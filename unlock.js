/* Passkey unlock helpers: record validation and token encryption. Exposes window.Unlock. */
(() => {
"use strict";
const KEY = "cw:unlock";
const TOKEN_RE = /^github_pat_[A-Za-z0-9_]{20,255}$/;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const INFO = "city-walks editor token v1", AAD = "cw-unlock-v1|";
const enc = new TextEncoder(), dec = new TextDecoder();

function b64uEnc(bytes) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uDec(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error("bad base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const newSalt = () => b64uEnc(crypto.getRandomValues(new Uint8Array(32)));

async function deriveKey(prf) {
  const base = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(INFO) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const needId = (id) => { if (typeof id !== "string" || !id) throw new Error("Missing credential id"); };
async function seal(key, payload, credentialId) {
  needId(credentialId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(AAD + credentialId) }, key, enc.encode(JSON.stringify({ token: payload.token, repo: payload.repo })));
  return { iv: b64uEnc(iv), ciphertext: b64uEnc(new Uint8Array(ct)) };
}
async function open(key, sealed, credentialId) {
  needId(credentialId);
  let p;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64uDec(sealed.iv), additionalData: enc.encode(AAD + credentialId) }, key, b64uDec(sealed.ciphertext));
    p = JSON.parse(dec.decode(pt));
  } catch { throw new Error("Could not decrypt the stored token"); }
  if (!p || typeof p.token !== "string" || typeof p.repo !== "string" || !TOKEN_RE.test(p.token) || !REPO_RE.test(p.repo)) throw new Error("Stored token is not valid");
  return { token: p.token, repo: p.repo };
}

const byteLen = (s) => { try { return b64uDec(s).length; } catch { return -1; } };
// Returns a validated record, or null when absent or malformed (never throws).
function parseRecord(raw) {
  let r;
  try { r = JSON.parse(raw); } catch { return null; }
  if (!r || typeof r !== "object" || Array.isArray(r) || r.v !== 1) return null;
  const idLen = byteLen(r.credentialId);
  if (idLen < 16 || idLen > 1023 || byteLen(r.salt) !== 32) return null;
  if (typeof r.repo !== "string" || !REPO_RE.test(r.repo) || !Number.isFinite(r.created)) return null;
  const out = { v: 1, credentialId: r.credentialId, salt: r.salt, repo: r.repo, created: r.created };
  if (r.iv !== undefined || r.ciphertext !== undefined) {
    if (typeof r.ciphertext !== "string" || r.ciphertext.length > 2048 || byteLen(r.ciphertext) < 16 || byteLen(r.iv) !== 12) return null;
    out.iv = r.iv; out.ciphertext = r.ciphertext;
  }
  return out;
}

window.Unlock = { KEY, TOKEN_RE, REPO_RE, b64uEnc, b64uDec, newSalt, deriveKey, seal, open, parseRecord };
})();
