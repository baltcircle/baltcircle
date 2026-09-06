// Гейт авто-показа предложения включить уведомления.
//
// Почему промпт вообще нужен, а не «включить по умолчанию»: разрешение на
// уведомления нельзя выдать программно ни в одном браузере, а Safari (iOS 16.4+)
// дополнительно требует, чтобы Notification.requestPermission() был вызван
// синхронно из обработчика пользовательского жеста. Поэтому максимум, что можно
// сделать при первом запуске установленной PWA, — показать своё окно с кнопкой:
// тап по ней и есть тот самый жест.
//
// Гейт нужен, потому что системное окно разрешения показывается ОДИН раз за
// установку: если пользователь отклонит его случайно, вернуть выбор из веба
// уже нельзя. Значит спрашивать надо редко и в осмысленный момент.
//
// Правила те же, что у подсказки «На экран Домой» (lib/pwa.ts), но состояние
// отдельное: это разные решения пользователя и смешивать их счётчики нельзя.

const KEY = "bc.push.optin";

/** Больше трёх авто-показов — назойливость: настройки никуда не денутся. */
export const PUSH_OPTIN_MAX_AUTO_SHOWS = 3;
/** Не чаще раза в трое суток. */
export const PUSH_OPTIN_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

interface OptInState {
  shows: number;
  lastAt: number;
  /** «Больше не предлагать» — гасит только авто-показ, не настройки. */
  dismissed: boolean;
}

const EMPTY_STATE: OptInState = { shows: 0, lastAt: 0, dismissed: false };

function readState(): OptInState {
  if (typeof localStorage === "undefined") return EMPTY_STATE;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as Partial<OptInState>;
    return {
      shows: typeof parsed.shows === "number" && parsed.shows >= 0 ? parsed.shows : 0,
      lastAt: typeof parsed.lastAt === "number" && parsed.lastAt >= 0 ? parsed.lastAt : 0,
      dismissed: parsed.dismissed === true,
    };
  } catch {
    // Повреждённый JSON или Private Mode — ведём себя как при чистом состоянии.
    return EMPTY_STATE;
  }
}

function writeState(state: OptInState): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Квота/Private Mode: предложение просто появится ещё раз позже.
  }
}

/**
 * Показывать ли предложение автоматически.
 *
 * `pushState === "default"` — единственное состояние, в котором есть что
 * предлагать: "granted-*" уже решено (ре-синк подписки делает
 * resyncPushSubscription молча), "denied" из веба не переспросить,
 * "ios-need-standalone"/"unsupported" — не про разрешение.
 */
export function shouldAutoShowPushOptIn(pushState: string, now: number = Date.now()): boolean {
  if (pushState !== "default") return false;
  const state = readState();
  if (state.dismissed) return false;
  if (state.shows >= PUSH_OPTIN_MAX_AUTO_SHOWS) return false;
  return now - state.lastAt >= PUSH_OPTIN_COOLDOWN_MS;
}

export function markPushOptInShown(now: number = Date.now()): void {
  const state = readState();
  writeState({ ...state, shows: state.shows + 1, lastAt: now });
}

export function dismissPushOptInForever(): void {
  const state = readState();
  writeState({ ...state, dismissed: true });
}
