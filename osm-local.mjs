// Answers the build's two Overpass questions from an OpenStreetMap extract (Geofabrik, filtered with osmium; see
// .github/workflows/build.yml), so the build doesn't depend on the busy public Overpass servers.
// The extract is `osmium export -f geojsonseq --attributes=type,id` output: one GeoJSON feature per line, with
// "@type"/"@id" and the OSM tags as properties. Its boundary is Geofabrik's .poly file for the same extract (objects
// in the data can reach far beyond it). Queries it doesn't recognise, or areas not fully inside the boundary, get
// null: the caller then asks the real Overpass. Not published (only used by build.mjs).
import fs from "node:fs";

const R = 6371000, rad = (d) => (d * Math.PI) / 180;
const dist = (a, b) => 2 * R * Math.asin(Math.sqrt(Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2));
const TYPES = { node: 0, way: 1, relation: 2 };
const wanted = (t) => t.tourism === "artwork" || t.wikipedia != null || t.wikidata != null;

// Geofabrik .poly: a name line, then rings ("1", or "!2" for a hole) of "lon lat" lines, each closed by END; END.
function parsePoly(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean), outer = [], holes = [];
  let i = 1;
  while (i < lines.length && lines[i] !== "END") {
    const hole = lines[i].startsWith("!"), ring = [];
    for (i++; i < lines.length && lines[i] !== "END"; i++) {
      const [lon, lat] = lines[i].split(/\s+/).map(Number);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      ring.push([lon, lat]);
    }
    if (i >= lines.length || ring.length < 3) return null;
    (hole ? holes : outer).push(ring);
    i++;
  }
  return i < lines.length && outer.length ? { outer, holes } : null;
}
const inRing = (ring, x, y) => { // ray casting
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const cross = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
const segmentsMeet = (p1, p2, p3, p4) => {
  const d1 = cross(...p3, ...p4, ...p1), d2 = cross(...p3, ...p4, ...p2), d3 = cross(...p1, ...p2, ...p3), d4 = cross(...p1, ...p2, ...p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
};
// A box is covered when its corners are inside the boundary (outside every hole) and no boundary edge crosses it.
function covers(poly, s, w, n, e) {
  const corners = [[w, s], [e, s], [e, n], [w, n]];
  const inPoly = ([x, y]) => poly.outer.some((r) => inRing(r, x, y)) && !poly.holes.some((r) => inRing(r, x, y));
  if (!corners.every(inPoly)) return false;
  for (const ring of [...poly.outer, ...poly.holes])
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      for (let k = 0; k < 4; k++) if (segmentsMeet(a, b, corners[k], corners[(k + 1) % 4])) return false;
    }
  return true;
}

// Reads the extract and its boundary; returns null when either is missing or unreadable (the build then uses the
// public Overpass).
export function loadOsmExtract(file, boundaryFile) {
  let text, poly;
  try { text = fs.readFileSync(file, "utf8"); poly = parsePoly(fs.readFileSync(boundaryFile, "utf8")); } catch { return null; }
  if (!poly) return null;
  const els = [];
  try {
    for (let line of text.split("\n")) {
      line = line.replace(/^\x1e/, "").trim(); // osmium may start each record with a record separator
      if (!line) continue;
      const f = JSON.parse(line), p = f.properties || {}, type = p["@type"], id = p["@id"];
      if (!(type in TYPES) || !Number.isInteger(id)) continue;
      const pts = [];
      (function walk(c) { if (typeof c[0] === "number") pts.push(c); else for (const x of c) walk(x); })(f.geometry.coordinates);
      if (!pts.length) continue;
      const box = { s: Math.min(...pts.map((q) => q[1])), w: Math.min(...pts.map((q) => q[0])), n: Math.max(...pts.map((q) => q[1])), e: Math.max(...pts.map((q) => q[0])) };
      const tags = {};
      for (const [k, v] of Object.entries(p)) if (!k.startsWith("@")) tags[k] = String(v);
      if (!wanted(tags)) continue; // referenced objects osmium keeps for geometry
      els.push({ type, id, box, tags });
    }
  } catch { return null; }
  if (!els.length) return null;
  els.sort((a, b) => TYPES[a.type] - TYPES[b.type] || a.id - b.id); // Overpass order: nodes, ways, relations; by id
  return { els, poly };
}

const NUM = "(-?\\d+(?:\\.\\d+)?)";
// builder.js: everything that may be a mural or a sight along the way, in a bounding box
const BBOX_Q = new RegExp(`^\\[out:json\\]\\[timeout:\\d+\\];\\(nwr\\["tourism"="artwork"\\]\\(${NUM},${NUM},${NUM},${NUM}\\);nwr\\["wikipedia"\\]\\(\\1,\\2,\\3,\\4\\);nwr\\["wikidata"\\]\\(\\1,\\2,\\3,\\4\\);\\);out center tags;$`);
// sources.js genOverpassArt: artworks of some types around a point
const ART_Q = new RegExp(`^\\[out:json\\]\\[timeout:\\d+\\];nwr\\["tourism"="artwork"\\]\\["artwork_type"~"\\^\\(([a-z_|]+)\\)\\$"\\]\\(around:${NUM},${NUM},${NUM}\\);out center tags;$`);

const r7 = (x) => Math.round(x * 1e7) / 1e7; // Overpass gives 7 decimals
const out = (el) => {
  const lat = r7((el.box.s + el.box.n) / 2), lon = r7((el.box.w + el.box.e) / 2);
  return el.type === "node" ? { type: el.type, id: el.id, lat, lon, tags: el.tags } : { type: el.type, id: el.id, center: { lat, lon }, tags: el.tags };
};

// Overpass JSON "elements" for a query, or null when this query (or its area) can't be answered here.
export function answerOverpass(osm, query) {
  let m;
  if ((m = BBOX_Q.exec(query))) {
    const [s, w, n, e] = m.slice(1, 5).map(Number);
    if (!covers(osm.poly, s, w, n, e)) return null;
    return osm.els.filter((el) => el.box.s <= n && el.box.n >= s && el.box.w <= e && el.box.e >= w).map(out);
  }
  if ((m = ART_Q.exec(query))) {
    const types = new Set(m[1].split("|")), r = Number(m[2]), c = { lat: Number(m[3]), lon: Number(m[4]) };
    const dLat = r / 111320, dLon = r / (111320 * Math.cos(rad(c.lat)));
    if (!covers(osm.poly, c.lat - dLat, c.lon - dLon, c.lat + dLat, c.lon + dLon)) return null;
    return osm.els.filter((el) => {
      if (el.tags.tourism !== "artwork" || !types.has(el.tags.artwork_type)) return false;
      const near = { lat: Math.min(Math.max(c.lat, el.box.s), el.box.n), lon: Math.min(Math.max(c.lon, el.box.w), el.box.e) }; // closest point of its box
      return dist(c, near) <= r;
    }).map(out);
  }
  return null;
}
