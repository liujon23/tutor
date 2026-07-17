/// <reference types="vite/client" />

// Injected by vite.config.ts's `define` at build time — one id per build,
// compared against GET /api/version to power the "update available" toast.
declare const __BUILD_ID__: string;
