/**
 * TEMP DEBUG: логирует ВСЕ навигации (pushState/replaceState/popstate/href),
 * а также клики по элементам с href="/payment-methods". Показывает fixed overlay
 * в правом нижнем углу с последними 20 событиями.
 *
 * Активируется, если в localStorage стоит bc.debug.nav = "1", ИЛИ если
 * URL содержит ?debug=nav. Первый заход можно активировать так:
 *   https://takeride.ru/?debug=nav
 * После этого работает на всех страницах пока не убрать localStorage.
 *
 * УДАЛИТЬ этот файл и импорт в main.tsx когда баг с /payment-methods найден.
 */

const KEY = "bc.debug.nav";

function isEnabled(): boolean {
  try {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("debug") === "nav") {
      localStorage.setItem(KEY, "1");
      return true;
    }
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

interface Event {
  t: number;
  kind: string;
  from: string;
  to: string;
  extra?: string;
}

let events: Event[] = [];
let overlayEl: HTMLDivElement | null = null;

function stack(): string {
  return new Error().stack?.split("\n").slice(2, 5).join(" | ") ?? "";
}

function log(kind: string, to: string, extra?: string) {
  const from = window.location.pathname + window.location.search;
  events.push({ t: Date.now(), kind, from, to, extra });
  if (events.length > 30) events.shift();
  render();
}

function render() {
  if (!overlayEl) return;
  const rows = events
    .slice(-15)
    .map((e) => {
      const time = new Date(e.t).toISOString().slice(14, 23);
      const extra = e.extra ? ` [${e.extra}]` : "";
      return `<div style="font-size:10px;line-height:1.3;padding:2px 4px;border-bottom:1px solid #333;color:#0f0"><span style="color:#888">${time}</span> <b style="color:#ff0">${e.kind}</b> ${e.from} → <span style="color:#0ff">${e.to}</span>${extra}</div>`;
    })
    .join("");
  overlayEl.innerHTML = `<div style="padding:4px 6px;background:#000;color:#fff;font-size:11px;font-weight:bold;display:flex;justify-content:space-between;align-items:center"><span>NAV DEBUG (${events.length})</span><button id="__bcdbg_clear" style="background:#444;color:#fff;border:none;padding:2px 6px;font-size:10px;border-radius:2px">clear</button><button id="__bcdbg_off" style="background:#a00;color:#fff;border:none;padding:2px 6px;font-size:10px;border-radius:2px">off</button></div>${rows}`;
  const clearBtn = overlayEl.querySelector<HTMLButtonElement>("#__bcdbg_clear");
  clearBtn?.addEventListener("click", () => { events = []; render(); });
  const offBtn = overlayEl.querySelector<HTMLButtonElement>("#__bcdbg_off");
  offBtn?.addEventListener("click", () => {
    localStorage.removeItem(KEY);
    overlayEl?.remove();
    overlayEl = null;
  });
}

function mountOverlay() {
  if (overlayEl) return;
  overlayEl = document.createElement("div");
  overlayEl.style.cssText = [
    "position:fixed",
    "left:8px",
    "bottom:8px",
    "width:min(360px,calc(100vw - 16px))",
    "max-height:50vh",
    "overflow-y:auto",
    "background:rgba(0,0,0,0.92)",
    "color:#fff",
    "font-family:monospace",
    "z-index:2147483647",
    "border-radius:6px",
    "border:1px solid #444",
    "box-shadow:0 4px 24px rgba(0,0,0,0.5)",
    "pointer-events:auto",
  ].join(";");
  document.body.appendChild(overlayEl);
  render();
}

export function installNavDebug() {
  if (!isEnabled()) return;
  if (typeof window === "undefined") return;

  // Ждём body
  const ready = () => {
    mountOverlay();

    // Патчим pushState / replaceState
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState = function (state, title, url) {
      log("pushState", String(url ?? "?"), stack());
      return origPush(state, title, url);
    };
    history.replaceState = function (state, title, url) {
      log("replaceState", String(url ?? "?"), stack());
      return origReplace(state, title, url);
    };

    // popstate = back/forward
    window.addEventListener("popstate", () => {
      log("popstate", window.location.pathname);
    });

    // location.href / location.replace / location.assign
    const origAssign = window.location.assign.bind(window.location);
    const origReplaceLoc = window.location.replace.bind(window.location);
    try {
      window.location.assign = function (url: string | URL) {
        log("location.assign", String(url), stack());
        return origAssign(url as any);
      };
      window.location.replace = function (url: string | URL) {
        log("location.replace", String(url), stack());
        return origReplaceLoc(url as any);
      };
    } catch {
      /* Safari blocks reassignment sometimes — skip */
    }

    // Клики по ссылкам
    document.addEventListener(
      "click",
      (e) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const link = target.closest("a[href]") as HTMLAnchorElement | null;
        if (link) {
          const href = link.getAttribute("href") ?? "";
          log("click:a", href, `text="${link.textContent?.slice(0, 20).trim()}"`);
        }
        const btn = target.closest("button");
        if (btn) {
          const label = (btn.getAttribute("aria-label") ?? btn.textContent ?? "").slice(0, 30).trim();
          if (label) log("click:btn", "-", `"${label}"`);
        }
      },
      true
    );

    // Слушаем overlay:back
    window.addEventListener("overlay:back", () => log("overlay:back", "-"));

    log("init", window.location.pathname, `ref=${document.referrer || "-"}`);
  };

  if (document.body) ready();
  else document.addEventListener("DOMContentLoaded", ready);
}
