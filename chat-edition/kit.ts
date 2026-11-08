/**
 * tutor-kit: the tutor's deterministic core as one self-contained CLI, for the
 * claude.ai "chat edition" (a Project + Skills, no Claude Code). The build
 * (`npm run build:chat-kit`) bundles this file and its imports, `yaml`
 * included, into a single `tutor-kit.mjs` that runs on plain Node in the
 * chat's code sandbox.
 *
 *   node tutor-kit.mjs start    --today YYYY-MM-DD [--lane ID] [--size tight|standard|deep] [--history N]
 *   node tutor-kit.mjs commit   --patch FILE [--dry-run]
 *   node tutor-kit.mjs validate
 *
 * Common: [--data DIR] [--work DIR] [--out DIR]
 *
 * A Project's files are flat (no folders), so the learner's data is a flat set:
 *   curriculum.yaml · profile.md · lesson-history.md · project-<laneId>.md
 * The kit never edits --data in place. Every run copies it into a fresh work
 * dir laid out the way core/ expects (projects/<laneId>.md), works there, and
 * `commit` then copies just the files that changed to --out under their flat
 * names, and lists them, so Claude knows exactly what to save back.
 *
 * Deliberately free of scripts/lib.ts: no .env, no git, no repo paths.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { DataPaths, SessionPatch } from "../core/types.js";
import { buildSessionPacket } from "../core/slicer.js";
import { DEFAULT_SPACING } from "../core/spacing.js";
import { applySessionPatch, checkPatch } from "../core/patcher.js";
import { loadCurriculum } from "../core/curriculum.js";
import { validateCurriculum } from "../core/validator.js";

export const CORE_FILES = ["curriculum.yaml", "profile.md", "lesson-history.md"] as const;
const PROJECT_DOC = /^project-([a-z0-9][a-z0-9-]*)\.md$/i;

/** Where a learner's files may show up in claude.ai's sandbox, most likely first. */
export const DATA_CANDIDATES = ["/mnt/project", "/mnt/user-data/uploads", "."];

export function findDataDir(explicit?: string, candidates = DATA_CANDIDATES): string {
  if (explicit) {
    const d = resolve(explicit);
    if (!existsSync(join(d, "curriculum.yaml"))) throw new Error(`no curriculum.yaml in ${d}`);
    return d;
  }
  for (const c of candidates) {
    if (existsSync(join(c, "curriculum.yaml"))) return resolve(c);
  }
  throw new Error(`couldn't find curriculum.yaml (looked in ${candidates.join(", ")}); pass --data <dir>`);
}

export interface Workspace {
  dataDir: string;
  workDir: string;
  paths: DataPaths;
}

/** Fresh copy of the flat data set into workDir, in core's layout. */
export function prepareWorkspace(dataDir: string, workDir: string): Workspace {
  for (const f of CORE_FILES) {
    if (!existsSync(join(dataDir, f))) throw new Error(`missing ${f} in ${dataDir}`);
  }
  rmSync(workDir, { recursive: true, force: true });
  const projectsDir = join(workDir, "projects");
  mkdirSync(projectsDir, { recursive: true });
  for (const f of CORE_FILES) copyFileSync(join(dataDir, f), join(workDir, f));
  for (const name of readdirSync(dataDir)) {
    const m = PROJECT_DOC.exec(name);
    if (m) copyFileSync(join(dataDir, name), join(projectsDir, `${m[1]}.md`));
  }
  return {
    dataDir,
    workDir,
    paths: {
      curriculum: join(workDir, "curriculum.yaml"),
      profile: join(workDir, "profile.md"),
      history: join(workDir, "lesson-history.md"),
      projectsDir,
      unitSummaries: join(workDir, "unit-summaries.json"),
    },
  };
}

/** Every file in the workspace, keyed by its flat (Project) name. */
function flatFiles(ws: Workspace): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of CORE_FILES) out.set(f, join(ws.workDir, f));
  for (const name of readdirSync(ws.paths.projectsDir)) {
    if (name.endsWith(".md")) out.set(`project-${name}`, join(ws.paths.projectsDir, name));
  }
  return out;
}

/** Flat names whose content differs from (or is new relative to) the data dir. */
export function changedFiles(ws: Workspace): { name: string; path: string }[] {
  const changed: { name: string; path: string }[] = [];
  for (const [name, path] of flatFiles(ws)) {
    const before = join(ws.dataDir, name);
    const now = readFileSync(path, "utf8");
    if (!existsSync(before) || readFileSync(before, "utf8") !== now) changed.push({ name, path });
  }
  return changed;
}

