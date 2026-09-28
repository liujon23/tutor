# Handsfree audio lessons for the commute — implementation plan

> **Read this first.** It is a handoff: you have the repo and the branch but
> none of the preceding conversation. Everything needed is here — the codebase
> exploration and the on-device measurement that produced it are already done,
> so trust the file:line references rather than re-deriving them.
>
> Branch: `claude/handsfree-audio-lessons-ysgzs7`. Start with **Cleanup**, then
> **What to build**. Delete this file when the work lands.

## Context

J has a ~30-minute car commute each way and wants to spend it on lessons from
this tutoring app — especially the text-heavy lanes. The goal is a **two-way
spoken lesson**: the tutor talks, J answers out loud, it adapts.

Constraints, all settled with J:

- **iPhone, mounted, plugged in, unlocked.** The app is opened while parked, so
  **startup need not be handsfree**, and an occasional single tap while driving
  is acceptable.
- **Lessons are `standard` size and span media** — begun on the morning drive,
  continued on the way home or finished at a desk in the normal text app. This
  is a first-class requirement, not an edge case.
- **Full lessons**, committing to history and advancing the curriculum as usual.
  Audio is tagged so the *data quality* can be read later (spoken turns come
  from speech recognition), **not** to make the teaching easier.

A throwaway spike (now deleted, see Cleanup) measured the platform on J's actual
phone in the actual car. **Browser-native two-way works, for free.** No cloud
TTS vendor, no API key, no per-lesson cost.

## The app you're working in

Read `ARCHITECTURE.md` and `APP.md` first. The short version:

| Layer | Owns |
|---|---|
| `core/` | Deterministic curriculum logic over `DataPaths` — parsing, selection, spacing, validation, patching. Knows nothing of AI, network or HTTP. |
| `scripts/` | CLI entry points. `scripts/lib.ts` is the only path-logic module. |
| `server/` | Fastify + Claude Agent SDK, SSE streaming, the `commit_session` tool. |
| `web/` | Vanilla-TS PWA built by Vite. Imports nothing from `core/` or `server/` — it re-declares shared types by hand in `web/src/api.ts`. |

Three invariants that shape everything:

1. **The session packet is the model's entire context.** It never reads data files.
2. **The validated `SessionPatch` is the model's only write path.** One lesson =
   one git commit in a separate data repo (default `my-data/`).
3. **Bookkeeping is code.** Anything deterministic belongs in `core/`, not in the
   model's judgement.

Run it with `npm run restart` (rebuilds the web app, then serves) — **not**
`npm run serve`, which skips the build. `npm run typecheck && npm test` before
any commit; CI also runs `build:web`.

## Already done on this branch

**Phase A — reconcile accounting** (commit `18b9619`). The lesson screen tracked
a *count* of rendered transcript entries, which drifted on a second device and
made every `reconcile()` re-render the tail. Replaced with
`renderedIds: Set<string>` plus `pendingSends`, matching logic in a zero-import
`web/src/lesson/reconcile.ts` so `tests/` can reach it. Failed sends now remove
their bubble and restore the text. `/api/lesson/:id/end` stores a one-line human
turn and passes its wrap-up checklist as `modelText`.

**This mattered for audio**: wire speech to `addBubble` on the old code and the
tutor's last reply would be spoken again on every screen wake. It is fixed; don't
reintroduce index-based reconciliation.

**Phase 0 — device measurement.** Results below. The spike itself is now dead
weight; delete it.

## What the device actually does (measured, iOS 18.7 / Safari 18.7.5)

These are facts from a real drive, not predictions. Design to them.

- **Recognition works in Safari.** Not in Chrome/Firefox/Edge for iOS — those
  expose `webkitSpeechRecognition` but lack the entitlement and fail instantly
  with `not-allowed / "Microphone permission check has failed"`. **Safari only.**
- **Synthesis stays fully audible with the mic live.** The widely-reported
  `play-and-record` demotion of `speechSynthesis` did not reproduce. There is
  nothing to work around, and no need for `AudioContext` + cloud TTS.
- **Restart gap is ~110ms** (measured 110/111/108/112/94). Restarting recognition
  is nearly free.
