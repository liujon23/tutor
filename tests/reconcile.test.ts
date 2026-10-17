// Tests for transcript reconciliation — the "what is already on screen"
// bookkeeping the lesson screen uses after an SSE reconnect or a return to the
// foreground. Pure; no browser, no server.
//
// The bug these lock down: the client used to track a COUNT of rendered
// entries. `user` events from another device on the same session were
// deliberately not rendered (the sending device had already drawn them
// locally) and did not bump the count, so a second device's count fell
// permanently behind and every reconcile re-rendered the tail. Wired to audio,
// that becomes the tutor's last reply spoken again on every screen wake.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  entryKey,
  findPendingSend,
  END_TURN_TEXT as CLIENT_END_TURN_TEXT,
  type PendingSendMatch,
} from "../web/src/lesson/reconcile.js";
import { END_TURN_TEXT } from "../server/params.js";

interface Entry {
  id?: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  images?: string[];
}

/** The reconcile loop from web/src/lesson/events.ts, over the pure helpers. */
function reconcile(
  rendered: Set<string>,
  pending: PendingSendMatch[],
  transcript: Entry[]
): string[] {
  const drawn: string[] = [];
  for (const t of transcript) {
    const key = entryKey(t);
    if (rendered.has(key)) continue;
    if (t.role === "user") {
      const i = findPendingSend(pending, t.text, (t.images ?? []).length);
      if (i !== -1) {
        pending.splice(i, 1);
        rendered.add(key);
        continue;
      }
    }
    drawn.push(t.text);
    rendered.add(key);
  }
  return drawn;
}

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

test("entryKey prefers the server id", () => {
  assert.equal(entryKey({ id: "m-abc", role: "user", at: at(1) }), "m-abc");
});

test("entryKey falls back to role@timestamp for pre-id sessions", () => {
  const k = entryKey({ role: "assistant", at: at(2) });
  assert.equal(k, `assistant@${at(2)}`);
  // Stable across calls — that is the only property reconcile needs.
  assert.equal(k, entryKey({ role: "assistant", at: at(2) }));
});

test("entryKey distinguishes two entries sharing a timestamp by role", () => {
  assert.notEqual(entryKey({ role: "user", at: at(3) }), entryKey({ role: "assistant", at: at(3) }));
});

test("findPendingSend matches on text and attachment count", () => {
  const pending: PendingSendMatch[] = [{ text: "hello", imageCount: 0 }];
  assert.equal(findPendingSend(pending, "hello", 0), 0);
  assert.equal(findPendingSend(pending, "hello", 1), -1, "attachment count must agree");
  assert.equal(findPendingSend(pending, "goodbye", 0), -1);
});

test("findPendingSend claims identical texts first-in-first-out", () => {
  const pending: PendingSendMatch[] = [
    { text: "ok", imageCount: 0 },
    { text: "ok", imageCount: 0 },
  ];
  const first = findPendingSend(pending, "ok", 0);
  assert.equal(first, 0);
  pending.splice(first, 1);
  assert.equal(findPendingSend(pending, "ok", 0), 0);
  pending.splice(0, 1);
  assert.equal(findPendingSend(pending, "ok", 0), -1);
});

test("a reconcile after every turn is rendered draws nothing", () => {
  const rendered = new Set(["m-1", "m-2"]);
  const drawn = reconcile(rendered, [], [
    { id: "m-1", role: "user", text: "hi", at: at(1) },
    { id: "m-2", role: "assistant", text: "hello", at: at(2) },
  ]);
  assert.deepEqual(drawn, []);
});

test("reconcile draws only what the stream missed", () => {
  const rendered = new Set(["m-1"]);
  const drawn = reconcile(rendered, [], [
    { id: "m-1", role: "user", text: "hi", at: at(1) },
    { id: "m-2", role: "assistant", text: "missed this", at: at(2) },
  ]);
  assert.deepEqual(drawn, ["missed this"]);
  assert.ok(rendered.has("m-2"), "and remembers it for next time");
});

test("reconcile adopts a send still in flight instead of doubling it", () => {
  // The refetch landed after the server persisted the turn but before its
  // `user` event arrived. The bubble is already on screen.
  const rendered = new Set<string>();
  const pending: PendingSendMatch[] = [{ text: "my answer", imageCount: 0 }];
  const drawn = reconcile(rendered, pending, [
    { id: "m-9", role: "user", text: "my answer", at: at(1) },
  ]);
  assert.deepEqual(drawn, [], "already on screen — must not be drawn again");
  assert.equal(pending.length, 0, "and the optimistic bubble is now claimed");
  assert.ok(rendered.has("m-9"));
});

test("a turn from another device is drawn, not swallowed as a local echo", () => {
  const rendered = new Set<string>();
  const pending: PendingSendMatch[] = [{ text: "mine", imageCount: 0 }];
  const drawn = reconcile(rendered, pending, [
    { id: "m-1", role: "user", text: "mine", at: at(1) },
    { id: "m-2", role: "user", text: "sent from the phone", at: at(2) },
  ]);
  assert.deepEqual(drawn, ["sent from the phone"]);
  assert.equal(pending.length, 0);
});

test("REGRESSION: repeated reconciles never re-render the tail", () => {
  // The exact shape of the old bug. A second device sees `user` events it did
  // not send; under the old counter it never caught up, so each wake redrew
  // everything after its stale position.
  const transcript: Entry[] = [
    { id: "m-1", role: "user", text: "from the other device", at: at(1) },
    { id: "m-2", role: "assistant", text: "the tutor's reply", at: at(2) },
  ];
  const rendered = new Set<string>();
  const first = reconcile(rendered, [], transcript);
  assert.deepEqual(first, ["from the other device", "the tutor's reply"]);

  // visibilitychange fires repeatedly on a mounted phone.
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(reconcile(rendered, [], transcript), [], `wake ${i + 1} drew a duplicate`);
  }
});

test("REGRESSION: a failed send does not skip the next real message", () => {
  // The old code bumped the counter before awaiting the POST and never rolled
  // back, so a failed send left it one too high and reconcile skipped a real
  // message for good — silent in text, inaudible in audio.
  const rendered = new Set<string>();
  const pending: PendingSendMatch[] = [{ text: "never arrived", imageCount: 0 }];
  // The send threw, so the client drops its optimistic bubble.
  pending.splice(0, 1);
  const drawn = reconcile(rendered, pending, [
    { id: "m-1", role: "assistant", text: "a real message", at: at(1) },
  ]);
  assert.deepEqual(drawn, ["a real message"]);
});

test("the End-lesson turn stored for the transcript is a human line", () => {
  // The wrap-up checklist rides along as modelText; storing it as the visible
  // turn put six lines of machinery on screen after any reconcile — and a
  // spoken client would read the whole procedure aloud.
  assert.ok(!END_TURN_TEXT.includes("\n"), "must be a single line");
  assert.ok(END_TURN_TEXT.length < 80, "must be a sentence, not a checklist");
  assert.ok(!/commit_session/.test(END_TURN_TEXT), "must not carry model machinery");
});

test("client and server agree on the End-lesson turn text", () => {
  // The live client renders this turn from the server's `user` event, so a
  // drift is not a correctness bug there — but the demo replay has no server
  // and emits its own copy. If these diverge the Pages demo starts showing a
  // different line than the real app.
  assert.equal(CLIENT_END_TURN_TEXT, END_TURN_TEXT);
});
