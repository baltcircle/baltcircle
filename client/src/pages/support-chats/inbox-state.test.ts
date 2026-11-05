import { describe, expect, it } from "vitest";
import { filterConversations, resolveConversationSelection } from "./inbox-state";

const rows = [
  { id: 11, userName: "Анна", userPhone: "+79990000011", lastMessagePreview: "Замок не открывается" },
  { id: 22, userName: "Борис", userPhone: "+79990000022", lastMessagePreview: "Возврат велосипеда" },
];

describe("support inbox selection", () => {
  it("waits for the first nonempty response", () => {
    const waiting = resolveConversationSelection(null, []);
    expect(waiting).toBeNull();
    expect(resolveConversationSelection(waiting, rows)).toBe(11);
  });

  it("keeps the original automatic selection after pinning or sorting", () => {
    const selected = resolveConversationSelection(null, rows);
    expect(resolveConversationSelection(selected, [...rows].reverse())).toBe(11);
  });

  it("keeps a manual selection across refreshes", () => {
    expect(resolveConversationSelection(22, rows)).toBe(22);
  });

  it("keeps selection when the inbox becomes empty or the row disappears", () => {
    expect(resolveConversationSelection(22, [])).toBe(22);
    expect(resolveConversationSelection(22, [rows[0]])).toBe(22);
  });

  it("does not treat zero as an unselected id", () => {
    expect(resolveConversationSelection(0, rows)).toBe(0);
    expect(resolveConversationSelection(null, [{ id: 0 }])).toBe(0);
  });

  it("converges after choosing the first row", () => {
    const selected = resolveConversationSelection(null, rows);
    expect(resolveConversationSelection(selected, rows)).toBe(selected);
  });
});

describe("support inbox search", () => {
  it.each(["", "   "])("reuses the original array for an empty query: %j", (query) => {
    expect(filterConversations(rows, query)).toBe(rows);
  });

  it.each([
    ["  АННА  ", 11],
    ["000022", 22],
    ["ЗАМОК", 11],
    ["возврат", 22],
  ])("searches names, phones and previews: %s", (query, id) => {
    expect(filterConversations(rows, String(query)).map((row) => row.id)).toEqual([id]);
  });

  it("handles missing and null search fields", () => {
    const sparse = [{ id: 1 }, { id: 2, userName: null, userPhone: null, lastMessagePreview: null }];
    expect(filterConversations(sparse, "missing")).toEqual([]);
  });

  it("preserves row order and does not mutate the inbox", () => {
    const before = rows.map((row) => ({ ...row }));
    expect(filterConversations(rows, "+7999")).toEqual(rows);
    expect(rows).toEqual(before);
  });

  it("does not change selection when the selected chat is filtered out", () => {
    const selected = resolveConversationSelection(null, rows);
    expect(filterConversations(rows, "Борис").map((row) => row.id)).toEqual([22]);
    expect(resolveConversationSelection(selected, rows)).toBe(11);
  });
});
