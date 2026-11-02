import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
function loadUnlock() {
  const sandbox = { crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "unlock.js"), "utf8"), sandbox, { filename: "unlock.js" });
  return sandbox.Unlock;
}
const U = loadUnlock();
const TOKEN = "github_pat_" + "A".repeat(40), REPO = "PieterWittebol/City-Walks";
const plain = (x) => JSON.parse(JSON.stringify(x)); // objects from the vm context have another prototype
const prf = (n) => new Uint8Array(32).fill(n);
const b64 = (n) => U.b64uEnc(new Uint8Array(n).fill(1));
const record = (o = {}) => ({ v: 1, credentialId: b64(32), salt: b64(32), iv: b64(12), ciphertext: b64(60), repo: REPO, created: 1700000000000, ...o });

test("seal then open returns the token and repo", async () => {
  const key = await U.deriveKey(prf(7));
  const sealed = await U.seal(key, { token: TOKEN, repo: REPO }, "credA");
  assert.deepEqual(plain(await U.open(key, sealed, "credA")), { token: TOKEN, repo: REPO });
});

test("open fails with another credential id", async () => {
  const key = await U.deriveKey(prf(7));
  const sealed = await U.seal(key, { token: TOKEN, repo: REPO }, "credA");
  await assert.rejects(U.open(key, sealed, "credB"));
});

test("open fails with a different PRF output", async () => {
  const sealed = await U.seal(await U.deriveKey(prf(7)), { token: TOKEN, repo: REPO }, "credA");
  await assert.rejects(U.open(await U.deriveKey(prf(8)), sealed, "credA"));
});

test("open fails when the ciphertext is changed", async () => {
  const key = await U.deriveKey(prf(7));
  const sealed = await U.seal(key, { token: TOKEN, repo: REPO }, "credA");
  const c = sealed.ciphertext;
  await assert.rejects(U.open(key, { ...sealed, ciphertext: (c[0] === "A" ? "B" : "A") + c.slice(1) }, "credA"));
});

test("two seals of the same token differ", async () => {
  const key = await U.deriveKey(prf(7));
  const a = await U.seal(key, { token: TOKEN, repo: REPO }, "credA");
  const b = await U.seal(key, { token: TOKEN, repo: REPO }, "credA");
  assert.notEqual(a.iv, b.iv);
});

test("open rejects a payload that isn't a fine-grained token", async () => {
  const key = await U.deriveKey(prf(7));
  const sealed = await U.seal(key, { token: "ghp_x", repo: REPO }, "credA");
  await assert.rejects(U.open(key, sealed, "credA"));
});

test("open rejects a payload with an invalid repo", async () => {
  const key = await U.deriveKey(prf(7));
  const sealed = await U.seal(key, { token: TOKEN, repo: "../evil" }, "credA");
  await assert.rejects(U.open(key, sealed, "credA"));
});

test("b64u round-trips and rejects invalid input", () => {
  const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(Array.from(U.b64uDec(U.b64uEnc(bytes))), Array.from(bytes));
  assert.equal(U.newSalt().length, 43);
  assert.throws(() => U.b64uDec("a+b/"));
  assert.throws(() => U.b64uDec("a"));
});

test("parseRecord accepts a valid record", () => {
  const r = record();
  assert.deepEqual(plain(U.parseRecord(JSON.stringify(r))), r);
});

test("parseRecord accepts a record without a token", () => {
  const r = record(); delete r.iv; delete r.ciphertext;
  assert.deepEqual(plain(U.parseRecord(JSON.stringify(r))), r);
});

test("parseRecord rejects malformed records", () => {
  const noCt = record(); delete noCt.ciphertext;
  const cases = {
    null: null, "bad json": "{", array: "[]",
    "v 2": JSON.stringify(record({ v: 2 })),
    "salt 16": JSON.stringify(record({ salt: b64(16) })),
    "iv 16": JSON.stringify(record({ iv: b64(16) })),
    "iv without ciphertext": JSON.stringify(noCt),
    "bad repo": JSON.stringify(record({ repo: "../evil" })),
    "empty credentialId": JSON.stringify(record({ credentialId: "" })),
    "long ciphertext": JSON.stringify(record({ ciphertext: "A".repeat(5000) })),
    "created string": JSON.stringify(record({ created: "x" })),
  };
  for (const [name, raw] of Object.entries(cases)) assert.equal(U.parseRecord(raw), null, name);
});

