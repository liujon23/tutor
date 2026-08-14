# The terminal path — lessons in Claude Code, and the script toolbox

The app is the main way to use the tutor, but everything it does runs through
deterministic CLI scripts that you can drive directly. Two reasons to care:

- **Lessons in Claude Code.** If you already use
  [Claude Code](https://claude.com/claude-code), you can run a full lesson in
  the terminal with zero server setup and no token — Claude Code's own login is
  enough.
- **The scripts themselves.** Validation, exports, and usage analysis are plain
  commands you can run any time; they read and write the same data as the app.

Both paths write through the identical core — same session packet, same
validated patch, same one-commit-per-lesson rule — so you can mix them freely.

## Lessons in Claude Code

Open Claude Code in this folder and say *"let's do a lesson"*. The
`daily-lesson` skill runs the same flow the app does, in the terminal:

1. It runs `start-lesson` to assemble the session packet (parameters, the queued
   topic and its carried plan, recall candidates, your profile, the active-lane
   curriculum slice, recent history).
2. It teaches from the packet, per the shared teaching contract
   (`skills/references/teaching-contract.md`) — the same contract the app
   splices into its system prompt.
3. At wrap-up it builds a session patch and applies it with
   `commit-session` — validated first, then written and git-committed.

The terminal renders no images or diagrams, so image-led lessons (art history
especially) are better in the app. Course *authoring* also lives here: the
`course-setup` skill designs new lanes in conversation (see the README).

## The script toolbox

```bash
npm run start-lesson -- --lane ai --size deep [--model opus] [--history 5]
npm run commit-session -- --patch .session/patch.json [--dry-run]
npm run validate
npm run usage-report [-- --json]
npm run export-lane -- --lane sts [--out <dir>] [--md-only] [--clean]
npm run unit-summaries [-- --check | --force]
npm run backfill-completed-at [-- --dry-run]
npm run demo:snapshot
npm run echo-test
```

- **`start-lesson`** prints the session packet — useful for seeing exactly what
  the tutor gets to know before a lesson.
- **`commit-session`** validates and applies a session patch (`--dry-run` to
  check without writing). Rejected patches change nothing on disk.
- **`validate`** checks the curriculum graph, states, and pointers — run it
  after any hand-edit of `data/curriculum.yaml`.
- **`usage-report`** analyzes the token/cost ledger: totals, per-lesson
  timeline, breakdowns by lane / size / model / feature. (The app's Stats
  screen shows the same analysis.)
- **`export-lane`** renders a lane as a shareable Markdown + PDF document — no
  state or progress, just the direction, notes, and curated links. `--clean`
  strips all authored prose down to a bare syllabus / reading list, safe to
  send to anyone.
- **`unit-summaries`** writes the short "what this unit covers" blurbs the app's
  curriculum viewer shows. The **only** script here that spends tokens, and the
  only non-deterministic one — so it's explicit rather than automatic. It
  regenerates just the units whose *structure* changed (renamed, topics
  added/removed/reordered, or the lane's `direction` rewritten); ordinary lessons
  never invalidate a summary. `--check` lists what's stale and spends nothing;
  `--force` regenerates everything. Writes `data/unit-summaries.json` and commits.
- **`backfill-completed-at`** a one-time migration for curricula that predate the
  `completedAt` field: stamps each already-finished unit with the date of its
  last lesson. Idempotent — it only fills blanks — so it's harmless to re-run.
- **`demo:snapshot`** freezes one lane of the curriculum plus a single lesson
  transcript into `web/public/demo/` for the public demo build (which has no
  data repo to read). Commit what it writes.
- **`echo-test`** verifies the Agent SDK and your token before the first app
  lesson.

Paths these commands print or mention (`data/curriculum.yaml` and friends) are
relative to your **data root** — `my-data/` by default, or wherever
`TUTOR_DATA_DIR` points (see SETUP.md). The scripts resolve it for you, so they
work unchanged wherever you keep your data.