- **Sessions run 20s+ before ending on their own**, so restarts are occasional,
  not constant.
- **Transcription at highway speed is excellent** — full sentences at confidence
  0.99 through the phone's own speaker and mic. Road noise was not a problem.
- **Bluetooth flips the audio profile and the head unit switches source**, and
  call-mode audio is audibly worse. **Phone speaker is the default** — better
  quality and no profile churn.
- `speechSynthesis` had 223 voices at load; wake lock acquires and holds.

## What to build

**Drive mode is a rendering mode on the existing lesson screen, not a new
screen.** `web/src/lesson/screen.ts` already owns the SSE subscription,
reconcile, bubbles, model switcher and end-lesson button. Audio attaches to the
same `LessonCtx`.

This is the decision that makes everything else cheap: **continuation across
media is free.** Toggle audio off at your desk and you are in the same lesson,
same session, as text; toggle it back on for the drive home. No resume plumbing,
no second session — `status.activeSessions` and the existing "In progress" card
already surface it.

### Modules

Keep the rule-bound logic pure and confine browser APIs to one file.

| File | Purity | Job |
|---|---|---|
| `web/src/lesson/audio/text.ts` | pure | markdown + LaTeX → speakable text, and chunking. **Imports nothing.** |
| `web/src/lesson/audio/endpoint.ts` | pure | the two-clock endpointer |
| `web/src/lesson/audio/adapter.ts` | impure | the *only* file touching `speechSynthesis`, `SpeechRecognition`, `wakeLock` |
| `web/src/lesson/audio/panel.ts` | impure | the overlay |

`web/src/lesson/reconcile.ts` is the precedent: zero imports, listed in the root
`tsconfig.json` `include` so `tests/` can reach it. Do the same for `text.ts` and
`endpoint.ts`. **They must import nothing from `web/src/`** — see Traps.

### Turn-taking

**Half-duplex**: stop recognition while speaking, restart when the utterance
queue drains. At ~110ms that is nearly free. Barge-in is a tap, not a voice
command. (During the mic-live test, recognition captured *nothing* while the
tutor spoke through the phone speaker — no phantom barge-in from speaker bleed —
so full-duplex with real voice barge-in looks feasible later. One uncontrolled
observation; ship half-duplex.)

**Endpointing — two clocks, both ours.** `SpeechRecognition` gives no "how long
to wait" setting: it ends its own session after ~1–2s of silence. So treat
`onend` as *"the recogniser gave up"*, not *"the learner finished"*, restart it,
and keep accumulating into the same pending-answer buffer. Then:

| Situation | Rule |
|---|---|
| **Buffer empty** — J hasn't started talking | **Wait indefinitely.** Never submit. J can think for two minutes while the recogniser silently cycles underneath. |
| **Buffer non-empty** — J spoke, then went quiet | Submit after **~2.5s** of no new final text. |

Plus a hard cap around 90s, and a **Done** tap that submits immediately. This
split is what makes recall warm-ups work unchanged — thinking time is free by
construction, so no per-question timing hints are needed and grading is untouched.

**Adapter rules, each learned the hard way:**

- **Always stop before starting; never retry into a running recogniser.** The
  spike started recognition in one step without stopping it, so a later step
  inherited a live session and threw `InvalidStateError` dozens of times at
  ~600ms intervals. Keep an explicit `starting | running | stopped` flag.
- **Reset the "last ended at" timestamp when opening a fresh session**, or the
  first `audiostart` measures a gap from some earlier session and reports a
  fictitious multi-second stall.
- `no-speech` and `aborted` are the **normal** end path with `continuous = false`
  — never treat them as errors or back off on them. `network` needs real backoff.
- One singleton `SpeechRecognition`; constructing a new one each time plays the
  system chime.
- **Watchdog.** The documented iOS failure is `onresult` ceasing with *neither*
  `onerror` nor `onend`. No event within N seconds while nominally listening →
  `abort()`, fresh `start()`, and say something aloud. The "wait indefinitely"
  rule above would otherwise hide this as silence.
