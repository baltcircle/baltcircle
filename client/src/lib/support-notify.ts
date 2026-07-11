// Небольшой пик через WebAudio (без внешних файлов).
// Двух-нотный звук: 880 → 660 Гц, ~180 мс общий, ~-20 dB.
// Автоплей политика: работает только после первого пользовательского жеста
// на странице; до этого AudioContext может быть suspended — мы просто пробуем
// и молча падаем, чтобы не спамить консоль.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  try {
    const AC = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    return ctx;
  } catch {
    return null;
  }
}

/** Разбудить AudioContext после первого клика — вызвать один раз на маунт. */
export function primeAudio(): void {
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") {
    void c.resume().catch(() => {});
  }
}

/** Короткий приятный "динь-дон". Ошибки глотаем. */
export function playSupportChime(): void {
  const c = getCtx();
  if (!c) return;
  try {
    if (c.state === "suspended") void c.resume().catch(() => {});

    const now = c.currentTime;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    gain.connect(c.destination);

    const o1 = c.createOscillator();
    o1.type = "sine";
    o1.frequency.setValueAtTime(880, now);
    o1.frequency.exponentialRampToValueAtTime(660, now + 0.18);
    o1.connect(gain);
    o1.start(now);
    o1.stop(now + 0.35);
  } catch {
    /* ignore */
  }
}
