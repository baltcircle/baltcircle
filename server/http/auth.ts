import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { z } from "zod";
import { TARIFFS, tariffPriceKopecks } from "@shared/geo";
import {
  insertMapObjectSchema, otpStartSchema, otpVerifySchema, updateProfileSchema,
  adminSetRoleSchema, adminSetBlockedSchema,
  phoneChangeStartSchema, phoneChangeVerifySchema,
  emailChangeStartSchema, emailChangeVerifySchema,
  OAUTH_PROVIDERS,
  linkPaymentMethodSchema, createSupportTicketSchema, rideInitPaymentSchema,
  rideChargeSavedCardSchema,
  adminCreateBikeSchema, adminUpdateBikeSchema,
  createTicketSchema, updateTicketSchema, addTicketCommentSchema,
  adminCreateParkingSchema, adminUpdateParkingSchema, updateMapObjectSchema,
} from "@shared/schema";
import type { OauthProvider } from "@shared/schema";
import type { PaymentMethod, PaymentOrder, Ride } from "@shared/schema";
import { sendOtpSms, getSmsDiagnostics, smsProvider, getSigmaSmsSendingStatus } from "./../sms";
import { sendOtpEmail } from "./../email";
import { randomBytes, createHash } from "node:crypto";
import {
  getTbankConfig, getTbankDiagnostics, isTbankConfigured, tbankAddCard,
  tbankGetAddCardState, classifyCardBinding, classifyInitBinding,
  verifyNotificationToken,
  tbankInitRidePayment, generateRideOrderId, classifyRidePayment,
  tbankInitSavedCardCharge, tbankCharge, generateSavedCardRideOrderId,
  tbankGetState,
  tbankAddAccountQr, tbankGetAddAccountQrState,
  generateSbpBindOrderId, extractQrPayload, classifyAccountBinding,
} from "./../tbank";
import type { TbankConfig } from "./../tbank";
import {
  startRideForPaidOrder, tbankErrorBody, handleTbankNotification,
  bindingErrorPatch, refundVerificationCharge, bindViaVerificationPayment,
  maskPan, cardBrand,
} from "./../payments/tbank-handlers";
import { log } from "./../index";
import {
  riderId, isStaffSession, canManageRide, actorName, clientIp,
  requireRole, requireAuth, requireRoleWhenConfigured,
  otpLimiter, paymentLimiter,
} from "./context";

