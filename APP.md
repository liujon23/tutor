# The app — setup & operations

Lessons from any device (PC, phone, tablet) in a proper UI — rendered markdown and
LaTeX, tap-to-select topics, streaming chat — on your own Claude subscription, with
all bookkeeping done by the deterministic core.

> **New here? Start with SETUP.md** — a guided, no-CLI-experience-needed first-time
> setup (`npm run setup`, then your phone). This file is the fuller ops reference.

```
server/    Fastify backend: /api/* + serves the PWA (one origin, no CORS)
web/       Vite PWA: select / lesson / wrap-up screens (vanilla TS + marked + KaTeX
           + DOMPurify + mermaid)
.app/      per-lesson session files + image cache, under your data root (gitignored
           — the git commit is the record; archived images live in transcripts/assets/)
```

## One-time setup (on the PC that hosts it)

1. **Auth** — mint a subscription token and put it in the server's environment:

   ```bash
   claude setup-token          # prints CLAUDE_CODE_OAUTH_TOKEN
   cp .env.example .env        # paste the token there (or export it in your shell)
   ```

   The token is a key to the whole subscription: it lives only on this PC — never in
   the frontend, never in this repo. Fallback order if policy changes: set
   `ANTHROPIC_API_KEY` instead (metered), or fall back to Claude Code interactive
   lessons (CLI lessons still work unchanged — see CLI.md).

2. **Verify the SDK path** before the first lesson:

   ```bash
   npm run echo-test                    # hello-world on the default model (opus)
   npm run echo-test -- --model sonnet  # then the model toggle
   ```

3. **Build the frontend & start the server:**

   ```bash
   npm run build:web
   npm run serve        # binds 127.0.0.1:4321 (TUTOR_PORT / TUTOR_HOST to change)
   ```

4. **Expose over the tailnet** (nothing public; Tailscale terminates TLS):

   ```bash
   tailscale serve --bg 4321
   ```

   Then open `https://<pc-name>.<tailnet>.ts.net/` on the phone/iPad and use the
   browser's "Add to Home Screen" — the PWA manifest makes it install like an app.

5. **Keep it running** — leave the server process up (e.g. the `restart-tutor`
   launcher window). The server is stateless apart from `.app/` session files, so
   restarts are safe: an in-flight lesson resumes via the SDK session id on the
   next message.

## Daily flow

Open the app → the select screen shows each lane's queued topic and carried plan
(zero tokens spent until you commit). Pick lane or a specific topic, size
(tight/standard/deep), model (Opus default; Sonnet toggle — picking "tight"
preselects Sonnet, still freely switchable) — or "Discuss it instead" to move
selection into the chat. Recall warm-up chips appear once comfortable topics
go stale (14 days; `TUTOR_STALE_DAYS` to tune).

The lesson is a streaming chat with rendered math and code — plus
embedded images (fetched through the server's validating proxy and cached under
`.app/assets/`), mermaid diagrams (rendered when a message finalizes), and photo
attachments: the + button sends a downscaled photo (handwritten work, textbook
pages) for the tutor to read. Web search/fetch is on by default so the tutor
verifies sources instead of citing from memory (`TUTOR_WEB_TOOLS=0` to disable).
At commit time, embedded and inbound images are copied to
`transcripts/assets/lesson-NNN/` and ride the same git commit as the transcript.

The app now shows an "update available" toast whenever the server is running a
newer build than the one the PWA has cached — no more reopen-twice ritual to pick
up a fix.

### Curriculum viewer and transcripts

**Curriculum** in the header opens a track as a whole. Pick a lane and its units
lay out as a flowchart, arranged from their `prerequisites` — so a branching lane
reads as a branching graph rather than a list. Solid arrows are prerequisites;
dashed ones are `bridgeTopics`, the softer "leans on this" links, which can point
either forward or back. Each block carries its state, when it was completed, how
many core topics are comfortable, and a short summary of what the unit covers.
Below ~640px the graph becomes one column and the arrows turn into "after: …"
labels, since a DAG at phone width is unreadable.

Tapping a block expands it in place: core topics with their state and when each
was last touched, optional topics in a dimmer group, cross-lane connections, and
every lesson taught in that unit. Tapping a lesson opens its **transcript**, fully
rendered with math, code and the artwork the lesson embedded. A topic's
last-touched lesson is a link too, which matters when a topic was last exercised
as a recall warm-up inside *another* lane's lesson.

Two things render as plain text rather than links, on purpose: lessons from before
the transcript archive existed (they show "no transcript archived"), and a unit
summary whose unit has since been restructured (marked "outdated" until you re-run
`npm run unit-summaries`).

This whole screen is read-only and spends no tokens. The summaries are the one
generated ingredient, and they're written ahead of time by an explicit CLI — see
`unit-summaries` in CLI.md.

### Per-message feedback

Long-press (phone) or right-click (PC) any tutor message to rate it: strong/normal
thumbs up or down (⏫ 👍 👎 ⏬), always with a short written explanation. The control
is hidden until you invoke it, and not rating a message means nothing — the tutor is
told to read no signal into silence, ever.

