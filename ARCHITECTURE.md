# Architecture

The system is one loop, run once per lesson:

```
                ┌─────────────────────────────────────────────────┐
                │                    data/                        │
                │  profile.md · curriculum.yaml · lesson-history  │
                └───────┬─────────────────────────────▲───────────┘
                        │ read                        │ validated write
                        ▼                             │
   deterministic   buildSessionPacket()      applySessionPatch()   deterministic
                        │                             ▲
                        ▼                             │
                ┌── session packet ──┐      ┌── session patch ──┐
                │ params, next topic,│      │ lesson entry,     │
                │ recall candidates, │      │ state changes,    │
                │ profile, slice of  │      │ profile edits,    │
                │ curriculum, history│      │ nextUp plan       │
                └─────────┬──────────┘      └─────────▲─────────┘
                          ▼                           │
                       the model teaches (the only non-deterministic step)
```

The packet is the model's **entire context** — it never reads the data files.
The patch is the model's **only write path** — validated, applied atomically,
then git-committed. **One lesson = one commit**; `git revert` undoes a bad one.

## Layers

| Layer | What it owns | Doesn't know about |
|---|---|---|
| `core/` | parsing, selection, validation, patching — pure logic over `DataPaths` | AI, network, HTTP, where files live |
| `scripts/` | CLI entry points; resolves the real paths (`scripts/lib.ts`) | teaching |
| `server/` | HTTP + SSE, the Agent SDK session, the `commit_session` tool | curriculum semantics (delegates to core) |
| `web/` | the PWA; `web/src/demo/` replays a recording instead of calling the server | everything server-side |
| `skills/` | the Claude Code flows + the teaching contract (shared with the app) | implementation |

On disk, that's:

```
data/        the state: profile.md · curriculum.yaml · lesson-history.md
             (+ unit-summaries.json — derived, viewer-only, regenerable)
core/        deterministic TS library — slicer, selector, validator, patcher
scripts/     CLIs: start-lesson · commit-session · validate · export-lane
server/      Fastify + Claude Agent SDK backend; serves the PWA
web/         the PWA (vanilla TS + Vite); web/src/demo/ is the static replay
skills/      Claude Code skills + the teaching contract (how lessons are taught)
tests/       node:test suite (npm test)
```

### Reading, as its own path

The loop above is how state *changes*. Reading it back is a separate, strictly
read-only path with no model in it at all: `/api/status`, `/api/report` and
`/api/curriculum` aggregate the same files and spend zero tokens.

The curriculum viewer sits on that path. `core/layout.ts` turns a lane's unit
`prerequisites` into rows for the flowchart; `server/lesson-index.ts` reconstructs
every lesson ever taught by merging three records that accumulated over time
(`usage.jsonl`, transcript headers, and `lesson-history.md` for the oldest
lessons, which predate both). The one piece of generated prose — each unit's
summary — is written ahead of time by `npm run unit-summaries` and cached in
`data/unit-summaries.json` behind a structure hash, so serving a page never
calls a model.

Two invariants make the design hold:

1. **Everything writes through the same patcher.** The CLI (`commit-session`) and
   the app (`server/tutor-tool.ts`) both call `checkPatch` → `applySessionPatch`.
   There is no second write path to corrupt state.
2. **Paths flow from one place.** `scripts/lib.ts` resolves a data root
   (`TUTOR_DATA_DIR`, default: this repo) into a `TutorPaths` object; core takes
   its `DataPaths` subset as an argument. Nothing else touches path logic.

## Suggested reading order

1. **`core/types.ts`** — the data model and the `SessionPatch` contract. Ten
   minutes here explains everything else.
2. **`core/slicer.ts`** — how a packet is assembled (what the model gets to see).
3. **`core/selector.ts`** — deterministic "what to learn next" + spaced recall
   (lane-paired, sampled above mastery-widened intervals; the curve and its
   constants live in `core/spacing.ts`).
4. **`core/patcher.ts`** — validate-then-apply; note the compute-then-write shape
   so a late failure can't leave a partial write.
5. **`skills/references/teaching-contract.md`** — how lessons are taught; shared
   verbatim between the CLI skill and the app's system prompt. The profile's
   confirmed patterns override its defaults.
6. **`server/tutor-tool.ts`** — the commit pipeline (guards, ledgers, transcript,
   git), serialized through a single write chain.
7. **`server/runner.ts`** — one Agent SDK session per lesson: streaming, revival
   after restart, per-turn cost tracking.
8. **`web/src/lesson/screen.ts`** — the lesson screen orchestrator; each concern
   (bubbles, ratings, wrap-up, SSE, composer) is its own module.

## The feedback loop (how it learns how you learn)

- In-app, any tutor message can be rated (⏫👍👎⏬ + a note). Only a ⏬ interrupts
  the lesson; the rest are held for wrap-up.
- At wrap-up the model distills every rating and folds durable hunches into the
  profile's Working notes as "Preference guess:" bullets.
- Guesses with evidence get **proposed** as confirmed patterns. Proposals are
  never applied — you approve or reject (in-app buttons, or conversationally).
  Only approved patterns enter `## How I learn best`, which then overrides the
  teaching contract's defaults in every future lesson.

## Demo mode

`vite build web --mode demo` sets a compile-time `__DEMO__` flag: `web/src/api.ts`
swaps the fetch/SSE client for `web/src/demo/replay.ts`, which replays a recorded
lesson (`web/public/demo/lesson.json`) with typewriter pacing. Live builds
tree-shake the demo out entirely (and strip `demo/` from the output); demo builds
have no server, no token, and no way to spend anyone's money.
