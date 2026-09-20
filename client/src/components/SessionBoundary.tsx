import { useEffect, useRef, useState, type ReactNode } from "react";
import { useCurrentUser, CURRENT_USER_KEY } from "@/hooks/use-current-user";
import { queryClient, resetSessionData } from "@/lib/queryClient";
import { QueryErrorNotice } from "@/components/QueryErrorNotice";

export function SessionBoundary({ children }: { children: ReactNode }) {
  const { user, query } = useCurrentUser();
  const [identity, setIdentity] = useState({ id: user?.id, epoch: 0 });
  const [checkingSession, setCheckingSession] = useState(false);
  const verifiedAt = useRef(0);
  if (identity.id !== user?.id) {
    // Preserve guest onboarding/QR continuation on login, but discard every
    // account-owned local state on logout or an account-to-account switch.
    setIdentity({ id: user?.id, epoch: identity.epoch + (identity.id ? 1 : 0) });
  }
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === "takeride-session-changed") {
        setCheckingSession(true);
        verifiedAt.current = queryClient.getQueryState(CURRENT_USER_KEY)?.dataUpdatedAt ?? 0;
        resetSessionData();
        void queryClient.cancelQueries().then(async () => {
          await queryClient.refetchQueries({ queryKey: CURRENT_USER_KEY });
        });
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  useEffect(() => {
    if (!query.isError && query.dataUpdatedAt > verifiedAt.current) setCheckingSession(false);
  }, [query.dataUpdatedAt, query.isError]);
  if (checkingSession && query.isError) return <div className="p-6"><QueryErrorNotice query={query} /></div>;
  if (query.isPending || checkingSession) return <div role="status" className="p-6">Загрузка аккаунта…</div>;
  if (query.isError && query.data === undefined) return <div className="p-6"><QueryErrorNotice query={query} /></div>;
  // Remount local state only on identity changes, never on navigation/refetch.
  return <div key={identity.epoch} className="contents">{children}</div>;
}
