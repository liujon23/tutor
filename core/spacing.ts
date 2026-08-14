// Spaced-recall scheduling math. The single home for the constants and the
// curve — everything else (selector, packet, report, CLI, server) reads them
// from here so there's exactly one place the intervals are defined.
import type { RecallHistory, SpacingConfig, Topic } from "./types.js";

/**
 * Intervals widen exponentially with demonstrated mastery: each clean recall
 * multiplies the gap by `growth`, so nailing a topic buys a much longer silence
 * than merely having been taught it once.
 *
 *   streak 0 → 14d · 1 → 35d · 2 → 87d · 3 → 219d · 4+ → 365d (capped)
 *
 * `baseDays` is the streak-0 interval, which is exactly the flat threshold this
 * system used before mastery was tracked — so untouched data behaves identically.
 */
export const DEFAULT_SPACING: SpacingConfig = { baseDays: 14, growth: 2.5, maxDays: 365 };

/** The current review interval for a topic at this recall streak, in days. */
export function stabilityDays(streak: number, cfg: SpacingConfig = DEFAULT_SPACING): number {
  const s = Math.max(0, Math.floor(streak));
  return Math.min(cfg.baseDays * Math.pow(cfg.growth, s), cfg.maxDays);
}

/**
 * Probability that a topic is offered today. Zero below the floor — a clean
 * recall genuinely buys silence, not a reduced chance — then a forgetting-curve
 * ramp above it: ~63% the day it comes due, ~86% one interval later, ~95% at two.
 * The softness is the point: the same few topics shouldn't win every session.
 */
export function offerProbability(daysStale: number, stability: number): number {
  if (stability <= 0) return 1;
  if (daysStale < stability) return 0;
  return 1 - Math.exp(-daysStale / stability);
}

/**
 * Deterministic [0,1) draw from a string seed (FNV-1a 32-bit).
 *
 * Recall selection must NOT use Math.random(). The select screen and the session
 * packet call the selector independently, and the screen re-renders on every lane
 * override — a live RNG would make the chips flicker between renders and disagree
 * with the packet the tutor actually receives. Seeding on `date|topicId` keeps a
 * day's answer stable across every call while still varying day to day.
 */
export function seededUnit(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

const NO_RECALL: RecallHistory = { streak: 0, reviews: 0 };

/**
 * A topic's recall history, defaulted for topics that have never been quizzed.
 *
 * `Topic.recall` stays optional in the YAML rather than being normalized on load
 * (unlike `assets`): `saveCurriculum` re-serializes the whole file, so normalizing
 * would stamp an empty `recall` block onto every untouched topic in the file. The
 * patcher writes the field only when a recall actually happens; everything else
 * reads through here.
 */
export function getRecall(t: Topic): RecallHistory {
  return t.recall ?? NO_RECALL;
}
