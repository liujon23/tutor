/**
 * Print the session packet for today's lesson.
 *
 * Usage:
 *   npm run start-lesson -- [--lane ai|sts|art] [--size tight|standard|deep]
 *                           [--model opus|sonnet] [--history N] [--stale-days N]
 *                           [--recall-growth F] [--today YYYY-MM-DD]
 *
 * Defaults: lane = highest-weight lane, size = standard, model = opus,
 *           history = 3, today = local date.
 *
 * `--stale-days` is the recall interval at streak 0; each clean recall multiplies
 * it by `--recall-growth` (see core/spacing.ts).
 */
import { buildSessionPacket } from "../core/slicer.js";
import { DEFAULT_SPACING } from "../core/spacing.js";
import { DATA_PATHS, ensureDataRoot, parseArgs, todayLocal } from "./lib.js";

ensureDataRoot();

const args = parseArgs(process.argv.slice(2), {
  lane: undefined as string | undefined,
  size: "standard",
  model: "opus",
  history: "3",
  "stale-days": String(DEFAULT_SPACING.baseDays),
  "recall-growth": String(DEFAULT_SPACING.growth),
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
    spacing: {
      ...DEFAULT_SPACING,
      baseDays: Number(args["stale-days"]),
      growth: Number(args["recall-growth"]),
    },
    today: args.today,
  });
  process.stdout.write(packet);
} catch (e) {
  console.error(`start-lesson failed: ${(e as Error).message}`);
  process.exit(1);
}
