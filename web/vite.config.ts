import { defineConfig, type Plugin } from "vite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

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

// web/public/demo/ (the recording + its two images) is a static folder Vite's
// publicDir copy step includes unconditionally — the __DEMO__ compile-time
// flag only eliminates JS. Delete it from a non-demo build's output so the
// live artifact really does ship zero demo bytes, JS or otherwise.
function stripDemoAssets(outDir: string, isDemo: boolean): Plugin {
  return {
    name: "strip-demo-assets",
    apply: "build",
    async closeBundle() {
      if (isDemo) return;
      await rm(join(here, outDir, "demo"), { recursive: true, force: true });
    },
  };
}

export default defineConfig(({ mode }) => {
  const isDemo = mode === "demo";
  // Separate output dirs so `build:web` (live, served by server/index.ts from
  // web/dist) and `build:demo` (static Pages artifact) never clobber each other.
  const outDir = isDemo ? "dist-demo" : "dist";
  return {
    root: here,
    base: isDemo ? "/tutor/" : "/",
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
      __DEMO__: JSON.stringify(isDemo),
    },
    plugins: [emitBuildId(), stripDemoAssets(outDir, isDemo)],
    build: {
      outDir,
      emptyOutDir: true,
    },
    server: {
      // dev-only: proxy API calls to the backend
      proxy: {
        "/api": "http://127.0.0.1:4321",
      },
    },
  };
});
