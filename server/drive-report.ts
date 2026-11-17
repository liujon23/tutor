// Analysis over the drive-mode diagnostics in <data root>/.app/diag/: what the
// logs say about a drive, or about all of them. Pure aggregation + text
// formatting here; scripts/drive-report.ts is the thin CLI (the same split as
// usage-report.ts). It answers the questions an audit of the logs asks by
// hand: did anything break a rule, where does the wait for a reply go, did the
// prompt cache hold, what did the stream lose and get back.
//
// The log's shape changed once (2026-11): interims used to carry their full
// text, and the state machine repeated four recogniser events under the
// adapter's names. Both shapes are read; the adapter's copy is the one counted
// (it is the one with `session` in its detail).

export interface DiagLine {
  src: "server" | "client";
  /** ISO time; a few client marker lines (diag-dropped) have none. */
  at?: string;
  kind: string;
  level?: string;
  /** The drive phase when a client record was made. */
  state?: string;
  detail?: Record<string, unknown>;
  batch?: string;
  seq?: number;
  /** Length of the line as written, for the size table. */
  bytes: number;
}

export interface DiagSession {
  id: string;
  lines: DiagLine[];
}

/**
 * Parse one diag file. Malformed lines are skipped. A client batch re-sent
 * after a lost ack — or by sendBeacon and then again by the normal flush — is
 * in the file twice; records are de-duplicated by batch id + sequence number.
 */
