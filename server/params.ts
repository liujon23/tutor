// Small pure helpers used by server/index.ts, split out into their own module
// because index.ts has a top-level `await app.listen(...)` that starts the
// Fastify server on import — tests need these without booting the server.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The model a lesson runs on when the client doesn't say. Tight sessions
 * default to Sonnet (fast, cheap, fits a short window); standard/deep default
 * to Opus. An explicit choice from the client always wins.
 */
export function defaultModel(
  size: "tight" | "standard" | "deep",
  model?: "opus" | "sonnet"
): "opus" | "sonnet" {
  if (model) return model;
  return size === "tight" ? "sonnet" : "opus";
}

/**
 * The web build's id, written by vite.config.ts's emit-build-id plugin to
 * `<distDir>/build-id.txt`. Read fresh per call (not cached) — the file on
 * disk can change under a running server after a rebuild, and the server
 * always serves whatever dist/ currently holds. Null when the build hasn't
 * happened yet (or predates this feature).
 */
export function readBuildId(distDir: string): string | null {
  try {
    return readFileSync(join(distDir, "build-id.txt"), "utf8").trim();
  } catch {
    return null;
  }
}
