# Chat edition (Free-plan spike)

An experiment: can the tutor run inside a claude.ai **Project** on the Free plan,
with no Claude Code and no server? Lessons happen in the Project's chat; two
claude.ai Skills carry the instructions; the bookkeeping is the same deterministic
core as the app, bundled into one script that Claude runs in the chat's sandbox.

**Status: untested on a real Free account.** It's ready for the test in
`START-HERE.md`, and nothing else is built until that comes back.

| File | What it is |
|---|---|
| `kit.ts` | The CLI (`start` / `commit` / `validate`) around `core/`, with a flat-file adapter for Project files. Bundled to `tutor-kit.mjs`. |
| `skills/tutor-lesson/` | The lesson skill: `.claude/skills/daily-lesson` adapted to the chat medium, plus a hand-applied fallback. |
| `skills/tutor-probe/` | The feasibility probe: Node, file visibility, the kit end to end, and a save-back test. |
| `project-instructions.md` | Text for the Project's instructions box. |
| `START-HERE.md` | The tester's step-by-step. |

Build everything to hand over (`exports/chat-edition/`, gitignored):

```bash
npm run build:chat-kit
```

Send the tester the whole `exports/chat-edition/` folder. The teaching contract and
document formats are copied in from `.claude/skills/references/` at build time, so
edit them there.
