/* Open data sources used to build walks. Loaded before app.js; exposes window.Sources.
 * Every host used here is also listed in the Content Security Policy in index.html. */
(() => {
"use strict";
const U = window.Util;
const { str, okLat, okLon, dist, norm, fetchJSON, sleep, dbg } = U;

// ---------- OpenStreetMap: Overpass ----------
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
async function overpass(q) {
  for (const u of OVERPASS) {
    try {
      const r = await fetchJSON(u, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" } }, 35000);
      return (r.elements || []).map((el) => ({ tags: el.tags || {}, lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon, id: el.type + "/" + el.id }))
        .filter((el) => okLat(el.lat) && okLon(el.lon));
    } catch (e) { dbg("overpass endpoint failed", u, String(e)); }
  }
  throw new Error("Overpass unavailable");
}
function commonsFromTags(t) {
  const f = str(t.wikimedia_commons, 300);
  if (/^File:/i.test(f)) return "https://commons.wikimedia.org/wiki/Special:FilePath/" + encodeURIComponent(f.slice(5)) + "?width=640";
  return null;
}
const osmLink = (id) => /^(node|way|relation)\/\d+$/.test(id) ? { label: "OpenStreetMap", url: "https://www.openstreetmap.org/" + id } : null;

// ---------- Wikipedia ----------
const LANGS = ["en", "nl", "fr", "de"];
const wikiCache = U.LS.get("bd:wiki2", {});
let wikiSave = null;
const remember = (k, v) => { wikiCache[k] = v; clearTimeout(wikiSave); wikiSave = setTimeout(() => U.LS.set("bd:wiki2", wikiCache), 800); return v; };
async function wikiSummary(lang, title) {
  if (!LANGS.includes(lang) || !title) return null;
  const k = "s:" + lang + ":" + title; if (wikiCache[k] !== undefined) return wikiCache[k];
  try {
    const r = await fetchJSON(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, {}, 12000);
    if (r.type === "disambiguation") return remember(k, null);
    return remember(k, {
      lang, title: str(r.title, 200), text: str(r.extract, 3000), url: U.safeUrl(r.content_urls?.mobile?.page),
      img: U.safeImg(r.thumbnail?.source), qid: /^Q\d+$/.test(r.wikibase_item || "") ? r.wikibase_item : null,
      lat: okLat(r.coordinates?.lat) ? r.coordinates.lat : null, lon: okLon(r.coordinates?.lon) ? r.coordinates.lon : null,
    });
  } catch (e) { dbg("wiki summary failed", lang, title, String(e)); return null; }
}
async function geosearch(lang, lat, lon, radius = 600) {
  const k = `g:${lang}:${lat.toFixed(4)},${lon.toFixed(4)}:${radius}`; if (wikiCache[k]) return wikiCache[k];
  const r = await fetchJSON(`https://${lang}.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${lat}|${lon}&gsradius=${radius}&gslimit=100&format=json&origin=*`, {}, 12000);
  return remember(k, (r.query?.geosearch || []).map((g) => ({ title: str(g.title, 200), lat: g.lat, lon: g.lon })));
}
// Wikidata sitelinks for a batch of QIDs -> { Q: { en: "Title", nl: "Titel", ... } }
async function sitelinks(qids) {
  const out = {}, todo = [];
  for (const q of qids) { const c = wikiCache["l:" + q]; if (c) out[q] = c; else todo.push(q); }
  for (let i = 0; i < todo.length; i += 50) {
    const ids = todo.slice(i, i + 50).join("|");
    try {
      const r = await fetchJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids}&props=sitelinks&sitefilter=${LANGS.map((l) => l + "wiki").join("|")}&format=json&origin=*`, {}, 15000);
      for (const [q, ent] of Object.entries(r.entities || {})) {
        const m = {}; for (const l of LANGS) if (ent.sitelinks?.[l + "wiki"]) m[l] = str(ent.sitelinks[l + "wiki"].title, 200);
        out[q] = remember("l:" + q, m);
      }
    } catch (e) { dbg("sitelinks failed", String(e)); }
  }
  return out;
}
const langOrder = (pref) => [pref, ...LANGS.filter((l) => l !== pref)];

// Resolve a stop to a Wikipedia article in the preferred language. Stop may have:
//   wikipedia: "nl:Titel" | wikidata: "Q123" | wiki: ["keyword", ...] (searched near the stop's coordinates)
async function resolveWiki(stop, pref) {
  let qid = stop.wikidata, first = null;
  if (!qid && stop.wikipedia) {
    const m = stop.wikipedia.match(/^([a-z]{2}):(.+)$/);
    if (m) { first = await wikiSummary(m[1], m[2]); qid = first?.qid; }
  }
  if (!qid && !first && stop.wiki?.length) {
    const keys = stop.wiki.map(norm);
    for (const lang of langOrder(pref)) {
      let hits = [];
      try { hits = await geosearch(lang, stop.lat, stop.lon, 700); } catch (e) { dbg("geosearch failed", lang, String(e)); continue; }
      const m = hits.filter((h) => keys.some((k) => norm(h.title).includes(k))).sort((a, b) => dist(stop, a) - dist(stop, b))[0];
      if (m) { first = await wikiSummary(lang, m.title); qid = first?.qid; if (first) break; }
    }
  }
  if (qid) {
    const links = (await sitelinks([qid]))[qid] || {};
    for (const l of langOrder(pref)) if (links[l]) {
      if (first && first.lang === l) break;
      const s = await wikiSummary(l, links[l]); if (s) { first = s; break; }
    }
  }
  if (first && !first.qid && qid) first.qid = qid;
  return first;
}

// ---------- Wikidata Query Service ----------
async function sparql(q) {
  const r = await fetchJSON("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), { headers: { Accept: "application/sparql-results+json" } }, 40000);
  return (r.results?.bindings || []).map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
}
const qidOf = (uri) => (String(uri).match(/\/(Q\d+)$/) || [])[1] || null;
const wkt = (s) => { const m = String(s).match(/Point\(([-\d.]+) ([-\d.]+)\)/); return m ? { lon: +m[1], lat: +m[2] } : null; };

// Heritage register links via Wikidata (Flemish heritage inventory = P1764). The URL pattern is read from Wikidata itself
// (formatter URL, P1630) and only used when it points to the allow-listed inventory site.
async function heritageLinks(qids) {
  if (!qids.length) return {};
  try {
    const rows = await sparql(`SELECT ?item ?id ?fmt WHERE { VALUES ?item { ${qids.map((q) => "wd:" + q).join(" ")} } ?item wdt:P1764 ?id . wd:P1764 wdt:P1630 ?fmt . }`);
    const out = {};
    for (const r of rows) {
      const q = qidOf(r.item), id = str(r.id, 30), fmt = str(r.fmt, 200);
      if (!q || !/^\d+$/.test(id) || !/^https:\/\/inventaris\.onroerenderfgoed\.be\/[^\s]*\$1$/.test(fmt)) continue;
      out[q] = { label: "Flemish heritage inventory", url: fmt.replace("$1", id) };
    }
    return out;
  } catch (e) { dbg("heritage links failed", String(e)); return {}; }
}

// ---------- Opendatasoft portals (City of Brussels, City of Ghent, ...) ----------
const ODS_HOSTS = ["opendata.brussels.be", "opendata.bruxelles.be", "data.stad.gent"];
function odsGeo(rec) { // find a {lat, lon} object anywhere in the record
  for (const v of Object.values(rec)) if (v && typeof v === "object" && okLat(v.lat) && okLon(v.lon)) return { lat: v.lat, lon: v.lon };
  for (const v of Object.values(rec)) if (v && v.type === "Point" && Array.isArray(v.coordinates)) { const [lon, lat] = v.coordinates; if (okLat(lat) && okLon(lon)) return { lat, lon }; }
  return null;
}
function odsField(rec, names) { for (const n of names || []) { const v = rec[n]; if (v != null && v !== "" && typeof v !== "object") return str(v, 2000); } return ""; }
function odsImage(rec, host) {
  for (const v of Object.values(rec)) if (v && typeof v === "object" && typeof v.url === "string") {
    const u = U.safeImg(v.url); if (u && new URL(u).hostname === host) return u;
  }
  return null;
}
async function odsRecords(src, max = 400) {
  const host = str(src.host, 100);
  if (!ODS_HOSTS.includes(host) || !/^[a-z0-9_@-]+$/i.test(src.dataset || "")) throw new Error("data source not allowed: " + host);
  const out = [];
  for (let off = 0; off < max; off += 100) {
    const r = await fetchJSON(`https://${host}/api/explore/v2.1/catalog/datasets/${encodeURIComponent(src.dataset)}/records?limit=100&offset=${off}`, {}, 20000);
    const res = r.results || []; out.push(...res);
    if (res.length < 100 || out.length >= (r.total_count || 0)) break;
  }
  dbg("ods", host, src.dataset, out.length, "records, fields:", Object.keys(out[0] || {}).join(","));
  return out.map((rec) => {
    const g = odsGeo(rec); if (!g) return null;
    const f = src.fields || {};
    return {
      ...g, raw: rec,
      title: odsField(rec, f.title), artist: odsField(rec, f.artist), year: odsField(rec, f.year), address: odsField(rec, f.address),
      text: odsField(rec, f.text), img: odsImage(rec, host),
      hay: norm(Object.values(rec).filter((v) => typeof v === "string").join(" ")),
    };
  }).filter(Boolean);
}

// ---------- generators: build a list of stops from open data ----------
async function genWikidata(g, pref, log) {
  const [lat, lon] = g.center, r = Math.min(3, Math.max(0.2, +g.radiusKm || 1)), min = Math.max(0, +g.minSitelinks || 3);
  log("Asking Wikidata for notable places…");
  const q = `SELECT DISTINCT ?item ?coord ?links ?label WHERE {
    SERVICE wikibase:around { ?item wdt:P625 ?coord . bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral . bd:serviceParam wikibase:radius "${r}" . }
    { ?item wdt:P1435 [] } UNION { ?item wdt:P1764 [] } UNION { VALUES ?t { wd:Q33506 wd:Q16970 wd:Q2977 wd:Q23413 wd:Q12280 wd:Q174782 wd:Q4989906 wd:Q179700 } ?item wdt:P31 ?t }
    ?item wikibase:sitelinks ?links . FILTER(?links >= ${min})
    FILTER NOT EXISTS { ?item wdt:P31 wd:Q79007 } FILTER NOT EXISTS { ?item wdt:P31 wd:Q5 }
    FILTER NOT EXISTS { ?item wdt:P31 wd:Q515 } FILTER NOT EXISTS { ?item wdt:P31 wd:Q493522 } FILTER NOT EXISTS { ?item wdt:P31 wd:Q1549591 }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "${pref},en,nl,fr" . ?item rdfs:label ?label . }
  } ORDER BY DESC(?links) LIMIT 200`;
  const rows = await sparql(q), seen = new Set(), stops = [];
  const exclude = new Set((g.exclude || []).filter((x) => /^Q\d+$/.test(x)));
  for (const row of rows) {
    const qid = qidOf(row.item), p = wkt(row.coord);
    if (!qid || !p || seen.has(qid) || exclude.has(qid) || /^Q\d+$/.test(row.label || "")) continue;
    if (stops.some((s) => dist(s, p) < 25)) continue; // same spot already in the list
    seen.add(qid);
    stops.push({ id: qid, title: str(row.label, 120), lat: p.lat, lon: p.lon, wikidata: qid, links: [{ label: "Wikidata", url: "https://www.wikidata.org/wiki/" + qid }] });
    if (stops.length >= Math.min(30, +g.limit || 15)) break;
  }
  dbg("wikidata generator:", rows.length, "rows ->", stops.length, "stops");
  return stops;
}
async function genOverpassArt(g, log) {
  const [lat, lon] = g.center, r = Math.round(Math.min(3000, Math.max(200, (+g.radiusKm || 1) * 1000)));
  const types = (g.artworkTypes || ["mural", "graffiti"]).filter((t) => /^[a-z_]+$/.test(t)).join("|");
  log("Asking OpenStreetMap for artworks…");
  const els = await overpass(`[out:json][timeout:30];nwr["tourism"="artwork"]["artwork_type"~"^(${types})$"](around:${r},${lat},${lon});out center tags;`);
  const stops = els.filter((el) => el.tags.tourism === "artwork").map((el) => {
    const t = el.tags;
    const title = str(t.name || t["name:en"] || t["name:nl"] || (t.artist_name ? "Work by " + t.artist_name : ""), 120);
    return {
      id: el.id.replace("/", "-"), title: title || (t.artwork_type === "graffiti" ? "Graffiti" : "Mural"),
      artist: str(t.artist_name, 120), year: str(t.start_date, 20), lat: el.lat, lon: el.lon,
      text: str(t.description || t["description:en"] || t.inscription || (t.artist_name ? `${t.artwork_type === "graffiti" ? "Graffiti" : "A mural"} by ${t.artist_name}.` : ""), 1500), img: commonsFromTags(t),
      wikidata: /^Q\d+$/.test(t.wikidata || "") ? t.wikidata : null, links: [osmLink(el.id)].filter(Boolean), named: !!title,
    };
  });
  stops.sort((a, b) => (b.named - a.named) || (dist({ lat, lon }, a) - dist({ lat, lon }, b)));
  dbg("overpass art generator:", els.length, "artworks");
  return stops.slice(0, Math.min(40, +g.limit || 20));
}
async function genOds(g, log) {
  log("Loading the city's open data…");
  const recs = await odsRecords(g);
  const c = { lat: g.center[0], lon: g.center[1] }, r = (+g.radiusKm || 1.5) * 1000;
  const host = str(g.host, 100);
  const stops = recs.filter((x) => dist(c, x) <= r).map((x, i) => ({
    id: "ods" + i + "-" + norm(x.title).replace(/[^a-z0-9]+/g, "-").slice(0, 30), title: x.title || "Mural", artist: x.artist, year: x.year, address: x.address,
    lat: x.lat, lon: x.lon, text: x.text, img: x.img,
    links: [{ label: g.sourceLabel || "Open data", url: `https://${host}/explore/dataset/${encodeURIComponent(g.dataset)}/` }],
  }));
  dbg("ods generator:", recs.length, "records ->", stops.length, "within radius");
  return stops.slice(0, Math.min(80, +g.limit || 60));
}

// ---------- ordering: nearest neighbour + 2-opt for a short open walk ----------
function orderStops(stops, start) {
  if (stops.length < 3) return stops;
  const rest = stops.slice(); const route = [];
  let cur = start ? rest.reduce((b, s) => dist(start, s) < dist(start, b) ? s : b, rest[0]) : rest[0];
  route.push(cur); rest.splice(rest.indexOf(cur), 1);
  while (rest.length) { const nx = rest.reduce((b, s) => dist(cur, s) < dist(cur, b) ? s : b, rest[0]); route.push(nx); rest.splice(rest.indexOf(nx), 1); cur = nx; }
  let improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 1; i < route.length - 2; i++) for (let k = i + 1; k < route.length - 1; k++) {
      const d0 = dist(route[i - 1], route[i]) + dist(route[k], route[k + 1]);
      const d1 = dist(route[i - 1], route[k]) + dist(route[i], route[k + 1]);
      if (d1 + 0.5 < d0) { route.splice(i, k - i + 1, ...route.slice(i, k + 1).reverse()); improved = true; }
    }
  }
  return route;
}

// ---------- walking route (OSRM, FOSSGIS) ----------
async function walkingRoute(stops) {
  const coords = stops.map((s) => `${s.lon.toFixed(6)},${s.lat.toFixed(6)}`).join(";");
  const r = await fetchJSON(`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coords}?overview=full&geometries=geojson`, {}, 25000);
  const line = r.routes[0].geometry.coordinates.filter(([lo, la]) => okLat(la) && okLon(lo)).map(([lon, lat]) => ({ lat, lon }));
  return { line, km: r.routes[0].distance / 1000 };
}

// ---------- geocoding (Nominatim; max 1 request per second) ----------
async function geocode(q) {
  const r = await fetchJSON("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(q), {}, 10000);
  if (!r[0]) return null; const p = { lat: +r[0].lat, lon: +r[0].lon };
  return okLat(p.lat) && okLon(p.lon) ? p : null;
}

// ---------- self-test: checks each source from the phone and logs the result ----------
async function selfTest(log) {
  const t = async (name, fn) => { const t0 = Date.now(); try { const r = await fn(); log(`✓ ${name} (${Date.now() - t0} ms) ${r || ""}`); } catch (e) { log(`✗ ${name}: ${e.message || e}`); } };
  await t("Wikipedia summary", async () => (await wikiSummary("en", "Manneken Pis"))?.title);
  await t("Wikipedia geosearch", async () => (await geosearch("nl", 51.0543, 3.7253, 300)).length + " hits");
  await t("Wikidata sitelinks", async () => { const q = (await wikiSummary("en", "Gravensteen"))?.qid; return q + " " + JSON.stringify((await sitelinks([q]))[q] || {}).slice(0, 100); });
  await t("Wikidata SPARQL", async () => (await sparql("SELECT ?l WHERE { wd:Q1296 rdfs:label ?l FILTER(LANG(?l)='nl') }"))[0]?.l);
  await t("Heritage links (P1764)", async () => { const q = (await wikiSummary("en", "Gravensteen"))?.qid; return JSON.stringify(await heritageLinks([q])).slice(0, 160); });
  await t("Wikidata generator", async () => (await genWikidata({ center: [51.0543, 3.7253], radiusKm: 0.8, limit: 5 }, "en", () => {})).map((s) => s.title).join(", "));
  await t("Overpass", async () => (await overpass('[out:json][timeout:20];nwr["tourism"="artwork"](around:300,50.8467,4.3525);out center tags 5;')).length + " artworks");
  await t("City of Brussels open data", async () => { const r = await odsRecords({ host: "opendata.brussels.be", dataset: "bruxelles_parcours_bd" }, 100); return r.length + " records; first: " + JSON.stringify(r[0]?.raw || {}).slice(0, 300); });
  await t("Walking route (OSRM)", async () => (await walkingRoute([{ lat: 50.8467, lon: 4.3525 }, { lat: 50.8450, lon: 4.3500 }])).km.toFixed(2) + " km");
  await t("Nominatim", async () => JSON.stringify(await geocode("Grote Markt, Antwerpen")));
}

window.Sources = { overpass, commonsFromTags, osmLink, wikiSummary, geosearch, sitelinks, resolveWiki, sparql, heritageLinks, odsRecords,
  genWikidata, genOverpassArt, genOds, orderStops, walkingRoute, geocode, selfTest, LANGS, ODS_HOSTS };
})();
