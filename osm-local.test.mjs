// Tests for osm-local.mjs: answering the build's Overpass queries from a Geofabrik extract. Run with: node --test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { loadOsmExtract, answerOverpass } = await import("./osm-local.mjs");

// What `osmium export -f geojsonseq --attributes=type,id` writes: one feature per line.
const node = (id, lon, lat, tags) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { "@type": "node", "@id": id, ...tags } });
const way = (id, coords, tags, type = "LineString") => ({ type: "Feature", geometry: { type, coordinates: type === "Polygon" ? [coords] : coords }, properties: { "@type": "way", "@id": id, ...tags } });
function extractFile(features) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cw-osm-")), "osm.geojsonseq");
  fs.writeFileSync(file, features.map((f) => JSON.stringify(f)).join("\n") + "\n");
  return file;
}
// Geofabrik's boundary polygon format (.poly): name, ring id, "lon lat" lines, END per ring, END
function polyFile(text = "belgium\n1\n   2.500000E+00   4.950000E+01\n   6.400000E+00   4.950000E+01\n   6.400000E+00   5.150000E+01\n   2.500000E+00   5.150000E+01\nEND\nEND\n") {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cw-poly-")), "area.poly");
  fs.writeFileSync(file, text);
  return file;
}
const load = (features = FEATURES) => loadOsmExtract(extractFile(features), polyFile());
// Ghent centre, with a far-away corner object so the extract covers a realistic area
const FEATURES = [
  node(1, 3.7253, 51.0543, { tourism: "artwork", artwork_type: "mural", name: "Mural A" }),
  node(2, 3.7260, 51.0550, { tourism: "artwork", artwork_type: "statue", name: "Statue B" }),
  node(3, 3.7240, 51.0540, { amenity: "cafe", wikidata: "Q1" }),
  node(4, 3.7245, 51.0545, { highway: "crossing" }), // referenced node, no matching tag
  way(10, [[3.7200, 51.0560], [3.7210, 51.0560], [3.7210, 51.0570], [3.7200, 51.0570], [3.7200, 51.0560]], { building: "church", wikipedia: "nl:Kerk" }, "Polygon"),
  node(5, 3.9000, 51.2000, { tourism: "artwork", artwork_type: "mural" }), // outside the query areas
  // a large object reaching far outside the area, as real extracts have (e.g. a sea area with a wikidata tag)
  way(20, [[-5.6, 58.3], [7.2, 49.4]], { wikidata: "Q2" }),
];
const bboxQuery = (s, w, n, e) => `[out:json][timeout:25];(nwr["tourism"="artwork"](${s},${w},${n},${e});nwr["wikipedia"](${s},${w},${n},${e});nwr["wikidata"](${s},${w},${n},${e}););out center tags;`;
const artQuery = (types, r, lat, lon) => `[out:json][timeout:30];nwr["tourism"="artwork"]["artwork_type"~"^(${types})$"](around:${r},${lat},${lon});out center tags;`;

test("the bounding-box query returns artworks and Wikipedia/Wikidata-linked objects in the box, ways with their center", () => {
  const osm = load();
  const els = answerOverpass(osm, bboxQuery(51.0500, 3.7150, 51.0600, 3.7300));
  assert.deepEqual(els.map((e) => `${e.type}/${e.id}`), ["node/1", "node/2", "node/3", "way/10", "way/20"]);
  assert.deepEqual(els.find((e) => e.id === 10).center, { lat: 51.0565, lon: 3.7205 });
  assert.equal(els.find((e) => e.id === 1).lat, 51.0543);
  assert.deepEqual(els.find((e) => e.id === 3).tags, { amenity: "cafe", wikidata: "Q1" });
});

test("the artwork query returns only the asked artwork types within the radius", () => {
  const osm = load();
  assert.deepEqual(answerOverpass(osm, artQuery("mural|graffiti", 500, 51.0543, 3.7253)).map((e) => e.id), [1]);
  assert.deepEqual(answerOverpass(osm, artQuery("mural|statue", 500, 51.0543, 3.7253)).map((e) => e.id), [1, 2]);
  assert.deepEqual(answerOverpass(osm, artQuery("mural", 20, 51.0550, 3.7260)).map((e) => e.id), []); // Mural A is ~90 m away
});

test("a query it doesn't recognise isn't answered (it goes to the real Overpass)", () => {
  const osm = load();
  assert.equal(answerOverpass(osm, '[out:json];node["amenity"="cafe"](51,3,52,4);out;'), null);
  assert.equal(answerOverpass(osm, '[out:json][timeout:20];nwr["tourism"="artwork"](around:300,51.05,3.72);out center tags 5;'), null);
});

test("an area outside the extract's boundary isn't answered (it goes to the real Overpass), even where its data reaches", () => {
  const osm = load();
  assert.equal(answerOverpass(osm, bboxQuery(48.85, 2.33, 48.87, 2.36)), null); // Paris
  assert.equal(answerOverpass(osm, artQuery("mural", 1000, 48.86, 2.35)), null);
  assert.equal(answerOverpass(osm, bboxQuery(52.36, 4.88, 52.38, 4.91)), null); // Amsterdam: inside way 20's box
  assert.equal(answerOverpass(osm, artQuery("mural", 3000, 51.49, 4.0)), null); // the circle crosses the boundary
});

test("a boundary with a hole: an area in the hole isn't answered", () => {
  const holed = "x\n1\n 0 0\n 10 0\n 10 10\n 0 10\nEND\n!2\n 4 4\n 6 4\n 6 6\n 4 6\nEND\nEND\n";
  const osm = loadOsmExtract(extractFile([node(1, 1, 1, { tourism: "artwork" })]), polyFile(holed));
  assert.equal(answerOverpass(osm, bboxQuery(4.9, 4.9, 5.1, 5.1)), null);
  assert.deepEqual(answerOverpass(osm, bboxQuery(0.5, 0.5, 1.5, 1.5)).map((e) => e.id), [1]);
});

test("a missing or broken extract or boundary file gives no extract", () => {
  assert.equal(loadOsmExtract(path.join(os.tmpdir(), "does-not-exist.geojsonseq"), polyFile()), null);
  assert.equal(loadOsmExtract(extractFile(FEATURES), path.join(os.tmpdir(), "does-not-exist.poly")), null);
  assert.equal(loadOsmExtract(extractFile(FEATURES), polyFile("garbage\n")), null);
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cw-osm-")), "bad.geojsonseq");
  fs.writeFileSync(bad, "not json\n");
  assert.equal(loadOsmExtract(bad, polyFile()), null);
});
