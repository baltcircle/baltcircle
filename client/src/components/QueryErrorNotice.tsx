export function QueryErrorNotice({ query }: {
  query: { isError: boolean; dataUpdatedAt: number; refetch: () => unknown };
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
