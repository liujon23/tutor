import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { DataPaths, SpacingConfig } from "../core/types.js";
import { DEFAULT_SPACING } from "../core/spacing.js";

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
  recallLedger: string;
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
    lessonDigests: join(dataRoot, "data", "lesson-digests.json"),
    dataRoot,
    transcriptsDir: join(dataRoot, "transcripts"),
    usageLedger: join(dataRoot, "transcripts", "usage.jsonl"),
    feedbackLedger: join(dataRoot, "transcripts", "feedback.jsonl"),
    recallLedger: join(dataRoot, "transcripts", "recall.jsonl"),
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

/**
 * The recall curve from the environment: TUTOR_STALE_DAYS is the interval at
 * streak 0, widened by TUTOR_RECALL_GROWTH on every clean recall. One helper so
 * the server and the CLI commit path can't quote different intervals for the
 * same grade (start-lesson takes them as explicit flags instead).
 */
export function spacingFromEnv(): SpacingConfig {
  return {
    ...DEFAULT_SPACING,
    baseDays: Number(process.env.TUTOR_STALE_DAYS ?? DEFAULT_SPACING.baseDays),
    growth: Number(process.env.TUTOR_RECALL_GROWTH ?? DEFAULT_SPACING.growth),
  };
}

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

/**
 * Set KEY=value in .env contents, preserving every other line — including the
 * commented guidance in .env.example, which seeds the file when there's no .env
 * yet. Lives here rather than in init-data.ts so tests can import it without
 * running that script.
 */
export function upsertEnv(contents: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const lines = contents.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^\\s*#?\\s*${key}\\s*=`).test(l));
  if (at === -1) {
    const body = contents.trimEnd();
    return `${body ? `${body}\n` : ""}${line}\n`;
  }
  lines[at] = line;
  return lines.join("\n");
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
 *
 * `holdPush` skips the TUTOR_GIT_PUSH push for this commit: the lesson commit
 * does this while proposed confirmed patterns are still waiting on the learner,
 * so an approval can still be folded into it (see gitAmendInto). The caller
 * then pushes with `gitPushNow()` once the proposals are resolved; if they never
 * are, the next commit's push carries this one along.
 */
export function gitCommit(
  message: string,
  paths: string[] = ["data"],
  opts: { holdPush?: boolean } = {}
): string {
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
    pushStartedForHead = false; // a fresh HEAD, not yet handed to any remote
    if (!opts.holdPush) pushInBackground();
    return `git: committed '${message}'`;
  } catch (e) {
    return `WARNING: git commit failed (${(e as Error).message.split("\n")[0]}) — changes written but not committed.`;
  }
}

/** HEAD's sha in the data root, or null when there is none (not a repo yet, no
 *  commits, or git isn't installed). Recorded at commit time so a later write
 *  can tell whether HEAD is still the commit it belongs to. */
export function gitHeadSha(): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: PATHS.dataRoot,
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

/** True when HEAD is already contained in its upstream branch — i.e. it has been
 *  published and amending it would rewrite shared history. No upstream means
 *  there is nowhere for it to have gone. */
function headIsPublished(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "@{u}"], {
      cwd: PATHS.dataRoot,
      stdio: "pipe",
    });
  } catch {
    return false; // no upstream configured
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", "@{u}"], {
      cwd: PATHS.dataRoot,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false; // HEAD is ahead of the remote — still local-only
  }
}

/** The inputs to the amend decision, so the rule itself stays pure and testable. */
export interface AmendCheck {
  /** The data root is its own git repository. */
  isOwnRepo: boolean;
  /** Current HEAD in the data root. */
  headSha: string | null;
  /** The commit this write belongs to — the one it may fold into. */
  targetSha: string | undefined;
  /** A background push was started for the current HEAD (may still be in flight). */
  pushStarted: boolean;
  /** HEAD is already contained in its upstream. */
  headIsPublished: boolean;
}

/**
 * Whether a follow-up write may be folded into HEAD instead of adding a commit.
 * Amending is only ever safe on a commit that is still local and still ours:
 * anything else earns a separate commit rather than a rewritten history.
 */
export function shouldAmend(c: AmendCheck): boolean {
  if (!c.isOwnRepo) return false;
  if (!c.targetSha || !c.headSha) return false;
  if (c.headSha !== c.targetSha) return false; // something else committed since
  return !c.pushStarted && !c.headIsPublished;
}

/**
 * Fold staged-and-new changes into the commit `targetSha` (`git commit --amend`)
 * so one lesson stays one commit. Returns a receipt message, or **null** when
 * amending isn't safe or fails — the caller then makes an ordinary commit, which
 * is always correct, just noisier in the log. Never throws.
 */
export function gitAmendInto(targetSha: string | undefined, paths: string[] = ["data"]): string | null {
  const safe = shouldAmend({
    isOwnRepo: isOwnGitRepo(PATHS.dataRoot),
    headSha: gitHeadSha(),
    targetSha,
    pushStarted: pushStartedForHead,
    headIsPublished: headIsPublished(),
  });
  if (!safe) return null;
  try {
    execFileSync("git", ["add", "--", ...paths], { cwd: PATHS.dataRoot, stdio: "pipe" });
    execFileSync("git", ["commit", "--amend", "--no-edit"], { cwd: PATHS.dataRoot, stdio: "pipe" });
    pushInBackground();
    return `git: folded into the lesson's own commit (amended ${targetSha!.slice(0, 7)})`;
  } catch {
    // Nothing was rewritten; anything `git add` staged rides the caller's commit.
    return null;
  }
}

/**
 * Off-site durability (TUTOR_GIT_PUSH=1): push after a successful commit,
 * without ever delaying or failing it — the commit is already the record;
 * the push is best-effort replication.
 */
let pushStartedForHead = false;

/** Push now (when TUTOR_GIT_PUSH=1), for a commit made with `holdPush`.
 *  Same best-effort, never-throws contract as every other push. */
export function gitPushNow(): void {
  if (!isOwnGitRepo(PATHS.dataRoot)) return;
  pushInBackground();
}

function pushInBackground(): void {
  if (process.env.TUTOR_GIT_PUSH !== "1") return;
  // Once a push is under way, HEAD may reach the remote at any moment — from
  // here on it is off-limits to `--amend`, even before the tracking ref moves.
  pushStartedForHead = true;
  execFile("git", ["push"], { cwd: PATHS.dataRoot }, (err) => {
    if (err) console.error(`git push failed (commit is safe locally): ${err.message.split("\n")[0]}`);
    else console.error("git push: ok");
  });
}

export { ROOT };
