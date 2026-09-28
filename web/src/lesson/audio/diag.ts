// ---------------------------------------------------------------------------
// Client-side diagnostics for drive mode — the one seam every audio module
// logs through. Deliberately over-built (docs/drive-mode-plan.md, Diagnostics):
// this app has one user, so a log line costs nothing, while a silent failure
// on a 30-minute drive costs a lesson. To strip it later, pass
// `enabled: false` (or make these methods no-ops) and leave the call sites.
//
// This module holds records and batches; it does no I/O. The adapter injects
// the clock, persists `pending()` to localStorage, uploads batches, and calls
// `ack()` once the server has them — so a batch written while the tailnet is
// unreachable from the road survives until it can be sent.
//
// IMPORTANT: this module imports nothing (see web/src/lesson/reconcile.ts).
// ---------------------------------------------------------------------------

export type DiagLevel = "info" | "anomaly" | "invariant";

export interface DiagRecord {
  seq: number;
  /** Monotonic ms from the injected clock. */
  t: number;
  /** Wall-clock ISO time, for lining records up with the server's. */
  at: string;
  kind: string;
  level: DiagLevel;
  /** The drive state machine's phase when this was recorded. */
  state: string;
  detail?: unknown;
}

export interface DiagBatch {
  id: string;
  build: string;
  session: string;
  /** Records dropped since the last batch because the outbox was full. */
  dropped: number;
  records: DiagRecord[];
}

export interface DiagOptions {
  /** Monotonic clock (performance.now in the browser). */
  now: () => number;
  /** Wall clock — defaults to building an ISO string from Date. */
  wallClock?: () => string;
  build: string;
  session: string;
  /** The current drive-state phase, stamped on every record. */
  state?: () => string;
  enabled?: boolean;
  /** Records kept in memory for the debug strip. */
  ringSize?: number;
  /** Largest batch handed out by takeBatch(). */
  maxBatch?: number;
  /** Cap on unsent + unacknowledged records, so a long offline drive can't grow without bound. */
  maxBacklog?: number;
}

export interface Diag {
  log(kind: string, detail?: unknown): void;
  /** Something that shouldn't happen but isn't a broken rule. */
  anomaly(kind: string, detail?: unknown): void;
  /** Log loudly and count when `cond` is false. Never throws; returns `cond`. */
  invariant(cond: boolean, name: string, detail?: unknown): boolean;
  /** How many times `key` was seen: a kind, `anomaly:<kind>` or `invariant:<name>`. */
  count(key: string): number;
  readonly counters: Readonly<Record<string, number>>;
  /** The newest `n` records, oldest first. */
  recent(n?: number): DiagRecord[];
  /** Move unsent records into a new pending batch, or null if there are none. */
  takeBatch(): DiagBatch | null;
  /** The server has this batch — forget it. */
  ack(id: string): void;
  /** Batches taken but not yet acknowledged, oldest first (to mirror to storage). */
  pending(): DiagBatch[];
  /** Re-adopt batches left over from an earlier page load. */
  restore(batches: DiagBatch[]): void;
}

export function createDiag(opts: DiagOptions): Diag {
  const enabled = opts.enabled ?? true;
  const ringSize = opts.ringSize ?? 500;
  const maxBatch = opts.maxBatch ?? 400;
  const maxBacklog = opts.maxBacklog ?? 20_000;
  const wall = opts.wallClock ?? (() => new Date().toISOString());
  const counters: Record<string, number> = {};
  const ring: DiagRecord[] = [];
  let outbox: DiagRecord[] = [];
  let pendingBatches: DiagBatch[] = [];
  let seq = 0;
  let batchSeq = 0;
  let dropped = 0;

  const bump = (key: string) => {
    counters[key] = (counters[key] ?? 0) + 1;
  };

  const backlog = () => outbox.length + pendingBatches.reduce((n, b) => n + b.records.length, 0);

  const record = (kind: string, level: DiagLevel, detail: unknown) => {
    if (!enabled) return;
    const r: DiagRecord = {
      seq: ++seq,
      t: Math.round(opts.now()),
      at: wall(),
      kind,
      level,
      state: opts.state?.() ?? "",
      ...(detail === undefined ? {} : { detail }),
    };
    ring.push(r);
    if (ring.length > ringSize) ring.shift();
    if (backlog() >= maxBacklog) {
      // Keep the newest: drop the oldest unsent record, and say so in the next batch.
      if (outbox.length) outbox.shift();
      else pendingBatches[0]?.records.shift();
      dropped++;
      bump("diag:dropped");
    }
    outbox.push(r);
  };

  return {
    log(kind, detail) {
      if (!enabled) return;
      bump(kind);
      record(kind, "info", detail);
    },
    anomaly(kind, detail) {
      if (!enabled) return;
      bump(`anomaly:${kind}`);
      record(kind, "anomaly", detail);
    },
    invariant(cond, name, detail) {
      if (!enabled || cond) return cond;
      bump(`invariant:${name}`);
      record(name, "invariant", detail);
      return cond;
    },
    count(key) {
      return counters[key] ?? 0;
    },
    get counters() {
      return counters;
    },
    recent(n = 20) {
      return ring.slice(-n);
    },
    takeBatch() {
      if (!enabled || outbox.length === 0) return null;
      const records = outbox.slice(0, maxBatch);
      outbox = outbox.slice(records.length);
      const batch: DiagBatch = {
        // Wall time keeps ids unique across page loads (seq restarts at 1).
        id: `${opts.session}-${wall()}-${++batchSeq}`,
        build: opts.build,
        session: opts.session,
        dropped,
        records,
      };
      dropped = 0;
      pendingBatches.push(batch);
      return batch;
    },
    ack(id) {
      pendingBatches = pendingBatches.filter((b) => b.id !== id);
    },
    pending() {
      return pendingBatches;
    },
    restore(batches) {
      const known = new Set(pendingBatches.map((b) => b.id));
      for (const b of batches) if (!known.has(b.id)) pendingBatches.push(b);
    },
  };
}

/** Parse batches mirrored to storage; anything malformed is dropped, never thrown. */
export function parseStoredBatches(raw: string | null): DiagBatch[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (b): b is DiagBatch =>
        typeof b === "object" &&
        b !== null &&
        typeof (b as DiagBatch).id === "string" &&
        Array.isArray((b as DiagBatch).records)
    );
  } catch {
    return [];
  }
}
