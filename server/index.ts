// The app server: serves the PWA and the lesson API on one origin.
// Runs on the host PC, reached over the tailnet (Tailscale serve terminates TLS).
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { applyProfilePatch } from "../core/profile.js";
import { DEFAULT_SPACING } from "../core/spacing.js";
import type { SpacingConfig } from "../core/types.js";
import { DATA_PATHS, PATHS, ROOT, gitCommit, todayLocal } from "../scripts/lib.js";
import { registerAssetRoutes } from "./assets.js";
import { composeFeedbackHandoff, messageSnippet, validateFeedbackInput } from "./feedback.js";
import { buildLessonSystemPrompt, kickoffMessage } from "./prompt.js";
import { defaultModel, readBuildId } from "./params.js";
import { buildReport } from "./report.js";
import { LessonManager } from "./runner.js";
import { buildStatus, laneExists } from "./status.js";
import { newSessionId, saveSession } from "./store.js";
import { INBOUND_MEDIA_TYPES } from "./types.js";
import type {
  InboundImage,
  InboundMediaType,
  LessonEvent,
  LessonParams,
  MessageFeedback,
  RatingLevel,
  StoredSession,
} from "./types.js";

const PORT = Number(process.env.TUTOR_PORT ?? 4321);
const HOST = process.env.TUTOR_HOST ?? "127.0.0.1";
// Recall spacing: TUTOR_STALE_DAYS is the interval at streak 0, widened by
// TUTOR_RECALL_GROWTH on every clean recall. One config, passed to every caller —
// the constants themselves live in core/spacing.ts.
const SPACING: SpacingConfig = {
  ...DEFAULT_SPACING,
  baseDays: Number(process.env.TUTOR_STALE_DAYS ?? DEFAULT_SPACING.baseDays),
  growth: Number(process.env.TUTOR_RECALL_GROWTH ?? DEFAULT_SPACING.growth),
};
const WEB_DIST = join(ROOT, "web", "dist");

const manager = new LessonManager();
const app = Fastify({ logger: { level: process.env.TUTOR_LOG_LEVEL ?? "info" } });

// --- Static PWA -------------------------------------------------------------

if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST, prefix: "/" });
} else {
  app.get("/", async () => ({
    error: "web/dist not found — run `npm run build:web` first",
  }));
}

// Archived transcripts (read-only) — keeps archived lesson images viewable
// and lets recall prompts re-show them after .app/ is gone.
const TRANSCRIPTS_DIR = PATHS.transcriptsDir;
mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
await app.register(fastifyStatic, {
  root: TRANSCRIPTS_DIR,
  prefix: "/transcripts/",
  decorateReply: false,
});

// --- Asset proxy --------------------------------------------------------------

registerAssetRoutes(app);

// --- Selection screen -------------------------------------------------------

app.get("/api/status", async () => buildStatus(SPACING));

// Usage + curriculum progress + feedback trends — the in-app Stats screen
// (also available as `npm run usage-report` on the CLI).
app.get("/api/report", async () => buildReport());

// Build-id check for the PWA's "update available" toast — read fresh each
// request since dist/ can change under a running server after a rebuild.
app.get("/api/version", async () => ({ buildId: readBuildId(WEB_DIST) }));

// --- Lesson lifecycle -------------------------------------------------------

interface CreateLessonBody {
  laneId?: string;
  topicOverride?: string;
  discuss?: boolean;
  recallRequested?: string[];
  size?: "tight" | "standard" | "deep";
  model?: "opus" | "sonnet";
  historyN?: number;
}

app.post<{ Body: CreateLessonBody }>("/api/lesson", async (req, reply) => {
  const b = req.body ?? {};
  const size = b.size ?? "standard";
  const params: LessonParams = {
    laneId: b.laneId,
    topicOverride: b.topicOverride,
    discuss: b.discuss ?? false,
    recallRequested: b.recallRequested,
    size,
    model: defaultModel(size, b.model),
    historyN: b.historyN ?? 3,
    spacing: SPACING,
  };
  if (params.laneId && !laneExists(params.laneId)) {
    return reply.code(400).send({ error: `lane '${params.laneId}' not found` });
  }

  let prompt;
  try {
    prompt = buildLessonSystemPrompt(params);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }

  const now = new Date().toISOString();
  const session: StoredSession = {
    id: newSessionId(),
    createdAt: now,
    lastActivityAt: now,
    status: "active",
    params,
    title: prompt.title,
    systemPrompt: prompt.systemPrompt,
    sdkSessionId: null,
    transcript: [],
    commit: null,
  };
  manager.start(session, kickoffMessage(params));
  return { sessionId: session.id, title: session.title };
});

app.get<{ Params: { id: string } }>("/api/lesson/:id", async (req, reply) => {
  const session = manager.sessionFor(req.params.id);
  if (!session) return reply.code(404).send({ error: "no such lesson" });
  const { systemPrompt: _omit, ...rest } = session;
  return {
    ...rest,
    transcript: session.transcript.filter((t) => !t.hidden),
  };
});

const MAX_IMAGES_PER_MESSAGE = 4;

