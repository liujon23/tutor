# tutor

A self-hosted AI tutoring app with a split brain: **deterministic code does all
the bookkeeping** — curriculum progression, topic selection, prior knowledge, validation,
write-back — so **the AI only does what the AI is needed for: personalized and adaptive teaching.**

**[▶ Try the demo](https://liujon23.github.io/tutor/)** — a real lesson from the
author's art-history course, replayed in the actual app. 

<!-- demo GIF goes here once captured from the live Pages deploy -->

## The one idea: rigid scaffolding, fluid teaching

Most AI-tutor setups drift: the model half-remembers what you know, re-asks
settled questions, and loses the thread between sessions. Here the model never
keeps the books. Before each lesson, code assembles a *session packet*:
everything the tutor needs to know, computed deterministically. After each lesson,
the tutor hands back one structured *session patch*, which code validates,
applies, and commits. The lesson in between is freeform teaching.

**Every lesson is one git commit.** Your entire learning history is a readable git log. 
The tutor's only write path is the validated post-lesson patch — it can never quietly 
corrupt your curriculum. 

The system also *learns how you learn*: lessons accumulate observations about
what works for you, and a gated flow (the tutor proposes, you approve) promotes
them into confirmed patterns that shape future lessons.

## The app

A PWA served by a small Fastify + Claude Agent SDK server on your own machine —
install it on your phone and study from anywhere on your
[Tailscale](https://tailscale.com/) network, on **your own Claude subscription**
(a token from `claude setup-token`, or a metered API key).

- **Streaming lessons** with rendered LaTeX, syntax-highlighted code, embedded
  artwork and diagrams — built for all kinds of subjects.
- **Photo attachments** — send handwritten work for the tutor to read and grade honestly.
- **Per-message feedback**: long-press any tutor message to rate it. Strong negative ratings
course-correct the tutor mid-lesson; everything else is distilled at wrap-up into durable
observations about how you learn. The tutor is learning your habits directly from your participation as well.
- **Spaced recall**: previously-covered topics are occasionally quizzed lightly (if you want) to help
train your recall muscle.
- **Session sizes** (tight / standard / deep) and per-lesson model choice, with
  a live switch if you hit your subscription's rate window.
- **Stats screen**: token/cost trends, per-lane progress, feedback history.
- **Wrap-up receipts**: every lesson ends with what was committed, what it cost,
  and what's queued next.

## Course Design

The `course-setup` skill designs a course with you, in
conversation. It'll ask for your goals with the course, conduct a sweep 
of what you already know so lessons don't re-teach
it, then you'll co-design a unit/topic skeleton with curated information sources. It runs in
[Claude Code](https://claude.com/claude-code) (open this folder and say *"I want
to start learning X"*) — course authoring is a structural conversation, so it
lives next to the code rather than in the app. 

## Quickstart

```bash
git clone https://github.com/liujon23/tutor && cd tutor
npm run setup          # install + build, with sanity checks
claude setup-token     # prints a token — put it in .env (cp .env.example .env)
npm run serve          # open http://127.0.0.1:4321
```

The repo ships with three example courses — how modern LLMs work,
Science & Technology Studies, and modern art history — so your first lesson
works out of the box in your web browser. For keeping your data in its own
repo, setting up your own courses, and accessing the tutor from your phone:
**[SETUP.md](SETUP.md)**. 


## Docs

- **[SETUP.md](SETUP.md)** — first-time setup, phone access, where your data lives
- **[APP.md](APP.md)** — the full ops reference: auth, usage tracking, env knobs
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — how the code fits together, with a
  guided reading order
- **[CLI.md](CLI.md)** — running lessons in the terminal instead, and the
  deterministic script toolbox (validation, exports, usage reports)

## License

[MIT](LICENSE)