Ratings are siloed from the tutor until the lesson ends, with one exception: a
**double thumbs-down** immediately posts a visible flag under the message and the
tutor course-corrects on its next turn (it won't cut off a reply mid-stream). Rated
messages carry a small badge; tap the message again (same gesture) to change or
remove a rating, up until the lesson commits.

At wrap-up the tutor receives everything at once, distills each rating into a
one-line context + takeaway, and commits those to **`transcripts/feedback.jsonl`**
(one line per rating, with lesson metadata) — the raw ratings themselves stay in the
ephemeral session file. The commit is refused until every rating is covered, so
feedback can't be silently dropped even if you end the lesson by just typing "let's
stop here". Archived transcripts mark only double-thumbs-down flags (so the tutor's
visible course-corrections still make sense when re-read); other ratings leave no
trace there. Over time the tutor turns recurring feedback into "Preference guess:"
bullets in your profile's Working notes — promoted into "How I learn best" only
through the usual Approve/Reject gate — and the post-lesson questioning gets lighter
as the per-message signal does the work.

"End lesson" asks the
tutor to recap and wrap up; it then validates and applies the session patch through
the same core patcher as the CLI and git-commits it. Proposed confirmed-pattern
changes show up in the wrap-up panel with Approve/Reject buttons — nothing touches
"How I learn best" without your explicit yes.

Abandoning a lesson (or letting it idle >24h) writes nothing back — no partial
entries.

## Usage tracking

Every lesson records what it cost to run. As each turn completes, the server
captures the SDK's per-turn usage — input/output/cache tokens, the equivalent
dollar cost, turn duration, the model used, which tools fired (web search/fetch,
commit), and whether a photo was attached — and rolls it up at commit time. It
lands in three places, all from one source:

- **The wrap-up panel** shows a "This lesson used" summary: total tokens (with
  the in/out/cache split), the equivalent cost, wall-clock duration, and a
  feature line (turns, web searches, photos, model split).
- **The committed transcript header** carries a one-line `Usage:` digest, so
  `git grep Usage: transcripts/` gives a quick history.
- **`transcripts/usage.jsonl`** — an append-only ledger, one JSON line per
  lesson, holding both the roll-up *and* every per-turn record with its tags.
  This is the substrate for the long game: average time per lesson, cost trends,
  and which features (a chatty web-search habit, image-heavy lessons, Opus vs.
  Sonnet) are the expensive ones and worth optimizing.

> **On the dollar figures:** on a Claude subscription you are **not** billed per
> token — the cost is the SDK's *computed equivalent* at API rates. It's a
> yardstick for comparing lessons and features, not money leaving your account.
> The real limit is the subscription's shared rate-limit window (the app
> still banners when you approach it). Tokens are the ground truth; the `$` is a
> convenience.

> **On the elapsed time:** wall-clock is a *rough* proxy for effort, not a
> reliable usage metric — it counts any stretch you stepped away or changed
> focus mid-lesson, so a lesson can read as "long" without using any more of the
> subscription. Still worth knowing; just don't treat it as spend.

One small gap by design: the final wrap-up turn commits *before* its own result
message arrives, so that last turn's tokens aren't counted — a tiny, consistent
undercount.

### The analysis report

```
npm run usage-report            # readable text report
npm run usage-report -- --json  # the raw analysis object, for piping
```

Reads the whole ledger and prints: overall totals and per-lesson averages; a
by-lesson timeline; breakdowns **by lane, by size, and by model**; and a
**by-feature** table that contrasts turns which used web search / web fetch /
photos against those that didn't — the read on which features are the expensive
ones (attribution by association, since the SDK bills per turn, not per tool).

The same analysis is also in the app itself, as the **Stats** screen (reachable
from a small "Stats" link in the select screen's header) — `GET /api/report`
(`server/report.ts`) adds a packet-size trend (first-turn cache tokens per
lesson, to see whether the packet is growing) and per-lane curriculum progress
and feedback totals on top of the same `analyzeUsage()` used by the CLI.

## Env knobs

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | subscription auth (preferred) |
| `TUTOR_DATA_DIR` | repo root | where data/, transcripts/, .app/ live (see SETUP.md) |
| `ANTHROPIC_API_KEY` | — | metered fallback |
| `TUTOR_PORT` / `TUTOR_HOST` | `4321` / `127.0.0.1` | bind address |
| `TUTOR_STALE_DAYS` | `14` | recall-candidate threshold |
| `TUTOR_WEB_TOOLS` | on | `0` disables the WebSearch/WebFetch tools (kill switch) |
| `TUTOR_GIT_PUSH` | off | `1` pushes after every lesson commit (non-blocking, best-effort) |
| `TUTOR_LOG_LEVEL` | `info` | Fastify log level |

### Off-site durability (`TUTOR_GIT_PUSH=1`)

Every lesson commit fires a background `git push` — the commit never waits on it or
fails because of it; push failures are only logged. Prerequisites on the host PC: a
configured remote on the data repo and non-interactive auth (an SSH
key or a credential helper — the push must not prompt). Both the app and the CLI
scripts funnel through the same commit helper, so both get pushed.

## Boundaries (by design)

- The lesson model has **no file tools** — its only write path is the
  `commit_session` tool, which runs the same `checkPatch`/`applySessionPatch` as the
  CLI. Rejected patches are returned to the model to fix; nothing is written on error.
- **course-setup stays in Claude Code**; the app is lesson-only.
- No visitor mode on the live server — your token never serves anyone else. (The
  public demo is a static replay with no server and no token at all.)
- Rate limits: lessons share your subscription's rate window with your other Claude use. The
  app shows a gentle banner if a lesson hits the limit, with a one-tap switch to
  Sonnet.
- The CLI scripts (CLI.md) remain the offline/manual escape hatch — the app and the
  CLI write through the identical core.
