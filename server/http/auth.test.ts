import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Audit HIGH #24: server/http/auth.ts (OTP registration, phone/email change,
// OAuth linking + sign-in) had zero test coverage. Storage/SMS/email/crypto
// are mocked — these assert routing, validation and session-mutation logic,
// not real SMS delivery, DB rows or provider tokens.

const storageMock = vi.hoisted(() => ({
  getUser: vi.fn(),
  updateProfile: vi.fn(),
  startOtp: vi.fn(),
  verifyOtp: vi.fn(),
  recordOtpSend: vi.fn(),
  getLastOtpSend: vi.fn(),
  updateOtpProviderStatus: vi.fn(),
  startPhoneChange: vi.fn(),
  verifyPhoneChange: vi.fn(),
  startEmailChange: vi.fn(),
  verifyEmailChange: vi.fn(),
  unlinkEmail: vi.fn(),
  listOauthIdentities: vi.fn(),
  unlinkOauthIdentity: vi.fn(),
  linkOauthIdentity: vi.fn(),
  findUserByOauth: vi.fn(),
}));

const smsMock = vi.hoisted(() => ({
  sendOtpSms: vi.fn(),
  getSmsDiagnostics: vi.fn(),
  smsProvider: vi.fn(),
  getSigmaSmsSendingStatus: vi.fn(),
}));

const emailMock = vi.hoisted(() => ({
  sendOtpEmail: vi.fn(),
}));

const logMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock("../storage", () => ({ storage: storageMock }));
vi.mock("../index", () => ({ log: logMock }));
vi.mock("../logger", () => ({ logger: loggerMock, log: logMock }));
vi.mock("./../sms", () => smsMock);
vi.mock("./../email", () => emailMock);
vi.mock("./../tbank", () => ({}));
vi.mock("./../payments/tbank-handlers", () => ({}));
vi.mock("./context", () => ({
  riderId: vi.fn(),
  isStaffSession: vi.fn(),
  canManageRide: vi.fn(),
  actorName: vi.fn(),
  clientIp: vi.fn((req: any) => req.ip),
  requireRole: vi.fn(() => vi.fn()),
  requireAuth: vi.fn(),
  requireRoleWhenConfigured: vi.fn(),
  otpLimiter: vi.fn(),
  otpPhoneLimiter: vi.fn(),
  paymentLimiter: vi.fn(),
}));

import { registerAuthRoutes } from "./auth";

type Handler = (req: any, res: any) => Promise<unknown> | unknown;

function routeApp() {
  const post = new Map<string, Handler>();
  const get = new Map<string, Handler>();
  const patch = new Map<string, Handler>();
  const register = (target: Map<string, Handler>) => (path: string, ...handlers: any[]) => {
    target.set(path, handlers.at(-1));
  };
  registerAuthRoutes({ get: register(get), post: register(post), patch: register(patch) } as any);
  return { post, get, patch };
}

