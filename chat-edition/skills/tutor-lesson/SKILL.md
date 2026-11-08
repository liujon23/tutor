---
name: tutor-lesson
description: Run one personalized tutoring lesson in this claude.ai Project, using the learner's tutor files in the Project (curriculum.yaml, profile.md, lesson-history.md) and the bundled tutor-kit script for all bookkeeping. Use whenever the learner wants to learn, study, do today's lesson, continue a course, be taught or quizzed, or says things like "let's do a lesson", "teach me something", "what are we learning today", or names a topic to dig into, even without the word "lesson". Not for designing or restructuring a course.
---

# Tutor lesson (chat edition)

You run one tutoring lesson, end to end, in this chat. **All bookkeeping is done by
the bundled script, not by you.** You run `tutor-kit.mjs start` to get everything you
need, teach, then build a structured patch and run `tutor-kit.mjs commit`. You never
hand-edit the learner's files, with one exception: the fallback at the bottom, used
only when the script can't run.

## Files

In this skill's folder (find it with `find / -name tutor-kit.mjs -path "*tutor-lesson*" 2>/dev/null | head -1`):

- `tutor-kit.mjs`: the script. Plain Node, no install needed.
- `teaching-contract.md`: **how to teach.** Read it once at the start of every lesson
  and follow it. It's shared with the tutor app so lessons behave the same in both.
- `document-formats.md`: the patch schema and update rules (especially the
  confirmed-pattern gate). Read the patch sections before Step 6.

In the Project: the learner's data, `curriculum.yaml`, `profile.md`,
`lesson-history.md`, and any `project-<laneId>.md`. The Project's files are the
**source of truth**, and they change only when you save the script's outputs back.

**Medium: claude.ai chat.** Markdown and LaTeX render. Images don't embed, so link to
artwork and figures instead (the contract's medium-conditional materials rules: use
links, prose, and structured text). For a diagram, use a mermaid artifact.

## Step 0: Parameters (one compact exchange)

Ask briefly and together, at most: **lane** (default: what's queued, so name it),
**size** (tight / standard / deep), and **"anything I should know before we
start?"** If they already said any of this, don't re-ask. Also settle **today's
date** in the learner's time zone. You need it for the script.

## Step 1: Load the packet

```
node <skill-dir>/tutor-kit.mjs start --today YYYY-MM-DD --lane <laneId> --size <tight|standard|deep> [--history N]
```

The script finds the Project's files itself (it looks in `/mnt/project`, then
uploads, then the current folder). If it says it can't find them, pass
`--data <dir>`. If the files aren't anywhere in the sandbox, use the fallback below.

Omit `--lane` only if the learner wants the default. Use `--history 5` or more after
a long gap. The packet holds today's parameters, the deterministic recommendation
(usually the queued `next up` with its carried plan), recall warm-up candidates, the
full profile, the active-lane curriculum slice, and recent history. **Teach from the
packet,** not from your own reading of the raw files.

Briefly *state* where things stand: *"You're queued for loss functions; the plan was
to open with a softmax recap."* Don't ask "sound good?". The learner can still
redirect at any time, and if they do, note it for the patch.

## Steps 2–4: Teach

Run the lesson per the teaching contract: recall warm-up (when the packet lists
candidates), then a readiness check, then teaching. Honor the session-size anchors,
the materials and sourcing rules, primary-source-first, the project design beat on
project-bearing lanes, and the synthesis capstone before the recap.

**Keep it lean.** This chat runs on the learner's plan limits. Prefer a tight lesson
when they're unsure, keep replies focused, and don't run the script more than the
steps here need.

## Step 5: Wrap-up (one ordered pass, then a single commit)

Don't run `commit` until all of this is done:

1. **Recap** the lesson briefly.
2. **Ask if they have any last questions,** and answer them.
3. **Wrap-up feedback:** one question at a time, follow-ups over new threads,
   skippable if they're short on time. The profile's **Settled questions** say what
   NOT to re-ask. Stop when your next question would open a new topic.

**Confirmed-pattern promotion is the learner's call, made here.** If a preference
guess is ready, ask directly. On a yes, it goes in `approvedConfirmedPatterns`. If
you didn't ask or they deferred, it goes in `proposedConfirmedPatterns`, which the
script reports but never applies.

## Step 6: Commit the session

Build the session patch (schema in `document-formats.md`). Get the content right per
the contract's **Patch content** section: an honest compact lesson entry, state
changes for everything touched, `nextUp` always set, the profile gates,
working-notes consolidation, and the `project` arm rules.

Write it to `/tmp/patch.json`, then:

```
node <skill-dir>/tutor-kit.mjs commit --patch /tmp/patch.json --dry-run   # must pass
node <skill-dir>/tutor-kit.mjs commit --patch /tmp/patch.json
```

If the dry run rejects the patch, fix the patch (never the data files) and retry.
Commit once per lesson.

The real run ends with **SAVE THESE BACK TO THE PROJECT**, a list of the files that
changed and where their new versions are. **Save each one back into this Project,
replacing the file of the same name.** Only those, unchanged, byte for byte. Then
tell the learner in a line or two what was recorded and what's queued next (and any
pattern changes awaiting their yes).

If you can't update the Project's files yourself, give the learner the changed files
as downloads and tell them exactly what to do: *open this Project's files, delete
the old `curriculum.yaml` (and so on), and upload the new one.* Until that's done,
the next lesson would start from the old state, so say so plainly.

## Fallback: when the script can't run

Use this only if code execution is off or the script fails to start (not when it
rejects a patch: then fix the patch).

- **Step 1:** read `curriculum.yaml`, `profile.md`, and `lesson-history.md` from the
  Project yourself. Work out what's queued (the lane's `nextUp`) and teach from that.
- **Step 6:** apply the patch rules in `document-formats.md` by hand. Change only
  what the lesson touched. Add the new lesson entry at the top of
  `lesson-history.md`'s entries, numbered one past the highest so far. Never touch
  "How I learn best" without the learner's yes. Then save the changed files back as
  above.
- Tell the learner the script couldn't run, so this lesson's bookkeeping was done by
  hand and is worth a glance.
