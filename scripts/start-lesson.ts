/**
 * Print the session packet for today's lesson.
 *
 * Usage:
 *   npm run start-lesson -- [--lane ai|sts|art] [--size tight|standard|deep]
 *                           [--model opus|sonnet] [--history N] [--stale-days N]
 *                           [--today YYYY-MM-DD]
 *
 * Defaults: lane = highest-weight lane, size = standard, model = opus,
 *           history = 3, stale-days = 14, today = local date.
 */
import { buildSessionPacket } from "../core/slicer.js";
import { DATA_PATHS, parseArgs, todayLocal } from "./lib.js";

const args = parseArgs(process.argv.slice(2), {
  lane: undefined as string | undefined,
  size: "standard",
  model: "opus",
  history: "3",
  "stale-days": "14",
  today: todayLocal(),
});

const size = args.size as "tight" | "standard" | "deep";
if (!["tight", "standard", "deep"].includes(size)) {
  console.error(`--size must be tight|standard|deep (got '${size}')`);
  process.exit(1);
}

try {
  const packet = buildSessionPacket(DATA_PATHS, {
    laneId: args.lane,
    size,
    model: args.model,
    historyN: Number(args.history),
    staleDays: Number(args["stale-days"]),
    today: args.today,
  });
  process.stdout.write(packet);
} catch (e) {
  console.error(`start-lesson failed: ${(e as Error).message}`);
  process.exit(1);
}
