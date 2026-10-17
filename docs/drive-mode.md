# Drive mode — two-way spoken lessons

Drive mode turns the lesson screen into a hands-free, spoken lesson for J's
~30-minute car commute: the tutor talks, J answers out loud, it adapts. It is a
**rendering mode on the existing lesson screen**, not a separate screen, so a
lesson moves freely between voice and text — start it in the car, finish it at
a desk — with no resume plumbing and no second session.

This doc is the reference: how it works, what the phone measurably does, the
traps, and the decisions behind it. It replaces the build plan it grew from
(`docs/drive-mode-plan.md`, in git history before the merge), keeping the
findings and dropping the plan.

For using it, see [APP.md](../APP.md#drive-mode).

## Constraints

Settled with J before building, and still true:

- **iPhone, mounted, plugged in, unlocked, Safari.** Opened while parked, so
  startup needn't be hands-free; an occasional single tap while driving is fine.
- **Full lessons** that commit to history and advance the curriculum as usual,
  usually *mixed* — partly spoken, partly typed.
- **Browser-native speech only** (`speechSynthesis`, `webkitSpeechRecognition`):
  no cloud TTS/STT vendor, key or per-lesson cost. The one paid extra is a Haiku
  call per spoken answer (see Cleanup), on the same Claude login as the tutor.
- **Single user, diagnostics deliberately over-built.** Anything can be stripped
  later; a feature that silently breaks over many drives can't be un-broken.

## Modules

Rule-bound logic is pure and testable; browser APIs are confined to one file.

| File | Purity | Job |
|---|---|---|
| `web/src/lesson/audio/text.ts` | pure | markdown + LaTeX → speakable text; the streaming chunker |
| `web/src/lesson/audio/endpoint.ts` | pure | the endpointer: when has J finished answering |
| `web/src/lesson/audio/drive-state.ts` | pure | the turn-taking state machine: events, reconcile, recogniser/synth callbacks and taps in → actions out |
| `web/src/lesson/audio/diag.ts` | pure | client diagnostics: ring buffer, counters, soft invariants |
| `web/src/lesson/audio/adapter.ts` | impure | the **only** file touching `speechSynthesis`, `SpeechRecognition`, `wakeLock`, `AudioContext`, `navigator.audioSession` |
| `web/src/lesson/audio/panel.ts` | impure | the overlay, debug strip, pre-drive check output |
| `web/src/lesson/audio/controller.ts` | impure | glue: machine ↔ adapter ↔ overlay ↔ diag ↔ lesson screen; timers, storage, uploads, the cleanup call |
| `web/src/lesson/send.ts` | — | one learner turn, shared by the composer and drive mode |
| `server/cleanup.ts` | — | spoken-answer cleanup (Haiku, kept warm) |
| `server/diag.ts` | — | server diagnostics sink |

The four pure modules import only each other (with `.js` specifiers) and are
listed in the root `tsconfig.json` `include`, like `web/src/lesson/reconcile.ts`,
so `tests/` can reach them (see Traps). `drive-state.ts` declares the slice of
`LessonEvent` it consumes structurally and reports through `diag` *actions*, so
its invariants are assertable in `tests/audio.test.ts`.

Audio state hangs on `LessonCtx` as one opaque field, `audio: AudioController | null`.

## Turn-taking

**Half-duplex.** Recognition is stopped while speaking. The mic opens only when
**the utterance queue has drained *and* `turn_done` has arrived** for the latest
turn — draining alone isn't enough: a turn with web tools emits "Let me check
that.", then a 5–100s tool call, then more text. Barge-in is a tap, not voice.
(Recognition heard nothing of the tutor through the phone speaker in one test,
so full-duplex looks feasible — unverified.)

Drive mode **starts assuming a turn is running** and lets the server's health
answer open the mic: guessing "idle" opened the mic mid-kickoff in the first
browser run.

The **listening cue fires on `audiostart`**, not `start()`: a cold start took
3.65s, and words spoken before `audiostart` are lost.

### Endpointing

`SpeechRecognition` ends its own session after ~1–2s of silence, so `end` means
"the recogniser gave up", not "J finished". The adapter restarts it and the
endpointer keeps accumulating into one answer. Our clocks:

| Situation | Rule |
|---|---|
| Nothing heard yet | **Wait indefinitely.** An empty buffer never submits — thinking time is free, which is what makes recall warm-ups work unchanged. |
| J has spoken, then gone quiet | Submit after **4s** with no new interim or final — **7s** when the last word can't end a sentence ("the", "to", "which"…). |
| Answer running long | From **3 minutes**, submit at the next **1.5s** pause; **hard at 4 minutes** (speech that never pauses — a radio). |
| **Done** tap | Submit now. A no-op on an empty buffer. |

The silence clock follows **interims, not finals** (finals land 1.2–2.1s after J
stops). On submit, if the newest words exist only as an interim, the recogniser
is stopped and its final awaited for up to 1s. An interim left dangling when a
session ends is promoted to a final, or the next session's first interim would
overwrite it.

History: 2.5s flat cut off two of four answers on the first run (J thinks aloud
with pauses up to ~2.7s); a 90s hard cap cut one off mid-sentence in the first
commuting week. **J would rather wait than feel rushed.**

### Adapter rules (each learned the hard way)

- **Always stop before starting; never `start()` a running recogniser.** The
  spike did, and threw `InvalidStateError` ~100 times a run. An explicit
  `starting | running | stopping | stopped` state guards it.
- **One `SpeechRecognition`, ever** — constructing another plays the system chime.
- Reset the "started at" timestamp per session, or `audiostart` latency measures
  from an earlier session (the spike logged a fictitious 50,596ms stall).
- `no-speech` and `aborted` are the **normal** end path with `continuous = false`
  (iOS reports silence as `aborted` / "No speech detected"). `network` and
  `audio-capture` back off (1, 2, 5, 10, 30s).
- **A final can arrive after `stop()`** — logged as `late-final`, never fed into
  the next answer.
- **Recogniser watchdog:** iOS can stop `onresult` with neither `onerror` nor
  `onend`. No event for 30s while listening (8s while starting) → abort, restart,
  say "The mic stalled. Listening again.", keeping any half-said answer.
- **No auto-resume after an interruption.** Hidden → hard PAUSED, one tap to
  resume. A phone call breaks the gesture chain; auto-resuming yields a silent car.

## Speaking

- **Chunks at paragraph / 2–3-sentence granularity**, one utterance at a time off
  `onend`, with a timeout of 2× the estimated length + 5s. More `speak()` calls
  means more chances to hit iOS's stalled queue.
- **The chunker only cuts at safe boundaries** of streaming markdown, and is
  message-scoped: each `assistant` event flushes its own residual (never
  `ev.text`, which would repeat it) and inserts a boundary. Every `delta` carries
  its message id, so reconcile can resume a half-spoken message from its offset.
- Keep a **strong reference** to the speaking utterance (iOS can GC it before
  `onend`) and stamp each with a **generation**: `cancel()` can fire
  `onend`/`onerror` for the cancelled one, which must not advance the queue.
- **The first `speak()` must run synchronously inside a tap** — anything after an
  `await` is silently dropped by iOS. The select screen's Start and the
  headphones button both say "Starting." in the handler itself.
- **Voice: Samantha (en-US), outright.** The automatic "best voice" pick landed on
  Eloquence novelty voices twice (Reed, then Flo), so there's no automatic
  option; `defaultVoice` falls back to scoring only when Samantha is missing. A
  voice + speed picker is in the debug strip, remembered per device
  (`tutor.voice.v2`).
- **Cues are Web Audio tones** (the CSP blocks `data:` audio): a lead-in before
  speech after ≥1.5s of quiet (the waking route clips the first ~100–300ms), a
  turn-start tone, and "still working" every 20s of a turn in flight. With tones
  off, "Okay." / "Still working." are spoken; the listening cue is then silent.
  iOS suspends an idle `AudioContext` ~8s after its last sound, so a tone resumes
  it first (≤500ms) and speech waits for the tone.

### What gets said

`text.ts` turns markdown into speech: tables, display math, code fences, mermaid
and images become "there's a table here, it's in the app"; inline math gets a
light verbaliser (Greek by name, `x_t` → "x sub t", `x^2` → "x squared",
`\frac{a}{b}` → "a over b"); ordered lists read "One," / "Two,"; link text without
the URL; currency ("$5 to $10" → "5 dollars to 10 dollars"). Abbreviations are
left to the voice, but the sentence splitter never breaks on them. Nothing spoken
may contain a markdown sigil — the diag log flags any that does.

## Controls

**One full-screen, state-dependent tap target**, with a small **Again** and
**✕ Exit drive mode** in the corners:

| Phase | Tap means |
|---|---|
| SPEAKING | skip — drops everything received so far this turn (messages arriving *later* in the turn are still spoken, so a closing question isn't lost) |
| LISTENING | done — submit now |
| THINKING | speak a status line ("Still working, about 40 seconds so far.") |
| PAUSED | resume |
| STUCK | retry (kick the runner) |

Taps are ignored for 400ms after any phase change (a skip landing as the phase
flips must not become a half-answer submit).

- **Again** replays all tutor text since J's last turn (not the last `assistant`
  event — one turn emits several around web tools). It reads the transcript when
  drive mode starts, so it works when drive mode came on mid-lesson; from PAUSED
  it also resumes. Local replay, no model turn.
- **There is no End in the overlay.** On the first run End was tapped twice, then
  ✕ — they read as the same thing. Ending is a text-mode action; a drive ends with
  Exit and the lesson stays in progress.
- **Listen** on the select screen (per device) starts lessons — and opens
  In-progress / Needs-attention lessons — in drive mode, so the opening is spoken.
- The overlay is always dark (glare). The **debug strip** (collapsed) holds the
  build id, wake-lock dot, voice/speed/tones, the playback-mode toggle, the
  pre-drive check and the live diag tail.
- Errors are **spoken**: `closed`, `api_error`, `error`, `rate_limit`
  (rejected/warning, once per change). Everything else is silent and logged.

## Telling the model it's a spoken turn

The system prompt is built once per session and never rebuilt, so the channel
rides on each turn: **`via: "typed" | "spoken"`** on the message, create
(kickoff) and end routes becomes a `modelText` prefix the transcript never shows.
The tag carries the rule, adjacent to the content it governs:

`[spoken turn — transcribed from speech; reply in spoken form: no markdown, no LaTeX, no URLs read aloud]`

A typed turn is tagged only right after a spoken one; the mode holds until the
next tag. The spoken rules live in `server/prompt.ts` (not the shared teaching
contract — the CLI consumer can never be audio): write for the ear; announce
the shape of long blocks and recap at the seams; math as intuition, derivations
parked into `nextUp`; never read a URL; questions answerable out loud; J's turns
are speech recognition, so never grade a transcription artifact.

## Cleanup — what J actually said

Before a spoken answer is sent, `POST /api/lesson/:id/clean` asks Haiku for its
best guess at the exact words, using the tutor's last message as context
("tension" → "attention", "wait them" → "weight them", "but" → "BERT"). The
bubble, transcript and tutor get the cleaned text; the raw recognition is kept
as `heard` on the transcript entry and follows the text for the tutor only, in
brackets, so a wrong guess is recoverable.

- **Latency 0.7–2.8s** (median ~1.5s) — achieved by keeping one CLI subprocess
  warm (`startup()`; warmed at drive start via `/clean/warm`, replaced after each
  use, closed after 15 idle minutes) and **thinking off**. Cold, it was ~5s of
  spawn plus 36s of Haiku *thinking* on a seven-word answer.
- Read the iterator by hand: leaving a `for await` calls `return()`, which waits
  out the subprocess's shutdown (~3s).
- **Never costs the turn:** a timeout (10s server, 15s client), error, empty
  reply, or a "repair" whose word count drifts past max(4, 25%) — an answer or a
  summary, not a transcription — sends the raw text.

## Recording that a lesson was spoken

A lesson is usually mixed, so counts, not a flag: `spokenTurns` / `typedTurns`
on the usage ledger's `LedgerMeta`, `via` on each `UsageRecord` (exact spoken vs
typed cost per turn), a header line and `### J (spoken)` markers in the archived
transcript, threaded through the lesson index to the viewer. Not in `core/` — a
lesson-record field there is invisible to the model (see Traps).

