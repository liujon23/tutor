// Analysis over the transcripts/usage.jsonl ledger: what lessons cost over
// time, and which features are the expensive ones. Pure aggregation + text
// formatting here; scripts/usage-report.ts is the thin CLI. Deliberately not
// wired into the app UI yet — this is the offline analyst's view.
import { existsSync, readFileSync } from "node:fs";
import {
  USAGE_LEDGER,
  formatDuration,
  formatInt,
  formatUsd,
  totalTokens,
  type LedgerMeta,
} from "./usage.js";
import type { LessonUsage, TokenCounts, UsageRecord } from "./types.js";

/** One ledger line: the per-lesson roll-up plus every per-turn record. */
export interface LedgerEntry extends LedgerMeta {
  usage: LessonUsage;
  turns: UsageRecord[];
}

/** Parse JSONL text into entries, skipping blank or malformed lines. */
export function parseLedger(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as LedgerEntry);
    } catch {
      /* a corrupt line shouldn't sink the whole report */
    }
  }
  return out;
}

export function readLedger(path: string = USAGE_LEDGER): LedgerEntry[] {
  if (!existsSync(path)) return [];
  return parseLedger(readFileSync(path, "utf8"));
}

// --- Aggregates -------------------------------------------------------------

export interface GroupStats {
  key: string;
  lessons: number;
  turns: number;
  tokens: TokenCounts;
  totalTokens: number;
  costUsd: number;
  wallClockMs: number;
}

function emptyGroup(key: string): GroupStats {
  return {
    key,
    lessons: 0,
    turns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    totalTokens: 0,
    costUsd: 0,
    wallClockMs: 0,
  };
}

function fold(g: GroupStats, e: LedgerEntry): GroupStats {
  const t = e.usage.tokens;
  g.lessons += 1;
  g.turns += e.usage.turns;
  g.tokens.input += t.input;
  g.tokens.output += t.output;
  g.tokens.cacheRead += t.cacheRead;
  g.tokens.cacheCreation += t.cacheCreation;
  g.totalTokens += totalTokens(t);
  g.costUsd += e.usage.costUsd;
  g.wallClockMs += e.usage.wallClockMs;
  return g;
}

