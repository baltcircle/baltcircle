// Map a raw T-Bank status to a short Russian label for the result page. Unknown
// statuses are shown verbatim so support still sees the acquirer's exact value.
const STATUS_LABELS: Record<string, string> = {
  REJECTED: "Отклонён",
  CANCELED: "Отменён",
  CANCELLED: "Отменён",
  AUTH_FAIL: "Ошибка авторизации",
  DEADLINE_EXPIRED: "Истёк срок оплаты",
};

// Render the acquirer's failure detail (when available) as a compact, labelled
// block: "Причина", "Код", "Статус". All values come from T-Bank and are
// non-secret. Renders nothing when there is nothing useful to show.
export function PaymentErrorDetails({
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
