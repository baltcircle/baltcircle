import { useQuery } from "@tanstack/react-query";
import type { User, UserRole } from "@shared/schema";

export const CURRENT_USER_KEY = ["/api/users/current"] as const;

// Reads the registered rider tied to the current session cookie. Returns null
// when the visitor has not registered yet. Backed by the session cookie, so it
// survives page refresh on the same device.
export function useCurrentUser() {
  const query = useQuery<User | null>({
    queryKey: CURRENT_USER_KEY,
    staleTime: 0,
  });

  const user = query.data ?? null;
  const role = (user?.role as UserRole | undefined) ?? null;

  // `isStaff` means "may reach the operator panel at all". Mechanics are staff
  // but with a restricted view (service + read-only fleet); nav/route gating
  // narrows them down from there. `canManageStaff` mirrors the user-management
  // gate (operator/admin only — mechanics never manage users).
  return {
    user,
    role,
    isRegistered: !!user,
    isStaff: role === "mechanic" || role === "operator" || role === "admin",
    isMechanic: role === "mechanic",
    isOperator: role === "operator",
    isAdmin: role === "admin",
    canManageStaff: role === "operator" || role === "admin",
    isLoading: query.isLoading,
  };
}
