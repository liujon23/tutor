// Read-only static serving of the archived transcripts directory.
// Kept out of index.ts so tests can mount it on a throwaway Fastify instance.
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

// Lesson markdown and archived images only. The same directory also holds
// usage.jsonl and feedback.jsonl — the cost ledger and distilled notes about the
// learner — which nothing in the UI fetches and which have no business being
// served.
export const SERVABLE_TRANSCRIPT_FILE = /\.(md|jpg|jpeg|png|gif|webp|avif)$/i;

export async function registerTranscriptsStatic(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, {
    root,
    prefix: "/transcripts/",
    decorateReply: false,
    allowedPath: (pathName) => SERVABLE_TRANSCRIPT_FILE.test(pathName),
  });
}
