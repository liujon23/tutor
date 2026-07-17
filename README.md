# tutor

A personal AI tutoring system with a split brain: **deterministic code does all the
bookkeeping** — curriculum state, topic selection, spaced recall, validation,
write-back, git versioning — so **the AI only does what AI is for: teaching.**

**[▶ Try the demo](https://liujon23.github.io/tutor/)** — a real lesson from the
author's art-history course, replayed in the actual app. No account needed.

<!-- demo GIF goes here once captured from the live Pages deploy -->

## The one idea: rigid scaffolding, fluid teaching

Most AI-tutor setups drift: the model half-remembers what you know, re-asks
settled questions, and loses the thread between sessions. This system splits the
job instead:

- **A deterministic TypeScript core** owns the curriculum (a YAML topic graph with
  knowledge states), your learner profile, and the lesson history. Before each
  lesson it assembles a *session packet* — everything the tutor needs to know,
  computed, not recalled.
- **The model teaches** — freeform, responsive, steered by the packet and by a
  teaching contract — and at the end emits one structured *session patch*.
- **The core validates and applies the patch**, then makes a git commit.
  **Every lesson is one commit.** A bad session is one `git revert` away, and
  your entire learning history is a readable git log.

The system also *learns how you learn*: lessons accumulate observations about
what works for you, and a gated flow (the tutor proposes, you approve) promotes
them into confirmed patterns that shape every future lesson.

## Two ways to run a lesson

1. **In Claude Code** — zero setup if you already use it. Open this repo and say
   *"let's do a lesson"*; the `daily-lesson` skill drives the whole flow in your
   terminal.
2. **The app** — a self-hosted PWA (streaming chat, LaTeX, embedded artwork,
   photo attachments, per-message feedback) served by a small Fastify + Claude
   Agent SDK server on your own machine, reachable from your phone over
   [Tailscale](https://tailscale.com/). Uses **your own Claude subscription**
   via a token from `claude setup-token` (or a metered API key).

Both paths write through the identical core — same packet, same patch, same
commit.

## Quickstart

```bash
git clone https://github.com/liujon23/tutor && cd tutor
npm run setup          # install + build, with sanity checks
```

Then either open Claude Code here and say *"let's do a lesson"*, or:

```bash
claude setup-token     # prints CLAUDE_CODE_OAUTH_TOKEN — put it in .env
cp .env.example .env   # fill in the token
npm run serve          # app on http://127.0.0.1:4321
```

The repo ships with a **three-lane example course** — how modern LLMs work,
Science & Technology Studies, and modern art history — so your first lesson
works out of the box. Make it yours: the `course-setup` skill builds a course on
any subject through a conversation (goals, a prerequisite sweep of what you
already know, then a unit/topic skeleton with curated sources).

Full setup (phone access, keeping your data in its own repo): **[SETUP.md](SETUP.md)**.

## Repo map

```
data/        the state: profile.md · curriculum.yaml · lesson-history.md
core/        deterministic TS library — slicer, selector, validator, patcher
scripts/     CLIs: start-lesson · commit-session · validate · export-lane
server/      Fastify + Claude Agent SDK backend; serves the PWA
web/         the PWA (vanilla TS + Vite); web/src/demo/ is the static replay
skills/      Claude Code skills + the teaching contract (how lessons are taught)
tests/       node:test suite (npm test)
```

Reading the code? **[ARCHITECTURE.md](ARCHITECTURE.md)** has the guided tour.
App operations (auth, Tailscale, usage tracking): **[APP.md](APP.md)**.

## License

[MIT](LICENSE)
