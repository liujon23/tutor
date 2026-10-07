// Server-side diagnostics for drive mode: one JSONL file per lesson session
// under <data root>/.app/diag/, holding both what the server saw (runner
// lifecycle, every dispatched event with its listener count, turn timing,
// SSE connects) and the client's uploaded batches. Read afterwards with
// `npm run drive-report`.
//
// Deliberately over-built (docs/drive-mode-plan.md, Diagnostics): this app has
// one user, so a log line costs nothing, while a silent failure on a drive
// costs a lesson. To strip it later, make `serverDiag` a no-op and leave the
// call sites. .app/ never enters git.
//
// Rules: a diag write never throws and never blocks a lesson, and a session id
// is validated before it becomes a filename.
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../scripts/lib.js";

export type DiagLevel = "info" | "anomaly" | "invariant";

/** Session ids are UUIDs (store.ts newSessionId) — the only shape allowed into a path. */
export function isSessionId(id: string): boolean {
  return /^[0-9a-f-]{36}$/.test(id);
}

export interface DiagSink {
  /** Append one record. `sessionId` null goes to the server-wide file. */
  write(sessionId: string | null, record: Record<string, unknown>): void;
  /** The file a session's records land in. */
  fileFor(sessionId: string | null): string;
}

/** Each file stops growing here (one marker line says so) — a runaway loop can't fill the disk. */
export const DEFAULT_MAX_DIAG_BYTES = 25 * 1024 * 1024;

export function createDiagSink(dir: string, maxBytes = DEFAULT_MAX_DIAG_BYTES): DiagSink {
  const sizes = new Map<string, number>();
  const capped = new Set<string>();
  let warned = false;

  const fileFor = (sessionId: string | null): string => {
    if (sessionId !== null && !isSessionId(sessionId)) throw new Error(`bad session id '${sessionId}'`);
    return join(dir, `${sessionId ?? "_server"}.jsonl`);
  };

  return {
    fileFor,
    write(sessionId, record) {
      try {
        const file = fileFor(sessionId);
        if (capped.has(file)) return;
        if (!sizes.has(file)) {
          mkdirSync(dir, { recursive: true });
          let size = 0;
          try {
            size = statSync(file).size;
          } catch {
            /* new file */
          }
          sizes.set(file, size);
        }
        let line = JSON.stringify(record) + "\n";
        const size = sizes.get(file)!;
        if (size + line.length > maxBytes) {
          capped.add(file);
          line = JSON.stringify({ src: "server", at: new Date().toISOString(), kind: "diag-cap-reached", level: "anomaly", detail: { bytes: size } }) + "\n";
        }
        appendFileSync(file, line, "utf8");
        sizes.set(file, size + line.length);
      } catch (e) {
        // Diagnostics must never take a lesson down. Say so once on the console.
        if (!warned) {
          warned = true;
          console.error(`diag write failed (further failures are silent): ${(e as Error).message}`);
        }
      }
    },
  };
}

// Tests run against the configured data root (see tests/server.test.ts), so
// under the node test runner the shared sink writes nothing — a test that
// exercises a logging path must not leave records in J's real diag files.
// Tests of the sink itself build their own with createDiagSink(tempDir).
const sink: DiagSink | null = process.env.NODE_TEST_CONTEXT ? null : createDiagSink(join(PATHS.appDir, "diag"));

/** Record something the server saw. Never throws. */
export function serverDiag(
  sessionId: string | null,
  kind: string,
  detail?: unknown,
  level: DiagLevel = "info"
): void {
  sink?.write(sessionId, {
    src: "server",
    at: new Date().toISOString(),
    kind,
    level,
    ...(detail === undefined ? {} : { detail }),
  });
}

// --- Client batches -----------------------------------------------------------

/** One record as web/src/lesson/audio/diag.ts produces it. */
export interface ClientDiagRecord {
  seq: number;
  t: number;
  at: string;
  kind: string;
  level: string;
  state: string;
  detail?: unknown;
}

export interface ClientDiagBatch {
  id: string;
  build: string;
  session: string;
  dropped: number;
  records: ClientDiagRecord[];
}

const MAX_RECORDS_PER_BATCH = 5000;

/** Validate an uploaded batch's shape. Returns the batch, or an error string. */
export function parseClientBatch(body: unknown, sessionId: string): ClientDiagBatch | string {
  if (typeof body !== "object" || body === null) return "batch must be an object";
  const b = body as Partial<ClientDiagBatch>;
  if (typeof b.id !== "string" || b.id.length === 0 || b.id.length > 200) return "batch id missing";
  if (b.session !== sessionId) return "batch session does not match the URL";
  if (!Array.isArray(b.records)) return "records must be an array";
  if (b.records.length > MAX_RECORDS_PER_BATCH) return `at most ${MAX_RECORDS_PER_BATCH} records per batch`;
  for (const r of b.records) {
    if (typeof r !== "object" || r === null || typeof (r as ClientDiagRecord).kind !== "string") {
      return "every record needs a kind";
    }
  }
  return {
    id: b.id,
    build: typeof b.build === "string" ? b.build : "",
    session: sessionId,
    dropped: typeof b.dropped === "number" ? b.dropped : 0,
    records: b.records as ClientDiagRecord[],
  };
}

/**
 * Append a client batch, one line per record, each tagged with the batch id
 * so a re-sent batch (its ack was lost on the road) can be de-duplicated when
 * the log is read. Batches already written by this process are skipped.
 */
export function createClientBatchWriter(target: DiagSink) {
  const seen = new Map<string, Set<string>>();
  return (sessionId: string, batch: ClientDiagBatch): { written: number; duplicate: boolean } => {
    let ids = seen.get(sessionId);
    if (!ids) seen.set(sessionId, (ids = new Set()));
    if (ids.has(batch.id)) return { written: 0, duplicate: true };
    ids.add(batch.id);
    if (batch.dropped > 0) {
      target.write(sessionId, {
        src: "client",
        batch: batch.id,
        build: batch.build,
        kind: "diag-dropped",
        level: "anomaly",
        detail: { dropped: batch.dropped },
      });
    }
    for (const r of batch.records) {
      target.write(sessionId, { src: "client", batch: batch.id, build: batch.build, ...r });
    }
    return { written: batch.records.length, duplicate: false };
  };
}

export const writeClientBatch = createClientBatchWriter(
  sink ?? { write: () => undefined, fileFor: () => "" }
);