app.post<{
  Params: { id: string };
  Body: { text?: string; images?: { media_type?: string; data?: string }[] };
}>(
  "/api/lesson/:id/message",
  // Base64 photos are bulky — Fastify's default 1 MiB body limit won't do.
  { bodyLimit: 20 * 1024 * 1024 },
  async (req, reply) => {
    const text = (req.body?.text ?? "").trim();
    const rawImages = req.body?.images ?? [];
    if (!text && rawImages.length === 0) return reply.code(400).send({ error: "empty message" });
    if (rawImages.length > MAX_IMAGES_PER_MESSAGE) {
      return reply.code(400).send({ error: `at most ${MAX_IMAGES_PER_MESSAGE} images per message` });
    }
    const images: InboundImage[] = [];
    for (const img of rawImages) {
      if (
        !INBOUND_MEDIA_TYPES.includes(img.media_type as InboundMediaType) ||
        typeof img.data !== "string" ||
        !/^[A-Za-z0-9+/=]+$/.test(img.data)
      ) {
        return reply.code(400).send({ error: "malformed image attachment" });
      }
      images.push({ media_type: img.media_type as InboundMediaType, data: img.data });
    }
    try {
      manager.runnerFor(req.params.id).send(text, false, images);
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
    // The learner chatting on means they're no longer just trying to wrap up.
    // (sessionFor AFTER runnerFor: mutate the live runner's record, not a copy.)
    const session = manager.sessionFor(req.params.id);
    if (session?.ending && !session.commit) {
      session.ending = false;
      saveSession(session);
    }
    return { ok: true };
  }
);

// "End lesson" — request the wrap-up AND mark the lesson as ending, so an
// uncommitted lesson shows up as "needs attention" instead of vanishing at expiry.
// Any siloed per-message feedback rides along as model-only text: the model
// sees it, the transcript keeps just the short human message.
app.post<{ Params: { id: string } }>("/api/lesson/:id/end", async (req, reply) => {
  if (!manager.sessionFor(req.params.id)) return reply.code(404).send({ error: "no such lesson" });
  let runner;
  try {
    runner = manager.runnerFor(req.params.id);
  } catch (e) {
    return reply.code(409).send({ error: (e as Error).message });
  }
  // Re-fetch AFTER runnerFor so we mutate the (possibly just-revived) runner's
  // live record — a stale copy would clobber its transcript writes.
  const session = manager.sessionFor(req.params.id)!;
  if (session.commit) return { ok: true, alreadyCommitted: true };
  session.ending = true;
  saveSession(session);
  const endText =
    "Let's wrap up. Work through these in order, and do NOT call commit_session until " +
    "every earlier step is done:\n" +
    "1. Give me a brief recap of the lesson.\n" +
    "2. Ask if I have any last questions before we end — and answer them.\n" +
    "3. Read all my ratings below and distill each one. If a rating is unclear, or a " +
    "preference guess is ready to promote to a confirmed pattern, ask me now — one short " +
    "question at a time. If I approve a promotion, fold it into approvedConfirmedPatterns " +
    "in the single commit (don't also list it under proposedConfirmedPatterns).\n" +
    "4. Only once this wrap-up conversation is done, build the patch and call " +
    "commit_session exactly once.";
  const handoff = composeFeedbackHandoff(session);
  runner.send(endText, false, [], handoff ? `${endText}\n\n${handoff}` : undefined);
  return { ok: true };
});

// --- Per-message feedback ----------------------------------------------------
// The learner rates individual tutor messages (⏫/👍/👎/⏬ + a required note). Ratings are
// siloed from the model until wrap-up — except a double thumbs-down, which
// fires a visible flag and a queued course-correct turn. Not rating a message
// carries no signal, so nothing here ever fires on absence.

app.post<{
  Params: { id: string };
  Body: { messageId?: string; level?: number; note?: string };
}>("/api/lesson/:id/feedback", async (req, reply) => {
  let session = manager.sessionFor(req.params.id);
  if (!session) return reply.code(404).send({ error: "no such lesson" });
  const err = validateFeedbackInput(req.body ?? {}, session);
  if (err) {
    const code = session.status !== "active" || session.commit ? 409 : 400;
    return reply.code(code).send({ error: err });
  }
  const messageId = req.body!.messageId as string;
  const level = req.body!.level as RatingLevel;
  const note = (req.body!.note as string).trim();

  // A -2 needs a live runner for the course-correct nudge — revive it BEFORE
  // mutating, then re-fetch so the upsert lands on the runner's live record.
  // Other levels never touch the runner: pure silo, no SDK revival.
  let runner: ReturnType<typeof manager.runnerFor> | null = null;
  if (level === -2) {
    try {
      runner = manager.runnerFor(req.params.id);
      session = manager.sessionFor(req.params.id)!;
    } catch {
      runner = null; // rating still saves; only the live nudge is lost
    }
  }

  const items = (session.feedback ??= []);
  const existing = items.find((f) => f.messageId === messageId);
  // The live flag fires only on a *transition into* -2 — editing the note of
  // an existing -2 must not re-flag, and a fired flag survives a downgrade.
  const firesFlag = level === -2 && existing?.level !== -2 && runner !== null;
  const item: MessageFeedback = {
    messageId,
    level,
    note,
    at: new Date().toISOString(),
    ...(existing?.flagged || firesFlag ? { flagged: true } : {}),
  };
  if (existing) items.splice(items.indexOf(existing), 1, item);
  else items.push(item);
  saveSession(session);

  if (firesFlag) {
    const rated = session.transcript.find((t) => t.id === messageId);
    runner!.flagDoubleDown(messageId, messageSnippet(rated?.text ?? "", 120), note);
  }
  return { ok: true, flagged: firesFlag };
});

app.delete<{ Params: { id: string; messageId: string } }>(
  "/api/lesson/:id/feedback/:messageId",
  async (req, reply) => {
    const session = manager.sessionFor(req.params.id);
    if (!session) return reply.code(404).send({ error: "no such lesson" });
    if (session.commit) return reply.code(409).send({ error: "lesson is already committed" });
    const items = session.feedback ?? [];
    const idx = items.findIndex((f) => f.messageId === req.params.messageId);
    if (idx === -1) return reply.code(404).send({ error: "no rating on that message" });
    items.splice(idx, 1);
    saveSession(session);
    return { ok: true };
  }
);

app.post<{ Params: { id: string }; Body: { model?: "opus" | "sonnet" } }>(
  "/api/lesson/:id/model",
  async (req, reply) => {
    const model = req.body?.model;
    if (model !== "opus" && model !== "sonnet") {
      return reply.code(400).send({ error: "model must be 'opus' or 'sonnet'" });
    }
    if (!manager.sessionFor(req.params.id)) return reply.code(404).send({ error: "no such lesson" });
    await manager.runnerFor(req.params.id).setModel(model);
    // After runnerFor: mutate the live runner's record, not a stale copy.
    const session = manager.sessionFor(req.params.id)!;
    session.params.model = model;
    saveSession(session);
    return { ok: true };
  }
);

// SSE event stream — the lesson screen's live feed.
app.get<{ Params: { id: string } }>("/api/lesson/:id/events", async (req, reply) => {
  const session = manager.sessionFor(req.params.id);
  if (!session) return reply.code(404).send({ error: "no such lesson" });

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  reply.raw.write(`retry: 2000\n\n`);

  const write = (ev: LessonEvent) => {
    reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  // Listeners are registered with the manager (not a runner) so they survive
  // runner revivals; a dormant session simply streams nothing until the next
  // POST message revives it.
  const unsubscribe = manager.subscribe(req.params.id, write);

  const ping = setInterval(() => reply.raw.write(`: ping\n\n`), 25_000);
  req.raw.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });

  // Keep the reply open — Fastify must not try to send a body.
  return reply;
});

