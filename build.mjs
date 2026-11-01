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
const FORMAT = 2; // bump when the built file format changes, so old published files aren't reused
const warn = (m) => console.log(`::warning::${m}`);
const summary = [];

// ---- polite fetch: identifies itself, caches identical requests, spaces requests per host, retries on 429/5xx ----
const SCALE = Number(process.env.WAIT_SCALE || 1); // only for local testing
const pause = (ms) => new Promise((r) => setTimeout(r, ms * SCALE));
function politeFetch(baseFetch) {
  const cache = new Map(), lastByHost = new Map();
  const gap = (host) => /overpass/.test(host) ? 1500 : /nominatim/.test(host) ? 1100 : /query\.wikidata/.test(host) ? 500 : 50;
  let stats = { requests: 0, cached: 0 };
  async function f(url, opts = {}) {
    const method = (opts.method || "GET").toUpperCase();
    const key = method + " " + url + " " + (typeof opts.body === "string" ? opts.body : "");
    if (cache.has(key)) { stats.cached++; const c = cache.get(key); return new Response(c.body, { status: c.status, headers: { "content-type": "application/json" } }); }
    const host = new URL(url).hostname;
    for (let attempt = 0; ; attempt++) {
      const wait = (lastByHost.get(host) || 0) + gap(host) - Date.now();
      if (wait > 0) await pause(wait);
      lastByHost.set(host, Date.now());
      stats.requests++;
      let res;
      try { res = await baseFetch(url, { ...opts, headers: { ...(opts.headers || {}), "User-Agent": UA, "Api-User-Agent": UA } }); }
      catch (e) { if (attempt < 2 && e.name !== "AbortError") { await pause(3000 * (attempt + 1)); continue; } throw e; }
      const busy = /overpass/.test(host) ? 3 : 2; // Overpass is often busy: wait longer and retry more
      if ((res.status === 429 || res.status >= 500) && attempt < busy) { await pause((/overpass/.test(host) ? 20000 : 5000) * (attempt + 1)); continue; }
      const body = await res.text();
      if (res.ok) cache.set(key, { status: res.status, body });
      return new Response(body, { status: res.status, headers: { "content-type": res.headers.get("content-type") || "application/json" } });
    }
  }
  f.stats = stats;
  return f;
}