function response() {
  const res = {
    code: 200,
    body: undefined as unknown,
    redirectedTo: undefined as string | undefined,
    status(code: number) { this.code = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    redirect(url: string) { this.redirectedTo = url; return this; },
  };
  return res;
}

function request(opts: {
  session?: Record<string, any>;
  body?: unknown;
  query?: Record<string, string>;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}) {
  const session: Record<string, any> = { ...(opts.session ?? {}) };
  session.save = (cb: () => void) => cb();
  // Mirrors express-session's real `regenerate`: wipes existing session data
  // (session-fixation defense) before the caller re-populates userId, but
  // keeps the same object reference so assertions on the passed-in `req`
  // still see fields set after regenerate resolves.
  session.regenerate = (cb: (err: Error | null) => void) => {
    for (const key of Object.keys(session)) {
      if (key !== "save" && key !== "regenerate") delete session[key];
    }
    cb(null);
  };
  return {
    session,
    body: opts.body ?? {},
    query: opts.query ?? {},
    params: opts.params ?? {},
    headers: opts.headers ?? {},
    ip: "203.0.113.10",
    protocol: "https",
    socket: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/auth/otp/start", () => {
  it("rejects invalid input before touching storage", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/auth/otp/start")!(
      request({ body: { name: "A", phone: "+79991234567", consent: true } }),
      res,
    );

    expect(res.code).toBe(400);
    expect(storageMock.startOtp).not.toHaveBeenCalled();
  });

  it("rejects when consent is not accepted", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/auth/otp/start")!(
      request({ body: { name: "Иван Иванов", phone: "+79991234567", consent: false } }),
      res,
    );

    expect(res.code).toBe(400);
    expect(storageMock.startOtp).not.toHaveBeenCalled();
  });

  it("dispatches an SMS and returns resend timing on success", async () => {
    storageMock.startOtp.mockResolvedValue({ ok: true, phone: "+79991234567", code: "123456", resendInSec: 60 });
    smsMock.sendOtpSms.mockResolvedValue({ provider: "sigmasms", providerMessageId: "sms-1", providerStatus: "queued" });
    const { post } = routeApp();
    const res = response();

    await post.get("/api/auth/otp/start")!(
      request({ body: { name: "Иван Иванов", phone: "+79991234567", consent: true } }),
      res,
    );

    expect(storageMock.recordOtpSend).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "+79991234567", provider: "sigmasms" }),
    );
    expect(res.body).toMatchObject({ phone: "+79991234567", resendInSec: 60, providerStatus: "queued" });
    expect((res.body as any).devCode).toBeUndefined();
  });

  it("echoes the dev code only when the SMS layer flags devEcho", async () => {
    storageMock.startOtp.mockResolvedValue({ ok: true, phone: "+79991234567", code: "654321", resendInSec: 60 });
    smsMock.sendOtpSms.mockResolvedValue({ provider: "dev", devEcho: true });
    const { post } = routeApp();
    const res = response();

    await post.get("/api/auth/otp/start")!(
      request({ body: { name: "Иван Иванов", phone: "+79991234567", consent: true } }),
      res,
    );

    expect((res.body as any).devCode).toBe("654321");
  });

  it("maps a resend-lock error from storage to 429", async () => {
    storageMock.startOtp.mockResolvedValue({ error: "Повторная отправка кода будет доступна через 30 с", retryAfterSec: 30 });
    const { post } = routeApp();
    const res = response();

    await post.get("/api/auth/otp/start")!(
      request({ body: { name: "Иван Иванов", phone: "+79991234567", consent: true } }),
      res,
    );

    expect(res.code).toBe(429);
    expect(smsMock.sendOtpSms).not.toHaveBeenCalled();
  });

  it("returns 502 without leaking rider state when SMS dispatch throws", async () => {
    storageMock.startOtp.mockResolvedValue({ ok: true, phone: "+79991234567", code: "123456", resendInSec: 60 });
    smsMock.sendOtpSms.mockRejectedValue(new Error("provider down"));
    const { post } = routeApp();
    const res = response();

    await post.get("/api/auth/otp/start")!(
      request({ body: { name: "Иван Иванов", phone: "+79991234567", consent: true } }),
      res,
    );

    expect(res.code).toBe(502);
  });
});

