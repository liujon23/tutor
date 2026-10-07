// Session persistence: one JSON file per lesson session under .app/sessions/.
// The commit is the durable record; these files exist so a lesson can be
// resumed mid-flight from any device and survive server restarts.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../scripts/lib.js";
import { isSessionId, serverDiag } from "./diag.js";
import type { StoredSession, TranscriptEntry } from "./types.js";

const SESSIONS_DIR = PATHS.sessionsDir;

function fileFor(id: string): string {
  if (!isSessionId(id)) throw new Error(`bad session id '${id}'`);
  return join(SESSIONS_DIR, `${id}.json`);
}

export function newSessionId(): string {
  return randomUUID();
}

/** A transcript entry's stable handle. Also assigned ahead of time to a streaming message. */
export function newMessageId(): string {
  return `m-${randomUUID().slice(0, 8)}`;
}

/**
 * Write JSON so a crash or power cut mid-write can never leave a torn file:
 * write a sibling temp file, then rename it over the original. A torn session
 * file used to be fatal well beyond its own lesson — listSessions() would
 * throw, taking /api/status and the select screen down with it. If the rename
 * itself fails (Windows can refuse while another process holds the file), fall
 * back to a direct write rather than lose the data, and log it.
 */
export function writeJsonAtomic(file: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, json, "utf8");
  try {
    renameSync(tmp, file);
  } catch (e) {
    serverDiag(null, "atomic-rename-failed", { file, error: (e as Error).message }, "anomaly");
    writeFileSync(file, json, "utf8");
    rmSync(tmp, { force: true });
  }
}

export function saveSession(s: StoredSession): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeJsonAtomic(fileFor(s.id), s);
}

export function loadSession(id: string): StoredSession | null {
  const f = fileFor(id);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8")) as StoredSession;
}

/**
 * Every readable session file in `dir`, newest first. An unreadable one is
 * skipped and reported — one bad file must not hide every other lesson.
 */
export function readSessionFiles(dir: string): StoredSession[] {
  if (!existsSync(dir)) return [];
  const out: StoredSession[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as StoredSession);
    } catch (e) {
      console.error(`skipping unreadable session file ${f}: ${(e as Error).message}`);
      serverDiag(null, "session-file-unreadable", { file: f, error: (e as Error).message }, "anomaly");
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function listSessions(): StoredSession[] {
  return readSessionFiles(SESSIONS_DIR);
}

export function deleteSession(id: string): void {
  rmSync(fileFor(id), { force: true });
}

export function touchSession(s: StoredSession): void {
  s.lastActivityAt = new Date().toISOString();
  saveSession(s);
}

export function appendTranscript(s: StoredSession, entry: TranscriptEntry): void {
  // Every message gets a stable handle — ratings and badges key on it.
  entry.id ??= newMessageId();
  s.transcript.push(entry);
  touchSession(s);
}
