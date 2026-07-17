# First-time setup

Start-to-finish guide for standing up the tutor on your own machine and (optionally)
reaching it from your phone. Assumes no command-line comfort. The fuller ops
reference is **APP.md**.

## What you need

- **Node.js 20.12+** (includes `npm`) — the setup script checks and will tell you
  if yours is too old.
- **A Claude subscription** (Pro/Max) or an Anthropic API key. Lessons in the app
  run on *your* account; nothing is shared.
- **Optional, for phone access:** [Tailscale](https://tailscale.com/) signed in on
  both the PC and the phone.

## Step 1 — Install and build

```bash
git clone https://github.com/liujon23/tutor && cd tutor
npm run setup
```

Installs dependencies and builds the web app, with sanity checks. Re-runnable any
time.

## Step 2 — Auth

Two paths, pick one:

- **Claude Code lessons only** (terminal): nothing to do — Claude Code's own login
  is enough. Skip to Step 4.
- **The app**: mint a subscription token and put it in `.env`:

  ```bash
  claude setup-token          # prints a CLAUDE_CODE_OAUTH_TOKEN value
  cp .env.example .env        # then paste the token into .env
  ```

  The token is a key to your whole subscription: it lives only on this machine —
  never in the frontend, never committed (`.env` is gitignored). No subscription?
  Set `ANTHROPIC_API_KEY` instead (metered billing). Verify before the first
  lesson:

  ```bash
  npm run echo-test
  ```

## Step 3 — Try the app on the PC

```bash
npm run serve
```

Open **http://127.0.0.1:4321**. You should see the select screen with the bundled
example course (three lanes: AI, Science & Technology Studies, modern art
history). Start a tight lesson and say hello.

## Step 4 — Or run a lesson in Claude Code

Open Claude Code in this folder and say *"let's do a lesson"*. The `daily-lesson`
skill runs the same flow in the terminal — no server, no token setup.

## Step 5 — Make the course yours

The example course is a real, working curriculum — feel free to just start it.
When you want your own subjects, open Claude Code here and say *"I want to start
learning X"* — the `course-setup` skill designs a lane with you: goals, a sweep of
what you already know, then a unit/topic skeleton with curated sources. Add your
name to the top of `data/profile.md` and the tutor will use it.

## Where your data lives (worth deciding early)

Your learning state is three files under `data/` plus archived transcripts —
and **every lesson is a git commit** of them. By default that's this repo, which
works fine: your clone quietly becomes your learning journal.

If you'd rather keep the code checkout clean (so `git pull` never mingles with
your history), point the tutor at a separate folder:

```bash
mkdir ../tutor-data && cp -r data ../tutor-data/data && cd ../tutor-data && git init && cd ../tutor
# in .env:  TUTOR_DATA_DIR=../tutor-data
```

Everything (app, CLI, skills) honors `TUTOR_DATA_DIR`. Set `TUTOR_GIT_PUSH=1` to
also push your data repo after each lesson (off-site backup).

## Step 6 — Reach it from your phone (optional)

With Tailscale on both devices, expose the app over HTTPS **once**:

```bash
tailscale serve --bg 4321
```

Then open `https://<your-pc-name>.<your-tailnet>.ts.net/` on the phone and use
the browser's **Add to Home Screen** — it installs like a native app. The server
itself only ever listens on localhost; Tailscale is what makes it reachable, and
only to your own devices.

## Keeping it running

Leave the server window open while you study. After changing anything,
double-click `restart-tutor.cmd` (Windows) / `restart-tutor.command` (macOS) — or
run `npm run restart` — to rebuild and restart. See **DEVELOPING.md**.

## Troubleshooting

- **"web/dist not found"** — run `npm run setup` (or `npm run build:web`) first.
- **Auth error during a lesson** — Step 2; re-run `npm run echo-test`.
- **Phone can't connect** — Tailscale running and signed in on *both* devices?
  Server running? `tailscale serve` set up for port 4321? Firewall allowed Node?
- **"port already in use"** — another copy is running, or set `TUTOR_PORT=4322`
  (and point `tailscale serve` at the same port).
