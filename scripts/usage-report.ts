/**
 * Print an analysis of the lesson usage ledger (transcripts/usage.jsonl):
 * cost/time per lesson, by lane, by size, by model, and per-feature attribution
 * (which of web search / fetch / photos are the expensive turns).
 *
 * Usage:
 *   npm run usage-report              # human-readable report
 *   npm run usage-report -- --json    # the raw analysis object, for piping
 */
import { analyzeUsage, formatReport, readLedger } from "../server/usage-report.js";

const asJson = process.argv.includes("--json");
const analysis = analyzeUsage(readLedger());

if (asJson) {
  process.stdout.write(JSON.stringify(analysis, null, 2) + "\n");
} else {
  process.stdout.write(formatReport(analysis));
}