export function registerAuthRoutes(app: Express): void {
  // -------------- Rider registration (SMS OTP) --------------
  // Step 1: rider submits name + phone + consent. We generate a code, persist
  // its hash, and dispatch it by SMS. No session is created yet.
  app.post("/api/auth/otp/start", otpLimiter, async (req, res) => {
    const parsed = otpStartSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.startOtp({ name: parsed.data.name, phone: parsed.data.phone });
    if ("error" in result) {
      const status = result.retryAfterSec ? 429 : 400;
      return res.status(status).json(result);
    }
    try {
      const sent = await sendOtpSms(result.phone, result.code);
      // Persist the provider's sending id/status so staff can later query the
      // provider's delivery status for this phone. Non-secret diagnostics only.
      await storage.recordOtpSend({
        phone: result.phone,
        provider: sent.provider,
        providerMessageId: sent.providerMessageId,
        providerStatus: sent.providerStatus,
      });
      // In dev fallback (no SMS provider configured) we echo the code so the
      // flow is testable locally. In production this is always undefined.
      res.json({
        phone: result.phone,
        resendInSec: result.resendInSec,
        ...(sent.providerStatus ? { providerStatus: sent.providerStatus } : {}),
        ...(sent.devEcho ? { devCode: result.code } : {}),
      });
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "Не удалось отправить SMS. Попробуйте позже." });
    }
  });

  // Step 2: rider submits the code. On success we create/activate the rider and
  // bind the session, allowing rental/scan.
  app.post("/api/auth/otp/verify", otpLimiter, async (req, res) => {
    const parsed = otpVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.verifyOtp({
      phone: parsed.data.phone,
      code: parsed.data.code,
      consentIp: clientIp(req),
    });
    if ("error" in result) return res.status(400).json(result);
    req.session.userId = result.user.id;
    res.status(201).json(result.user);
  });

  // Public probe so the client can tell whether a real SMS provider is wired up.
  // Never exposes the token — just the provider name and a configured flag.
  app.get("/api/sms/config", async (_req, res) => {
    res.json({ provider: smsProvider() || "(none)", configured: getSmsDiagnostics().configured });
  });

  // Admin-only SMS diagnostics. Returns ONLY non-secret metadata: provider,
  // configured flag, token LENGTH (never the token), sender and the API base.
  // Lets staff confirm the SigmaSMS wiring without ever seeing the secret.
  app.get("/api/sms/diagnostics", requireRole("admin"), async (_req, res) => {
    res.json(getSmsDiagnostics());
  });


  // Admin-only OTP delivery diagnostics for a phone. Returns the stored provider
  // metadata for the last OTP send (provider, sending id, status, error, and the
  // OTP request timestamps) — never the code or its hash. When a SigmaSMS sending
  // id is on file, this also queries the provider's status API and persists the
  // refreshed status so repeat checks reflect the latest delivery state.
  // Usage: GET /api/sms/otp-status?phone=+79991234567
  app.get("/api/sms/otp-status", requireRole("admin"), async (req, res) => {
    const phone = typeof req.query.phone === "string" ? req.query.phone.trim() : "";
    if (!phone) return res.status(400).json({ error: "Укажите параметр phone" });

    const row = await storage.getLastOtpSend(phone);
    if (!row) {
      return res.status(404).json({ error: "По этому номеру нет записей об отправке кода" });
    }

    // If we have a SigmaSMS sending id, refresh the delivery status from the
    // provider and persist it. A lookup failure is reported but does not fail the
    // endpoint — the stored snapshot is still returned.
    let providerLookup: { httpStatus: number; found: boolean; status?: string; error?: string } | undefined;
    if (row.provider === "sigmasms" && smsProvider() === "sigmasms" && row.providerMessageId) {
      try {
        const live = await getSigmaSmsSendingStatus(row.providerMessageId);
        providerLookup = live;
        await storage.updateOtpProviderStatus({
          phone,
          providerStatus: live.status ?? row.providerStatus ?? undefined,
          providerError: live.error ?? undefined,
        });
      } catch (err: any) {
        providerLookup = { httpStatus: 0, found: false, error: err?.message ?? "lookup failed" };
      }
    }

    // Re-read so the response reflects any refresh we just persisted.
    const latest = await storage.getLastOtpSend(phone) ?? row;
    res.json({
      phone: latest.phone,
      provider: latest.provider,
      providerMessageId: latest.providerMessageId,
      providerStatus: latest.providerStatus,
      providerError: latest.providerError,
      consumed: latest.consumed,
      createdAt: latest.lastSentAt,
      checkedAt: latest.providerCheckedAt,
      ...(providerLookup ? { providerLookup } : {}),
    });
  });

  app.get("/api/users/current", async (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.json(null);
    const user = await storage.getUser(id);
    if (!user) {
      // Session points at a user that no longer exists (e.g. DB reset). Clear
      // the stale id so the client falls back to the unregistered state.
      req.session.userId = undefined;
      return res.json(null);
    }
    res.json(user);
  });

  // Self-service profile update for the logged-in rider. Name and email only —
  // phone changes are intentionally not accepted here (they need SMS OTP).
  app.patch("/api/users/me", async (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.status(401).json({ error: "Требуется вход" });
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.updateProfile(id, parsed.data);
    if ("error" in result) return res.status(400).json(result);
    res.json(result.user);
  });

  // -------------- Phone change (SMS OTP, existing account) --------------
  // The current rider changes their phone number. This is the ONLY way to
  // change a phone — the profile PATCH endpoint never touches it. Step 1 sends a
  // code to the new number; step 2 verifies it and applies the change.
  app.post("/api/users/me/phone/start", async (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.status(401).json({ error: "Требуется вход" });
    const parsed = phoneChangeStartSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.startPhoneChange({ userId: id, phone: parsed.data.phone });
    if ("error" in result) {
      const status = result.retryAfterSec ? 429 : 400;
      return res.status(status).json(result);
    }
    try {
      const { devEcho } = await sendOtpSms(result.phone, result.code);
      res.json({
        phone: result.phone,
        resendInSec: result.resendInSec,
        ...(devEcho ? { devCode: result.code } : {}),
      });
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "Не удалось отправить SMS. Попробуйте позже." });
    }
  });

  app.post("/api/users/me/phone/verify", async (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.status(401).json({ error: "Требуется вход" });
    const parsed = phoneChangeVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.verifyPhoneChange({ userId: id, code: parsed.data.code });
    if ("error" in result) return res.status(400).json(result);
    res.json(result.user);
  });

  // -------------- Email change (RuSender OTP) --------------
  // Same OTP UX as phone — send code to the target email, verify, apply. This is
  // the only path to set/change/verify an email; profile PATCH never touches it.
  app.post("/api/users/me/email/start", async (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.status(401).json({ error: "Требуется вход" });
    const parsed = emailChangeStartSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.startEmailChange({ userId: id, email: parsed.data.email });
    if ("error" in result) {
      const status = result.retryAfterSec ? 429 : 400;
      return res.status(status).json(result);
    }
    try {
      const { devEcho } = await sendOtpEmail(result.email, result.code);
      res.json({
        email: result.email,
        resendInSec: result.resendInSec,
        ...(devEcho ? { devCode: result.code } : {}),
      });
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "Не удалось отправить письмо. Попробуйте позже." });
    }
  });

  app.post("/api/users/me/email/verify", async (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.status(401).json({ error: "Требуется вход" });
    const parsed = emailChangeVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.verifyEmailChange({ userId: id, code: parsed.data.code });
    if ("error" in result) return res.status(400).json(result);
    res.json(result.user);
  });

  app.post("/api/users/me/email/unlink", async (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.status(401).json({ error: "Требуется вход" });
    const result = await storage.unlinkEmail(id);
    if ("error" in result) return res.status(400).json(result);
    res.json(result.user);
  });

  // -------------- OAuth (Yandex ID + VK ID) --------------
  // Both flows are "link to logged-in account" first. Callbacks also support
  // sign-in by an already-linked identity or by verified email match.

  app.get("/api/users/me/oauth", async (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.status(401).json({ error: "Требуется вход" });
    const rows = await storage.listOauthIdentities(id);
    res.json(rows);
  });

  app.post("/api/users/me/oauth/:provider/unlink", async (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.status(401).json({ error: "Требуется вход" });
    const provider = req.params.provider as OauthProvider;
    if (!OAUTH_PROVIDERS.includes(provider)) return res.status(400).json({ error: "Неизвестный провайдер" });
    await storage.unlinkOauthIdentity(id, provider);
    res.json({ ok: true });
  });

  // ---- Yandex ID ----
  // Authorization Code flow. Docs: https://yandex.ru/dev/id/doc/ru/codes/code-url
  app.get("/api/auth/yandex/start", async (req, res) => {
    const clientId = (process.env.YANDEX_CLIENT_ID || "").trim();
    if (!clientId) return res.status(503).json({ error: "Yandex OAuth не настроен" });
    const state = randomBytes(24).toString("hex");
    req.session.oauthState = { ...(req.session.oauthState || {}), yandex: state };
    const redirectUri = `${publicAppUrl(req)}/api/auth/yandex/callback`;
    const authUrl = new URL("https://oauth.yandex.ru/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "login:email login:info");
    authUrl.searchParams.set("state", state);
    // Save the session cookie before we 302 out to Yandex, otherwise the state
    // we just stored may be lost on some clients.
    req.session.save(() => res.redirect(authUrl.toString()));
  });

  app.get("/api/auth/yandex/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const expected = req.session.oauthState?.yandex;
    if (!code || !state || !expected || state !== expected) {
      return res.redirect("/settings?oauth=error&reason=state");
    }
    if (req.session.oauthState) req.session.oauthState.yandex = undefined;

    const clientId = (process.env.YANDEX_CLIENT_ID || "").trim();
    const clientSecret = (process.env.YANDEX_CLIENT_SECRET || "").trim();
    if (!clientId || !clientSecret) return res.redirect("/settings?oauth=error&reason=config");

    // Exchange code for access token.
    let tokenResp: globalThis.Response;
    try {
      tokenResp = await fetch("https://oauth.yandex.ru/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return res.redirect("/settings?oauth=error&reason=token");
    }
    if (!tokenResp.ok) return res.redirect("/settings?oauth=error&reason=token");
    const tokenBody = await tokenResp.json().catch(() => null) as any;
    const accessToken = tokenBody?.access_token as string | undefined;
    if (!accessToken) return res.redirect("/settings?oauth=error&reason=token");

    // Fetch user info.
    let infoResp: globalThis.Response;
    try {
      infoResp = await fetch("https://login.yandex.ru/info?format=json", {
        headers: { Authorization: `OAuth ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return res.redirect("/settings?oauth=error&reason=info");
    }
    if (!infoResp.ok) return res.redirect("/settings?oauth=error&reason=info");
    const info = await infoResp.json().catch(() => null) as any;
    const subject = String(info?.id ?? "");
    if (!subject) return res.redirect("/settings?oauth=error&reason=info");
    const providerEmail: string | null = info?.default_email ?? info?.emails?.[0] ?? null;
    const displayName: string | null = info?.real_name ?? info?.display_name ?? info?.login ?? null;

    await completeOauthCallback(req, res, {
      provider: "yandex", subject, providerEmail, displayName,
    });
  });

  // ---- VK ID ----
  // OAuth 2.1 + PKCE flow. Docs: https://id.vk.com/about/business/go/docs/ru/vkid/latest/vk-id/connection/start-integration/auth-without-sdk-web
  app.get("/api/auth/vk/start", async (req, res) => {
    const appId = (process.env.VK_APP_ID || "").trim();
    if (!appId) return res.status(503).json({ error: "VK ID не настроен" });
    const state = randomBytes(24).toString("hex");
    // PKCE: S256 code_challenge derived from code_verifier stored in the session.
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    req.session.oauthState = { ...(req.session.oauthState || {}), vk: state, vkCodeVerifier: codeVerifier };

    const redirectUri = `${publicAppUrl(req)}/api/auth/vk/callback`;
    const authUrl = new URL("https://id.vk.com/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", appId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "email");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    req.session.save(() => res.redirect(authUrl.toString()));
  });

  app.get("/api/auth/vk/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const deviceId = typeof req.query.device_id === "string" ? req.query.device_id : "";
    const expected = req.session.oauthState?.vk;
    const codeVerifier = req.session.oauthState?.vkCodeVerifier;
    if (!code || !state || !expected || state !== expected || !codeVerifier) {
      return res.redirect("/settings?oauth=error&reason=state");
    }
    if (req.session.oauthState) {
      req.session.oauthState.vk = undefined;
      req.session.oauthState.vkCodeVerifier = undefined;
    }

    const appId = (process.env.VK_APP_ID || "").trim();
    if (!appId) return res.redirect("/settings?oauth=error&reason=config");

    const redirectUri = `${publicAppUrl(req)}/api/auth/vk/callback`;

    // Exchange code + code_verifier for access token via VK ID token endpoint.
    let tokenResp: globalThis.Response;
    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: appId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        state,
      });
      if (deviceId) body.set("device_id", deviceId);
      tokenResp = await fetch("https://id.vk.com/oauth2/auth", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return res.redirect("/settings?oauth=error&reason=token");
    }
    if (!tokenResp.ok) return res.redirect("/settings?oauth=error&reason=token");
    const tokenBody = await tokenResp.json().catch(() => null) as any;
    const accessToken = tokenBody?.access_token as string | undefined;
    const providerEmail: string | null = tokenBody?.email ?? null;
    const vkUserId = tokenBody?.user_id;
    if (!accessToken) return res.redirect("/settings?oauth=error&reason=token");

    // Fetch profile for a display name.
    let displayName: string | null = null;
    let subject = vkUserId ? String(vkUserId) : "";
    try {
      const userResp = await fetch("https://id.vk.com/oauth2/user_info", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ access_token: accessToken, client_id: appId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (userResp.ok) {
        const info = await userResp.json().catch(() => null) as any;
        const user = info?.user ?? info;
        if (user) {
          if (!subject && user?.user_id) subject = String(user.user_id);
          const first = user?.first_name ?? "";
          const last = user?.last_name ?? "";
          const joined = `${first} ${last}`.trim();
          if (joined) displayName = joined;
        }
      }
    } catch {
      // Non-fatal — we can link with just the subject.
    }

    if (!subject) return res.redirect("/settings?oauth=error&reason=info");

    await completeOauthCallback(req, res, {
      provider: "vk", subject, providerEmail, displayName,
    });
  });
}

// -------------- OAuth helpers --------------

// Build an absolute base URL from the incoming request, preferring the
// PUBLIC_APP_URL env when set. Used to construct redirect_uri that must match
// what's whitelisted in the provider console.
function publicAppUrl(req: Request): string {
  const configured = (process.env.PUBLIC_APP_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host || "takeride.ru";
  return `${proto}://${host}`;
}

// Common tail of a successful OAuth callback: either link to the logged-in
// user, or sign them in by an already-linked identity / verified email, or
// bounce to /settings with a needs-phone hint when there's no way to resolve
// a user (registration requires a phone).
async function completeOauthCallback(
  req: Request,
  res: Response,
  params: { provider: OauthProvider; subject: string; providerEmail: string | null; displayName: string | null },
) {
  const { provider, subject, providerEmail, displayName } = params;
  const sessionUserId = req.session?.userId;

  if (sessionUserId) {
    const result = await storage.linkOauthIdentity({
      userId: sessionUserId, provider, subject, email: providerEmail, displayName,
    });
    if ("error" in result) {
      return res.redirect(`/settings?oauth=error&reason=conflict`);
    }
    return res.redirect(`/settings?oauth=linked&provider=${provider}`);
  }

  // Not logged in — try to sign in.
  const user = await storage.findUserByOauth(provider, subject, providerEmail);
  if (user) {
    // Refresh the identity snapshot so subject stays mapped.
    await storage.linkOauthIdentity({
      userId: user.id, provider, subject, email: providerEmail, displayName,
    });
    req.session.userId = user.id;
    return req.session.save(() => res.redirect(`/settings?oauth=signed-in&provider=${provider}`));
  }

  // No match — we can't create an account without a phone. Redirect to the
  // registration page with a hint.
  return res.redirect(`/?oauth=need-phone&provider=${provider}`);
}
