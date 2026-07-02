import { useEffect, useMemo } from "react";
import { Link, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2, Loader2, XCircle, AlertCircle, Bike as BikeIcon, RefreshCw,
} from "lucide-react";

interface RidePaymentStatus {
  orderId: string;
  status: "pending" | "paid" | "failed";
  bikeId: string;
  tariffId: string;
  amountKopecks: number;
  rideId: number | null;
  error?: string;
  // Acquirer failure detail (non-secret) for debugging declined payments.
  errorCode?: string;
  errorMessage?: string;
  errorDetails?: string;
}

// Map a raw T-Bank status to a short Russian label for the result page. Unknown
// statuses are shown verbatim so support still sees the acquirer's exact value.
const STATUS_LABELS: Record<string, string> = {
  REJECTED: "Отклонён",
  CANCELED: "Отменён",
  CANCELLED: "Отменён",
  AUTH_FAIL: "Ошибка авторизации",
  DEADLINE_EXPIRED: "Истёк срок оплаты",
};

// Landing page after the rider returns from T-Bank's hosted payment form.
// The webhook may not have arrived yet, so we poll the order status until it
// settles to paid/failed. On "paid" the ride has already been started by the
// server; we offer a link straight into the active ride.
// sessionStorage key carrying the acquirer's return params across the clean
// reboot we perform to escape the leftover T-Bank history stack.
const TBANK_RESULT_RETURN_KEY = "tbankResultReturnParams";

