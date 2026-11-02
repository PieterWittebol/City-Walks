// Build step for GitHub Actions: looks up all open data once and publishes ready-made walk files,
// so phones don't have to query Wikipedia, Wikidata, OpenStreetMap etc. themselves.
// It runs the exact same code as the app (util.js, sources.js, schema.js, builder.js) in a sandbox.
//
//   node build.mjs              → writes the site + built/ data to _site/
//   BUILD_MODE=incremental      → reuse the published data for walks that didn't change (fewer queries)
//
// No secrets are used. Requires Node 20+.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadOsmExtract, answerOverpass } from "./osm-local.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, process.env.OUT_DIR || "_site");
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(process.env.GITHUB_REPOSITORY || "") ? process.env.GITHUB_REPOSITORY : "unknown/city-walks";
const MODE = process.env.BUILD_MODE === "incremental" ? "incremental" : "full";
const UA = `CityWalks/1.0 (https://github.com/${REPO}; walk data build)`;
const SITE_FILE = /^[a-z0-9][a-z0-9._-]*\.(html|js|css|json|svg|png|jpe?g|webp|webmanifest|md)$/i;
const NOT_PUBLISHED = new Set(["build.mjs", "package.json", "package-lock.json"]);

function siteUrl() {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/?$/, "/");
  const [owner, repo] = REPO.split("/");
  return repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${repo}/` : `https://${owner.toLowerCase()}.github.io/${repo}/`;
}
const FORMAT = 4; // bump when the built file format changes, so old published files aren't reused
const warn = (m) => console.log(`::warning::${m}`);

