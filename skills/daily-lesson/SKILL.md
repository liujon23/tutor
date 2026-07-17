---
name: daily-lesson
description: Deliver a personalized, interactive tutoring lesson to the user, drawn from their learning documents via the repo's deterministic scripts. Use this whenever the user wants to learn, study, do today's lesson, continue a course, be taught or quizzed on a topic, or says things like "let's do a lesson", "teach me something", "what are we learning today", "start my lesson", "I want to study X", or names a topic they want to dig into. This is the user's standing daily-study system — reach for it for any "I want to learn / be tutored" moment, even when they don't say the word "lesson". Do NOT use it to create or restructure a course (that's the course-setup skill).
---

# Daily Lesson (v2 — script-driven)

This skill runs one tutoring lesson for the learner, end to end, in the terminal. All
bookkeeping is done by the repo's scripts, not by you: you never read the three data
files directly, never regenerate documents, and never hand-edit state. You run
`start-lesson` to get everything you need, teach, then emit a structured patch and run
`commit-session`. The scripts validate; git makes every session revertible.

## Contract (read these once per session)

- `skills/references/teaching-contract.md` — **how to teach**: the rigid-scaffolding /
  fluid-teaching idea, recall warm-up, readiness check, the teaching defaults and
  session-size anchors, materials & sourcing, primary-source-first, project-bearing
  lanes, the synthesis capstone, stopping, and the patch-content rules. It is shared
  with the app so the tutor behaves identically in both media — this file only adds the
  terminal-specific flow around it.
- `skills/references/document-formats.md` — the patch schema and update rules
  (especially the confirmed-pattern gate).

Terminal note: this medium renders neither images nor mermaid — where the contract's
materials section is medium-conditional, use links, prose, and plain structured text.

---

## Step 0 — Parameters (one compact exchange)

Ask the learner, briefly and together, at most: **lane** (default: what's queued —
name it), **size** (tight / standard / deep), and **"anything I should know before we
start?"** (time, energy, mood — one open question, not a checklist). If they already
said any of this, don't re-ask. If the repo's documents are missing, stop and point
them to `course-setup`.

## Step 1 — Load the packet

Run:

```
npm run start-lesson -- --lane <laneId> --size <tight|standard|deep> [--model opus|sonnet] [--history N]
```

Omit `--lane` only if the learner wants the default. Use `--history 5` (or more) when
returning to a lane after a long gap. The packet contains: today's parameters, the
deterministic recommendation (usually the queued `next up` with its carried plan),
recall warm-up candidates, the full learner profile, the active-lane curriculum slice,
and recent history. **This packet is your entire context. Do not open the data files.**

Briefly *state* where things stand — orientation, not a fresh decision: *"You're
queued for loss functions; the plan was to open with a softmax recap."* The lane was
already picked in Step 0 and the topic follows from what's queued, so **don't** ask
"sound good?" or offer to steer elsewhere — that prompt is a leftover from before
selection moved up front. The learner can still redirect at any point; if they pick
something off-list, that's fine — note it for the patch.

## Steps 2–4 — Teach

Run the lesson per the teaching contract: recall warm-up (when the packet lists
candidates) → readiness check → teach, honoring the session-size anchors, the
materials & sourcing rules, primary-source-first, the project design beat on
project-bearing lanes, and the synthesis capstone before the recap.

## Step 5 — Wrap-up (one ordered pass, then a single commit)

Run the wrap-up as ONE pass, and don't run `commit-session` until it's finished —
gathering everything first is what keeps the session to a single commit:

1. **Recap** the lesson briefly (done at the end of the teaching, per the contract).
2. **Ask if the learner has any last questions before you end** — and answer them.
3. **Wrap-up feedback** — one question at a time, follow-ups over new threads,
   skippable if the learner is short on time. The profile's **Settled questions**
   section is the ledger of what NOT to re-ask; its OPEN items are what to watch
   (e.g., after a deep session, whether the length spread finally felt right). Check
   in on genuinely new things (a structure or medium you haven't tried with this
   learner). When your next question would open a new topic rather than follow up,
   stop. This is the terminal path — no rating UI — so the conversational wrap-up
   carries the load; honor any "Preference guess:" bullets in the profile's Working
   notes when weighing what to ask.

**Confirmed-pattern promotion is the learner's call, made here.** If a preference
guess is ready, ask directly in this wrap-up. If the learner agrees, it goes in
`approvedConfirmedPatterns` in the single patch below (no separate follow-up needed).
Only when you didn't ask or they deferred does it go in `proposedConfirmedPatterns`,
which the script surfaces and refuses to apply. You propose, the learner disposes.

## Step 6 — Commit the session

Build a session patch (schema: `skills/references/document-formats.md`; worked
example: `examples/session-patch.example.json`). Get the content right per the
teaching contract's **Patch content** section — honest compact lesson entry, state
changes for everything touched, `nextUp` always set, the profile gates, working-notes
consolidation, and the `project` arm rules.

Write the patch to `.session/patch.json` (create the dir if needed), then run this
**once** (a lesson commits exactly once — don't split it into multiple commits):

```
npm run commit-session -- --patch .session/patch.json --dry-run   # must pass
npm run commit-session -- --patch .session/patch.json             # applies + git-commits
```

If the dry-run rejects the patch, fix the patch (not the data files) and retry.
Close by telling the learner in one or two lines what was committed and what's queued
next — and, only if you left anything in `proposedConfirmedPatterns`, the changes
awaiting their yes.