function groupBy(entries: LedgerEntry[], keyOf: (e: LedgerEntry) => string): GroupStats[] {
  const map = new Map<string, GroupStats>();
  for (const e of entries) {
    const k = keyOf(e);
    fold(map.get(k) ?? map.set(k, emptyGroup(k)).get(k)!, e);
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

export interface ModelStats {
  model: string;
  lessons: number;
  turns: number;
  totalTokens: number;
  costUsd: number;
}

function byModel(entries: LedgerEntry[]): ModelStats[] {
  const map = new Map<string, ModelStats>();
  for (const e of entries) {
    for (const [model, m] of Object.entries(e.usage.byModel)) {
      const s = map.get(model) ?? { model, lessons: 0, turns: 0, totalTokens: 0, costUsd: 0 };
      s.lessons += 1;
      s.turns += m.turns;
      s.totalTokens += totalTokens(m.tokens);
      s.costUsd += m.costUsd;
      map.set(model, s);
    }
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

// --- Feature attribution (turn-level marginal cost) -------------------------

export interface FeatureStat {
  feature: string;
  turnsWith: number;
  turnsWithout: number;
  avgTokensWith: number;
  avgTokensWithout: number;
  avgCostWith: number;
  avgCostWithout: number;
  totalTokensWith: number;
  totalCostWith: number;
}

const FEATURES: { label: string; has: (t: UsageRecord) => boolean }[] = [
  { label: "web search", has: (t) => t.tools.includes("WebSearch") },
  { label: "web fetch", has: (t) => t.tools.includes("WebFetch") },
  { label: "photo attached", has: (t) => t.hadImage },
];

/**
 * For each feature, compare the average turn WITH it against turns WITHOUT it —
 * the honest read on "does this feature cost a lot?" (The SDK bills usage per
 * turn, not per tool, so this is attribution by association, not exact.)
 */
export function featureStats(entries: LedgerEntry[]): FeatureStat[] {
  const turns = entries.flatMap((e) => e.turns);
  return FEATURES.map(({ label, has }) => {
    const withF = turns.filter(has);
    const without = turns.filter((t) => !has(t));
    const sum = (rs: UsageRecord[], f: (t: UsageRecord) => number) => rs.reduce((n, t) => n + f(t), 0);
    const tokTot = (rs: UsageRecord[]) => sum(rs, (t) => totalTokens(t.tokens));
    const avg = (n: number, d: number) => (d ? n / d : 0);
    return {
      feature: label,
      turnsWith: withF.length,
      turnsWithout: without.length,
      avgTokensWith: avg(tokTot(withF), withF.length),
      avgTokensWithout: avg(tokTot(without), without.length),
      avgCostWith: avg(sum(withF, (t) => t.costUsd), withF.length),
      avgCostWithout: avg(sum(without, (t) => t.costUsd), without.length),
      totalTokensWith: tokTot(withF),
      totalCostWith: sum(withF, (t) => t.costUsd),
    };
  });
}

export interface TimelineRow {
  lessonNumber: number;
  date: string;
  laneId: string;
  size: string;
  turns: number;
  totalTokens: number;
  costUsd: number;
  wallClockMs: number;
}

export interface UsageAnalysis {
  overall: GroupStats;
  byLane: GroupStats[];
  bySize: GroupStats[];
  byModel: ModelStats[];
  features: FeatureStat[];
  timeline: TimelineRow[];
}

const SIZE_ORDER = ["tight", "standard", "deep"];

export function analyzeUsage(entries: LedgerEntry[]): UsageAnalysis {
  const bySize = groupBy(entries, (e) => e.size).sort(
    (a, b) => SIZE_ORDER.indexOf(a.key) - SIZE_ORDER.indexOf(b.key)
  );
  const timeline = entries
    .map((e) => ({
      lessonNumber: e.lessonNumber,
      date: e.date,
      laneId: e.laneId,
      size: e.size,
      turns: e.usage.turns,
      totalTokens: totalTokens(e.usage.tokens),
      costUsd: e.usage.costUsd,
      wallClockMs: e.usage.wallClockMs,
    }))
    .sort((a, b) => a.lessonNumber - b.lessonNumber);
  return {
    overall: entries.reduce(fold, emptyGroup("all")),
    byLane: groupBy(entries, (e) => e.laneId),
    bySize,
    byModel: byModel(entries),
    features: featureStats(entries),
    timeline,
  };
}

// --- Text formatting --------------------------------------------------------

const avgInt = (n: number, d: number) => (d ? formatInt(n / d) : "—");
const avgUsd = (n: number, d: number) => (d ? formatUsd(n / d) : "—");

function padCols(rows: string[][], aligns: ("l" | "r")[]): string {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows
    .map((r) =>
      r.map((cell, c) => (aligns[c] === "r" ? cell.padStart(widths[c]) : cell.padEnd(widths[c]))).join("  ")
    )
    .join("\n");
}

function groupTable(title: string, label: string, groups: GroupStats[]): string {
  const header = [label, "lessons", "avg tok", "avg $", "avg time", "total tok", "total $"];
  const rows = [header];
  for (const g of groups) {
    rows.push([
      g.key,
      String(g.lessons),
      avgInt(g.totalTokens, g.lessons),
      avgUsd(g.costUsd, g.lessons),
      g.lessons ? formatDuration(g.wallClockMs / g.lessons) : "—",
      formatInt(g.totalTokens),
      formatUsd(g.costUsd),
    ]);
  }
  return `${title}\n${padCols(rows, ["l", "r", "r", "r", "r", "r", "r"])}`;
}

export function formatReport(a: UsageAnalysis): string {
  if (a.overall.lessons === 0) {
    return "No usage recorded yet — the ledger (transcripts/usage.jsonl) is empty.\nRun some app lessons and check back.";
  }
  const o = a.overall;
  const span = a.timeline.length
    ? `Lessons ${a.timeline[0].lessonNumber}–${a.timeline[a.timeline.length - 1].lessonNumber} · ${a.timeline[0].date} → ${a.timeline[a.timeline.length - 1].date}`
    : "";

  const out: string[] = [];
  out.push("USAGE REPORT");
  out.push(span);
  out.push("");
  out.push(`  ${o.lessons} lessons · ${formatInt(o.totalTokens)} tokens · ≈ ${formatUsd(o.costUsd)} API-equiv`);
  out.push(
    `  per lesson: ${avgInt(o.totalTokens, o.lessons)} tokens · ≈ ${avgUsd(o.costUsd, o.lessons)} · ` +
      `${avgInt(o.turns, o.lessons)} turns · ${formatDuration(o.wallClockMs / o.lessons)} (rough)`
  );
  out.push("");
  out.push("  $ figures are equivalent at API rates — Pro isn't billed per token.");
  out.push("  Elapsed time counts idle spells mid-lesson, so read it as a rough proxy.");
  out.push("");

  // Timeline
  const tRows = [["lesson", "date", "lane", "size", "turns", "tokens", "$", "time"]];
  for (const r of a.timeline) {
    tRows.push([
      String(r.lessonNumber),
      r.date,
      r.laneId,
      r.size,
      String(r.turns),
      formatInt(r.totalTokens),
      formatUsd(r.costUsd),
      formatDuration(r.wallClockMs),
    ]);
  }
  out.push("By lesson");
  out.push(padCols(tRows, ["r", "l", "l", "l", "r", "r", "r", "r"]));
  out.push("");

  out.push(groupTable("By lane", "lane", a.byLane));
  out.push("");
  out.push(groupTable("By size", "size", a.bySize));
  out.push("");

  // By model
  const mRows = [["model", "lessons", "turns", "avg tok/lesson", "total tok", "total $"]];
  for (const m of a.byModel) {
    mRows.push([
      m.model,
      String(m.lessons),
      String(m.turns),
      avgInt(m.totalTokens, m.lessons),
      formatInt(m.totalTokens),
      formatUsd(m.costUsd),
    ]);
  }
  out.push("By model");
  out.push(padCols(mRows, ["l", "r", "r", "r", "r", "r"]));
  out.push("");

  // Feature attribution
  const fRows = [["feature", "turns", "avg tok w/", "avg tok w/o", "total tok", "total $"]];
  for (const f of a.features) {
    fRows.push([
      f.feature,
      String(f.turnsWith),
      formatInt(f.avgTokensWith),
      formatInt(f.avgTokensWithout),
      formatInt(f.totalTokensWith),
      formatUsd(f.totalCostWith),
    ]);
  }
  out.push("By feature (turns using it vs. not — attribution by association, not exact)");
  out.push(padCols(fRows, ["l", "r", "r", "r", "r", "r"]));

  return out.join("\n") + "\n";
}
