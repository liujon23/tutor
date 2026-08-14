# Your learning data

This folder is **yours** — the tutor's memory. The code that reads and writes it
lives in the tutor checkout next door; nothing in here is executable.

- `data/curriculum.yaml` — your courses: lanes, units, topics, and their state
- `data/profile.md` — who you are as a learner, and the patterns you've confirmed
- `data/lesson-history.md` — one entry per lesson, newest last
- `transcripts/` — the full text of each lesson, plus the usage and feedback ledgers

It starts as a copy of the tutor's three example courses (how modern LLMs work,
Science & Technology Studies, modern art history) so your first lesson works
immediately. Replace them with your own subjects whenever you like — open the
tutor's folder in Claude Code and say *"I want to start learning X"*.

## Version history (optional, recommended)

If this folder is a git repository, **every lesson is one commit**: your whole
learning history becomes a readable log, and a bad write-back can be undone with
`git revert`. Turn that on any time from the tutor checkout:

```bash
npm run init-data
```

Nothing is committed on your behalf — your next lesson becomes the first commit.
To keep an off-site backup, add a **private** remote yourself and set
`TUTOR_GIT_PUSH=1` in the tutor's `.env`; each lesson commit then pushes in the
background.
