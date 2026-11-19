# Drive mode — two-way spoken lessons

Drive mode turns the lesson screen into a hands-free, spoken lesson for a
~30-minute car commute: the tutor talks, J answers out loud, it adapts. It is a
**rendering mode of the existing lesson screen**, not a separate one, so a
lesson moves freely between voice and text — start it in the car, finish it at
a desk — with no second session.

This is the reference: how it works and the rule behind each choice, each with
the observation that led to it. Using it is in [APP.md](../APP.md#drive-mode).
Numbers come from J's iPhone (iOS 18.7, Safari 18.7.5) and the diagnostics
through Lesson 50; `npm run drive-report` recomputes them.

## Constraints

- **iPhone, mounted, plugged in, unlocked, Safari.** Opened while parked, so
  startup needn't be hands-free; an occasional single tap while driving is fine.
- **Full lessons** that commit and advance the curriculum as usual, usually
  mixed — partly spoken, partly typed.
- **Browser-native speech only** (`speechSynthesis`, `webkitSpeechRecognition`):
  no cloud speech vendor, key or per-lesson cost. The one paid extra is a Haiku
  call per spoken answer (Cleanup), on the same Claude login as the tutor.
- **Single user, diagnostics deliberately over-built.** A feature that silently
  breaks over many drives can't be un-broken; a log line costs nothing.

## Modules

Rules are pure and tested; browser APIs are confined to one file.

| File | Job |
|---|---|
| `web/src/lesson/audio/text.ts` | pure — markdown + LaTeX → speakable text; the streaming chunker |
| `web/src/lesson/audio/endpoint.ts` | pure — when J has finished answering |
| `web/src/lesson/audio/drive-state.ts` | pure — the turn-taking state machine: events, reconcile, recogniser and speech callbacks and taps in → actions out |
| `web/src/lesson/audio/diag.ts` | pure — client diagnostics: ring buffer, counters, batches |
| `web/src/lesson/audio/adapter.ts` | the **only** file touching `speechSynthesis`, `SpeechRecognition`, `wakeLock`, `AudioContext`, `navigator.audioSession` |
| `web/src/lesson/audio/panel.ts` | the overlay, debug strip, pre-drive check output |
| `web/src/lesson/audio/controller.ts` | glue: machine ↔ adapter ↔ overlay ↔ diag ↔ lesson screen; timers, storage, uploads |
| `web/src/lesson/send.ts` | one learner turn, shared by the composer and drive mode |
| `server/cleanup.ts` | spoken-answer cleanup (Haiku, kept warm) |
| `server/diag.ts`, `server/drive-report.ts` | the diagnostics sink and its report |

The four pure modules import only each other and are listed in the root
`tsconfig.json` `include` so `tests/audio.test.ts` can reach them (see Traps).
Audio state hangs on `LessonCtx` as one field, `audio: AudioController | null`.

## Turn-taking

**Half-duplex.** Recognition is stopped while speaking. The mic opens only when
the utterance queue has drained **and** `turn_done` has arrived: a turn with web
tools says "Let me check that.", runs a tool for up to a minute, then says more.
Barge-in is a tap, not voice.

- Drive mode **starts assuming a turn is running** and lets the server's health
  answer open the mic. Guessing "idle" opened the mic mid-kickoff.
- The **listening cue fires on `audiostart`**, not `start()`: a cold start took
  3.6s, and words spoken before `audiostart` are lost.

### Endpointing

`SpeechRecognition` ends its own session after a few seconds (median ~9s, up to
~50s), so `end` means "the recogniser gave up", not "J finished". The adapter
restarts it and the endpointer keeps accumulating one answer.

| Situation | Rule |
|---|---|
| Nothing heard yet | **Wait indefinitely.** Thinking time is free, which is what makes recall warm-ups work unchanged. |
| J has spoken, then gone quiet | Submit after **4s** with no new interim or final — **7s** when the last word can't end a sentence ("the", "to", "which"…). |
| Answer running long | From **3 minutes**, submit at the next **1.5s** pause; **hard at 4 minutes** (speech that never pauses — a radio). |
| **Done** tap | Submit now. A no-op on an empty buffer. |

- The silence clock follows **interims, not finals**: finals land 1.2–2.1s after
  J stops.
- On submit, if the newest words exist only as an interim, the recogniser is
  stopped and its final awaited for up to 1s. An interim left dangling when a
  session ends is promoted to a final, or the next session's first interim
  would overwrite it.
- The clocks are long on purpose. 2.5s cut off two of four answers on the first
  run (J thinks aloud, with pauses up to ~2.7s) and a 90s cap cut one off
  mid-sentence: **J would rather wait than feel rushed.** In use, 87% of answers
  end on the silence clock and 13% on a Done tap; the median answer runs 40s.

### Adapter rules

- **Always stop before starting; never `start()` a running recogniser** (it
  throws `InvalidStateError`). An explicit `starting | running | stopping |
  stopped` state guards it.
- **One `SpeechRecognition`, ever** — constructing another plays the system chime.
- Reset the "started at" timestamp per session, or `audiostart` latency measures
  from an earlier session.
- `no-speech` and `aborted` are the **normal** end path with `continuous = false`
  (iOS reports silence as `aborted` / "No speech detected"). `network` and
  `audio-capture` back off (1, 2, 5, 10, 30s); the first start in a lesson
  sometimes fails with `audio-capture` ("Source is muted") and retries fine.
- **A final can arrive after `stop()`** — logged as `late-final`, never fed into
  the next answer.
- **Recogniser watchdog:** iOS can stop `onresult` with neither `onerror` nor
  `onend`. No event for 30s while listening (8s while starting) → abort and
  restart. A running recogniser that has heard nothing is restarted without a
  word: it can't be told from J thinking, and half the early firings were that.
  A mic that never opened also says "The mic stalled. Listening again."
- **No auto-resume after an interruption.** Hidden → PAUSED, one tap to resume:
  a phone call breaks the gesture chain, and auto-resuming yields a silent car.
- **Never start recognition while speech is playing** — the machine's own *or*
  untracked speech (the select screen's "Starting.", spoken cues). Safari then
  refuses the mic ~1.2s in without showing its prompt (`not-allowed`, "User
  permission check has failed") and keeps refusing for the life of the page.
  `startRecognizer` waits for `speechSynthesis` to go quiet (up to 5s).
- **A refused mic offers Reload.** Only a fresh page makes Safari ask again, so
  `not-allowed` puts the overlay in MIC BLOCKED with a Reload button; the reload
  comes back paused via the pending-drive record. A browser that can't
  recognise speech at all (Chrome, Firefox and Edge on iOS expose the API and
  fail at once) pauses with the needs-Safari line.

## Speaking

- **Chunks at paragraph / 2–3-sentence granularity**, one utterance at a time off
  `onend`, with a timeout of 2× the estimated length + 5s (actual length runs a
  median 88% of the estimate). More `speak()` calls means more chances to hit
  iOS's stalled queue.
- **The chunker only cuts at safe boundaries** of streaming markdown and is
  message-scoped: each `assistant` event flushes its own residual (never
  `ev.text`, which would repeat it). Every `delta` carries its message id, so
  reconcile can resume a half-spoken message from its offset.
- Keep a **strong reference** to the speaking utterance (iOS can collect it
  before `onend`) and stamp each with a **generation**: `cancel()` can fire
  `onend`/`onerror` for the cancelled one, which must not advance the queue.
- **The first `speak()` must run synchronously inside a tap** — iOS silently
  drops anything after an `await`. The select screen's Start and the headphones
  button both say "Starting." in the handler itself.
- **Voice: Samantha (en-US), outright.** The automatic "best voice" pick landed
  on novelty voices twice, so there is no automatic option; `defaultVoice` falls
  back to scoring only when Samantha is missing. Voice and speed are in the
  debug strip, remembered per device.
- **Cues are Web Audio tones** (the CSP blocks `data:` audio): a lead-in before
  speech after ≥1.5s of quiet (the waking audio route clips the first
  ~100–300ms), a turn-start tone, and "still working" every 20s of a turn in
  flight. With tones off, "Okay." / "Still working." are spoken and the
  listening cue is silent. iOS suspends an idle `AudioContext` ~8s after its
  last sound, so a tone resumes it first (≤500ms) and speech waits for the tone.
- **The audio session type is never set.** `"play-and-record"` made the
  speaker quieter and switched the car's Bluetooth source. `"playback"` while
  speaking (a setting, on by default until November 2026) made speech silent
  on iOS 27: the utterances ran to time and tones still played, but nothing
  was heard, and starting speech interrupted the page's `AudioContext` on 13
  of 41 lines (1 in 1,145 before). It had been added because speech sometimes
  came out quieter on `"auto"`; if that returns, it is the known trade-off.
- **The phone speaker is the default.** Any open Bluetooth mic forces the
  call (HFP) profile, and a web page can't choose the built-in mic instead.

### What gets said

`text.ts` turns markdown into speech: tables, display math, code fences, mermaid
and images become "there's a table here, it's in the app"; inline math gets a
light verbaliser (Greek by name, `x_t` → "x sub t", `x^2` → "x squared",
`\frac{a}{b}` → "a over b"); ordered lists read "One," / "Two,"; link text
without the URL; currency ("$5 to $10" → "5 dollars to 10 dollars").
Abbreviations are left to the voice, but the sentence splitter never breaks on
them. Nothing spoken may contain a markdown sigil — the diag log flags any that
does.

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

- Taps are ignored for 400ms after any phase change, so a skip landing as the
  phase flips can't become a half-answer submit.
- **Again** replays all tutor text since J's last turn (one turn emits several
  `assistant` events around web tools). It reads the transcript when drive mode
  starts, so it works when drive mode came on mid-lesson; from PAUSED it also
  resumes. Local replay, no model turn.
- **There is no End in the overlay**: on the first run End and ✕ read as the
  same thing. Ending is a text-mode action; a drive ends with Exit and the
  lesson stays in progress.
- **Listen** on the select screen (per device) starts lessons — and opens
  in-progress ones — in drive mode, so the opening is spoken.
- The overlay is always dark (glare). The **debug strip** (collapsed) holds the
  build id, wake-lock dot, voice/speed/tones, the
  pre-drive check and the live diag tail.
- Errors are **spoken**: `closed`, `api_error`, `error`, `rate_limit` (once per
  change). Everything else is silent and logged.

## Telling the model it's a spoken turn

The system prompt is built once per session, so the channel rides on each turn:
`via: "typed" | "spoken"` on the message, create and end routes becomes a
`modelText` prefix the transcript never shows:

`[spoken turn — transcribed from speech; reply in spoken form: no markdown, no LaTeX, no URLs read aloud]`

A typed turn is tagged only right after a spoken one; the mode holds until the
next tag. The spoken rules live in `server/prompt.ts`, not the shared teaching
contract (the CLI can never be audio): write for the ear; announce the shape of
long blocks and recap at the seams; math as intuition, derivations parked into
`nextUp`; never read a URL; questions answerable out loud; J's turns are speech
recognition, so never grade a transcription artifact.

## Cleanup — what J actually said

Recognition at highway speed through the phone's own mic is good; its mistakes
are jargon and homophones ("tension" for "attention", "but" for "BERT"). Before
a spoken answer is sent, `POST /api/lesson/:id/clean` asks Haiku for its best
guess at the exact words, with the tutor's last message as context. The bubble,
transcript and tutor get the cleaned text; the raw recognition is kept as
`heard` on the transcript entry and follows the text for the tutor, in
brackets, so a wrong guess is recoverable.

- **Median 1.4s, never over 4s** — by keeping one CLI subprocess warm (spawned
  at drive start, replaced after each use, closed after 15 idle minutes) and
  **thinking off**. Cold, it was ~5s of spawn plus 36s of Haiku thinking on a
  seven-word answer.
- Read the iterator by hand: leaving a `for await` calls `return()`, which waits
  out the subprocess's shutdown (~3s).
- **Never costs the turn:** a timeout (10s server, 15s client), an error, an
  empty reply, or a "repair" whose word count drifts past max(4, 25%) sends the
  raw text. A failed request's error text is never taken for a reply — on one
  auth failure only the word count stood between it and the transcript.

## Recording that a lesson was spoken

A lesson is usually mixed, so counts, not a flag: `spokenTurns` / `typedTurns`
on the usage ledger, `via` on each usage record, a header line and
`### J (spoken)` markers in the archived transcript, threaded through the lesson
index to the viewer. Not in `core/` — a lesson-record field there is invisible
to the model (see Traps).

## Resilience

The car is on cellular, through the tailnet, to a PC at home: the stream will
drop. 9% of events are sent while no client is listening.

- **Reconcile feeds audio.** SSE has no replay; `reconcile()` hands missed
  entries to the machine, which speaks each unspoken one once and resumes a
  half-spoken one from its offset. `GET /api/lesson/:id` returns `turnInFlight`
  so a lost `turn_done` is recovered.
- **Real heartbeat events** every 15s (SSE comments are invisible to
  `EventSource`); 60s without any server event → "Lost the connection.
  Reconnecting." A `CLOSED` `EventSource` is recreated with backoff.
- **An answer that isn't echoed reopens the stream.** 10s after a submit with no
  `user` event back, the `EventSource` is recreated without a word: the stream
  can die before the answer is sent, and the reply then waits out the 60s clock.
- **Reply watchdog:** no progress for 120s → ask `/health` first (never blindly
  re-POST — that duplicates the answer). Alive but silent → auto-kick once
  (`/kick` revives the runner and sends a hidden nudge, not the turn again: the
  stuck session had already recorded it); a second stall → STUCK, tap to retry.
- **A failed send is verified** before "That answer didn't reach the tutor": the
  POST's response can be lost after the server stored the answer.
- **Reload-on-resume:** `{lessonId}` is kept in localStorage while drive mode is
  on; a reload reopens that lesson in drive mode, PAUSED, waiting for the tap
  that re-unlocks audio.
- `ending` is sticky until commit; idle sessions expire after 7 days (lessons
  run over several days of wall clock); session writes are atomic.

## Latency and cost

- **The tutor's first word comes a median ~24s after an answer is submitted**
  (p90 ~45s), on top of the 4s silence clock: ~2.4s cleanup and send, ~15s to
  the model's first text, ~2.5s to speech. About 1,000 of a spoken reply's
  ~1,360 output tokens are thinking. Lower effort for spoken turns would
  shorten it at some cost to teaching; J's call is to leave it.
- Turns with web tools take a median 54s; the commit turn ~2 minutes.
- **The prompt cache lasts an hour.** A turn more than an hour after the last
  re-writes the whole prompt (7% of turns, ~20% of spend): a lesson spread over
  days pays for it each time it's picked up.
- **The tool list must not change after a runner's first call**, or the next
  call re-writes the cache while it is still warm. Two things hold it still:
  `strictMcpConfig` (only the `tutor` server — on the Claude Code login, an
  account connector that finished connecting after the first call added eight
  tools and cost ~$0.45 at every start and revival), and the runner holding its
  first message until `tutor` is connected and nothing is pending.
  `sdk-init-unexpected` in the log means the list has something it shouldn't.
  In the ledger, turn 1's `cacheRead` should be about turn 0's `cacheCreation`.

## Diagnostics

One seam per side (`diag.ts` in the client, `server/diag.ts`); stripping them
means making them no-ops. **Soft invariants** log and count, never throw.
Audibly, the app speaks only when it's *acting* on a problem.

- **Reading it:** `npm run drive-report` (one session by id prefix, `--since`,
  or all): broken rules, anomalies, the wait for a reply split into its parts,
  cache misses, events lost to a stream gap and recovered.
- **Sink:** client batches go to `POST /api/diag/:sessionId` every 15s and on
  hide / `pagehide` (`sendBeacon`), mirrored in localStorage until acknowledged
  (~2MB cap). The server appends client and server records to
  `<data root>/.app/diag/<sessionId>.jsonl` (25MB cap; never in git).
- **Client records:** every recogniser event with latencies (an interim result
  as its length and last 40 characters — in full they were half the log); per
  utterance the markdown slice, spoken text, estimated vs actual duration and
  the audio state at its start; endpointer decision traces; taps; SSE
  open/error/reconcile; wake lock, visibility, navigation type; voice choice;
  cleanup result and time.
- **Invariants:** never `start()` while speaking or recognising; never submit
  during a turn or an empty buffer; never speak a sigil.
- **Server records:** runner start/revive/close, the tool list and MCP state at
  SDK init, the wait for the `tutor` tool server (`mcp-ready`), SSE
  connect/disconnect, every dispatched event with its listener count (0 = lost
  to a gap), turn timing (send → first delta → result), `rate_limit_info`,
  cleanup, kicks, ending.
- **Pre-drive check** (debug strip, run parked): Safari, HTTPS, recognition,
  voices, wake lock, server health, heartbeat, current build, a tone then speech
  at equal volume, and a mic round trip — spoken and listed.

## Traps

- **Tests importing `web/src/` drag those files into the root `NodeNext`
  program**, which lacks `vite-env.d.ts`; it breaks on anything touching
  `markdown.ts` (katex CSS) or `__DEMO__`. `npm test` won't catch it — only
  `npm run typecheck` does. Keep the pure audio modules import-free beyond each
  other.
- **`web/src/markdown.ts`'s `extractMath` eats currency** — "$50 to $100" loses
  everything between the dollar signs. `text.ts` has its own handling and a test.
- **Never trigger speech from bubble rendering:** `showLesson` renders the whole
  history through `addBubble`. Speech is fed from SSE events plus the reconcile
  feed.
- **Don't reintroduce index-based reconciliation** (`web/src/lesson/reconcile.ts`
  keys on ids): a count drifts on a second device and re-speaks the last reply
  on every wake.
- **A reconnecting `EventSource` doesn't revive a wound-down runner, and a POST
  doesn't replace a hung one** (`runnerFor` returns any non-closed runner) —
  hence health + kick.
- **`condenseEntry` keeps three whitelisted lines of each past lesson**, so a new
  lesson-record field in `core/` is invisible to the model.
- **`web/src/demo/replay.ts` implements `Api` and builds `Status`**: a new
  required field or method breaks the GitHub Pages build.
- **The pending send must hold exactly the trimmed text the server stores**, or
  `adoptLocalSend` won't match the echo; a cleaned answer's echo is matched by
  its cleaned text.
- **CSP** (`server/index.ts`): `script-src 'self'`, `connect-src 'self'`, no
  `data:` audio. **Secure context required** — use the tailnet HTTPS URL.
- **The service worker serves pages network-first** (`tests/sw.test.ts`); check
  the build id in the debug strip before trusting a test on the phone.
- **A cache miss under an hour after the previous turn is a broken prefix**, not
  an expired cache — something before the messages changed (see Latency and
  cost).

## Open items

- **How the curriculum viewer shows spoken turns.** The counts reach
  `CurriculumUnitLesson`; nothing renders them yet.
- **A math-heavy warning on the select screen** when Listen is on — how to judge
  "math-heavy" is undecided.
- **`speech-audit`** (run `text.ts` over every archived tutor message) was never
  built.
- **Backgrounding mid-turn.** 23 of 37 hides came while waiting for a reply
  (median 8s), each needing a tap to resume. By design; revisit if it grates.
- **Not yet measured:** standalone-PWA mode (recognition is reported to fail
  there), navigation prompts interrupting speech, Low Power Mode and the wake
  lock.
- **Wrap-up by voice** is out of drive mode by design. **Full-duplex barge-in**
  looks feasible (recognition heard nothing of the tutor through the phone
  speaker in one test) but is unverified.
