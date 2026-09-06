/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_YANDEX_MAPS_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Подставляется через define в vite.config.ts; то же значение лежит в
// /version.json рядом со статикой.
declare const __BUILD_ID__: string;
