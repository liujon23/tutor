// Tests for drive mode's pure modules: markdown → speech (text.ts), the
// endpointer (endpoint.ts), the turn-taking machine (drive-state.ts) and the
// diagnostics seam (diag.ts). No browser, no server.
//
// The rules these lock down are in docs/drive-mode.md; each one exists
// because breaking it is silent in a car — nothing on screen to notice.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PLACEHOLDER,
  NESTED_INTRO,
  createChunker,
  findSigils,
  inlineSpans,
  splitSentences,
  texToWords,
  toSpeech,
} from "../web/src/lesson/audio/text.js";
import {
  DEFAULT_ENDPOINT,
  endsMidSentence,
  initialEndpoint,
  onDone,
  onFinal,
  onInterim,
  onRecognizerEnd,
  onTick,
  type EndpointState,
} from "../web/src/lesson/audio/endpoint.js";
import {
  DriveMachine,
  LINES,
  lastTutorTurn,
  stillWorkingLine,
  type DriveAction,
  type DriveInput,
  type LessonEventIn,
} from "../web/src/lesson/audio/drive-state.js";
import { createDiag, parseStoredBatches } from "../web/src/lesson/audio/diag.js";

const say = (md: string) => toSpeech(md).text;

// ---------------------------------------------------------------------------
// text.ts — currency
// ---------------------------------------------------------------------------

test("currency is spoken as dollars, never swallowed as math", () => {
  // The trap: extractMath-style matching eats everything between the signs.
  // A "no $ survives" assertion would pass on that bug — check the words.
  const t = say("It fell from $50 to $100 last year.");
  assert.equal(t, "It fell from 50 dollars to 100 dollars last year.");
});

test("price ranges and scaled amounts", () => {
  assert.equal(say("Between $5-$10."), "Between 5 dollars to 10 dollars.");
  assert.equal(say("A $1.5M round and a $50k seed."), "A 1.5 million dollars round and a 50 thousand dollars seed.");
  assert.equal(say("It costs $1,000."), "It costs 1,000 dollars.");
  assert.equal(say("Escaped \\$20 too."), "Escaped 20 dollars too.");
});

test("single-number math is still math", () => {
  assert.equal(say("As $p_c \\approx 0$, the loss grows."), "As p sub c is approximately 0, the loss grows.");
  assert.equal(say("It goes to $0$ fast."), "It goes to 0 fast.");
  assert.deepEqual(
    inlineSpans("from $50 to $100").map((s) => s.kind),
    ["currency", "currency"]
  );
  assert.deepEqual(inlineSpans("value $0$ here").map((s) => s.kind), ["math"]);
});

// ---------------------------------------------------------------------------
// text.ts — math verbalizer
// ---------------------------------------------------------------------------

test("inline TeX becomes words", () => {
  assert.equal(texToWords("v_{\\text{king}} - v_{\\text{man}}"), "v sub king minus v sub man");
  assert.equal(texToWords("\\partial L / \\partial a"), "partial L over partial a");
  assert.equal(texToWords("\\hat y"), "y hat");
  assert.equal(texToWords("\\sqrt{\\hat s}"), "the square root of s hat");
  assert.equal(texToWords("\\frac{a}{b}"), "a over b");
  assert.equal(texToWords("x^2 + y^3"), "x squared plus y cubed");
  assert.equal(texToWords("W^T"), "W transpose");
  assert.equal(texToWords("W_h^{(1)}"), "W sub h superscript 1");
  assert.equal(texToWords("\\eta \\nabla L"), "eta grad L");
  assert.equal(texToWords("QK^T"), "Q K transpose");
  assert.equal(texToWords("d_k = 512/8 = 64"), "d sub k equals 512 over 8 equals 64");
  assert.equal(texToWords("[2.0, -1.0, 0.5]"), "2.0, minus 1.0, 0.5");
});

test("unknown TeX commands are spoken by name and noted, not dropped silently", () => {
  const notes: string[] = [];
  assert.equal(texToWords("\\weirdop x", notes), "weirdop x");
  assert.deepEqual(notes, ["tex:unknown \\weirdop"]);
});

test("formula-looking inline code goes through the verbalizer; identifiers lose underscores", () => {
  assert.equal(say("Compute `softmax(QK^T/√d_k)` now."), "Compute softmax Q K transpose over the square root of d sub k now.");
  assert.equal(say("Set `max_len` first."), "Set max len first.");
});

// ---------------------------------------------------------------------------
// text.ts — blocks
// ---------------------------------------------------------------------------

test("tables, code, diagrams, display math and images become placeholders", () => {
  const md = [
    "Intro.",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "```python",
    "print('x')",
    "```",
    "",
    "```mermaid",
    "graph TD; A-->B",
    "```",
    "",
    "$$",
    "x = \\frac{1}{2}",
    "$$",
    "",
    "![a cat](https://example.com/cat.png)",
  ].join("\n");
  const s = toSpeech(md);
  assert.equal(
    s.text,
    ["Intro.", PLACEHOLDER.table, PLACEHOLDER.code, PLACEHOLDER.diagram, PLACEHOLDER.equation, PLACEHOLDER.image].join(" ")
  );
  assert.deepEqual(s.notes, [
    "placeholder:table",
    "placeholder:code",
    "placeholder:diagram",
    "placeholder:equation",
    "placeholder:image",
  ]);
});

test("ordered lists are counted, nested runs are introduced once", () => {
  const md = ["1. First thing", "   - a detail", "   - another detail", "2. Second thing", "3. Third"].join("\n");
  assert.equal(
    say(md),
    `One, First thing. ${NESTED_INTRO} a detail. another detail. Two, Second thing. Three, Third.`
  );
});

