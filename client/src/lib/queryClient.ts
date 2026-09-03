import { QueryClient, QueryFunction } from "@tanstack/react-query";

export { errorMessage } from "./error-message";

export const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

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
    csrfTokenPromise = fetchCsrfToken()
      .then((token) => {
        csrfToken = token;
        return token;
      })
      .finally(() => {
        csrfTokenPromise = null;
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
): Promise<Response> {
  const needsCsrf = !SAFE_METHODS.has(method.toUpperCase());

  const send = async (token?: string) =>
    fetch(`${API_BASE}${url}`, {
      method,
      headers: {
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...(needsCsrf && token ? { "x-csrf-token": token } : {}),
        ...extraHeaders,
      },
      body: data ? JSON.stringify(data) : undefined,
      credentials: "include",
    });

  let res = await send(needsCsrf ? await getCsrfToken() : undefined);

  if (needsCsrf && (await isCsrfRejection(res))) {
    res = await send(await getCsrfToken(true));
  }

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
