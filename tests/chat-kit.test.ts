import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { changedFiles, findDataDir, main, prepareWorkspace } from "../chat-edition/kit.js";
import { buildSessionPacket } from "../core/slicer.js";
import { DEFAULT_SPACING } from "../core/spacing.js";
import type { DataPaths, PacketOptions } from "../core/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STARTER = join(ROOT, "examples", "starter-data", "data");
const PROBE_PATCH = join(ROOT, "chat-edition", "skills", "tutor-probe", "probe-patch.json");
const FILES = ["curriculum.yaml", "profile.md", "lesson-history.md"];

/** The starter data as a Project would hold it: flat, in a fresh temp dir. */
function flatStarter(): string {
  const dir = mkdtempSync(join(tmpdir(), "chat-kit-data-"));
  for (const f of FILES) copyFileSync(join(STARTER, f), join(dir, f));
  return dir;
}

const snapshot = (dir: string) =>
  Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));

/** Run the CLI with console output captured instead of printed. */
function run(args: string[]): { code: number; out: string } {
  let out = "";
  const grab = (...a: unknown[]) => void (out += a.join(" ") + "\n");
  const saved = { log: console.log, error: console.error, write: process.stdout.write };
  console.log = grab;
  console.error = grab;
  process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
  try {
    return { code: main(args), out };
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    process.stdout.write = saved.write;
  }
}

const OPTS: PacketOptions = {
  size: "tight",
  model: "claude.ai",
  historyN: 3,
  spacing: DEFAULT_SPACING,
  today: "2026-11-08",
};

test("chat kit: the packet from a flat Project copy matches the repo layout's", () => {
  const data = flatStarter();
  const ws = prepareWorkspace(data, join(mkdtempSync(join(tmpdir(), "chat-kit-work-")), "w"));
  const repoPaths: DataPaths = {
    curriculum: join(STARTER, "curriculum.yaml"),
    profile: join(STARTER, "profile.md"),
    history: join(STARTER, "lesson-history.md"),
    projectsDir: join(STARTER, "projects"),
    unitSummaries: join(STARTER, "unit-summaries.json"),
  };
  assert.equal(buildSessionPacket(ws.paths, OPTS), buildSessionPacket(repoPaths, OPTS));

  const cli = run(["start", "--data", data, "--work", ws.workDir, "--today", OPTS.today, "--size", "tight"]);
  assert.equal(cli.code, 0);
  assert.equal(cli.out, buildSessionPacket(repoPaths, OPTS));
});

test("chat kit: start refuses to guess the date", () => {
  const data = flatStarter();
  const r = run(["start", "--data", data, "--work", join(data, "..", "w-nodate")]);
  assert.equal(r.code, 1);
  assert.match(r.out, /--today/);
});

test("chat kit: commit writes only the changed files to --out, never the data dir", () => {
  const data = flatStarter();
  const before = snapshot(data);
  const base = mkdtempSync(join(tmpdir(), "chat-kit-commit-"));
  const out = join(base, "out");
  const work = join(base, "work");

  const dry = run(["commit", "--data", data, "--work", work, "--out", out, "--patch", PROBE_PATCH, "--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.ok(!existsSync(out), "dry run writes nothing");

  const r = run(["commit", "--data", data, "--work", work, "--out", out, "--patch", PROBE_PATCH]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(readdirSync(out).sort(), ["curriculum.yaml", "lesson-history.md"]);
  assert.match(readFileSync(join(out, "lesson-history.md"), "utf8"), /## Lesson 1 — 2026-01-01/);
  assert.match(r.out, /SAVE THESE BACK/);
  assert.deepEqual(snapshot(data), before, "the Project's copies are untouched");
});

test("chat kit: a rejected patch writes nothing and says to fix the patch", () => {
  const data = flatStarter();
  const base = mkdtempSync(join(tmpdir(), "chat-kit-reject-"));
  const bad = join(base, "bad.json");
  const patch = JSON.parse(readFileSync(PROBE_PATCH, "utf8"));
  patch.lesson.topicIds = ["no-such-topic"];
  writeFileSync(bad, JSON.stringify(patch));
  const r = run(["commit", "--data", data, "--work", join(base, "w"), "--out", join(base, "out"), "--patch", bad]);
  assert.equal(r.code, 1);
  assert.match(r.out, /PATCH REJECTED/);
  assert.ok(!existsSync(join(base, "out")));
});

test("chat kit: project-<lane>.md maps to the lane's project doc and back", () => {
  const data = flatStarter();
  writeFileSync(join(data, "project-ai.md"), "# AI project\n\nDraft.\n");
  const ws = prepareWorkspace(data, join(mkdtempSync(join(tmpdir(), "chat-kit-proj-")), "w"));
  assert.equal(readFileSync(join(ws.paths.projectsDir, "ai.md"), "utf8"), "# AI project\n\nDraft.\n");
  assert.deepEqual(changedFiles(ws), [], "an unchanged copy reports nothing");

  writeFileSync(join(ws.paths.projectsDir, "ai.md"), "# AI project\n\nRevised.\n");
  assert.deepEqual(
    changedFiles(ws).map((c) => c.name),
    ["project-ai.md"]
  );
});

test("chat kit: findDataDir uses the first candidate holding curriculum.yaml", () => {
  const empty = mkdtempSync(join(tmpdir(), "chat-kit-empty-"));
  const data = flatStarter();
  assert.equal(findDataDir(undefined, [empty, data]), data);
  assert.throws(() => findDataDir(undefined, [empty]), /couldn't find curriculum\.yaml/);
  assert.throws(() => findDataDir(empty), /no curriculum\.yaml/);
});
