import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";

import { DEFAULT_DATA_DIR, resolveTutorPaths } from "../scripts/lib.js";
import { upsertEnv } from "../scripts/init-data.js";

// A resolved absolute stand-in for the code repo — platform-appropriate.
const CODE_ROOT = resolve(sep, "srv", "tutor-code");
const DEFAULT_ROOT = join(CODE_ROOT, DEFAULT_DATA_DIR);

test("no override: every path lives under the default data dir, not the code root", () => {
  const p = resolveTutorPaths(CODE_ROOT);
  assert.equal(p.dataRoot, DEFAULT_ROOT);
  assert.equal(p.curriculum, join(DEFAULT_ROOT, "data", "curriculum.yaml"));
  assert.equal(p.profile, join(DEFAULT_ROOT, "data", "profile.md"));
  assert.equal(p.history, join(DEFAULT_ROOT, "data", "lesson-history.md"));
  assert.equal(p.projectsDir, join(DEFAULT_ROOT, "data", "projects"));
  assert.equal(p.unitSummaries, join(DEFAULT_ROOT, "data", "unit-summaries.json"));
  assert.equal(p.transcriptsDir, join(DEFAULT_ROOT, "transcripts"));
  assert.equal(p.usageLedger, join(DEFAULT_ROOT, "transcripts", "usage.jsonl"));
  assert.equal(p.feedbackLedger, join(DEFAULT_ROOT, "transcripts", "feedback.jsonl"));
  assert.equal(p.appDir, join(DEFAULT_ROOT, ".app"));
  assert.equal(p.sessionsDir, join(DEFAULT_ROOT, ".app", "sessions"));
  assert.equal(p.assetsDir, join(DEFAULT_ROOT, ".app", "assets"));
  // Nothing lands directly in the checkout, where git would track it.
  for (const v of Object.values(p)) assert.ok(v.startsWith(DEFAULT_ROOT), v);
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
  const p = resolveTutorPaths(CODE_ROOT, "elsewhere");
  assert.equal(p.dataRoot, resolve("elsewhere"));
  assert.equal(p.history, join(resolve("elsewhere"), "data", "lesson-history.md"));
});

// --- .env upsert (init-data records the data root there) ---------------------

test("upsertEnv appends a key that isn't there yet", () => {
  const out = upsertEnv("FOO=1\n", "TUTOR_DATA_DIR", "/srv/data");
  assert.equal(out, "FOO=1\nTUTOR_DATA_DIR=/srv/data\n");
});

test("upsertEnv replaces an existing key in place, keeping other lines", () => {
  const out = upsertEnv("FOO=1\nTUTOR_DATA_DIR=/old\nBAR=2\n", "TUTOR_DATA_DIR", "/new");
  assert.equal(out, "FOO=1\nTUTOR_DATA_DIR=/new\nBAR=2\n");
});

test("upsertEnv uncomments the commented placeholder from .env.example", () => {
  const example = "# Where your data lives\n#TUTOR_DATA_DIR=\n\n#TUTOR_GIT_PUSH=1\n";
  const out = upsertEnv(example, "TUTOR_DATA_DIR", "/srv/data");
  assert.equal(out, "# Where your data lives\nTUTOR_DATA_DIR=/srv/data\n\n#TUTOR_GIT_PUSH=1\n");
  assert.ok(out.includes("#TUTOR_GIT_PUSH=1"), "leaves other commented keys alone");
});

test("upsertEnv handles an empty file", () => {
  assert.equal(upsertEnv("", "TUTOR_DATA_DIR", "/srv/data"), "TUTOR_DATA_DIR=/srv/data\n");
});
