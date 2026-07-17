# Test fixtures

A **fully synthetic** snapshot of `data/`, derived from the example course
(`data/curriculum.yaml`/`profile.md`/`lesson-history.md` as shipped to new
learners) and then hand-edited into a controlled scenario that
`tests/core.test.ts` asserts against exactly. Nothing here is real learner
data — no names, no real conversation history. Only the `shipped curriculum
is valid` test still reads the real `data/curriculum.yaml`, and it only
asserts structural invariants (validates, at least one lane), not exact
content, because the real repo's data differs across checkouts.

The controlled scenario, in `curriculum.yaml`:

- The `ai` lane's first unit (`ai-nn-foundations`) is `in-progress`, with
  `currentTopic` and `nextUp` both pointing at `ai-nn-foundations-loss`
  (state `shaky`, `lastTouched` 2026-06-15/Lesson 2) — a distinctive carried
  plan string is attached.
- `ai-nn-foundations-activation` is `comfortable` with an **old**
  `lastTouched` (2026-06-01/Lesson 1) — stale at a 14-day threshold measured
  from 2026-07-16.
- `ai-nn-foundations-backprop` is `comfortable` with a **recent**
  `lastTouched` (2026-07-10/Lesson 3) — not stale at that same threshold.
- `ai-nn-foundations-embeddings` stays `not-started`.
- The `sts` and `art` lanes are untouched from the example course (every
  unit/topic `not-started`, unit-level `nextUp`), so nothing in them is a
  recall candidate and no state anywhere gets touched by non-`ai` tests.

`lesson-history.md` carries three synthetic entries — Lessons 1 (2026-06-01,
activation), 2 (2026-06-15, a brief/shaky touch on loss), 3 (2026-07-10,
backprop review) — reverse-chronological, so `nextLessonNumber` is 4.

`profile.md` starts from the example course's near-empty starter profile
and adds a couple of confirmed-pattern, broader-prerequisite,
settled-question, and working-notes bullets so the profile-patch tests
(add / `removeContaining` / gated confirmed-patterns) have real content to
exercise. All of it is written in the neutral "I" / "the learner" voice, no
names.

**Only regenerate deliberately.** If you change the fixture, update the
matching assertions in `tests/core.test.ts` (topic ids/dates/needles) to
match. There's no scripted regeneration step — this is a hand-authored
scenario, not a frozen export of real data.
