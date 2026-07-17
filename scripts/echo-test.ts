/**
 * Agent SDK smoke test (PHASE2 build-order step 2): verifies the subscription
 * token / auth path works end to end before the first real lesson.
 *
 * Usage:
 *   npm run echo-test                 # default model (opus)
 *   npm run echo-test -- --model sonnet
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { parseArgs } from "./lib.js";

const args = parseArgs(process.argv.slice(2), { model: "opus" as string });

const auth = process.env.CLAUDE_CODE_OAUTH_TOKEN
  ? "CLAUDE_CODE_OAUTH_TOKEN"
  : process.env.ANTHROPIC_API_KEY
    ? "ANTHROPIC_API_KEY"
    : "no env token (falling back to Claude Code login, if any)";
console.log(`auth source: ${auth}`);
console.log(`model: ${args.model}`);

const q = query({
  prompt: "Reply with exactly: TUTOR ECHO OK",
  options: {
    model: args.model,
    systemPrompt: "You are a connectivity test. Follow the instruction exactly.",
    tools: [],
    maxTurns: 1,
  },
});

let ok = false;
try {
  for await (const msg of q) {
    if (msg.type === "system" && msg.subtype === "init") {
      console.log(`session: ${msg.session_id} (model ${msg.model})`);
    }
    if (msg.type === "result") {
      if (msg.subtype === "success") {
        console.log(`response: ${msg.result.trim()}`);
        console.log(`cost: $${msg.total_cost_usd.toFixed(4)} · ${msg.duration_ms}ms`);
        ok = msg.result.includes("TUTOR ECHO OK");
      } else {
        console.error(`FAILED (${msg.subtype}):`, msg.errors.join("; "));
      }
    }
  }
} catch (e) {
  console.error(`FAILED: ${(e as Error).message}`);
}

console.log(ok ? "echo test PASSED" : "echo test FAILED");
process.exit(ok ? 0 : 1);
