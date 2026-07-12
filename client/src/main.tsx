import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerServiceWorker } from "./lib/push";

createRoot(document.getElementById("root")!).render(<App />);

// Регистрируем Service Worker для Web Push. Ошибку не эскалируем — SW опционален.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    registerServiceWorker().catch(() => { /* noop */ });
  });
}
