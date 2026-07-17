// One-shot first-time setup for the tutor app: install dependencies and build
// the PWA, with friendly checks and next-step guidance.
//
// Zero dependencies on purpose — this runs BEFORE `npm install`, so it may only
// use Node built-ins. ASCII-only output so it reads cleanly on any Windows/macOS
// console. Run it with `npm run setup`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

// 3. Auth heads-up (a Claude Code login can't be verified from a plain script).
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
console.log("\nNext steps:");
console.log("  1. Test it on this PC:   npm run serve   then open http://127.0.0.1:4321");
console.log("  2. Reach it from phone:  open https://<pc-tailscale-name>.<tailnet>.ts.net/");
console.log("     (one-time: expose it with `tailscale serve --bg 4321`; see SETUP.md/APP.md)");
console.log("\nSee SETUP.md for the phone walk-through and troubleshooting.");
console.log("------------------------------------------------------------");