test("headings get a stop; links keep their text; URLs are never read", () => {
  assert.equal(say("## The idea\nBody text"), "The idea. Body text.");
  assert.equal(say("See [Mikolov's paper](https://arxiv.org/abs/1301.3781)."), "See Mikolov's paper.");
  assert.equal(say("Source: https://example.com/x_y?z=1"), "Source: a link.");
});

test("emphasis, dashes and fill-in blanks", () => {
  assert.equal(say("**Bold** and *italic* — then _under_."), "Bold and italic, then under.");
  assert.equal(say("**Impressionism was a *secession.***"), "Impressionism was a secession.");
  assert.equal(say("*the $\\tanh$ curve*"), "the tanh curve.");
  assert.equal(say("the water is ___"), "the water is blank.");
  assert.equal(say("pages 3–5"), "pages 3 to 5.");
});

test("no sigil ever survives, and a crude strip is reported", () => {
  const s = toSpeech("weird | pipe and # hash and ~tilde");
  assert.deepEqual(findSigils(s.text), []);
  assert.ok(s.notes.includes("stripped:|"));
  assert.ok(s.notes.includes("stripped:#"));
});

test("sentence splitting respects abbreviations, initials and decimals", () => {
  assert.deepEqual(
    splitSentences("Dr. Smith said e.g. this works. Fig. 3 shows 0.5 and v1.2.3 here. J. Doe agreed. Next one!"),
    ["Dr. Smith said e.g. this works.", "Fig. 3 shows 0.5 and v1.2.3 here.", "J. Doe agreed.", "Next one!"]
  );
  // Periods inside math are not sentence ends.
  assert.deepEqual(splitSentences("We get $x = 0.5. y$ back. Done."), ["We get $x = 0.5. y$ back.", "Done."]);
});

// ---------------------------------------------------------------------------
// text.ts — the streaming chunker
// ---------------------------------------------------------------------------

const CORPUS = [
  "Short.",
  "Para one is here and it is long enough to stand alone as a chunk of speech in the car, honestly it is.\n\nPara two follows it. And a third sentence.",
  "Intro line:\n\n1. First item\n\n2. Second item, loose list\n   - nested\n3. Third\n\nAfter the list, a closing paragraph that wraps it all up nicely for the listener.",
  "Code first:\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nThen prose after the code block, which should be spoken after the placeholder.",
  "## Heading one\nText under heading one that is reasonably long so the chunker has something to cut at a boundary.\n## Heading two\nMore text.",
  "A very long paragraph. ".repeat(40) + "End.",
  "Math $x^2$ and money $50 to $100. Then $$\\frac{a}{b}$$ inline display. Then more words to finish the paragraph well.",
  "| a | b |\n|---|---|\n| 1 | 2 |\n\nText after a table.",
];

function chunkWhole(md: string) {
  const c = createChunker();
  return [...c.push(md), ...c.flush()];
}

function chunkSplit(md: string, sizes: number[]) {
  const c = createChunker();
  const out = [];
  let i = 0;
  let k = 0;
  while (i < md.length) {
    const n = sizes[k++ % sizes.length];
    out.push(...c.push(md.slice(i, i + n)));
    i += n;
  }
  out.push(...c.flush());
  return out;
}

test("streaming equivalence: whole, per-character and odd splits chunk identically", () => {
  for (const md of CORPUS) {
    const whole = chunkWhole(md);
    for (const sizes of [[1], [2, 3, 5], [7], [13, 1, 40]]) {
      assert.deepEqual(chunkSplit(md, sizes), whole, `split ${sizes} of: ${md.slice(0, 40)}`);
    }
  }
});

test("chunks reassemble to the same speech as converting the message at once", () => {
  for (const md of CORPUS) {
    const joined = chunkWhole(md)
      .map((c) => c.md)
      .join("");
    assert.equal(joined, md, "chunks must cover the message exactly, in order");
  }
});