// ---- polite fetch: identifies itself, caches identical requests, spaces requests per host, retries on 429/5xx ----
// Busy public services get one request at a time; Wikipedia and the Wikidata API up to 4 (as the app itself does).
// Answers can be kept between runs (cacheFile), and after the deadline no new requests are sent.
const SCALE = Number(process.env.WAIT_SCALE || 1); // only for local testing
const abortErr = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
function pause(ms, signal) { // waits ms × SCALE; stops at once when the request is aborted
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortErr());
    const done = () => { signal?.removeEventListener("abort", stop); resolve(); };
    const stop = () => { clearTimeout(t); reject(abortErr()); };
    const t = setTimeout(done, ms * SCALE);
    signal?.addEventListener("abort", stop, { once: true });
  });
}
const NO_BODY = new Set([101, 204, 205, 304]);
const respond = (c) => new Response(NO_BODY.has(c.status) ? null : c.body, { status: c.status, headers: { "content-type": c.type || "application/json" } });
export function politeFetch(baseFetch, { deadline = Infinity, cacheFile = null, maxAgeMs = 0, downMs = 10 * 60e3, failMemoryMs = 5 * 60e3 } = {}) {
  const cache = new Map(), hosts = new Map();
  const gap = (host) => /overpass/.test(host) ? 1500 : /nominatim/.test(host) ? 1100 : /query\.wikidata/.test(host) ? 500 : /onroerenderfgoed|erfgoed\.net/.test(host) ? 300 : 50;
  const slots = (host) => /(^|\.)wikipedia\.org$|^www\.wikidata\.org$/.test(host) ? 4 : 1;
  const watched = (host) => /^(overpass-api\.de|overpass\.private\.coffee|maps\.mail\.ru|overpass\.kumi\.systems)$/.test(host); // the Overpass endpoints
  // refused: requests not sent (deadline, host down, recent failure); pastDeadline: those refused because time ran out
  const stats = { requests: 0, cached: 0, refused: 0, pastDeadline: 0, hosts: {}, down: [] };
  // An Overpass host that fails twice in a row is skipped for downMs, and a failed request isn't repeated for failMemoryMs
  // (sources.js tries 4 Overpass servers per query, and the same query again for every language). Other services are never skipped.
  const health = new Map(), failed = new Map(); // host → { fails, downUntil }, request key → time until which it is refused
  const healthOf = (h) => { if (!health.has(h)) health.set(h, { fails: 0, downUntil: 0 }); return health.get(h); };
  const refuse = (host) => new Error(`host down: ${host}`);
  const skipIfDown = (key, host) => { if (watched(host) && (Date.now() < (failed.get(key) || 0) || Date.now() < healthOf(host).downUntil)) { stats.refused++; throw refuse(host); } };
  function noteFailure(key, host) {
    if (!watched(host)) return;
    const h = healthOf(host);
    failed.set(key, Date.now() + failMemoryMs);
    if (++h.fails >= 2) { h.fails = 0; h.downUntil = Date.now() + downMs; if (!stats.down.includes(host)) stats.down.push(host); }
  }
  if (cacheFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      for (const [k, c] of saved.entries || []) if (Date.now() - c.at < maxAgeMs) cache.set(k, c);
      console.log(`HTTP cache: ${cache.size} of ${(saved.entries || []).length} saved answers still fresh`);
    } catch { /* no cache yet */ }
  }
  const hostState = (h) => { if (!hosts.has(h)) hosts.set(h, { next: 0, active: 0, queue: [] }); return hosts.get(h); };
  async function acquire(h, signal) { // a freed slot is handed straight to the first waiter, so a newcomer can't overtake it
    const s = hostState(h);
    if (s.active < slots(h)) { s.active++; return; }
    await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortErr());
      const stop = () => { const i = s.queue.indexOf(go); if (i >= 0) s.queue.splice(i, 1); reject(abortErr()); };
      const go = () => { signal?.removeEventListener("abort", stop); resolve(); };
      s.queue.push(go);
      signal?.addEventListener("abort", stop, { once: true });
    });
  }
  function release(h) { const s = hostState(h), next = s.queue.shift(); if (next) next(); else s.active--; }
  const checkDeadline = () => { if (Date.now() > deadline) { stats.refused++; stats.pastDeadline++; throw new Error("time budget used up; no new requests"); } };

  async function f(url, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();
    const accept = (opts.headers && (opts.headers.Accept || opts.headers.accept)) || "";
    const key = method + " " + url + " " + accept + " " + (typeof opts.body === "string" ? opts.body : "");
    if (cache.has(key)) { stats.cached++; return respond(cache.get(key)); }
    checkDeadline();
    const host = new URL(url).hostname, signal = opts.signal;
    skipIfDown(key, host);
    const hs = (stats.hosts[host] ||= { requests: 0, ms: 0 });
    const backoff = async (ms) => { try { await pause(ms, signal); } catch (e) { noteFailure(key, host); throw e; } }; // giving up during a back-off still counts as a failure
    await acquire(host, signal);
    try {
      for (let attempt = 0; ; attempt++) {
        checkDeadline();
        skipIfDown(key, host); // it may have been marked down while this request was waiting its turn
        const s = hostState(host), at = Math.max(Date.now(), s.next); // reserve the next slot for this host
        s.next = at + gap(host) * SCALE;
        if (at > Date.now()) await pause((at - Date.now()) / SCALE, signal);
        stats.requests++; hs.requests++;
        const t0 = Date.now();
        let res;
        try { res = await baseFetch(url, { ...opts, headers: { ...(opts.headers || {}), "User-Agent": UA, "Api-User-Agent": UA } }); }
        catch (e) { hs.ms += Date.now() - t0; if (attempt < 2 && e.name !== "AbortError") { await backoff(3000 * (attempt + 1)); continue; } noteFailure(key, host); throw e; }
        const busy = /overpass/.test(host) ? 3 : 2; // Overpass is often busy: wait longer and retry more
        if ((res.status === 429 || res.status >= 500) && attempt < busy) { hs.ms += Date.now() - t0; await backoff((/overpass/.test(host) ? 20000 : 5000) * (attempt + 1)); continue; }
        const body = await res.text();
        hs.ms += Date.now() - t0;
        if (res.status === 429 || res.status >= 500) noteFailure(key, host); else healthOf(host).fails = 0;
        const c = { status: res.status, body, type: res.headers.get("content-type") || "", at: Date.now() };
        // remember answers and definite "not found"s (4xx), but not "busy" or server errors
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408)) cache.set(key, c);
        return respond(c);
      }
    } finally { release(host); }
  }
  f.stats = stats;
  // forget which hosts are down and which requests failed (used before the retry round); cached answers stay
  f.forgetFailures = () => { health.clear(); failed.clear(); };
  // keep successful answers for the next run
  f.save = () => {
    if (!cacheFile) return;
    // (Overpass reports its own runtime errors/timeouts as a "remark" in an HTTP 200 answer: not worth keeping)
    const entries = [...cache].filter(([, c]) => c.status >= 200 && c.status < 300 && !c.body.includes('"remark"'));
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ v: 1, entries }));
    console.log(`HTTP cache: saved ${entries.length} answers`);
  };
  return f;
}