// The learner's explicit yes/no on proposed confirmed patterns — the gate, as UI.
app.post<{
  Params: { id: string };
  Body: { approve?: string[]; rejectAll?: boolean };
}>("/api/lesson/:id/approve-patterns", async (req, reply) => {
  const session = manager.sessionFor(req.params.id);
  if (!session) return reply.code(404).send({ error: "no such lesson" });
  if (!session.commit) return reply.code(409).send({ error: "lesson has no commit yet" });
  if (session.commit.patternsResolved) {
    return reply.code(409).send({ error: "patterns already resolved" });
  }

  const approve = (req.body?.approve ?? []).filter((p) =>
    session.commit!.proposedConfirmedPatterns.includes(p)
  );
  let gitMessage = "";
  if (approve.length > 0) {
    applyProfilePatch(DATA_PATHS.profile, { approvedConfirmedPatterns: { add: approve } });
    gitMessage = gitCommit(
      `Approve confirmed pattern(s) after Lesson ${session.commit.lessonNumber} — ${todayLocal()}`
    );
  }
  session.commit.patternsResolved = true;
  saveSession(session);
  return { ok: true, applied: approve.length, gitMessage };
});

app.delete<{ Params: { id: string } }>("/api/lesson/:id", async (req, reply) => {
  const session = manager.sessionFor(req.params.id);
  if (!session) return reply.code(404).send({ error: "no such lesson" });
  manager.abandon(req.params.id);
  return { ok: true };
});

// --- Startup ----------------------------------------------------------------

function authNote(): string {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return "CLAUDE_CODE_OAUTH_TOKEN (Pro subscription)";
  if (process.env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY (metered API)";
  return "no token in env — the SDK will fall back to Claude Code's own login if present";
}

app.log.info(`code: ${ROOT}`);
app.log.info(`data: ${PATHS.dataRoot}`);
app.log.info(`auth: ${authNote()}`);
app.log.info(`web: ${existsSync(WEB_DIST) ? WEB_DIST : "NOT BUILT (npm run build:web)"}`);

process.on("SIGINT", () => {
  manager.closeAll();
  process.exit(0);
});
process.on("SIGTERM", () => {
  manager.closeAll();
  process.exit(0);
});

await app.listen({ port: PORT, host: HOST });