export function PaymentResultPage() {
  const search = useSearch();
  const queryClient = useQueryClient();
  const params = new URLSearchParams(search);
  const orderId = params.get("orderId") ?? "";

  // Escape the Back-into-T-Bank trap by REBOOTING to a clean URL. Arriving here
  // is a full page load from T-Bank's form, so the history below us still holds
  // one or more T-Bank entries that redirect forward again on Back — and a
  // native swipe-back can reach them even after a single-entry rewrite. Fighting
  // history by hand (replaceState/pushState/popstate) also desynced wouter.
  //
  // Instead: if the URL still carries the acquirer's return params (Success/
  // ErrorCode/Message/Details), stash them and `location.replace` to a clean
  // `/payment-result?orderId=...`. That physically drops every leftover T-Bank
  // entry (Back and swipe both leave cleanly) and reboots the SPA with wouter
  // pristine. On the fresh load we read the stashed error params back so the
  // failure hint still shows.
  useEffect(() => {
    if (!orderId) return;
    const hasAcquirerParams =
      params.has("Success") ||
      params.has("ErrorCode") ||
      params.has("Message") ||
      params.has("Details");
    if (hasAcquirerParams) {
      try {
        sessionStorage.setItem(TBANK_RESULT_RETURN_KEY, search);
      } catch {
        /* storage disabled — reboot still fixes the trap, we just lose the hint */
      }
      window.location.replace(`/payment-result?orderId=${encodeURIComponent(orderId)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On the clean post-reboot load the acquirer params are gone from the URL, so
  // read them from the stash we saved on the previous leg.
  const stashedSearch = useMemo(() => {
    try {
      const s = sessionStorage.getItem(TBANK_RESULT_RETURN_KEY);
      if (s) sessionStorage.removeItem(TBANK_RESULT_RETURN_KEY);
      return s || "";
    } catch {
      return "";
    }
  }, []);

  // T-Bank may append acquirer fields to the FailURL it redirects back to
  // (Success=false, ErrorCode, Message, Details). We surface these as a hint
  // while the webhook is still in flight — the persisted order is authoritative
  // once it settles, but this lets the rider/support see a reason immediately.
  // Read acquirer fields from the current URL if still present (pre-reboot), or
  // from the stash saved before the reboot (post-reboot clean URL).
  const redirectError = (() => {
    const p = search && params.has("Success") ? params : new URLSearchParams(stashedSearch);
    const success = (p.get("Success") ?? "").toLowerCase();
    const code = (p.get("ErrorCode") ?? "").trim();
    const message = (p.get("Message") ?? "").trim();
    const details = (p.get("Details") ?? "").trim();
    const declined = success === "false" || (code !== "" && code !== "0");
    if (!declined && !message && !details) return null;
    return {
      code: code && code !== "0" ? code : undefined,
      message: message || undefined,
      details: details || undefined,
    };
  })();

  const statusQ = useQuery<RidePaymentStatus>({
    queryKey: ["/api/payments/tbank/ride", orderId],
    enabled: orderId.length > 0,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/payments/tbank/ride/${encodeURIComponent(orderId)}`);
      return res.json();
    },
    // Keep polling while the payment is still pending (webhook in flight); stop
    // once it settles to paid/failed.
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "pending" || s === undefined ? 2500 : false;
    },
  });

  const status = statusQ.data?.status;

  // Once paid, refresh the active-ride / bikes caches so the rest of the app
  // reflects the started ride when the rider navigates back.
  useEffect(() => {
    if (status === "paid") {
      queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
    }
  }, [status, queryClient]);



  return (
    <div className="px-4 lg:px-10 py-10 max-w-xl mx-auto" data-testid="page-payment-result">
      <header className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Оплата</div>
        <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Результат оплаты</h1>
      </header>

      {!orderId ? (
        <Card className="p-8 text-center space-y-4" data-testid="payment-result-missing">
          <AlertCircle className="w-10 h-10 mx-auto text-destructive opacity-70" />
          <div className="text-muted-foreground">Не указан номер заказа.</div>
          <Button asChild variant="outline"><Link href="/">На главную</Link></Button>
        </Card>
      ) : statusQ.isError ? (
        <Card className="p-8 text-center space-y-4" data-testid="payment-result-error">
          <XCircle className="w-10 h-10 mx-auto text-destructive opacity-70" />
          <div className="text-muted-foreground">Не удалось получить статус оплаты.</div>
          <Button variant="outline" onClick={() => statusQ.refetch()}>
            <RefreshCw className="w-4 h-4 mr-2" /> Обновить
          </Button>
        </Card>
      ) : status === "paid" ? (
        <Card className="p-8 text-center space-y-4" data-testid="payment-result-paid">
          <CheckCircle2 className="w-12 h-12 mx-auto text-primary" />
          <div className="font-display text-xl font-light">Оплата прошла</div>
          <div className="text-sm text-muted-foreground">
            Аренда велосипеда {statusQ.data?.bikeId} начата. Замок разблокирован — можно ехать!
          </div>
          <div className="flex flex-col gap-2">
            <Button asChild>
              <Link href="/"><BikeIcon className="w-4 h-4 mr-2" /> К поездке</Link>
            </Button>
            <Button asChild variant="outline"><Link href="/rides">История поездок</Link></Button>
          </div>
        </Card>
      ) : status === "failed" ? (
        <Card className="p-8 text-center space-y-4" data-testid="payment-result-failed">
          <XCircle className="w-12 h-12 mx-auto text-destructive opacity-80" />
          <div className="font-display text-xl font-light">Оплата не прошла</div>
          <div className="text-sm text-muted-foreground">
            {statusQ.data?.errorMessage ||
              statusQ.data?.error ||
              "Платёж отклонён. Велосипед остался свободен — попробуйте ещё раз."}
          </div>
          <PaymentErrorDetails
            code={statusQ.data?.errorCode ?? redirectError?.code}
            message={statusQ.data?.errorMessage ?? redirectError?.message}
            details={statusQ.data?.errorDetails ?? redirectError?.details}
            status={statusQ.data?.status}
          />
          <Button asChild variant="outline"><Link href="/">Выбрать велосипед</Link></Button>
        </Card>
      ) : (
        <Card className="p-8 text-center space-y-4" data-testid="payment-result-pending">
          <Loader2 className="w-12 h-12 mx-auto text-muted-foreground animate-spin" />
          <div className="font-display text-xl font-light">Подтверждаем оплату…</div>
          <div className="text-sm text-muted-foreground">
            Это занимает несколько секунд. Аренда начнётся автоматически, как только
            банк подтвердит платёж — страница обновится сама.
          </div>
          {redirectError && (
            <div className="text-sm text-muted-foreground">
              Банк сообщил об отклонении. Подтверждаем окончательный статус…
            </div>
          )}
          <PaymentErrorDetails
            code={redirectError?.code}
            message={redirectError?.message}
            details={redirectError?.details}
          />
          <Button variant="outline" onClick={() => statusQ.refetch()}>
            <RefreshCw className="w-4 h-4 mr-2" /> Обновить сейчас
          </Button>
        </Card>
      )}
    </div>
  );
}

// Render the acquirer's failure detail (when available) as a compact, labelled
// block: "Причина", "Код", "Статус". All values come from T-Bank and are
// non-secret. Renders nothing when there is nothing useful to show.
function PaymentErrorDetails({
  code,
  message,
  details,
  status,
}: {
  code?: string;
  message?: string;
  details?: string;
  status?: string;
}) {
  const statusLabel =
    status && status !== "failed"
      ? STATUS_LABELS[status.toUpperCase()] ?? status
      : undefined;
  const reason = message || details;
  if (!reason && !code && !statusLabel) return null;

  return (
    <div
      className="text-left text-xs bg-muted/50 rounded-md p-3 space-y-1 text-muted-foreground"
      data-testid="payment-result-error-detail"
    >
      {reason && (
        <div>
          <span className="font-medium text-foreground">Причина:</span> {reason}
        </div>
      )}
      {details && message && details !== message && (
        <div>
          <span className="font-medium text-foreground">Детали:</span> {details}
        </div>
      )}
      {code && (
        <div>
          <span className="font-medium text-foreground">Код:</span> {code}
        </div>
      )}
      {statusLabel && (
        <div>
          <span className="font-medium text-foreground">Статус:</span> {statusLabel}
        </div>
      )}
    </div>
  );
}
