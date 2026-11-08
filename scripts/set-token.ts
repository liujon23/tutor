/**
 * Save your Claude subscription token for the app, then check that it works.
 *
 *   claude setup-token      # prints a long token starting with sk-ant-oat
 *   npm run set-token       # paste it when asked
 *
 * Writes CLAUDE_CODE_OAUTH_TOKEN into .env (creating .env from .env.example if
 * needed, keeping every other line), then runs the echo test against it. The
 * token is read from the keyboard and never echoed, so it doesn't end up on
 * screen or in shell history. Piped input works too: `... | npm run set-token`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { ROOT, cleanPastedToken, upsertEnv } from "./lib.js";

const KEY = "CLAUDE_CODE_OAUTH_TOKEN";

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Piped: read everything.
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  process.stdout.write(prompt);
  let muted = true;
  const sink = new Writable({
    write(chunk, _enc, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output: sink, terminal: true });
  const answer = await new Promise<string>((res) => rl.question("", res));
  muted = false;
  rl.close();
  process.stdout.write("\n");
  return answer;
}

console.log("Paste the token that `claude setup-token` printed, then press Enter.");
console.log("(Nothing will appear as you paste. That's on purpose.)\n");
const token = cleanPastedToken(await readHidden("Token: "));

if (!token) {
  console.error("\n[x] No token received. Run `claude setup-token` first, copy what it prints, and try again.");
  process.exit(1);
}
if (!token.startsWith("sk-ant-")) {
  console.log("\n[!] That doesn't look like a Claude token (they start with sk-ant-). Saving it anyway;");
  console.log("    the check below will tell you whether it works.");
}

const envPath = join(ROOT, ".env");
const examplePath = join(ROOT, ".env.example");
const base = existsSync(envPath)
  ? readFileSync(envPath, "utf8")
  : existsSync(examplePath)
    ? readFileSync(examplePath, "utf8")
    : "";
writeFileSync(envPath, upsertEnv(base, KEY, token));
console.log(`\n[ok] Saved to ${envPath}`);

// Things that would quietly win over the token we just saved.
const envText = readFileSync(envPath, "utf8");
if (/^\s*ANTHROPIC_API_KEY\s*=\s*\S/m.test(envText) || process.env.ANTHROPIC_API_KEY) {
  console.log("[!] An ANTHROPIC_API_KEY is also set. It takes priority over the subscription token,");
  console.log("    so lessons would bill that key. Remove it from .env if you meant to use your plan.");
}
const shellToken = process.env[KEY];
if (shellToken && shellToken !== token) {
  console.log(`[!] Your terminal also has ${KEY} set, and that one wins over .env.`);
  console.log("    Remove it from your shell settings, or the app will keep using the old one.");
}

console.log("\nChecking the token works (a one-line test message)...\n");
const res = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "echo-test.ts"), "--model", "sonnet"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, [KEY]: token },
});
if (res.status === 0) {
  console.log("\n[ok] All set. Start the app with: npm run serve");
} else {
  console.log("\n[x] The token was saved, but the check failed. Run `claude setup-token` again,");
  console.log("    copy the whole token, and re-run `npm run set-token`.");
  process.exit(1);
}
