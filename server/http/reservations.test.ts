import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercises the three reservation routes' request/response shaping in
// isolation from storage/rate-limiting, following the routeApp() pattern
// already established in payments.test.ts.
const storageMock = vi.hoisted(() => ({
  createReservation: vi.fn(),
  cancelReservation: vi.fn(),
  getActiveReservations: vi.fn(),
}));

vi.mock("../storage", () => ({ storage: storageMock }));
vi.mock("./context", () => ({
  requireAuth: vi.fn(),
  riderId: (req: any) => req.session?.userId ?? "demo",
  reservationLimiter: vi.fn(),
}));

import { registerReservationRoutes } from "./reservations";

type Handler = (req: any, res: any) => Promise<unknown>;

function routeApp() {
  const post = new Map<string, Handler>();
  const get = new Map<string, Handler>();
  const register = (target: Map<string, Handler>) => (path: string, ...handlers: any[]) => {
    target.set(path, handlers.at(-1));
  };
  registerReservationRoutes({ get: register(get), post: register(post) } as any);
  return { post, get };
}

function response() {
  const res = {
    code: 200,
    body: undefined as unknown,
    status(code: number) { this.code = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/reservations", () => {
  it("creates a reservation for the authenticated rider and returns 201", async () => {
    const { post } = routeApp();
    const reservation = { id: 5, bikeId: "BC-01", userId: "user-1", status: "active" };
    storageMock.createReservation.mockResolvedValue({ reservation });
    const res = response();

    await post.get("/api/reservations")!(
      { session: { userId: "user-1" }, body: { bikeId: "BC-01" } },
      res,
    );

    expect(storageMock.createReservation).toHaveBeenCalledWith({ bikeId: "BC-01", userId: "user-1" });
    expect(res.code).toBe(201);
    expect(res.body).toEqual(reservation);
  });

  it("rejects a missing bikeId with 400 before touching storage", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/reservations")!({ session: { userId: "user-1" }, body: {} }, res);

    expect(storageMock.createReservation).not.toHaveBeenCalled();
    expect(res.code).toBe(400);
  });

  it("surfaces a domain error (e.g. bike already reserved) as 409", async () => {
    const { post } = routeApp();
    storageMock.createReservation.mockResolvedValue({ error: "Велосипед сейчас «reserved» — забронировать нельзя" });
    const res = response();

    await post.get("/api/reservations")!(
      { session: { userId: "user-1" }, body: { bikeId: "BC-01" } },
      res,
    );

    expect(res.code).toBe(409);
    expect(res.body).toEqual({ error: "Велосипед сейчас «reserved» — забронировать нельзя" });
  });
});

describe("POST /api/reservations/:id/cancel", () => {
  it("cancels the reservation and returns ok:true", async () => {
    const { post } = routeApp();
    storageMock.cancelReservation.mockResolvedValue({ ok: true });
    const res = response();

    await post.get("/api/reservations/:id/cancel")!(
      { session: { userId: "user-1" }, params: { id: "5" } },
      res,
    );

    expect(storageMock.cancelReservation).toHaveBeenCalledWith(5, "user-1");
    expect(res.body).toEqual({ ok: true });
  });

  it("rejects a non-numeric id with 400 before touching storage", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/reservations/:id/cancel")!(
      { session: { userId: "user-1" }, params: { id: "abc" } },
      res,
    );

    expect(storageMock.cancelReservation).not.toHaveBeenCalled();
    expect(res.code).toBe(400);
  });

  it("surfaces a domain error (e.g. not the caller's reservation) as 409", async () => {
    const { post } = routeApp();
    storageMock.cancelReservation.mockResolvedValue({ error: "Это не ваша бронь" });
    const res = response();

    await post.get("/api/reservations/:id/cancel")!(
      { session: { userId: "user-2" }, params: { id: "5" } },
      res,
    );

    expect(res.code).toBe(409);
    expect(res.body).toEqual({ error: "Это не ваша бронь" });
  });
});

describe("GET /api/reservations/active", () => {
  it("returns the rider's active reservations as an array", async () => {
    const { get } = routeApp();
    const reservations = [
      { id: 5, bikeId: "BC-01", userId: "user-1", status: "active" },
      { id: 6, bikeId: "BC-02", userId: "user-1", status: "active" },
    ];
    storageMock.getActiveReservations.mockResolvedValue(reservations);
    const res = response();

    await get.get("/api/reservations/active")!({ session: { userId: "user-1" } }, res);

    expect(storageMock.getActiveReservations).toHaveBeenCalledWith("user-1");
    expect(res.body).toEqual(reservations);
  });

  it("returns an empty array when the rider has no active reservations", async () => {
    const { get } = routeApp();
    storageMock.getActiveReservations.mockResolvedValue([]);
    const res = response();

    await get.get("/api/reservations/active")!({ session: { userId: "user-1" } }, res);

    expect(res.body).toEqual([]);
  });
});
