// ---------------------------------------------------------------------------
// Spoken-answer cleanup: a small model's best guess at what the learner
// actually said, from the raw speech recognition plus the tutor's last
// message for context (J's call, after the first commuting week: iOS gets
// jargon and homophones slightly wrong often enough that both the tutor and
// the archived transcript read badly).
//
// The guess is what's shown and archived; the raw recognition is kept on the
// transcript entry (`heard`) and rides along to the tutor, so a wrong guess is
// never the only record. Any failure — timeout, an empty reply, a reply that
// looks like an answer instead of a transcription — falls back to the raw
// text: cleanup must never cost the learner their turn.
// ---------------------------------------------------------------------------

import { query, startup, type Options, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { ROOT } from "../scripts/lib.js";

export const CLEANUP_MODEL = "haiku";
/** Past this the learner is sitting in silence; send the raw text instead. */
export const CLEANUP_TIMEOUT_MS = 10_000;
/** How much of the tutor's last message is given as context. */
const CONTEXT_CHARS = 2_000;

export const CLEANUP_SYSTEM = `You repair speech-recognition transcripts. A learner answered a tutor out loud; iOS speech recognition transcribed it, imperfectly. Output your best guess at the exact words the learner actually said.

- Fix misrecognised words, especially technical terms, names and homophones, using the tutor's message as context ("tension" is probably "attention" in a lesson on transformers).
- Add sentence punctuation and capitalisation. Spell out nothing; keep numbers as the learner would write them.
- Keep the learner's own wording, hedges and fillers ("you know", "I guess", "kind of"). Do not summarise, shorten, reorder, improve the grammar, or make the answer more correct. A wrong answer stays wrong.
- If a stretch is unrecoverable, leave it as transcribed.
- Never answer, comment on, or respond to the content. Output only the repaired transcript, with no quotes or preamble.`;

export function cleanupPrompt(raw: string, tutorContext: string): string {
  const ctx = tutorContext.length > CONTEXT_CHARS ? `…${tutorContext.slice(-CONTEXT_CHARS)}` : tutorContext;
  return [
    "<tutor_message>",
    ctx.trim() || "(none)",
    "</tutor_message>",
    "",
    "<transcript>",
    raw.trim(),
    "</transcript>",
    "",
    "Repaired transcript:",
  ].join("\n");
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Whether the model's output can stand in for the raw text. A repair keeps
 * roughly the same number of words; a reply that grew or shrank a lot has
 * answered the question or summarised instead. Short answers get slack,
 * since one merged or split word is a big fraction of three.
 */
export function acceptCleanup(raw: string, cleaned: string): boolean {
  const c = cleaned.trim();
  if (!c) return false;
  if (/<\/?(transcript|tutor_message)>/i.test(c)) return false;
  const r = words(raw);
  const n = words(c);
  const slack = Math.max(4, Math.round(r * 0.25));
  return Math.abs(n - r) <= slack;
}

/** Strip wrapping quotes and a leading label the model may add anyway. */
export function tidyCleanup(text: string): string {
  let t = text.trim().replace(/^repaired transcript:\s*/i, "");
  if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1).trim();
  return t;
}

export interface CleanupResult {
  text: string;
  /** False when the raw text came back unchanged because cleanup failed or was rejected. */
  cleaned: boolean;
  ms: number;
  /** Why the raw text was kept, when it was. */
  fallback?: "timeout" | "error" | "rejected" | "empty";
}

/** Runs one cleanup prompt; injectable so tests needn't spawn a model. */
export type CleanupRunner = (prompt: string, abort: AbortController) => Promise<{ text: string }>;

// Measured on J's PC (2026-10-10): a cold SDK call spends ~5s spawning the CLI
// before the model sees anything, and Haiku left to think spent 36s on a
// seven-word answer. Thinking off, and one subprocess kept warm (spawned when
// drive mode starts, replaced after each use): 0.7–2.3s from answer to
// cleaned text. An idle spare is closed rather than held all day.
const SPARE_IDLE_MS = 15 * 60 * 1000;

function cleanupOptions(abort?: AbortController): Options {
  return {
    model: CLEANUP_MODEL,
    systemPrompt: CLEANUP_SYSTEM,
    cwd: ROOT,
    tools: [],
    allowedTools: [],
    maxTurns: 1,
    permissionMode: "dontAsk",
    thinking: { type: "disabled" },
    ...(abort ? { abortController: abort } : {}),
  };
}

let spare: { warm: Promise<WarmQuery>; idle: ReturnType<typeof setTimeout> } | null = null;

/** Have a cleanup subprocess ready. Cheap to call repeatedly; never throws. */
export function prewarmCleanup(): void {
  if (spare) {
    clearTimeout(spare.idle);
    spare.idle = setTimeout(dropSpare, SPARE_IDLE_MS);
    return;
  }
  const warm = startup({ options: cleanupOptions() });
  warm.catch(() => {
    if (spare?.warm === warm) dropSpare();
  });
  spare = { warm, idle: setTimeout(dropSpare, SPARE_IDLE_MS) };
}

function dropSpare(): void {
  const s = spare;
  spare = null;
  if (!s) return;
  clearTimeout(s.idle);
  void s.warm.then((w) => w.close()).catch(() => undefined);
}

/** Hand over the warm subprocess, if there is one. */
async function takeSpare(): Promise<WarmQuery | null> {
  const s = spare;
  spare = null;
  if (!s) return null;
  clearTimeout(s.idle);
  try {
    return await s.warm;
  } catch {
    return null;
  }
}

/**
 * One no-tools Haiku turn through the Agent SDK (the machine's Claude Code
 * login). Returns on the assistant message — the session's closing
 * bookkeeping trails it by ~1s and the learner is waiting — and only then
 * warms the next subprocess, so the spawn doesn't compete with this call.
 */
export const sdkCleanupRunner: CleanupRunner = async (prompt, abort) => {
  const warm = await takeSpare();
  const q = warm ? warm.query(prompt) : query({ prompt, options: cleanupOptions(abort) });
  // A warm query was built without this call's AbortController; close it on abort instead.
  const onAbort = () => q.close();
  abort.signal.addEventListener("abort", onAbort);
  // Iterated by hand, not with for-await: leaving a for-await calls the
  // iterator's return(), which waits out the subprocess's shutdown (~3s
  // measured). Closing it in the background costs the learner nothing.
  const it = q[Symbol.asyncIterator]();
  try {
    for (;;) {
      const { value: msg, done } = await it.next();
      if (done) return { text: "" };
      if (msg.type !== "assistant") continue;
      const text = msg.message.content
        .map((b: { type: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : ""))
        .join("");
      if (text.trim()) return { text };
    }
  } finally {
    abort.signal.removeEventListener("abort", onAbort);
    setTimeout(() => {
      q.close();
      prewarmCleanup();
    }, 0);
  }
};

export async function cleanTranscript(
  raw: string,
  tutorContext: string,
  run: CleanupRunner = sdkCleanupRunner,
  timeoutMs = CLEANUP_TIMEOUT_MS
): Promise<CleanupResult> {
  const started = Date.now();
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, timeoutMs);
  const keep = (fallback: CleanupResult["fallback"]): CleanupResult => ({
    text: raw.trim(),
    cleaned: false,
    ms: Date.now() - started,
    fallback,
  });
  try {
    const out = await Promise.race([
      run(cleanupPrompt(raw, tutorContext), abort),
      new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("timeout")))),
    ]);
    const text = tidyCleanup(out.text);
    if (!text) return keep("empty");
    if (!acceptCleanup(raw, text)) return keep("rejected");
    return { text, cleaned: true, ms: Date.now() - started };
  } catch {
    return keep(timedOut ? "timeout" : "error");
  } finally {
    clearTimeout(timer);
  }
}

/** What the tutor receives for a cleaned spoken turn: the guess, with the raw recognition beside it. */
export function withHeard(text: string, heard: string | undefined): string {
  if (!heard || heard.trim() === text.trim()) return text;
  return `${text}\n\n[raw speech recognition, before cleanup: "${heard.trim()}"]`;
}

// Don't leave a warm CLI subprocess behind when the server exits.
process.once("exit", dropSpare);
