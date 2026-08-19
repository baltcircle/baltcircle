import { useEffect, useRef, useState } from "react";
import { DRAWER_OPEN_KEY } from "./map-constants";

/**
 * Состояние бургер-меню на главном экране + его переживание полного
 * reload (возврат с T-Bank на /payment-methods перемонтирует MapPage).
 */
export function useDrawerState() {
  // Восстанавливаем открытое меню СРАЗУ при монтировании из sessionStorage-флага.
  // После возврата с T-Bank приложение грузится с нуля на /payment-methods,
  // MapPage монтируется под оверлеем (z-50). Если меню (z-40) сразу открыто
  // без анимации — оно не видно под оверлеем, а когда оверлей уйдёт (slide-down)
  // — под ним уже готовый открытый бургер (как при обычных меню, без slide-in).
  const [drawerOpen, setDrawerOpenState] = useState(() => {
    try {
      return sessionStorage.getItem(DRAWER_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  // Меню, восстановленное открытым на первом рендере, не должно играть slide-in
  // (оно «уже было открыто» до ухода на T-Bank). Передаём это в DrawerMenu.
  const drawerMountedOpen = useRef(drawerOpen);
  // Счётчик «мгновенного открытия»: при возврате со «Способов оплаты» в бургер
  // (событие drawer:reopen из OverlayRouter) меню должно появиться БЕЗ slide-in —
  // оно логически «уже было открыто» до перехода. Каждый bump просит DrawerMenu
  // отрисовать открытие первым кадром без transition.
  const [drawerInstantTick, setDrawerInstantTick] = useState(0);

  useEffect(() => {
    const reopen = () => {
      setDrawerInstantTick((n) => n + 1);
      setDrawerOpenState(true);
      try {
        sessionStorage.setItem(DRAWER_OPEN_KEY, "1");
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("drawer:reopen", reopen);
    return () => window.removeEventListener("drawer:reopen", reopen);
  }, []);

  // Синхронизируем состояние меню с sessionStorage, чтобы оно переживало
  // полный reload (возврат в меню после привязки карты).
  const setDrawerOpen = (open: boolean) => {
    setDrawerOpenState(open);
    try {
      if (open) sessionStorage.setItem(DRAWER_OPEN_KEY, "1");
      else sessionStorage.removeItem(DRAWER_OPEN_KEY);
    } catch {
      /* private mode — меню просто не восстановится после reload */
    }
  };

  return { drawerOpen, setDrawerOpen, drawerMountedOpen, drawerInstantTick };
}
