// Asset proxy: fetch-validate-cache-serve for images the tutor embeds.
// One mechanism gives validation (https, image/*, size cap), an on-disk cache
// under .app/assets/, and — at commit time — the file the transcript archiver
// copies into transcripts/assets/. This is a local, single-user proxy on the
// tailnet, so no full SSRF hardening — but loopback/private hosts are blocked
// as cheap insurance.
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { PATHS } from "../scripts/lib.js";
import type { InboundImage } from "./types.js";

export const ASSETS_DIR = PATHS.assetsDir;

const MAX_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
/** Ceiling for the on-disk cache. The route is unauthenticated, so it's also a disk-fill guard. */
const MAX_CACHE_BYTES = 512 * 1024 * 1024;

// SVG is deliberately absent. It is an executable document, and this proxy
// serves cached bytes back from the app's own origin — a navigation to a cached
// SVG would run its script with full access to /api/* and /transcripts/*.
// Lesson artwork is raster, and diagrams render locally through mermaid, so
// nothing real is lost by refusing it outright.
const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
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

/** Is this a literal address the proxy must never reach? Covers IPv4 and IPv6. */
export function isPrivateIp(ip: string): boolean {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];

  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT — this is the tailnet's own range
      a >= 224 // multicast + reserved
    );
  }

  if (h === "::" || h === "::1") return true;
  // IPv4-mapped (::ffff:127.0.0.1) smuggles a v4 address through a v6 literal.
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  // Link-local (fe80::/10) and unique-local (fc00::/7).
  return /^fe[89ab]/.test(h) || /^f[cd]/.test(h);
}

/** Cheap insurance: the proxy must not reach loopback or private-range hosts. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h.includes(":") || h.includes("[")) return true; // IPv6 literals — don't bother classifying
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  return isPrivateIp(h);
}

/**
 * Assert a URL is safe for the proxy to fetch, checking the name AND where it
 * actually points. The name check alone is bypassed by a public hostname with a
 * private A record, so every hop resolves through DNS and every returned
 * address must be public.
 *
 * Residual, accepted: Node's fetch gives no hook to pin the resolved address
 * into the connection, so a TOCTOU rebind between this lookup and the request
 * stays theoretically possible. Closing it would mean hand-rolling the HTTP
 * client — too much machinery for a single-user proxy behind a tailnet.
 */
export async function assertFetchableUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:") throw new Error("https URLs only");
  if (isBlockedHost(url.hostname)) throw new Error(`blocked host '${url.hostname}'`);

  let addresses: { address: string }[];
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new Error(`cannot resolve '${url.hostname}'`);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(`'${url.hostname}' resolves to private address ${address}`);
    }
  }
}

/** Fetch, validate, and cache an image URL. Returns the cached file path; throws on any failure. */
export async function fetchAndCacheAsset(url: string): Promise<string> {
  const parsed = new URL(url); // throws on garbage
  await assertFetchableUrl(parsed);

  const cached = cachedAssetFile(url);
  if (cached) return cached;

  // Redirects are followed by hand so every hop gets the same validation as the
  // first. `redirect: "follow"` would check only the URL we started with, which
  // makes a 302 into a private-network reach-through.
  let target = parsed;
  let res: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await fetch(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get("location");
    if (!location) break; // a 3xx with nowhere to go — fall through to the status check
    if (hop === MAX_REDIRECTS) throw new Error("too many redirects");
    target = new URL(location, target);
    await assertFetchableUrl(target);
  }
  if (!res) throw new Error("no response");
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!(type in EXT_BY_TYPE)) throw new Error(`unsupported image type (${type || "none"})`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new Error("too large");

  mkdirSync(ASSETS_DIR, { recursive: true });
  // Cache under the ORIGINAL url — that's the key callers and the transcript
  // archiver look up, regardless of where redirects landed.
  const file = join(ASSETS_DIR, `${assetHash(url)}.${extForContentType(type)}`);
  writeFileSync(file, buf);
  pruneAssetCache();
  return file;
}

/** Drop the oldest cached assets once the directory passes its ceiling. */
export function pruneAssetCache(maxBytes = MAX_CACHE_BYTES): void {
  let entries: { file: string; size: number; mtime: number }[];
  try {
    entries = readdirSync(ASSETS_DIR)
      // Inbound photos belong to live lessons and aren't re-fetchable — never prune them.
      .filter((f) => !f.startsWith("inbound-"))
      .map((f) => {
        const s = statSync(join(ASSETS_DIR, f));
        return { file: join(ASSETS_DIR, f), size: s.size, mtime: s.mtimeMs };
      });
  } catch {
    return; // cache dir vanished mid-sweep — nothing to do
  }
  let total = entries.reduce((n, e) => n + e.size, 0);
  if (total <= maxBytes) return;
  for (const e of entries.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) break;
    try {
      rmSync(e.file, { force: true });
      total -= e.size;
    } catch {
      /* someone else got there first */
    }
  }
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
  // These bytes came from somewhere else but are served from our origin. The
  // sandbox keeps anything that manages to be a document — now or after a future
  // content-type is added — from running as us.
  reply.header("content-security-policy", "default-src 'none'; sandbox");
  return reply.send(createReadStream(file));
}
