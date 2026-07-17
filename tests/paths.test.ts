import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";

import { resolveTutorPaths } from "../scripts/lib.js";

// A resolved absolute stand-in for the code repo — platform-appropriate.
const CODE_ROOT = resolve(sep, "srv", "tutor-code");

test("no override: every path lives under the code root", () => {
  const p = resolveTutorPaths(CODE_ROOT);
  assert.equal(p.dataRoot, CODE_ROOT);
  assert.equal(p.curriculum, join(CODE_ROOT, "data", "curriculum.yaml"));
  assert.equal(p.profile, join(CODE_ROOT, "data", "profile.md"));
  assert.equal(p.history, join(CODE_ROOT, "data", "lesson-history.md"));
  assert.equal(p.projectsDir, join(CODE_ROOT, "data", "projects"));
  assert.equal(p.transcriptsDir, join(CODE_ROOT, "transcripts"));
  assert.equal(p.usageLedger, join(CODE_ROOT, "transcripts", "usage.jsonl"));
  assert.equal(p.feedbackLedger, join(CODE_ROOT, "transcripts", "feedback.jsonl"));
  assert.equal(p.appDir, join(CODE_ROOT, ".app"));
  assert.equal(p.sessionsDir, join(CODE_ROOT, ".app", "sessions"));
  assert.equal(p.assetsDir, join(CODE_ROOT, ".app", "assets"));
});

test("absolute override: every path moves under the data root", () => {
  const dataRoot = resolve(sep, "srv", "tutor-data");
  const p = resolveTutorPaths(CODE_ROOT, dataRoot);
  assert.equal(p.dataRoot, dataRoot);
  assert.equal(p.curriculum, join(dataRoot, "data", "curriculum.yaml"));
  assert.equal(p.transcriptsDir, join(dataRoot, "transcripts"));
  assert.equal(p.sessionsDir, join(dataRoot, ".app", "sessions"));
  // Nothing points back into the code checkout.
  for (const v of Object.values(p)) assert.ok(!v.startsWith(CODE_ROOT), v);
});

test("Windows-style override resolves with the drive letter intact", () => {
  const raw = "C:\\somewhere\\tutor-data";
  const p = resolveTutorPaths(CODE_ROOT, raw);
  // path.resolve is the contract — same normalization the runtime applies.
  assert.equal(p.dataRoot, resolve(raw));
  assert.equal(p.curriculum, join(resolve(raw), "data", "curriculum.yaml"));
});

test("relative override resolves against the current working directory", () => {
  const p = resolveTutorPaths(CODE_ROOT, "my-data");
  assert.equal(p.dataRoot, resolve("my-data"));
  assert.equal(p.history, join(resolve("my-data"), "data", "lesson-history.md"));
});
