export const INTRO_SHOWN_KEY = "bc.registration.intro.shown";
export const PAYMENT_BANNER_KEY = "bc.payment.banner.dismissed";
// Флаг «бургер-меню открыто». Нужен, чтобы восстановить открытое меню
// после полного reload MapPage — напр. T-Bank reboot на /payment-methods
// перемонтирует страницу и теряет in-memory drawerOpen.
export const DRAWER_OPEN_KEY = "bc.drawer.open";
