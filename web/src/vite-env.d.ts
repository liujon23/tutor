/// <reference types="vite/client" />

// Injected by vite.config.ts's `define` at build time — one id per build,
// compared against GET /api/version to power the "update available" toast.
declare const __BUILD_ID__: string;

// Injected by vite.config.ts's `define` at build time — true only for
// `vite build web --mode demo`. Gates all static-demo-mode code so it's
// dead-code-eliminated from the live bundle.
declare const __DEMO__: boolean;