## Resilience

The car is on cellular, through the tailnet, to a PC at home — the stream will
drop. Network loss is the most likely way this fails, not an edge case.

- **Reconcile feeds audio.** SSE has no replay; `reconcile()` hands missed
  entries to the machine, which speaks each unspoken one once and resumes a
  half-spoken one from its offset. `GET /api/lesson/:id` returns `turnInFlight`
  so a lost `turn_done` is recovered.
- **Real heartbeat events** every 15s (SSE comments are invisible to
  `EventSource`); 60s without any server event → "Lost the connection.
  Reconnecting." A `CLOSED` `EventSource` is recreated with backoff.
- **Reply watchdog:** no progress for 120s → ask `/health` first (never blindly
  re-POST — that duplicates the answer). Alive but silent → auto-kick once
  (`/kick` revives the runner and sends a hidden nudge, not the turn again — the
  stuck session had already recorded it); a second stall → STUCK, tap to retry.
- **A failed send is verified** before "That answer didn't reach the tutor": the
  POST's response can be lost after the server stored the answer.
- **Reload-on-resume:** `{lessonId}` is kept in localStorage while drive mode is
  on; a reload reopens that lesson in drive mode, PAUSED, waiting for the tap
  that re-unlocks audio.
- `ending` is sticky until commit; idle sessions expire after 7 days (lessons
  span 22–51 hours of wall clock); session writes are atomic.

