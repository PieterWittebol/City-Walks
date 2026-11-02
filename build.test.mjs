// Tests for build.mjs. Run with: node --test
// No network: every test passes its own fake fetch. Not published (build.mjs only copies site files).
process.env.WAIT_SCALE = "0.02"; // 20 s Overpass back-off → 400 ms, 1.5 s Overpass spacing → 30 ms
delete process.env.GITHUB_STEP_SUMMARY; // tests must not write to a real Actions summary
process.env.RETRY_WAIT_MS = "0"; // no 60 s pause before the retry round
const realLog = console.log;
console.log = () => {}; // quiet: run() prints progress and ::warning:: lines
process.on("exit", () => { console.log = realLog; });
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

test("a 503 is not cached: the same request is tried again later", async () => {
  let calls = 0;
  const f = politeFetch(async () => { calls++; return json({}, 503); });
  await f("https://www.wikidata.org/w/api.php?x=1");
  const afterFirst = calls;
  await f("https://www.wikidata.org/w/api.php?x=1");
  assert.ok(calls > afterFirst, `expected new requests for the second call, got ${calls} total`);
});

test("aborting during a back-off stops at once, without another request", async () => {
  let calls = 0;
  const f = politeFetch(async (url, opts) => { calls++; if (opts.signal?.aborted) throw abortError(); return json({}, 429); });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10); // back-off after a 429 from Overpass is 20 s × 0.02 = 400 ms
  const t0 = Date.now();
  await assert.rejects(f("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=1", signal: ac.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
  // without the abort it would take at least the full 400 ms back-off; the rest is slack for a busy CI runner
  assert.ok(Date.now() - t0 < 380, `took ${Date.now() - t0} ms (a full back-off is 400 ms)`);
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
  const f = politeFetch(async () => { calls++; throw abortError(); }, { downMs: 400 }); // roomy, so a busy CI runner can't flake it
  await assert.rejects(f(OVERPASS, post(1)));
  await assert.rejects(f(OVERPASS, post(2)));
  await assert.rejects(f(OVERPASS, post(3)), /host down/);
  await new Promise((r) => setTimeout(r, 500));
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

test("forgetting failures lets a down host be tried again", async () => {
  let calls = 0;
  const f = politeFetch(async () => { calls++; throw abortError(); });
  await assert.rejects(f(OVERPASS, post(1)), { name: "AbortError" });
  await assert.rejects(f(OVERPASS, post(2)), { name: "AbortError" });
  await assert.rejects(f(OVERPASS, post(3)), /host down/);
  assert.equal(calls, 2);
  f.forgetFailures();
  await assert.rejects(f(OVERPASS, post(1)), { name: "AbortError" }); // a request that failed before
  await assert.rejects(f(OVERPASS, post(4)), { name: "AbortError" }); // a new one
  assert.equal(calls, 4);
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

test("only Overpass hosts are skipped: other services are always tried", async () => {
  let calls = 0;
  const f = politeFetch(async () => { calls++; throw abortError(); });
  const url = "https://en.wikipedia.org/w/api.php?q=1";
  await assert.rejects(f(url), { name: "AbortError" });
  await assert.rejects(f("https://en.wikipedia.org/w/api.php?q=2"), { name: "AbortError" });
  await assert.rejects(f("https://en.wikipedia.org/w/api.php?q=3"), { name: "AbortError" });
  await assert.rejects(f(url), { name: "AbortError" }); // the same failed request is sent again too
  assert.equal(calls, 4);
  assert.deepEqual(f.stats.down, []);
});

test("giving up during a back-off counts as a failure", async () => {
  let calls = 0;
  const f = politeFetch(async () => { calls++; return json({}, 503); });
  for (const n of [1, 2]) {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(f(OVERPASS, { method: "POST", body: "data=" + n, signal: ac.signal }), { name: "AbortError" });
  }
  await assert.rejects(f(OVERPASS, post(3)), /host down/);
  assert.equal(calls, 2);
});

test("a freed slot goes to the request that was waiting, not to a newcomer", async () => {
  const order = [];
  const f = politeFetch(async (url, opts) => { order.push(opts.body); await new Promise((r) => setTimeout(r, 20)); return json({ elements: [] }); });
  const a = f("https://overpass-api.de/api/interpreter", post("a"));
  const b = f("https://overpass-api.de/api/interpreter", post("b"));
  await a;
  const c = f("https://overpass-api.de/api/interpreter", post("c")); // arrives just as a's slot is freed
  await Promise.all([b, c]);
  assert.deepEqual(order, ["data=a", "data=b", "data=c"]);
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

test("Overpass answers that carry a runtime-error remark aren't kept for the next run", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cw-cache-")), "http-cache.json");
  const url = "https://overpass-api.de/api/interpreter";
  const first = politeFetch(async (u, o) => json(o.body === "data=bad" ? { elements: [], remark: "runtime error: Query timed out" } : { elements: [1] }), { cacheFile: file, maxAgeMs: 60_000 });
  await first(url, post("bad")); await first(url, post("good"));
  first.save();
  const keys = JSON.parse(fs.readFileSync(file, "utf8")).entries.map(([k]) => k);
  assert.equal(keys.length, 1);
  assert.ok(keys[0].endsWith("data=good"));
});

// ---- run(): time budget ----

// A small site: two hand-placed walks (one in Ghent, two in Antwerp), plus the app's own modules.
// wiki: stop A links to a Wikipedia article, so a walk counts as "online" even when Overpass doesn't answer.
const TWO_LAT = "51.21";
function fixtureRoot({ wiki = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cw-root-"));
  for (const f of ["util.js", "sources.js", "schema.js", "builder.js"]) fs.copyFileSync(path.join(HERE, f), path.join(root, f));
  const walk = (id, title, lat, lon) => ({ schema: 2, id, title, lang: "en", stops: [
    { id: "a", title: "Stop A", lat, lon, fixed: true, text: "First stop.", ...(wiki ? { wikipedia: "en:Stop A" } : {}) },
    { id: "b", title: "Stop B", lat: lat + 0.0017, lon: lon + 0.0017, fixed: true, text: "Second stop." },
  ] });
  fs.writeFileSync(path.join(root, "walk-x-one.json"), JSON.stringify(walk("one", "Walk one", 51.0543, 3.7253)));
  fs.writeFileSync(path.join(root, "walk-x-two.json"), JSON.stringify(walk("two", "Walk two", 51.2194, 4.4025)));
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
// Open data with a Wikipedia article for stop A; Overpass answers through the given function.
function openData(overpass = () => json({ elements: [] }), counter = { overpass: 0 }) {
  return async (url, opts = {}) => {
    if (/overpass/.test(url)) { counter.overpass++; return overpass(url, opts); }
    if (/wikipedia\.org\/api\/rest_v1\/page\/summary\/Stop_A$/.test(url)) return json({ title: "Stop A", extract: "About stop A." });
    return json({}, 404);
  };
}
const readJSON = (...p) => JSON.parse(fs.readFileSync(path.join(...p), "utf8"));
const tmpOut = () => fs.mkdtempSync(path.join(os.tmpdir(), "cw-out-"));
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

// ---- run(): incomplete walks aren't published ----

test("a walk built while Overpass is unavailable isn't published from that run; the previous version is kept", async () => {
  const root = fixtureRoot({ wiki: true });
  const out1 = tmpOut();
  await run({ root, out: out1, mode: "full", fetchImpl: openData(), previous: { index: null }, cacheFile: null });
  const prevIndex = readJSON(out1, "built", "index.json");
  assert.deepEqual(Object.keys(prevIndex.walks).sort(), ["x/one", "x/two"]);

  // Overpass doesn't answer for walk two (in Antwerp); Wikipedia still does
  const failTwo = openData((url, opts) => { if (decodeURIComponent(opts.body).includes(TWO_LAT)) throw abortError(); return json({ elements: [] }); });

  const out2 = tmpOut(); // no previous build: walk two isn't published at all
  await run({ root, out: out2, mode: "full", fetchImpl: failTwo, previous: { index: null }, cacheFile: null });
  assert.deepEqual(Object.keys(readJSON(out2, "built", "index.json").walks), ["x/one"]);

  const out3 = tmpOut(); // with a previous build: walk two keeps its published version
  await run({ root, out: out3, mode: "full", cacheFile: null,
    fetchImpl: publishedSite(out1, failTwo), previous: { index: prevIndex, base: "https://prev.example/" } });
  const index = readJSON(out3, "built", "index.json");
  assert.deepEqual(Object.keys(index.walks).sort(), ["x/one", "x/two"]);
  for (const f of Object.values(index.walks["x/two"].files)) assert.equal(readJSON(out3, "built", f).builtAt, prevIndex.builtAt, f);
  for (const f of Object.values(index.walks["x/one"].files)) assert.equal(readJSON(out3, "built", f).builtAt, index.builtAt, f);
});

test("a walk the deadline cuts off halfway isn't published from that run; the previous version is kept", async () => {
  const root = fixtureRoot({ wiki: true });
  const out1 = tmpOut();
  await run({ root, out: out1, mode: "full", fetchImpl: openData(), previous: { index: null }, cacheFile: null });
  const prevIndex = readJSON(out1, "built", "index.json");

  // Overpass answers only after the deadline, so the walking route request after it is refused
  const budgetMs = 1000, start = Date.now(), counter = { overpass: 0 };
  const late = openData(async () => { await new Promise((r) => setTimeout(r, Math.max(0, start + budgetMs + 50 - Date.now()))); return json({ elements: [] }); }, counter);
  const out2 = tmpOut();
  await run({ root, out: out2, mode: "full", budgetMs, graceMs: 0, cacheFile: null,
    fetchImpl: publishedSite(out1, late), previous: { index: prevIndex, base: "https://prev.example/" } });
  assert.ok(counter.overpass > 0, "walk one was started before the budget ran out");
  const index = readJSON(out2, "built", "index.json");
  assert.deepEqual(Object.keys(index.walks).sort(), ["x/one", "x/two"]);
  for (const k of ["x/one", "x/two"]) for (const f of Object.values(index.walks[k].files)) assert.equal(readJSON(out2, "built", f).builtAt, prevIndex.builtAt, f);
});
