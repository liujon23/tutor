/**
 * Backfill key points for lessons committed before the tutor wrote them.
 *
 * Reads each lesson's transcript and its history summary, asks a model for the
 * key points under the same rule the tutor follows at commit, and stores them
 * in data/lesson-digests.json with origin "backfill". Sources are not
 * backfilled: those lessons keep their transcript links and the history's
 * "Sources used" line, which the reader already shows.
 *
 * Usage:
 *   npm run lesson-digests -- --check              # which lessons have none? costs nothing, exits 1 if any
 *   npm run lesson-digests -- --lessons 44,50,53   # just these (a review batch)
 *   npm run lesson-digests                         # every lesson that has none, then commit
 *
 * A lesson that already has a digest is never rewritten.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { parseHistory } from "../core/history.js";
import { loadDigests, saveDigests } from "../core/lesson-digests.js";
import { PATHS, ROOT, gitCommit, parseArgs } from "./lib.js";
import { parseHistoryFields } from "../server/lesson-detail.js";
import {
  backfillPrompt,
  conversationText,
  missingDigests,
  parseKeyPoints,
  readKeyPointsRule,
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

const file = loadDigests(PATHS.lessonDigests);
const missing = missingDigests([...transcriptFor.keys()], file);

let targets = missing;
if (args.lessons) {
  const asked = args.lessons.split(",").map((s) => Number(s.trim())).filter(Number.isInteger);
  const skipped = asked.filter((n) => !missing.includes(n));
  for (const n of skipped) {
    console.log(`skip  L${n}: ${transcriptFor.has(n) ? "already has key points" : "no transcript"}`);
  }
  targets = asked.filter((n) => missing.includes(n));
}

if (targets.length === 0) {
  console.log(missing.length === 0 ? "Every lesson with a transcript has key points." : "Nothing to do.");
  process.exit(0);
}

if (checkOnly) {
  console.log(`${targets.length} lesson(s) without key points: ${targets.map((n) => `L${n}`).join(", ")}`);
  console.log("Run `npm run lesson-digests` to write them.");
  process.exit(1);
}

const rule = readKeyPointsRule(ROOT);
const history = parseHistory(readFileSync(PATHS.history, "utf8")).entries;

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

console.log(`Writing key points for ${targets.length} lesson(s) with ${MODEL}…\n`);

let written = 0;
let totalCost = 0;
const failures: number[] = [];

for (const n of targets) {
  process.stdout.write(`L${n} … `);
  try {
    const entry = history.find((h) => h.number === n);
    const whatHappened = entry ? parseHistoryFields(entry.body).whatHappened : "";
    const conversation = conversationText(readFileSync(transcriptFor.get(n)!, "utf8"));
    const prompt = backfillPrompt(rule, n, whatHappened, conversation);
    let { text, costUsd } = await generate(prompt);
    let { keyPoints, errors } = parseKeyPoints(text);
    if (errors.length) {
      // One retry with the errors, as a rejected commit goes back to the tutor.
      const fix = `${prompt}\n\n--- Your previous answer ---\n${text.trim()}\n\nIt was rejected: ${errors.join("; ")}. Write the key points again, fixing that.`;
      const again = await generate(fix);
      costUsd += again.costUsd;
      ({ keyPoints, errors } = parseKeyPoints(again.text));
    }
    totalCost += costUsd;
    if (errors.length) throw new Error(errors.join("; "));
    file.lessons[String(n)] = { keyPoints, sources: [], origin: "backfill" };
    // Saved after every lesson, so a failure later on keeps what was written.
    saveDigests(PATHS.lessonDigests, file);
    written++;
    console.log(`ok ($${costUsd.toFixed(3)})`);
    for (const p of keyPoints) console.log(`    - ${p}`);
  } catch (e) {
    console.log(`FAILED (${(e as Error).message.split("\n")[0]})`);
    failures.push(n);
  }
}

console.log(`\n${written} lesson(s) written, about $${totalCost.toFixed(2)} in all.`);
if (written > 0) {
  console.log(gitCommit(`Backfill key points for ${written} lesson(s)`));
}
if (failures.length > 0) {
  console.error(`${failures.length} failed and still have none: ${failures.map((x) => `L${x}`).join(", ")}. Re-run to retry them.`);
  process.exit(1);
}