export function parseDiag(text: string): DiagLine[] {
  const out: DiagLine[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let r: Partial<DiagLine>;
    try {
      r = JSON.parse(line) as Partial<DiagLine>;
    } catch {
      continue;
    }
    if (typeof r.kind !== "string" || (r.src !== "server" && r.src !== "client")) continue;
    if (r.src === "client" && typeof r.batch === "string" && typeof r.seq === "number") {
      const key = `${r.batch}#${r.seq}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push({ ...(r as DiagLine), bytes: raw.length + 1 });
  }
  return out;
}

// --- Small statistics ---------------------------------------------------------

export interface Dist {
  n: number;
  p50: number | null;
  p90: number | null;
  max: number | null;
}

export function dist(values: number[]): Dist {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, p50: null, p90: null, max: null };
  const at = (p: number) => Math.round(v[Math.min(v.length - 1, Math.floor(p * v.length))]);
  return { n: v.length, p50: at(0.5), p90: at(0.9), max: Math.round(v[v.length - 1]) };
}

type Counts = Record<string, number>;
const bump = (c: Counts, key: string, by = 1): void => {
  c[key] = (c[key] ?? 0) + by;
};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const ms = (at: string | undefined): number => (at ? Date.parse(at) : NaN);

// --- The analysis -------------------------------------------------------------

/** A turn whose first API call read nothing from the prompt cache. */
export interface CacheMiss {
  session: string;
  at: string;
  /** Minutes since the session's previous turn. Under an hour is a broken prefix, not an expired cache. */
  gapMin: number;
  cacheCreation: number;
  costUsd: number;
}

export interface DriveAnalysis {
  sessions: number;
  records: number;
  bytes: number;
  from: string | null;
  to: string | null;
  /** Broken rules — these should be zero. */
  invariants: Counts;
  /** Non-info records by `src:kind`, lost dispatches aside (see `stream`). */
  anomalies: Counts;
  turns: {
    spoken: number;
    typed: number;
    withTools: number;
    errors: number;
    costUsd: number;
    /** Send → result, for spoken turns that used no tools. */
    spokenPlainMs: Dist;
    toolTurnMs: Dist;
    commitTurnMs: Dist;
    commitCostUsd: number;
  };
  /** Where the wait between the learner going quiet and the tutor's first word goes. */
  wait: {
    /** The endpointer's silence clock before it submitted. */
    silenceMs: Dist;
    /** Submit → the POST acknowledged (cleanup + send). */
    cleanupAndSendMs: Dist;
    /** Send → the model's first text, spoken turns without tools. */
    firstDeltaMs: Dist;
    /** The server's first text → speech starting on the phone. */
    deltaToSpeechMs: Dist;
    /** Submit → the tutor's first word, turns not interrupted by a pause. */
    submitToSpeechMs: Dist;
  };
  cache: {
    turns: number;
    misses: number;
    /** Misses less than an hour after the previous turn. */
    shortGap: CacheMiss[];
    longGapCostUsd: number;
    /** Inits that listed a tool or MCP server a lesson shouldn't have. */
    unpinnedInits: number;
    inits: number;
    mcpReadyMs: Dist;
  };
  stream: {
    dispatched: number;
    /** Events sent while no client was listening, by type. */
    lost: Counts;
    lostTotal: number;
    /** Gaps the client filled from the transcript. */
    filled: number;
    missedTurnDone: number;
    sseErrors: number;
    sseSilent: number;
    noEcho: number;
    sendFailed: number;
    kicks: number;
  };
  hides: { byPhase: Counts; ms: Dist };
  endpoint: { reasons: Counts; heardMs: Dist };
  recognizer: {
    sessions: number;
    audiostartMs: Dist;
    errors: Counts;
    watchdog: number;
    watchdogSilent: number;
    notAllowed: number;
  };
  speech: { utterances: number; errors: number; timeouts: number; actualVsEstimatePct: Dist };
  cleanup: { runs: number; accepted: number; ms: Dist; fallbacks: Counts };
  bytesByKind: { kind: string; bytes: number; records: number }[];
}

const EXPECTED_TOOLS = new Set(["WebSearch", "WebFetch", "mcp__tutor__commit_session"]);
const isCommitTool = (t: string) => t.includes("commit_session");

export function analyzeDrive(sessions: DiagSession[]): DriveAnalysis {
  const invariants: Counts = {};
  const anomalies: Counts = {};
  const lost: Counts = {};
  const hidesByPhase: Counts = {};
  const reasons: Counts = {};
  const recErrors: Counts = {};
  const fallbacks: Counts = {};
  const byKind = new Map<string, { bytes: number; records: number }>();

  const silence: number[] = [];
  const cleanupAndSend: number[] = [];
  const firstDelta: number[] = [];
  const deltaToSpeech: number[] = [];
  const submitToSpeech: number[] = [];
  const spokenPlain: number[] = [];
  const toolTurn: number[] = [];
  const commitTurn: number[] = [];
  const hideMs: number[] = [];
  const heardMs: number[] = [];
  const audiostart: number[] = [];
  const estimatePct: number[] = [];
  const cleanupMs: number[] = [];
  const mcpReady: number[] = [];
  const shortGap: CacheMiss[] = [];

  let records = 0;
  let bytes = 0;
  let from: string | null = null;
  let to: string | null = null;
  const t = { spoken: 0, typed: 0, withTools: 0, errors: 0, costUsd: 0, commitCostUsd: 0 };
  const c = { turns: 0, misses: 0, longGapCostUsd: 0, unpinnedInits: 0, inits: 0 };
  const s = { dispatched: 0, lostTotal: 0, filled: 0, missedTurnDone: 0, sseErrors: 0, sseSilent: 0, noEcho: 0, sendFailed: 0, kicks: 0 };
  const rec = { sessions: 0, watchdog: 0, watchdogSilent: 0, notAllowed: 0 };
  const sp = { utterances: 0, errors: 0, timeouts: 0 };
  const cl = { runs: 0, accepted: 0 };

  for (const session of sessions) {
    // File order is arrival order: a client batch lands up to 15s after the
    // events in it. Sort by wall clock (stable, so a batch keeps its sequence).
    const lines = session.lines
      .map((l, i) => ({ l, i, at: ms(l.at) }))
      .sort((a, b) => (Number.isNaN(a.at) || Number.isNaN(b.at) || a.at === b.at ? a.i - b.i : a.at - b.at))
      .map((x) => x.l);

    let prevResultAt = NaN;
    let firstResult = true;
    let phase = "off";
    let hiddenAt = NaN;
    let hiddenPhase = "";
    // One learner turn's wait, from ep-submit to the tutor's first utterance.
    let submitAt = NaN;
    let submitInterrupted = false;
    let sendOkSeen = false;
    let firstDeltaAt = NaN;
    let awaitingGen: number | null = null;
    // The server's view of the turn in flight.
    let sendVia: string | null = null;
    let firstDeltaMs: number | undefined;

    for (const r of lines) {
      records++;
      bytes += r.bytes;
      const k = byKind.get(`${r.src}:${r.kind}`) ?? { bytes: 0, records: 0 };
      k.bytes += r.bytes;
      k.records++;
      byKind.set(`${r.src}:${r.kind}`, k);
      if (r.at) {
        if (!from || r.at < from) from = r.at;
        if (!to || r.at > to) to = r.at;
      }
      const d = r.detail ?? {};
      const at = ms(r.at);

      if (r.level === "invariant") bump(invariants, r.kind);
      else if (r.level === "anomaly" && r.kind !== "dispatch") bump(anomalies, `${r.src}:${r.kind}`);

      if (r.src === "server") {
        switch (r.kind) {
          case "dispatch": {
            s.dispatched++;
            if (num(d.listeners) === 0) {
              s.lostTotal++;
              bump(lost, str(d.type) ?? "?");
            }
            break;
          }
          case "send":
            sendVia = str(d.via) ?? null;
            firstDeltaMs = undefined;
            break;
          case "first-delta":
            firstDeltaMs = num(d.msSinceSend);
            firstDeltaAt = at;
            break;
          case "sdk-init": {
            const tools = Array.isArray(d.tools) ? (d.tools as string[]) : null;
            if (!tools) break; // logged without detail before 2026-10-31
            c.inits++;
            const servers = Array.isArray(d.mcpServers) ? (d.mcpServers as { name?: string }[]) : [];
            if (tools.some((x) => !EXPECTED_TOOLS.has(x)) || servers.some((x) => x.name !== "tutor")) c.unpinnedInits++;
            break;
          }
          case "mcp-ready": {
            const w = num(d.waitedMs);
            if (w !== undefined) mcpReady.push(w);
            break;
          }
          case "kick":
            s.kicks++;
            break;
          case "cleanup": {
            cl.runs++;
            if (d.cleaned === true) cl.accepted++;
            else bump(fallbacks, str(d.fallback) ?? "unknown");
            const w = num(d.ms);
            if (w !== undefined) cleanupMs.push(w);
            break;
          }
          case "result": {
            const tokens = (d.tokens ?? {}) as Record<string, unknown>;
            const tools = Array.isArray(d.tools) ? (d.tools as string[]) : [];
            const cost = num(d.costUsd) ?? 0;
            const took = num(d.msSinceSend);
            const via = str(d.via) ?? sendVia ?? "typed";
            t.costUsd += cost;
            if (d.isError === true) {
              t.errors++;
              break; // a failed request: no tokens, nothing to say about the cache
            }
            if (via === "spoken") t.spoken++;
            else t.typed++;
            const committed = tools.some(isCommitTool);
            if (committed) {
              t.commitCostUsd += cost;
              if (took !== undefined) commitTurn.push(took);
            } else if (tools.length) {
              t.withTools++;
              if (took !== undefined) toolTurn.push(took);
            } else if (via === "spoken") {
              if (took !== undefined) spokenPlain.push(took);
              if (firstDeltaMs !== undefined) firstDelta.push(firstDeltaMs);
            }
            // The cache: a turn that read nothing and wrote a whole prompt.
            const read = num(tokens.cacheRead) ?? 0;
            const wrote = num(tokens.cacheCreation) ?? 0;
            c.turns++;
            if (!firstResult && read === 0 && wrote > 5000) {
              c.misses++;
              const gapMin = (at - prevResultAt) / 60_000;
              if (gapMin < 60) shortGap.push({ session: session.id, at: r.at ?? "", gapMin, cacheCreation: wrote, costUsd: cost });
              else c.longGapCostUsd += cost;
            }
            firstResult = false;
            prevResultAt = at;
            break;
          }
        }
        continue;
      }

      // --- client records ---
      switch (r.kind) {
        case "phase": {
          const next = str(d.to);
          if (next === "paused" && !Number.isNaN(submitAt)) submitInterrupted = true;
          if (next && next !== "paused") phase = next;
          break;
        }
        case "visibility": {
          if (d.hidden === true) {
            hiddenAt = at;
            hiddenPhase = phase;
          } else if (!Number.isNaN(hiddenAt)) {
            bump(hidesByPhase, hiddenPhase || "?");
            hideMs.push(at - hiddenAt);
            hiddenAt = NaN;
          }
          break;
        }
        case "ep-submit": {
          bump(reasons, `${str(d.reason) ?? "?"}${d.midSentence === true ? " (mid-sentence)" : ""}`);
          const sil = num(d.silenceMs);
          if (sil !== undefined && d.reason === "silence") silence.push(sil);
          const heard = num(d.heardMs);
          if (heard !== undefined) heardMs.push(heard);
          submitAt = at;
          submitInterrupted = false;
          sendOkSeen = false;
          firstDeltaAt = NaN;
          awaitingGen = null;
          break;
        }
        case "send-ok":
          if (!Number.isNaN(submitAt) && !sendOkSeen) {
            sendOkSeen = true;
            cleanupAndSend.push(at - submitAt);
          }
          break;
        case "speak":
          sp.utterances++;
          if (d.kind === "tutor" && !Number.isNaN(submitAt) && awaitingGen === null) awaitingGen = num(d.gen) ?? null;
          break;
        case "tts-start":
          if (awaitingGen !== null && num(d.gen) === awaitingGen) {
            if (!submitInterrupted) {
              submitToSpeech.push(at - submitAt);
              if (!Number.isNaN(firstDeltaAt) && at >= firstDeltaAt) deltaToSpeech.push(at - firstDeltaAt);
            }
            submitAt = NaN;
            awaitingGen = null;
          }
          break;
        case "spoken": {
          const est = num(d.estMs);
          const actual = num(d.actualMs);
          if (est && actual !== undefined) estimatePct.push((100 * actual) / est);
          break;
        }
        case "utterance-error":
          sp.errors++;
          break;
        case "utterance-timeout":
          sp.timeouts++;
          break;
        case "rec-end":
          if (d.session !== undefined) rec.sessions++;
          break;
        case "rec-audiostart": {
          const lat = num(d.latencyMs);
          if (d.session !== undefined && lat !== undefined) audiostart.push(lat);
          break;
        }
        case "rec-error": {
          const e = str(d.error);
          if (d.session !== undefined && e && e !== "aborted" && e !== "no-speech") bump(recErrors, `${e}${d.message ? ` (${String(d.message)})` : ""}`);
          break;
        }
        case "rec-not-allowed":
          rec.notAllowed++;
          break;
        case "rec-watchdog":
          rec.watchdog++;
          if (d.silent === true) rec.watchdogSilent++;
          break;
        case "fill-gap":
          s.filled++;
          break;
        case "missed-turn-done":
          s.missedTurnDone++;
          break;
        case "sse-error":
          s.sseErrors++;
          break;
        case "sse-silent":
          s.sseSilent++;
          break;
        case "no-echo":
          s.noEcho++;
          break;
        case "send-failed":
          s.sendFailed++;
          break;
      }
    }
  }

  return {
    sessions: sessions.length,
    records,
    bytes,
    from,
    to,
    invariants,
    anomalies,
    turns: {
      ...t,
      spokenPlainMs: dist(spokenPlain),
      toolTurnMs: dist(toolTurn),
      commitTurnMs: dist(commitTurn),
    },
    wait: {
      silenceMs: dist(silence),
      cleanupAndSendMs: dist(cleanupAndSend),
      firstDeltaMs: dist(firstDelta),
      deltaToSpeechMs: dist(deltaToSpeech),
      submitToSpeechMs: dist(submitToSpeech),
    },
    cache: { ...c, shortGap, mcpReadyMs: dist(mcpReady) },
    stream: { ...s, lost },
    hides: { byPhase: hidesByPhase, ms: dist(hideMs) },
    endpoint: { reasons, heardMs: dist(heardMs) },
    recognizer: { ...rec, audiostartMs: dist(audiostart), errors: recErrors },
    speech: { ...sp, actualVsEstimatePct: dist(estimatePct) },
    cleanup: { ...cl, ms: dist(cleanupMs), fallbacks },
    bytesByKind: [...byKind.entries()]
      .map(([kind, v]) => ({ kind, ...v }))
      .sort((a, b) => b.bytes - a.bytes),
  };
}

// --- Text formatting ------------------------------------------------------------

const secs = (v: number | null): string => (v === null ? "—" : v >= 10_000 ? `${Math.round(v / 1000)}s` : `${(v / 1000).toFixed(1)}s`);
const usd = (n: number): string => `$${n.toFixed(2)}`;
const pct = (n: number, of: number): string => (of ? `${Math.round((100 * n) / of)}%` : "—");

function timing(label: string, d: Dist): string {
  return `  ${label.padEnd(34)} ${secs(d.p50).padStart(6)} median · ${secs(d.p90).padStart(6)} p90 · ${secs(d.max).padStart(6)} max  (n=${d.n})`;
}

function countLines(c: Counts, indent = "  "): string[] {
  const rows = Object.entries(c).sort((a, b) => b[1] - a[1]);
  return rows.length ? rows.map(([k, n]) => `${indent}${String(n).padStart(5)}  ${k}`) : [`${indent}    none`];
}

export function formatDriveReport(a: DriveAnalysis): string {
  if (a.records === 0) return "No drive-mode diagnostics found (<data root>/.app/diag/ is empty).\n";
  const out: string[] = [];
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "?");
  out.push("DRIVE REPORT");
  out.push(`${a.sessions} session${a.sessions === 1 ? "" : "s"} · ${day(a.from)} → ${day(a.to)} · ${a.records.toLocaleString("en-US")} records · ${(a.bytes / 1e6).toFixed(1)} MB`);
  out.push("");

  const broken = Object.values(a.invariants).reduce((n, v) => n + v, 0);
  out.push(broken ? `Broken rules: ${broken}` : "Broken rules: none");
  if (broken) out.push(...countLines(a.invariants));
  out.push("");

  out.push("Anomalies");
  out.push(...countLines(a.anomalies));
  out.push("");

  const turns = a.turns.spoken + a.turns.typed;
  out.push(`Turns: ${turns} (${a.turns.spoken} spoken, ${a.turns.typed} typed) · ${a.turns.withTools} with web tools · ${a.turns.errors} failed · ≈ ${usd(a.turns.costUsd)} API-equiv`);
  out.push(timing("spoken turn, no tools", a.turns.spokenPlainMs));
  out.push(timing("turn with web tools", a.turns.toolTurnMs));
  out.push(timing("commit turn", a.turns.commitTurnMs) + ` · ${usd(a.turns.commitCostUsd)} (${pct(a.turns.commitCostUsd, a.turns.costUsd)} of cost)`);
  out.push("");

  out.push("The wait for a reply (learner goes quiet → tutor's first word)");
  out.push(timing("silence clock before submit", a.wait.silenceMs));
  out.push(timing("cleanup + send", a.wait.cleanupAndSendMs));
  out.push(timing("model's first text (after send)", a.wait.firstDeltaMs));
  out.push(timing("first text → speech starts", a.wait.deltaToSpeechMs));
  out.push(timing("submit → first word, in all", a.wait.submitToSpeechMs));
  out.push("");

  const short = a.cache.shortGap;
  out.push(`Prompt cache: ${a.cache.misses} of ${a.cache.turns} turns re-wrote the prompt`);
  out.push(`  after a gap of over an hour: ${a.cache.misses - short.length} (≈ ${usd(a.cache.longGapCostUsd)}) — expected, the cache had expired`);
  out.push(`  within an hour of the last turn: ${short.length}${short.length ? ` (≈ ${usd(short.reduce((n, m) => n + m.costUsd, 0))}) — a changed prompt prefix, worth a look:` : ""}`);
  for (const m of short) out.push(`    ${m.at.slice(0, 16).replace("T", " ")}  ${m.session.slice(0, 8)}  ${m.gapMin.toFixed(1)} min after the previous turn · ${m.cacheCreation.toLocaleString("en-US")} tokens written`);
  out.push(`  tool list at start: ${a.cache.unpinnedInits} of ${a.cache.inits} inits listed a tool or server a lesson shouldn't have`);
  out.push(timing("wait for the tutor tool server", a.cache.mcpReadyMs));
  out.push("");

  out.push(`Stream: ${a.stream.lostTotal} of ${a.stream.dispatched} events (${pct(a.stream.lostTotal, a.stream.dispatched)}) were sent with no client listening`);
  out.push(...countLines(a.stream.lost, "    "));
  out.push(`  recovered by the client: ${a.stream.filled} messages filled from the transcript, ${a.stream.missedTurnDone} missed turn endings`);
  out.push(`  stream errors ${a.stream.sseErrors} · silent ≥60s ${a.stream.sseSilent} · answers not echoed ${a.stream.noEcho} · sends failed ${a.stream.sendFailed} · kicks ${a.stream.kicks}`);
  out.push("");

  const hides = Object.values(a.hides.byPhase).reduce((n, v) => n + v, 0);
  out.push(`Backgrounded ${hides} times (each pauses the drive until a tap) · median ${secs(a.hides.ms.p50)}, longest ${secs(a.hides.ms.max)}`);
  out.push(...countLines(a.hides.byPhase, "    "));
  out.push("");

  out.push("Answers: why each was submitted");
  out.push(...countLines(a.endpoint.reasons, "    "));
  out.push(timing("length of an answer", a.endpoint.heardMs));
  out.push("");

  out.push(`Recogniser: ${a.recognizer.sessions} sessions · mic refused ${a.recognizer.notAllowed} · watchdog fired ${a.recognizer.watchdog} (${a.recognizer.watchdogSilent} handled silently)`);
  out.push(`  mic opened in ${a.recognizer.audiostartMs.p50 ?? "—"}ms median, ${a.recognizer.audiostartMs.p90 ?? "—"}ms p90, ${a.recognizer.audiostartMs.max ?? "—"}ms worst`);
  out.push(...countLines(a.recognizer.errors, "    "));
  out.push("");

  out.push(`Speech: ${a.speech.utterances} utterances · ${a.speech.errors} errors · ${a.speech.timeouts} timeouts · actual length ${a.speech.actualVsEstimatePct.p50 ?? "—"}% of the estimate (median)`);
  out.push(`Cleanup: ${a.cleanup.accepted} of ${a.cleanup.runs} accepted · ${secs(a.cleanup.ms.p50)} median, ${secs(a.cleanup.ms.max)} max${Object.keys(a.cleanup.fallbacks).length ? ` · kept the raw text: ${Object.entries(a.cleanup.fallbacks).map(([k, n]) => `${n} ${k}`).join(", ")}` : ""}`);
  out.push("");

  out.push("Log size by record kind");
  for (const k of a.bytesByKind.slice(0, 8)) {
    out.push(`  ${(k.bytes / 1e6).toFixed(2).padStart(6)} MB  ${pct(k.bytes, a.bytes).padStart(4)}  ${String(k.records).padStart(6)}  ${k.kind}`);
  }
  return out.join("\n") + "\n";
}
