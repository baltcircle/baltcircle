import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AdminSupportConversationRow } from "@shared/schema";
import { queryClient, API_BASE } from "@/lib/queryClient";
import { useCurrentUser } from "@/hooks/use-current-user";
import { playSupportChime, primeAudio } from "@/lib/support-notify";

const INBOX_KEY = ["/api/admin/support/chats"];

interface UseSupportUnreadResult {
  unreadTotal: number;
  activeChats: number;
  isLoading: boolean;
}

/**
 * Единая точка правды по непрочитанным чатам поддержки для оператора/админа:
 * — тянет /api/admin/support/chats с polling'ом
 * — подписывается на inbox SSE и подаёт звуковой сигнал при новом сообщении от пользователя
 * — invalidate списка чтобы бейджи и AdminSupportChatsPage синхронно обновились
 *
 * Один раз замонтированный в AppShell/AdminPage, покрывает всю операторскую сессию.
 */
export function useSupportUnread(): UseSupportUnreadResult {
  const { isOperator, isAdmin } = useCurrentUser();
  const enabled = isOperator || isAdmin;

  const q = useQuery<AdminSupportConversationRow[]>({
    queryKey: INBOX_KEY,
    enabled,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  // Разбудить AudioContext на первом клике страницы.
  useEffect(() => {
    if (!enabled) return;
    const wake = () => primeAudio();
    window.addEventListener("pointerdown", wake, { once: true });
    window.addEventListener("keydown", wake, { once: true });
    return () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource(`${API_BASE}/api/admin/support/inbox/stream`, {
      withCredentials: true,
    });

    es.onmessage = (evt) => {
      // Сервер гонит лёгкие полевые объекты ({conversationId, notify?, escalated?}),
      // а не полные SupportMessage — см. server/http/support.ts.
      const payload: { conversationId?: number; notify?: boolean; escalated?: boolean } | null = (() => {
        try {
          return JSON.parse(evt.data);
        } catch {
          return null;
        }
      })();

      // Всегда синхронизируем inbox.
      queryClient.invalidateQueries({ queryKey: INBOX_KEY });

      // Пикаем только когда сообщение действительно требует внимания человека
      // (эскалация или уже идущий human-диалог) — не на тихие FAQ-ответы бота.
      if (payload?.notify) {
        playSupportChime();
      }
    };

    es.onerror = () => {
      /* EventSource переподключится сам */
    };

    return () => es.close();
  }, [enabled]);

  const rows = q.data ?? [];
  const unreadTotal = rows.reduce((s, r) => s + (r.operatorUnreadCount ?? 0), 0);
  const activeChats = rows.length;

  return { unreadTotal, activeChats, isLoading: q.isLoading };
}
