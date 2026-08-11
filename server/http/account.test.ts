import { beforeEach, describe, expect, it, vi } from "vitest";

const storageMock = vi.hoisted(() => ({
  getUser: vi.fn(),
  getActiveRide: vi.fn(),
  listPaymentMethods: vi.fn(),
  unlinkPaymentMethod: vi.fn(),
  deleteAccount: vi.fn(),
}));
const tbankMock = vi.hoisted(() => ({
  getTbankConfig: vi.fn(),
  tbankRemoveCard: vi.fn(),
}));
const unlinkPaymentMethodForUserMock = vi.hoisted(() => vi.fn());

vi.mock("../storage", () => ({ storage: storageMock }));
vi.mock("../tbank", () => tbankMock);
vi.mock("./payments", () => ({ unlinkPaymentMethodForUser: unlinkPaymentMethodForUserMock }));
vi.mock("./context", () => ({ clientIp: vi.fn(() => "203.0.113.10") }));

import { registerAccountRoutes } from "./account";

type Handler = (req: any, res: any, next: (err?: unknown) => void) => Promise<unknown>;

function routeApp() {
  const post = new Map<string, Handler>();
  const del = new Map<string, Handler>();
  const register = (target: Map<string, Handler>) => (path: string, ...handlers: any[]) => {
    target.set(path, handlers.at(-1));
  };
  registerAccountRoutes({
    post: register(post),
    delete: register(del),
  } as any);
  return { post, del };
}

function response() {
  return {
    code: 200,
    body: undefined as unknown,
    cookies: [] as Array<[string, unknown]>,
    status(code: number) { this.code = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    clearCookie(name: string, options: unknown) { this.cookies.push([name, options]); return this; },
  };
}

function request(session: Record<string, unknown> | undefined = undefined) {
  return { session, ip: "203.0.113.10", socket: {} };
}

async function invoke(handler: Handler, req: any, res: any) {
  let nextError: unknown;
  await handler(req, res, (err?: unknown) => { nextError = err; });
  return nextError;
}

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.getUser.mockResolvedValue({ id: "user-1", phone: "+79991234567" });
  storageMock.getActiveRide.mockResolvedValue(undefined);
  storageMock.listPaymentMethods.mockResolvedValue([]);
  storageMock.unlinkPaymentMethod.mockResolvedValue(true);
  storageMock.deleteAccount.mockResolvedValue({ ok: true });
  tbankMock.getTbankConfig.mockReturnValue({ terminalKey: "test" });
  tbankMock.tbankRemoveCard.mockResolvedValue({ Success: true });
  unlinkPaymentMethodForUserMock.mockResolvedValue({ ok: true });
});

describe("POST /api/auth/logout", () => {
  it("destroys the server-side session and expires the bc.sid cookie", async () => {
    const { post } = routeApp();
    const destroy = vi.fn((done: (err?: Error) => void) => done());
    const res = response();

    const nextError = await invoke(post.get("/api/auth/logout")!, request({ userId: "user-1", destroy }), res);

    expect(nextError).toBeUndefined();
    expect(destroy).toHaveBeenCalledOnce();
    expect(res.cookies).toEqual([[ "bc.sid", expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }) ]]);
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("DELETE /api/account", () => {
  it("unlinks every saved method, anonymizes/deletes account data through storage, and destroys the session", async () => {
    const { del } = routeApp();
    const destroy = vi.fn((done: (err?: Error) => void) => done());
    storageMock.listPaymentMethods.mockResolvedValue([
      {
        id: 11, type: "card", status: "active", provider: "tbank",
        customerKey: "user-1", cardId: "card-11",
      },
      { id: 12, type: "sbp", status: "active", provider: "tbank" },
    ]);
    const res = response();

    const nextError = await invoke(del.get("/api/account")!, request({ userId: "user-1", destroy }), res);

    expect(nextError).toBeUndefined();
    expect(unlinkPaymentMethodForUserMock).toHaveBeenNthCalledWith(
      1, "user-1", expect.objectContaining({ id: 11, cardId: "card-11" }), "203.0.113.10",
    );
    expect(unlinkPaymentMethodForUserMock).toHaveBeenNthCalledWith(
      2, "user-1", expect.objectContaining({ id: 12, type: "sbp" }), "203.0.113.10",
    );
    // DatabaseStorage.deleteAccount owns the transactional PII erasure while
    // deliberately retaining rides/payment ledger rows under the opaque id.
    expect(storageMock.deleteAccount).toHaveBeenCalledWith("user-1");
    expect(destroy).toHaveBeenCalledOnce();
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("blocks deletion while a ride is active without unlinking payment methods", async () => {
    const { del } = routeApp();
    storageMock.getActiveRide.mockResolvedValue({ id: 99, status: "active" });
    const res = response();

    const nextError = await invoke(del.get("/api/account")!, request({ userId: "user-1", destroy: vi.fn() }), res);

    expect(nextError).toBeUndefined();
    expect(res.code).toBe(409);
    expect(res.body).toEqual({ error: "Сначала завершите активную поездку." });
    expect(storageMock.listPaymentMethods).not.toHaveBeenCalled();
    expect(storageMock.deleteAccount).not.toHaveBeenCalled();
  });
});
