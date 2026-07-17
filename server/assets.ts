// Asset proxy: fetch-validate-cache-serve for images the tutor embeds.
// One mechanism gives validation (https, image/*, size cap), an on-disk cache
// under .app/assets/, and — at commit time — the file the transcript archiver
// copies into transcripts/assets/. This is a local, single-user proxy on the
// tailnet, so no full SSRF hardening — but loopback/private hosts are blocked
// as cheap insurance.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { PATHS } from "../scripts/lib.js";
import type { InboundImage } from "./types.js";

export const ASSETS_DIR = PATHS.assetsDir;

const MAX_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};
const TYPE_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_TYPE).map(([t, e]) => [e, t])
);

export function assetHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

export function extForContentType(contentType: string): string {
  return EXT_BY_TYPE[contentType] ?? "img";
}

export function contentTypeForFile(file: string): string {
  return TYPE_BY_EXT[extname(file).slice(1)] ?? "application/octet-stream";
}

/**
 * Cached file (absolute path) for a URL, if present. The extension comes from
 * the response content-type, so it isn't knowable up front — scan for the hash.
 */
export function cachedAssetFile(url: string): string | null {
  if (!existsSync(ASSETS_DIR)) return null;
  const prefix = `${assetHash(url)}.`;
  const hit = readdirSync(ASSETS_DIR).find((f) => f.startsWith(prefix));
  return hit ? join(ASSETS_DIR, hit) : null;
}

/** Cheap insurance: the proxy must not reach loopback or private-range hosts. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h.includes(":") || h.includes("[")) return true; // IPv6 literals — don't bother classifying
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Fetch, validate, and cache an image URL. Returns the cached file path; throws on any failure. */
export async function fetchAndCacheAsset(url: string): Promise<string> {
  const parsed = new URL(url); // throws on garbage
  if (parsed.protocol !== "https:") throw new Error("https URLs only");
  if (isBlockedHost(parsed.hostname)) throw new Error(`blocked host '${parsed.hostname}'`);

  const cached = cachedAssetFile(url);
  if (cached) return cached;

  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) throw new Error(`not an image (${type || "no content-type"})`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new Error("too large");

  mkdirSync(ASSETS_DIR, { recursive: true });
  const file = join(ASSETS_DIR, `${assetHash(url)}.${extForContentType(type)}`);
  writeFileSync(file, buf);
  return file;
}

// Inbound photos (the learner → tutor). The session JSON must never hold base64 — the
// image bytes live here, the transcript entry holds the filename.
const INBOUND_NAME_RE = /^inbound-[0-9a-f-]{36}\.(jpg|png|gif|webp)$/;

export function saveInboundImage(img: InboundImage): string {
  mkdirSync(ASSETS_DIR, { recursive: true });
  const name = `inbound-${randomUUID()}.${extForContentType(img.media_type)}`;
  writeFileSync(join(ASSETS_DIR, name), Buffer.from(img.data, "base64"));
  return name;
}

/** Absolute path of a stored inbound image, if the name is well-formed and present. */
export function inboundAssetFile(name: string): string | null {
  if (!INBOUND_NAME_RE.test(name)) return null;
  const file = join(ASSETS_DIR, name);
  return existsSync(file) ? file : null;
}

export function registerAssetRoutes(app: FastifyInstance): void {
  app.get<{ Params: { name: string } }>("/api/assets/local/:name", async (req, reply) => {
    const file = inboundAssetFile(req.params.name);
    if (!file) return reply.code(404).send({ error: "no such asset" });
    return sendAssetFile(reply, file);
  });

  app.get<{ Querystring: { src?: string } }>("/api/assets", async (req, reply) => {
    const src = req.query.src;
    if (!src) return reply.code(400).send({ error: "missing ?src=<url>" });
    let file: string;
    try {
      file = await fetchAndCacheAsset(src);
    } catch (e) {
      req.log.info({ src, err: (e as Error).message }, "asset fetch failed");
      return reply.code(404).send({ error: "asset unavailable" });
    }
    return sendAssetFile(reply, file);
  });
}

export function sendAssetFile(reply: FastifyReply, file: string): FastifyReply {
  reply.header("content-type", contentTypeForFile(file));
  reply.header("cache-control", "public, max-age=31536000, immutable");
  reply.header("x-content-type-options", "nosniff");
  return reply.send(createReadStream(file));
}
