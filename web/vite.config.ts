import { defineConfig, type Plugin } from "vite";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// One id per build, embedded in the bundle (__BUILD_ID__) and also written as
// a plain-text file (dist/build-id.txt) the server reads to answer
// GET /api/version — the substrate for the PWA's "update available" toast.
const buildId = Date.now().toString(36);

function emitBuildId(): Plugin {
  return {
    name: "emit-build-id",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "build-id.txt", source: buildId });
    },
  };
}

export default defineConfig({
  root: here,
  base: "/",
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [emitBuildId()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // dev-only: proxy API calls to the backend
    proxy: {
      "/api": "http://127.0.0.1:4321",
    },
  },
});