## Diagnostics

J's standing instruction: **build in far too many, strip later.** One seam per
side (`diag.ts` in the client, `server/diag.ts`); stripping means making them
no-ops. **Soft invariants** log and count, never throw. Audibly, the app speaks
only when it's *acting* on a problem.

- **Sink:** client batches go to `POST /api/diag/:sessionId` every 15s and on
  hide / `pagehide` (`sendBeacon`), mirrored in localStorage until acknowledged
  (~2MB cap). The server appends client and server records to
  `<data root>/.app/diag/<sessionId>.jsonl` (25MB cap; never in git).
- **Client records:** every recogniser event with latencies; per utterance the
  markdown slice, spoken text, estimated vs actual duration, and the audio
  session and `AudioContext` state at its start; endpointer decision traces
  (which clock fired, timings); taps; SSE open/error/reconcile; wake lock,
  visibility, navigation type; voice choice and why; cleanup result and time;
  audio-session switches.
- **Invariants:** never `start()` while speaking or recognising; never submit
  during a turn or an empty buffer; never speak a sigil.
- **Server records:** runner start/revive/close, SSE connect/disconnect, every
  dispatched event with its listener count (0 = lost to a gap), turn timing
  (send → first delta → result), full `rate_limit_info`, cleanup, kicks, ending.
