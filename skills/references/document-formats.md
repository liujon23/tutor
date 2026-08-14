# Document formats — contract v2 (script-driven)

The shared contract for the tutoring system's data. Both skills depend on it. The v1
contract's storage-mode dance (Project knowledge vs. folder) is gone: the data lives
in this repo, scripts do the bookkeeping, and git provides rollback. What remains
rigid: schemas, ID conventions, state vocabularies, and the update gates below.

## The three documents (`data/`)

```
profile.md          # who the learner is and how they like to learn — prose, markdown
curriculum.yaml     # the topic graph + knowledge state + recency — structured, YAML
lesson-history.md   # append-only log, one entry per lesson, newest first — markdown
projects/<lane>.md  # OPTIONAL per-lane project artifact (only project-bearing lanes)
unit-summaries.json # DERIVED — generated unit blurbs for the viewer; not read by lessons
```

`unit-summaries.json` is the one derived file here: a cache of one- or two-sentence
descriptions of what each unit covers, written by `npm run unit-summaries` and keyed
by a hash of the unit's *structure* (its name, its topic names and order, its
prerequisites, and its lane's `direction`). Progress, notes and dates are deliberately
outside that hash, so an ordinary lesson never invalidates it. It exists only for the
app's curriculum viewer — it never enters a session packet, and deleting it costs
nothing but a regeneration.

**Access rule for lessons:** `daily-lesson` never reads these files directly. It reads
the *session packet* from `npm run start-lesson` and writes back via a *session patch*
through `npm run commit-session`. Only `course-setup` (structural work) and the learner (it's
their data) edit files directly — followed by `npm run validate`.

## curriculum.yaml

Hierarchy: lanes → units → topics (core / optional). Knowledge state is held loosely
on purpose; it is fragile and decays between sessions.

Key fields (see the shipped file for a live example):

- **Lane:** `id`, `name`, `weight` (rough % of the learner's attention — their deliberate
  setting), `currentUnit`, `direction` (a loose line or two on where the lane is
  heading — themes, not a fixed syllabus), `nextUp`, `units`.
- **Unit:** `id`, `name`, `state`, `currentTopic`, `prerequisites` (unit ids, same
  lane), `bridgeTopics` (topic ids in *other* units — suggestions for connecting
  lessons, not dependencies), `notes`, `coreTopics`, `optionalTopics`,
  `completedAt`.
- **Unit.completedAt** (machine-written): `YYYY-MM-DD` the unit first reached
  `core-complete`/`complete`, stamped by the patcher from the lesson date. Like
  `Topic.lastTouched` there is **no patch field for it** — the tutor never sets
  it. A later `core-complete` → `complete` keeps the first date; reopening the
  unit clears it so the next completion re-stamps. `null` until the unit
  completes.
- **Topic:** `id`, `name`, `state`, `lastTouched` (`{date, lesson}` or `null`),
  `prerequisites` / `buildsToward` (topic ids, **same unit only**), `notes`,
  optional `assets`.
- **Topic.assets** (optional): curated materials for future lessons —
  `{kind: image|text|link, url, title, note?}`. `image` URLs must be public-domain
  sources (embedded and cached by the app); `text`/`link` are navigational and may
  point anywhere. Curated by course-setup (direct file edit + validate); lessons
  read them from the packet and prefer them over live search.

**State vocabularies** — graded *fairly*, never generously:

- Topic: `not-started` · `touched` (seen it, shaky-to-partial) · `comfortable`
  (solid, but fair game for recall when stale) · `shaky` (didn't stick; revisit).
- Unit: `not-started` · `in-progress` · `core-complete` (core done, exploring
  optional/bridges) · `complete` (wrapped, ready to move on).

**ID convention:** lowercase, hyphenated, lane-prefixed, readable —
`ai-attention-transformer` (unit), `ai-attn-mechanism` (topic).

**Graph rules (enforced by the validator):** topic→topic edges never cross unit
boundaries (express cross-unit dependency as unit→unit); no cycles; every referenced
id exists; pointers resolve; bridges point outside their unit.

**Unit ordering is `units:` array position — not just prerequisites.** The selector
(`core/selector.ts`, `firstStartableUnits`) walks the units top-to-bottom and picks the
first that is `not-started` with all `prerequisites` complete; `nextUp` overrides only
the *immediate* next step. So among units that share the same prerequisites (e.g. three
units that each only depend on unit 1), array order alone decides the sequence.
Prerequisites are *true dependencies*; the linear teaching order is the array order.
Reordering a lane's arc therefore means **physically moving the unit blocks** in the
file — editing edges or pointers won't change the order the selector walks. (The
validator checks structure, not whether the order matches intent, so re-read the
`units:` sequence top-to-bottom after a reshape.)

**`nextUp` (per lane):** `{topicId | unitId, plan}` — what's queued and a one-line
plan, written at every wrap-up. Set `topicId` for an existing next topic, or `unitId`
when the next lesson opens a new unit whose topics aren't created yet (topic setup is
course-setup's job — don't anchor to a stale topic). This is what makes the next
session's selection instant and carries intent ("open with a softmax recap") across
sessions. The selector uses it first and only derives from the graph when it's absent.

**Notes discipline:** brief. For comfortable/done topics, strip to recency plus a
one-liner; spend words only on active topics where they help the next lesson.

