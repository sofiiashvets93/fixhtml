/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ADAPTER?: 'local' | 'browser';
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
