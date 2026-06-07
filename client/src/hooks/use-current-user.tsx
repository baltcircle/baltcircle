import { useQuery } from "@tanstack/react-query";
import type { User, UserRole } from "@shared/schema";

export const CURRENT_USER_KEY = ["/api/users/current"] as const;

// Reads the registered rider tied to the current session cookie. Returns null
// when the visitor has not registered yet. Backed by the session cookie, so it
// survives page refresh on the same device.
export function useCurrentUser() {
  const query = useQuery<User | null>({
    queryKey: CURRENT_USER_KEY,
    staleTime: 1000 * 60,
  });

  const user = query.data ?? null;
  const role = (user?.role as UserRole | undefined) ?? null;

  return {
    user,
    role,
    isRegistered: !!user,
    isStaff: role === "operator" || role === "admin",
    isLoading: query.isLoading,
  };
}