describe("POST /api/auth/otp/verify", () => {
  it("rejects a malformed (non-6-digit) code before calling storage", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/auth/otp/verify")!(
      request({ body: { phone: "+79991234567", code: "12" } }),
      res,
    );

    expect(res.code).toBe(400);
    expect(storageMock.verifyOtp).not.toHaveBeenCalled();
  });

  it("creates a session on a correct code and returns the user", async () => {
    storageMock.verifyOtp.mockResolvedValue({ user: { id: "user-1", name: "Иван", phone: "+79991234567", role: "rider" } });
    const { post } = routeApp();
    const res = response();
    const req = request({ body: { phone: "+79991234567", code: "123456" } });

    await post.get("/api/auth/otp/verify")!(req, res);

    expect(req.session.userId).toBe("user-1");
    expect(res.code).toBe(201);
    expect(res.body).toMatchObject({ id: "user-1" });
  });

  it("regenerates the session id on login (audit LOW: session fixation)", async () => {
    storageMock.verifyOtp.mockResolvedValue({ user: { id: "user-1", name: "Иван", phone: "+79991234567", role: "rider" } });
    const { post } = routeApp();
    const res = response();
    // Simulate an attacker-fixed pre-auth session carrying unrelated data —
    // it must be gone by the time the rider is logged in.
    const req = request({ body: { phone: "+79991234567", code: "123456" }, session: { attackerPlanted: "evil" } });
    const regenerateSpy = vi.spyOn(req.session, "regenerate");

    await post.get("/api/auth/otp/verify")!(req, res);

    expect(regenerateSpy).toHaveBeenCalledTimes(1);
    expect(req.session.attackerPlanted).toBeUndefined();
    expect(req.session.userId).toBe("user-1");
    expect(res.code).toBe(201);
  });

  it("does not create a session on a wrong code", async () => {
    storageMock.verifyOtp.mockResolvedValue({ error: "Неверный код. Осталось попыток: 4" });
    const { post } = routeApp();
    const res = response();
    const req = request({ body: { phone: "+79991234567", code: "000000" } });

    await post.get("/api/auth/otp/verify")!(req, res);

    expect(req.session.userId).toBeUndefined();
    expect(res.code).toBe(400);
  });
});

describe("GET /api/users/current", () => {
  it("returns null for an anonymous session without querying storage", async () => {
    const { get } = routeApp();
    const res = response();

    await get.get("/api/users/current")!(request({ session: {} }), res);

    expect(res.body).toBeNull();
    expect(storageMock.getUser).not.toHaveBeenCalled();
  });

  it("clears a stale session id when the user no longer exists", async () => {
    storageMock.getUser.mockResolvedValue(undefined);
    const { get } = routeApp();
    const res = response();
    const req = request({ session: { userId: "ghost" } });

    await get.get("/api/users/current")!(req, res);

    expect(req.session.userId).toBeUndefined();
    expect(res.body).toBeNull();
  });

  it("returns the current user for a valid session", async () => {
    storageMock.getUser.mockResolvedValue({ id: "user-1", name: "Иван" });
    const { get } = routeApp();
    const res = response();

    await get.get("/api/users/current")!(request({ session: { userId: "user-1" } }), res);

    expect(res.body).toMatchObject({ id: "user-1" });
  });
});

describe("PATCH /api/users/me", () => {
  it("requires an authenticated session", async () => {
    const { patch } = routeApp();
    const res = response();

    await patch.get("/api/users/me")!(request({ session: {}, body: { name: "Иван" } }), res);

    expect(res.code).toBe(401);
    expect(storageMock.updateProfile).not.toHaveBeenCalled();
  });

  it("rejects a name shorter than 2 characters", async () => {
    const { patch } = routeApp();
    const res = response();

    await patch.get("/api/users/me")!(
      request({ session: { userId: "user-1" }, body: { name: "A" } }),
      res,
    );

    expect(res.code).toBe(400);
    expect(storageMock.updateProfile).not.toHaveBeenCalled();
  });

  it("updates the name for the logged-in rider", async () => {
    storageMock.updateProfile.mockResolvedValue({ user: { id: "user-1", name: "Иван Петров" } });
    const { patch } = routeApp();
    const res = response();

    await patch.get("/api/users/me")!(
      request({ session: { userId: "user-1" }, body: { name: "Иван Петров" } }),
      res,
    );

    expect(storageMock.updateProfile).toHaveBeenCalledWith("user-1", { name: "Иван Петров" });
    expect(res.body).toMatchObject({ name: "Иван Петров" });
  });

  it("never accepts a phone or email change through this endpoint", async () => {
    storageMock.updateProfile.mockResolvedValue({ user: { id: "user-1", name: "Иван" } });
    const { patch } = routeApp();
    const res = response();

    await patch.get("/api/users/me")!(
      request({ session: { userId: "user-1" }, body: { name: "Иван", phone: "+79990000000", email: "x@example.com" } }),
      res,
    );

    // Схема zod выбрасывает неизвестные ключи — в storage почти всегда только name.
    expect(storageMock.updateProfile).toHaveBeenCalledWith("user-1", { name: "Иван" });
  });
});

