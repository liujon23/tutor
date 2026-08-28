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
my-data/     YOUR state — gitignored here, and its own git repo:
               data/  profile.md · curriculum.yaml · lesson-history.md
                      (+ unit-summaries.json — derived, viewer-only, regenerable)
               transcripts/ · .app/
core/        deterministic TS library — slicer, selector, validator, patcher
scripts/     CLIs: start-lesson · commit-session · validate · export-lane
server/      Fastify + Claude Agent SDK backend; serves the PWA
web/         the PWA (vanilla TS + Vite); web/src/demo/ is the static replay
skills/      Claude Code skills + the teaching contract (how lessons are taught)
examples/    starter-data/ — what a fresh data root is seeded from
tests/       node:test suite (npm test)
```

The checkout tracks **no** learning data, which is what makes `git pull` safe:
the code you pull and the history you accumulate can never touch the same files.

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

1. **Every write is validate-then-apply, and the rules have one home.** Lesson
   commits — the CLI's `commit-session` and the app's `commit_session` — both go
   `checkPatch` → `applySessionPatch`. The app's one-click recall check is the one
   other writer: `checkRecallCheck` → `applyRecallCheck` in `core/recall.ts`, which
   touches nothing but a topic's `recall` block. The two cannot drift because the
   grading rules live in a single shared function (`applyRecallGrade`) that both
   call, and both refuse to write anything when validation fails.
2. **Paths flow from one place.** `scripts/lib.ts` resolves a data root
   (`TUTOR_DATA_DIR`, default: `my-data/`) into a `TutorPaths` object; core takes
   its `DataPaths` subset as an argument. Nothing else touches path logic.
3. **The tutor runs git only when asked.** `git init` happens in
   `npm run setup` and `npm run init-data`, nowhere else — serving the app can't
   create a repo or a commit behind your back. `gitCommit` requires the data root
   to be its *own* repo, not merely inside one, and degrades to a plain "saved
   but not versioned" note otherwise.

## Suggested reading order

1. **`core/types.ts`** — the data model and the `SessionPatch` contract. Ten
   minutes here explains everything else.
2. **`core/slicer.ts`** — how a packet is assembled (what the model gets to see).
3. **`core/selector.ts`** — deterministic "what to learn next" + spaced recall
   (lane-paired, sampled above mastery-widened intervals; the curve and its
   constants live in `core/spacing.ts`). `pickRecallBundle` is the unsampled
   cross-lane draw behind the app's one-click recall check.
4. **`core/recall.ts`** — the standalone recall write path (grade a topic without
   committing a lesson), and `applyRecallGrade`, the one home for the streak and
   demotion rules that `core/patcher.ts` also calls.
5. **`core/patcher.ts`** — validate-then-apply; note the compute-then-write shape
   so a late failure can't leave a partial write.
6. **`skills/references/teaching-contract.md`** — how lessons are taught; shared
   verbatim between the CLI skill and the app's lesson prompt, with its
   `## Recall grading` section sliced out on its own for the app's recall check.
   The profile's confirmed patterns override its defaults.
7. **`server/tutor-tool.ts`** — the write pipeline (guards, ledgers, transcript,
   git), serialized through a single write chain. Which of its two tools a
   session gets — `commit_session` or `record_recall` — is decided at
   registration by the session's mode.
8. **`server/runner.ts`** — one Agent SDK session per lesson: streaming, revival
   after restart, per-turn cost tracking.
9. **`web/src/lesson/screen.ts`** — the lesson screen orchestrator; each concern
   (bubbles, ratings, wrap-up, SSE, composer) is its own module. A recall check
   reuses it wholesale — every difference reads off `params.mode`.

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
