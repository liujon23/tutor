import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { DataPaths } from "../core/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Default data root, relative to the code checkout. Gitignored here, so a
 *  user's learning history can never collide with `git pull` or ride along in
 *  a PR branch. */
export const DEFAULT_DATA_DIR = "my-data";

/** The seed copied into an empty data root on first run. */
export const STARTER_TEMPLATE = join(ROOT, "examples", "starter-data");

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
 *  relative (resolved against cwd), or undefined (falls back to the default
 *  data dir inside the code checkout). */
export function resolveTutorPaths(codeRoot: string, dataRootRaw?: string): TutorPaths {
  const dataRoot = dataRootRaw ? resolve(dataRootRaw) : join(codeRoot, DEFAULT_DATA_DIR);
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

/** All runtime paths. The data root defaults to `my-data/` inside this checkout
 *  (gitignored, seeded from the starter template on first run); point
 *  TUTOR_DATA_DIR at any other folder to keep your learning data elsewhere. */
export const PATHS: TutorPaths = resolveTutorPaths(ROOT, process.env.TUTOR_DATA_DIR);

/** True when the user hasn't named a data root, so we're using `my-data/`.
 *  Seeding is only ever automatic in that case — never at a path someone
 *  typed, which may be a typo we shouldn't build a tree at. */
export const DATA_ROOT_IS_DEFAULT = !process.env.TUTOR_DATA_DIR;

/** The core-facing subset (kept as its own export — core/* takes DataPaths). */
export const DATA_PATHS: DataPaths = PATHS;

/** Recursive directory copy. Hand-rolled rather than fs.cpSync, which still
 *  prints an ExperimentalWarning on the Node 20 floor SETUP.md advertises. */
export function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else copyFileSync(src, dst);
  }
}

/**
 * Make sure the data root holds a curriculum, seeding the starter courses if
 * it doesn't. Copies files only — it never runs git, so simply serving the app
 * can't create a repository or a commit behind the user's back. `npm run
 * init-data` is the one place that offers version history.
 *
 * Only the default root is seeded automatically: a missing TUTOR_DATA_DIR may
 * be a typo, and building a tree at a typo is worse than a clear error.
 */
export function ensureDataRoot(): void {
  if (existsSync(PATHS.curriculum)) return;
  if (!DATA_ROOT_IS_DEFAULT) {
    console.error(
      `No learning data at ${PATHS.dataRoot} (looked for data/curriculum.yaml).\n` +
        `TUTOR_DATA_DIR points there — check the path, or set it up with:\n` +
        `  npm run init-data -- --dir "${PATHS.dataRoot}"`
    );
    process.exit(1);
  }
  copyDir(STARTER_TEMPLATE, PATHS.dataRoot);
  console.error(
    `First run: created ${PATHS.dataRoot} from the starter courses — it's yours to edit.\n` +
      `Run \`npm run init-data\` to keep a git history of your lessons.`
  );
}

/** True when `dir` is the top level of its own git repository. A data root
 *  nested inside the code checkout answers "yes" to `--is-inside-work-tree`
 *  by finding the OUTER repo, which is not the same question. */
export function isOwnGitRepo(dir: string): boolean {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
    return samePath(top, dir);
  } catch {
    return false; // not a repo, or git isn't installed
  }
}

/** Path equality across git's forward slashes and Windows' case-insensitivity. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

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
  // Must be its own repo, not merely *inside* one: the default data root sits
  // in the code checkout, where `git add` would refuse the gitignored path and
  // report a baffling error on the wrap-up receipt.
  if (!isOwnGitRepo(PATHS.dataRoot)) {
    return (
      `Saved to ${PATHS.dataRoot}, but not versioned — it isn't a git repository. ` +
      "Run `npm run init-data` for one-commit-per-lesson history and rollback."
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
