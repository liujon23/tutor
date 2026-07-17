// Session persistence: one JSON file per lesson session under .app/sessions/.
// The commit is the durable record; these files exist so a lesson can be
// resumed mid-flight from any device and survive server restarts.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../scripts/lib.js";
import type { StoredSession, TranscriptEntry } from "./types.js";

const SESSIONS_DIR = PATHS.sessionsDir;

function fileFor(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`bad session id '${id}'`);
  return join(SESSIONS_DIR, `${id}.json`);
}

export function newSessionId(): string {
  return randomUUID();
}

export function saveSession(s: StoredSession): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(fileFor(s.id), JSON.stringify(s, null, 2), "utf8");
}

export function loadSession(id: string): StoredSession | null {
  const f = fileFor(id);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8")) as StoredSession;
}

export function listSessions(): StoredSession[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf8")) as StoredSession)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
  entry.id ??= `m-${randomUUID().slice(0, 8)}`;
  s.transcript.push(entry);
  touchSession(s);
}
