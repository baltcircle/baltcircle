import { storage } from "../../storage";
import { logger } from "../../logger";
import { log } from "../../index";
import type { PaymentMethod } from "@shared/schema";
import {
  tbankGetAddCardState, classifyCardBinding, classifyInitBinding, tbankGetState,
} from "../../tbank";
import type { TbankConfig } from "../../tbank";
import {
  bindingErrorPatch, refundVerificationCharge, maskPan, cardBrand,
  extractLast4FromLabel, terminalBindingFailurePatch,
} from "../../payments/tbank-handlers";

// A state check is on the synchronous request path when a rider returns to the
// payment-methods page or starts another bind. Bound it so an acquirer outage
// cannot tie up an Express worker indefinitely. On a transport/timeout error we
// deliberately fail closed for that one request: a live 3DS session is still
// possible, and creating another one would orphan it. We never use a local
// timestamp as a substitute for the bank's answer.
const BIND_STATE_TIMEOUT_MS = 5_000;
const LIVE_BINDING_STATUSES = new Set([
  "NEW", "FORM_SHOWED", "3DS_CHECKING", "3DS_CHECKED", "AUTHORIZING",
]);

export type BindingReconciliation = "active" | "failed" | "in_flight" | "unavailable";

function failedBindingPatch(body: Record<string, unknown>, fallback: string) {
  const patch = bindingErrorPatch(body);
  return {
    ...patch,
    lastErrorCode: patch.lastErrorCode ?? "BINDING_STATE_UNAVAILABLE",
    lastErrorMessage: patch.lastErrorMessage ?? fallback,
    lastErrorDetails: patch.lastErrorDetails ?? null,
  };
}

// T-Bank uses an unsuccessful state request for an identifier it no longer
// knows. That is terminal for our local attempt: it cannot become active later.
// Keep the match deliberately narrow; authentication/terminal outages are
// handled as `unavailable` below and must not incorrectly fail a live bind.
function isUnknownBindingAtBank(resp: Record<string, unknown>): boolean {
  const code = String(resp.ErrorCode ?? "").trim();
  const message = `${String(resp.Message ?? "")} ${String(resp.Details ?? "")}`.toLowerCase();
  return code === "7" || /not\s*found|unknown|не\s*найден|не\s*существует/.test(message);
}

// RequestKey and PaymentId are opaque T-Bank values, so do not impose a
// provider-specific character whitelist here. A trimmed non-control string is
// the smallest safe definition of a usable identifier; blank/control-only
// legacy values cannot name a live bank session and must not fail closed.
function normalizedBindingIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const identifier = value.trim();
  // eslint-disable-next-line no-control-regex -- deliberately matching control chars to reject them, not a typo
  return identifier && !/[\u0000-\u001F\u007F]/.test(identifier) ? identifier : undefined;
}

