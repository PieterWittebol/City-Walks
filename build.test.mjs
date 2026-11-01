// Tests for build.mjs. Run with: node --test
// No network: every test passes its own fake fetch. Not published (build.mjs only copies site files).
process.env.WAIT_SCALE = "0.01"; // 20 s Overpass back-off → 200 ms, 1.5 s Overpass spacing → 15 ms
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { politeFetch, run } = await import("./build.mjs");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

// ---- politeFetch ----

test("a 404 is remembered: the same request isn't sent twice", async () => {
  let calls = 0;
  const f = politeFetch(async () => { calls++; return json({}, 404); });
  const a = await f("https://en.wikipedia.org/api/rest_v1/page/summary/Nope");
  const b = await f("https://en.wikipedia.org/api/rest_v1/page/summary/Nope");
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
  assert.equal(calls, 1);
});

test("a 503 is not remembered: the same request is tried again later", async () => {
  let calls = 0;
  const f = politeFetch(async () => { calls++; return json({}, 503); }, { failMemoryMs: 0 }); // (failure memory would refuse it at once)
  await f("https://www.wikidata.org/w/api.php?x=1");
  const afterFirst = calls;
  await f("https://www.wikidata.org/w/api.php?x=1");
  assert.ok(calls > afterFirst, `expected new requests for the second call, got ${calls} total`);
});