- **Pre-drive check** (debug strip, run parked): Safari, HTTPS, recognition,
  voices, wake lock, server health, heartbeat, current build, a tone then speech
  at equal volume, and a mic round trip — spoken and listed.

## What the phone actually does

Measured on J's iPhone (iOS 18.7, Safari 18.7.5) in the car — a small sample;
the diagnostics widen it.

- **Recognition works in Safari only.** Chrome/Firefox/Edge on iOS expose
  `webkitSpeechRecognition` but fail at once with `not-allowed`.
- **Restart gap ~110ms once warm; a cold start 1.4–3.6s** to `audiostart`. The
  first start in a lesson sometimes fails ~1s in with `audio-capture` ("Source is
  muted") and retries fine.
- **Sessions end on their own after 4–79s** (median ~12.6s). Finals arrive
  1.2–2.1s after the last interim. Spoken numbers come back as digits
  ("one, two, three" → `123`).
- **Transcription at highway speed through the phone's speaker and mic is
  excellent**; road noise was not a problem. Mistakes are jargon and homophones —
  hence Cleanup.
- **Speech volume.** `audioSession.type = "play-and-record"` made the speaker
  quieter and switched the car's Bluetooth source. Left on `"auto"`, speech came
  out quieter on some drives and not others. Setting **`"playback"` while
  speaking and `"auto"` before the mic** (a setting, on by default) gave steady
  volume on the first drives with it, and the `AudioContext` stopped suspending.
  `audioSession.state` reads null on iOS 18.7.
- **Bluetooth:** any open Bluetooth mic forces the call (HFP) profile — "phone
  mode" — and a web page can't choose the built-in mic instead. With playback
  mode the tutor's voice can use media audio; the car still switches while J
  answers. **The phone speaker remains the default.**
- **Latency:** the tutor's first word arrives a median ~14s after an answer
  (p90 ~25s); turns with web tools run to ~100s.
- Wake lock acquires and holds; `speechSynthesis` reports 223 voices at load.

**Not yet measured:** standalone-PWA mode (recognition is reported to fail
there), navigation prompts interrupting speech, Low Power Mode and the wake lock.

## Traps

- **Tests importing `web/src/` drag those files into the root `NodeNext`
  program**, which lacks `vite-env.d.ts`; it breaks on anything touching
  `markdown.ts` (katex CSS) or `__DEMO__`. `npm test` won't catch it — only
  `npm run typecheck` does. Keep the pure audio modules import-free beyond each
  other.
- **Never set `navigator.audioSession.type` to `"play-and-record"`** (above).
- **`web/src/markdown.ts`'s `extractMath` eats currency** — "$50 to $100" loses
  everything between the dollar signs. `text.ts` has its own handling and a
  currency test.
- **Never trigger speech from bubble rendering:** `showLesson` renders the whole
  history through `addBubble`. Speech is fed from SSE events plus the reconcile
  feed.
- **Don't reintroduce index-based reconciliation** (`renderedIds` +
  `pendingSends`, `web/src/lesson/reconcile.ts`) — a count drifts on a second
  device and re-speaks the last reply on every wake.
