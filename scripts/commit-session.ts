/**
 * Apply a session patch (JSON) to the three data files, then git-commit.
 *
 * Usage:
 *   npm run commit-session -- --patch path/to/patch.json [--dry-run]
 *   cat patch.json | npm run commit-session -- --stdin [--dry-run]
 *
 * --dry-run validates the patch against current data and prints what would
 * happen, writing nothing. Always dry-run first.
 *
 * Confirmed-pattern gate: 'proposedConfirmedPatterns' is printed, never applied.
 * Only 'approvedConfirmedPatterns' (the learner agreed in-conversation) is written.
 */
import { readFileSync } from "node:fs";
import type { SessionPatch } from "../core/types.js";
import { applySessionPatch, checkPatch } from "../core/patcher.js";
import { DATA_PATHS, ensureDataRoot, gitCommit, parseArgs } from "./lib.js";

ensureDataRoot();

const args = parseArgs(process.argv.slice(2), {
  patch: undefined as string | undefined,
  stdin: undefined as string | undefined,
  "dry-run": undefined as string | undefined,
});

let raw: string;
if (args.stdin === "true") {
  raw = readFileSync(0, "utf8");
} else if (args.patch) {
  raw = readFileSync(args.patch, "utf8");
} else {
  console.error("provide --patch <file> or --stdin");
  process.exit(1);
}

let patch: SessionPatch;
try {
  patch = JSON.parse(raw);
} catch (e) {
  console.error(`patch is not valid JSON: ${(e as Error).message}`);
  process.exit(1);
}

const errors = checkPatch(DATA_PATHS, patch);
if (errors.length) {
  console.error("PATCH REJECTED:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}

if (args["dry-run"] === "true") {
  console.log("dry-run: patch is valid. Nothing written.");
  if (patch.profile?.proposedConfirmedPatterns?.length) {
    printProposals(patch.profile.proposedConfirmedPatterns);
  }
  process.exit(0);
}

try {
  const res = applySessionPatch(DATA_PATHS, patch);
  console.log(`Session committed as Lesson ${res.lessonNumber}.`);
  for (const s of res.summary) console.log(`  - ${s}`);
  if (res.proposedConfirmedPatterns.length) printProposals(res.proposedConfirmedPatterns);
  console.log(gitCommit(`Lesson ${res.lessonNumber} — ${patch.lesson.date} — ${patch.lesson.topicIds.join(", ")}`));
} catch (e) {
  console.error(`commit-session failed: ${(e as Error).message}`);
  process.exit(1);
}

function printProposals(props: string[]): void {
  console.log("\n================ PROPOSED CONFIRMED-PATTERN CHANGES ================");
  console.log("NOT applied. The learner holds the gate — you propose, they dispose.");
  for (const p of props) console.log(`  * ${p}`);
  console.log("If the learner agrees, re-run with the item moved to profile.approvedConfirmedPatterns");
  console.log("in a follow-up patch (lesson-less patches are not supported; fold it into the");
  console.log("next session, or edit profile.md by hand — it's yours).");
  console.log("=====================================================================");
}