export function defaultOutDir(workDir: string): string {
  return existsSync("/mnt/user-data/outputs") ? "/mnt/user-data/outputs" : join(workDir, "changed");
}

// ---------------------------------------------------------------------------

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = "true";
    else out[key] = argv[++i];
  }
  return out;
}

function printProposals(props: string[]): void {
  console.log("\n================ PROPOSED CONFIRMED-PATTERN CHANGES ================");
  console.log("NOT applied. The learner holds the gate: you propose, they dispose.");
  for (const p of props) console.log(`  * ${p}`);
  console.log("If the learner agrees, put it in profile.approvedConfirmedPatterns in a");
  console.log("patch (fold it into the next lesson's), or they can edit profile.md by hand.");
  console.log("=====================================================================");
}

export function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const f = parseFlags(rest);
  if (!cmd || !["start", "commit", "validate"].includes(cmd)) {
    console.error("usage: tutor-kit.mjs start|commit|validate [--data DIR] (see the file header)");
    return 2;
  }

  let ws: Workspace;
  try {
    const dataDir = findDataDir(f.data);
    ws = prepareWorkspace(dataDir, resolve(f.work ?? join(tmpdir(), "tutor-work")));
  } catch (e) {
    console.error(`tutor-kit: ${(e as Error).message}`);
    return 1;
  }

  if (cmd === "validate") {
    const errors = validateCurriculum(loadCurriculum(ws.paths.curriculum));
    if (errors.length) {
      console.error("CURRICULUM INVALID:\n" + errors.map((e) => `  - ${e}`).join("\n"));
      return 1;
    }
    console.log(`curriculum valid (${ws.dataDir}/curriculum.yaml)`);
    return 0;
  }

  if (cmd === "start") {
    if (!f.today || !/^\d{4}-\d{2}-\d{2}$/.test(f.today)) {
      console.error("start needs --today YYYY-MM-DD (the learner's local date; the sandbox clock is UTC)");
      return 1;
    }
    const size = (f.size ?? "standard") as "tight" | "standard" | "deep";
    if (!["tight", "standard", "deep"].includes(size)) {
      console.error(`--size must be tight|standard|deep (got '${size}')`);
      return 1;
    }
    try {
      process.stdout.write(
        buildSessionPacket(ws.paths, {
          laneId: f.lane,
          size,
          model: f.model ?? "claude.ai",
          historyN: Number(f.history ?? 3),
          spacing: DEFAULT_SPACING,
          today: f.today,
        })
      );
      return 0;
    } catch (e) {
      console.error(`start failed: ${(e as Error).message}`);
      return 1;
    }
  }

  // commit
  if (!f.patch) {
    console.error("commit needs --patch <file>");
    return 1;
  }
  let patch: SessionPatch;
  try {
    patch = JSON.parse(readFileSync(f.patch, "utf8"));
  } catch (e) {
    console.error(`patch is not valid JSON: ${(e as Error).message}`);
    return 1;
  }
  const errors = checkPatch(ws.paths, patch);
  if (errors.length) {
    console.error("PATCH REJECTED (fix the patch, not the data files):\n" + errors.map((e) => `  - ${e}`).join("\n"));
    return 1;
  }
  if (f["dry-run"] === "true") {
    console.log("dry-run: patch is valid. Nothing written.");
    if (patch.profile?.proposedConfirmedPatterns?.length) printProposals(patch.profile.proposedConfirmedPatterns);
    return 0;
  }
  try {
    const res = applySessionPatch(ws.paths, patch);
    const outDir = resolve(f.out ?? defaultOutDir(ws.workDir));
    mkdirSync(outDir, { recursive: true });
    console.log(`Session applied as Lesson ${res.lessonNumber}.`);
    for (const s of res.summary) console.log(`  - ${s}`);
    console.log("\nSAVE THESE BACK TO THE PROJECT (replace the file of the same name):");
    for (const c of changedFiles(ws)) {
      const dest = join(outDir, c.name);
      copyFileSync(c.path, dest);
      console.log(`  ${c.name}  ->  ${dest}`);
    }
    console.log("Until they're saved back, the Project still holds the old versions.");
    if (res.proposedConfirmedPatterns.length) printProposals(res.proposedConfirmedPatterns);
    return 0;
  } catch (e) {
    console.error(`commit failed: ${(e as Error).message}`);
    return 1;
  }
}

// Run as a CLI (bundled or via tsx), but not when imported by tests.
const invoked = process.argv[1] ? basename(process.argv[1]) : "";
if (/^(tutor-kit\.mjs|kit\.ts)$/.test(invoked)) {
  process.exitCode = main(process.argv.slice(2));
}
