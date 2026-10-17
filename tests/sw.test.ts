// Tests for the PWA service worker (web/public/sw.js), run in a VM against a
// fake cache and network. The bug these lock down (seen in J's server log,
// 2026-10-08): the worker served the cached index.html first, so the first
// open after a rebuild asked for the previous build's /assets/ files — which
// the rebuild had deleted — and the phone showed a broken page until reload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const SW_SOURCE = readFileSync(join(import.meta.dirname, "..", "web", "public", "sw.js"), "utf8");
const ORIGIN = "https://tutor.example";

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
}

const req = (path: string, mode = "no-cors"): FakeRequest => ({ url: ORIGIN + path, method: "GET", mode });
const keyOf = (r: FakeRequest | string) => (typeof r === "string" ? new URL(r, ORIGIN).href : r.url);

/** A worker instance with its own caches and a scriptable network. */
function loadWorker(network: (url: string) => Promise<Response>) {
  const stores = new Map<string, Map<string, Response>>();
  const caches = {
    async open(name: string) {
      let s = stores.get(name);
      if (!s) stores.set(name, (s = new Map()));
      const store = s;
      return {
        async put(r: FakeRequest | string, res: Response) {
          store.set(keyOf(r), res);
        },
        async addAll(paths: string[]) {
          for (const p of paths) store.set(keyOf(p), await network(keyOf(p)));
        },
      };
    },
    async match(r: FakeRequest | string) {
      for (const s of stores.values()) {
        const hit = s.get(keyOf(r));
        if (hit) return hit.clone();
      }
      return undefined;
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
  };
  const handlers = new Map<string, (e: unknown) => void>();
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  runInNewContext(SW_SOURCE, {
    self,
    caches,
    fetch: (r: FakeRequest) => network(r.url),
    Response,
    URL,
    Promise,
    setTimeout,
    clearTimeout,
  });

  const fetchVia = async (r: FakeRequest): Promise<Response | null> => {
    let responded: Promise<Response> | null = null;
    handlers.get("fetch")!({ request: r, respondWith: (p: Promise<Response>) => (responded = p) });
    return responded ? await responded : null;
  };
  const lifecycle = async (type: "install" | "activate") => {
    let wait: Promise<unknown> = Promise.resolve();
    handlers.get(type)!({ waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  };
  return { fetchVia, lifecycle, stores };
}

const page = (build: string) => new Response(`<script src="/assets/index-${build}.js"></script>`, { status: 200 });

test("a page load after a rebuild gets the new HTML, not the cached one", async () => {
  let build = "OLD";
  const w = loadWorker(async (url) => (url.endsWith("/") ? page(build) : new Response("asset", { status: 200 })));
  await w.lifecycle("install");
  await w.lifecycle("activate");
  assert.match(await (await w.fetchVia(req("/", "navigate")))!.text(), /index-OLD/);

  build = "NEW"; // npm run restart rebuilt the web app
  const res = await w.fetchVia(req("/", "navigate"));
  assert.match(await res!.text(), /index-NEW/, "network-first: the fresh page, so its assets exist");
});

test("offline, a page load falls back to the cached page", async () => {
  let online = true;
  const w = loadWorker(async (url) => {
    if (!online) throw new TypeError("network down");
    return url.endsWith("/") ? page("A") : new Response("asset", { status: 200 });
  });
  await w.lifecycle("install");
  online = false;
  assert.match(await (await w.fetchVia(req("/", "navigate")))!.text(), /index-A/);
});

test("a hanging network falls back to the cache after the page timeout", async () => {
  let hang = false;
  const w = loadWorker((url) =>
    hang ? new Promise<Response>(() => undefined) : Promise.resolve(url.endsWith("/") ? page("A") : new Response("x"))
  );
  await w.lifecycle("install");
  hang = true; // a tunnel on the commute: no error, just nothing
  const started = Date.now();
  const res = await w.fetchVia(req("/", "navigate"));
  assert.match(await res!.text(), /index-A/);
  assert.ok(Date.now() - started >= 3900, "waited for the network first");
});

test("hashed assets are cache-first; the API is never intercepted", async () => {
  let calls = 0;
  const w = loadWorker(async () => {
    calls++;
    return new Response("js", { status: 200 });
  });
  await w.fetchVia(req("/assets/index-X.js"));
  await w.fetchVia(req("/assets/index-X.js"));
  assert.equal(calls, 1, "an immutable asset is fetched once");
  assert.equal(await w.fetchVia(req("/api/status")), null, "API requests go straight to the network");
});

test("activating the new worker clears the old caches that held stale HTML", async () => {
  const w = loadWorker(async () => new Response("x", { status: 200 }));
  w.stores.set("tutor-shell-v1", new Map([[ORIGIN + "/", page("STALE")]]));
  await w.lifecycle("install");
  await w.lifecycle("activate");
  assert.deepEqual([...w.stores.keys()], ["tutor-shell-v2"]);
});
