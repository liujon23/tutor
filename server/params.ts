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

/**
 * The visible user turn stored when the learner taps "End lesson". The full
 * ordered wrap-up checklist rides along as `modelText` instead, so the model
 * gets its instructions while the transcript keeps a line a human (or a
 * text-to-speech client) can read. The client draws this turn from the `user`
 * SSE event, never optimistically; web/src/lesson/reconcile.ts keeps a copy
 * only so the demo replay shows the same line (tests/reconcile.test.ts).
 */
export const END_TURN_TEXT = "Let's stop here \u2014 recap and wrap up.";

/**
 * An active lesson untouched for this long is auto-abandoned. Seven days, not
 * one: lessons span media and days (recent ones ran 22–51 hours of wall
 * clock), and a Friday drive resumed on Monday must still be there.
 */
export const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** When an active session will be auto-abandoned, given its last activity. */
export function sessionExpiresAt(lastActivityAt: string): string {
  return new Date(Date.parse(lastActivityAt) + SESSION_EXPIRY_MS).toISOString();
}
