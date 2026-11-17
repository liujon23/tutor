/**
 * Print an analysis of the drive-mode diagnostics (<data root>/.app/diag/):
 * broken rules and anomalies, where the wait for a reply goes, whether the
 * prompt cache held, what the stream lost and recovered, backgrounding,
 * endpointing, the recogniser, and what fills the log.
 *
 * Usage:
 *   npm run drive-report                       # every session
 *   npm run drive-report -- 600c0f35           # sessions whose id starts with this
 *   npm run drive-report -- --since 2026-11-01 # sessions with records on or after a date
 *   npm run drive-report -- --json             # the raw analysis object, for piping
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeDrive, formatDriveReport, parseDiag, type DiagSession } from "../server/drive-report.js";
import { PATHS } from "./lib.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const sinceAt = args.indexOf("--since");
const since = sinceAt >= 0 ? args[sinceAt + 1] : undefined;
if (sinceAt >= 0 && !/^\d{4}-\d{2}-\d{2}/.test(since ?? "")) {
  process.stderr.write("--since needs a date, e.g. --since 2026-11-01\n");
  process.exit(1);
}
const prefix = args.find((a, i) => !a.startsWith("--") && (sinceAt < 0 || i !== sinceAt + 1));

const dir = join(PATHS.appDir, "diag");
const sessions: DiagSession[] = [];
for (const file of existsSync(dir) ? readdirSync(dir).sort() : []) {
  if (!file.endsWith(".jsonl")) continue;
  const id = file.slice(0, -".jsonl".length);
  if (prefix && !id.startsWith(prefix)) continue;
  const lines = parseDiag(readFileSync(join(dir, file), "utf8"));
  // A session counts as "since" a date when any of it happened on or after it;
  // its earlier records stay in, since a lesson's turns only make sense together.
  if (since && !lines.some((l) => l.at !== undefined && l.at >= since)) continue;
  sessions.push({ id, lines });
}

const analysis = analyzeDrive(sessions);
process.stdout.write(asJson ? JSON.stringify(analysis, null, 2) + "\n" : formatDriveReport(analysis));