describe("Phone change flow", () => {
  it("/phone/start requires an authenticated session", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/users/me/phone/start")!(
      request({ session: {}, body: { phone: "+79997654321" } }),
      res,
    );

    expect(res.code).toBe(401);
    expect(storageMock.startPhoneChange).not.toHaveBeenCalled();
  });

  it("/phone/start sends an SMS to the new number", async () => {
    storageMock.startPhoneChange.mockResolvedValue({ ok: true, phone: "+79997654321", code: "111111", resendInSec: 60 });
    smsMock.sendOtpSms.mockResolvedValue({ provider: "sigmasms" });
    const { post } = routeApp();
    const res = response();

    await post.get("/api/users/me/phone/start")!(
      request({ session: { userId: "user-1" }, body: { phone: "+79997654321" } }),
      res,
    );

    expect(res.body).toMatchObject({ phone: "+79997654321", resendInSec: 60 });
  });

  it("/phone/verify requires an authenticated session", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/users/me/phone/verify")!(
      request({ session: {}, body: { code: "111111" } }),
      res,
    );

    expect(res.code).toBe(401);
    expect(storageMock.verifyPhoneChange).not.toHaveBeenCalled();
  });

  it("/phone/verify applies the change on a correct code", async () => {
    storageMock.verifyPhoneChange.mockResolvedValue({ user: { id: "user-1", phone: "+79997654321" } });
    const { post } = routeApp();
    const res = response();

    await post.get("/api/users/me/phone/verify")!(
      request({ session: { userId: "user-1" }, body: { code: "111111" } }),
      res,
    );

    expect(res.body).toMatchObject({ phone: "+79997654321" });
  });
});

describe("Email change flow", () => {
  it("/email/start requires an authenticated session", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/users/me/email/start")!(
      request({ session: {}, body: { email: "rider@example.com" } }),
      res,
    );

    expect(res.code).toBe(401);
  });

  it("/email/start rejects a malformed email before storage", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/users/me/email/start")!(
      request({ session: { userId: "user-1" }, body: { email: "not-an-email" } }),
      res,
    );

    expect(res.code).toBe(400);
    expect(storageMock.startEmailChange).not.toHaveBeenCalled();
  });

  it("/email/verify applies the change on a correct code", async () => {
    storageMock.verifyEmailChange.mockResolvedValue({ user: { id: "user-1", email: "rider@example.com" } });
    const { post } = routeApp();
    const res = response();

    await post.get("/api/users/me/email/verify")!(
      request({ session: { userId: "user-1" }, body: { code: "222222" } }),
      res,
    );

    expect(res.body).toMatchObject({ email: "rider@example.com" });
  });

  it("/email/unlink requires an authenticated session", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/users/me/email/unlink")!(request({ session: {} }), res);

    expect(res.code).toBe(401);
    expect(storageMock.unlinkEmail).not.toHaveBeenCalled();
  });

  it("/email/unlink clears the email for the logged-in rider", async () => {
    storageMock.unlinkEmail.mockResolvedValue({ user: { id: "user-1", email: null } });
    const { post } = routeApp();
    const res = response();

    await post.get("/api/users/me/email/unlink")!(request({ session: { userId: "user-1" } }), res);

    expect(storageMock.unlinkEmail).toHaveBeenCalledWith("user-1");
    expect(res.body).toMatchObject({ email: null });
  });
});

