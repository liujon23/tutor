// The commit_session SDK tool — the model's only write path to the learner's data.
// Validation errors go back as the tool result so the model can fix and retry;
// a successful apply is a git commit, and any proposedConfirmedPatterns are
// surfaced to the learner via the app (never applied here — they hold the gate).
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { SessionPatch } from "../core/types.js";
import { applySessionPatch, checkPatch } from "../core/patcher.js";
import { appendFeedbackLedger, checkFeedbackCoverage, composeFeedbackHandoff } from "./feedback.js";
import { DATA_PATHS, gitCommit } from "../scripts/lib.js";
import { fmtDuration, writeTranscript, type CommitTimings } from "./transcript.js";
import { appendUsageLedger, formatInt, formatUsd, summarizeUsage, totalTokens } from "./usage.js";
import { saveSession } from "./store.js";
import type { CommitResult, StoredSession } from "./types.js";

export interface TutorToolContext {
  /** The live session record — read at call time so the commit guard sees fresh state. */
  session: () => StoredSession;
  onCommitted: (result: CommitResult) => void;
  /** Wall-clock ms (epoch) of the learner's last message before the commit — anchors the
   *  "compose" timing: how long the model took to build the patch (spanning any
   *  rejection/retry cycles, since those are model-driven, not new user turns). */
  composeStartedAt: () => number;
}

// Serialize the whole read-modify-write-commit path. Even single-user, a
// stray second lesson or a racing CLI run could otherwise interleave writes to
// the three data files and `git add`. Cheap insurance; the app is not hot.
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

const lessonShape = z.object({
  date: z.string(),
  laneId: z.string(),
  unitId: z.string(),
  topicIds: z.array(z.string()),
  topicsFreeform: z.string().optional(),
  whatHappened: z.string(),
  performanceSketch: z.string(),
  sourcesUsed: z.string(),
  feedbackCaptured: z.string(),
  askedAbout: z.string(),
});

// The distilled per-message feedback log — app-only, never seen by the core
// patcher. One entry per rated message; the commit guard enforces coverage.
const feedbackEntryShape = z.object({
  messageId: z.string(),
  level: z.union([z.literal(2), z.literal(1), z.literal(-1), z.literal(-2)]),
  context: z.string(),
  takeaway: z.string(),
});

// Curriculum/profile sub-objects are validated for real by checkPatch — the zod
// schema only needs to let well-formed JSON through with the right top-level shape.
const patchSchema = {
  patch: z
    .object({
      lesson: lessonShape,
      curriculum: z.looseObject({}).optional(),
      profile: z.looseObject({}).optional(),
      project: z.looseObject({}).optional(),
      feedback: z.object({ entries: z.array(feedbackEntryShape) }).optional(),
    })
    .describe("The complete session patch, per the schema in your system prompt"),
};

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/**
 * The commit_session tool definition, factored out of `createTutorServer` so
 * its handler can be invoked directly in tests (bypassing the MCP transport)
 * without changing `createTutorServer`'s return contract, which `runner.ts`
 * depends on. Tests should only rely on early-exit branches (e.g. the
 * ALREADY-COMMITTED guard) that don't reach `DATA_PATHS` — the rest of the
 * handler writes to the real `data/` directory and creates git commits.
 */
