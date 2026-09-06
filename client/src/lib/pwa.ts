// Определение iOS / установленной PWA + гейт показов подсказки «На экран Домой».
//
// Единственный источник правды для обеих сторон фичи: lib/push.ts берёт отсюда
// isIos/isStandalone, поэтому состояние "ios-need-standalone" в настройках и
// подсказка об установке физически не могут разойтись.
//
// Зачем подсказка вообще нужна: на iOS подписаться на Web Push можно ТОЛЬКО из
// PWA, установленной на экран «Домой» (Safari 16.4+), программного API
// установки там нет — beforeinstallprompt не существует. Единственный путь —
// объяснить пользователю ручные шаги.

export function isIos(): boolean {
  if (typeof navigator === "undefined" || typeof document === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPad с iPadOS 13+ маскируется под Mac — отличаем по наличию тач-событий.
  const iPadOsMac = ua.includes("Macintosh") && "ontouchend" in document;
  return /iPad|iPhone|iPod/.test(ua) || iPadOsMac;
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const mm = window.matchMedia?.("(display-mode: standalone)").matches;
  // iOS-специфичное свойство: display-mode на старых версиях не срабатывает.
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return !!(mm || iosStandalone);
}

/** iPhone/iPad в обычном Safari — единственный случай, когда подсказка уместна. */
export function canInstallIosPwa(): boolean {
  return isIos() && !isStandalone();
}

const HINT_KEY = "bc.pwa.ios-hint";
/** Больше трёх авто-показов — это уже назойливость, а не подсказка. */
export const IOS_HINT_MAX_AUTO_SHOWS = 3;
/** Не чаще раза в трое суток, даже если аренд за это время было несколько. */
export const IOS_HINT_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

interface HintState {
  shows: number;
  lastAt: number;
  dismissed: boolean;
  /**
   * Ключ повода последнего авто-показа (id поездки). Карта
   * перемонтируется при каждом возвращении с overlay-страницы и после
   * редиректа с оплаты, поэтому «появилась активная аренда» само по себе
   * не событие — иначе окно всплывало бы по несколько раз за одну поездку.
   */
  lastKey: string | null;
}

const EMPTY_STATE: HintState = { shows: 0, lastAt: 0, dismissed: false, lastKey: null };

function readHintState(): HintState {
  if (typeof localStorage === "undefined") return EMPTY_STATE;
  try {
    const raw = localStorage.getItem(HINT_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as Partial<HintState>;
    return {
      shows: typeof parsed.shows === "number" && parsed.shows >= 0 ? parsed.shows : 0,
      lastAt: typeof parsed.lastAt === "number" && parsed.lastAt >= 0 ? parsed.lastAt : 0,
      dismissed: parsed.dismissed === true,
      lastKey: typeof parsed.lastKey === "string" ? parsed.lastKey : null,
    };
  } catch {
    // Повреждённый JSON или Private Mode с запретом на чтение — ведём себя как
    // при чистом состоянии, но не роняем рендер.
    return EMPTY_STATE;
  }
}

function writeHintState(state: HintState): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(HINT_KEY, JSON.stringify(state));
  } catch {
    // Квота/Private Mode: подсказка просто покажется в следующий раз снова.
  }
}

/**
 * Можно ли показать подсказку АВТОМАТИЧЕСКИ (при старте аренды).
 * Ручное открытие из бургер-меню этот гейт не использует — там пользователь
 * попросил инструкцию сам.
 *
 * `key` — идентификатор повода (id поездки): повторный вызов с тем же
 * ключом после показа всегда вернёт false.
 */
export function shouldAutoShowIosInstallHint(key: string, now: number = Date.now()): boolean {
  if (!canInstallIosPwa()) return false;
  const state = readHintState();
  if (state.dismissed) return false;
  if (state.lastKey === key) return false;
  if (state.shows >= IOS_HINT_MAX_AUTO_SHOWS) return false;
  return now - state.lastAt >= IOS_HINT_COOLDOWN_MS;
}

export function markIosInstallHintShown(key: string, now: number = Date.now()): void {
  const state = readHintState();
  writeHintState({ ...state, shows: state.shows + 1, lastAt: now, lastKey: key });
}

/** «Больше не показывать» — навсегда гасит только авто-показ. */
export function dismissIosInstallHintForever(): void {
  const state = readHintState();
  writeHintState({ ...state, dismissed: true });
}
