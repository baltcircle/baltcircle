import { QueryClient, QueryFunction } from "@tanstack/react-query";

export { errorMessage } from "./error-message";

export const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
let sessionGeneration = 0;
export const getSessionGeneration = () => sessionGeneration;
const SESSION_NOTICE = "takeride-session-changed";
export function announceSessionChange() {
  try { localStorage.setItem(SESSION_NOTICE, crypto.randomUUID()); } catch { /* private browsing */ }
}
export function resetSessionData() {
  sessionGeneration += 1;
  const predicate = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] !== "/api/users/current";
  void queryClient.cancelQueries({ predicate });
  queryClient.removeQueries({ predicate });
  csrfToken = null;
  csrfTokenPromise = null;
}
export function acceptSessionUser(user: { id: string } | null, broadcast = false) {
  if (broadcast) void queryClient.cancelQueries({ queryKey: ["/api/users/current"] });
  const previous = queryClient.getQueryData<{ id: string } | null>(["/api/users/current"]);
  if (previous !== undefined && previous?.id !== user?.id) {
    resetSessionData();
  }
  if (broadcast) announceSessionChange();
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// CSRF synchronizer token (csrf-sync, server/csrf.ts). Cached in memory and
// attached to every mutating request; refreshed lazily on first use and again
// whenever the server rejects a token (e.g. after login/registration
// regenerates the session, which invalidates the previous token).
let csrfToken: string | null = null;
let csrfTokenPromise: Promise<string> | null = null;

async function fetchCsrfToken(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/csrf-token`, { credentials: "include" });
  if (!res.ok) throw new Error("Не удалось получить CSRF-токен");
  const body = (await res.json()) as { csrfToken: string };
  return body.csrfToken;
}

async function getCsrfToken(forceRefresh = false): Promise<string> {
  if (forceRefresh) {
    csrfToken = null;
    csrfTokenPromise = null;
  }
  if (csrfToken) return csrfToken;
  if (!csrfTokenPromise) {
    const generation = sessionGeneration;
    csrfTokenPromise = fetchCsrfToken()
      .then((token) => {
        if (generation === sessionGeneration) csrfToken = token;
        return token;
      })
      .finally(() => {
        if (generation === sessionGeneration) csrfTokenPromise = null;
      });
  }
  return csrfTokenPromise;
}

// The generic error middleware (server/index.ts) responds to a rejected
// synchronizer token with `{ message: "invalid csrf token" }` — every other
// hand-written 403 in the codebase uses an `{ error }` key instead, so this
// is a safe, unambiguous discriminator without depending on response headers.
async function isCsrfRejection(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  try {
    const body = await res.clone().json();
    return body?.message === "invalid csrf token";
  } catch {
    return false;
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const generation = sessionGeneration;
  const needsCsrf = !SAFE_METHODS.has(method.toUpperCase());

  const send = async (token?: string) => {
    // A session can change while the CSRF request is in flight. Never send an
    // old account's mutation with the replacement account's browser cookie.
    if (generation !== sessionGeneration) throw new Error("Сессия изменилась. Повторите действие.");
    return fetch(`${API_BASE}${url}`, {
      method,
      headers: {
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...(needsCsrf && token ? { "x-csrf-token": token } : {}),
        ...extraHeaders,
      },
      body: data ? JSON.stringify(data) : undefined,
      credentials: "include",
      signal,
    });
  };

  let res = await send(needsCsrf ? await getCsrfToken() : undefined);

  if (needsCsrf && (await isCsrfRejection(res))) {
    res = await send(await getCsrfToken(true));
  }

  await throwIfResNotOk(res);
  if (generation !== sessionGeneration) throw new Error("Сессия изменилась. Повторите действие.");
  const json = res.json.bind(res);
  res.json = async () => {
    const data = await json();
    if (generation !== sessionGeneration) throw new Error("Сессия изменилась. Повторите действие.");
    return data;
  };
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey, signal }) => {
    const generation = sessionGeneration;
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`, {
      credentials: "include",
      signal,
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    const data = await res.json();
    if (generation !== sessionGeneration) throw new Error("Сессия изменилась");
    if (queryKey[0] === "/api/users/current") acceptSessionUser(data);
    return data;
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: true,
      refetchOnReconnect: "always",
      staleTime: 15_000,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

// Administrative lists
// and their nested pages/details must revalidate after leaving/reopening them.
for (const path of [
  "/api/admin/users", "/api/admin/rides", "/api/admin/ride-stats", "/api/admin/feedback",
  "/api/admin/analytics", "/api/admin/bikes", "/api/admin/parkings", "/api/admin/map-objects",
  "/api/admin/alerts", "/api/admin/support/chats", "/api/admin/support/tickets", "/api/tickets",
]) {
  queryClient.setQueryDefaults([path], {
    staleTime: 10_000,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
}

// HTTP is an independent recovery path: a healthy SSE heartbeat is not proof
// that a database snapshot succeeded. Poll only mounted/enabled visible queries.
for (const path of ["/api/bikes", "/api/parkings", "/api/map-objects", "/api/rides",
  "/api/rider/history", "/api/rider/stats", "/api/reservations/active",
  "/api/payment-methods", "/api/wallet", "/api/payments", "/api/support/chat"]) {
  queryClient.setQueryDefaults([path], {
    staleTime: 10_000, refetchOnMount: "always", refetchOnWindowFocus: "always",
    refetchOnReconnect: "always", refetchInterval: 30_000,
  });
}
for (const path of ["/api/rides/active", "/api/reservations/active"]) {
  queryClient.setQueryDefaults([path], { staleTime: 0, refetchInterval: 10_000 });
}
queryClient.setQueryDefaults(["/api/users/current"], { refetchInterval: 30_000 });
queryClient.setQueryDefaults(["/api/payments/tbank/config"], {
  staleTime: 15_000, refetchOnMount: "always", refetchInterval: 60_000,
  refetchOnWindowFocus: "always", refetchOnReconnect: "always",
});
