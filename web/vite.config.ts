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

// Vite's publicDir copy step is unconditional — the __DEMO__ compile-time flag
// only eliminates JS — so folders under web/public/ that belong to one build
// have to be deleted from the other's output.
//   demo/  the recording + its images: kept only in the demo build, so the live
//          artifact really does ship zero demo bytes, JS or otherwise.
//   spike/ the throwaway iOS audio diagnostic: kept only in the live build,
//          which is served privately over the tailnet. The demo build is
//          deployed to public GitHub Pages and has no business carrying it.
//          Delete web/public/spike/ once Phase 0 is finished and this entry
//          with it.
function stripPublicDirs(outDir: string, isDemo: boolean): Plugin {
  const drop = isDemo ? ["spike"] : ["demo"];
  return {
    name: "strip-public-dirs",
    apply: "build",
    async closeBundle() {
      for (const dir of drop) {
        await rm(join(here, outDir, dir), { recursive: true, force: true });
      }
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
    plugins: [emitBuildId(), stripPublicDirs(outDir, isDemo)],
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
