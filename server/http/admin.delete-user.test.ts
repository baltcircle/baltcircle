import { beforeEach, describe, expect, it, vi } from "vitest";

// Admin-only hard-delete route added to the operator panel's "Пользователи"
// list. Reuses the same storage.deleteAccount() transaction as the rider
// self-service flow (see account.test.ts) — these tests assert the extra
// admin-side guards (self/other-admin protection, 404/409 propagation) and
// that saved payment methods are unlinked before the account is erased.

const storageMock = vi.hoisted(() => ({
  getUser: vi.fn(),
  getActiveRide: vi.fn(),
  listPaymentMethods: vi.fn(),
  deleteAccount: vi.fn(),
}));
const unlinkPaymentMethodForUserMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => vi.fn());

vi.mock("../storage", () => ({ storage: storageMock }));
vi.mock("../index", () => ({ log: logMock }));
vi.mock("./payments", () => ({ unlinkPaymentMethodForUser: unlinkPaymentMethodForUserMock }));
vi.mock("./context", () => ({
  riderId: vi.fn(),
  isStaffSession: vi.fn(),
  canManageRide: vi.fn(),
  actorName: vi.fn(),
  clientIp: vi.fn(() => "203.0.113.10"),
  requireRole: vi.fn(() => vi.fn()),
  requireAuth: vi.fn(() => vi.fn()),
  requireRoleWhenConfigured: vi.fn(() => vi.fn()),
  otpLimiter: vi.fn(),
  paymentLimiter: vi.fn(),
  parsePageParams: vi.fn(),
}));

import { registerAdminUserRoutes } from "./admin";

type Handler = (req: any, res: any, next: (err?: unknown) => void) => Promise<unknown>;

function routeApp() {
  const del = new Map<string, Handler>();
  const noop = () => {};
  const register = (target: Map<string, Handler>) => (path: string, ...handlers: any[]) => {
    target.set(path, handlers.at(-1));
  };
  registerAdminUserRoutes({
    get: noop,
    patch: noop,
    delete: register(del),
  } as any);
  return { del };
}

function response() {
  return {
    code: 200,
    body: undefined as unknown,
    status(code: number) { this.code = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
}

function request(userId: string, params: Record<string, string>) {
  return { session: { userId }, params, ip: "203.0.113.10", socket: {} };
}

async function invoke(handler: Handler, req: any, res: any) {
  let nextError: unknown;
  await handler(req, res, (err?: unknown) => { nextError = err; });
  return nextError;
}

const ADMIN = { id: "admin-1", role: "admin", name: "Админ" };
const OTHER_ADMIN = { id: "admin-2", role: "admin", name: "Другой админ" };
const RIDER = { id: "user-1", role: "rider", name: "Тест Пользователь" };

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.getActiveRide.mockResolvedValue(undefined);
  storageMock.listPaymentMethods.mockResolvedValue([]);
  storageMock.deleteAccount.mockResolvedValue({ ok: true });
  unlinkPaymentMethodForUserMock.mockResolvedValue({ ok: true });
});

