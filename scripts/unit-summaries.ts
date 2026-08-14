/**
 * Generate the curriculum viewer's per-unit summaries — the one place in this
 * system where prose is written by a model rather than derived from data.
 *
 * It stays honest about that by being explicit and rare: you run it, it only
 * touches units whose structure actually changed (see core/unit-summaries.ts
 * for what "changed" means), and it commits the result. Nothing generates on
 * demand behind your back — the server never calls a model to render a page.
 *
 * Usage:
 *   npm run unit-summaries -- --check    # what's stale? costs nothing, exits 1 if any
 *   npm run unit-summaries               # generate the stale ones, write, commit
 *   npm run unit-summaries -- --force    # regenerate everything
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadCurriculum } from "../core/curriculum.js";
import {
  loadUnitSummaries,
  saveUnitSummaries,
  staleUnits,
  unitSourceHash,
  type StaleUnit,
  type UnitSummariesFile,
} from "../core/unit-summaries.js";
import { DATA_PATHS, PATHS, gitCommit, parseArgs } from "./lib.js";
import type { Lane, Unit } from "../core/types.js";

const MODEL = "opus";

const args = parseArgs(process.argv.slice(2), {} as { check?: string; force?: string });
const checkOnly = args.check === "true";
const force = args.force === "true";

const c = loadCurriculum(DATA_PATHS.curriculum);
const file: UnitSummariesFile = loadUnitSummaries(PATHS.unitSummaries);

const targets: StaleUnit[] = force
  ? c.lanes.flatMap((lane) =>
      lane.units.map((unit) => ({
        lane,
        unit,
        hash: unitSourceHash(lane, unit),
        reason: "changed" as const,
      }))
    )
  : staleUnits(c, file);

if (targets.length === 0) {
  console.log("Every unit summary is up to date.");
  process.exit(0);
}

for (const t of targets) {
  console.log(`${t.reason === "missing" ? "missing" : "changed"}  ${t.unit.id}  (${t.lane.name})`);
}

if (checkOnly) {
  console.log(`\n${targets.length} unit(s) stale. Run \`npm run unit-summaries\` to regenerate.`);
  process.exit(1);
}

console.log(`\nGenerating ${targets.length} summary/summaries with ${MODEL}…\n`);

/**
 * Describe the unit to the model. Only structural facts go in — deliberately no
 * states, notes or dates, so the prompt matches the hash: the same inputs that
 * decide "is this stale?" are the only ones that shape the prose.
 */
function promptFor(lane: Lane, unit: Unit): string {
  const list = (ts: Unit["coreTopics"]) => ts.map((t) => `  - ${t.name}`).join("\n");
  return [
    `Course: ${lane.name}`,
    `Course direction: ${lane.direction}`,
    ``,
    `Unit: ${unit.name}`,
    `Core topics, in order:`,
    list(unit.coreTopics) || "  (none yet)",
    unit.optionalTopics.length ? `Optional topics:\n${list(unit.optionalTopics)}` : "",
    ``,
    `Write exactly two sentences describing what this unit covers, for a reader`,
    `browsing a curriculum map. Say what the ideas are and how the unit builds,`,
    `in plain declarative prose.`,
    ``,
    `Rules: no lists. No second person, no "you". No mention of the learner,`,
    `their progress, difficulty, or how long it takes — that is rendered from`,
    `data elsewhere. Do not restate the unit's name as a definition ("This unit`,
    `covers…"); just describe the material. Output the two sentences and nothing`,
    `else.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

async function generate(lane: Lane, unit: Unit): Promise<string> {
  const q = query({
    prompt: promptFor(lane, unit),
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
  for await (const msg of q) {
    if (msg.type === "assistant") {
      text += msg.message.content
        .map((b: { type: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : ""))
        .join("");
    }
  }
  return text.trim().replace(/\s*\n\s*/g, " ");
}

let written = 0;
const failures: string[] = [];

for (const { lane, unit, hash } of targets) {
  process.stdout.write(`  ${unit.id} … `);
  try {
    const summary = await generate(lane, unit);
    if (!summary) throw new Error("model returned no text");
    file.units[unit.id] = {
      summary,
      sourceHash: hash,
      generatedAt: new Date().toISOString(),
      model: MODEL,
    };
    written++;
    console.log("ok");
    console.log(`      ${summary}`);
  } catch (e) {
    // One bad unit shouldn't cost you the whole run — keep the successes.
    console.log(`FAILED (${(e as Error).message.split("\n")[0]})`);
    failures.push(unit.id);
  }
}

if (written === 0) {
  console.error("\nNo summaries generated — nothing written.");
  process.exit(1);
}

saveUnitSummaries(PATHS.unitSummaries, file);
console.log(`\ndata/unit-summaries.json written — ${written} summary/summaries.`);
console.log(gitCommit(`Regenerate unit summaries (${written} unit(s))`));

if (failures.length > 0) {
  console.error(`\n${failures.length} unit(s) failed and stay stale: ${failures.join(", ")}`);
  console.error("Re-run to retry just those.");
  process.exit(1);
}
