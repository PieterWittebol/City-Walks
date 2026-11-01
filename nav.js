/* Turn-by-turn navigation along a walking leg: where am I on the route, what's the next manoeuvre, and how
 * to say it (English, Dutch, French, German). Pure logic, no UI. Exposes window.Nav. */
(() => {
"use strict";
const { dist } = window.Util;

// Prepare a leg ({ line: [[lat,lon]...], steps }) for fast lookups.
function prepare(leg) {
  const pts = leg.line.map(([lat, lon]) => ({ lat, lon }));
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const steps = leg.steps.map((s) => ({ ...s, along: cum[Math.min(s.i, cum.length - 1)] || 0 }));
  return { pts, cum, steps, length: cum[cum.length - 1] || 0 };
}
// Project a position onto the leg: distance from the route (off) and distance travelled along it (along).
function locate(P, pos, hint = 0) {
  const kx = Math.cos(pos.lat * Math.PI / 180) * 111320, ky = 110540;
  let best = { off: Infinity, along: 0, seg: 0 };
  for (let i = 0; i < P.pts.length - 1; i++) {
    const a = P.pts[i], b = P.pts[i + 1];
    const ax = (a.lon - pos.lon) * kx, ay = (a.lat - pos.lat) * ky, bx = (b.lon - pos.lon) * kx, by = (b.lat - pos.lat) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? -(ax * dx + ay * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    let off = Math.hypot(ax + t * dx, ay + t * dy);
    if (i + 1 < hint) off += 15; // prefer not to jump backwards along the route
    if (off < best.off) best = { off, along: P.cum[i] + t * (P.cum[i + 1] - P.cum[i]), seg: i };
  }
  if (P.pts.length === 1) best = { off: dist(pos, P.pts[0]), along: 0, seg: 0 };
  return best;
}
// The next manoeuvre ahead of `along` (skipping the departure) and the distance to it.
function upcoming(P, along) {
  for (const s of P.steps) {
    if (s.t === "depart") continue;
    if (s.along > along + 3) return { step: s, dist: s.along - along };
  }
  const last = P.steps[P.steps.length - 1];
  return { step: last && last.t === "arrive" ? last : { t: "arrive" }, dist: Math.max(0, P.length - along) };
}
// The step the walker is currently on (for "continue on X").
function current(P, along) { let c = P.steps[0]; for (const s of P.steps) if (s.along <= along + 3) c = s; return c; }

// ---------- wording ----------
const T = {
  en: { left: "left", right: "right", "slight left": "slightly left", "slight right": "slightly right", "sharp left": "sharp left", "sharp right": "sharp right",
    turn: (d, n) => `Turn ${d}` + (n ? ` onto ${n}` : ""), keep: (d, n) => `Keep ${d}` + (n ? ` onto ${n}` : ""), straight: (n) => n ? `Continue on ${n}` : "Continue straight ahead",
    uturn: () => "Turn around", endroad: (d, n) => `At the end of the street, turn ${d}` + (n ? ` onto ${n}` : ""),
    round: (x, n) => `At the roundabout, take the ${ord("en", x)} exit` + (n ? ` onto ${n}` : ""), arrive: (s) => `You've arrived at ${s}`, head: (c, n) => `Head ${c}` + (n ? ` on ${n}` : ""),
    in: (d) => `In ${d}`, now: "Now", then: "then", N: ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"] },
  nl: { left: "links", right: "rechts", "slight left": "flauw links", "slight right": "flauw rechts", "sharp left": "scherp links", "sharp right": "scherp rechts",
    turn: (d, n) => `Sla ${d}af` + (n ? `, de ${n} in` : ""),
    keep: (d, n) => `Houd ${d} aan` + (n ? `, richting ${n}` : ""), straight: (n) => n ? `Ga verder rechtdoor op de ${n}` : "Ga rechtdoor",
    uturn: () => "Keer om", endroad: (d, n) => `Sla aan het einde van de straat ${d}af` + (n ? `, de ${n} in` : ""),
    round: (x, n) => `Neem op de rotonde de ${ord("nl", x)} afslag` + (n ? `, de ${n} in` : ""), arrive: (s) => `Je bent aangekomen bij ${s}`, head: (c, n) => `Ga richting ${c}` + (n ? ` op de ${n}` : ""),
    in: (d) => `Over ${d}`, now: "Nu", then: "daarna", N: ["het noorden", "het noordoosten", "het oosten", "het zuidoosten", "het zuiden", "het zuidwesten", "het westen", "het noordwesten"] },
  fr: { left: "à gauche", right: "à droite", "slight left": "légèrement à gauche", "slight right": "légèrement à droite", "sharp left": "franchement à gauche", "sharp right": "franchement à droite",
    turn: (d, n) => `Tournez ${d}` + (n ? ` sur ${n}` : ""), keep: (d, n) => `Restez ${d}` + (n ? ` sur ${n}` : ""), straight: (n) => n ? `Continuez sur ${n}` : "Continuez tout droit",
    uturn: () => "Faites demi-tour", endroad: (d, n) => `Au bout de la rue, tournez ${d}` + (n ? ` sur ${n}` : ""),
    round: (x, n) => `Au rond-point, prenez la ${ord("fr", x)} sortie` + (n ? ` sur ${n}` : ""), arrive: (s) => `Vous êtes arrivé à ${s}`, head: (c, n) => `Partez vers ${c}` + (n ? ` sur ${n}` : ""),
    in: (d) => `Dans ${d}`, now: "Maintenant", then: "puis", N: ["le nord", "le nord-est", "l'est", "le sud-est", "le sud", "le sud-ouest", "l'ouest", "le nord-ouest"] },
  de: { left: "links", right: "rechts", "slight left": "leicht links", "slight right": "leicht rechts", "sharp left": "scharf links", "sharp right": "scharf rechts",
    turn: (d, n) => `${cap(d)} abbiegen` + (n ? ` auf ${n}` : ""), keep: (d, n) => `${cap(d)} halten` + (n ? ` auf ${n}` : ""), straight: (n) => n ? `Weiter auf ${n}` : "Geradeaus weiter",
    uturn: () => "Wenden", endroad: (d, n) => `Am Ende der Straße ${d} abbiegen` + (n ? ` auf ${n}` : ""),
    round: (x, n) => `Im Kreisverkehr die ${ord("de", x)} Ausfahrt nehmen` + (n ? ` auf ${n}` : ""), arrive: (s) => `Sie haben ${s} erreicht`, head: (c, n) => `Richtung ${c} gehen` + (n ? ` auf ${n}` : ""),
    in: (d) => `In ${d}`, now: "Jetzt", then: "dann", N: ["Norden", "Nordosten", "Osten", "Südosten", "Süden", "Südwesten", "Westen", "Nordwesten"] },
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function ord(lang, x) {
  x = x || 1;
  if (lang === "en") return x + (x % 10 === 1 && x !== 11 ? "st" : x % 10 === 2 && x !== 12 ? "nd" : x % 10 === 3 && x !== 13 ? "rd" : "th");
  if (lang === "nl") return x + "e"; if (lang === "fr") return x === 1 ? "1re" : x + "e"; return x + ".";
}
const fmt = (m) => m < 1000 ? `${Math.max(5, Math.round(m / 5) * 5)} m` : `${(m / 1000).toFixed(1)} km`;
function text(step, lang, stopTitle) {
  const L = T[lang] || T.en, n = step.n || "", m = step.m || "straight";
  const dir = L[m] || L.left;
  switch (step.t) {
    case "arrive": return L.arrive(stopTitle || "");
    case "depart": return L.head(L.N[Math.round(((step.b || 0) % 360) / 45) % 8], n);
    case "roundabout": case "rotary": return L.round(step.x, n);
    case "end of road": return L.endroad(dir, n);
    case "fork": case "use lane": case "merge": case "on ramp": case "off ramp":
      return m === "straight" ? L.straight(n) : L.keep(dir, n);
    default:
      if (m === "uturn") return L.uturn();
      if (m === "straight" || !step.m) return L.straight(n);
      if (m.startsWith("slight") && step.t !== "turn") return L.keep(dir, n);
      return L.turn(dir, n);
  }
}
// Arrow angle for the instruction icon (0 = straight ahead, negative = left)
const ANGLE = { uturn: 180, "sharp right": 135, right: 90, "slight right": 45, straight: 0, "slight left": -45, left: -90, "sharp left": -135 };
function icon(step) {
  if (!step || step.t === "arrive") return { glyph: "⚑", rot: 0 };
  if (step.t === "roundabout" || step.t === "rotary") return { glyph: "⟳", rot: 0 };
  return { glyph: "↑", rot: ANGLE[step.m] ?? 0 };
}
window.Nav = { prepare, locate, upcoming, current, text, icon, fmt, words: (lang) => T[lang] || T.en };
})();
