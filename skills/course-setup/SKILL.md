---
name: course-setup
description: Set up a brand-new learning course/lane for the user, or revisit and restructure an existing one — defining goals, doing a wide prerequisite sweep, and seeding the curriculum with an initial unit structure. Use this when the user wants to start learning a new subject area, add a new lane/course to their tutoring system, redefine what they're aiming for in a course, reshape or re-plan an existing course's units, or adjust their interest-area mix and weights. Reach for this on phrases like "I want to start learning X", "add a new course on Y", "I want to rethink where this course is going", or "let's re-plan this unit". Do NOT use it to deliver an actual lesson (that's the daily-lesson skill).
---

# Course Setup (v2 — script-validated)

This skill stands up or reshapes a course. It runs rarely, and it's the one activity
that edits `data/curriculum.yaml` **directly** (structural work doesn't fit the
session-patch shape). The safety net is the validator and git, not caution about
touching the file.

Read `skills/references/document-formats.md` first — it defines the YAML schema, ID
conventions, graph rules, and update gates.

## The setup conversation

A real, fluid conversation, not a form. Roughly in this order:

### 1. Goals — what is the learner building toward?

Sketch the destination together (or revisit it for an existing lane). Hold goals
lightly; they evolve. Capture the result in the lane's `direction` field.

### 2. Wide prerequisite sweep — find the learner's floor

For a new course, sweep broadly to learn what the learner already owns, so future
lessons don't teach familiar ground. Wider than a daily readiness check — you're
mapping the floor, not gating one topic. Assess fairly; lean on the learner's
self-assessment. Record cross-cutting findings in the profile's **Broader
prerequisites** (edit `data/profile.md` directly for this — the prerequisite sweep is
the ONE profile edit setup owns; all other profile evolution — working notes, settled
questions, preference guesses, consolidation — belongs to daily-lesson's session
patch, and the confirmed-patterns gate applies as always), and mark clearly-owned
topics `comfortable` from the start.

### 3. Seed the unit skeleton

Lay out units as a *starting ground truth*, freely revised later. Draw on how the
subject is standardly taught; don't invent idiosyncratic orderings. For each unit:
ID + name, `state`, unit→unit `prerequisites`, topics planned up front and split
**core** vs **optional**, any `bridgeTopics` (topic IDs in *other* units — suggestions,
not dependencies), and pointers (`currentUnit`, `currentTopic`) if the learner starts
immediately. **Set the lane's `nextUp`** so the first daily lesson knows where to open
— for a brand-new lane, the plan line should note that the lesson opens with the
lane roadmap (per the contract's teaching defaults). Plan early units concretely,
sketch later ones lightly.

Remember the graph rules: topic→topic edges only within a unit; cross-unit
dependencies are unit→unit; no cycles.

**Asset curation.** When creating or re-planning a unit, populate topic `assets`
(see document-formats.md) where real materials will carry future lessons: vetted
public-domain image URLs (Wikimedia Commons class — verify each resolves), primary-
text links (Gutenberg, SEP, arXiv), one line each on why it's there. Art-lane topics
should ship with their core images; humanities topics with their primary passages.
Lessons prefer curated assets over live search — curation here is what makes lessons
fast and reliable there.

### 3b. Project-bearing lanes (when the lane carries a running project)

Some lanes pair the curriculum with a **project** the learner builds across the whole
lane — a design/spec artifact each unit's ideas get applied to (see the projects
section of document-formats.md). To stand one up:

- Create a stub `data/projects/<laneId>.md` — a skeleton with section headers the
  learner will fill (and a note like `_(not yet proposed — Unit 1 defines this with the
  learner)_`), so the packet always shows a `## Project` section and the first lesson
  knows to populate it. Lessons evolve it from there via the patch's `project` arm; you
  only seed the stub.
- Record the project's role in the lane's `direction` — including whether it's a *real*
  project or an *emulated* one (the learner playing a student's POV). That prose is the
  only marker of a project-bearing lane; there is no schema flag.
- Fold the "apply it to the project" work into the lessons themselves (it lands in the
  synthesis-capstone beat), with occasional standalone design-review units/lessons at
  natural milestones — set those up as ordinary units/topics if you want them queued.

### 4. Interest mix (when relevant)

If the learner wants to adjust the split across lanes, update each lane's `weight` —
but only with their explicit confirmation. This is the learner's deliberate setting.

## Reshaping or reordering an existing lane

Restructuring is the *revisit* half of this skill, and it has one non-obvious rule:

- **Order lives in `units:` array position.** The selector teaches units top-to-bottom,
  picking the first `not-started` unit whose prerequisites are all `complete` (`nextUp`
  only overrides the immediate next step). To move a unit earlier or later in the arc,
  **physically move its block** in `curriculum.yaml` — reordering prerequisites or
  pointers alone won't change the sequence, and adding a fake prerequisite to force
  order corrupts the dependency graph. Keep prerequisites as *true* dependencies; use
  array order to sequence siblings. For a big block move, a raw-text cut/insert anchored
  on the unit-level `      - id:` lines preserves YAML formatting exactly (a length-
  unchanged move is a good sanity check).
- **At a unit boundary,** flip the finished unit to `complete`, advance the lane's
  `currentUnit`, and repoint `nextUp` at the new next unit with a fresh `plan` line
  (roadmap-first for a new unit) so the next lesson opens in the right place.
- After reordering, re-read the lane's `units:` order top-to-bottom — that *is* the
  teaching sequence, and the validator won't check it against your intent.

## Write back

Edit `data/curriculum.yaml` (and `data/profile.md` where the sweep warrants), then:

```
npm run validate
```

Fix anything it flags. **YAML footgun:** in an unquoted multi-line `notes`/`direction`
value, a `: ` (colon-space) or a leading quote makes the parser fail with "Nested
mappings are not allowed in compact mappings" — double-quote the whole value or
rephrase. `npm run validate` catches it. Then commit:

```
git add data && git commit -m "course-setup: <what changed>"
```

Close by summarizing what you set up — goals captured, floor found, unit skeleton —
so the learner can eyeball it, and point them to `daily-lesson` to begin.
