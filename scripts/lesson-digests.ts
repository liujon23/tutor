/**
 * Backfill key points and titles for lessons committed before the tutor wrote them.
 *
 * Key points: from each lesson's transcript and its history summary. Title: from
 * the history summary and the key points (the transcript is not re-read). Each
 * goes to the model with the rule the tutor follows at commit, read word for
 * word from the teaching contract, and is held to the same check. Results go to
 * data/lesson-digests.json with origin "backfill". Sources are not backfilled:
 * those lessons keep their transcript links and the history's "Sources used"
 * line, which the reader already shows.
 *
 * Lessons with no transcript (L1–3) get a title alone, from their history entry.
 *
 * Usage:
 *   npm run lesson-digests -- --check              # what's missing? costs nothing, exits 1 if anything is
 *   npm run lesson-digests -- --lessons 44,50,53   # just these (a review batch)
 *   npm run lesson-digests                         # everything missing, then commit
 *
 * Key points or a title that a lesson already has are never rewritten.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { parseHistory } from "../core/history.js";
import { loadDigests, saveDigests, type LessonDigest } from "../core/lesson-digests.js";
import { PATHS, ROOT, gitCommit, parseArgs } from "./lib.js";
import { parseHistoryFields } from "../server/lesson-detail.js";
import {
  backfillPrompt,
  conversationText,
  missingDigests,
  missingTitles,
  parseKeyPoints,
  parseTitle,
  readKeyPointsRule,
  readTitleRule,
  titlePrompt,
} from "./lesson-digests-prompt.js";

const MODEL = "sonnet";

const args = parseArgs(process.argv.slice(2), {} as { check?: string; lessons?: string });
const checkOnly = args.check === "true";

const transcriptFor = new Map<number, string>();
if (existsSync(PATHS.transcriptsDir)) {
  for (const name of readdirSync(PATHS.transcriptsDir)) {
    const m = /^lesson-(\d+)\.md$/.exec(name);
    if (m) transcriptFor.set(Number(m[1]), join(PATHS.transcriptsDir, name));
  }
}
const history = parseHistory(readFileSync(PATHS.history, "utf8")).entries;

const file = loadDigests(PATHS.lessonDigests);
const needPoints = new Set(missingDigests([...transcriptFor.keys()], file));
const needTitle = new Set(missingTitles([...history.map((h) => h.number), ...transcriptFor.keys()], file));
const missing = [...new Set([...needPoints, ...needTitle])].sort((a, b) => a - b);

let targets = missing;
if (args.lessons) {
  const asked = args.lessons.split(",").map((s) => Number(s.trim())).filter(Number.isInteger);
  for (const n of asked.filter((x) => !missing.includes(x))) {
    const known = transcriptFor.has(n) || history.some((h) => h.number === n);
    console.log(`skip  L${n}: ${known ? "already has key points and a title" : "no record of this lesson"}`);
  }
  targets = asked.filter((n) => missing.includes(n));
}

if (targets.length === 0) {
  console.log(missing.length === 0 ? "Every lesson has its key points and a title." : "Nothing to do.");
  process.exit(0);
}

const list = (ns: number[]) => ns.map((n) => `L${n}`).join(", ") || "none";
if (checkOnly) {
  console.log(`Without key points: ${list(targets.filter((n) => needPoints.has(n)))}`);
  console.log(`Without a title:    ${list(targets.filter((n) => needTitle.has(n)))}`);
  console.log("Run `npm run lesson-digests` to write them.");
  process.exit(1);
}

const pointsRule = readKeyPointsRule(ROOT);
const titleRule = readTitleRule(ROOT);

async function generate(prompt: string): Promise<{ text: string; costUsd: number }> {
  const q = query({
    prompt,
    options: {
      model: MODEL,
      // Pure text generation: no tools, no repo access, one turn.
      tools: [],
      allowedTools: [],
      maxTurns: 1,
      permissionMode: "dontAsk",
    },
  });
  let text = "";
  let costUsd = 0;
  for await (const msg of q) {
    if (msg.type === "assistant") {
      text += msg.message.content
        .map((b: { type: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : ""))
        .join("");
    }
    if (msg.type === "result" && typeof msg.total_cost_usd === "number") costUsd = msg.total_cost_usd;
  }
  return { text, costUsd };
}

/** One answer, and one retry carrying the errors, as a rejected commit goes back to the tutor. */
async function withRetry<T extends { errors: string[] }>(
  prompt: string,
  parse: (text: string) => T
): Promise<{ result: T; costUsd: number }> {
  const first = await generate(prompt);
  let result = parse(first.text);
  let costUsd = first.costUsd;
  if (result.errors.length) {
    const fix = `${prompt}\n\n--- Your previous answer ---\n${first.text.trim()}\n\nIt was rejected: ${result.errors.join("; ")}. Write it again, fixing that.`;
    const again = await generate(fix);
    costUsd += again.costUsd;
    result = parse(again.text);
  }
  return { result, costUsd };
}