- **Also watchdog the server**: a dead runner is revived only by a POST (see
  Traps), so no `turn_done` within N seconds → nudge or re-POST.
- **No auto-resume after an interruption.** On `visibilitychange → hidden` while
  active, enter a hard PAUSED state needing one tap. A phone call breaks the
  gesture chain and kills synthesis; auto-resuming yields a car that is silent
  for the rest of the drive.

### Speaking

- **Chunk at paragraph / 2–3 sentence granularity, not per sentence.** iOS's
  failure mode is a stalled queue; more `speak()` calls means more chances to hit
  it, plus an audible gap at every boundary. Drive the queue yourself one
  utterance at a time off `onend`, with a timeout fallback. Never push N
  utterances in at once.
- **The first `speak()` must run synchronously inside the tap handler.** Anything
  behind an `await` breaks the gesture chain and iOS drops it silently. Speak a
  one-word "Starting." in the handler itself.
- **The chunker is message-scoped**: it flushes only its own residual and resets
  on `turn_done`. Flushing the tail using the `assistant` event's `ev.text` would
  speak every message twice.
- Wait for `voiceschanged` before picking a voice; prepend a short tone, since the
  first ~100–300ms is clipped while the output route wakes.
- Backgrounding mid-utterance kills synthesis unrecoverably in-page — plan for
  reload-on-resume, not resume.

`text.ts` must handle: tables (**drop** them with a spoken "there's a table here,
it's in the app" — normalising is worse than skipping), nested lists (ordered
markers → "One," / "Two,"; flatten and say so), inline code and symbols
(`softmax(QK^T/√d_k)` — the AI lane is weight 50, so this is constant, not rare),
markdown link text without the URL, em-dash → comma, abbreviations and decimals
in the sentence splitter (`Dr.`, `e.g.`, `Fig. 3`, `0.5`, `v1.2.3`), stripped
headings needing an appended period, and **currency** (see Traps).

### Controls

Prefer **one full-screen, state-dependent tap target** — speaking → skip,
listening → done, paused → resume — with a small End in the corner. Four buttons
plus End is too much target-finding on a mount.

Also needed:

- **Again**: replays the concatenation of all assistant text since the last user
  turn, *not* the last `assistant` event (one logical turn emits several when web
  tools fire). Local replay only — instant, free, no model turn.
- **Audible errors.** `showBanner`, `alert()` (`screen.ts:49`) and `confirm()`
  (`screen.ts:116`) are all invisible while driving. `closed`, `api_error`,
  `error` and `rate_limit` each need a spoken line.
- **A soft tone on turn start.** Opus first-token latency is 3–6s of dead
  silence, which reads as "it broke".
- A **Listen** toggle on the *select* screen as well as in-lesson, so the tutor's
  opening — the orienting message — is spoken rather than missed.
- One line noting phone speaker is preferred, if Bluetooth is connected.

### Telling the model it's a spoken turn

The system prompt is built once at session creation and **never rebuilt**
(`server/runner.ts:92`, resumed via `sdkSessionId` at `:103`). Since a lesson
spans media, medium cannot live in the prompt. Instead:

- The client sends `medium` on `POST /api/lesson/:id/message`; the server turns
  it into a `modelText` prefix via the existing `runner.send(text, hidden,
  images, modelText)` path (`server/runner.ts:130-157` — the transcript keeps
  `text`, the model receives `modelText`). `/api/lesson/:id/end` already uses
  this, so it is a proven mechanism, not a new one.
- **Tag both directions.** An untagged turn following tagged ones is ambiguous,
  and recency bias keeps the model in spoken mode.
- **Make the tag carry the rule**, not just a label:
  `[spoken turn — transcribed from speech; reply in spoken form: no markdown, no
  LaTeX, no URLs read aloud]`. ~20 tokens, adjacent to the content it governs.
  This is the highest-leverage line in the design.
- Add `medium?: "app" | "audio"` to `TranscriptEntry` (`server/types.ts`) — and
  **also** to the hand-duplicated copy in `web/src/api.ts:236-242`.

### Where the spoken rules live

