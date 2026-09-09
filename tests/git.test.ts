// One lesson = one commit, including the write that lands after it: an approved
// confirmed pattern folds into the lesson's own commit when that is still local,
// and takes a commit of its own the moment amending would rewrite published
// history. The rule is pure (shouldAmend); the mechanics are exercised for real
// against throwaway repositories, one child process per scenario.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { shouldAmend, type AmendCheck } from "../scripts/lib.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = join(ROOT, "tests", "fixtures", "git-probe.ts");

const safe: AmendCheck = {
  isOwnRepo: true,
  headSha: "abc123",
  targetSha: "abc123",
  pushStarted: false,
  headIsPublished: false,
};

test("shouldAmend: only a local commit that is still HEAD may be amended", () => {
  assert.equal(shouldAmend(safe), true);
  assert.equal(shouldAmend({ ...safe, isOwnRepo: false }), false, "unversioned data root");
  assert.equal(shouldAmend({ ...safe, headSha: "def456" }), false, "something committed since");
  assert.equal(shouldAmend({ ...safe, headSha: null }), false, "no commits yet");
  assert.equal(shouldAmend({ ...safe, targetSha: undefined }), false, "lesson predates sha tracking");
  assert.equal(shouldAmend({ ...safe, pushStarted: true }), false, "a push is in flight");
  assert.equal(shouldAmend({ ...safe, headIsPublished: true }), false, "already on the remote");
});

/** A throwaway data root that is its own git repo, seeded like init-data leaves it. */
function makeDataRoot(withRemote: boolean): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "tutor-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "profile.md"), "# Profile\n\n## How I learn best\n\n", "utf8");
  git("init", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Tutor Test");
  git("add", "--", "data");
  git("commit", "-m", "seed");
  if (withRemote) {
    const remote = mkdtempSync(join(tmpdir(), "tutor-remote-"));
    execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });
    git("remote", "add", "origin", remote);
    return { root, cleanup: () => [root, remote].forEach((d) => rmSync(d, { recursive: true, force: true })) };
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runProbe(root: string, scenario: string) {
  const out = execFileSync("npx", ["tsx", PROBE, scenario], {
    cwd: ROOT,
    stdio: "pipe",
    encoding: "utf8",
    env: { ...process.env, TUTOR_DATA_DIR: root, TUTOR_GIT_PUSH: "0" },
  });
  return JSON.parse(out) as {
    lessonSha: string | null;
    amendMessage: string | null;
    fallbackMessage: string | null;
  };
}

const log = (root: string) =>
  execFileSync("git", ["log", "--format=%s"], { cwd: root, stdio: "pipe", encoding: "utf8" })
    .trim()
    .split("\n");

test("an approval on a local lesson commit folds into it — one lesson, one commit", () => {
  const { root, cleanup } = makeDataRoot(false);
  try {
    const res = runProbe(root, "local");
    assert.ok(res.amendMessage?.startsWith("git: folded into"), "amended, not re-committed");
    assert.equal(res.fallbackMessage, null, "no second commit was needed");
    assert.deepEqual(log(root), ["Lesson 1 — 2026-09-09 — ai-attn-mechanism", "seed"]);
    // The approval is inside the lesson commit, and nothing is left uncommitted.
    const tracked = execFileSync("git", ["show", "HEAD:data/profile.md"], {
      cwd: root,
      stdio: "pipe",
      encoding: "utf8",
    });
    assert.ok(tracked.includes("an approved confirmed pattern"), "approval rode the lesson commit");
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], { cwd: root, stdio: "pipe", encoding: "utf8" }).trim(),
      "",
      "working tree clean"
    );
    assert.equal(readFileSync(join(root, "data", "profile.md"), "utf8").includes("a pattern the lesson wrote"), true);
  } finally {
    cleanup();
  }
});

test("a lesson commit already pushed is never rewritten — the approval takes its own commit", () => {
  const { root, cleanup } = makeDataRoot(true);
  try {
    const res = runProbe(root, "published");
    assert.equal(res.amendMessage, null, "declined to amend published history");
    assert.ok(res.fallbackMessage?.startsWith("git: committed"), "fell back to a plain commit");
    assert.deepEqual(log(root), [
      "Approve confirmed pattern(s)",
      "Lesson 1 — 2026-09-09 — ai-attn-mechanism",
      "seed",
    ]);
    // The pushed commit is still exactly the one the remote has.
    const remoteHead = execFileSync("git", ["rev-parse", "origin/main"], {
      cwd: root,
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
    assert.equal(remoteHead, res.lessonSha, "the published commit is untouched");
  } finally {
    cleanup();
  }
});

test("an intervening commit blocks the amend — the approval never rewrites someone else's commit", () => {
  const { root, cleanup } = makeDataRoot(false);
  try {
    const res = runProbe(root, "moved-head");
    assert.equal(res.amendMessage, null, "HEAD is no longer the lesson's commit");
    assert.deepEqual(log(root), [
      "Approve confirmed pattern(s)",
      "something else",
      "Lesson 1 — 2026-09-09 — ai-attn-mechanism",
      "seed",
    ]);
  } finally {
    cleanup();
  }
});