// ---- load the app's own modules in a sandbox ----
function loadModules(fetchImpl, root = ROOT) {
  const store = new Map();
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder,
    fetch: fetchImpl, document: { addEventListener() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    addEventListener() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ["util.js", "sources.js", "schema.js", "builder.js"]) vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), sandbox, { filename: f });
  return sandbox;
}

// ---- Onroerend Erfgoed: Flemish heritage inventory (inventaris.onroerenderfgoed.be) ----
// Finds the inventory object for a stop (via Wikidata P1764, or the agency's geo search service around the stop)
// and adds its Dutch description. Only for stops in Flanders (the inventory doesn't cover Brussels).
// Turn off with OE_TEXTS=off (e.g. if the reuse conditions turn out not to allow it).
const OE_ON = process.env.OE_TEXTS !== "off";
const OE_BASE = "https://inventaris.onroerenderfgoed.be/erfgoedobjecten/";
const inFlanders = (p) => p.lat > 50.68 && p.lat < 51.51 && p.lon > 2.54 && p.lon < 5.92 && !(p.lat > 50.76 && p.lat < 50.92 && p.lon > 4.24 && p.lon < 4.49);
const stripHtml = (h) => String(h || "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const normName = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((w) => w.length > 2 && !["van", "het", "der", "den", "des", "the", "and", "sint", "saint", "kerk", "church", "gent", "ghent", "antwerpen", "antwerp"].includes(w));
const nameMatch = (a, b) => { const A = normName(a), B = new Set(normName(b)); return A.length && A.filter((w) => B.has(w)).length / A.length >= 0.5; };
let oeKeysLogged = false;
function makeOE(f, sparql) {
  const cache = new Map();
  async function details(id) {
    if (cache.has(id)) return cache.get(id);
    let out = null;
    try { // JSON representation of the inventory object
      const r = await f(OE_BASE + id, { headers: { Accept: "application/json" } });
      if (r.ok && /json/.test(r.headers.get("content-type") || "")) {
        const j = await r.json();
        if (!oeKeysLogged) { console.log("Onroerend Erfgoed JSON fields:", Object.keys(j).join(", ")); oeKeysLogged = true; }
        const pick = (o, re, depth = 0) => { // first string field whose name matches re (searching nested objects)
          if (!o || typeof o !== "object" || depth > 3) return "";
          for (const [k, v] of Object.entries(o)) if (re.test(k) && typeof v === "string" && v.trim()) return v;
          for (const v of Object.values(o)) { const x = pick(v, re, depth + 1); if (x) return x; }
          return "";
        };
        const short = stripHtml(pick(j, /^korte_?beschrijving$|^samenvatting$|^summary$/i));
        const long = stripHtml(pick(j, /^beschrijving$|^description$/i));
        const text = short || long.split("\n").find((p) => p.length > 80) || long;
        if (text) out = { id, name: stripHtml(j.naam || j.name || ""), text };
      }
    } catch (e) { console.log(`OE ${id}: JSON failed (${e.message})`); }
    if (!out) try { // fallback: the page's own summary
      const r = await f(OE_BASE + id, { headers: { Accept: "text/html" } });
      const h = r.ok ? await r.text() : "";
      const m = h.match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']{40,})["']/i) || h.match(/<meta[^>]+content=["']([^"']{40,})["'][^>]+(?:name|property)=["'](?:og:)?description["']/i);
      const t = h.match(/<title>([^<]+)<\/title>/i);
      if (m) out = { id, name: stripHtml(t ? t[1].split("|")[0] : ""), text: stripHtml(m[1]) };
    } catch (e) { console.log(`OE ${id}: page failed (${e.message})`); }
    cache.set(id, out);
    return out;
  }
  async function idsByQid(qids) {
    if (!qids.length) return {};
    try {
      const rows = await sparql(`SELECT ?item ?id WHERE { VALUES ?item { ${qids.map((q) => "wd:" + q).join(" ")} } ?item wdt:P1764 ?id . }`);
      const out = {}; for (const r of rows) { const q = (String(r.item).match(/Q\d+$/) || [])[0]; if (q && /^\d+$/.test(r.id) && !out[q]) out[q] = r.id; }
      return out;
    } catch (e) { console.log("OE: Wikidata lookup failed", e.message); return {}; }
  }
  async function idNear(stop) { // the agency's geo search service, 30 m around the stop
    const geo = JSON.stringify({ type: "Point", coordinates: [stop.lon, stop.lat] });
    try {
      const r = await f(`https://geo.onroerenderfgoed.be/zoekdiensten/afbakeningen?categorie=erfgoedobjecten&buffer=30&geef_geometrie=0&geometrie=${encodeURIComponent(geo)}`, { headers: { Accept: "application/json" } });
      if (!r.ok) { if (r.status === 401 || r.status === 403) console.log("OE geo search needs access (HTTP " + r.status + ")"); return null; }
      const list = await r.json();
      const hit = (Array.isArray(list) ? list : []).find((x) => x && /^\d+$/.test(String(x.id)) && nameMatch(stop.title, x.naam));
      return hit ? String(hit.id) : null;
    } catch (e) { return null; }
  }
  // add inventory texts to the stops of one walk, in one language
  return async function enrich(stops, lang) {
    let added = 0;
    const flemish = stops.filter((s) => inFlanders(s));
    if (!flemish.length) return 0;
    const byQ = await idsByQid([...new Set(flemish.map((s) => s.qid).filter(Boolean))]);
    for (const s of flemish) {
      const id = (s.qid && byQ[s.qid]) || await idNear(s);
      if (!id) continue;
      const url = OE_BASE + id;
      if (!(s.links || []).some((l) => l.url === url)) (s.links = s.links || []).push({ label: "Flemish heritage inventory", url });
      if (!(lang === "nl" && s.textLang === "nl") && s.text) continue; // text only needed in Dutch, or when there's none
      const d = await details(id);
      if (!d || !d.text) continue;
      const short = d.text.length > 700 ? d.text.slice(0, 680).replace(/\s+\S*$/, "") + "…" : d.text;
      if (lang === "nl" && s.text && s.textLang === "nl") s.text += "\n\nUit de Vlaamse erfgoedinventaris: " + short;
      else if (!s.text) { s.text = short; s.textLang = "nl"; }
      else continue;
      s.credit = [s.credit, "Inventory text: Agentschap Onroerend Erfgoed"].filter(Boolean).join(" · ");
      added++;
    }
    return added;
  };
}

// Time budget: after budgetMs no new walk is started (unchanged walks keep their published data), and after
// budgetMs + graceMs no request is sent at all, so the build always finishes and the site is always published.
const envMinutes = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && process.env[name] !== "" ? n * 60e3 : dflt; };
export async function run({
  fetchImpl = globalThis.fetch, previous = null, root = ROOT, out = OUT, mode = MODE,
  budgetMs = envMinutes("BUILD_BUDGET_MIN", 20 * 60e3), graceMs = envMinutes("BUILD_GRACE_MIN", 5 * 60e3),
  cacheFile = process.env.HTTP_CACHE ? path.resolve(process.env.HTTP_CACHE) : null,
  cacheMaxAgeMs = envMinutes("HTTP_CACHE_MAX_AGE_MIN", 8 * 24 * 60 * 60e3),
  osmFile = process.env.OSM_EXTRACT ? path.resolve(process.env.OSM_EXTRACT) : null,
  osmBoundary = process.env.OSM_BOUNDARY ? path.resolve(process.env.OSM_BOUNDARY) : null,
} = {}) {
  const t0 = Date.now(), summary = [];
  const overBudget = () => Date.now() - t0 >= budgetMs;
  const pf = politeFetch(fetchImpl, { deadline: t0 + budgetMs + graceMs, cacheFile, maxAgeMs: cacheMaxAgeMs });
  // OpenStreetMap extract (Geofabrik): Overpass questions it can answer never reach the public Overpass servers
  const osm = osmFile && osmBoundary ? loadOsmExtract(osmFile, osmBoundary) : null;
  if (osmFile) console.log(osm ? `OpenStreetMap extract: ${osm.els.length} objects` : `OpenStreetMap extract ${osmFile} not usable; asking Overpass`);
  pf.stats.osmLocal = 0;
  const OVERPASS_URL = /^https:\/\/(overpass-api\.de|overpass\.private\.coffee|maps\.mail\.ru|overpass\.kumi\.systems)\//;
  const fetchLocalFirst = async (url, opts = {}) => {
    if (osm && OVERPASS_URL.test(url) && typeof opts.body === "string") {
      const els = answerOverpass(osm, new URLSearchParams(opts.body).get("data") || "");
      if (els) { pf.stats.osmLocal++; return new Response(JSON.stringify({ elements: els }), { status: 200, headers: { "content-type": "application/json" } }); }
    }
    return pf(url, opts);
  };
  const W = loadModules(fetchLocalFirst, root);
  const { Util, Schema, Builder, Sources } = W;
  // Overpass not answering at all leaves out murals' positions and the sights along the way. Builder looks up
  // Sources.overpass at call time, so this wrapper counts it (walks are built one at a time, so a counter is enough).
  let overpassMissing = 0;
  const overpass = Sources.overpass;
  Sources.overpass = async (q) => { try { return await overpass(q); } catch (e) { if (/Overpass unavailable/.test(e.message)) overpassMissing++; throw e; } };
  const oeEnrich = OE_ON ? makeOE(pf, (q) => Sources.sparql(q)) : null;
  let oeCount = 0;
  const LANGS = Sources.LANGS;

  // 1. copy the site (root files only; no dotfiles, folders or build tooling)
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "built"), { recursive: true });
  for (const f of fs.readdirSync(root)) {
    if (!SITE_FILE.test(f) || NOT_PUBLISHED.has(f) || !fs.statSync(path.join(root, f)).isFile()) continue;
    fs.copyFileSync(path.join(root, f), path.join(out, f));
  }

  // 2. previous build, to reuse unchanged walks
  let prev = previous;
  if (!prev) { // always fetched: reused for unchanged walks (incremental), and as a fallback when a lookup fails
    try { const r = await fetchImpl(siteUrl() + "built/index.json", { cache: "no-store" }); if (r.ok) prev = { index: await r.json(), base: siteUrl() + "built/" }; }
    catch (e) { console.log("No previous build found (" + e.message + "); building everything."); }
  }

  // 3. build every walk listed in cities.json, in every language
  const cities = JSON.parse(fs.readFileSync(path.join(root, "cities.json"), "utf8"));
  for (const e of Schema.checkCities(cities)) warn("cities.json: " + e);
  const index = { v: FORMAT, builtAt: new Date().toISOString(), walks: {} };
  // build one walk in one language; throws when the open data can't be reached, or when part of it wasn't asked
  // (time budget used up, Overpass down): such a walk is retried, else the previous version is kept or phones look it up
  async function buildOne(walk, lang, hash) {
    // A walk is incomplete when time ran out during it, or when no Overpass server answered at all. A server skipped
    // as down doesn't count by itself: sources.js then simply asks the next one.
    const late0 = pf.stats.pastDeadline, missing0 = overpassMissing;
    const r = await Builder.buildWalk(walk, lang, () => {});
    if (!r.online) throw new Error("no open data service answered");
    if (oeEnrich) { try { const n = await oeEnrich(r.stops, lang); oeCount += n; if (n) console.log(`  ${walk.id} (${lang}): ${n} inventory text(s) from Onroerend Erfgoed`); } catch (e) { console.log("OE enrich failed:", e.message); } }
    let n = 0;
    for (const s of r.live) { // texts for sights along the way, so phones don't have to ask Wikipedia
      if (n++ >= 50) break;
      const info = await Builder.sightText(s, lang);
      if (info.text) { s.text = info.text; s.url = info.url || null; }
    }
    r.live = r.live.filter((s) => s.text);
    if (pf.stats.pastDeadline > late0 || overpassMissing > missing0) throw new Error("incomplete: time budget used up or Overpass unavailable");
    const result = { v: FORMAT, hash, lang, builtAt: index.builtAt, stops: r.stops, line: r.line, km: r.km, legs: r.legs, live: r.live };
    if (!Schema.cleanBuilt(result)) throw new Error("result failed validation");
    return result;
  }
  const failed = [], doneWalks = [];
  for (const city of cities.cities || []) {
    for (const entry of city.walks || []) {
      const key = `${city.id}/${entry.id}`;
      if (!Schema.validFile(entry.file) || !fs.existsSync(path.join(root, entry.file))) { warn(`${key}: file ${entry.file} not found`); continue; }
      let raw, walk;
      try { raw = JSON.parse(fs.readFileSync(path.join(root, entry.file), "utf8")); walk = Schema.cleanWalk(raw); }
      catch (e) { warn(`${entry.file}: ${e.message} (skipped; the app will show an error for this walk)`); continue; }
      for (const p of Schema.checkWalk(raw)) warn(`${entry.file}: ${p}`);
      const hash = Util.hash(JSON.stringify(raw));
      const files = {}, row = { key, langs: [], stops: 0, placed: "", reused: 0, skipped: 0, secs: 0 }, tw = Date.now();
      for (const lang of LANGS) {
        const file = `${city.id}--${entry.id}.${lang}.json`.replace(/[^a-z0-9.-]/gi, "-").toLowerCase();
        // reuse the published file if the walk didn't change
        const pe = prev && prev.index && prev.index.walks && prev.index.walks[key];
        const reusePrev = async () => {
          if (!(pe && pe.hash === hash && pe.files && pe.files[lang] === file)) return false;
          try {
            const r = await fetchImpl(prev.base + file); const b = r.ok ? await r.json() : null;
            if (b && b.v === FORMAT && Schema.cleanBuilt(b) && b.hash === hash && b.lang === lang) { fs.writeFileSync(path.join(out, "built", file), JSON.stringify(b)); files[lang] = file; row.langs.push(lang); row.stops = b.stops.length; return true; }
          } catch {}
          return false;
        };
        if ((mode === "incremental" || overBudget()) && await reusePrev()) { row.reused++; continue; }
        if (overBudget()) { row.skipped++; continue; }
        try {
          const built = await buildOne(walk, lang, hash);
          fs.writeFileSync(path.join(out, "built", file), JSON.stringify(built));
          files[lang] = file; row.langs.push(lang); row.stops = built.stops.length; row.km = built.km;
          row.placed = ["wikipedia", "ods", "osm", "geocode"].map((k) => [k, built.stops.filter((s) => s.src === k).length]).filter(([, c]) => c).map(([k, c]) => `${k} ${c}`).join(", ");
          row.turns = built.legs ? "✓" : "–";
        } catch (e) { failed.push({ key, lang, file, walk, hash, files, row, reusePrev, err: e.message }); }
      }
      doneWalks.push({ key, hash, files });
      row.secs = Math.round((Date.now() - tw) / 1000);
      summary.push(row);
      if (row.skipped) warn(`${key}: time budget used up; ${row.skipped} language(s) not built, phones will look them up themselves until the next build`);
      console.log(`${key}: ${row.langs.join(",") || "FAILED"} · ${row.stops} stops${row.reused ? ` · ${row.reused} reused` : ""}${row.placed ? " · " + row.placed : ""} · ${row.secs} s`);
    }
  }
  // retry failures once more after a pause (public services are sometimes briefly overloaded),
  // then fall back to the previously published version of that walk, if it's still current
  if (failed.length && !overBudget()) { pf.forgetFailures(); console.log(`Retrying ${failed.length} failed walk/language combination(s) in 60 s…`); await new Promise((r) => setTimeout(r, Number(process.env.RETRY_WAIT_MS ?? 60000))); }
  for (const f of failed) {
    try {
      if (overBudget()) throw new Error("time budget used up");
      const built = await buildOne(f.walk, f.lang, f.hash);
      fs.writeFileSync(path.join(out, "built", f.file), JSON.stringify(built));
      f.files[f.lang] = f.file; f.row.langs.push(f.lang); f.row.stops = built.stops.length; f.row.km = built.km;
      console.log(`${f.key} (${f.lang}): OK on retry`);
    } catch (e) {
      if (await f.reusePrev()) { f.row.reused++; warn(`${f.key} (${f.lang}): ${e.message}; kept the previously published version`); }
      else warn(`${f.key} (${f.lang}): ${e.message}; no ready-made data, phones will look it up themselves`);
    }
  }
  for (const d of doneWalks) if (Object.keys(d.files).length) index.walks[d.key] = { hash: d.hash, files: d.files };
  fs.writeFileSync(path.join(out, "built", "index.json"), JSON.stringify(index, null, 1));
  pf.save();

  // 4. report
  const secs = Math.round((Date.now() - t0) / 1000);
  const md = [`### City Walks data build (${mode})`, "", `${pf.stats.requests} requests to open data services, ${pf.stats.cached} answered from cache${osm ? `, ${pf.stats.osmLocal} OpenStreetMap questions answered from the Geofabrik extract` : ""}${pf.stats.refused ? `, ${pf.stats.refused} not sent (time budget or service down)` : ""}, ${secs} s${overBudget() ? " (time budget used up)" : ""}. Onroerend Erfgoed texts added: ${oeEnrich ? oeCount : "off"}.`,
    ...(pf.stats.down.length ? ["", `Skipped as down: ${pf.stats.down.join(", ")}.`] : []), "",
    "| Walk | Languages | Stops | Positions | Route | Turn-by-turn | Time |", "|---|---|---|---|---|---|---|",
    ...summary.map((r) => `| ${r.key} | ${r.langs.join(", ") || "❌ failed"}${r.reused ? ` (${r.reused} reused)` : ""}${r.skipped ? ` (${r.skipped} skipped)` : ""} | ${r.stops} | ${r.placed || "–"} | ${r.km ? r.km.toFixed(1) + " km" : "–"} | ${r.turns || (r.reused ? "reused" : "–")} | ${r.secs} s |`),
    "", "| Service | Requests | Network time |", "|---|---|---|",
    ...Object.entries(pf.stats.hosts).sort((a, b) => b[1].ms - a[1].ms).map(([h, v]) => `| ${h} | ${v.requests} | ${Math.round(v.ms / 1000)} s |`)].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  console.log(`\n${pf.stats.requests} requests, ${pf.stats.cached} cached, ${secs} s`);
  return { index, summary, stats: pf.stats };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