// ---- load the app's own modules in a sandbox ----
function loadModules(fetchImpl) {
  const store = new Map();
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder,
    fetch: fetchImpl, document: { addEventListener() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    addEventListener() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ["util.js", "sources.js", "schema.js", "builder.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
  return sandbox;
}

export async function run({ fetchImpl = globalThis.fetch, previous = null } = {}) {
  const t0 = Date.now();
  const pf = politeFetch(fetchImpl);
  const W = loadModules(pf);
  const { Util, Schema, Builder, Sources } = W;
  const LANGS = Sources.LANGS;

  // 1. copy the site (root files only; no dotfiles, folders or build tooling)
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "built"), { recursive: true });
  for (const f of fs.readdirSync(ROOT)) {
    if (!SITE_FILE.test(f) || NOT_PUBLISHED.has(f) || !fs.statSync(path.join(ROOT, f)).isFile()) continue;
    fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
  }

  // 2. previous build, to reuse unchanged walks
  let prev = previous;
  if (!prev) { // always fetched: reused for unchanged walks (incremental), and as a fallback when a lookup fails
    try { const r = await fetchImpl(siteUrl() + "built/index.json", { cache: "no-store" }); if (r.ok) prev = { index: await r.json(), base: siteUrl() + "built/" }; }
    catch (e) { console.log("No previous build found (" + e.message + "); building everything."); }
  }

  // 3. build every walk listed in cities.json, in every language
  const cities = JSON.parse(fs.readFileSync(path.join(ROOT, "cities.json"), "utf8"));
  for (const e of Schema.checkCities(cities)) warn("cities.json: " + e);
  const index = { v: FORMAT, builtAt: new Date().toISOString(), walks: {} };
  // build one walk in one language; throws when the open data can't be reached
  async function buildOne(walk, lang, hash) {
    const r = await Builder.buildWalk(walk, lang, () => {});
    if (!r.online) throw new Error("no open data service answered");
    let n = 0;
    for (const s of r.live) { // texts for sights along the way, so phones don't have to ask Wikipedia
      if (n++ >= 50) break;
      const info = await Builder.sightText(s, lang);
      if (info.text) { s.text = info.text; s.url = info.url || null; }
    }
    r.live = r.live.filter((s) => s.text);
    const out = { v: FORMAT, hash, lang, builtAt: index.builtAt, stops: r.stops, line: r.line, km: r.km, legs: r.legs, live: r.live };
    if (!Schema.cleanBuilt(out)) throw new Error("result failed validation");
    return out;
  }
  const failed = [], doneWalks = [];
  for (const city of cities.cities || []) {
    for (const entry of city.walks || []) {
      const key = `${city.id}/${entry.id}`;
      if (!Schema.validFile(entry.file) || !fs.existsSync(path.join(ROOT, entry.file))) { warn(`${key}: file ${entry.file} not found`); continue; }
      let raw, walk;
      try { raw = JSON.parse(fs.readFileSync(path.join(ROOT, entry.file), "utf8")); walk = Schema.cleanWalk(raw); }
      catch (e) { warn(`${entry.file}: ${e.message} (skipped; the app will show an error for this walk)`); continue; }
      for (const p of Schema.checkWalk(raw)) warn(`${entry.file}: ${p}`);
      const hash = Util.hash(JSON.stringify(raw));
      const files = {}, row = { key, langs: [], stops: 0, placed: "", reused: 0 };
      for (const lang of LANGS) {
        const file = `${city.id}--${entry.id}.${lang}.json`.replace(/[^a-z0-9.-]/gi, "-").toLowerCase();
        // reuse the published file if the walk didn't change
        const pe = prev && prev.index && prev.index.walks && prev.index.walks[key];
        const reusePrev = async () => {
          if (!(pe && pe.hash === hash && pe.files && pe.files[lang] === file)) return false;
          try {
            const r = await fetchImpl(prev.base + file); const b = r.ok ? await r.json() : null;
            if (b && b.v === FORMAT && Schema.cleanBuilt(b) && b.hash === hash && b.lang === lang) { fs.writeFileSync(path.join(OUT, "built", file), JSON.stringify(b)); files[lang] = file; row.langs.push(lang); row.stops = b.stops.length; return true; }
          } catch {}
          return false;
        };
        if (MODE === "incremental" && await reusePrev()) { row.reused++; continue; }
        try {
          const out = await buildOne(walk, lang, hash);
          fs.writeFileSync(path.join(OUT, "built", file), JSON.stringify(out));
          files[lang] = file; row.langs.push(lang); row.stops = out.stops.length; row.km = out.km;
          row.placed = ["wikipedia", "ods", "osm", "geocode"].map((k) => [k, out.stops.filter((s) => s.src === k).length]).filter(([, c]) => c).map(([k, c]) => `${k} ${c}`).join(", ");
          row.turns = out.legs ? "✓" : "–";
        } catch (e) { failed.push({ key, lang, file, walk, hash, files, row, reusePrev, err: e.message }); }
      }
      doneWalks.push({ key, hash, files });
      summary.push(row);
      console.log(`${key}: ${row.langs.join(",") || "FAILED"} · ${row.stops} stops${row.reused ? ` · ${row.reused} reused` : ""}${row.placed ? " · " + row.placed : ""}`);
    }
  }
  // retry failures once more after a pause (public services are sometimes briefly overloaded),
  // then fall back to the previously published version of that walk, if it's still current
  if (failed.length) { console.log(`Retrying ${failed.length} failed walk/language combination(s) in 60 s…`); await new Promise((r) => setTimeout(r, Number(process.env.RETRY_WAIT_MS ?? 60000))); }
  for (const f of failed) {
    try {
      const out = await buildOne(f.walk, f.lang, f.hash);
      fs.writeFileSync(path.join(OUT, "built", f.file), JSON.stringify(out));
      f.files[f.lang] = f.file; f.row.langs.push(f.lang); f.row.stops = out.stops.length; f.row.km = out.km;
      console.log(`${f.key} (${f.lang}): OK on retry`);
    } catch (e) {
      if (await f.reusePrev()) { f.row.reused++; warn(`${f.key} (${f.lang}): ${e.message}; kept the previously published version`); }
      else warn(`${f.key} (${f.lang}): ${e.message}; no ready-made data, phones will look it up themselves`);
    }
  }
  for (const d of doneWalks) if (Object.keys(d.files).length) index.walks[d.key] = { hash: d.hash, files: d.files };
  fs.writeFileSync(path.join(OUT, "built", "index.json"), JSON.stringify(index, null, 1));

  // 4. report
  const secs = Math.round((Date.now() - t0) / 1000);
  const md = [`### City Walks data build (${MODE})`, "", `${pf.stats.requests} requests to open data services, ${pf.stats.cached} answered from cache, ${secs} s.`, "",
    "| Walk | Languages | Stops | Positions | Route | Turn-by-turn |", "|---|---|---|---|---|---|",
    ...summary.map((r) => `| ${r.key} | ${r.langs.join(", ") || "❌ failed"}${r.reused ? ` (${r.reused} reused)` : ""} | ${r.stops} | ${r.placed || "–"} | ${r.km ? r.km.toFixed(1) + " km" : "–"} | ${r.turns || (r.reused ? "reused" : "–")} |`)].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  console.log(`\n${pf.stats.requests} requests, ${pf.stats.cached} cached, ${secs} s`);
  return { index, summary, stats: pf.stats };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