describe("DELETE /api/admin/users/:id", () => {
  it("unlinks every saved payment method, then deletes the target account", async () => {
    const { del } = routeApp();
    storageMock.getUser.mockImplementation((id: string) =>
      Promise.resolve(id === ADMIN.id ? ADMIN : RIDER));
    storageMock.listPaymentMethods.mockResolvedValue([
      { id: 11, type: "card", status: "active", provider: "tbank", customerKey: "user-1", cardId: "card-11" },
      { id: 12, type: "sbp", status: "active", provider: "tbank" },
    ]);
    const res = response();

    const nextError = await invoke(del.get("/api/admin/users/:id")!, request(ADMIN.id, { id: RIDER.id }), res);

    expect(nextError).toBeUndefined();
    expect(unlinkPaymentMethodForUserMock).toHaveBeenNthCalledWith(
      1, RIDER.id, expect.objectContaining({ id: 11, cardId: "card-11" }), "203.0.113.10",
    );
    expect(unlinkPaymentMethodForUserMock).toHaveBeenNthCalledWith(
      2, RIDER.id, expect.objectContaining({ id: 12, type: "sbp" }), "203.0.113.10",
    );
    expect(storageMock.deleteAccount).toHaveBeenCalledWith(RIDER.id);
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("rejects deleting your own account without touching storage", async () => {
    const { del } = routeApp();
    storageMock.getUser.mockResolvedValue(ADMIN);
    const res = response();

    const nextError = await invoke(del.get("/api/admin/users/:id")!, request(ADMIN.id, { id: ADMIN.id }), res);

    expect(nextError).toBeUndefined();
    expect(res.code).toBe(400);
    expect(res.body).toEqual({ error: "Нельзя удалить самого себя" });
    expect(storageMock.deleteAccount).not.toHaveBeenCalled();
  });

  it("404s when the target does not exist (already deleted, or bad id)", async () => {
    const { del } = routeApp();
    storageMock.getUser.mockImplementation((id: string) =>
      Promise.resolve(id === ADMIN.id ? ADMIN : undefined));
    const res = response();

    const nextError = await invoke(del.get("/api/admin/users/:id")!, request(ADMIN.id, { id: "ghost" }), res);

    expect(nextError).toBeUndefined();
    expect(res.code).toBe(404);
    expect(res.body).toEqual({ error: "Пользователь не найден" });
    expect(storageMock.deleteAccount).not.toHaveBeenCalled();
  });

  it("refuses to delete another admin", async () => {
    const { del } = routeApp();
    storageMock.getUser.mockImplementation((id: string) =>
      Promise.resolve(id === ADMIN.id ? ADMIN : OTHER_ADMIN));
    const res = response();

    const nextError = await invoke(del.get("/api/admin/users/:id")!, request(ADMIN.id, { id: OTHER_ADMIN.id }), res);

    expect(nextError).toBeUndefined();
    expect(res.code).toBe(403);
    expect(res.body).toEqual({ error: "Нельзя удалить другого администратора" });
    expect(storageMock.getActiveRide).not.toHaveBeenCalled();
    expect(storageMock.deleteAccount).not.toHaveBeenCalled();
  });

  it("blocks deletion while the rider has an active ride, without unlinking anything", async () => {
    const { del } = routeApp();
    storageMock.getUser.mockImplementation((id: string) =>
      Promise.resolve(id === ADMIN.id ? ADMIN : RIDER));
    storageMock.getActiveRide.mockResolvedValue({ id: 99, status: "active" });
    const res = response();

    const nextError = await invoke(del.get("/api/admin/users/:id")!, request(ADMIN.id, { id: RIDER.id }), res);

    expect(nextError).toBeUndefined();
    expect(res.code).toBe(409);
    expect(res.body).toEqual({ error: "Сначала завершите активную поездку." });
    expect(storageMock.listPaymentMethods).not.toHaveBeenCalled();
    expect(storageMock.deleteAccount).not.toHaveBeenCalled();
  });

  it("blocks deletion while a card/SBP binding is still pending", async () => {
    const { del } = routeApp();
    storageMock.getUser.mockImplementation((id: string) =>
      Promise.resolve(id === ADMIN.id ? ADMIN : RIDER));
    storageMock.listPaymentMethods.mockResolvedValue([
      { id: 13, type: "card", status: "pending", provider: "tbank" },
    ]);
    const res = response();

    const nextError = await invoke(del.get("/api/admin/users/:id")!, request(ADMIN.id, { id: RIDER.id }), res);

    expect(nextError).toBeUndefined();
    expect(res.code).toBe(409);
    expect(res.body).toEqual({
      error: "Дождитесь завершения или отмените привязку карты/СБП перед удалением аккаунта.",
    });
    expect(unlinkPaymentMethodForUserMock).not.toHaveBeenCalled();
    expect(storageMock.deleteAccount).not.toHaveBeenCalled();
  });

  it("propagates an unlink failure and stops before deleting the account", async () => {
    const { del } = routeApp();
    storageMock.getUser.mockImplementation((id: string) =>
      Promise.resolve(id === ADMIN.id ? ADMIN : RIDER));
    storageMock.listPaymentMethods.mockResolvedValue([
      { id: 14, type: "card", status: "active", provider: "tbank", customerKey: "user-1", cardId: "card-14" },
    ]);
    unlinkPaymentMethodForUserMock.mockResolvedValue({
      ok: false, status: 503, error: "Не удалось отвязать карту в платёжном сервисе. Попробуйте позже.",
    });
    const res = response();

    const nextError = await invoke(del.get("/api/admin/users/:id")!, request(ADMIN.id, { id: RIDER.id }), res);

    expect(nextError).toBeUndefined();
    expect(res.code).toBe(503);
    expect(res.body).toEqual({ error: "Не удалось отвязать карту в платёжном сервисе. Попробуйте позже." });
    expect(storageMock.deleteAccount).not.toHaveBeenCalled();
  });

  it("maps a deleteAccount race (active_ride) to 409", async () => {
    const { del } = routeApp();
    storageMock.getUser.mockImplementation((id: string) =>
      Promise.resolve(id === ADMIN.id ? ADMIN : RIDER));
    storageMock.deleteAccount.mockResolvedValue({ error: "active_ride" });
    const res = response();

    const nextError = await invoke(del.get("/api/admin/users/:id")!, request(ADMIN.id, { id: RIDER.id }), res);

    expect(nextError).toBeUndefined();
    expect(res.code).toBe(409);
    expect(res.body).toEqual({ error: "Сначала завершите активную поездку." });
  });

  it("maps a deleteAccount race (not_found, e.g. already deleted concurrently) to 404", async () => {
    const { del } = routeApp();
    storageMock.getUser.mockImplementation((id: string) =>
      Promise.resolve(id === ADMIN.id ? ADMIN : RIDER));
    storageMock.deleteAccount.mockResolvedValue({ error: "not_found" });
    const res = response();

    const nextError = await invoke(del.get("/api/admin/users/:id")!, request(ADMIN.id, { id: RIDER.id }), res);

    expect(nextError).toBeUndefined();
    expect(res.code).toBe(404);
    expect(res.body).toEqual({ error: "Пользователь не найден" });
  });
});
