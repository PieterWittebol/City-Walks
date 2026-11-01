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
