// One-shot first-time setup for the tutor app: install dependencies and build
// the PWA, with friendly checks and next-step guidance.
//
// Zero dependencies on purpose — this runs BEFORE `npm install`, so it may only
// use Node built-ins. ASCII-only output so it reads cleanly on any Windows/macOS
// console. Run it with `npm run setup`.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(args, label) {
  console.log(`\n> ${label} ...`);
  // shell:true is required on Windows: since a 2024 Node security change,
  // spawning npm.cmd/.bat without a shell fails with EINVAL.
  const res = spawnSync(npm, args, { cwd: ROOT, stdio: "inherit", env: process.env, shell: true });
  if (res.status !== 0) {
    console.error(`\n[x] ${label} failed. Fix the error above, then run \`npm run setup\` again.`);
    process.exit(res.status ?? 1);
  }
}

// 1. Sanity: run from the project root, on a new-enough Node.
if (!existsSync(join(ROOT, "package.json"))) {
  console.error("[x] No package.json here — run this from the project root.");
  process.exit(1);
}
const major = Number(process.versions.node.split(".")[0]);
console.log(`Node ${process.versions.node} detected.`);
if (major < 20) {
  console.error(`[x] Node ${major} is too old. Install the current LTS from nodejs.org and re-run.`);
  process.exit(1);
}

// 2. Install + build.
run(["install"], "Installing dependencies");
run(["run", "build:web"], "Building the web app");

// 3. Your learning data: seed it, and turn on lesson history.
//
// This mirrors ensureDataRoot() in scripts/lib.ts, re-implemented on built-ins
// because this file runs before `npm install` and so can't import TypeScript.
// `git init` happens here and in `npm run init-data` and nowhere else — running
// the app never touches git. No commit is made: the first lesson is commit #1.
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else copyFileSync(src, dst);
  }
}

try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  /* no .env, or a Node without loadEnvFile — the default path still applies */
}
const dataRoot = process.env.TUTOR_DATA_DIR
  ? resolve(process.env.TUTOR_DATA_DIR)
  : join(ROOT, "my-data");

if (!existsSync(join(dataRoot, "data", "curriculum.yaml"))) {
  if (process.env.TUTOR_DATA_DIR) {
    console.log(`\n[!] TUTOR_DATA_DIR points at ${dataRoot}, which has no data/curriculum.yaml.`);
    console.log(`    Check the path, or set it up: npm run init-data -- --dir "${dataRoot}"`);
  } else {
    copyDir(join(ROOT, "examples", "starter-data"), dataRoot);
    console.log(`\n> Created ${dataRoot} from the starter courses — your learning data lives there.`);
  }
}

let versioned = false;
try {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dataRoot,
    stdio: "pipe",
    encoding: "utf8",
  }).trim();
  const norm = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  versioned = norm(top) === norm(dataRoot);
} catch {
  /* not a repo, or git isn't installed */
}
if (!versioned && existsSync(dataRoot)) {
  try {
    execFileSync("git", ["init", "-q"], { cwd: dataRoot, stdio: "pipe" });
    console.log("> Lesson history is on: each lesson becomes one commit there (nothing committed yet).");
  } catch {
    console.log("[!] Couldn't run git, so lessons won't be versioned. Install git, then: npm run init-data");
  }
}

// 4. Auth heads-up (a Claude Code login can't be verified from a plain script).
const hasToken = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);

console.log("\n------------------------------------------------------------");
console.log("[ok] Setup complete.");
console.log(
  hasToken
    ? "Auth: a token was found in your environment."
    : [
        "Auth: no token set. The app will try your existing Claude Code login,",
        "      which is usually enough. If a lesson ever fails with an auth error,",
        "      run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN to its output.",
      ].join("\n")
);
console.log(`\nYour data: ${dataRoot}`);
console.log("      (gitignored by this checkout, so `git pull` never touches your lessons.");
console.log("       To keep it somewhere else: npm run init-data -- --dir <path>)");
console.log("\nNext steps:");
console.log("  1. Test it on this PC:   npm run serve   then open http://127.0.0.1:4321");
console.log("  2. Reach it from phone:  open https://<pc-tailscale-name>.<tailnet>.ts.net/");
console.log("     (one-time: expose it with `tailscale serve --bg 4321`; see SETUP.md/APP.md)");
console.log("\nSee SETUP.md for the phone walk-through and troubleshooting.");
console.log("------------------------------------------------------------");