export async function reconcilePendingCardBinding(
  method: PaymentMethod,
  cfg: TbankConfig,
): Promise<BindingReconciliation> {
  if (method.status !== "pending") return method.status === "active" ? "active" : "failed";

  const requestKey = normalizedBindingIdentifier(method.requestKey);
  const paymentId = normalizedBindingIdentifier(method.paymentId);
  const isAddCard = Boolean(requestKey);
  const identifier = requestKey || paymentId;
  if (method.provider !== "tbank" || !identifier) {
    logger.info({
      userId: method.userId,
      methodId: method.id,
      requestKeyPresent: Boolean(requestKey),
      paymentIdPresent: Boolean(paymentId),
      outcome: "failed_missing_identifier",
    }, "[tbank] card-bind reconciliation");
    await storage.updatePaymentMethod(method.id, {
      status: "failed",
      lastErrorCode: "BINDING_IDENTIFIER_MISSING",
      lastErrorMessage: "Не удалось найти идентификатор привязки в платёжном сервисе.",
      lastErrorDetails: null,
    });
    return "failed";
  }

  let resp: Record<string, unknown>;
  try {
    resp = isAddCard
      ? await tbankGetAddCardState(cfg, requestKey!, BIND_STATE_TIMEOUT_MS)
      : await tbankGetState(cfg, paymentId!, BIND_STATE_TIMEOUT_MS);
  } catch (err) {
    logger.warn({
      err,
      userId: method.userId,
      methodId: method.id,
      requestKeyPresent: Boolean(requestKey),
      paymentIdPresent: Boolean(paymentId),
      outcome: "unavailable",
    }, "[tbank] card-bind state check failed");
    return "unavailable";
  }

  // Intentionally record only decision-relevant, non-card data: a raw state
  // response may contain PAN/CardId/RebillId and must never reach application
  // logs.
  logger.info({
    userId: method.userId,
    methodId: method.id,
    requestKeyPresent: Boolean(requestKey),
    paymentIdPresent: Boolean(paymentId),
    bankResponse: {
      success: resp.Success === true,
      status: typeof resp.Status === "string" ? resp.Status : null,
      errorCode: resp.ErrorCode != null ? String(resp.ErrorCode) : null,
    },
  }, "[tbank] card-bind state response");

  if (!resp.Success) {
    if (isUnknownBindingAtBank(resp)) {
      await storage.updatePaymentMethod(method.id, {
        status: "failed",
        ...failedBindingPatch(resp, "Привязка не найдена в платёжном сервисе."),
      });
      return "failed";
    }
    log(`[tbank] binding state query rejected methodId=${method.id} code=${String(resp.ErrorCode ?? "?")}`, "tbank");
    return "unavailable";
  }

  const status = typeof resp.Status === "string" ? resp.Status : "";
  const cardId = typeof resp.CardId === "string" ? resp.CardId : "";
  const rebillId = resp.RebillId != null ? String(resp.RebillId) : "";
  const pan = typeof resp.Pan === "string" ? resp.Pan : "";
  if (LIVE_BINDING_STATUSES.has(status.trim().toUpperCase())) return "in_flight";
  const outcome = isAddCard
    ? classifyCardBinding({ status, cardId })
    : classifyInitBinding({ status, rebillId });

  if (outcome === "failed") {
    await storage.updatePaymentMethod(method.id, {
      status: "failed",
      ...terminalBindingFailurePatch(resp),
    });
    return "failed";
  }

  if (outcome === "active") {
    const label = pan ? maskPan(pan) : method.label === "Карта (привязывается…)" ? "Карта" : method.label;
    const brand = pan ? cardBrand(pan) ?? method.brand : method.brand;
    const last4 = extractLast4FromLabel(label);
    const duplicate = last4
      ? await storage.findActiveCardDuplicate(method.userId, last4, brand, method.id)
      : undefined;
    if (duplicate) {
      await storage.updatePaymentMethod(method.id, {
        status: "failed",
        lastErrorCode: "DUPLICATE_CARD",
        lastErrorMessage: "Эта карта уже привязана к вашему аккаунту.",
        lastErrorDetails: null,
      });
      if (!isAddCard && method.paymentId) {
        const customer = await storage.getUser(method.userId);
        void refundVerificationCharge(cfg, {
          methodId: method.id,
          paymentId: method.paymentId,
          knownStatus: status,
          amountKopecks: method.amountKopecks ?? cfg.cardBindAmountKopecks,
          customerEmail: customer?.email,
          customerPhone: customer?.phone,
        });
      }
      return "failed";
    }

    await storage.updatePaymentMethod(method.id, {
      status: "active",
      cardId: cardId || method.cardId,
      rebillId: rebillId || method.rebillId,
      paymentId: method.paymentId,
      label,
      brand,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorDetails: null,
    });
    if (!isAddCard && method.paymentId) {
      const customer = await storage.getUser(method.userId);
      void refundVerificationCharge(cfg, {
        methodId: method.id,
        paymentId: method.paymentId,
        knownStatus: status,
        amountKopecks: method.amountKopecks ?? cfg.cardBindAmountKopecks,
        customerEmail: customer?.email,
        customerPhone: customer?.phone,
      });
    }
    return "active";
  }

  // NEW, FORM_SHOWED, 3DS_* and AUTHORIZING are an actual acquirer-side
  // session, not a locally guessed "fresh" row. AUTHORIZED deliberately goes
  // through the binding-specific classifier first: an Init+Recurrent response
  // may already include its usable RebillId at that status.
  return "in_flight";
}

export async function reconcilePendingCardBindingsForUser(
  userId: string,
  cfg: TbankConfig,
  methods?: PaymentMethod[],
): Promise<BindingReconciliation[]> {
  // This is intentionally the single user-level reconciliation path. Listing
  // methods, starting a new binding, and explicit refreshes must all ask the
  // same T-Bank endpoint for every pending card instead of letting a duplicate
  // "pending" query drift back into one of the entry points.
  const pending = (methods ?? await storage.listPaymentMethods(userId))
    .filter((method) => method.type === "card" && method.status === "pending");
  return Promise.all(pending.map(async (method) => {
    // A legacy row or a transient failure while resolving one row must not
    // prevent later rows for this same user from being independently resolved.
    // We still fail closed for the affected row only, because its bank session
    // may be live.
    try {
      return await reconcilePendingCardBinding(method, cfg);
    } catch (err) {
      logger.warn({
        err,
        userId,
        methodId: method.id,
        requestKeyPresent: Boolean(normalizedBindingIdentifier(method.requestKey)),
        paymentIdPresent: Boolean(normalizedBindingIdentifier(method.paymentId)),
        outcome: "unavailable",
      }, "[tbank] card-bind reconciliation row failed");
      return "unavailable" as const;
    }
  }));
}

// Starting another card-bind flow is an explicit product-level abandonment of
// every previous unfinished flow. The hosted T-Bank form may still be open in
// another tab, but the application cannot observe that reliably and must never
// leave the rider blocked behind it. Mark the old rows terminal locally before
// creating the next bank session. A later bank-confirmed success is still
// accepted by the webhook handler through its stable OrderId/RequestKey
// correlation, so supersession does not discard a successfully bound card.
export async function supersedePendingCardBindingsForUser(userId: string): Promise<void> {
  const methods = await storage.listPaymentMethods(userId);
  const pending = methods.filter((method) => method.type === "card" && method.status === "pending");
  if (!pending.length) return;

  await Promise.all(pending.map((method) => storage.updatePaymentMethod(method.id, {
    status: "failed",
    lastErrorCode: "SUPERSEDED_BY_NEW_ATTEMPT",
    lastErrorMessage: "Привязка отменена: начата новая попытка.",
    lastErrorDetails: null,
  })));
  logger.info({
    userId,
    supersededRows: pending.map((method) => ({
      methodId: method.id,
      requestKeyPresent: Boolean(normalizedBindingIdentifier(method.requestKey)),
      paymentIdPresent: Boolean(normalizedBindingIdentifier(method.paymentId)),
    })),
  }, "[tbank] card-bind attempts superseded");
}