- **A reconnecting `EventSource` doesn't revive a wound-down runner, and a POST
  doesn't replace a hung one** (`runnerFor` returns any non-closed runner) —
  hence health + kick.
- **`condenseEntry` keeps three whitelisted lines of each past lesson**, so a new
  lesson-record field in `core/` is invisible to the model.
- **One logical turn emits several `assistant` events** around web tools.
- **`web/src/demo/replay.ts` implements `Api` and builds `Status`**: a new
  required field or method breaks the GitHub Pages build.
- **The pending send must hold exactly the trimmed text the server stores**, or
  `adoptLocalSend` won't match the echo; a cleaned answer's echo is matched by
  its cleaned text.
- **CSP** (`server/index.ts`): `script-src 'self'`, `connect-src 'self'`, no
  `data:` audio. **Secure context required** — use the tailnet HTTPS URL.
- **The service worker serves pages network-first** (`tests/sw.test.ts`); check
  the build id in the debug strip before trusting a test on the phone.
- **Prompt caching is automatic** through the Agent SDK; read `cacheRead` /
  `cacheCreation` when reasoning about the cost of many short spoken turns.

## Decisions log

J's calls, in order, with the evidence behind them.

- **Overlay** (2026-10-06): big state word + hint; heard words in large text;
  Again / Exit corners; collapsed debug strip; a headphones toggle beside "+";
  Listen on the select screen; tones for cues.
- **Typed turns tagged only right after a spoken one.** A kick sends a hidden
  nudge, not the turn again (the model saw it twice). "Still working" at 20s.
- **First iPhone run** (2026-10-09): End dropped from the overlay; silence clocks
  4s / 7s mid-sentence; Samantha with tones on by default.
- **First commuting week** (2026-10-09/10, Lessons 29–31): cleanup with raw
  attached; Again from the transcript; Samantha outright; soft 3-minute cap; the
  heard text bottom-anchored (oldest lines fade off the top); playback mode as a
  default-on experiment; tones wait for a suspended context.
- **With those changes** (2026-10-13, Lesson 32; J: "it worked better"): playback
  mode held on every utterance, cleanup never fell back, two answers ran past the
  old cap. Profile bullet removals now match across line wraps (Lessons 29 and
  32 had commits rejected 2–3 times on it); a failed send is verified first.

## Open items

- **How the curriculum viewer shows spoken turns.** The counts reach
  `CurriculumUnitLesson`; nothing renders them yet.
- **A math-heavy warning on the select screen** when Listen is on — how to judge
  "math-heavy" (the lane, or math density in past transcripts) is undecided.
- **Offline tools never built:** `drive-report` (summarise a session's diag log)
  and `speech-audit` (run `text.ts` over every archived tutor message).
- **Cost per lesson** — `via` on usage records makes spoken vs typed cost exact;
  worth a look once there are more drives.
- **Wrap-up by voice** is out of drive mode by design; revisit if it gets
  annoying.
- **Full-duplex barge-in** looks feasible but is unverified.
