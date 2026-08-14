// Tests for the boundary pieces: the outbound URL guard on the model's
// WebFetch tool, the asset proxy's SSRF checks, the startup exposure tripwire,
// and the id charset rule that keeps a curriculum id inside its directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFetchUrl, urlFromWebFetchInput } from "../core/url-guard.js";
import { validateCurriculum } from "../core/validator.js";
import { isPrivateIp } from "../server/assets.js";
import { webFetchGate } from "../server/runner.js";
import {
  buildAllowedHosts,
  funnelTargetsPort,
  isHostAllowed,
  isLoopbackBind,
} from "../server/exposure.js";
import type { PreToolUseHookSpecificOutput } from "@anthropic-ai/claude-agent-sdk";
import type { Curriculum } from "../core/types.js";

// --- Outbound URL guard -----------------------------------------------------

test("url guard lets ordinary reference URLs through", () => {
  for (const url of [
    "https://en.wikipedia.org/wiki/Impressionism",
    "https://www.metmuseum.org/art/collection/search/436121",
    "https://arxiv.org/abs/1706.03762",
    "https://www.google.com/search?q=degas+ballet+class",
    "https://plato.stanford.edu/entries/aesthetic-judgment/",
    // A long-but-legitimate CDN path with a content hash in it.
    "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/Claude_Monet.jpg/800px-Claude_Monet.jpg",
  ]) {
    assert.ok(checkFetchUrl(url).ok, `${url} should be allowed`);
  }
});

test("url guard blocks URLs shaped to carry data off-site", () => {
  const payload = "x".repeat(400);
  const cases: [string, RegExp][] = [
    [`https://evil.test/?d=${payload}`, /query string/],
    [`https://evil.test/?a=1&b=${"y".repeat(100)}`, /parameter 'b'/],
    [`https://evil.test/${"z".repeat(200)}`, /path segment/],
    [`https://${"w".repeat(600)}.test/`, /over 512 characters/],
    ["https://user:pass@evil.test/", /embedded credentials/],
    ["ftp://evil.test/x", /not allowed/],
    ["not-a-url", /not a valid absolute URL/],
    ["", /no URL given/],
  ];
  for (const [url, pattern] of cases) {
    const v = checkFetchUrl(url);
    assert.ok(!v.ok, `${url.slice(0, 40)} should be denied`);
    assert.match(v.reason ?? "", pattern);
  }
});

test("url guard blocks request-capture and tunnel hosts", () => {
  for (const host of [
    "webhook.site",
    "abc123.webhook.site",
    "my-tunnel.ngrok.io",
    "x.oast.fun",
    "foo.burpcollaborator.net",
    "test.loca.lt",
  ]) {
    const v = checkFetchUrl(`https://${host}/a`);
    assert.ok(!v.ok, `${host} should be denied`);
    assert.match(v.reason ?? "", /request-capture or tunnel/);
  }
  // The denylist must not swallow lookalike public domains.
  assert.ok(checkFetchUrl("https://notngrok.io/a").ok);
  assert.ok(checkFetchUrl("https://webhook.sites.example.org/a").ok);
});

test("urlFromWebFetchInput reads the url field and tolerates junk", () => {
  assert.equal(urlFromWebFetchInput({ url: "https://a.test" }), "https://a.test");
  for (const junk of [null, undefined, 42, "string", {}, { url: 7 }]) {
    assert.equal(urlFromWebFetchInput(junk), null);
  }
});

test("webFetchGate denies only WebFetch, and only on bad URLs", () => {
  // Untouched: other tools, and fetches that look like real sourcing.
  assert.deepEqual(webFetchGate("WebSearch", { query: "x".repeat(500) }), {});
  assert.deepEqual(webFetchGate("commit_session", { patch: {} }), {});
  assert.deepEqual(webFetchGate("WebFetch", { url: "https://en.wikipedia.org/wiki/Degas" }), {});
  // An unreadable input shape must fail open, not break fetching wholesale.
  assert.deepEqual(webFetchGate("WebFetch", { notAUrl: true }), {});

  const denied = webFetchGate("WebFetch", { url: `https://evil.test/?d=${"x".repeat(400)}` });
  const out = denied.hookSpecificOutput as PreToolUseHookSpecificOutput | undefined;
  assert.equal(out?.permissionDecision, "deny");
  assert.match(out?.permissionDecisionReason ?? "", /outbound URL guard/);
});

// --- Asset proxy SSRF -------------------------------------------------------

test("isPrivateIp classifies v4, v6, and the tailnet's own range", () => {
  for (const ip of [
    "127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254",
    "0.0.0.0", "224.0.0.1", "100.103.244.9", // CGNAT: tailnet peers
    "::1", "::", "fe80::1", "fd00::1", "fc00::1", "::ffff:127.0.0.1",
  ]) {
    assert.ok(isPrivateIp(ip), `${ip} should be private`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "2606:4700::1111"]) {
    assert.ok(!isPrivateIp(ip), `${ip} should be public`);
  }
});