test("aborting during a back-off stops at once, without another request", async () => {
  let calls = 0;
  const f = politeFetch(async (url, opts) => { calls++; if (opts.signal?.aborted) throw abortError(); return json({}, 429); });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10); // back-off after a 429 is 5 s × 0.01 = 50 ms
  const t0 = Date.now();
  await assert.rejects(f("https://en.wikipedia.org/w/api.php?q=1", { signal: ac.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
  assert.ok(Date.now() - t0 < 40, `took ${Date.now() - t0} ms`);
});

test("after the deadline no requests are sent", async () => {
  let calls = 0;
  const f = politeFetch(async () => { calls++; return json({}); }, { deadline: Date.now() - 1 });
  await assert.rejects(f("https://en.wikipedia.org/w/api.php?q=2"), /time budget/);
  assert.equal(calls, 0);
});

test("Overpass gets one request at a time, even when asked concurrently", async () => {
  let inFlight = 0, max = 0;
  const f = politeFetch(async () => { max = Math.max(max, ++inFlight); await new Promise((r) => setTimeout(r, 30)); inFlight--; return json({ elements: [] }); });
  await Promise.all([1, 2, 3].map((i) => f("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + i })));
  assert.equal(max, 1);
});

test("Wikipedia requests may run side by side", async () => {
  let inFlight = 0, max = 0;
  const f = politeFetch(async () => { max = Math.max(max, ++inFlight); await new Promise((r) => setTimeout(r, 30)); inFlight--; return json({}); });
  await Promise.all([1, 2, 3].map((i) => f("https://en.wikipedia.org/w/api.php?q=" + i)));
  assert.ok(max > 1, `max in flight was ${max}`);
});

// ---- politeFetch: slow hosts are skipped ----

const OVERPASS = "https://overpass.private.coffee/api/interpreter";
const post = (n) => ({ method: "POST", body: "data=" + n });

test("a host that times out twice in a row is skipped", async () => {
  let calls = 0;
  const f = politeFetch(async () => { calls++; throw abortError(); });
  await assert.rejects(f(OVERPASS, post(1)), { name: "AbortError" });
  await assert.rejects(f(OVERPASS, post(2)), { name: "AbortError" });
  await assert.rejects(f(OVERPASS, post(3)), /host down/);
  assert.equal(calls, 2);
  assert.deepEqual(f.stats.down, ["overpass.private.coffee"]);
});

test("a success resets the count", async () => {
  let calls = 0;
  const f = politeFetch(async (url, opts) => { calls++; if (/ok/.test(opts.body)) return json({ elements: [] }); throw abortError(); });
  await assert.rejects(f(OVERPASS, { method: "POST", body: "fail1" }));
  await f(OVERPASS, { method: "POST", body: "ok" });
  await assert.rejects(f(OVERPASS, { method: "POST", body: "fail2" }));
  await assert.rejects(f(OVERPASS, { method: "POST", body: "fail3" }), { name: "AbortError" }); // reached baseFetch
  assert.equal(calls, 4);
});

test("a down host comes back after downMs", async () => {
  let calls = 0;
  const f = politeFetch(async () => { calls++; throw abortError(); }, { downMs: 50 });
  await assert.rejects(f(OVERPASS, post(1)));
  await assert.rejects(f(OVERPASS, post(2)));
  await assert.rejects(f(OVERPASS, post(3)), /host down/);
  await new Promise((r) => setTimeout(r, 60));
  await assert.rejects(f(OVERPASS, post(4)), { name: "AbortError" });
  assert.equal(calls, 3);
});

test("a failed request isn't repeated for the next language", async () => {
  let calls = 0;
  const f = politeFetch(async (url, opts) => { calls++; if (opts.body === "data=bad") throw abortError(); return json({ elements: [] }); });
  await assert.rejects(f(OVERPASS, { method: "POST", body: "data=bad" }), { name: "AbortError" });
  await assert.rejects(f(OVERPASS, { method: "POST", body: "data=bad" }), /host down/);
  assert.equal(calls, 1);
  assert.equal((await f(OVERPASS, post(1))).status, 200); // a different request still goes through
});

test("other hosts are unaffected", async () => {
  const seen = [];
  const f = politeFetch(async (url) => { seen.push(url); if (/overpass/.test(url)) throw abortError(); return json({}); });
  await assert.rejects(f("https://overpass-api.de/api/interpreter", post(1)));
  await assert.rejects(f("https://overpass-api.de/api/interpreter", post(2)));
  await assert.rejects(f("https://overpass-api.de/api/interpreter", post(3)), /host down/);
  assert.equal((await f("https://en.wikipedia.org/w/api.php?q=9")).status, 200);
  assert.equal(seen.length, 3);
});

// ---- cache kept between runs ----

test("answers saved by one run are reused by the next, until they're too old", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-cache-"));
  const file = path.join(dir, "http-cache.json");
  let calls = 0;
  const base = async () => { calls++; return json({ ok: calls }); };
  const url = "https://query.wikidata.org/sparql?format=json&query=x";

  const first = politeFetch(base, { cacheFile: file, maxAgeMs: 60_000 });
  await first(url);
  first.save();
  assert.equal(calls, 1);

  const second = politeFetch(base, { cacheFile: file, maxAgeMs: 60_000 });
  assert.deepEqual(await (await second(url)).json(), { ok: 1 });
  assert.equal(calls, 1);

  const expired = politeFetch(base, { cacheFile: file, maxAgeMs: 0 });
  await expired(url);
  assert.equal(calls, 2);
});

// ---- run(): time budget ----

// A small site: two hand-placed walks, plus the app's own modules.
function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cw-root-"));
  for (const f of ["util.js", "sources.js", "schema.js", "builder.js"]) fs.copyFileSync(path.join(HERE, f), path.join(root, f));
  const walk = (id, title) => ({ schema: 2, id, title, lang: "en", stops: [
    { id: "a", title: "Stop A", lat: 51.0543, lon: 3.7253, fixed: true, text: "First stop." },
    { id: "b", title: "Stop B", lat: 51.0560, lon: 3.7270, fixed: true, text: "Second stop." },
  ] });
  fs.writeFileSync(path.join(root, "walk-x-one.json"), JSON.stringify(walk("one", "Walk one")));
  fs.writeFileSync(path.join(root, "walk-x-two.json"), JSON.stringify(walk("two", "Walk two")));
  fs.writeFileSync(path.join(root, "cities.json"), JSON.stringify({ schema: 2, title: "Test", cities: [{ id: "x", name: "X", lat: 51.05, lon: 3.72, walks: [
    { id: "one", file: "walk-x-one.json", title: "Walk one" },
    { id: "two", file: "walk-x-two.json", title: "Walk two" },
  ] }] }));
  return root;
}
// Open data: Overpass answers (nothing found), everything else is "not found".
function fakeOpenData(counter) {
  return async (url) => {
    counter.n++;
    if (/overpass/.test(url)) return json({ elements: [] });
    return json({}, 404);
  };
}
// Serves a previous build's output folder as if it were the published site.
function publishedSite(out, fallback) {
  return async (url, opts) => {
    if (url.startsWith("https://prev.example/")) {
      const p = path.join(out, "built", url.slice("https://prev.example/".length));
      return fs.existsSync(p) ? new Response(fs.readFileSync(p, "utf8"), { status: 200, headers: { "content-type": "application/json" } }) : json({}, 404);
    }
    return fallback(url, opts);
  };
}

test("when the time budget is used up, unchanged walks keep their published data and nothing is looked up", async () => {
  const root = fixtureRoot();
  const out1 = fs.mkdtempSync(path.join(os.tmpdir(), "cw-out1-"));
  const first = { n: 0 };
  await run({ root, out: out1, mode: "full", fetchImpl: fakeOpenData(first), previous: { index: null }, cacheFile: null });
  const prevIndex = JSON.parse(fs.readFileSync(path.join(out1, "built", "index.json"), "utf8"));
  assert.deepEqual(Object.keys(prevIndex.walks).sort(), ["x/one", "x/two"]);
  assert.ok(first.n > 0);

  // walk two changes; then a run with no time left
  const w2 = JSON.parse(fs.readFileSync(path.join(root, "walk-x-two.json"), "utf8"));
  w2.stops[0].text = "Changed.";
  fs.writeFileSync(path.join(root, "walk-x-two.json"), JSON.stringify(w2));
  const out2 = fs.mkdtempSync(path.join(os.tmpdir(), "cw-out2-"));
  const second = { n: 0 };
  await run({ root, out: out2, mode: "full", budgetMs: 0, cacheFile: null,
    fetchImpl: publishedSite(out1, fakeOpenData(second)), previous: { index: prevIndex, base: "https://prev.example/" } });

  assert.equal(second.n, 0, "no open data requests after the budget is used up");
  const index = JSON.parse(fs.readFileSync(path.join(out2, "built", "index.json"), "utf8"));
  assert.deepEqual(Object.keys(index.walks), ["x/one"]); // two changed: phones look it up themselves until the next build
  assert.deepEqual(Object.keys(index.walks["x/one"].files).sort(), ["de", "en", "fr", "nl"]);
  for (const f of Object.values(index.walks["x/one"].files)) assert.ok(fs.existsSync(path.join(out2, "built", f)), f);
});

test("the report shows how long each walk took", async () => {
  const root = fixtureRoot();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cw-out-"));
  const { summary } = await run({ root, out, mode: "full", fetchImpl: fakeOpenData({ n: 0 }), previous: { index: null }, cacheFile: null });
  assert.equal(summary.length, 2);
  for (const row of summary) assert.equal(typeof row.secs, "number");
});
