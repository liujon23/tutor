// Feasibility probe for the tutor's claude.ai chat edition. Run it in the
// chat's code sandbox: `node probe.mjs` from this skill's folder. It changes
// nothing in the Project: the kit works on a copy, and the probe's test commit
// writes to /tmp only.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, "tutor-kit.mjs");
const results = [];
const record = (check, ok, detail = "") => {
  results.push({ check, ok, detail });
  console.log(`${ok === null ? "INFO" : ok ? "PASS" : "FAIL"}  ${check}${detail ? ` | ${detail}` : ""}`);
};

function listing(dir, depth = 1) {
  if (!existsSync(dir)) return `${dir}: (absent)`;
  const lines = [];
  const walk = (d, level) => {
    let entries = [];
    try {
      entries = readdirSync(d);
    } catch (e) {
      lines.push(`${"  ".repeat(level)}(unreadable: ${e.code ?? e.message})`);
      return;
    }
    for (const name of entries.slice(0, 40)) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      lines.push(`${"  ".repeat(level)}${name}${st.isDirectory() ? "/" : ` (${st.size} B)`}`);
      if (st.isDirectory() && level < depth) walk(p, level + 1);
    }
  };
  walk(dir, 0);
  return `${dir}:\n${lines.map((l) => "    " + l).join("\n")}`;
}

function kit(args) {
  const r = spawnSync(process.execPath, [KIT, ...args], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  const lines = out.split("\n");
  // The line worth reporting: the kit's own message, or a crash's Error line.
  const why = lines.find((l) => /^(tutor-kit:|PATCH REJECTED|start failed|commit failed|\w*Error\b)/.test(l.trim())) ?? lines[0] ?? "";
  // A patch rejection is the kit working correctly; anything else non-zero is the kit failing.
  return { ok: r.status === 0, out, why: why.trim(), rejected: /PATCH REJECTED/.test(out) };
}

console.log("=== tutor chat-edition probe ===\n");

const [maj, min] = process.versions.node.split(".").map(Number);
record("Node available", true, `v${process.versions.node}`);
record("Node new enough for the kit (18+)", maj >= 18, `v${maj}.${min}`);
record("Kit bundled with this skill", existsSync(KIT), KIT);

console.log("\n--- What the sandbox can see ---");
for (const d of ["/mnt", "/mnt/project", "/mnt/user-data", "/mnt/skills"]) console.log(listing(d, 2));
console.log(`cwd: ${process.cwd()}`);

console.log("\n--- Finding the learner's files ---");
const candidates = ["/mnt/project", "/mnt/user-data/uploads", process.cwd()];
const dataDir = candidates.find((d) => existsSync(join(d, "curriculum.yaml")));
record("Project files visible to code", Boolean(dataDir), dataDir ?? `no curriculum.yaml in ${candidates.join(", ")}`);

if (dataDir && existsSync(KIT)) {
  const v = kit(["validate", "--data", dataDir, "--work", "/tmp/probe-work"]);
  record("kit validate", v.ok, v.ok ? v.out.split("\n")[0] : v.why);

  const today = new Date().toISOString().slice(0, 10);
  const s = kit(["start", "--data", dataDir, "--work", "/tmp/probe-work", "--today", today, "--size", "tight"]);
  record("kit start (session packet)", s.ok, s.ok ? `${s.out.length} chars, ~${Math.round(s.out.length / 4)} tokens` : s.why);

  const patch = join(HERE, "probe-patch.json");
  const d = kit(["commit", "--data", dataDir, "--work", "/tmp/probe-work", "--patch", patch, "--dry-run"]);
  if (d.ok) {
    record("kit commit --dry-run", true);
    const c = kit(["commit", "--data", dataDir, "--work", "/tmp/probe-work", "--out", "/tmp/probe-out", "--patch", patch]);
    record("kit commit (to /tmp only; the Project is untouched)", c.ok, c.ok ? "" : c.why);
  } else if (!d.rejected) {
    record("kit commit --dry-run", false, d.why);
  } else {
    record(
      "kit commit --dry-run",
      null,
      "skipped: the probe patch only fits the unchanged starter courses. Not a failure if these are real courses."
    );
  }

  let bytes = 0;
  for (const f of readdirSync(dataDir)) {
    try {
      bytes += statSync(join(dataDir, f)).size;
    } catch {}
  }
  record("Size of Project files", null, `${bytes} B, ~${Math.round(bytes / 4)} tokens if all loaded into every message`);
}

console.log("\n--- Network (informational: the kit doesn't need it) ---");
for (const url of ["https://registry.npmjs.org/yaml", "https://raw.githubusercontent.com/liujon23/tutor/main/README.md"]) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    record(`reach ${new URL(url).host}`, null, `HTTP ${r.status}`);
  } catch (e) {
    record(`reach ${new URL(url).host}`, null, `blocked or offline (${e.cause?.code ?? e.name})`);
  }
}

const failed = results.filter((r) => r.ok === false).length;
console.log(`\n=== ${failed ? `${failed} check(s) failed` : "all checks passed"} ===`);
