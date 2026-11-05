// Keep inbox decisions independent of React, SSE and network requests.
interface ConversationId {
  id: number;
}

interface SearchableConversation {
  userName?: string | null;
  userPhone?: string | null;
  lastMessagePreview?: string | null;
}

export function resolveConversationSelection(
  selectedId: number | null,
  rows: readonly ConversationId[],
): number | null {
  return selectedId ?? rows[0]?.id ?? null;
}

export function filterConversations<T extends SearchableConversation>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => {
    const hay = `${row.userName ?? ""} ${row.userPhone ?? ""} ${row.lastMessagePreview ?? ""}`.toLowerCase();
    return hay.includes(q);
  });
}