export function createCommitSessionTool(ctx: TutorToolContext) {
  return tool(
    "commit_session",
    "Validate and apply the end-of-lesson session patch to the learner's documents " +
      "(curriculum, lesson history, profile) and git-commit the result. Call this " +
      "exactly once at wrap-up. On validation errors, fix the patch and call again.",
    patchSchema,
    async ({ patch }) =>
      serialize(async () => {
        // Idempotency guard: a lesson commits exactly once. A retry after a
        // success the model half-saw, or a stray call after the learner keeps
        // chatting, would otherwise duplicate the history entry and re-stamp
        // lastTouched.
        const already = ctx.session().commit;
        if (already) {
          return textResult(
            `ALREADY COMMITTED as Lesson ${already.lessonNumber} — nothing written. ` +
              `This lesson's patch is already recorded; do not commit again. If the learner ` +
              `wants changes, they can edit the files directly or start a follow-up lesson.`,
            true
          );
        }

        // Compose = the learner's "go ahead" → this call: the model building the
        // patch, the dominant and most variable cost. Measured before any step below.
        const composeMs = Date.now() - ctx.composeStartedAt();

        // Feedback guard: the learner's per-message ratings must be fully distilled into
        // patch.feedback.entries — this also covers lessons ended by typing
        // "let's stop here" (where the /end hand-off never fired). Like any
        // validation error, the model fixes the patch and retries.
        const tValidate = Date.now(); // validating patch
        const feedbackEntries = patch.feedback?.entries ?? [];
        const coverageError = checkFeedbackCoverage(ctx.session(), feedbackEntries);
        if (coverageError) {
          const handoff = composeFeedbackHandoff(ctx.session());
          return textResult(
            `PATCH REJECTED — nothing written. ${coverageError}.\n` +
              `For reference, the learner's ratings:\n${handoff}\n` +
              `Add the missing distilled entries and call commit_session again.`,
            true
          );
        }

        const sessionPatch = patch as SessionPatch;
        const errors = checkPatch(DATA_PATHS, sessionPatch);
        if (errors.length) {
          return textResult(
            "PATCH REJECTED — nothing written. Fix these and call commit_session again:\n" +
              errors.map((e) => `  - ${e}`).join("\n"),
            true
          );
        }

        const validateMs = Date.now() - tValidate;

        const tWrite = Date.now(); // writing curriculum, history, profile
        const res = applySessionPatch(DATA_PATHS, sessionPatch);
        const writeMs = Date.now() - tWrite;

        // Idempotency guard becomes durable HERE: curriculum/history/profile
        // are already written to disk, so persist a provisional commit record
        // right away — before any of the steps below (ledgers, transcript,
        // git), which can still fail. Once this is saved, a retry (or a
        // post-crash revival) hits the ALREADY-COMMITTED guard above and can
        // never re-apply the patch, no matter what happens next.
        const provisional: CommitResult = {
          lessonNumber: res.lessonNumber,
          summary: res.summary,
          proposedConfirmedPatterns: res.proposedConfirmedPatterns,
          gitMessage: "",
          committedAt: new Date().toISOString(),
        };
        const liveSession = ctx.session();
        liveSession.commit = provisional;
        saveSession(liveSession);

        // Tracked outside the try so a failure partway through can still
        // report whichever of these actually completed.
        let ledgerPath: string | null = null;
        let feedbackPath: string | null = null;
        let transcriptPath: string | null = null;
        let gitMessage = "";

        try {
          const tArchive = Date.now(); // archiving logs (usage + feedback ledgers)
          // Roll up resource use. The wrap-up turn's own tokens land after this
          // tool returns, so they're a small known undercount — the record here
          // covers everything through the moment the learner ended the lesson.
          const session = ctx.session();
          const records = session.usage ?? [];
          const wallClockMs = Date.parse(session.lastActivityAt) - Date.parse(session.createdAt);
          const usage = summarizeUsage(records, wallClockMs);
          ledgerPath = records.length
            ? appendUsageLedger(
                {
                  lessonNumber: res.lessonNumber,
                  date: sessionPatch.lesson.date,
                  laneId: sessionPatch.lesson.laneId,
                  unitId: sessionPatch.lesson.unitId,
                  topicIds: sessionPatch.lesson.topicIds,
                  size: session.params.size,
                  committedAt: new Date().toISOString(),
                },
                usage,
                records
              )
            : null;

          // The distilled per-message feedback — one ledger line per rating.
          feedbackPath = feedbackEntries.length
            ? appendFeedbackLedger(
                {
                  lessonNumber: res.lessonNumber,
                  date: sessionPatch.lesson.date,
                  laneId: sessionPatch.lesson.laneId,
                  unitId: sessionPatch.lesson.unitId,
                  topicIds: sessionPatch.lesson.topicIds,
                  committedAt: new Date().toISOString(),
                },
                feedbackEntries
              )
            : null;

          const archiveMs = Date.now() - tArchive;

          // The transcript carries the timing block — it can account for every
          // phase up to itself; its own write and the git commit that seals it
          // are reported below (a step can't time its own output file).
          const timings: CommitTimings = { composeMs, validateMs, writeMs, archiveMs };
          const tTranscript = Date.now();
          transcriptPath = writeTranscript(
            session,
            sessionPatch,
            res.lessonNumber,
            records.length ? usage : undefined,
            timings
          );
          const transcriptMs = Date.now() - tTranscript;

          const tGit = Date.now(); // git commit — never throws
          gitMessage = gitCommit(
            `Lesson ${res.lessonNumber} — ${sessionPatch.lesson.date} — ${sessionPatch.lesson.topicIds.join(", ")}`,
            ["data", "transcripts"]
          );
          const gitMs = Date.now() - tGit;
          const totalMs = composeMs + validateMs + writeMs + archiveMs + transcriptMs + gitMs;
          const timingLine =
            `timing: compose ${fmtDuration(composeMs)} · validate ${fmtDuration(validateMs)} · ` +
            `write ${fmtDuration(writeMs)} · archive ${fmtDuration(archiveMs)} · ` +
            `transcript ${fmtDuration(transcriptMs)} · git ${fmtDuration(gitMs)} · ` +
            `total ${fmtDuration(totalMs)}`;
          const usageSummaryLine = records.length
            ? `usage: ${formatInt(totalTokens(usage.tokens))} tokens · ≈ ${formatUsd(usage.costUsd)} API-equiv`
            : "usage: not recorded";
          const result: CommitResult = {
            lessonNumber: res.lessonNumber,
            summary: [
              ...res.summary,
              `transcript archived: ${transcriptPath}`,
              ...(ledgerPath ? [`usage logged: ${ledgerPath}`] : []),
              ...(feedbackPath
                ? [`feedback logged: ${feedbackEntries.length} rating(s) → ${feedbackPath}`]
                : []),
              usageSummaryLine,
              timingLine,
            ],
            proposedConfirmedPatterns: res.proposedConfirmedPatterns,
            gitMessage,
            committedAt: new Date().toISOString(),
            ...(records.length ? { usage } : {}),
          };
          ctx.onCommitted(result);

          const proposalNote = result.proposedConfirmedPatterns.length
            ? `\nProposed confirmed-pattern changes were NOT applied — the app is showing ` +
              `them to the learner with Approve/Reject buttons. Mention this in your close-out.`
            : "";
          return textResult(
            `Session committed as Lesson ${res.lessonNumber}.\n` +
              result.summary.map((s) => `  - ${s}`).join("\n") +
              `\n${gitMessage}${proposalNote}`
          );
        } catch (e) {
          // Data files (curriculum/history/profile) and the provisional
          // commit record are already safely written — only an ancillary
          // post-commit step (usage/feedback ledger, transcript archive, or
          // git commit) failed. Close the loop with a NON-error result so the
          // model doesn't retry commit_session (which would just hit the
          // ALREADY-COMMITTED guard, but a clean close-out beats the model
          // treating this as a failed call and fumbling for a fix).
          const message = (e as Error).message;
          const warning =
            `WARNING: a post-commit step failed (${message}) — data files and the commit ` +
            `record are safe; do NOT call commit_session again.`;
          const finalResult: CommitResult = {
            lessonNumber: res.lessonNumber,
            summary: [
              ...res.summary,
              ...(transcriptPath ? [`transcript archived: ${transcriptPath}`] : []),
              ...(ledgerPath ? [`usage logged: ${ledgerPath}`] : []),
              ...(feedbackPath
                ? [`feedback logged: ${feedbackEntries.length} rating(s) → ${feedbackPath}`]
                : []),
              ...(gitMessage ? [gitMessage] : []),
              warning,
            ],
            proposedConfirmedPatterns: res.proposedConfirmedPatterns,
            gitMessage,
            committedAt: provisional.committedAt,
          };
          ctx.onCommitted(finalResult);
          return textResult(
            `Session committed as Lesson ${res.lessonNumber}, but a post-commit step failed.\n` +
              finalResult.summary.map((s) => `  - ${s}`).join("\n")
          );
        }
      })
  );
}

export function createTutorServer(ctx: TutorToolContext) {
  const commitSession = createCommitSessionTool(ctx);
  return createSdkMcpServer({ name: "tutor", version: "1.0.0", tools: [commitSession] });
}

export const COMMIT_TOOL_NAME = "mcp__tutor__commit_session";
