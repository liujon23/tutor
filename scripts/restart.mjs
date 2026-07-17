// Fully restart the tutor server — the click-to-run entry point.
//
// Stops a server this script previously started, rebuilds the web app so
// frontend changes are picked up, then starts a fresh server on localhost —
// reached from your phone/iPad over the tailnet as HTTPS through `tailscale
// serve`, which terminates TLS and proxies to this local port. Foreground: the
// window stays open while the server runs; close it to stop, click the shortcut
// again to restart.
//
// Zero dependencies (Node built-ins only) and cross-platform: it launches the
// server as a directly-killable process and tracks its PID in .app/server.pid,
// so the kill path is just process.kill — no lsof/taskkill needed. Pass
// --no-build to skip the rebuild (faster when you only touched server code).
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(ROOT, ".app");
const PID_FILE = join(APP_DIR, "server.pid");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const PORT = Number(process.env.TUTOR_PORT || "4321");
// Bind localhost only: TLS + tailnet exposure are `tailscale serve`'s job, so
// there's no reason to open the raw HTTP port on every interface.
const HOST = process.env.TUTOR_HOST || "127.0.0.1";
const skipBuild = process.argv.includes("--no-build");

// --- 1. Stop the previous server, if we started one -------------------------
function stopPrevious() {
  if (!existsSync(PID_FILE)) return;
  const pid = Number(readFileSync(PID_FILE, "utf8").trim());
  rmSync(PID_FILE, { force: true });
  if (!pid) return;
  try {
    process.kill(pid); // SIGTERM; on Windows this terminates the process too
    console.log(`Stopped the previous server (pid ${pid}).`);
  } catch {
    /* already gone — nothing to do */
  }
}

// --- 2. Wait for the port to actually free up before rebinding --------------
function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

async function waitPortFree(port) {
  for (let i = 0; i < 40; i++) {
    if (await portFree(port)) return true;
    await sleep(250);
  }
  return false;
}

// --- 3. Build, then start a fresh server ------------------------------------
function build() {
  console.log("\n> Rebuilding the web app ...");
  // shell:true is required on Windows: since a 2024 Node security change,
  // spawning npm.cmd/.bat without a shell fails with EINVAL.
  const res = spawnSync(npm, ["run", "build:web"], { cwd: ROOT, stdio: "inherit", env: process.env, shell: true });
  if (res.status !== 0) {
    console.error("\n[x] Build failed — leaving the server stopped. Fix the error above and click again.");
    process.exit(res.status ?? 1);
  }
}

function start() {
  const env = { ...process.env, TUTOR_HOST: HOST };
  console.log(`\n> Starting the tutor (TUTOR_HOST=${env.TUTOR_HOST}, port ${PORT}) ...`);
  console.log(`  On this PC:        http://127.0.0.1:${PORT}`);
  console.log(`  From your phone:   https://<this-pc>.<tailnet>.ts.net/  (via tailscale serve)`);
  console.log("  (Leave this window open while you study; close it to stop.)\n");

  // Run tsx as an in-process loader (`--import tsx`) so the child we spawn IS
  // the listener — its PID is exactly what we track and later kill, with no
  // forwarding through a wrapper process.
  const child = spawn(process.execPath, ["--import", "tsx", join("server", "index.ts")], {
    cwd: ROOT,
    stdio: "inherit",
    env,
  });
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(child.pid), "utf8");

  const cleanup = () => {
    try {
      if (readFileSync(PID_FILE, "utf8").trim() === String(child.pid)) rmSync(PID_FILE, { force: true });
    } catch {
      /* file already gone */
    }
  };
  child.on("exit", (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
  // If this window is closed, take the server down with it.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    });
  }
}

// --- run --------------------------------------------------------------------
console.log("Restarting the tutor server ...");
stopPrevious();
const free = await waitPortFree(PORT);
if (!free) {
  console.error(
    `\n[x] Port ${PORT} is still in use by something this script didn't start.\n` +
      `    Close that other server (or its window) and click again, or set a\n` +
      `    different port: TUTOR_PORT=4322 before launching.`
  );
  process.exit(1);
}
if (!skipBuild) build();
start();