describe("OAuth identity management", () => {
  it("GET /api/users/me/oauth requires an authenticated session", async () => {
    const { get } = routeApp();
    const res = response();

    await get.get("/api/users/me/oauth")!(request({ session: {} }), res);

    expect(res.code).toBe(401);
  });

  it("GET /api/users/me/oauth lists the caller's linked identities", async () => {
    storageMock.listOauthIdentities.mockResolvedValue([{ provider: "yandex" }]);
    const { get } = routeApp();
    const res = response();

    await get.get("/api/users/me/oauth")!(request({ session: { userId: "user-1" } }), res);

    expect(storageMock.listOauthIdentities).toHaveBeenCalledWith("user-1");
    expect(res.body).toEqual([{ provider: "yandex" }]);
  });

  it("POST /api/users/me/oauth/:provider/unlink rejects an unknown provider", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/users/me/oauth/:provider/unlink")!(
      request({ session: { userId: "user-1" }, params: { provider: "google" } }),
      res,
    );

    expect(res.code).toBe(400);
    expect(storageMock.unlinkOauthIdentity).not.toHaveBeenCalled();
  });

  it("POST /api/users/me/oauth/:provider/unlink removes a known provider", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/users/me/oauth/:provider/unlink")!(
      request({ session: { userId: "user-1" }, params: { provider: "vk" } }),
      res,
    );

    expect(storageMock.unlinkOauthIdentity).toHaveBeenCalledWith("user-1", "vk");
    expect(res.body).toEqual({ ok: true });
  });
});

describe("OAuth start endpoints — CSRF state", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

  it("GET /api/auth/yandex/start returns 503 when not configured", async () => {
    delete process.env.YANDEX_CLIENT_ID;
    const { get } = routeApp();
    const res = response();

    await get.get("/api/auth/yandex/start")!(request({}), res);

    expect(res.code).toBe(503);
  });

  it("GET /api/auth/yandex/start stores a random state in the session and redirects to Yandex", async () => {
    process.env.YANDEX_CLIENT_ID = "client-abc";
    const { get } = routeApp();
    const res = response();
    const req = request({});

    await get.get("/api/auth/yandex/start")!(req, res);

    expect(req.session.oauthState?.yandex).toMatch(/^[0-9a-f]{48}$/);
    expect(res.redirectedTo).toContain("oauth.yandex.ru/authorize");
    expect(res.redirectedTo).toContain(`state=${req.session.oauthState.yandex}`);
  });

  it("GET /api/auth/vk/start stores state + PKCE verifier and redirects to VK", async () => {
    process.env.VK_APP_ID = "vk-app-1";
    const { get } = routeApp();
    const res = response();
    const req = request({});

    await get.get("/api/auth/vk/start")!(req, res);

    expect(req.session.oauthState?.vk).toMatch(/^[0-9a-f]{48}$/);
    expect(req.session.oauthState?.vkCodeVerifier).toBeTruthy();
    expect(res.redirectedTo).toContain("id.vk.com/authorize");
    expect(res.redirectedTo).toContain("code_challenge_method=S256");
  });
});