**`server/prompt.ts`, not the shared teaching contract.**
`skills/references/teaching-contract.md:6-8` states that medium-specific
machinery stays in the consumers, and the CLI consumer runs in a terminal and can
never be audio — so a spoken section there is dead text for one of two consumers.
Avoid the word "medium" for this axis: the repo already uses it for CLI-vs-app.
Say "spoken turns".

`APP_INTRO` must change too: `server/prompt.ts:37-39` currently says flatly *"Use
math notation freely — it renders properly here"*, and one conditional line
elsewhere cannot override a categorical claim in the intro. Make its rendering
claim conditional in prose.

The rules themselves, as J chose them:

- **Long blocks are fine** — but announce their shape and recap at the seams.
  "Three parts here, roughly two minutes", then a one-line "so that's X, now Y"
  at each seam. That is the verbal equivalent of headings, and it is what makes a
  block re-enterable when attention drifts. No forced "still with me?" check-ins.
- **Math: intuition aloud, derivations parked.** Audio carries motivation,
  structure and intuition. When a derivation genuinely needs to be seen, say so
  and queue it in the patch's `nextUp` plan, so the next desk session opens on
  exactly that. This keeps the AI lane (weight 50) fully in play.
- No markdown, headings, bullets, tables, code fences, images or mermaid.
- **Never read a URL aloud** — name the source ("Mikolov's 2013 Word2Vec paper");
  `sourcesUsed` and the transcript keep the link.
- **Questions must be answerable out loud with no scratch paper.** A medium
  constraint, not a difficulty concession — the depth stays.
- **J's turns are speech-recognition output.** Expect homophones, no punctuation,
  mangled jargon ("tension" for attention). Read for intent, silently correct the
  obvious, and **never grade a transcription artifact as a learner error.**
- Decline image-led material in audio and offer to park it for the app.

### Recording that a lesson was spoken

Put it in **`LedgerMeta`** (`server/usage.ts:160-168`, which already carries
`size` — the same kind of app-only session metadata), plus a line in the
transcript header (`server/transcript.ts`). `server/lesson-index.ts` already
merges the ledger, so the viewer gets it free.

**Do not put it in `core/`.** A lesson-record field there would be stripped from
the packet anyway — see Traps.

## Traps

Each of these cost real time to find. Don't rediscover them.

- **Tests importing `web/src/` drag those files into the root `NodeNext`
  program**, which lacks `web/src/vite-env.d.ts` and resolves differently. It
  breaks the moment a module touches `web/src/markdown.ts` (which imports katex
  CSS) or `__DEMO__` (declared only in `vite-env.d.ts`). **`npm test` will not
  catch it** — `tsx --test` doesn't typecheck; only `npm run typecheck` does. Keep
  the pure audio modules import-free and add them to the root `tsconfig.json`
  `include`, as `web/src/lesson/reconcile.ts` already is.
- **`web/src/markdown.ts`'s `extractMath` eats currency.** If `text.ts` reuses
  that heuristic, "it fell from $50 to $100" silently loses everything between
  the dollar signs. A test asserting "no `$` survives" would pass. Write a
  currency test.
- **A reconnecting `EventSource` does NOT revive a wound-down runner.**
  `server/runner.ts:404-409` refuses revival on subscribe by design; only a POST
  route calls `runnerFor`. Hence the server watchdog above.
- **`condenseEntry` (`core/history.ts:49-53`) filters history entries to three
  whitelisted fields**, and `core/slicer.ts:83` condenses all but the newest. Any
  new field on the lesson record is invisible to the model on every past lesson.
  The history renderer is `core/history.ts:72-84`, *not* `core/patcher.ts`.
- **One logical turn emits several `assistant` events** when web tools fire
  (`server/runner.ts:272-296`), so "the last assistant message" is often "Let me
  check that."
- **`web/src/demo/replay.ts` builds a `Status` object literal.** Adding a
  *required* field to `Status`/`StatusLane` breaks `tsc -p web` and the GitHub
  Pages build. Make new fields optional or update the stub.
- **`composer.ts`'s `send()` is a closure inside `buildComposer`, not exported.**
  Audio needs the same sequence (optimistic bubble, pending-send bookkeeping,
  thinking indicator, error rollback). Hoist it to a shared
  `web/src/lesson/send.ts` rather than duplicating it.
