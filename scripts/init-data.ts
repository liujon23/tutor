/**
 * Set up where your learning data lives.
 *
 *   npm run init-data                       # turn on lesson history where it is
 *   npm run init-data -- --dir ../my-study  # move it somewhere else
 *   npm run init-data -- --dry-run          # say what would happen, touch nothing
 *
 * Two jobs, and this command (with `npm run setup`) is the only place either
 * happens — serving the app never runs git:
 *
 *   1. `git init` the data root, so every lesson becomes one commit. No initial
 *      commit is made: your next lesson is commit #1, and nothing of yours is
 *      ever committed on your behalf.
 *   2. Relocate the data root, moving the folder as-is so an existing history
 *      travels with it, then recording the new path in .env.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";

import {
  copyDir,
  DEFAULT_DATA_DIR,
  isOwnGitRepo,
  parseArgs,
  PATHS,
  ROOT,
  STARTER_TEMPLATE,
} from "./lib.js";

const args = parseArgs(process.argv.slice(2), {
  dir: undefined as string | undefined,
  "dry-run": undefined as string | undefined,
  yes: undefined as string | undefined,
});
const dryRun = args["dry-run"] === "true";
const assumeYes = args.yes === "true";

const current = PATHS.dataRoot;
const target = args.dir ? resolve(args.dir) : current;
const moving = resolve(target) !== resolve(current);

/** Rename, falling back to copy-then-delete across filesystems (EXDEV — a
 *  different drive on Windows, a different mount elsewhere). */
function movePath(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    copyDir(from, to);
    rmSync(from, { recursive: true, force: true });
  }
}

/** Empty or absent — safe to move into or seed. */
function isVacant(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

async function confirm(question: string): Promise<boolean> {
  if (assumeYes || dryRun) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function run(label: string, cmd: string, cmdArgs: string[], cwd: string): void {
  if (dryRun) {
    console.log(`  would ${label}`);
    return;
  }
  execFileSync(cmd, cmdArgs, { cwd, stdio: "pipe" });
  console.log(`  ${label}`);
}

/**
 * Set KEY=value in .env, preserving every other line (including the commented
 * guidance in .env.example, which seeds the file when it doesn't exist yet).
 * Exported for tests.
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

function writeEnv(dataRoot: string): void {
  const envPath = join(ROOT, ".env");
  const base = existsSync(envPath)
    ? readFileSync(envPath, "utf8")
    : existsSync(join(ROOT, ".env.example"))
      ? readFileSync(join(ROOT, ".env.example"), "utf8")
      : "";
  // Always absolute: relative values resolve against the *current directory*,
  // which is only the checkout when run through npm.
  const value = dataRoot;
  if (dryRun) {
    console.log(`  would set TUTOR_DATA_DIR=${value} in .env`);
    return;
  }
  writeFileSync(envPath, upsertEnv(base, "TUTOR_DATA_DIR", value));
  console.log(`  set TUTOR_DATA_DIR=${value} in .env`);
}

async function main(): Promise<void> {
  if (dryRun) console.log("Dry run — nothing will be written.\n");

  // 1. Get the data root into place.
  if (moving) {
    if (!isVacant(target)) {
      console.error(`[x] ${target} already exists and isn't empty. Pick an empty path.`);
      process.exit(1);
    }
    if (existsSync(current)) {
      console.log(`Moving your learning data to ${target}`);
      const carriesHistory = isOwnGitRepo(current);
      if (dryRun) console.log(`  would move ${current} -> ${target}`);
      else {
        movePath(current, target);
        console.log(`  moved ${current} -> ${target}`);
      }
      if (carriesHistory) console.log("  (its git history moved with it)");
    } else {
      console.log(`Creating your learning data at ${target}`);
      if (dryRun) console.log("  would copy the starter courses in");
      else {
        copyDir(STARTER_TEMPLATE, target);
        console.log("  copied the starter courses in");
      }
    }
    writeEnv(target);
  } else if (!existsSync(join(current, "data", "curriculum.yaml"))) {
    console.log(`Creating your learning data at ${current}`);
    if (dryRun) console.log("  would copy the starter courses in");
    else {
      copyDir(STARTER_TEMPLATE, current);
      console.log("  copied the starter courses in");
    }
  }

  // 2. Offer version history.
  if (isOwnGitRepo(target)) {
    console.log(`\n${target} is already a git repository — lesson history is on.`);
  } else if (
    await confirm(`\nKeep a git history of your lessons in ${target}? (one commit per lesson)`)
  ) {
    run("git init", "git", ["init", "-q"], target);
    console.log("  no commit made — your next lesson will be the first one");
  } else {
    console.log("  skipped. Lessons still save normally, just without version history.");
    console.log(`  Change your mind any time: npm run init-data`);
  }

  console.log("\nOff-site backup (optional): add a PRIVATE remote yourself, then");
  console.log("set TUTOR_GIT_PUSH=1 in .env to push after each lesson commit:");
  console.log(`  git -C "${target}" remote add origin <your-private-repo-url>`);
  if (!moving && target === join(ROOT, DEFAULT_DATA_DIR)) {
    console.log(`\n${DEFAULT_DATA_DIR}/ is gitignored here, so pulling code updates`);
    console.log("can never collide with your learning history.");
  }
}

await main();
