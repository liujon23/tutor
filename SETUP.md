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

Installs dependencies, builds the web app, and creates your `my-data/` folder
from the starter courses (see [Where your data lives](#where-your-data-lives)).
Re-runnable any time.

## Step 2 — Auth

Mint a subscription token and put it in `.env`:

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

> **Prefer the terminal?** Lessons can also run inside Claude Code with no
> server and no token — see **CLI.md**.

## Step 4 — Make the course yours

The example course is a real, working curriculum — feel free to just start it.
When you want your own subjects, open Claude Code here and say *"I want to start
learning X"* — the `course-setup` skill designs a lane with you: goals, a sweep of
what you already know, then a unit/topic skeleton with curated sources. Add your
name to the title of `my-data/data/profile.md` and the tutor will use it.

## Where your data lives

Everything the tutor remembers about you — three files under `data/` plus
archived transcripts — lives in **`my-data/`**, created for you on first setup
from the starter courses. It is *not* part of this code repo: `my-data/` is
gitignored here, so pulling code updates can never collide with your learning
history, and nothing personal can ride along if you ever send a pull request.

**Every lesson is one commit** in that folder, which `npm run setup` initializes
as its own little git repository. Your history becomes a readable log, and a bad
lesson's write-back can be undone with `git revert`. Nothing is committed on
your behalf — your first lesson is the first commit.

Two things you might want:

```bash
npm run init-data -- --dir ../my-study   # keep it somewhere else entirely
npm run init-data                        # turn on lesson history if you skipped it
```

Moving it takes your existing history with it and records the new path in
`.env`. For an off-site backup, add a **private** remote yourself and set
`TUTOR_GIT_PUSH=1` in `.env`; each lesson commit then pushes in the background.
Everything (app, CLI, skills) honors `TUTOR_DATA_DIR`.

> Prefer no version control at all? Skip the git step — lessons still save
> normally, you just lose rollback and the readable log.

## Step 5 — Reach it from your phone (optional)

With Tailscale on both devices, expose the app over HTTPS **once**:

```bash
tailscale serve --bg 4321
```

Then open `https://<your-pc-name>.<your-tailnet>.ts.net/` on the phone and use
the browser's **Add to Home Screen** — it installs like a native app. The server
itself only ever listens on localhost; Tailscale is what makes it reachable, and
only to your own devices.

> **`serve`, never `funnel`.** They're one word apart and they do opposite things:
> `tailscale serve` reaches your own devices, `tailscale funnel` publishes to the
> whole internet. The tutor has no login — anyone who reached a funnelled URL could
> read your transcripts and spend your Claude subscription. The server checks for
> this at startup and refuses to run if it finds a funnel on its port, but the
> habit is the real protection.

## Keeping it running

Leave the server window open while you study. After changing anything,
double-click `restart-tutor.cmd` (Windows) / `restart-tutor.command` (macOS) — or
run `npm run restart` — to rebuild and restart. See **DEVELOPING.md**.

## Troubleshooting

- **"web/dist not found"** — run `npm run setup` (or `npm run build:web`) first.
- **Auth error during a lesson** — Step 2; re-run `npm run echo-test`.
- **Phone can't connect** — Tailscale running and signed in on *both* devices?
  Server running? `tailscale serve` set up for port 4321? Firewall allowed Node?
- **"unrecognized Host"** — the server only answers to localhost and its own
  tailnet name (it logs the list as `hosts: …` at startup). If you reach it under
  some other name, add it: `TUTOR_ALLOWED_HOSTS=my-name.example` in `.env`.
- **Server refuses to start, complaining about a funnel** — run
  `tailscale funnel --https=443 off`, then `tailscale serve --bg 4321`.
- **"port already in use"** — another copy is running, or set `TUTOR_PORT=4322`
  (and point `tailscale serve` at the same port).