test("the chunker never cuts inside a code fence or a list", () => {
  for (const md of CORPUS) {
    for (const c of chunkWhole(md)) {
      const fences = (c.md.match(/^```/gm) ?? []).length;
      assert.equal(fences % 2, 0, `unbalanced fence in chunk: ${c.md}`);
    }
  }
  const listMd = CORPUS[2];
  const chunks = chunkWhole(listMd).map((c) => c.md);
  const withList = chunks.filter((c) => /^\d\./m.test(c));
  assert.equal(withList.length, 1, "the whole list stays in one chunk");
});

test("long paragraphs are cut at sentence ends, short messages are one chunk", () => {
  assert.equal(chunkWhole("Short.").length, 1);
  const long = chunkWhole(CORPUS[5]);
  assert.ok(long.length > 1);
  for (const c of long.slice(0, -1)) assert.match(c.md.trim(), /\.$/);
});

// ---------------------------------------------------------------------------
// endpoint.ts
// ---------------------------------------------------------------------------

function tickTo(s: EndpointState, from: number, to: number, step = 250) {
  let st = s;
  for (let t = from; t <= to; t += step) {
    const r = onTick(st, t);
    st = r.state;
    if (r.action) return { state: st, action: r.action, at: t };
  }
  return { state: st, action: null, at: to };
}

test("an empty buffer never submits, however much time passes", () => {
  let s = initialEndpoint();
  s = onInterim(s, "   ", 0).state; // empty interims carry no speech
  s = onFinal(s, "", 10).state;
  const r = tickTo(s, 0, 10 * 60_000, 1000);
  assert.equal(r.action, null);
  assert.equal(r.state.phase, "idle");
  assert.equal(onDone(r.state, 600_001).action, null, "Done on an empty buffer is a no-op");
});

test("the silence clock follows interims, not finals", () => {
  let s = initialEndpoint();
  s = onInterim(s, "the", 1000).state;
  s = onInterim(s, "the gradient", 2000).state;
  // 4s after the last interim — not after a final (none has arrived).
  assert.equal(onTick(s, 5999).action, null);
  const r = onTick(s, 6000);
  assert.deepEqual(r.action, { type: "flush" }, "newest words are only interim: stop and wait for the final");
  const f = onFinal(r.state, "the gradient vanishes", 6700);
  assert.equal(f.action?.type, "submit");
  if (f.action?.type === "submit") {
    assert.equal(f.action.text, "the gradient vanishes");
    assert.equal(f.action.trace.reason, "silence");
    assert.equal(f.action.trace.usedInterim, false);
  }
});

test("a flush with no final falls back to the interim at the deadline", () => {
  let s = onInterim(initialEndpoint(), "half a thought", 0).state;
  s = onTick(s, DEFAULT_ENDPOINT.silenceMs).state; // flushing
  assert.equal(s.phase, "flushing");
  const r = onTick(s, DEFAULT_ENDPOINT.silenceMs + DEFAULT_ENDPOINT.flushMs);
  assert.equal(r.action?.type, "submit");
  if (r.action?.type === "submit") {
    assert.equal(r.action.text, "half a thought");
    assert.equal(r.action.trace.usedInterim, true);
  }
});

test("a pause after an unfinished clause waits longer than one after a finished one", () => {
  const { silenceMs, midSentenceMs } = DEFAULT_ENDPOINT;
  assert.ok(midSentenceMs > silenceMs);
  // The first real run's two cut-offs, verbatim.
  assert.equal(endsMidSentence("the science automatically backs the"), true);
  assert.equal(endsMidSentence("the criteria by which that you"), true);
  // A false positive — that answer was finished. It costs 3s of wait, not a cut-off.
  assert.equal(endsMidSentence("and maintain whatever the current explanation is"), true);
  assert.equal(endsMidSentence("Let's do the warm-up"), false);
  assert.equal(endsMidSentence("it’s"), true, "curly apostrophe");
  assert.equal(endsMidSentence(""), false);

  let s = onFinal(onInterim(initialEndpoint(), "a refusal", 0).state, "a refusal to", 500).state;
  assert.equal(onTick(s, 500 + silenceMs).action, null, "mid-sentence: the short clock doesn't fire");
  const r = onTick(s, 500 + midSentenceMs);
  assert.equal(r.action?.type, "submit");
  if (r.action?.type === "submit") {
    assert.equal(r.action.trace.midSentence, true);
    assert.equal(r.action.trace.waitMs, midSentenceMs);
  }
  // Finishing the clause puts the short clock back.
  s = onFinal(s, "accept the winner", 3000).state;
  const done = onTick(s, 3000 + silenceMs);
  assert.equal(done.action?.type, "submit");
  if (done.action?.type === "submit") assert.equal(done.action.trace.midSentence, false);
});

test("finals accumulate across recogniser sessions; a dangling interim is promoted", () => {
  let s = onInterim(initialEndpoint(), "first", 0).state;
  s = onFinal(s, "first part", 800).state;
  s = onInterim(s, "second", 1500).state;
  const end = onRecognizerEnd(s, 1600); // session ended with no final for "second"
  assert.equal(end.promoted, true);
  s = onInterim(end.state, "third", 2000).state; // must not overwrite "second"
  s = onFinal(s, "third bit", 2600).state;
  const r = tickTo(s, 2600, 10_000);
  assert.equal(r.action?.type, "submit");
  if (r.action?.type === "submit") assert.equal(r.action.text, "first part second third bit");
});

test("the cap ends a long answer at its next pause, not mid-word; Done submits at once", () => {
  const { capMs, capPauseMs, capHardMs, silenceMs } = DEFAULT_ENDPOINT;
  assert.ok(capMs >= 180_000, "the 90s cap cut J off mid-sentence");
  // Talking steadily past the cap, a word every second: no pause long enough yet.
  let s = onFinal(onInterim(initialEndpoint(), "a", 0).state, "a", 100).state;
  for (let t = 1000; t <= capMs + 5000; t += 1000) s = onFinal(s, "more", t).state;
  assert.equal(onTick(s, capMs + 5000 + 500).action, null, "mid-flow at the cap: keep listening");
  // A brief pause, shorter than the normal silence clock, now ends it.
  assert.ok(capPauseMs < silenceMs);
  const capped = onTick(s, capMs + 5000 + capPauseMs);
  assert.equal(capped.action?.type, "submit");
  if (capped.action?.type === "submit") {
    assert.equal(capped.action.trace.reason, "cap");
    assert.equal(capped.action.trace.waitMs, capPauseMs);
  }
  // Speech that never pauses (a radio) still ends at the hard backstop.
  let r = onFinal(initialEndpoint(), "x", 0).state;
  for (let t = 500; t < capHardMs; t += 500) r = onFinal(r, "y", t).state;
  assert.equal(onTick(r, capHardMs - 100).action, null);
  const hard = onTick(r, capHardMs);
  assert.equal(hard.action?.type, "submit");
  if (hard.action?.type === "submit") assert.equal(hard.action.trace.reason, "cap");

  const d = onDone(onFinal(initialEndpoint(), "yes", 0).state, 10);
  assert.equal(d.action?.type, "submit");
});

// ---------------------------------------------------------------------------
// drive-state.ts — harness
// ---------------------------------------------------------------------------

/**
 * Drives a DriveMachine the way the adapter will, with a fake speech engine:
 * every `speak` finishes on the next `finishSpeech()`, a `startRecognizer`
 * reaches audiostart on `recStarted()`, and a stop produces `end`.
 */
class Harness {
  m = new DriveMachine();
  now = 0;
  actions: DriveAction[] = [];
  spoken: string[] = [];
  submitted: string[] = [];
  private pendingGen: number | null = null;
  private recRunning = false;

  run(input: DriveInput): DriveAction[] {
    const out = this.m.dispatch(input);
    for (const a of out) {
      this.actions.push(a);
      if (a.type === "speak") {
        this.spoken.push(a.text);
        this.pendingGen = a.gen;
      }
      if (a.type === "cancelSpeech") this.pendingGen = null;
      if (a.type === "submit") this.submitted.push(a.text);
      if (a.type === "startRecognizer") this.recRunning = true;
    }
    // A stop yields `end` straight away, as the real recogniser does.
    if (out.some((a) => a.type === "stopRecognizer" || a.type === "abortRecognizer") && this.recRunning) {
      this.recRunning = false;
      this.run({ type: "rec_end", now: this.now });
    }
    return out;
  }

  at(ms: number): this {
    this.now = ms;
    return this;
  }

  enable(opts: { knownIds?: string[]; turnInFlight?: boolean; fromGesture?: boolean } = {}) {
    return this.run({
      type: "enable",
      now: this.now,
      fromGesture: opts.fromGesture ?? true,
      knownIds: opts.knownIds ?? [],
      turnInFlight: opts.turnInFlight ?? true,
    });
  }

  ev(event: LessonEventIn) {
    return this.run({ type: "event", now: this.now, event });
  }

  tap() {
    return this.run({ type: "tap", now: this.now });
  }

  tick() {
    return this.run({ type: "tick", now: this.now });
  }

  /** Let the current utterance finish (and any that follow, up to `max`). */
  finishSpeech(max = 50) {
    for (let i = 0; i < max && this.pendingGen !== null; i++) {
      const gen = this.pendingGen;
      this.pendingGen = null;
      this.now += 10;
      this.run({ type: "utterance_end", now: this.now, gen });
    }
  }

  recStarted() {
    this.run({ type: "rec_audiostart", now: this.now });
  }

  started(): number {
    return this.actions.filter((a) => a.type === "startRecognizer").length;
  }

  invariants(): DriveAction[] {
    return this.actions.filter((a) => a.type === "diag" && a.level === "invariant");
  }

  diags(kind: string) {
    return this.actions.filter((a) => a.type === "diag" && a.kind === kind);
  }
}

const LONG_PARA = "This is a paragraph long enough to be its own chunk when the tutor streams it to the car. ";

// ---------------------------------------------------------------------------
// drive-state.ts — turn-taking
// ---------------------------------------------------------------------------

test("the mic stays closed when the queue drains mid-turn (web tools)", () => {
  const h = new Harness();
  h.enable();
  h.finishSpeech(); // "Starting."
  h.ev({ type: "delta", id: "m1", text: "Let me check that." });
  h.ev({ type: "assistant", id: "m1", text: "Let me check that." });
  h.finishSpeech();
  h.ev({ type: "tool_use", name: "WebSearch" });
  // Queue drained, but the turn is still in flight: no listening.
  h.at(5_000).tick();
  assert.equal(h.started(), 0);
  assert.equal(h.m.snapshot.phase, "waiting");

  h.ev({ type: "delta", id: "m2", text: "Found it. What do you think?" });
  h.ev({ type: "assistant", id: "m2", text: "Found it. What do you think?" });
  h.finishSpeech();
  assert.equal(h.started(), 0, "still mid-turn until turn_done");
  h.ev({ type: "turn_done", isError: false });
  assert.equal(h.started(), 1, "turn over and queue empty: listen");
  assert.deepEqual(h.invariants(), []);
});

test("consecutive messages in a turn are spoken separately, never run together", () => {
  const h = new Harness();
  h.enable();
  h.finishSpeech();
  h.ev({ type: "delta", id: "m1", text: "Let me check that." });
  h.ev({ type: "assistant", id: "m1", text: "Let me check that." });
  h.ev({ type: "delta", id: "m2", text: "So the answer is yes." });
  h.ev({ type: "assistant", id: "m2", text: "So the answer is yes." });
  h.finishSpeech();
  assert.deepEqual(h.spoken, [LINES.starting, "Let me check that.", "So the answer is yes."]);
});

test("each message is spoken once — the assistant event's text is not re-fed", () => {
  const h = new Harness();
  h.enable();
  h.finishSpeech();
  const text = `${LONG_PARA}\n\n${LONG_PARA}`;
  for (const ch of text) h.ev({ type: "delta", id: "m1", text: ch });
  h.ev({ type: "assistant", id: "m1", text });
  h.finishSpeech();
  const words = h.spoken.slice(1).join(" ");
  assert.equal(words.split("This is a paragraph").length - 1, 2);
});

test("history on screen when audio turns on is never spoken", () => {
  const h = new Harness();
  h.enable({ knownIds: ["m1", "m2"], turnInFlight: false });
  h.finishSpeech();
  h.run({
    type: "reconcile",
    now: h.now,
    entries: [
      { id: "m1", role: "assistant", text: "Old reply." },
      { id: "m2", role: "assistant", text: "Older reply." },
    ],
  });
  assert.deepEqual(h.spoken, [LINES.starting]);
});

// ---------------------------------------------------------------------------
// drive-state.ts — reconcile after an SSE gap
// ---------------------------------------------------------------------------

test("an entry missed entirely during a gap is spoken exactly once", () => {
  const h = new Harness();
  h.enable();
  h.finishSpeech();
  const entries = [{ id: "m9", role: "assistant" as const, text: "You missed this." }];
  h.run({ type: "reconcile", now: h.now, entries, turnInFlight: false });
  h.finishSpeech();
  // The stream comes back and delivers the same message: not spoken twice.
  h.ev({ type: "assistant", id: "m9", text: "You missed this." });
  h.run({ type: "reconcile", now: h.now, entries });
  h.finishSpeech();
  assert.deepEqual(h.spoken.filter((t) => t === "You missed this.").length, 1);
});

test("a half-streamed message resumes from where the stream stopped", () => {
  const h = new Harness();
  h.enable();
  h.finishSpeech();
  const first = LONG_PARA.repeat(2).trim();
  const text = `${first}\n\nThe second paragraph arrived only via reconcile.`;
  const cut = first.length + 2; // the first paragraph and its blank line
  h.ev({ type: "delta", id: "m1", text: text.slice(0, cut + 3) });
  h.finishSpeech();
  assert.equal(h.spoken.length, 2, "the first paragraph was spoken before the gap");
  // SSE drops; the refetch has the whole message.
  h.run({ type: "reconcile", now: h.now, entries: [{ id: "m1", role: "assistant", text }], turnInFlight: false });
  h.finishSpeech();
  const all = h.spoken.join(" ");
  assert.equal(all.split("This is a paragraph").length - 1, 2, "the first paragraph (two sentences) is not repeated");
  assert.equal(all.split("The second paragraph arrived only via reconcile.").length - 1, 1, "the rest is not skipped");
  assert.equal(h.diags("missed-turn-done").length, 1);
  assert.equal(h.started(), 1, "and the turn is treated as over");
});

// ---------------------------------------------------------------------------
// drive-state.ts — taps
// ---------------------------------------------------------------------------

test("skip drops this turn's text, including the rest of the streaming message", () => {
  const h = new Harness();
  h.enable();
  h.finishSpeech();
  h.ev({ type: "delta", id: "m1", text: `${LONG_PARA}\n\n${LONG_PARA}\n\nMore` });
  assert.equal(h.m.snapshot.phase, "speaking");
  h.at(h.now + 1000).tap();
  h.ev({ type: "delta", id: "m1", text: " of the same message." });
  h.ev({ type: "assistant", id: "m1", text: `${LONG_PARA}\n\n${LONG_PARA}\n\nMore of the same message.` });
  h.ev({ type: "delta", id: "m2", text: "A later question?" });
  h.ev({ type: "assistant", id: "m2", text: "A later question?" });
  h.finishSpeech();
  assert.ok(!h.spoken.some((t) => t.includes("More of the same")), "rest of the skipped message dropped");
  assert.ok(h.spoken.includes("A later question?"), "later messages still spoken");
});

test("a tap right after the phase changes is ignored (skip must not become done)", () => {
  const h = new Harness();
  h.enable({ turnInFlight: false });
  h.at(1000).finishSpeech(); // "Starting." ends → listening
  h.recStarted();
  h.run({ type: "rec_final", now: h.now, text: "half an answer" });
  assert.equal(h.m.snapshot.phase, "listening");
  h.at(h.now + 100).tap(); // meant as "skip" for speech that just ended
  assert.deepEqual(h.submitted, []);
  assert.equal(h.diags("tap-ignored").length, 1);
  h.at(h.now + 1000).tap(); // a deliberate Done
  assert.deepEqual(h.submitted, ["half an answer"]);
});

test("Done with nothing heard is a no-op", () => {
  const h = new Harness();
  h.enable({ turnInFlight: false });
  h.finishSpeech();
  h.recStarted();
  h.at(h.now + 5000).tap();
  assert.deepEqual(h.submitted, []);
  assert.equal(h.diags("done-empty").length, 1);
});

test("a tap while the tutor is thinking speaks a status line", () => {
  const h = new Harness();
  h.enable({ turnInFlight: true });
  h.finishSpeech();
  h.at(42_000).tap();
  assert.equal(h.spoken[h.spoken.length - 1], stillWorkingLine(42));
  assert.equal(stillWorkingLine(42), "Still working, about 40 seconds so far.");
});

// ---------------------------------------------------------------------------
// drive-state.ts — the full answer loop and invariants
// ---------------------------------------------------------------------------

test("a spoken answer is submitted once, cues the turn, and awaits its echo", () => {
  const h = new Harness();
  h.enable({ turnInFlight: false });
  h.finishSpeech();
  h.recStarted();
  assert.ok(h.actions.some((a) => a.type === "cue" && a.cue === "listening"), "cued on audiostart");
  h.at(10_000).run({ type: "rec_interim", now: h.now, text: "attention" });
  h.run({ type: "rec_final", now: h.now + 500, text: "attention weights" });
  h.run({ type: "rec_end", now: h.now + 520 }); // the recogniser gives up; it restarts
  assert.equal(h.started(), 2);
  h.at(14_600).tick(); // 4s after the final
  assert.deepEqual(h.submitted, ["attention weights"]);
  assert.ok(h.actions.some((a) => a.type === "cue" && a.cue === "turn-start"));
  // Late final after submit goes to the log, not the next answer.
  h.run({ type: "rec_final", now: h.now, text: "stray" });
  assert.equal(h.diags("late-final").length, 1);
  h.ev({ type: "user", id: "u1", text: "attention weights" });
  assert.equal(h.diags("echo").length, 1);
  assert.deepEqual(h.invariants(), []);
});

test("a cleaned answer's echo is recognised by its cleaned text", () => {
  const h = new Harness();
  h.enable({ turnInFlight: false });
  h.finishSpeech();
  h.recStarted();
  h.at(10_000).run({ type: "rec_final", now: h.now, text: "the tension heads" });
  h.at(14_100).tick();
  assert.deepEqual(h.submitted, ["the tension heads"]);
  h.at(15_000).run({ type: "cleaned", now: h.now, text: "The attention heads.", cleaned: true, ms: 900 });
  h.ev({ type: "user", id: "u1", text: "The attention heads." });
  assert.equal(h.diags("echo").length, 1);
  assert.equal(h.diags("user-elsewhere").length, 0, "not mistaken for a turn from another device");
  // A cleanup that fell back to the raw text is logged as such.
  const g = new Harness();
  g.enable({ turnInFlight: false });
  g.run({ type: "cleaned", now: 0, text: "x", cleaned: false, ms: 10_000, fallback: "timeout" });
  assert.equal(g.actions.filter((a) => a.type === "diag" && a.kind === "cleanup-skipped").length, 1);
});

test("Again replays the tutor's last turn even when drive mode came on after it", () => {
  // The case that logged again-empty three times: a lesson begun in text, then
  // drive mode switched on. The last turn is history (knownIds), not news —
  // it isn't spoken on its own, but Again must still reach it.
  const h = new Harness();
  const transcript = [
    { role: "assistant" as const, text: "Welcome back." },
    { role: "user" as const, text: "go on" },
    { role: "assistant" as const, text: "Let me check that." },
    { role: "assistant" as const, text: "**BERT** reads *both* directions. Which one does GPT read?" },
  ];
  assert.deepEqual(lastTutorTurn(transcript), [transcript[2].text, transcript[3].text]);
  assert.deepEqual(lastTutorTurn([...transcript, { role: "user", text: "left" }]), []);
  h.enable({ turnInFlight: false, knownIds: ["m0", "u0", "m1", "m2"] });
  h.run({ type: "history", now: h.now, lastTurn: lastTutorTurn(transcript) });
  h.finishSpeech(); // "Starting."
  h.recStarted();
  assert.equal(h.spoken.length, 1, "history isn't spoken unasked");
  h.at(5_000).run({ type: "again", now: h.now });
  h.finishSpeech();
  const replay = h.spoken.slice(1).join(" ");
  assert.match(replay, /Let me check that./);
  assert.match(replay, /BERT reads both directions. Which one does GPT read?/);
  assert.equal(h.diags("again-empty").length, 0);
  assert.equal(h.started(), 2, "listening again afterwards");
  // A new learner turn replaces what Again replays.
  h.ev({ type: "user", id: "u1", text: "the left one" });
  h.ev({ type: "assistant", id: "m3", text: "Right." });
  h.ev({ type: "turn_done", isError: false });
  h.finishSpeech();
  const before = h.spoken.length;
  h.at(9_000).run({ type: "again", now: h.now });
  h.finishSpeech();
  assert.deepEqual(h.spoken.slice(before), ["Right."]);
  // From paused (a restore, a locked screen), Again resumes and replays at once.
  h.run({ type: "visibility", now: h.now, hidden: true });
  assert.equal(h.m.snapshot.phase, "paused");
  const pausedAt = h.spoken.length;
  h.at(10_000).run({ type: "again", now: h.now });
  assert.equal(h.m.snapshot.phase, "speaking");
  h.finishSpeech();
  assert.deepEqual(h.spoken.slice(pausedAt), ["Right."], "the replay, with no Resuming. before it");
  // A history answer that lands after a live message is older: ignored.
  h.run({ type: "history", now: h.now, lastTurn: ["stale"] });
  h.at(12_000).run({ type: "again", now: h.now });
  h.finishSpeech();
  assert.deepEqual(h.spoken.slice(-1), ["Right."]);
  assert.deepEqual(h.invariants(), []);
});

test("a cancelled utterance's late error does not advance the queue", () => {
  // iOS can fire onend/onerror for an utterance after cancel(); if that
  // advanced the queue, the next chunk would be skipped unheard.
  const h = new Harness();
  h.enable();
  h.finishSpeech();
  h.ev({ type: "delta", id: "m1", text: `${LONG_PARA}\n\n${LONG_PARA}\n\nTail.` });
  const skipped = h.actions.filter((a) => a.type === "speak").pop() as { gen: number };
  h.at(h.now + 1000).tap(); // skip
  h.ev({ type: "delta", id: "m2", text: "Next message." });
  h.ev({ type: "assistant", id: "m2", text: "Next message." });
  const before = h.spoken.length;
  h.run({ type: "utterance_error", now: h.now, gen: skipped.gen, error: "interrupted" });
  assert.equal(h.diags("stale-utterance-event").length, 1);
  assert.equal(h.spoken.length, before, "the stale event started nothing new");
  h.finishSpeech();
  assert.equal(h.spoken[h.spoken.length - 1], "Next message.");
});

test("a hung turn: health check first, one automatic kick, then ask for a tap", () => {
  const h = new Harness();
  h.enable({ turnInFlight: true });
  h.finishSpeech();
  h.at(121_000).tick();
  assert.equal(h.actions.filter((a) => a.type === "checkHealth").length, 1);
  assert.equal(h.actions.filter((a) => a.type === "submit").length, 0, "never a blind re-POST");
  h.run({ type: "health", now: h.now, report: { alive: true, turnInFlight: true, msSinceLastMessage: 121_000 } });
  assert.equal(h.actions.filter((a) => a.type === "kick").length, 1);
  assert.ok(h.spoken.includes(LINES.kicking));
  h.finishSpeech();
  h.at(250_000).tick();
  h.run({ type: "health", now: h.now, report: { alive: true, turnInFlight: true, msSinceLastMessage: 129_000 } });
  assert.equal(h.m.snapshot.phase, "stuck");
  assert.ok(h.spoken.includes(LINES.stuck));
  h.finishSpeech();
  h.at(h.now + 1000).tap();
  assert.equal(h.actions.filter((a) => a.type === "kick").length, 2, "the tap retries");
});

test("a kick drops the cut-off reply instead of speaking its tail before the fresh one", () => {
  // Seen live (2026-10-08): the kicked runner's half-streamed message never
  // reaches the transcript; the new runner answers from the start.
  const h = new Harness();
  h.enable({ turnInFlight: true });
  h.finishSpeech();
  h.ev({ type: "delta", id: "m-cut", text: "A reply that stalls half way thro" });
  h.at(121_000).tick();
  h.run({ type: "health", now: h.now, report: { alive: true, turnInFlight: true, msSinceLastMessage: 121_000 } });
  h.finishSpeech(); // "The tutor seems stuck. Restarting it."
  h.ev({ type: "delta", id: "m-new", text: "Here is the full answer." });
  h.ev({ type: "assistant", id: "m-new", text: "Here is the full answer." });
  h.ev({ type: "turn_done", isError: false });
  h.finishSpeech();
  assert.ok(!h.spoken.some((t) => t.includes("half way")), "the cut-off tail is never spoken");
  assert.ok(h.spoken.includes("Here is the full answer."));
  assert.equal(h.diags("unflushed-at-turn-done").length, 0);
});

test("health showing the turn finished recovers a lost turn_done", () => {
  const h = new Harness();
  h.enable({ turnInFlight: true });
  h.finishSpeech();
  h.at(121_000).tick();
  h.run({ type: "health", now: h.now, report: { alive: true, turnInFlight: false, msSinceLastMessage: 90_000 } });
  assert.equal(h.actions.filter((a) => a.type === "reconcile").length, 1);
  assert.equal(h.diags("missed-turn-done").length, 1);
});

test("the still-working cue repeats during a long silent turn", () => {
  const h = new Harness();
  h.enable({ turnInFlight: true });
  h.finishSpeech();
  for (let t = 1000; t <= 61_000; t += 1000) h.at(t).tick();
  assert.equal(h.actions.filter((a) => a.type === "cue" && a.cue === "still-working").length, 3);
});

test("backgrounding pauses; the tap resumes and re-speaks the interrupted chunk", () => {
  const h = new Harness();
  h.enable();
  h.finishSpeech();
  h.ev({ type: "delta", id: "m1", text: "Interrupted sentence." });
  h.ev({ type: "assistant", id: "m1", text: "Interrupted sentence." });
  h.run({ type: "visibility", now: h.now, hidden: true });
  assert.equal(h.m.snapshot.phase, "paused");
  h.at(h.now + 5000).tap();
  h.finishSpeech();
  assert.deepEqual(h.spoken.slice(-3), ["Interrupted sentence.", LINES.resuming, "Interrupted sentence."]);
});

test("the recogniser watchdog restarts a mic that went silent without end or error", () => {
  const h = new Harness();
  h.enable({ turnInFlight: false });
  h.finishSpeech();
  h.recStarted();
  h.at(31_000).tick();
  assert.equal(h.diags("rec-watchdog").length, 1);
  assert.ok(h.spoken.includes(LINES.micStalled));
  h.finishSpeech();
  assert.equal(h.started(), 2, "listening again after the notice");
  assert.deepEqual(h.invariants(), []);
});

test("a system line mid-answer keeps the half-said answer, and its clock restarts", () => {
  const h = new Harness();
  h.enable({ turnInFlight: false });
  h.finishSpeech();
  h.recStarted();
  h.at(10_000).run({ type: "rec_interim", now: h.now, text: "the key is" });
  // A usage warning interrupts: speech wins, the mic stops.
  h.ev({ type: "rate_limit", status: "allowed_warning" });
  assert.equal(h.m.snapshot.phase, "speaking");
  h.at(16_000).finishSpeech(); // six seconds of warning
  h.recStarted();
  h.at(17_000).tick();
  assert.deepEqual(h.submitted, [], "the interruption is not the learner going quiet");
  h.run({ type: "rec_interim", now: h.now, text: "the value vector" });
  h.run({ type: "rec_final", now: h.now + 400, text: "the value vector" });
  h.at(21_500).tick(); // 4s after the final
  assert.deepEqual(h.submitted, ["the key is the value vector"]);
});

test("not-allowed (Chrome on iOS) pauses with a spoken explanation, no retry loop", () => {
  const h = new Harness();
  h.enable({ turnInFlight: false });
  h.finishSpeech();
  h.run({ type: "rec_error", now: h.now, error: "not-allowed", message: "Microphone permission check has failed" });
  assert.ok(h.spoken.includes(LINES.micUnavailable));
  for (let t = 1000; t < 20_000; t += 1000) h.at(t).tick();
  assert.equal(h.started(), 1);
});

test("a failed request is announced once, then the mic reopens", () => {
  // The live failure (expired login): api_error, then an error turn_done.
  const h = new Harness();
  h.enable({ turnInFlight: true });
  h.finishSpeech();
  h.ev({ type: "api_error", error: "authentication_failed" });
  h.ev({ type: "turn_done", isError: true });
  h.finishSpeech();
  const errorLines = h.spoken.filter((t) => /error|failed/i.test(t));
  assert.deepEqual(errorLines, ["The tutor hit an error: authentication failed on the host PC."]);
  assert.equal(h.started(), 1, "listening again, so the learner can retry by voice");
});

test("drive mode starts assuming a turn is running; the server's answer opens the mic", () => {
  // Seen in the first browser run: guessing "idle" at a spoken start opened
  // the mic while the opening turn was still running.
  const h = new Harness();
  h.enable({ turnInFlight: true, fromGesture: true });
  h.finishSpeech();
  assert.equal(h.started(), 0, "no mic until the server says the turn is over");
  h.run({ type: "turn_state", now: h.now, turnInFlight: false, source: "health-at-start" });
  assert.equal(h.started(), 1);
  assert.equal(h.actions.filter((a) => a.type === "diag" && a.level !== "info").length, 0, "a correction, not an anomaly");

  const busy = new Harness();
  busy.enable({ turnInFlight: true });
  busy.finishSpeech();
  busy.run({ type: "turn_state", now: busy.now, turnInFlight: true, source: "health-at-start" });
  assert.equal(busy.started(), 0, "a running turn keeps the mic closed");
});

test("commit ends the drive once the close-out is spoken", () => {
  const h = new Harness();
  h.enable();
  h.finishSpeech();
  h.ev({ type: "tool_use", name: "mcp__tutor__commit_session" });
  h.ev({ type: "committed" });
  h.ev({ type: "delta", id: "m5", text: "Committed. Next up: loss functions." });
  h.ev({ type: "assistant", id: "m5", text: "Committed. Next up: loss functions." });
  h.ev({ type: "turn_done", isError: false });
  assert.equal(h.actions.filter((a) => a.type === "finished").length, 0, "not while speaking");
  h.finishSpeech();
  assert.equal(h.actions.filter((a) => a.type === "finished").length, 1);
  assert.equal(h.started(), 0, "no listening after the commit");
});

test("a scripted lesson never starts the recogniser while it's running or while speaking", () => {
  const h = new Harness();
  h.enable();
  h.finishSpeech();
  for (let turn = 0; turn < 5; turn++) {
    h.ev({ type: "delta", id: `a${turn}`, text: `${LONG_PARA}Question ${turn}?` });
    h.ev({ type: "assistant", id: `a${turn}`, text: `${LONG_PARA}Question ${turn}?` });
    h.ev({ type: "turn_done", isError: false });
    h.finishSpeech();
    h.recStarted();
    h.at(h.now + 1000).run({ type: "rec_interim", now: h.now, text: "my" });
    h.run({ type: "rec_end", now: h.now + 1500 }); // recogniser gives up, restarts
    h.recStarted();
    h.run({ type: "rec_final", now: h.now + 1800, text: `answer ${turn}` });
    h.at(h.now + 7000).tick(); // 5.2s after the final
    h.ev({ type: "user", id: `u${turn}`, text: `my answer ${turn}` });
  }
  assert.equal(h.submitted.length, 5);
  assert.deepEqual(h.invariants(), []);
});

// ---------------------------------------------------------------------------
// diag.ts
// ---------------------------------------------------------------------------

test("diag counts, batches, acknowledges and survives a reload", () => {
  let t = 0;
  const d = createDiag({ now: () => t++, wallClock: () => "2026-09-27T00:00:00Z", build: "b1", session: "s1", state: () => "listening" });
  d.log("rec-end");
  d.log("rec-end");
  d.anomaly("utterance-timeout", { gen: 3 });
  assert.equal(d.invariant(true, "never"), true);
  assert.equal(d.invariant(false, "empty-submit", { x: 1 }), false);
  assert.equal(d.count("rec-end"), 2);
  assert.equal(d.count("anomaly:utterance-timeout"), 1);
  assert.equal(d.count("invariant:empty-submit"), 1);
  assert.equal(d.count("invariant:never"), 0);
  assert.equal(d.recent(2)[1].state, "listening");

  const b = d.takeBatch()!;
  assert.equal(b.records.length, 4);
  assert.equal(d.takeBatch(), null, "nothing new to send");
  assert.equal(d.pending().length, 1);

  // Page reload: the mirror is parsed back and adopted.
  const stored = JSON.stringify(d.pending());
  const d2 = createDiag({ now: () => 0, build: "b1", session: "s1" });
  d2.restore(parseStoredBatches(stored));
  assert.equal(d2.pending().length, 1);
  d2.ack(b.id);
  assert.equal(d2.pending().length, 0);
});

test("diag's backlog is capped and reports what it dropped", () => {
  const d = createDiag({ now: () => 0, build: "b", session: "s", maxBacklog: 5 });
  for (let i = 0; i < 8; i++) d.log("x", i);
  const b = d.takeBatch()!;
  assert.equal(b.records.length, 5);
  assert.equal(b.dropped, 3);
  assert.deepEqual(
    b.records.map((r) => r.detail),
    [3, 4, 5, 6, 7]
  );
});

test("stored batches that don't parse are ignored, never thrown", () => {
  assert.deepEqual(parseStoredBatches("{not json"), []);
  assert.deepEqual(parseStoredBatches('{"a":1}'), []);
  assert.deepEqual(parseStoredBatches(null), []);
});

test("a disabled diag is a no-op", () => {
  const d = createDiag({ now: () => 0, build: "b", session: "s", enabled: false });
  d.log("x");
  assert.equal(d.invariant(false, "y"), false);
  assert.equal(d.takeBatch(), null);
  assert.equal(d.count("x"), 0);
});