test("open returns the repo from the payload, not the record's plain-text repo", async () => {
  const key = await U.deriveKey(prf(7));
  const sealed = await U.seal(key, { token: TOKEN, repo: REPO }, "credA");
  const rec = { ...sealed, repo: "Evil/Repo", credentialId: "credA", salt: U.newSalt(), v: 1 };
  assert.equal((await U.open(key, rec, "credA")).repo, REPO);
});

test("seal and open reject a credential id that isn't a non-empty string", async () => {
  const key = await U.deriveKey(prf(7));
  const sealed = await U.seal(key, { token: TOKEN, repo: REPO }, "credA");
  for (const bad of [undefined, "", new Uint8Array(16)]) {
    await assert.rejects(U.seal(key, { token: TOKEN, repo: REPO }, bad));
    await assert.rejects(U.open(key, sealed, bad));
  }
});

// --- WebAuthn wrappers: each test gets a fresh sandbox with fake browser globals ---
function loadWith(extra = {}) {
  const calls = {};
  const sandbox = { crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, Uint8Array, location: { hostname: "localhost" }, ...extra };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "unlock.js"), "utf8"), sandbox, { filename: "unlock.js" });
  return { W: sandbox.Unlock, calls };
}
function fakeNav(calls, { create, get }) {
  return { credentials: {
    create: async (arg) => { calls.create = arg; return create(); },
    get: async (arg) => { calls.get = arg; return get(); },
  } };
}
const cred = (prfResult) => ({ rawId: new Uint8Array(32).fill(5).buffer, getClientExtensionResults: () => ({ prf: prfResult }) });
const bytes = (x) => Array.from(new Uint8Array(x.buffer ?? x, x.byteOffset ?? 0, x.byteLength));

test("createPasskey asks for a user-verified passkey with PRF on this host", async () => {
  const calls = {};
  const { W } = loadWith({ navigator: fakeNav(calls, { create: () => cred({ enabled: true }) }) });
  assert.deepEqual(plain(await W.createPasskey("me")), { id: W.b64uEnc(new Uint8Array(32).fill(5)), prf: true });
  const pk = calls.create.publicKey;
  assert.equal(pk.rp.id, "localhost");
  assert.equal(pk.authenticatorSelection.userVerification, "required");
  assert.equal(pk.authenticatorSelection.residentKey, "preferred");
  assert.ok(pk.extensions.prf);
  assert.deepEqual(plain(pk.pubKeyCredParams.map((p) => p.alg)), [-7, -257]);
  assert.equal(pk.user.id.length, 16);
  assert.equal(pk.challenge.length, 32);
});

test("createPasskey returns the id with prf false when PRF isn't enabled, so the passkey can be forgotten", async () => {
  const id = (W) => W.b64uEnc(new Uint8Array(32).fill(5));
  for (const prfResult of [{ enabled: false }, undefined, {}]) {
    const { W } = loadWith({ navigator: fakeNav({}, { create: () => cred(prfResult) }) });
    assert.deepEqual(plain(await W.createPasskey("me")), { id: id(W), prf: false }, JSON.stringify(prfResult));
  }
});

test("createPasskey rejects when no credential comes back", async () => {
  const { W } = loadWith({ navigator: fakeNav({}, { create: () => null }) });
  await assert.rejects(W.createPasskey("me"));
});

test("prfSecret sends the stored salt and credential", async () => {
  const calls = {};
  const { W } = loadWith({ navigator: fakeNav(calls, { get: () => cred({ results: { first: prf(9) } }) }) });
  const id = b64(32), salt = W.newSalt();
  await W.prfSecret(id, salt);
  const pk = calls.get.publicKey;
  assert.deepEqual(bytes(pk.allowCredentials[0].id), bytes(W.b64uDec(id)));
  assert.deepEqual(bytes(pk.extensions.prf.eval.first), bytes(W.b64uDec(salt)));
  assert.equal(pk.userVerification, "required");
  assert.equal(pk.rpId, "localhost");
});

