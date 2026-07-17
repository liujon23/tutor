// Resource-use accounting for lessons: turn the SDK's per-result usage into
// tagged records, roll those up per lesson, and append a durable ledger line.
//
// On the Pro subscription the model is NOT billed per token — the dollar
// figures here are the SDK's *equivalent* cost at API rates, useful only for
// comparing lessons and spotting expensive features. Tokens are the ground
// truth; the SDK's per-result `usage` reports that turn's tokens (per-request,
// never cumulative), so summing across turns is correct. Cost is NOT: the
// SDK's `total_cost_usd` on a `result` message is CUMULATIVE for the whole SDK
// session, not per-turn. Callers must convert it to a per-turn delta with
// `costDelta` (below) before it reaches this module — `usageFromResult` takes
// that already-computed delta directly, so the `costUsd` this module stores
// and sums is per-turn and safe to add across records.
import { appendFileSync, mkdirSync } from "node:fs";
import { PATHS } from "../scripts/lib.js";
import type { LessonUsage, TokenCounts, UsageRecord } from "./types.js";

export const USAGE_LEDGER = PATHS.usageLedger;

/** Minimal shape of the SDK `result` message we read — kept local so this
 *  module has no SDK dependency and stays unit-testable. */
export interface ResultUsageLike {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
  duration_ms?: number;
  is_error?: boolean;
}

/** What the runner knows about the turn that a result concludes. */
export interface TurnTags {
  model: string;
  tools: string[];
  hadImage: boolean;
}

export function emptyTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  };
}

export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheCreation;
}

/**
 * Turn the SDK's cumulative `total_cost_usd` into a per-turn delta.
 * `current` is what the latest `result` message reports (running total for
 * the SDK session); `prevCumulative` is what the previous `result` reported.
 * A decrease means the running counter reset — e.g. a runner revived after a
 * server restart starts a fresh SDK query at 0 — so treat the whole current
 * figure as new spend rather than going negative.
 */
export function costDelta(prevCumulative: number, current: number): number {
  return current >= prevCumulative ? current - prevCumulative : current;
}

/** Build a tagged usage record from one SDK result message plus the
 *  already-computed per-turn `costUsd` (see `costDelta` — this module never
 *  reads `total_cost_usd` itself, since it's cumulative, not per-turn).
 *  Missing usage fields default to 0 so a malformed/partial result never
 *  throws. */
export function usageFromResult(msg: ResultUsageLike, tags: TurnTags, costUsd: number): UsageRecord {
  const u = msg.usage ?? {};
  return {
    at: new Date().toISOString(),
    model: tags.model,
    tokens: {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreation: u.cache_creation_input_tokens ?? 0,
    },
    costUsd,
    durationMs: msg.duration_ms ?? 0,
    tools: [...new Set(tags.tools)],
    hadImage: tags.hadImage,
    isError: msg.is_error ?? false,
  };
}

/** Roll per-turn records up into the per-lesson summary. `wallClockMs` is the
 *  real elapsed time (created → last activity), passed in by the caller. */
export function summarizeUsage(records: UsageRecord[], wallClockMs: number): LessonUsage {
  const byModel: LessonUsage["byModel"] = {};
  const features = { webSearch: 0, webFetch: 0, photos: 0 };
  let tokens = emptyTokens();
  let costUsd = 0;
  let durationMs = 0;

  for (const r of records) {
    tokens = addTokens(tokens, r.tokens);
    costUsd += r.costUsd;
    durationMs += r.durationMs;

    const m = (byModel[r.model] ??= { turns: 0, tokens: emptyTokens(), costUsd: 0 });
    m.turns += 1;
    m.tokens = addTokens(m.tokens, r.tokens);
    m.costUsd += r.costUsd;

    if (r.tools.includes("WebSearch")) features.webSearch += 1;
    if (r.tools.includes("WebFetch")) features.webFetch += 1;
    if (r.hadImage) features.photos += 1;
  }

  return {
    turns: records.length,
    tokens,
    costUsd,
    durationMs,
    wallClockMs: Math.max(0, wallClockMs),
    byModel,
    features,
  };
}

// --- Formatting (shared by the transcript header and the ledger) -----------

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const nf = new Intl.NumberFormat("en-US");
export const formatInt = (n: number): string => nf.format(Math.round(n));
export const formatUsd = (n: number): string => `$${n.toFixed(2)}`;

/** One compact human-readable line for the committed transcript header. */
export function usageHeadline(u: LessonUsage): string {
  const t = u.tokens;
  return (
    `${formatInt(totalTokens(t))} tokens ` +
    `(${formatInt(t.input)} in / ${formatInt(t.output)} out / ` +
    `${formatInt(t.cacheRead + t.cacheCreation)} cache) · ` +
    `≈ ${formatUsd(u.costUsd)} API-equiv · ${u.turns} turns · ` +
    `${formatDuration(u.wallClockMs)}`
  );
}

// --- Durable ledger --------------------------------------------------------

/** Metadata that pins a ledger line to its lesson, for later analysis. */
export interface LedgerMeta {
  lessonNumber: number;
  date: string;
  laneId: string;
  unitId: string;
  topicIds: string[];
  size: string;
  committedAt: string;
}

/**
 * Append one JSON line per lesson to transcripts/usage.jsonl — the durable,
 * greppable substrate for cross-lesson analysis (averages over time, cost by
 * feature). Rides the same git commit as the lesson (transcripts/ is staged).
 * Each line carries the roll-up *and* the per-turn records, so no detail is lost.
 */
export function appendUsageLedger(
  meta: LedgerMeta,
  usage: LessonUsage,
  records: UsageRecord[]
): string {
  mkdirSync(PATHS.transcriptsDir, { recursive: true });
  // costModel marks the line as holding per-turn deltas (vs. the pre-2026-07
  // cumulative format some old ledgers carried).
  const line = JSON.stringify({ ...meta, costModel: "delta", usage, turns: records }) + "\n";
  appendFileSync(USAGE_LEDGER, line, "utf8");
  return "transcripts/usage.jsonl";
}