// --- Exposure tripwire ------------------------------------------------------

test("isLoopbackBind separates a local bind from an exposed one", () => {
  for (const h of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost", "LOCALHOST"]) {
    assert.ok(isLoopbackBind(h), `${h} is loopback`);
  }
  for (const h of ["0.0.0.0", "::", "192.168.1.50", "100.103.244.9"]) {
    assert.ok(!isLoopbackBind(h), `${h} is not loopback`);
  }
});

test("funnelTargetsPort fires only when a funnel actually reaches our port", () => {
  const webHandlers = (proxy: string) => ({
    "host.ts.net:443": { Handlers: { "/": { Proxy: proxy } } },
  });

  // Tailnet-only serve — the intended setup, must not trip.
  assert.equal(
    funnelTargetsPort({ Web: webHandlers("http://127.0.0.1:4321") }, 4321),
    false
  );
  // Funnel on, pointed at us — the case worth refusing to start over.
  assert.equal(
    funnelTargetsPort(
      { AllowFunnel: { "host.ts.net:443": true }, Web: webHandlers("http://127.0.0.1:4321") },
      4321
    ),
    true
  );
  // Funnel on, but serving some other app.
  assert.equal(
    funnelTargetsPort(
      { AllowFunnel: { "host.ts.net:443": true }, Web: webHandlers("http://127.0.0.1:9999") },
      4321
    ),
    false
  );
  // Explicitly disabled funnel.
  assert.equal(
    funnelTargetsPort(
      { AllowFunnel: { "host.ts.net:443": false }, Web: webHandlers("http://127.0.0.1:4321") },
      4321
    ),
    false
  );
  // Funnel on with nothing we can trace — assume the worst rather than guess.
  assert.equal(funnelTargetsPort({ AllowFunnel: { "host.ts.net:443": true } }, 4321), true);
  // Raw TCP forward.
  assert.equal(
    funnelTargetsPort(
      { AllowFunnel: { "host.ts.net:443": true }, TCP: { "443": { TCPForward: "127.0.0.1:4321" } } },
      4321
    ),
    true
  );
  assert.equal(funnelTargetsPort({}, 4321), false);
});

// --- Host allowlist ---------------------------------------------------------

test("host allowlist admits loopback and the tailnet name, rejects rebinding", () => {
  const allowed = buildAllowedHosts({ tailnetHost: "jlpc.example.ts.net" });
  for (const h of [
    "127.0.0.1:4321", "localhost:4321", "localhost", "[::1]:4321",
    "jlpc.example.ts.net", "jlpc.example.ts.net:443", "JLPC.EXAMPLE.TS.NET",
  ]) {
    assert.ok(isHostAllowed(h, allowed), `${h} should be allowed`);
  }
  // A rebinding page arrives with its own hostname even though it resolved to us.
  for (const h of ["evil.test", "evil.test:4321", "attacker.example.com", undefined, ""]) {
    assert.ok(!isHostAllowed(h, allowed), `${h} should be rejected`);
  }
});

test("TUTOR_ALLOWED_HOSTS extends the allowlist", () => {
  const allowed = buildAllowedHosts({ tailnetHost: null, extra: "tutor.lan, box.local" });
  assert.ok(isHostAllowed("tutor.lan:4321", allowed));
  assert.ok(isHostAllowed("box.local", allowed));
  assert.ok(isHostAllowed("127.0.0.1:4321", allowed), "loopback survives the override");
  assert.ok(!isHostAllowed("other.lan", allowed));
});

// --- Curriculum id shape ----------------------------------------------------

function curriculumWithLaneId(id: string): Curriculum {
  return {
    lanes: [
      {
        id,
        title: "Test lane",
        units: [
          {
            id: "unit-one",
            title: "Unit",
            state: "in-progress",
            prerequisites: [],
            bridgeTopics: [],
            coreTopics: [
              { id: "topic-one", title: "Topic", state: "not-started", prerequisites: [], buildsToward: [] },
            ],
            optionalTopics: [],
          },
        ],
      },
    ],
  } as unknown as Curriculum;
}

test("validator rejects ids that could climb out of the projects directory", () => {
  // laneId is interpolated into data/projects/<laneId>.md by core/project.ts.
  for (const bad of ["../../etc/passwd", "a/b", "a.b", "Art", "a\\b", "-lead"]) {
    const errors = validateCurriculum(curriculumWithLaneId(bad));
    assert.ok(
      errors.some((e) => e.includes("lowercase letters")),
      `'${bad}' should be rejected, got: ${errors.join("; ") || "no errors"}`
    );
  }
  assert.deepEqual(validateCurriculum(curriculumWithLaneId("art-history")), []);
});
