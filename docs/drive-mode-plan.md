# Handsfree audio lessons for the commute — implementation plan

> **Read this first.** It is a handoff: you have the repo and the branch but
> none of the preceding conversation. Everything needed is here — the codebase
> exploration, the on-device measurement and an audit of the first draft of this
> plan are already done, so trust the file:line references rather than
> re-deriving them.
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
  Spoken turns are tagged so the *data quality* can be read later (they come
  from speech recognition), **not** to make the teaching easier.
- **Single user.** This is for J alone. **Diagnostics are deliberately
  over-built** — see Diagnostics. Anything can be stripped later; a feature that
  silently breaks over many drives cannot be un-broken after the fact.

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
   one git commit in a separate data repo (J's lives at `TUTOR_DATA_DIR`, set in
   `.env`; default `my-data/`).
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

**This mattered for audio**: wire speech to bubble rendering on the old code and
the tutor's last reply would be spoken again on every screen wake. It is fixed;
don't reintroduce index-based reconciliation. **And don't hook speech to
`addBubble` at all** — `showLesson` calls it for the entire history on load
(`screen.ts:157-160`). Speech is fed from SSE events plus an explicit reconcile
feed (see Turn-taking).

**Phase 0 — device measurement.** Results below. The spike itself is now dead
weight; delete it.

**The pure modules** — `web/src/lesson/audio/{text,endpoint,drive-state,diag}.ts`
with `tests/audio.test.ts`. Built to the rules below; run over all 395 tutor
messages in J's archive, `text.ts` leaves no sigil, and every message chunks
identically fed whole or one character at a time. Behaviour decided while
building them, beyond what this plan already said:
- The endpointer promotes an interim left dangling when a recogniser session
  ends (`onRecognizerEnd`), or the next session's first interim overwrites it.
- An answer interrupted mid-sentence by a spoken system line is kept (its
  interim promoted), and its silence clock restarts on the next `audiostart` —
  otherwise the interruption itself counts as the learner going quiet.
- A price range reads "5 dollars to 10 dollars".

**The server changes** (everything under "Server changes, collected", with
`tests/drive-server.test.ts`). Checked against a live server without spending
tokens: heartbeats every 15s, `modelText` never served, `turnInFlight` on GET,
health/kick/keep-going/diag routes and their refusals, connect/disconnect and
client batches landing in `.app/diag/<id>.jsonl`. **Not yet exercised against
the real SDK**: delta ids, the turn counter, `api_retry` /
`session_state_changed` handling and a real kick — the first real lesson turn
will show them in the diag log. Decided while building:
- **Typed turns are tagged only on the first one after a spoken turn** (J's
  call). The prompt says the mode holds until the next tag.
- `via` and the exact `modelText` are stored on every user entry, so a kick can
  re-send a turn verbatim (`modelText` is stripped from GET).
- `turnInFlight` = sends the SDK hasn't answered: reset on each `result` to the
  sends it hasn't been handed yet (a turn can absorb several queued sends). The
  SDK's own `session_state_changed` is logged beside it to check the rule.
- A kick closes the old runner *quietly*: nothing it emits afterwards, including
  `closed`, reaches clients. `api_retry` counts as progress, so a retrying turn
  is never kicked.
- Deltas are logged only when nobody received them (summarised on the next
  event); every other dispatched event is logged with its listener count.
- Server diag writes nothing under the node test runner (tests run against the
  real data root); diag files cap at 25 MB each.
- "Keep going" sits on the ending hint as an outline button; the In-progress
  card reads "expires in N days".
- **Still open**: how the curriculum viewer shows spoken turns. The counts reach
  `CurriculumUnitLesson` but nothing renders them yet — decide with J **once a
  real drive shows the feature works**. Same for the math-heavy select-screen
  warning (J, 2026-10-06).
- A failed API request (any assistant error but `max_output_tokens`) is no
  longer stored as a tutor turn — found live, when an expired login made every
  turn's "Failed to authenticate…" text a tutor bubble that drive mode would
  have read aloud. It is saved as `lastError` instead.

