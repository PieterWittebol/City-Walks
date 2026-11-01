/* Walk and city file format: validation shared by the app and the editor.
 * The editor refuses to save anything that doesn't pass these checks, so the app always accepts what's saved. */
(() => {
"use strict";
const U = window.Util, Src = window.Sources;
const { str, num, okLat, okLon, safeUrl, safeImg } = U;
const cleanId = (v, d) => str(v, 60).replace(/[^a-z0-9_-]/gi, "") || d;
const strList = (v, n = 10, max = 60) => Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, n) : [];
const okPoint = (p) => Array.isArray(p) && p.length === 2 && okLat(p[0]) && okLon(p[1]);
function cleanStop(s, i, ids) {
  let id = cleanId(s.id, "stop" + i); while (ids.has(id)) id += "_"; ids.add(id);
  return {
    id, title: str(s.title, 120), artist: str(s.artist, 120), year: str(s.year, 20), address: str(s.address, 160),
    lat: s.lat, lon: s.lon, text: str(s.text, 3000), textLang: Src.LANGS.includes(s.textLang) ? s.textLang : null, img: safeImg(s.image || s.img),
    match: strList(s.match, 10, 40), artworkType: ["statue", "mural"].includes(s.artworkType) ? s.artworkType : null, fixed: s.fixed === true,
    wiki: strList(s.wiki, 6, 80), wikipedia: /^[a-z]{2}:.{1,200}$/.test(s.wikipedia || "") ? s.wikipedia : null,
    wikidata: /^Q\d{1,12}$/.test(s.wikidata || "") ? s.wikidata : null,
    links: Array.isArray(s.links) ? s.links.map((l) => l && { label: str(l.label, 60), url: safeUrl(l.url) }).filter((l) => l && l.url) : [],
  };
}
function cleanSource(g) {
  if (!g || typeof g !== "object") return null;
  const type = ["wikidata", "osm-art", "ods"].includes(g.type) ? g.type : null;
  if (!type || !okPoint(g.center)) return null;
  const f = g.fields && typeof g.fields === "object" ? Object.fromEntries(["title", "artist", "year", "address", "text"].map((k) => [k, strList(g.fields[k], 12, 60)])) : {};
  return { type, center: g.center, radiusKm: num(g.radiusKm), limit: num(g.limit), minSitelinks: num(g.minSitelinks), exclude: strList(g.exclude, 50, 15),
    artworkTypes: strList(g.artworkTypes, 6, 20), host: str(g.host, 100), dataset: str(g.dataset, 100), fields: f, sourceLabel: str(g.sourceLabel, 80) };
}
function cleanWalk(w) {
  if (!w || typeof w !== "object") throw new Error("not a walk file");
  const ids = new Set();
  const stops = (Array.isArray(w.stops) ? w.stops : []).filter((s) => s && okLat(s.lat) && okLon(s.lon) && s.title).map((s, i) => cleanStop(s, i, ids));
  const generator = cleanSource(w.generator);
  if (!stops.length && !generator) throw new Error("walk has no stops");
  return {
    id: cleanId(w.id, "walk"), title: str(w.title, 120), subtitle: str(w.subtitle, 120), description: str(w.description, 1000),
    lang: Src.LANGS.includes(w.lang) ? w.lang : "en", geocodeSuffix: str(w.geocodeSuffix, 120),
    start: okPoint(w.start) ? { lat: w.start[0], lon: w.start[1] } : null,
    stops, generator,
    matchSources: (Array.isArray(w.matchSources) ? w.matchSources : []).map((m) => cleanSource({ ...m, center: [0, 0] })).filter((m) => m && m.type === "ods"),
    sights: (Array.isArray(w.sights) ? w.sights : []).filter((s) => s && okLat(s.lat) && okLon(s.lon) && s.title)
      .map((s) => ({ title: str(s.title, 120), lat: s.lat, lon: s.lon, text: str(s.text, 1500), curated: true })),
  };
}
const validFile = (f) => typeof f === "string" && /^walk-[a-z0-9-]+\.json$/.test(f);
const KINDS = ["comics", "street-art", "heritage", "highlights"];

// Strict check for the editor: returns a list of problems (empty = OK to save).
function checkWalk(w) {
  const errs = [];
  if (!/^[a-z0-9_-]{1,60}$/.test(w.id || "")) errs.push("Walk id: use 1–60 lowercase letters, digits, - or _.");
  if (!str(w.title).trim()) errs.push("The walk needs a title.");
  if (w.lang && !Src.LANGS.includes(w.lang)) errs.push("Language must be one of " + Src.LANGS.join(", ") + ".");
  const stops = Array.isArray(w.stops) ? w.stops : [];
  if (w.generator) {
    const g = cleanSource(w.generator);
    if (!g) errs.push("Generated walk: choose a type and a centre point.");
    else {
      if (!(g.radiusKm > 0 && g.radiusKm <= 3)) errs.push("Radius must be between 0.1 and 3 km.");
      if (g.type === "ods" && !Src.ODS_HOSTS.includes(g.host)) errs.push("Open data portal must be one of: " + Src.ODS_HOSTS.join(", ") + ".");
      if (g.type === "ods" && !/^[a-z0-9_@-]+$/i.test(g.dataset)) errs.push("Dataset id is missing or invalid.");
    }
  } else if (!stops.length) errs.push("Add at least one stop.");
  const ids = new Set();
  stops.forEach((s, i) => {
    const n = `Stop ${i + 1}${s.title ? " (" + str(s.title, 40) + ")" : ""}: `;
    if (!str(s.title).trim()) errs.push(n + "needs a title.");
    if (!okLat(s.lat) || !okLon(s.lon)) errs.push(n + "position is missing or invalid.");
    if (!/^[a-z0-9_-]{1,60}$/i.test(s.id || "")) errs.push(n + "id: use letters, digits, - or _.");
    else if (ids.has(s.id)) errs.push(n + "id '" + s.id + "' is used twice."); else ids.add(s.id);
    if (s.image && !safeImg(s.image)) errs.push(n + "image must be a file in the repository or an upload.wikimedia.org link.");
    if (s.wikipedia && !/^[a-z]{2}:.{1,200}$/.test(s.wikipedia)) errs.push(n + "Wikipedia reference must look like nl:Title.");
    if (s.wikidata && !/^Q\d{1,12}$/.test(s.wikidata)) errs.push(n + "Wikidata id must look like Q123.");
    if (str(s.text).length > 3000) errs.push(n + "text is longer than 3000 characters.");
  });
  try { cleanWalk(w); } catch (e) { errs.push(e.message); }
  return errs;
}
function checkCities(c) {
  const errs = [], ids = new Set(), files = new Set();
  if (!c || !Array.isArray(c.cities)) return ["cities.json has no cities list."];
  c.cities.forEach((city, i) => {
    const n = `City ${i + 1}${city.name ? " (" + str(city.name, 30) + ")" : ""}: `;
    if (!/^[a-z0-9_-]{1,60}$/.test(city.id || "")) errs.push(n + "id: use lowercase letters, digits, - or _.");
    else if (ids.has(city.id)) errs.push(n + "id is used twice."); else ids.add(city.id);
    if (!str(city.name).trim()) errs.push(n + "needs a name.");
    if (!okLat(city.lat) || !okLon(city.lon)) errs.push(n + "centre position is invalid.");
    const wids = new Set();
    (city.walks || []).forEach((w) => {
      if (!validFile(w.file)) errs.push(n + "walk file name '" + str(w.file, 60) + "' is invalid.");
      if (files.has(w.file)) errs.push(n + "walk file '" + w.file + "' is listed twice."); files.add(w.file);
      if (wids.has(w.id)) errs.push(n + "walk id '" + w.id + "' is used twice."); wids.add(w.id);
      if (w.kind && !KINDS.includes(w.kind)) errs.push(n + "unknown walk kind '" + str(w.kind, 20) + "'.");
    });
  });
  return errs;
}

// Turn-by-turn legs between stops (see Sources.walkingRoute)
const STEP_TYPES = ["depart", "arrive", "turn", "new name", "continue", "merge", "on ramp", "off ramp", "fork", "end of road", "use lane", "roundabout", "rotary", "roundabout turn", "exit roundabout", "exit rotary", "notification"];
const MODIFIERS = ["uturn", "sharp right", "right", "slight right", "straight", "slight left", "left", "sharp left"];
function cleanLeg(l) {
  if (!l || !Array.isArray(l.line) || !Array.isArray(l.steps)) return null;
  const line = l.line.filter((p) => Array.isArray(p) && okLat(p[0]) && okLon(p[1])).slice(0, 5000).map((p) => [p[0], p[1]]);
  if (line.length < 1) return null;
  const steps = l.steps.slice(0, 300).map((s) => s && ({
    t: STEP_TYPES.includes(s.t) ? s.t : "turn", m: MODIFIERS.includes(s.m) ? s.m : "", n: str(s.n, 80),
    i: Number.isInteger(s.i) && s.i >= 0 && s.i < line.length ? s.i : 0, x: Number.isInteger(s.x) && s.x > 0 && s.x < 20 ? s.x : undefined,
    b: Number.isFinite(s.b) ? s.b : undefined,
  })).filter(Boolean);
  return { line, steps };
}
function cleanLegs(legs, nStops) {
  if (!Array.isArray(legs) || legs.length !== nStops - 1) return null;
  const out = legs.map(cleanLeg);
  return out.every(Boolean) ? out : null;
}
// Ready-made walk data from the GitHub build (built/*.json): treated as untrusted and sanitised like everything else.
function cleanBuilt(b) {
  if (!b || typeof b !== "object" || !Array.isArray(b.stops)) return null;
  const ids = new Set();
  const stops = b.stops.filter((s) => s && okLat(s.lat) && okLon(s.lon) && s.title).map((s, i) => {
    const c = cleanStop(s, i, ids);
    c.credit = str(s.credit, 120); c.src = ["wikipedia", "ods", "osm", "geocode"].includes(s.src) ? s.src : undefined;
    c.qid = /^Q\d{1,12}$/.test(s.qid || "") ? s.qid : undefined;
    return c;
  });
  if (!stops.length) return null;
  const line = (Array.isArray(b.line) ? b.line : []).filter((p) => p && okLat(p.lat) && okLon(p.lon)).slice(0, 20000).map((p) => ({ lat: p.lat, lon: p.lon }));
  const live = (Array.isArray(b.live) ? b.live : []).filter((x) => x && okLat(x.lat) && okLon(x.lon) && x.title).slice(0, 80).map((x) => ({
    title: str(x.title, 120), lat: x.lat, lon: x.lon, text: str(x.text, 600), url: safeUrl(x.url),
    wp: /^[a-z-]{2,12}:.{1,200}$/.test(x.wp || "") ? x.wp : null, wd: /^Q\d{1,12}$/.test(x.wd || "") ? x.wd : null,
  }));
  const legs = cleanLegs(b.legs, stops.length);
  return { hash: str(b.hash, 20), lang: Src.LANGS.includes(b.lang) ? b.lang : null, builtAt: str(b.builtAt, 40), legs,
    stops, line: line.length > 1 ? line : stops.map((p) => ({ lat: p.lat, lon: p.lon })), km: typeof b.km === "number" && isFinite(b.km) ? b.km : null, live };
}
window.Schema = { cleanLeg, cleanLegs, cleanBuilt, cleanId, strList, okPoint, cleanStop, cleanSource, cleanWalk, validFile, checkWalk, checkCities, KINDS };
})();
