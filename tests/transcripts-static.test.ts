// /transcripts/ serves lesson markdown and archived images, and nothing else
// from that directory: usage.jsonl (cost ledger), feedback.jsonl (notes about
// the learner) and recall.jsonl (recall grades and their rationale) live
// alongside them. Older @fastify/static versions had
// path / route-guard bypasses (GHSA-83w8-p2f5-377r, GHSA-8pvw-jcv7-9cmj); this
// throws the usual bypass spellings at the real registration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { registerTranscriptsStatic } from "../server/transcripts-static.js";

const SECRET = "PRIVATE-LEDGER-CONTENTS";

async function buildApp() {
  const base = mkdtempSync(join(tmpdir(), "tutor-static-"));
  const transcripts = join(base, "transcripts");
  const web = join(base, "web");
  mkdirSync(join(transcripts, "assets"), { recursive: true });
  mkdirSync(web);
  writeFileSync(join(transcripts, "lesson-001.md"), "# Lesson 1\n");
  writeFileSync(join(transcripts, "assets", "pic.jpg"), "JPEGDATA");
  writeFileSync(join(transcripts, "usage.jsonl"), `{"secret":"${SECRET}"}\n`);
  writeFileSync(join(transcripts, "feedback.jsonl"), `{"secret":"${SECRET}"}\n`);
  writeFileSync(join(transcripts, "recall.jsonl"), `{"secret":"${SECRET}"}\n`);
  writeFileSync(join(web, "index.html"), "<!doctype html>");

  // Same shape as server/index.ts: the PWA at "/" plus the guarded transcripts.
  const app = Fastify();
  await app.register(fastifyStatic, { root: web, prefix: "/" });
  await registerTranscriptsStatic(app, transcripts);
  await app.ready();
  return { app, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("/transcripts/ serves lesson markdown and archived images", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const md = await app.inject({ url: "/transcripts/lesson-001.md" });
    assert.equal(md.statusCode, 200);
    assert.equal(md.body, "# Lesson 1\n");
    const jpg = await app.inject({ url: "/transcripts/assets/pic.jpg" });
    assert.equal(jpg.statusCode, 200);
    assert.equal(jpg.body, "JPEGDATA");
  } finally {
    await app.close();
    cleanup();
  }
});

test("/transcripts/ never serves usage.jsonl, feedback.jsonl or recall.jsonl, however the path is spelled", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const spellings = (f: string) => [
      `/transcripts/${f}`,
      `/transcripts/${f.toUpperCase()}`,
      `/transcripts//${f}`,
      `//transcripts/${f}`,
      `/transcripts/./${f}`,
      `/transcripts/assets/../${f}`,
      `/transcripts/assets/%2e%2e/${f}`,
      `/transcripts/assets/..%2F${f}`,
      `/transcripts/assets%2F..%2F${f}`,
      `/transcripts/%2e/${f}`,
      `/transcripts/${f.replace(".", "%2e")}`,
      `/transcripts/${f}%3F.md`,
      `/transcripts/${f}%23.md`,
      `/transcripts/${f}%00.md`,
      `/transcripts/${f}%2500.md`,
      `/transcripts/${f}/.md`,
      `/transcripts/${f}%2F.md`,
      `/transcripts/${f}%5C.md`,
      `/transcripts/assets%5C..%5C${f}`,
      `/transcripts/${f}?x=.md`,
      `/transcripts/${f};.md`,
      `/TRANSCRIPTS/${f}`,
      `/web/../transcripts/${f}`,
      `/%2e%2e/transcripts/${f}`,
    ];
    for (const f of ["usage.jsonl", "feedback.jsonl", "recall.jsonl"]) {
      for (const url of spellings(f)) {
        const r = await app.inject({ url });
        assert.ok(!r.body.includes(SECRET), `${url} leaked ${f} (status ${r.statusCode})`);
        assert.notEqual(r.statusCode, 200, `${url} returned 200`);
      }
    }
  } finally {
    await app.close();
    cleanup();
  }
});