describe("OAuth callback endpoints — CSRF/state validation", () => {
  it("yandex callback rejects a missing/mismatched state (CSRF guard)", async () => {
    const { get } = routeApp();
    const res = response();
    const req = request({
      session: { oauthState: { yandex: "expected-state" } },
      query: { code: "auth-code", state: "wrong-state" },
    });

    await get.get("/api/auth/yandex/callback")!(req, res);

    expect(res.redirectedTo).toContain("reason=state");
    expect(storageMock.linkOauthIdentity).not.toHaveBeenCalled();
    expect(storageMock.findUserByOauth).not.toHaveBeenCalled();
  });

  it("vk callback rejects when the PKCE code_verifier is missing from the session", async () => {
    const { get } = routeApp();
    const res = response();
    const req = request({
      session: { oauthState: { vk: "expected-state" } }, // no vkCodeVerifier
      query: { code: "auth-code", state: "expected-state" },
    });

    await get.get("/api/auth/vk/callback")!(req, res);

    expect(res.redirectedTo).toContain("reason=state");
  });

  it("yandex callback links to the logged-in session on success", async () => {
    process.env.YANDEX_CLIENT_ID = "client-abc";
    process.env.YANDEX_CLIENT_SECRET = "secret-xyz";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "yandex-42", default_email: "rider@example.com", real_name: "Иван" }) });
    vi.stubGlobal("fetch", fetchMock);
    storageMock.linkOauthIdentity.mockResolvedValue({ ok: true, identity: {} });
    const { get } = routeApp();
    const res = response();
    const req = request({
      session: { userId: "user-1", oauthState: { yandex: "state-1" } },
      query: { code: "auth-code", state: "state-1" },
    });

    await get.get("/api/auth/yandex/callback")!(req, res);

    expect(storageMock.linkOauthIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", provider: "yandex", subject: "yandex-42" }),
    );
    expect(res.redirectedTo).toContain("oauth=linked&provider=yandex");
    vi.unstubAllGlobals();
  });

  it("yandex callback signs in an unauthenticated caller matched by a linked identity", async () => {
    process.env.YANDEX_CLIENT_ID = "client-abc";
    process.env.YANDEX_CLIENT_SECRET = "secret-xyz";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "yandex-42" }) });
    vi.stubGlobal("fetch", fetchMock);
    storageMock.findUserByOauth.mockResolvedValue({ id: "user-7" });
    storageMock.linkOauthIdentity.mockResolvedValue({ ok: true, identity: {} });
    const { get } = routeApp();
    const res = response();
    const req = request({
      session: { oauthState: { yandex: "state-1" } }, // no userId — unauthenticated
      query: { code: "auth-code", state: "state-1" },
    });

    await get.get("/api/auth/yandex/callback")!(req, res);

    expect(req.session.userId).toBe("user-7");
    expect(res.redirectedTo).toContain("oauth=signed-in&provider=yandex");
    vi.unstubAllGlobals();
  });

  it("regenerates the session id on OAuth sign-in (audit LOW: session fixation)", async () => {
    process.env.YANDEX_CLIENT_ID = "client-abc";
    process.env.YANDEX_CLIENT_SECRET = "secret-xyz";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "yandex-42" }) });
    vi.stubGlobal("fetch", fetchMock);
    storageMock.findUserByOauth.mockResolvedValue({ id: "user-7" });
    storageMock.linkOauthIdentity.mockResolvedValue({ ok: true, identity: {} });
    const { get } = routeApp();
    const res = response();
    const req = request({
      // oauthState must survive up to the point it's verified, but the
      // finished session must not carry it (or any pre-auth data) forward.
      session: { oauthState: { yandex: "state-1" }, attackerPlanted: "evil" },
      query: { code: "auth-code", state: "state-1" },
    });
    const regenerateSpy = vi.spyOn(req.session, "regenerate");

    await get.get("/api/auth/yandex/callback")!(req, res);

    expect(regenerateSpy).toHaveBeenCalledTimes(1);
    expect(req.session.attackerPlanted).toBeUndefined();
    expect(req.session.userId).toBe("user-7");
    expect(res.redirectedTo).toContain("oauth=signed-in&provider=yandex");
    vi.unstubAllGlobals();
  });

  it("yandex callback bounces to registration when no user matches (no session, no email match)", async () => {
    process.env.YANDEX_CLIENT_ID = "client-abc";
    process.env.YANDEX_CLIENT_SECRET = "secret-xyz";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "yandex-99" }) });
    vi.stubGlobal("fetch", fetchMock);
    storageMock.findUserByOauth.mockResolvedValue(null);
    const { get } = routeApp();
    const res = response();
    const req = request({
      session: { oauthState: { yandex: "state-1" } },
      query: { code: "auth-code", state: "state-1" },
    });

    await get.get("/api/auth/yandex/callback")!(req, res);

    expect(req.session.userId).toBeUndefined();
    expect(res.redirectedTo).toContain("oauth=need-phone&provider=yandex");
    vi.unstubAllGlobals();
  });

  it("yandex callback fails closed when the token exchange errors", async () => {
    process.env.YANDEX_CLIENT_ID = "client-abc";
    process.env.YANDEX_CLIENT_SECRET = "secret-xyz";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const { get } = routeApp();
    const res = response();
    const req = request({
      session: { userId: "user-1", oauthState: { yandex: "state-1" } },
      query: { code: "auth-code", state: "state-1" },
    });

    await get.get("/api/auth/yandex/callback")!(req, res);

    expect(res.redirectedTo).toContain("reason=token");
    expect(storageMock.linkOauthIdentity).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
