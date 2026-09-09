/**
 * Child-process probe for tests/git.test.ts.
 *
 * `scripts/lib.ts` resolves the data root at module load from TUTOR_DATA_DIR,
 * so exercising the real commit/amend path means a fresh process per scenario.
 * The test builds the repo; this runs the sequence a lesson would and prints
 * one JSON line describing what happened.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { gitAmendInto, gitCommit, gitHeadSha, PATHS } from "../../scripts/lib.js";

const scenario = process.argv[2] ?? "local";
const touch = (line: string) => appendFileSync(PATHS.profile, `${line}\n`, "utf8");

touch("- a pattern the lesson wrote");
const commitMessage = gitCommit("Lesson 1 — 2026-09-09 — ai-attn-mechanism");
const lessonSha = gitHeadSha();

if (scenario === "published") {
  // Someone (or TUTOR_GIT_PUSH) already handed this commit to a remote.
  execFileSync("git", ["push", "-u", "origin", "HEAD"], { cwd: PATHS.dataRoot, stdio: "pipe" });
}
if (scenario === "moved-head") {
  touch("- an unrelated edit");
  execFileSync("git", ["commit", "-am", "something else"], { cwd: PATHS.dataRoot, stdio: "pipe" });
}

// The learner approves a proposed confirmed pattern after the commit.
touch("- an approved confirmed pattern");
const amendMessage = gitAmendInto(lessonSha ?? undefined);
const fallbackMessage = amendMessage === null ? gitCommit("Approve confirmed pattern(s)") : null;

process.stdout.write(
  JSON.stringify({ commitMessage, lessonSha, amendMessage, fallbackMessage, head: gitHeadSha() })
);