test("prfSecret returns the PRF bytes", async () => {
  const { W } = loadWith({ navigator: fakeNav({}, { get: () => cred({ results: { first: prf(9).buffer } }) }) });
  const out = await W.prfSecret(b64(32), W.newSalt());
  assert.deepEqual(bytes(out), bytes(prf(9)));
});

test("prfSecret passes a cancel through", async () => {
  const { W } = loadWith({ navigator: fakeNav({}, { get: () => { throw Object.assign(new Error("x"), { name: "NotAllowedError" }); } }) });
  await assert.rejects(W.prfSecret(b64(32), W.newSalt()), { name: "NotAllowedError" });
});

test("prfSecret rejects without PRF output", async () => {
  const { W } = loadWith({ navigator: fakeNav({}, { get: () => cred({}) }) });
  await assert.rejects(W.prfSecret(b64(32), W.newSalt()), { message: "no-prf" });
});

test("prfSecret fails fast on a missing credential id", async () => {
  const calls = {};
  const { W } = loadWith({ navigator: fakeNav(calls, { get: () => cred({ results: { first: prf(9) } }) }) });
  await assert.rejects(W.prfSecret("", W.newSalt()), { message: "Missing credential id" });
  assert.equal(calls.get, undefined);
});

const PKC = (o) => Object.assign(function PublicKeyCredential() {}, o);
test("supported is true with a platform authenticator", async () => {
  const { W } = loadWith({ PublicKeyCredential: PKC({ isUserVerifyingPlatformAuthenticatorAvailable: async () => true }) });
  assert.equal(await W.supported(), true);
});
test("supported is false without PublicKeyCredential", async () => {
  assert.equal(await loadWith().W.supported(), false);
});
test("supported is false when no platform authenticator is available", async () => {
  const { W } = loadWith({ PublicKeyCredential: PKC({ isUserVerifyingPlatformAuthenticatorAvailable: async () => false }) });
  assert.equal(await W.supported(), false);
});
test("supported is false when the browser reports no PRF", async () => {
  const { W } = loadWith({ PublicKeyCredential: PKC({ isUserVerifyingPlatformAuthenticatorAvailable: async () => true, getClientCapabilities: async () => ({ "extension:prf": false }) }) });
  assert.equal(await W.supported(), false);
});
test("supported is true when capabilities don't mention PRF", async () => {
  const { W } = loadWith({ PublicKeyCredential: PKC({ isUserVerifyingPlatformAuthenticatorAvailable: async () => true, getClientCapabilities: async () => ({}) }) });
  assert.equal(await W.supported(), true);
});
test("supported never rejects", async () => {
  const { W } = loadWith({ PublicKeyCredential: PKC({ isUserVerifyingPlatformAuthenticatorAvailable: async () => { throw new Error("boom"); } }) });
  assert.equal(await W.supported(), false);
});

test("forgetPasskey signals the unknown credential", async () => {
  const seen = [];
  const { W } = loadWith({ PublicKeyCredential: PKC({ signalUnknownCredential: async (a) => { seen.push(plain(a)); } }) });
  await W.forgetPasskey("abc");
  assert.deepEqual(seen, [{ rpId: "localhost", credentialId: "abc" }]);
});
test("forgetPasskey resolves when the signal API is missing", async () => {
  await loadWith({ PublicKeyCredential: PKC({}) }).W.forgetPasskey("abc");
  await loadWith().W.forgetPasskey("abc");
});
test("forgetPasskey resolves when the signal throws or rejects", async () => {
  await loadWith({ PublicKeyCredential: PKC({ signalUnknownCredential: () => { throw new Error("x"); } }) }).W.forgetPasskey("abc");
  await loadWith({ PublicKeyCredential: PKC({ signalUnknownCredential: async () => { throw new Error("x"); } }) }).W.forgetPasskey("abc");
});
