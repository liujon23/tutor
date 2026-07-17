# Making changes to the tutor

A short reference for when you edit the tutor and want the change to take effect —
and a one-click way to restart the server. For first-time setup see **SETUP.md**;
for the full ops reference see **APP.md**.

## What takes effect when you change…

The server (`npm run serve`, or the one-click launcher) runs the code as it was
when it started — there's no hot reload. So most changes need a restart:

| You changed… | What to do |
|---|---|
| `server/` or `core/` logic | Restart the server |
| `server/prompt.ts` (how the tutor teaches) | Restart **and** start a *new* lesson — a lesson's instructions are fixed when it's created, so a running lesson keeps the old ones even after a restart |
| `web/src/*` (the UI) | Rebuild + reload: `npm run build:web`, then reload the page. On the phone the installed app caches; reopen it twice (or pull-to-refresh) to pick up the new build |
| `skills/references/teaching-contract.md` (how the tutor teaches, both media) | The single shared source: CLI lessons pick it up immediately; the app splices it into the prompt at server start, so restart **and** start a *new* lesson (same as `prompt.ts`). No more mirroring by hand. |
| other `skills/**` | Nothing for the app — the skill files themselves are the *Claude Code CLI* flow, which the app never reads. They take effect on your next CLI lesson. |
| `data/*` (curriculum, profile) | Nothing to restart — each new lesson reads these fresh |

The **one-click restart below does the first three at once**: it stops the server,
rebuilds the web app, and starts fresh — so after clicking it, both backend and UI
changes are live. (You still start a new lesson to pick up `prompt.ts` changes.)

## The one-click restart

`scripts/restart.mjs` fully restarts the server:

1. **Stops** the server it previously started (tracked by PID in `.app/server.pid`, under your data root)
   and waits for the port to free.
2. **Rebuilds** the web app (`npm run build:web`) so UI changes are included.
3. **Starts** a fresh server on localhost (`127.0.0.1`). Your phone/iPad reach it
   over the tailnet as HTTPS through `tailscale serve`, which terminates TLS and
   proxies to this local port — so make sure that's set up once (`tailscale serve
   --bg 4321`; see APP.md).

It runs in the foreground: the window stays open while the server runs, showing its
log. **Close the window to stop the server; run it again to restart.**

### Running it

- **From a terminal:** `npm run restart`
  (skip the rebuild when you only touched server code: `npm run restart -- --no-build`)
- **By double-click:** use the launcher for your OS, in this folder —
  - **macOS:** `restart-tutor.command`
  - **Windows:** `restart-tutor.cmd`

### Make it a desktop shortcut

- **macOS:** in Finder, drag `restart-tutor.command` to your Desktop while holding
  Option (makes a copy), or right-click it → *Make Alias* and move the alias to the
  Desktop. Double-click to restart. (The first time, macOS may ask you to confirm
  opening it — right-click → *Open* once to allow it.)
- **Windows:** right-click `restart-tutor.cmd` → *Send to → Desktop (create
  shortcut)*, or right-click → *Show more options → Create shortcut* and drag the
  shortcut to your Desktop. Double-click to restart.

### If it doesn't run

- **"node is not recognized / command not found"** — Node isn't on your PATH.
  Reopen the launcher after installing Node (a fresh login, or a reboot, picks up
  the PATH). See SETUP.md.
- **"Port 4321 is still in use"** — a server you started another way (e.g. a stray
  `npm run serve` window) is holding the port. Close that window and click again,
  or start on another port: set `TUTOR_PORT=4322` first.