/** Title first in the stored entry, so the file reads in the order the reader shows. */
function entry(prev: LessonDigest | undefined, change: Partial<LessonDigest>): LessonDigest {
  const next = { keyPoints: [], sources: [], origin: "backfill" as const, ...prev, ...change };
  return { ...(next.title ? { title: next.title } : {}), keyPoints: next.keyPoints, sources: next.sources, origin: next.origin };
}

console.log(`Backfilling ${targets.length} lesson(s) with ${MODEL}…\n`);

let pointsWritten = 0;
let titlesWritten = 0;
let totalCost = 0;
const failures: number[] = [];

for (const n of targets) {
  process.stdout.write(`L${n} … `);
  let cost = 0;
  try {
    const h = history.find((x) => x.number === n);
    const whatHappened = h ? parseHistoryFields(h.body).whatHappened : "";
    const key = String(n);

    if (needPoints.has(n)) {
      const conversation = conversationText(readFileSync(transcriptFor.get(n)!, "utf8"));
      const { result, costUsd } = await withRetry(backfillPrompt(pointsRule, n, whatHappened, conversation), parseKeyPoints);
      cost += costUsd;
      if (result.errors.length) throw new Error(`key points: ${result.errors.join("; ")}`);
      file.lessons[key] = entry(file.lessons[key], { keyPoints: result.keyPoints });
      // Saved as soon as each part is written, so a failure later keeps it.
      saveDigests(PATHS.lessonDigests, file);
      pointsWritten++;
    }

    if (needTitle.has(n)) {
      const keyPoints = file.lessons[key]?.keyPoints ?? [];
      const { result, costUsd } = await withRetry(titlePrompt(titleRule, n, whatHappened, keyPoints), parseTitle);
      cost += costUsd;
      if (result.errors.length) throw new Error(`title: ${result.errors.join("; ")}`);
      file.lessons[key] = entry(file.lessons[key], { title: result.title });
      saveDigests(PATHS.lessonDigests, file);
      titlesWritten++;
    }

    console.log(`ok ($${cost.toFixed(3)})`);
    const d = file.lessons[key];
    if (needTitle.has(n)) console.log(`    ${d?.title}`);
    if (needPoints.has(n)) for (const p of d?.keyPoints ?? []) console.log(`    - ${p}`);
  } catch (e) {
    console.log(`FAILED (${(e as Error).message.split("\n")[0]})`);
    failures.push(n);
  } finally {
    totalCost += cost;
  }
}

console.log(`\n${pointsWritten} lesson(s) given key points, ${titlesWritten} given a title, about $${totalCost.toFixed(2)} in all.`);
const parts = [
  pointsWritten ? `key points for ${pointsWritten} lesson(s)` : "",
  titlesWritten ? `titles for ${titlesWritten} lesson(s)` : "",
].filter(Boolean);
if (parts.length > 0) console.log(gitCommit(`Backfill ${parts.join(" and ")}`));
if (failures.length > 0) {
  console.error(`${failures.length} failed: ${list(failures)}. Re-run to retry them; whatever they did get is kept.`);
  process.exit(1);
}
