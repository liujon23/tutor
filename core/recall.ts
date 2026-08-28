// Standalone spaced-recall checks: the narrow write path behind the app's
// one-click recall button.
//
// Why this isn't in patcher.ts: `applySessionPatch` is a *lesson* commit. It
// unconditionally consumes a lesson number and prepends an entry to
// lesson-history.md, and the tool around it archives a transcript. A recall
// check is not a lesson — running it through that path would fabricate one and
// bury real lessons under micro-entries. So this module writes exactly one
// thing: the graded topics' `recall` blocks in curriculum.yaml.
//
// The streak/demotion rules live here too (`applyRecallGrade`), shared with the
// patcher so the two write paths can never drift apart.
import type { Curriculum, DataPaths, RecallResult, Topic, TopicState } from "./types.js";
import { RECALL_RESULTS, TOPIC_STATES } from "./types.js";
import { loadCurriculum, saveCurriculum, topicById } from "./curriculum.js";
import { getRecall, stabilityDays } from "./spacing.js";
import { validateCurriculum } from "./validator.js";

/**
 * Apply one recall grade to a topic, in place. The single home for the streak
 * rules — called by the lesson patcher (via `topicUpdates[].recall`) and by a
 * standalone recall check alike.
 *
 * `explicitState` mirrors `TopicUpdate.state`: when the caller sets a state of
 * its own it wins over the automatic miss → shaky demotion.
 *
 * Deliberately does NOT touch `lastTouched`. That field means "last taught in a
 * numbered lesson" — it carries a lesson number, and the curriculum viewer links
 * a transcript from it. The lesson patcher stamps it separately; a standalone
 * check leaves it alone. See `lastExercised` for how staleness reads both.
 */
export function applyRecallGrade(
  topic: Topic,
  result: RecallResult,
  date: string,
  explicitState?: TopicState
): void {
  const prev = getRecall(topic);
  topic.recall = {
    streak: result === "clean" ? prev.streak + 1 : 0,
    reviews: prev.reviews + 1,
    last: { date, result },
  };
  // A topic that's gone is due for re-teaching, not another warm-up. Deterministic
  // bookkeeping, but an explicit state from the caller still wins.
  if (result === "miss" && !explicitState) topic.state = "shaky";
}

/**
 * The last date this topic was actually exercised — taught OR recall-checked.
 *
 * A lesson stamps `lastTouched.date` and `recall.last.date` from the same lesson
 * date, so for anything a lesson wrote these agree and this is a no-op. They
 * diverge only for a standalone recall check, which advances the recall clock
 * without claiming the topic was re-taught.
 *
 * ISO dates compare lexically, so a string compare is the whole implementation.
 */
export function lastExercised(t: Topic): string {
  const taught = t.lastTouched?.date ?? "";
  const recalled = t.recall?.last?.date ?? "";
  return recalled > taught ? recalled : taught;
}

/** One graded topic. `state` overrides the automatic miss → shaky demotion. */
export interface RecallGrade {
  topicId: string;
  result: RecallResult;
  state?: TopicState;
}

export interface RecallCheckInput {
  date: string; // YYYY-MM-DD — supplied by the server, never by the model
  grades: RecallGrade[];
}

export interface GradedTopic {
  topicId: string;
  name: string;
  result: RecallResult;
  streak: number;
  nextInDays: number;
  state: TopicState;
}

export interface RecallCheckResult {
  summary: string[];
  graded: GradedTopic[];
}

/**
 * Validate a recall check against current data WITHOUT writing anything.
 * Returns human-readable errors; empty = safe to apply. Mirrors `checkPatch`.
 */
export function checkRecallCheck(paths: DataPaths, input: RecallCheckInput): string[] {
  const errors: string[] = [];
  let c: Curriculum;
  try {
    c = loadCurriculum(paths.curriculum);
  } catch (e) {
    return [`could not load curriculum: ${(e as Error).message}`];
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? "")) {
    errors.push(`date '${input.date}' is not YYYY-MM-DD`);
  }

  const grades = input.grades ?? [];
  if (!grades.length) errors.push("grades must list at least one topic");

  const seen = new Set<string>();
  for (const g of grades) {
    if (seen.has(g.topicId)) errors.push(`grades: topic '${g.topicId}' listed twice`);
    seen.add(g.topicId);
    if (!topicById(c, g.topicId)) errors.push(`grades: topic '${g.topicId}' does not exist`);
    if (!RECALL_RESULTS.includes(g.result)) {
      errors.push(`grades ${g.topicId}: bad result '${g.result}' (clean|rusty|miss)`);
    }
    if (g.state && !TOPIC_STATES.includes(g.state)) {
      errors.push(`grades ${g.topicId}: bad state '${g.state}'`);
    }
  }
  if (errors.length) return errors;

  // Apply to a deep copy and run the graph validator, same belt-and-braces as
  // checkPatch — the only thing that catches a malformed recall block written
  // by a bug rather than by bad input.
  const copy: Curriculum = structuredClone(c);
  for (const g of grades) {
    const hit = topicById(copy, g.topicId)!;
    if (g.state) hit.topic.state = g.state;
    applyRecallGrade(hit.topic, g.result, input.date, g.state);
  }
  errors.push(...validateCurriculum(copy).map((e) => `post-check curriculum invalid: ${e}`));

  return errors;
}

/**
 * Apply a validated recall check: grades the listed topics and writes
 * curriculum.yaml. Touches nothing else — no lesson number, no history entry,
 * no profile, no project, and no `lastTouched`.
 *
 * The caller (server/tutor-tool.ts) is responsible for the git commit, the same
 * way `applySessionPatch` leaves that to its tool — core never shells out.
 */
export function applyRecallCheck(paths: DataPaths, input: RecallCheckInput): RecallCheckResult {
  const pre = checkRecallCheck(paths, input);
  if (pre.length) throw new Error(`recall check rejected:\n  - ${pre.join("\n  - ")}`);

  const c = loadCurriculum(paths.curriculum);
  const graded: GradedTopic[] = [];
  const summary: string[] = [];

  for (const g of input.grades) {
    const hit = topicById(c, g.topicId)!;
    if (g.state) hit.topic.state = g.state;
    applyRecallGrade(hit.topic, g.result, input.date, g.state);

    const { streak } = getRecall(hit.topic);
    const nextInDays = Math.round(stabilityDays(streak));
    graded.push({
      topicId: g.topicId,
      name: hit.topic.name,
      result: g.result,
      streak,
      nextInDays,
      state: hit.topic.state,
    });
    summary.push(
      `${hit.topic.name}: recall ${g.result} (streak ${streak} → next in ${nextInDays}d)` +
        (g.result === "miss" && hit.topic.state === "shaky" ? `, state → shaky` : "")
    );
  }

  saveCurriculum(paths.curriculum, c);
  summary.push(`curriculum.yaml written`);

  return { summary, graded };
}