## profile.md

Prose, markdown, section-structured. Sections the tooling knows about (headings must
be preserved):

- `## Interest lanes & distribution` — the learner's deliberate setting (weights also mirrored
  in curriculum.yaml lanes; keep them consistent when changing via course-setup).
- `## How I learn best  (CONFIRMED PATTERNS — …)` — **gated**, see below.
- `## Lesson preferences` — general shape/logistics preferences.
- `## Broader prerequisites` — cross-cutting knowledge that isn't a lane topic.
- `## Settled questions  (feedback ledger — …)` — which feedback questions are
  settled (don't re-ask) and which are OPEN (watch for them). This replaced scanning
  lesson-history's "Asked about" fields; wrap-ups read and update it here.
- `## Working notes  (tentative — …)` — hunches under test. By convention this is
  also where **preference guesses** live: tentative reads on how the learner likes to be taught,
  built up from per-message feedback in the app (bullets prefixed "Preference guess:",
  with supporting lessons noted). Guesses strengthen/weaken freely across sessions;
  promotion into "How I learn best" goes through the confirmed-pattern gate.

## lesson-history.md

Reverse-chronological, one entry per lesson, header `## Lesson N — YYYY-MM-DD`,
fields: Lane/Unit/Topic, What happened, Performance sketch, Sources used, Feedback
captured, Asked about. **Archival:** only the last few entries are loaded per session
(`--history N`); the durable signal lives in Settled questions.

## projects/&lt;laneId&gt;.md (optional — per-lane project artifact)

Some lanes carry a **project**: a design/spec document the learner builds and revises across the
whole lane (e.g. a design lane where each unit's principle gets applied to a running
mock app). Kept as its own markdown file, one per lane, so the prose stays prose — it is
**not** in curriculum.yaml and is **not** knowledge-state (no `comfortable`/`shaky`; it's
an artifact you evolve, not a topic you master).

- **Read path:** if `data/projects/<laneId>.md` exists, the packet injects it **verbatim**
  as a `## Project` section (unlike curriculum `notes`, whitespace/formatting is preserved).
  Lanes without the file get no section.
- **Write path:** the session patch's `project` arm (below) **replaces the file wholesale**
  — the same replace-not-merge semantics as a topic's `notes` or a lane's `direction`. The
  file rides the normal `git add data` commit; no separate plumbing.
- **Created by** either course-setup (a stub so the packet always shows the section) or the
  lane's first proposal lesson (which writes the doc for the first time).

Whether a lane is project-bearing is expressed only by the file's existence plus the lane's
`direction` prose — there is no schema flag, so the same primitive serves an *emulated*
project (the learner plays a student's POV) or a *real* one they are actually building.

## The session patch (write-back schema)

Emitted by `daily-lesson`, applied by `npm run commit-session`. TypeScript source of
truth: `core/types.ts` (`SessionPatch`); worked example:
`examples/session-patch.example.json`. Shape:

```
{
  lesson:      { date, laneId, unitId, topicIds[], topicsFreeform?, whatHappened,
                 performanceSketch, sourcesUsed, feedbackCaptured, askedAbout },
  curriculum?: { topicUpdates[]   — {id, state?, notes?, touched? (default true →
                                     lastTouched stamped with this lesson)},
                 unitUpdates[]    — {id, state?, currentTopic?, notes?},
                 laneUpdates[]    — {id, currentUnit?, direction?, nextUp?},
                 newTopics[], newUnits[] },
  profile?:    { workingNotes / broaderPrerequisites / settledQuestions —
                   {add[], removeContaining[]},
                 proposedConfirmedPatterns[]   — surfaced, NEVER applied,
                 approvedConfirmedPatterns     — applied; only after the learner's explicit yes },
  project?:    { laneId, content }             — project-bearing lanes only; `content`
                 is the FULL updated markdown, replaces data/projects/<laneId>.md
                 wholesale; laneId must equal lesson.laneId
}
```

The patcher validates everything (including the post-patch graph) and writes nothing
on any error. Lesson numbering is automatic. Every successful commit is a git commit.

**App-only extension — `patch.feedback`** (ignored by the core patcher; CLI lessons
never produce it): in the app, the learner can rate individual tutor messages (±1/±2 plus a
required note; only a -2 reaches the tutor mid-lesson; no rating = no signal). At
commit the tutor distills each rating into
`feedback.entries[] = {messageId, level, context, takeaway}` — a summary with
context, not a raw dump. The app appends one JSON line per entry (with lesson
metadata) to **`transcripts/feedback.jsonl`**, the durable substrate for future
feedback processing, and refuses a commit whose entries don't cover every rated
message. Raw ratings live only in the ephemeral session file.

## Update gates (unchanged in spirit from v1)

- **Working notes, Broader prerequisites, Settled questions** — freely updatable, any
  session, without asking.
- **Confirmed patterns** — any change requires the learner's agreement first. Mechanically
  enforced: only `approvedConfirmedPatterns` is ever written; `proposed…` is printed
  for the learner. You propose, they dispose.
- **Interest lanes & distribution / lane weights** — the learner's deliberate setting; change
  via course-setup with the learner's confirmation, or honor a per-session override without
  rewriting it.
