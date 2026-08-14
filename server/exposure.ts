// Startup exposure tripwire.
//
// The app has no authentication: anything that can reach the port can read every
// transcript and spend the Claude subscription. That's a deliberate choice — the
// boundary is `tailscale serve` (tailnet only) plus a loopback bind. But the
// difference between `tailscale serve` and `tailscale funnel` is one word typed
// by hand, and `TUTOR_HOST=0.0.0.0` widens the bind silently. This module is the
// guardrail for both: a funnel on our port refuses startup, a non-loopback bind
// warns loudly, and TUTOR_ALLOW_PUBLIC=1 overrides either.
//
// Every check FAILS OPEN. No tailscale binary, a timeout, a changed output
// format — all are treated as "nothing detected". A security check that can
// brick the app on an unrelated failure is worse than the risk it covers.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const TAILSCALE_TIMEOUT_MS = 2000;

/** Shape of `tailscale serve status --json` (ipn.ServeConfig) — only the parts we read. */
interface ServeConfig {
  AllowFunnel?: Record<string, boolean>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  TCP?: Record<string, { TCPForward?: string }>;
}

export interface ExposureVerdict {
  /** Reasons to refuse startup outright. */
  fatal: string[];
  /** Reasons to complain loudly but keep going. */
  warnings: string[];
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "localhost"]);

/** Does this bind address keep the raw HTTP port off the network? */
export function isLoopbackBind(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(h) || h.startsWith("127.");
}

/**
 * Is a Tailscale Funnel (public internet) fronting our port?
 *
 * Pure over the parsed serve config so it's testable without tailscale. A funnel
 * is only interesting when it actually reaches us, so an entry must be both
 * funnel-enabled AND proxy to our port. The one exception is a funnel we can't
 * trace: `AllowFunnel` set with no matching handler still returns true, because
 * guessing "probably not ours" is the wrong way to be wrong here.
 */
export function funnelTargetsPort(config: ServeConfig, port: number): boolean {
  const funneled = Object.entries(config.AllowFunnel ?? {})
    .filter(([, on]) => on)
    .map(([hostPort]) => hostPort);
  if (funneled.length === 0) return false;

  const proxiesToUs = (target: string | undefined): boolean => {
    if (!target) return false;
    try {
      // Targets appear as "http://127.0.0.1:4321" or bare "localhost:4321".
      const u = new URL(target.includes("://") ? target : `http://${target}`);
      return Number(u.port) === port;
    } catch {
      return target.endsWith(`:${port}`);
    }
  };

  let sawAnyHandler = false;
  for (const hostPort of funneled) {
    for (const h of Object.values(config.Web?.[hostPort]?.Handlers ?? {})) {
      sawAnyHandler = true;
      if (proxiesToUs(h.Proxy)) return true;
    }
    const tcpPort = hostPort.split(":").pop() ?? "";
    const forward = config.TCP?.[tcpPort]?.TCPForward;
    if (forward) {
      sawAnyHandler = true;
      if (proxiesToUs(forward)) return true;
    }
  }
  // Funnel is on but we couldn't see what it points at — assume the worst.
  return !sawAnyHandler;
}

/** Parsed serve config, or null if tailscale isn't there / didn't cooperate. */
async function readServeConfig(): Promise<ServeConfig | null> {
  try {
    const { stdout } = await run("tailscale", ["serve", "status", "--json"], {
      timeout: TAILSCALE_TIMEOUT_MS,
    });
    return JSON.parse(stdout) as ServeConfig;
  } catch {
    return null; // not installed, not running, timed out, or output changed shape
  }
}

/**
 * This machine's tailnet DNS name (e.g. "jlpc.taile1a347.ts.net"), lowercased
 * with the trailing dot stripped. Null when unavailable — callers must cope.
 */
export async function tailnetHostname(): Promise<string | null> {
  try {
    const { stdout } = await run("tailscale", ["status", "--json"], {
      timeout: TAILSCALE_TIMEOUT_MS,
    });
    const name = (JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self?.DNSName;
    const clean = name?.replace(/\.$/, "").trim().toLowerCase();
    return clean || null;
  } catch {
    return null;
  }
}

/** Assess how exposed this server is about to be. */
export async function checkExposure(opts: {
  port: number;
  host: string;
  allowPublic: boolean;
}): Promise<ExposureVerdict> {
  const fatal: string[] = [];
  const warnings: string[] = [];

  const config = await readServeConfig();
  if (config && funnelTargetsPort(config, opts.port)) {
    fatal.push(
      `A Tailscale FUNNEL is serving port ${opts.port}. Funnel is the PUBLIC internet, ` +
        `not just your tailnet — and this app has no login, so anyone who finds the URL ` +
        `could read your transcripts and profile and spend your Claude subscription.\n` +
        `  Fix:  tailscale funnel --https=443 off     (then use: tailscale serve --bg ${opts.port})`
    );
  }

  if (!isLoopbackBind(opts.host)) {
    warnings.push(
      `TUTOR_HOST is '${opts.host}', so the raw HTTP port is open to your whole local ` +
        `network, unencrypted and unauthenticated. The intended setup binds 127.0.0.1 and ` +
        `lets 'tailscale serve' handle TLS and remote access.`
    );
  }

  if (opts.allowPublic && (fatal.length > 0 || warnings.length > 0)) {
    warnings.push(...fatal.splice(0));
    warnings.push("TUTOR_ALLOW_PUBLIC=1 is set — starting anyway.");
  }
  return { fatal, warnings };
}

// --- Host allowlist ---------------------------------------------------------
// Without it, DNS rebinding turns any website the learner visits into a
// same-origin client of this server: the attacker's page resolves its own
// hostname to 127.0.0.1, and the browser's same-origin policy stops protecting
// us. Checking the Host header costs nothing and closes it, because a rebound
// request still carries the attacker's hostname.

/** Hostnames this server will answer to. Loopback plus, when known, the tailnet name. */
export function buildAllowedHosts(opts: {
  tailnetHost?: string | null;
  extra?: string | undefined;
}): Set<string> {
  const hosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (opts.tailnetHost) hosts.add(opts.tailnetHost.toLowerCase());
  for (const h of (opts.extra ?? "").split(",")) {
    const clean = h.trim().toLowerCase();
    if (clean) hosts.add(clean);
  }
  return hosts;
}

/** Does this request's Host header name something we serve? Port is ignored. */
export function isHostAllowed(hostHeader: string | undefined, allowed: Set<string>): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL normalizes an IPv6 literal to bracketed form; accept it either way.
  return allowed.has(hostname) || allowed.has(hostname.replace(/^\[|\]$/g, ""));
}

/** Render a verdict as a banner that's hard to scroll past. */
export function formatVerdict(v: ExposureVerdict): string {
  const rule = "!".repeat(78);
  const lines = [
    ...v.fatal.map((m) => `REFUSING TO START: ${m}`),
    ...v.warnings.map((m) => `WARNING: ${m}`),
  ];
  return `\n${rule}\n${lines.join("\n\n")}\n${rule}\n`;
}