- **Hang audio state on `LessonCtx` as one opaque field** (`audio:
  AudioController | null`), not five scattered properties — `ctx.ts` is already
  at the edge of its comfort.
- **CSP**: `server/index.ts:84-95` sets `script-src 'self'` (no inline scripts)
  and `connect-src 'self'` (any future third-party API must be proxied).
- **Secure context required.** `SpeechRecognition` and `wakeLock` need HTTPS —
  test over the tailnet URL, never a plain-HTTP LAN IP.
- **Prompt caching is not configured anywhere in this repo.** Don't let
  "byte-stability" drive a design decision; it's a comment, not a measurement.
- The web client always sends an explicit model, so `defaultModel()` in
  `server/params.ts` never fires from the PWA (`web/src/main.ts:51,297,332`).

## Cleanup — do this first

Delete the spike and everything supporting it, in one commit:

- `web/public/spike/` (whole directory)
- `POST /api/spike/run` and its allowlists in `server/index.ts` (~line 452ff),
  plus the now-unused `writeFileSync` import if nothing else needs it
- the `spike` branch of `stripPublicDirs` in `web/vite.config.ts` (~line 22-43);
  the plugin can go back to only dropping `demo` from non-demo builds

The spike's findings are recorded above; its raw logs are in J's data root under
`.app/spike/`.

## Files

**New:** `web/src/lesson/audio/{text,endpoint,adapter,panel}.ts`,
`web/src/lesson/send.ts`, `tests/audio.test.ts`

**Modified:** `server/prompt.ts` (spoken-turn rules + conditional `APP_INTRO`) ·
`server/index.ts` (`medium` on the message route → `modelText`; delete the spike
route) · `server/types.ts` (`TranscriptEntry.medium`) · `server/usage.ts`
(`LedgerMeta`) · `server/transcript.ts` (header line) ·
`web/src/lesson/{screen,ctx,events,composer}.ts` · `web/src/api.ts` (`medium` on
send, and the duplicated `TranscriptEntry`) · `web/src/main.ts` (Listen on
select) · `web/vite.config.ts` · `tsconfig.json` (include the pure audio modules)

## Verification

1. `npm run typecheck && npm test` — including a currency case (`$50 to $100`),
   abbreviation and decimal splitting, table/list handling, and an endpointer
   test asserting an empty buffer never submits however much time passes.
2. Desk run: `npm run restart`, start a lesson, toggle Listen. Speech starts
   within a chunk; nothing reads as "dollar sign" or "asterisk asterisk"; **Again**
   replays the whole turn rather than a tool preamble.
3. Continuation: toggle audio off mid-lesson, confirm the text screen picks up the
   same session; reload and confirm it appears under "In progress".
4. Mixed-medium round trip: half by voice, half typed, commit, confirm the ledger
   and transcript header record it. `npm run validate` clean.
5. Resilience: kill wifi mid-lesson and confirm recovery; background Safari and
   confirm `reconcile()` catches up without re-speaking.
6. **The screen is never required for a full lesson, including error recovery.**
7. Device: iPhone **Safari** over the tailnet HTTPS URL, phone speaker, parked
   with the engine running before any real drive.

## Open items

- **Cost is unsized.** Endpointing produces many short turns where typing produces
  few long ones; a 30-minute two-way Opus lesson with web tools, twice daily, will
  cost materially more than a text lesson. Price it early and tell J before it
  becomes a habit.
- **Wrap-up by voice is the hardest interaction.** `server/prompt.ts:83-117` is an
  ordered multi-turn pass with the commit at its end, and arriving at the office
  will routinely cut it off. The `ending` flag and the "needs attention" surface
  prevent data loss — verify that explicitly rather than assuming it.
- **Standalone-PWA mode is untested.** Every measurement was a Safari tab, which
  works. Only matters if a home-screen icon is wanted later; recognition is
  reported to fail there.
- **Full-duplex barge-in** looks feasible (no speaker bleed observed) but is
  unverified. Ship half-duplex first.
