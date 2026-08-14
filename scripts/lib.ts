import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { DataPaths } from "../core/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Load optional .env from the code-repo root. Real environment variables win
 *  (loadEnvFile never overwrites existing keys); missing file is fine. */
function loadDotEnv(): void {
  try {
    process.loadEnvFile(join(ROOT, ".env"));
  } catch {
    /* no .env — fine */
  }
}
loadDotEnv();

/** Everything DataPaths has, plus the app-side dirs that live under the data root. */
export interface TutorPaths extends DataPaths {
  dataRoot: string;
  transcriptsDir: string;
  usageLedger: string;
  feedbackLedger: string;
  appDir: string;
  sessionsDir: string;
  assetsDir: string;
}

/** Pure path resolution — exported for tests. dataRootRaw may be absolute,
 *  relative (resolved against cwd), or undefined (falls back to codeRoot). */
export function resolveTutorPaths(codeRoot: string, dataRootRaw?: string): TutorPaths {
  const dataRoot = dataRootRaw ? resolve(dataRootRaw) : codeRoot;
  const appDir = join(dataRoot, ".app");
  return {
    curriculum: join(dataRoot, "data", "curriculum.yaml"),
    profile: join(dataRoot, "data", "profile.md"),
    history: join(dataRoot, "data", "lesson-history.md"),
    projectsDir: join(dataRoot, "data", "projects"),
    unitSummaries: join(dataRoot, "data", "unit-summaries.json"),
    dataRoot,
    transcriptsDir: join(dataRoot, "transcripts"),
    usageLedger: join(dataRoot, "transcripts", "usage.jsonl"),
    feedbackLedger: join(dataRoot, "transcripts", "feedback.jsonl"),
    appDir,
    sessionsDir: join(appDir, "sessions"),
    assetsDir: join(appDir, "assets"),
  };
}

/** All runtime paths. The data root defaults to this repo (the bundled example
 *  data); point TUTOR_DATA_DIR at a separate folder/repo to keep your own
 *  learning data out of the code checkout. */
export const PATHS: TutorPaths = resolveTutorPaths(ROOT, process.env.TUTOR_DATA_DIR);

/** The core-facing subset (kept as its own export — core/* takes DataPaths). */
export const DATA_PATHS: DataPaths = PATHS;

export function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Tiny --flag value parser. Flags without values become "true". */
export function parseArgs<T extends Record<string, string | undefined>>(
  argv: string[],
  defaults: T
): T {
  const out: Record<string, string | undefined> = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = "true";
  }
  return out as T;
}

/**
 * git add <paths> && commit, in the data root's repository. Returns a message;
 * never throws (write-back already succeeded). `paths` defaults to just `data/`;
 * the app also passes `transcripts/` so the rendered conversation is archived
 * in the same commit.
 */
export function gitCommit(message: string, paths: string[] = ["data"]): string {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: PATHS.dataRoot,
      stdio: "pipe",
    });
  } catch {
    return (
      `WARNING: data dir ${PATHS.dataRoot} is not a git repository — changes written ` +
      "but NOT committed. Run `git init` there for session-level rollback."
    );
  }
  try {
    execFileSync("git", ["add", "--", ...paths], { cwd: PATHS.dataRoot, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", message], { cwd: PATHS.dataRoot, stdio: "pipe" });
    pushInBackground();
    return `git: committed '${message}'`;
  } catch (e) {
    return `WARNING: git commit failed (${(e as Error).message.split("\n")[0]}) — changes written but not committed.`;
  }
}

/**
 * Off-site durability (TUTOR_GIT_PUSH=1): push after a successful commit,
 * without ever delaying or failing it — the commit is already the record;
 * the push is best-effort replication.
 */
function pushInBackground(): void {
  if (process.env.TUTOR_GIT_PUSH !== "1") return;
  execFile("git", ["push"], { cwd: PATHS.dataRoot }, (err) => {
    if (err) console.error(`git push failed (commit is safe locally): ${err.message.split("\n")[0]}`);
    else console.error("git push: ok");
  });
}

export { ROOT };
