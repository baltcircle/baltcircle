import * as React from "react";

type QueryErrorState = {
  isError: boolean;
  dataUpdatedAt: number;
  data?: unknown;
  isFetching?: boolean;
  refetch: () => unknown;
};

// Administrative diagnostics are intentionally separate from rider feedback.
export function QueryErrorNotice({ query }: {
  query: QueryErrorState;
}) {
  if (!query.isError) return null;
  return (
    <div role="alert" className="p-3 my-2 border border-destructive/40 rounded-md text-sm text-destructive">
      Не удалось загрузить данные с сервера.
      {query.dataUpdatedAt > 0 && <> Показан сохранённый снимок от {new Date(query.dataUpdatedAt).toLocaleTimeString("ru-RU")}.</>}
      <button className="ml-2 underline" onClick={() => query.refetch()}>Повторить</button>
    </div>
  );
}

export function RiderQueryErrorNotice({
  query,
  blocking = false,
  message = "Не удалось открыть этот раздел. Попробуйте ещё раз.",
}: {
  query: QueryErrorState;
  blocking?: boolean;
  message?: string;
}) {
  // A failed background refresh is not a failed user action. Keep displaying
  // available data without exposing timestamps/cache diagnostics to riders.
  // Explicitly blocking checks (session identity, rental/payment readiness)
  // must still explain why the action is unavailable and offer recovery.
  if (!query.isError || (!blocking && query.data !== undefined)) return null;
  return (
    <div role="alert" className="p-3 my-2 rounded-md text-sm text-muted-foreground">
      {message}
      <button
        type="button"
        className="ml-2 underline disabled:opacity-50"
        disabled={query.isFetching}
        onClick={() => query.refetch()}
      >
        Повторить
      </button>
    </div>
  );
}
