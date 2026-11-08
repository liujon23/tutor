# First-time setup

Start-to-finish guide for standing up the tutor on your own machine and (optionally)
reaching it from your phone. Assumes no command-line comfort: if you've never
used a terminal, take [the easy way](#the-easy-way-let-claude-set-it-up) and let
Claude do the typing. The fuller ops reference is **APP.md**.

## Which Claude plan?

Everything here (app lessons, course design, terminal lessons) runs on
**Claude Code**, so you need a plan that includes it.

- **Free: doesn't work.** The free plan doesn't include Claude Code.
- **Pro: everything works.** Lessons share Pro's usage limits with the rest of
  your Claude use. Long lessons on Opus use them up fastest, so pick a *tight*
  lesson or Sonnet to stretch them. The app tells you when you hit the limit and
  offers a one-tap switch to Sonnet.
- **Max: same, with much more room.** Good if you plan to study most days.
- **No subscription: an API key** from the [Anthropic Console](https://console.anthropic.com/),
  billed per use instead of monthly.

Lessons run on *your* account; nothing is shared with anyone else.

## The easy way: let Claude set it up

Claude can do almost all of this for you through the **Code** tab of the Claude
desktop app (included with Pro and Max).

1. Install the Claude desktop app from [claude.com/download](https://claude.com/download)
   and sign in.
2. Make an empty folder with a short path, for example `Documents\Claude` on
   Windows or `Documents/Claude` on a Mac.
3. Open the **Code** tab, choose that folder, and send:

   > Set up the tutor app from https://github.com/liujon23/tutor in this folder,
   > following its SETUP.md. I'm not technical: explain each step in plain
   > words, and stop and tell me exactly what to click or type whenever
   > something needs me.

Claude installs what's missing, downloads the tutor, builds it, and starts it.
A few steps are yours, because they need you personally:

- **Approving installers.** Windows asks "Do you want to allow this app to make
  changes?"; a Mac asks for your password.
- **Your token** ([Step 2](#step-2--auth)). It signs in through your browser, and
  it's a key to your subscription, so run those two commands yourself and don't
  paste the token into the chat.
- **Phone access** ([Step 5](#step-5--reach-it-from-your-phone-optional)):
  making a Tailscale account, signing in on the phone, and *Add to Home Screen*.

Afterwards, whenever you want Claude to design a course with you, open the new
**`tutor`** folder itself in the Code tab (not the folder above it). That's
where Claude finds the tutor's course-design instructions.

## Step 0 — Install the basics

Skip anything you already have. (Claude does this part for you on the easy way.)

- **A terminal** is the window you type commands into. Windows: press Start and
  type *PowerShell*. Mac: press ⌘-Space and type *Terminal*. After installing
  anything below, **close the terminal and open a new one** so it notices.
- **Node.js** (which includes `npm`): the **LTS** installer from
  [nodejs.org](https://nodejs.org/), with every default. The setup script checks
  the version and tells you if yours is too old.
- **Git**: Windows, the installer from [git-scm.com](https://git-scm.com/downloads/win),
  with every default. Mac: run `xcode-select --install` and accept.
- **Claude Code's command-line tool**, which `claude setup-token` needs (the
  desktop app alone may not add it). Windows, in PowerShell:

  ```powershell
  irm https://claude.ai/install.ps1 | iex
  ```

  Mac, in Terminal:

  ```bash
  curl -fsSL https://claude.ai/install.sh | bash
  ```

- **Optional, for phone access:** [Tailscale](https://tailscale.com/) on both
  the PC and the phone, signed in to the same account.

## Step 1 — Install and build

```bash
git clone https://github.com/liujon23/tutor
cd tutor
npm run setup
```

This installs the app's parts, builds it, and creates your `my-data/` folder
from the starter courses (see [Where your data lives](#where-your-data-lives)).
It's safe to run again any time. Every command from here on runs **inside the
`tutor` folder**; if you open a new terminal, `cd` back into it first.

## Step 2 — Auth

The app needs a token that lets it use your Claude plan. Run these two
commands, one at a time:

```bash
claude setup-token
```

```bash
npm run set-token
```

The first signs you in through your browser and prints a long token starting
with `sk-ant-oat`. Copy all of it. The second asks you to paste it (nothing shows
on screen as you paste, on purpose), saves it to a file called `.env`, and
sends a one-line test message to check it works. If the test passes, you're done.

The token is a key to your whole subscription. It lives only in `.env` on this
machine: never in the app's pages, never committed (`.env` is gitignored).

No subscription? Put an API key in `.env` instead: copy `.env.example` to
`.env`, delete the `#` in front of `ANTHROPIC_API_KEY=`, paste the key after the
`=`, and check it with `npm run echo-test`.

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
When you want your own subjects, open Claude Code in the `tutor` folder (in
the desktop app: the Code tab, with `tutor` as the folder) and say *"I want to
start learning X"*. The `course-setup` skill designs a lane with you: goals, a sweep of
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

The first time, it may print a link and wait, asking you to turn on Serve (and
HTTPS certificates) for your tailnet. Open the link, approve, and the command
finishes on its own.

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

The app only works while its server is running on the PC, and the phone can
only reach it while the PC is **on and awake**. If you study from your phone,
set the PC not to sleep while plugged in (Windows: Settings → System → Power;
Mac: System Settings → Battery/Energy).

The simplest way to start it: double-click `restart-tutor.cmd` (Windows) /
`restart-tutor.command` (macOS) in the `tutor` folder, and leave that window
open while you study. Closing the window stops the app. A server Claude started
for you stops when that Claude session ends, so use the launcher day to day. It
also rebuilds first, so it's the one to use after an update too (`npm run
restart` does the same from a terminal). To put it on your Desktop, see
**DEVELOPING.md**.

## Troubleshooting

- **"node / npm / git / claude is not recognized" or "command not found"** —
  you just installed it, but the terminal was already open. Close it, open a new
  one, `cd` back into the `tutor` folder, and try again.
- **"web/dist not found"** — run `npm run setup` (or `npm run build:web`) first.
- **Auth error during a lesson** — redo Step 2 (`claude setup-token`, then
  `npm run set-token`), then restart the server.
- **Saying "I want to start learning X" doesn't start a course design** — Claude
  Code has to be opened in the `tutor` folder itself, where the course-setup
  instructions live (`.claude/skills/`). Reopen it there and ask again.
- **Phone can't connect** — Tailscale running and signed in on *both* devices?
  Server running? `tailscale serve` set up for port 4321? Firewall allowed Node?
- **"unrecognized Host"** — the server only answers to localhost and its own
  tailnet name (it logs the list as `hosts: …` at startup). If you reach it under
  some other name, add it: `TUTOR_ALLOWED_HOSTS=my-name.example` in `.env`.
- **Server refuses to start, complaining about a funnel** — run
  `tailscale funnel --https=443 off`, then `tailscale serve --bg 4321`.
- **"port already in use"** — another copy is running, or set `TUTOR_PORT=4322`
  (and point `tailscale serve` at the same port).
- **Clone fails on Windows with "Filename too long"** — the demo's artwork files
  have long content-hash names, so a deeply nested folder can exceed the legacy
  260-character path limit. Either clone somewhere shorter (`C:\dev\tutor`) or
  run `git config --global core.longpaths true` and clone again.