**First live run against the real SDK** (2026-10-08, tight/Sonnet, 4 turns +
a deliberate mid-turn kick, ≈ $0.47 API-equivalent). Confirmed: delta ids match
their finished messages exactly (text and id, all 4); `turnInFlight` and the
turn counter tracked every turn; tags landed (the spoken opening began "Quick
status check since you're on voice", the typed-after-spoken turn got its
markdown list back); the kicked runner's `closed` was muted; full
`rate_limit_info` arrives (five-hour window — but **no utilization figure**, so
subscription share still can't be read as a number). Measured:
- **First word 8–18s after an answer** (first delta, Sonnet) — far longer than
  the 3–6s the draft assumed for Opus. That's the dead air the turn-start tone
  and the 20s "still working" cue cover.
- **Cost shape**: the first two turns each paid ~30k tokens of cache creation
  (≈ $0.18–0.21 on Sonnet); later turns read the cache (≈ $0.04 each).
Found:
- **A kick made the model see the answer twice** ("Looks like that one may have
  come through twice"): the hung SDK session had already recorded it, as it will
  for nearly any mid-reply hang. **J's call: a kick now sends a hidden nudge**
  (`KICK_NUDGE`, tagged spoken when the turn was) instead of re-sending the
  turn. Re-run live: the fresh session answered the stuck turn naturally, in
  spoken form, with no mention of a duplicate.
- **"Still working" stays at 20s** (J's call): most replies start inside it, so
  it marks the genuinely slow turns.
- **A kicked reply's buffered tail would have been spoken** at turn_done ahead
  of the fresh reply. Fixed: a kick drops the cut-off message.

**J's calls for the browser side** (2026-10-06):
- **Overlay**: a big state word with a hint ("LISTENING · tap when you're
  done"); while listening, what the mic has heard so far in large text. Small
  Again / Exit in the corners (End was dropped after the first iPhone run —
  see below); a collapsed debug strip at the bottom.
- **In-lesson toggle**: a headphones button in the composer row, beside "+".
  (Plus the Listen toggle on the select screen, per Controls.)
- **Voice**: auto-pick the best installed English voice (iOS Premium/Enhanced
  first) at normal speed; a voice + speed picker in the overlay, remembered per
  device. (Since the first iPhone run: Samantha by default, tones on.)

**The browser side** — `adapter.ts`, `panel.ts`, `controller.ts` (the glue the
plan's module table didn't name: machine ↔ adapter ↔ overlay ↔ diag ↔ lesson
screen), `send.ts`, and the wiring in `screen`/`events`/`composer`/`main`.
Exercised in the desktop browser pane (Chromium, where the mic is blocked and
speech output fails — so it proved the wiring and the error paths, not
audio): restore-after-reload opens paused; a tap resumes; a blocked mic says so
once and pauses with no retry loop; the expired login is announced once;
client diag batches reach `.app/diag/`; ✕ exits and forgets the drive.
**Not yet run on the iPhone** — the next step is the parked preflight.
Decided while building:
- **Drive mode starts assuming a turn is running**; the server's health answer
  (a `turn_state` input) opens the mic. Found in the browser run: guessing
  "idle" from the screen opened the mic while a spoken start's opening turn was
  still running.
- **Listen applies to the In-progress and Needs-attention rows too**, not just
  Start: Listen on means "I'm in the car". (Flag to J — easy to narrow.)
- The overlay is always dark (glare), whatever the app theme.
- The pre-drive check lives in the expanded debug strip ("Run pre-drive
  check"), with the phone-speaker note. It pauses the drive and speaks results.
- Tones: short sine figures per cue; with tones off, "Okay." / "Still
  working." are spoken instead and the listening cue is silent (it fires with
  the mic live). A lead-in tone precedes speech after ≥1.5s of quiet, except
  inside a tap (a delay there would break iOS's gesture rule).
- Diag uploads every 15s, beacons on hide/pagehide, and keeps unsent batches in
  localStorage (capped ~2 MB) — adopted on the next drive, or sent straight up
  if they belong to another lesson.

**First iPhone run** (2026-10-09, parked, STS/Opus, two lessons: one
abandoned after the pre-drive check and a voice tour, one committed as Lesson
28 after a four-answer recall warm-up; ≈ $1.10 API-equivalent together,
≈ $0.04 per ordinary Opus turn once cached). Worked: the pre-drive check
passed every line; no sigil leaked into speech; the mic never opened before
`turn_done`; hide → pause → "Resuming." on tap; 8–13s from the end of an answer
to the tutor's first word. Found, and J's calls:
- **End was sent twice in both lessons** (taps 0.5s and 1.4s apart — End gave
  no feedback and the tutor kept talking), then ✕ — so the wrap-up ran to
  nobody. End and ✕ read as the same thing. **J: drop End from the overlay**;
  on the road the move is "stop here, carry on later". The one corner exit is
  labelled "✕ Exit drive mode"; ending is a text-mode action. The server also
  drops a second End the tutor hasn't answered yet (`endAlreadyPending`).
- **Two of four answers were cut off mid-sentence** ("…automatically backs
  the", "…the criteria by which that you"): J thinks aloud with pauses up to
  ~2.7s and the clock was 2.5s. **J: wait longer, both flat and mid-sentence** —
  waiting is fine while driving, feeling rushed isn't. Now 4s, or 7s when the
  last word can't end a sentence (`endsMidSentence`); the submit trace logs
  which clock applied.
- **Voice: Samantha (en-US) by default, tones on** — the automatic pick had
  been Eloquence's Reed, and most other voices are novelties. The saved-settings
  key moved to `tutor.voice.v2` so the tour's leftovers (tones off) reset.
- Not acted on: the first recogniser start in each lesson failed ~1s in with
  `audio-capture` ("Source is muted" / "Source is stopped") and retried fine
  1s later — words in that second would be lost. Watch for it in the car.

**First commuting week** (2026-10-09/10, Lessons 29–31 committed, three diag
logs read: `aa91ae2c`, `83f32ab8`, `714dd14a`; build `mv1rz3g6`; ≈ $7
API-equivalent across them; zero invariant failures; every turn missed while
the screen was off was recovered by reconcile). First delta after an answer:
median 14s, p90 25s. Found, and J's calls:
- **Spoken answers are cleaned before the tutor sees them** (J: "cleaned +
  raw"). `server/cleanup.ts`: Haiku, thinking off, the tutor's last message as
  context, one CLI subprocess kept warm (`POST /api/lesson/:id/clean/warm` at
  drive start; replaced after each use; closed after 15 idle minutes). Measured
  on the PC: cold SDK call ≈ 5s spawn + **36s of Haiku thinking** on a
  seven-word answer; warm with thinking off, **0.7–2.3s**. A `for await` exit
  added ~3s (the iterator's `return()` waits out the subprocess) — iterate by
  hand. The bubble, transcript and tutor get the cleaned text; the raw rides
  along as `heard` on the entry and in a bracket after the text for the
  tutor only. A repair whose word count drifts past max(4, 25%) is treated as
  an answer or a summary and rejected; any failure sends the raw text.
- **Again replays the last tutor turn even when drive mode came on after
  it** — it logged `again-empty` ×3 doing nothing in exactly that case. The
  controller reads the transcript at drive start (`history` input); from
  PAUSED, Again also resumes.
- **Samantha always, no "automatic" option** — the automatic pick landed on
  Eloquence's Flo on 2026-10-10 even after the Samantha change (the cause
  wasn't pinned down; `voice` now logs `why`). `defaultVoice` picks Samantha
  outright and only falls through to the old scoring when she's missing.
- **The 90s cap cut J off mid-sentence once** (19:27, "…so I think there is
  Attention"); every other answer ended on silence, the longest at 68s. J: 3
  minutes, ending at the next 1.5s pause; a hard backstop at 4 minutes for
  speech that never pauses.
- **The heard text scrolls** (J's pick): bottom-anchored, about six lines,
  oldest lines fade off the top.
- **Quieter on some drives, not others** (J's report, can't be measured from
  the page). Matches a well-reported iOS pattern: after the mic, the session
  stays in its record mode and speech plays attenuated. **Experiment, on by
  default with a toggle** (J): `audioSession.type = "playback"` before
  speaking, `"auto"` before the mic opens — never `"play-and-record"`. On
  Bluetooth it should keep the tutor's voice out of call-quality audio; the mic
  itself still forces the car into phone mode while J answers (iOS requires it
  for any Bluetooth mic; a web page can't pick the built-in mic instead). Every
  switch, every `audioSession` statechange and the session state at each
  utterance's start are logged — read them after the next drive.
- **The tone context goes `suspended` ~8s after its last sound**, so a lead-in
  or listening tone played late, over the speech it should precede. Tones now
  resume the context first (500ms limit) and speech waits for the tone.

**Audit.** A review of this plan's first draft against the code, the raw spike
logs and the usage ledger found nine wrong claims and a set of gaps; the
corrections are folded in throughout. The load-bearing finding: the draft treated
**network/SSE loss as an edge case, when it is the most likely way this fails in
a moving car** — and the spike, being device-local, never measured it.

## What the device actually does (measured, iOS 18.7 / Safari 18.7.5)

Facts from one evening's drive — **10 recognition sessions and 12 utterances**
(raw logs: J's data root, `.app/spike/`; two of the six files are cumulative
duplicates of the others). Design to them, but treat the numbers as a small
sample and let the diagnostics widen it.

- **Recognition works in Safari.** Not in Chrome/Firefox/Edge for iOS — those
  expose `webkitSpeechRecognition` but lack the entitlement and fail instantly
  with `not-allowed / "Microphone permission check has failed"`. **Safari only.**
- **Synthesis stays fully audible with the mic live** — *provided the page never
  touches `navigator.audioSession.type`*. The spike's "hold the session" test set
  it to `"play-and-record"`: on the phone speaker that made speech **quieter**, on
  Bluetooth it made **the car switch source**. Leaving it alone showed no
  demotion. See Traps.
- **Restart gap is ~110ms** (measured 94/108/110/111/112). Restarting
  recognition is nearly free — **once warm. The cold first start took 3.65s**
  from `start()` to `audiostart` (warm starts: 8–52ms). Words spoken before
  `audiostart` are lost.
- **Sessions end on their own after 4–79s, median ~12.6s**, not "20s+". With
  `continuous = false`, iOS reports a silent end as `error: "aborted"`, message
  `"No speech detected"`.
- **Finals arrive 1.2–2.1s after the last interim.** Interims stream as J talks
  (confidence 0); the final (confidence 1) lands when the recogniser gives up.
- **iOS rewrites spoken numbers**: "one, two, three, four, five" arrived as
  `12345`. Expect digits and symbols in J's turns.
- **Transcription at highway speed is excellent** through the phone's own
  speaker and mic. Road noise was not a problem.
- **Bluetooth flips the audio profile and the head unit switches source**, and
  call-mode audio is audibly worse. **Phone speaker is the default** — better
  quality and no profile churn.
- `speechSynthesis` had 223 voices at load; `tts.end` fired for every utterance.
  **But every utterance was one ~21s block**: a multi-utterance queue,
  `cancel()` and skip were never exercised.
- Wake lock acquires and holds (the one "RELEASED" line in the logs is the spike
  replacing its own lock, `audio-check.js:282`).

**Not measured at all**, and so covered by diagnostics and the preflight rather
than assumed: the network path (tailnet over cellular at speed — SSE, POSTs), the
home PC sleeping, navigation voice prompts or notifications interrupting
synthesis/recognition, Low Power Mode refusing the wake lock, and Web Audio
tones alongside a live mic.

## What the usage ledger says (J's `transcripts/usage.jsonl`, lessons 22–27)

- **Turns run long.** The longest turn per lesson was **52–104s**
  (`durationMs`), with web tools. Any "no reply" watchdog under ~120s fires on
  healthy turns — and 100s of silence in a car needs a cue (see Speaking).
- **Prompt caching is automatic and dominant.** The Agent SDK caches without any
  config here: lesson 27 was 32 input tokens against 533k cache-read. Each turn
  re-reads roughly 35k cached tokens, and a pause past the cache TTL pays
  `cacheCreation` again. So many short spoken turns cost more than few long typed
  ones — measure it per turn (`via` on `UsageRecord`) rather than guess.
- **Lessons already span 22–51 hours of wall clock** — the 24h idle expiry is too
  short for "spans media" (see Resilience).

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
| `web/src/lesson/audio/text.ts` | pure | markdown + LaTeX → speakable text, and the streaming chunker. **Imports nothing.** |
| `web/src/lesson/audio/endpoint.ts` | pure | the two-clock endpointer |
| `web/src/lesson/audio/drive-state.ts` | pure | the turn-taking reducer: `LessonEvent`s, reconcile additions, recogniser/synth callbacks and taps in → actions out (speak, listen, stop, submit, cue, say-recovery). **This is where the riskiest rules live, so it must be testable.** |
| `web/src/lesson/audio/diag.ts` | pure | the client diagnostics seam — ring buffer, counters, soft invariants (see Diagnostics). Storage and upload are injected. |
| `web/src/lesson/audio/adapter.ts` | impure | the *only* file touching `speechSynthesis`, `SpeechRecognition`, `wakeLock`, `AudioContext` |
| `web/src/lesson/audio/panel.ts` | impure | the overlay, the debug strip, the preflight |

`web/src/lesson/reconcile.ts` is the precedent: zero imports, listed in the root
`tsconfig.json` `include` so `tests/` can reach it. Do the same for `text.ts`,
`endpoint.ts`, `drive-state.ts` and `diag.ts`. **They may import each other
(with `.js` specifiers, which both programs resolve) but nothing else under
`web/src/`** — see Traps. `drive-state.ts` declares the slice of `LessonEvent`
it consumes structurally rather than importing `api.ts`, and reports through
`diag` *actions* rather than importing `diag.ts`, so its invariants are
assertable in tests.

### Turn-taking

**Half-duplex**: stop recognition while speaking. **Start listening only when
both hold: the utterance queue has drained *and* `turn_done` has arrived for the
latest turn.** Draining alone is not enough — a turn with web tools emits "Let
me check that.", then a tool call of 5–100s, then more text; opening the mic in
that gap lets the endpointer submit an answer while the model is mid-turn, and
`runner.send` queues it behind the turn in progress. Barge-in is a tap, not a
voice command. (During the mic-live test, recognition captured *nothing* while
the tutor spoke through the phone speaker — no phantom barge-in from speaker
bleed — so full-duplex with real voice barge-in looks feasible later. One
uncontrolled observation; ship half-duplex.)

**The listening cue fires on `audiostart`, not on `start()`.** A cold start took
3.65s; cueing on `start()` invites J to talk into a dead mic.

**Endpointing — two clocks, both ours.** `SpeechRecognition` gives no "how long
to wait" setting: it ends its own session after ~1–2s of silence. So treat
`onend` as *"the recogniser gave up"*, not *"the learner finished"*, restart it,
and keep accumulating into the same pending-answer buffer (join sessions with a
space). Then:

| Situation | Rule |
|---|---|
| **Buffer empty and no interim seen** — J hasn't started talking | **Wait indefinitely.** Never submit. J can think for two minutes while the recogniser silently cycles underneath. |
| **J has spoken, then gone quiet** | Submit after **4s with no new interim or final** — **7s when the last word can't end a sentence** ("the", "to", "which"…). Was 2.5s flat until the first iPhone run cut off two answers. |

**Time the silence clock from interim activity, not finals** — finals land
1.2–2.1s after J stops, so a finals-only clock means ~4s of dead air per answer.
On submit, if an interim is newer than the last final, stop the recogniser and
wait up to ~1s for its final before sending. Both numbers are first guesses;
the endpointer's decision trace (Diagnostics) exists to tune them.

Plus a cap at 3 minutes that ends the answer at its next 1.5s pause (hard at
4 minutes; it was 90s and hard until it cut J off), and a **Done** tap that
submits immediately. This
split is what makes recall warm-ups work unchanged — thinking time is free by
construction, so no per-question timing hints are needed and grading is untouched.

**Adapter rules, each learned the hard way:**

- **Always stop before starting; never retry into a running recogniser.** The
  spike started recognition in one step without stopping it, so a later step
  inherited a live session and threw `InvalidStateError` — ~100 times per run,
  at ~600ms intervals. Keep an explicit `starting | running | stopped` flag.
- **Reset the "last ended at" timestamp when opening a fresh session**, or the
  first `audiostart` measures a gap from some earlier session and reports a
  fictitious multi-second stall (the spike logged a 50,596ms one).
- `no-speech` and `aborted` are the **normal** end path with `continuous = false`
  — never treat them as errors or back off on them. `network` needs real backoff.
- One singleton `SpeechRecognition`; constructing a new one each time plays the
  system chime. Set `lang` explicitly and `interimResults = true`.
- **A final can arrive after `stop()`.** Once an answer is submitted, any late
  final goes to the diag log as `late-final`, never into the next answer's buffer.
- **Watchdog.** The documented iOS failure is `onresult` ceasing with *neither*
  `onerror` nor `onend`. No event within N seconds while nominally listening →
  `abort()`, fresh `start()`, and say so aloud. The "wait indefinitely" rule
  above would otherwise hide this as silence. Sessions have run up to 79s
  *with* events, so N is about silence-without-any-event; start at ~30s and tune
  from the logs.
- **No auto-resume after an interruption.** On `visibilitychange → hidden` while
  active, enter a hard PAUSED state needing one tap. A phone call breaks the
  gesture chain and kills synthesis; auto-resuming yields a car that is silent
  for the rest of the drive.

### Speaking

- **Chunk at paragraph / 2–3 sentence granularity, not per sentence.** iOS's
  failure mode is a stalled queue; more `speak()` calls means more chances to hit
  it, plus an audible gap at every boundary. Drive the queue yourself one
  utterance at a time off `onend`, with a timeout fallback scaled to the chunk's
  length (estimate from word count and rate). Never push N utterances in at once.
- **The chunker only cuts at safe boundaries** of streaming markdown: a blank
  line outside any code fence, `$$…$$` block, table or list, or a sentence end
  once a paragraph runs long. Half-streamed markdown is never converted.
- **The chunker is message-scoped, and the turn is several messages.** It
  accumulates deltas, and **on each `assistant` event flushes its own residual**
  — never `ev.text`, which would speak the message twice — and inserts a
  boundary so "…check that." and "So the…" don't run together. It resets on
  `turn_done`.
- **Every `delta` carries its message id** (new — see Server changes), so the
  audio layer knows how much of each entry it has spoken. That is what lets the
  reconcile feed resume a half-spoken message instead of repeating or skipping it.
- **iOS synthesis quirks:** keep a strong reference to the current
  `SpeechSynthesisUtterance` (it can be garbage-collected before `onend`), and
  stamp each utterance with a generation token — `cancel()` can fire
  `onend`/`onerror` for the cancelled one, which must not advance the queue.
- **The first `speak()` must run synchronously inside the tap handler.** Anything
  behind an `await` breaks the gesture chain and iOS drops it silently. Speak a
  one-word "Starting." in the handler itself — on the select screen's Start too
  (see Controls), since `createLesson` and `showLesson` both `await`.
- **Voices:** use `speechSynthesis.getVoices()` if it is already non-empty (it
  was, 223, at load on J's phone); only otherwise wait for `voiceschanged`, with
  a timeout. Waiting on the event unconditionally can hang forever.
- **Cues are Web Audio tones** (J's choice): one shared `AudioContext`, created
  and resumed synchronously in the start tap, tones made by an oscillator (the
  CSP's `default-src 'self'` blocks `data:` audio). Uses:
  - a short lead-in before the first chunk after silence, since the first
    ~100–300ms is clipped while the output route wakes;
  - a soft tone on turn start — Opus first-token latency is 3–6s of dead silence;
  - a quiet "still working" cue every ~20s while a turn is in flight, because
    turns run up to ~100s.

  **Tones alongside a live mic were never measured**, so: log
  `AudioContext.state` on every cue and every `statechange` (iOS interruptions
  suspend it), include a tone check in the preflight ("is speech still full
  volume after a tone?"), and keep a per-device setting that falls back to spoken
  cues ("Okay.", "Still working.") if tones misbehave in the car.
- Backgrounding mid-utterance kills synthesis unrecoverably in-page — plan for
  reload-on-resume, not resume (see Resilience for how the reload finds its way
  back).

`text.ts` must handle: tables (**drop** them with a spoken "there's a table here,
it's in the app" — normalising is worse than skipping), nested lists (ordered
markers → "One," / "Two,"; flatten and say so), inline code and symbols
(`softmax(QK^T/√d_k)` — the AI lane is weight 50, so this is constant, not rare),
markdown link text without the URL, em-dash → comma, abbreviations and decimals
in the sentence splitter (`Dr.`, `e.g.`, `Fig. 3`, `0.5`, `v1.2.3`), stripped
headings needing an appended period, and **currency** (see Traps).

J's calls on the details (J's archive: of 395 tutor messages, 82 have inline
math, 36 display math, 9 code fences, 5 tables, 3 nested lists):

- **Inline math gets a light verbalizer**: Greek letters by name, `x_t` → "x sub
  t", `x^2` → "x squared", `\frac{a}{b}` → "a over b", `\hat y` → "y hat",
  `\text{…}` unwrapped. Anything it can't parse falls back to stripped symbols,
  **recorded as a note** so the diag log shows it.
- **Display math, code fences, mermaid and images get a short placeholder**, like
  tables ("there's an equation here, it's in the app"). The spoken-turn rules
  steer the tutor away from producing them in the first place.
- **Nested lists**: sub-items follow their parent, introduced once per nested
  run with "Under that:".
- **Abbreviations are left to the voice** — no expansion. The sentence splitter
  still must not break on them.
- Nothing in the output may contain a markdown sigil. Anything stripped crudely
  is reported alongside the text, never silently.

### Controls

Prefer **one full-screen, state-dependent tap target** — speaking → skip,
listening → done, paused → resume — with a small Again and "✕ Exit drive
mode" in the corners. Four buttons is too much target-finding on a mount. (There
was an End corner too; it was dropped after the first iPhone run — ending is a
text-mode action.)

J's calls on the tap target:

- **Skip drops everything received so far this turn** — the queue, and the rest
  of the message still streaming in. Messages that arrive *later* in the same
  turn (after a web search, say) are still spoken, so a closing question isn't
  lost.
- **A tap while the tutor is thinking speaks a status line** ("Still working,
  about 40 seconds so far."). It changes nothing else.

**Guard the state transitions.** A "skip" tap that lands just as speaking flips
to listening becomes "done" and submits half an answer. Ignore taps for ~400ms
after any state change, and make "done" on an empty buffer a no-op. Log every
tap with its state and ms-since-transition.

Also needed:

- **Again**: replays the concatenation of all assistant text since the last user
  turn, *not* the last `assistant` event (one logical turn emits several when web
  tools fire). Local replay only — instant, free, no model turn.
- **Audible errors.** `showBanner`, `alert()` (`screen.ts:49`, `wrapup.ts:123`,
  `main.ts:338`) and `confirm()` (`screen.ts:119`) are all invisible while
  driving. `closed`, `api_error`, `error` and `rate_limit` each need a spoken
  line. Speak `rate_limit` once per status change, not on every turn, and only
  for `rejected` / `allowed_warning`.
- A **Listen** toggle on the *select* screen as well as in-lesson, so the tutor's
  opening — the orienting message — is spoken rather than missed, and arrives in
  spoken form (the kickoff is tagged; see below). Listen is a **per-device**
  setting (localStorage), not a session property.
- The build id, visible in the drive panel — `sw.js` serves the shell
  cache-first, so the first load after `npm run restart` runs the *previous*
  bundle.
- One line noting phone speaker is preferred, if Bluetooth is connected.
- **A math-heavy warning on the select screen** (J's request): when Listen is on
  and the picked topic is likely math-heavy, say so — "this is likely math-heavy,
  so probably not the best suited for an audio lesson". A warning, not a block.
  *How to judge "math-heavy" is still open* — decide with J when building the
  select screen (candidates: the lane, or math density in that topic's past
  transcripts).
- Hide drive mode entirely in `__DEMO__` builds.

### Telling the model it's a spoken turn

The system prompt is built once at session creation and **never rebuilt**
(`server/runner.ts:92`, resumed via `sdkSessionId` at `:103`). Since a lesson
spans media, the channel cannot live in the prompt. Instead:

- Every model-bound turn carries **`via: "typed" | "spoken"`**. The server turns
  it into a `modelText` prefix via the existing `runner.send(text, hidden,
  images, modelText)` path (`server/runner.ts:130-157` — the transcript keeps
  `text`, the model receives `modelText`). `/api/lesson/:id/end` already uses
  this, so it is a proven mechanism, not a new one.
- **All three server entry points take `via`**: `POST /api/lesson/:id/message`,
  `POST /api/lesson` (the hidden kickoff — otherwise the spoken opening arrives
  as markdown) and `POST /api/lesson/:id/end` (the wrap-up checklist). Prefix
  composes with the existing `modelText` there.
- **`runner.send` gains a `via` parameter and stores it on the
  `TranscriptEntry`** — a `modelText` prefix alone leaves no record. Assistant
  entries inherit the `via` of the user turn that produced them (track it on the
  runner per turn, like `turnModel`).
- **Tag both directions.** An untagged turn following tagged ones is ambiguous,
  and recency bias keeps the model in spoken mode. Typed turns get their own
  short tag.
- **Make the tag carry the rule**, not just a label:
  `[spoken turn — transcribed from speech; reply in spoken form: no markdown, no
  LaTeX, no URLs read aloud]`. ~20 tokens, adjacent to the content it governs.
  This is the highest-leverage line in the design.
- Add `via?: "typed" | "spoken"` to `TranscriptEntry` (`server/types.ts`) — and
  **also** to the hand-duplicated copy in `web/src/api.ts:236-242`. Optional:
  absent means typed, which keeps every existing session valid.

Naming: the repo already uses "medium" for CLI-vs-app, so this axis is `via`,
and prompt text says "spoken turns".

### Where the spoken rules live

**`server/prompt.ts`, not the shared teaching contract.**
`skills/references/teaching-contract.md:6-8` states that medium-specific
machinery stays in the consumers, and the CLI consumer runs in a terminal and can
never be audio — so a spoken section there is dead text for one of two consumers.

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
- No markdown, headings, bullets, tables, code fences, images or mermaid — and
  **no display equations**. If one of these genuinely can't be avoided, say it's
  waiting in the app rather than producing it.
- **Never read a URL aloud** — name the source ("Mikolov's 2013 Word2Vec paper");
  `sourcesUsed` and the transcript keep the link.
- **Questions must be answerable out loud with no scratch paper.** A medium
  constraint, not a difficulty concession — the depth stays.
- **J's turns are speech-recognition output.** Expect homophones, no punctuation,
  mangled jargon ("tension" for attention), and numbers rewritten as digits.
  Read for intent, silently correct the obvious, and **never grade a
  transcription artifact as a learner error.**
- Decline image-led material in audio and offer to park it for the app.

### Recording that a lesson was spoken

A lesson is usually *mixed*, so record counts, not a flag:

- **`LedgerMeta`** (`server/usage.ts:160-168`, which already carries `size` — the
  same kind of app-only session metadata) gains `spokenTurns` and `typedTurns`,
  computed from the transcript's `via`.
- **`UsageRecord`** gains `via` (the user turn that drove it), so spoken vs typed
  cost is exact per turn.
- A header line in `server/transcript.ts`, and a per-turn marker on spoken
  learner turns (e.g. `### J (spoken)`), so the data quality of each answer is
  readable in the archive.
- **The viewer does not get this for free.** `server/lesson-index.ts` copies an
  explicit field list into `LessonIndexEntry` (`:45-55`, `:189-199`); thread the
  counts through it, the web mirror (`CurriculumUnitLesson` in `web/src/api.ts`)
  and the viewer.

**Do not put it in `core/`.** A lesson-record field there would be stripped from
the packet anyway — see Traps.

### Resilience

The car is on cellular, through the tailnet, to a PC at home. Assume the stream
drops.

- **Reconcile feeds audio.** SSE has no replay: deltas, `assistant` and
  `turn_done` emitted during a gap are gone. `reconcile()` (`events.ts:23-65`)
  already draws the missed entries; the audio layer must also receive them —
  speaking each unspoken assistant entry once, resuming a half-spoken one from its
  spoken offset (by message id) — or the car stays silent waiting for a
  `turn_done` that was lost.
- **`GET /api/lesson/:id` returns `turnInFlight`**, so reconcile knows whether to
  keep waiting or treat the turn as done.
- **Heartbeat events.** The server's 25s pings are SSE *comments*
  (`index.ts:408`), which `EventSource` never surfaces — a dead stream and a
  thinking model look identical. Emit a real `{type:"heartbeat"}` event instead
  (add it to both `LessonEvent` unions; the text screen ignores it).
- **Recreate a `CLOSED` `EventSource`.** `api.events` (`api.ts:449-476`) handles
  reconnecting but not `readyState === CLOSED`, which any non-200 reconnect
  causes (e.g. a 502 from `tailscale serve` while the PC restarts). Recreate with
  backoff, then reconcile. Text mode benefits too.
- **Runner watchdog.** No `turn_done` within ~120s of a submit (turns run to
  ~104s) → ask `GET /api/lesson/:id/health` first; never blindly re-POST. A
  re-POST appends a *second copy* of J's answer, and does not revive a hung
  runner anyway: `runnerFor` (`runner.ts:410-420`) returns the existing
  non-closed runner. If health shows the runner alive but silent past the
  threshold → **auto-kick once** (`POST /api/lesson/:id/kick`, below), saying so
  aloud; a second stall → speak "the tutor seems stuck — tap to retry" and wait.
  If health shows the runner closed, the next message POST revives it as today.
- **Reload-on-resume must find its way back.** There is no routing: boot always
  calls `showSelect()` (`main.ts:408`). Persist `{lessonId, audio}` to
  localStorage when drive mode is on; on boot, if present, open that lesson in
  drive mode, PAUSED, waiting for the tap that re-unlocks audio.
- **`ending` is sticky until commit** (J's decision; fixes text mode too). Today,
  answering the wrap-up's own "any last questions?" clears it — server
  `index.ts:250-253` and client `composer.ts:145` — so a drive that ends mid-wrap-up
  drops the lesson from "Needs your attention" to plain "In progress". Remove
  both clears. `ending` resets only on commit, or on an explicit "keep going"
  control on the ending hint.
- **Expiry goes from 24h to 7 days** (J's decision): `EXPIRY_MS` in
  `runner.ts:348`. The In-progress card shows "expires in N days".
- **Atomic session writes.** `saveSession` (`store.ts:21-24`) is a bare
  `writeFileSync`, called on every transcript append; one torn file makes
  `listSessions` throw, which takes down `/api/status` and the select screen.
  Write to a temp file and rename; have `listSessions` log and skip a file that
  won't parse.

### Server changes, collected

- `via` on the message, create and end routes; `runner.send(…, via)`; assistant
  entries inherit it; `via` on `UsageRecord`; `spokenTurns`/`typedTurns` on
  `LedgerMeta`.
- The runner assigns each assistant entry's id when the message starts streaming
  and puts it on every `delta` (`{type:"delta", id, text}`), then uses the same id
  when it appends the finished entry.
- `turnInFlight` on `GET /api/lesson/:id`; `{type:"heartbeat"}` events.
- `GET /api/lesson/:id/health`: runner alive/closed, turn in flight, queue
  length, ms since the last SDK message, current SSE listener count.
- `POST /api/lesson/:id/kick`: close the runner, revive it via resume, and
  re-queue the last *unanswered* user entry **to the model only — no new
  transcript entry**, so nothing is duplicated.
- `POST /api/diag/:id` (see Diagnostics).
- Forward the full `rate_limit_info` object, not just `status`/`resetsAt`.
- Sticky `ending`, 7-day expiry, atomic `saveSession`.

## Diagnostics

J's standing instruction: **build in far too many, strip later.** Every rule in
this plan that was "learned the hard way" was learned from a log; the drives are
where the next ones will come from.

**Principles**

- **One seam per side.** Client: `web/src/lesson/audio/diag.ts` (pure; the
  storage and upload functions are injected by the adapter). Server:
  `server/diag.ts`. Everything calls `diag(kind, detail)`. Stripping later means
  making those no-ops; the call sites stay.
- **Soft invariants.** `diag.invariant(cond, name, detail)` logs loudly and bumps
  a counter. It never throws — a failed assertion mid-drive must not silence the
  car.
- **Every record** carries the build id, session id, a monotonic ms timestamp and
  the drive-state machine's current state.
- **Audibility: speak recoveries only** (J's decision). The app says something
  aloud only when it is *acting* on a problem — recogniser watchdog restart,
  connection lost/restored, a kick. Everything else is silent and read later.

**Sink** (J's decision: upload + local mirror). The client keeps a ring buffer,
batches it to `POST /api/diag/:sessionId` every ~15s and on
`visibilitychange → hidden` / `pagehide` (via `sendBeacon`; `connect-src 'self'`
allows it), and mirrors unacknowledged batches to localStorage, retrying them
later — the tailnet may be unreachable from the road. The server appends to
`<data root>/.app/diag/<sessionId>.jsonl` with a size cap; `.app/` never enters
git. Client and server records share the file, distinguished by a `src` field.

**Client — what to record**

- *Recognition:* every `start` / `audiostart` / `speechstart` / interim / final
  (text + confidence) / `end` / `error`; start→`audiostart` latency; session
  duration; late finals; watchdog fires.
- *Synthesis:* per chunk — the raw markdown slice and the spoken text it became,
  estimated vs actual duration, and how it ended (`end`, cancel, timeout
  fallback); the chosen voice and voice count.
- *Sigil scanner:* any spoken chunk containing `$ * # | \ _ ^`, a backtick or
  `http` is logged as an anomaly — catches `text.ts` gaps on real content the
  tests don't cover.
- *Stream consistency:* on each `assistant` event, compare the chunker's
  accumulated deltas for that message id with `ev.text`; log any mismatch.
- *Endpointer decision trace:* buffer contents, reason (silence / cap / done
  tap), and the timings behind it — the data for tuning 2.5s and 90s.
- *Taps:* state, ms since the last transition, the action taken or ignored.
- *SSE:* open, error, reconnect, time spent `CLOSED`, heartbeat gaps; reconcile
  additions while audio is on, and whether each was spoken.
- *Platform:* wake lock acquire/release, visibility changes, the page-load
  navigation type (catches iOS silently reloading the tab), `AudioContext.state`
  on every cue and `statechange`, whether `audioSession` exists (never set it),
  UA.
- *Invariants:*
  - never `start()` recognition while speaking, or while `starting` / `running`;
  - never submit while a turn is in flight;
  - never submit an empty buffer;
  - every assistant entry after audio-on is spoken or explicitly skipped;
  - every submit gets its `user` echo within ~10s, and a `turn_done` within the
    watchdog threshold.
- *Debug strip* in the drive panel, collapsed by default (tap to expand, for use
  while parked): state, the last 20 events, counters, build id.

**Server — what to record** (same JSONL file)

- Runner lifecycle: start, revive, close — with the reason and any `consume()`
  error.
- SSE connect/disconnect per session, with duration and UA.
- **Every dispatched event with the listener count at dispatch.** A count of 0
  means the event was lost to a gap — this measures the SSE problem directly.
- Turn timing: send → first delta → each `assistant` → `result`, tagged with
  `via` and tools used.
- The full `rate_limit_info` object on every `rate_limit_event`.
- Every `ending` set/reset, every auto-abandon, every kick and its outcome.

**Offline tools**

- `npm run drive-report <sessionId>` — summarises a session's diag JSONL: counts,
  anomalies, invariant failures, latency distributions (recogniser start, turn
  first-token, turn total), SSE gaps and zero-listener events.
- `npm run speech-audit` — runs `text.ts` over every tutor message in J's archived
  transcripts (27+ lessons of real content), and lists sigil hits and
  currency/number handling. Reads the data root; commits nothing.

**Preflight.** A "Check" button on the drive panel, run while parked, speaking
its results in the style of the spike's runbook: Safari (not Chrome) detected,
server health, an SSE round trip, mic → recogniser → a spoken test phrase, a
synthesis line, a tone followed by speech at full volume, wake lock held, build
id current.

## Traps

Each of these cost real time to find. Don't rediscover them.

- **Tests importing `web/src/` drag those files into the root `NodeNext`
  program**, which lacks `web/src/vite-env.d.ts` and resolves differently. It
  breaks the moment a module touches `web/src/markdown.ts` (which imports katex
  CSS) or `__DEMO__` (declared only in `vite-env.d.ts`). **`npm test` will not
  catch it** — `tsx --test` doesn't typecheck; only `npm run typecheck` does. Keep
  the pure audio modules free of imports beyond each other, and list them in the
  root `tsconfig.json` `include`, as `web/src/lesson/reconcile.ts` already is.
- **Never set `navigator.audioSession.type` to `"play-and-record"`.** Measured: it
  made speaker output quieter and made the car switch Bluetooth source.
  `"playback"` while speaking / `"auto"` before listening is a separate, logged
  experiment (see First commuting week).
- **`web/src/markdown.ts`'s `extractMath` eats currency.** If `text.ts` reuses
  that heuristic, "it fell from $50 to $100" silently loses everything between
  the dollar signs. A test asserting "no `$` survives" would pass. Write a
  currency test.
- **A reconnecting `EventSource` does NOT revive a wound-down runner.**
  `server/runner.ts:404-409` refuses revival on subscribe by design; only a POST
  route calls `runnerFor`. **And a POST does not replace a *hung* runner** —
  `runnerFor` returns any non-closed one. Hence health + kick.
- **`condenseEntry`'s field filter (`core/history.ts:49-53`, applied at
  `:63-69`) keeps three whitelisted lines**, and `core/slicer.ts:83` condenses
  all but the newest history entry. Any new field on the lesson record is
  invisible to the model on every past lesson. The history renderer is
  `core/history.ts:72-84`, *not* `core/patcher.ts`.
- **One logical turn emits several `assistant` events** when web tools fire
  (`server/runner.ts:272-296`), so "the last assistant message" is often "Let me
  check that." — and the queue drains between them (see Turn-taking).
- **`showLesson` renders the whole history through `addBubble`**
  (`screen.ts:157-160`). Never trigger speech from bubble rendering.
- **`web/src/demo/replay.ts` builds a `Status` object literal and implements the
  `Api` interface.** Adding a *required* field to `Status`/`StatusLane`, or a
  parameter the demo doesn't accept, breaks `tsc -p web` and the GitHub Pages
  build. Make new fields and params optional or update the demo.
- **`composer.ts`'s `send()` is a closure inside `buildComposer`, not exported.**
  Audio needs the same sequence (optimistic bubble, pending-send bookkeeping,
  thinking indicator, error rollback). Hoist it to a shared
  `web/src/lesson/send.ts` rather than duplicating it. The server trims `text`
  (`index.ts:225`); the pending send must hold exactly the trimmed text or
  `adoptLocalSend` won't match.
- **Hang audio state on `LessonCtx` as one opaque field** (`audio:
  AudioController | null`), not five scattered properties — `ctx.ts` is already
  at the edge of its comfort.
- **CSP**: `server/index.ts:84-95` sets `script-src 'self'` (no inline scripts),
  `connect-src 'self'` (any future third-party API must be proxied) and
  `default-src 'self'` (no `data:` audio — make tones with an oscillator).
- **Secure context required.** `SpeechRecognition` and `wakeLock` need HTTPS —
  test over the tailnet URL, never a plain-HTTP LAN IP.
- **Prompt caching is automatic, not absent.** Nothing here configures it, but
  the Agent SDK caches, and the ledger shows cache reads dominating every
  lesson. Don't let "byte-stability" drive a design decision; do read
  `cacheRead`/`cacheCreation` when reasoning about cost.
- **The service worker used to be cache-first for pages** (`web/public/sw.js`):
  the first load after a rebuild ran the old index.html, whose hashed assets
  the rebuild had deleted — a broken page on the phone (seen in J's log,
  2026-10-08). Pages are now network-first (cache only offline / after 4s),
  `/assets/` cache-first; `tests/sw.test.ts` locks it in. A phone still on the
  old worker gets one more stale load before the new one takes over. Check the
  build id in the debug strip before trusting a test. (The desktop browser pane
  refuses service-worker scripts, so it can't exercise this.)
- The web client always sends an explicit model, so `defaultModel()` in
  `server/params.ts` never fires from the PWA (`web/src/main.ts:51,297,332`).
- Stale comment to fix in passing: `END_TURN_TEXT` in `server/params.ts` still
  says the screen renders an optimistic End bubble; it no longer does.

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

**New:**
`web/src/lesson/audio/{text,endpoint,drive-state,diag,adapter,panel}.ts`,
`web/src/lesson/send.ts`, `server/diag.ts`, `scripts/drive-report.ts`,
`scripts/speech-audit.ts`, `tests/audio.test.ts`

**Modified:**
- `server/prompt.ts` — spoken-turn rules, conditional `APP_INTRO`
- `server/index.ts` — `via` on message/create/end; health, kick, diag routes;
  `turnInFlight`; heartbeat events; sticky `ending`; delete the spike route
- `server/runner.ts` — `send(…, via)`, delta ids, per-turn `via`, full
  `rate_limit_info`, kick support, 7-day expiry, diag hooks
- `server/types.ts` — `TranscriptEntry.via`, `UsageRecord.via`, `LessonEvent`
  additions
- `server/usage.ts` — `LedgerMeta` turn counts
- `server/tutor-tool.ts` — compute the counts for the ledger
- `server/transcript.ts` — header line and per-turn spoken markers
- `server/lesson-index.ts` — thread the counts through
- `server/store.ts` — atomic writes, tolerant listing
- `server/params.ts` — stale comment
- `web/src/lesson/{screen,ctx,events,composer,wrapup}.ts` — `via`, reconcile
  feed, sticky ending with "keep going"
- `web/src/api.ts` — `via` on send/create/end, duplicated types, heartbeat and
  delta id, `CLOSED` recovery, health/kick/diag calls, lesson-index mirror
- `web/src/main.ts` — Listen on select, restore drive mode on boot, expiry on
  In-progress cards
- `web/src/demo/replay.ts` — keep satisfying `Api`
- `web/vite.config.ts`
- `tsconfig.json` — include the four pure audio modules
- `package.json` — the two scripts

## Verification

1. `npm run typecheck && npm test`, including:
   - a currency case (`$50 to $100`), abbreviation and decimal splitting,
     table/list handling;
   - **streaming equivalence** — a message fed whole and fed one character at a
     time speaks identically;
   - endpointer: an empty buffer never submits however much time passes, and the
     silence clock follows interims;
   - `drive-state`: no listening before `turn_done` even when the queue drains
     mid-turn, the tap-transition guard, the reconcile feed speaking a missed
     entry exactly once, and resuming a half-spoken one from its offset.
2. `npm run speech-audit` over J's real transcripts: zero sigil hits.
3. Desk run: `npm run restart`, start a lesson, toggle Listen. Speech starts
   within a chunk; nothing reads as "dollar sign" or "asterisk asterisk";
   **Again** replays the whole turn rather than a tool preamble.
4. Continuation: toggle audio off mid-lesson, confirm the text screen picks up the
   same session; reload and confirm drive mode restores, PAUSED.
5. Mixed round trip: half by voice, half typed, commit, confirm the ledger turn
   counts, `via` on usage records, and the transcript header and per-turn
   markers. `npm run validate` clean.
6. Resilience: kill the network mid-turn and restore it; confirm the drive
   report shows the zero-listener events, the missed text is spoken once, and no
   invariant fails. Kill the server and restart it; confirm the `CLOSED` stream
   recovers. Background Safari and confirm `reconcile()` catches up without
   re-speaking. End a lesson, answer a wrap-up question, and confirm it stays
   under "Needs your attention".
7. **The screen is never required for a full lesson, including error recovery.**
8. Device: iPhone **Safari** over the tailnet HTTPS URL, phone speaker; the
   preflight passes parked with the engine running; then one real drive, and
   read `npm run drive-report` before the second.

## Open items

- **Cost is sized per turn, not yet per lesson.** `via` on `UsageRecord` will
  show spoken vs typed cost after the first few drives. Look at it and tell J
  before this becomes a habit.
- **Wrap-up by voice is the hardest interaction** — and is now out of drive
  mode: the overlay has no End, so a drive ends with "Exit drive mode" and the
  lesson stays in progress for a text wrap-up later. Revisit only if that gets
  annoying.
- **Standalone-PWA mode is untested.** Every measurement was a Safari tab, which
  works. Only matters if a home-screen icon is wanted later; recognition is
  reported to fail there.
- **Full-duplex barge-in** looks feasible (no speaker bleed observed) but is
  unverified. Ship half-duplex first.
- **Navigation prompts and notifications** interrupting speech are unmeasured;
  the diagnostics should show it if it happens.
