# Editor Passkey Unlock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the editor be unlocked with one Touch ID touch instead of re-pasting the GitHub token. The token is
stored only encrypted (WebAuthn PRF + AES-GCM), and the plain-text "remember" option is removed.

**Architecture:** A new root file `unlock.js` (browser global `window.Unlock`, loadable in Node through `vm`
like `build.mjs` loads the app modules) holds the crypto, the stored-record validation and thin WebAuthn
wrappers. `admin.js` uses it for enable / unlock / lock / forget. Infrastructure (subdomain, headers, redirect)
is not part of this plan; it is in `docs/superpowers/specs/2026-11-01-walks-subdomain-infra-handoff.md`.

**Tech Stack:** Vanilla browser JS (no build step, no dependencies), Web Crypto, WebAuthn PRF extension, Node ≥ 20
built-in test runner (`node --test`).

**Spec:** `docs/superpowers/specs/2026-11-01-editor-passkey-unlock-design.md`

## Global Constraints

- No new dependencies, no `package.json`, no build step. All site files in the repository root (the owner uploads
  from a phone).
- No inline scripts or styles. Render everything with `textContent` / DOM nodes, never HTML strings. The CSP in
  `admin.html` stays unchanged.
- The token is only ever sent to `https://api.github.com`. It is never written to `localStorage` in plain text,
  and never to `sessionStorage` while passkey unlock is on.
- Storage key `cw:unlock`. Record: `{ v: 1, credentialId, salt, iv?, ciphertext?, repo, created }`, base64url
  strings, `created` = ms since epoch.
- Key derivation: HKDF-SHA-256 over the PRF output, empty HKDF salt, `info = "city-walks editor token v1"`,
  giving a non-extractable AES-GCM 256-bit key.
- AES-GCM: fresh random 12-byte IV per encryption, additional data `"cw-unlock-v1|" + credentialId`. Plaintext is
  JSON `{ token, repo }`.
- PRF salt: 32 random bytes per record. WebAuthn user handle: 16 random bytes. `rp.id = location.hostname`.
  `pubKeyCredParams` ES256 (-7) and RS256 (-257). `userVerification: "required"`, `residentKey: "preferred"`.
- Idle lock after 60 minutes without `pointerdown` / `keydown` (unchanged value).
- Default repository: `<meta name="cw-repo" content="PieterWittebol/City-Walks">` in `admin.html`. The field
  stays editable.
- Tokens: `/^github_pat_[A-Za-z0-9_]{20,255}$/`. Repos: `/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/`.
  Both move from `admin.js` to `Unlock.TOKEN_RE` / `Unlock.REPO_RE`.
- Commits end with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push; the owner pushes.

## Review Focus

1. **A corrupted, truncated or hand-edited `cw:unlock` record** must not break the start screen. It should be
   treated as absent, and the token form shown. → Task 2, `parseRecord` tests.

2. **A cancelled Touch ID prompt** (`NotAllowedError`) must leave the record untouched and the unlock button
   available, with "Unlock cancelled". The error must not be swallowed inside `Unlock`. → Task 3 test; Task 4
   checklist.

3. **The passkey deleted in the Passwords app while the record remains:** the browser reports that the same way
   as a cancel. The start screen must keep "Use a token instead" and "Forget this device" visible, so the user is
   never stuck. → Task 4 checklist.

4. **A tampered plain-text `repo` in the record** must never redirect the token to another repository. The repo
   used for signing in comes from the decrypted payload. → Task 2 test.

5. **A leftover plain-text `cw:auth` in `localStorage`** from the old "remember" option must be deleted on first
   load, even in browsers without PRF support. → Task 4 checklist.

---

### Task 1: Commit the build fix (rollout step 1)

Already implemented and uncommitted: `build.mjs` (time budget, abort-aware back-off, per-host limits, negative
cache, cache kept between runs, timings), `build.test.mjs`, `.github/workflows/build.yml`, `.gitignore`.

**Files:**

- Modify (already done): `build.mjs`, `.github/workflows/build.yml`
- Create (already done): `build.test.mjs`, `.gitignore`

- [ ] **Step 1: Create the branch**

Run: `git switch -c fix/build-time-budget`

- [ ] **Step 2: Run the tests**

Run: `node --test`
Expected: `ℹ pass 9`, `ℹ fail 0`

**Addition (from the baseline measurement, 2026-11-01):** in a full local build, Overpass took ~49 of 62 minutes:
123 requests, 82 timeouts at 35 s, 25 × 5xx, 16 answers. `overpass.private.coffee` timed out 34/34 and
`overpass.kumi.systems` 8/8. `sources.js` tries the 4 endpoints in order for every query, and the same failing
query is repeated once per language. Both fixes go in `politeFetch` in `build.mjs`, with new options
`politeFetch(baseFetch, { …existing, downMs = 10 * 60e3, failMemoryMs = 5 * 60e3 })`:

- **Host breaker:** a request counts as failed when `baseFetch` throws (including `AbortError`, which is how
  `fetchJSON`'s 35 s timeout appears) or still answers 429/5xx after the retries. After **2 failed requests in a
  row** to a host, that host is "down" for `downMs`. Requests to it then reject at once with
  `Error("host down: <host>")`, without calling `baseFetch`. Any successful answer from the host resets its count.
- **Failure memory:** when a request fails as above, the same request key rejects at once with the same message
  for `failMemoryMs`, without calling `baseFetch`.
- Add `down` (list of hosts marked down) to `stats`, and a "Skipped as down: …" line to the build summary.

- [ ] **Step 2a: Write the failing tests** in `build.test.mjs`:
  - `a host that times out twice in a row is skipped`: `baseFetch` throws `AbortError` for
    `https://overpass.private.coffee/api/interpreter`. After two calls with different bodies (both rejecting), a
    third call with a new body rejects with `/host down/`, and `baseFetch` was called exactly 2 times.
  - `a success resets the count`: fail, succeed, fail → a fourth call still reaches `baseFetch` (4 calls total).
  - `a down host comes back after downMs`: `downMs: 50`; after 2 failures, wait 60 ms, then the next call reaches
    `baseFetch`.
  - `a failed request isn't repeated for the next language`: one failure for key K on a host, then the same K
    again → rejects without calling `baseFetch` (1 call total), while a different key on that host still goes
    through.
  - `other hosts are unaffected`: overpass-api.de down; an `en.wikipedia.org` request still reaches `baseFetch`.

- [ ] **Step 2b: Run them to check they fail.** Run: `node --test` → the 5 new tests fail.

- [ ] **Step 2c: Implement both in `politeFetch`.** Run: `node --test` → all 14 pass.

- [ ] **Step 2d: Measure.** Run the full build once locally with a per-host timing harness (local, not in the repo),
  on a `git archive` copy, with `BUILD_BUDGET_MIN=60` so the budget doesn't hide the effect. Report total time
  and Overpass time against the baseline (62 min / ~49 min Overpass).

- [ ] **Step 3: Commit (code and docs separately)**

```bash
git add build.mjs build.test.mjs .github/workflows/build.yml .gitignore
git commit -m "Build: time budget, open data cache between runs, per-host limits"
git add docs/
git commit -m "Docs: design, infra handoff and plan for editor passkey unlock"
```

The owner merges and pushes this before Task 2's work is released.

---

### Task 2: `unlock.js`: record validation and token encryption

**Files:**

- Create: `unlock.js`
- Test: `unlock.test.mjs`

**Interfaces:**

- Produces (on `window.Unlock`):
  - `KEY = "cw:unlock"`, `TOKEN_RE`, `REPO_RE`
  - `b64uEnc(bytes: Uint8Array): string`, `b64uDec(s: string): Uint8Array` (throws on invalid input)
  - `newSalt(): string`: 32 random bytes, base64url
  - `deriveKey(prf: Uint8Array): Promise<CryptoKey>`
  - `seal(key, payload: { token, repo }, credentialId: string): Promise<{ iv: string, ciphertext: string }>`
  - `open(key, sealed: { iv, ciphertext }, credentialId: string): Promise<{ token, repo }>`: rejects when
    decryption fails or the payload fails `TOKEN_RE` / `REPO_RE`
  - `parseRecord(raw: string | null): UnlockRecord | null`

- [ ] **Step 1: Write the failing tests** in `unlock.test.mjs`. Load `unlock.js` with
  `vm.runInContext` into a sandbox `{ crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, window }`
  (`window` = the sandbox). Use the fixed PRF bytes `new Uint8Array(32).fill(7)` and the token
  `"github_pat_" + "A".repeat(40)`.
  - `seal then open returns the token and repo`: deep-equals `{ token, repo: "PieterWittebol/City-Walks" }`.
  - `open fails with another credential id`: `seal(..., "credA")`, then `open(..., "credB")` rejects.
  - `open fails with a different PRF output`: a key from `fill(8)` rejects.
  - `open fails when the ciphertext is changed`: flip one character of `ciphertext`; rejects.
  - `two seals of the same token differ`: the `iv` values differ.
  - `open rejects a payload that isn't a fine-grained token`: seal `{ token: "ghp_x", repo }`, `open` rejects.
  - `parseRecord accepts a valid record`: a record with 32-byte salt and 12-byte IV returns an object with the
    same fields.
  - `parseRecord accepts a record without a token` (no `iv`/`ciphertext`): returns it.
  - `parseRecord rejects`, table-driven, each → `null`: `null`, `"{"`, `"[]"`, `v: 2`, salt of 16 bytes, IV of
    16 bytes, `iv` without `ciphertext`, `repo: "../evil"`, `credentialId: ""`, a `ciphertext` of 5000 characters,
    `created: "x"`.

- [ ] **Step 2: Run the tests to check they fail**

Run: `node --test unlock.test.mjs`
Expected: FAIL (`unlock.js` not found)

- [ ] **Step 3: Implement `unlock.js`** using the existing IIFE + `"use strict"` + `window.X = {…}` pattern from
  `util.js`. HKDF: `crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"])`, then `deriveKey` with
  `{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info }` and `{ name: "AES-GCM", length: 256 }`,
  non-extractable. Limits in `parseRecord`: `credentialId` decodes to 16–1023 bytes, `ciphertext` ≤ 2048 characters.

- [ ] **Step 4: Run the tests to check they pass**

Run: `node --test`
Expected: all `build.test.mjs` and `unlock.test.mjs` tests pass.

- [ ] **Step 5: Commit**

`git add unlock.js unlock.test.mjs && git commit -m "Editor: encrypted token storage helpers"`

---

### Task 3: `unlock.js`: WebAuthn wrappers

**Files:**

- Modify: `unlock.js`
- Test: `unlock.test.mjs`

**Interfaces:**

- Consumes: `b64uEnc`, `b64uDec`, `newSalt` (Task 2)
- Produces (on `window.Unlock`):
  - `supported(): Promise<boolean>`: `true` only if `PublicKeyCredential` exists and
    `isUserVerifyingPlatformAuthenticatorAvailable()` resolves to true. If `getClientCapabilities()` exists and
    reports `extension:prf === false`, return false.
  - `createPasskey(userName: string): Promise<string | null>`: the credential ID (base64url), or `null` when the
    result's `getClientExtensionResults().prf?.enabled` isn't `true`
  - `prfSecret(credentialId: string, salt: string): Promise<Uint8Array>`: rejects with the browser's own error
    (e.g. `NotAllowedError`) unchanged; rejects with `Error("no-prf")` when there is no `prf.results.first`
  - `forgetPasskey(credentialId: string): Promise<void>`: calls `PublicKeyCredential.signalUnknownCredential(
    { rpId: location.hostname, credentialId })` when it exists; otherwise does nothing; never rejects

- [ ] **Step 1: Write the failing tests.** Give the sandbox a fake
  `navigator.credentials.create/get` that records its argument and returns
  `{ rawId: Uint8Array, getClientExtensionResults: () => ({ prf: … }) }`, plus `location: { hostname: "localhost" }`.
  - `createPasskey asks for a user-verified passkey with PRF on this host`: the recorded `publicKey.rp.id` is
    `"localhost"`, `authenticatorSelection.userVerification` is `"required"`, `extensions.prf` exists,
    `pubKeyCredParams` algorithms are `[-7, -257]`, and `user.id` is 16 bytes.
  - `createPasskey returns null when PRF isn't enabled`: fake returns `prf: { enabled: false }` → `null`.
  - `prfSecret sends the stored salt and credential`: the recorded `allowCredentials[0].id` bytes equal
    `b64uDec(credentialId)`, `extensions.prf.eval.first` equals `b64uDec(salt)`, `userVerification` is `"required"`.
  - `prfSecret returns the PRF bytes`: fake returns `results.first = new Uint8Array(32).fill(9)` → equal bytes.
  - `prfSecret passes a cancel through`: fake rejects with `name: "NotAllowedError"` → rejects with that name.
  - `prfSecret rejects without PRF output`: fake returns `prf: {}` → rejects with message `"no-prf"`.

- [ ] **Step 2: Run the tests to check they fail**

Run: `node --test unlock.test.mjs`
Expected: FAIL (`createPasskey is not a function`)

- [ ] **Step 3: Implement the four functions in `unlock.js`.** Use `challenge = crypto.getRandomValues(32 bytes)`.
  There is no server, so the challenge is not checked; security rests on PRF + user verification. Add a comment
  saying so.

- [ ] **Step 4: Run the tests to check they pass**

Run: `node --test`
Expected: all pass

- [ ] **Step 5: Commit**

`git add unlock.js unlock.test.mjs && git commit -m "Editor: passkey (WebAuthn PRF) helpers"`

---

### Task 4: Editor: enable, unlock, lock, forget; remove plain-text remember

**Files:**

- Modify: `admin.html` (head meta, login section lines 26–50, header button line 21, `#vHome` line 51, scripts lines 144–148)
- Modify: `admin.js` (auth section lines 46–70, sign-in lines 112–153, start lines 556–565; replace `TOKEN_RE` / `REPO_RE` with `Unlock.*`)
- Modify: `admin.css` (only if new elements need it)
- Modify: `README.md` (Editor, Security and Files sections)

**Interfaces:**

- Consumes: all of `window.Unlock` (Tasks 2–3)

Behaviour to implement (from spec section C):

- `admin.html`: add `<meta name="cw-repo" content="PieterWittebol/City-Walks">`. Remove the `#inRemember`
  checkbox and `#rememberWarn`. Add an `#unlockBox` (hidden by default) to `#vLogin` with `#btnUnlock`
  ("Unlock with Touch ID"), `#btnUseToken` ("Use a token instead") and `#btnForget` ("Forget this device"). Add a
  `#btnForgetHome` next to `#tokenInfo`. Load `unlock.js` after `schema.js` and before `admin.js`.
- Repository field default: the meta tag; otherwise `guessRepo()`.
- On start: if `localStorage` has `cw:auth`, delete it and show "A token saved by an older version of the editor
  was removed from this browser." Then: record with ciphertext → show `#unlockBox` (token form collapsed).
  Record without ciphertext → token form with "Your token expired or was replaced. Paste a new one; Touch ID
  unlock stays set up." No record → token form; the plain-text session restore via `sessionStorage` stays only
  for passkey-off sessions.
- After a successful token sign-in:
  - A record exists → re-encrypt with its passkey (one touch). On cancel, keep the session in memory only.
  - No record and `supported()` → `dialog("Unlock with Touch ID next time?", …)` with "Not now" / "Set up".
    On "Set up": `createPasskey("City Walks editor · " + repo)`. `null` → toast "This browser can't protect the
    token with a passkey; you'll need to paste it again next time." Otherwise `prfSecret` → `deriveKey` → `seal`
    → store the record.
  - When passkey unlock is on, the token goes in memory only and is never written to `sessionStorage`.
- Unlock: `prfSecret` → `deriveKey` → `open` → `connect({ token, repo })`, using the repo from the decrypted
  payload. `NotAllowedError` → "Unlock cancelled." (record untouched). A decryption failure or a 401 from
  `connect` → remove only `iv` and `ciphertext`, then show the token form with the expired message.
- Lock: the header button says "Lock" when passkey unlock is on, otherwise "Sign out". It keeps the
  unsaved-changes confirmation, wipes `auth`, and reloads the page (as `signOut` does today). The idle timer
  locks after 60 minutes in both modes (remove the `!remember` condition).
- Forget (`#btnForget`, `#btnForgetHome`): confirm, delete `cw:unlock`, call `forgetPasskey`, then show a dialog
  explaining how to remove the passkey: "Passwords app (or System Settings → Passwords) → search
  walks.wittebol.be → delete". Then show the token form.
- `README.md`: the Editor section describes token + Touch ID unlock. Security bullets: remove the
  "Remember on this device" text, add "stored only encrypted; unlocking needs your passkey". Files table: add
  `unlock.js`, `build.test.mjs`, `unlock.test.mjs`.

- [ ] **Step 1: Write the manual checklist** as a `## Manual checks (editor)` section at the end of `README.md`
  (Troubleshooting area), covering: enable, reload, unlock, cancel Touch ID, idle lock (for a quick check, change
  the 60-minute limit to 1 minute in a local copy only; never commit that), token expired (revoke the token on GitHub, then unlock → expired message, passkey kept, paste a new
  token → one touch), forget, an old `cw:auth` present before load (`localStorage.setItem("cw:auth","{}")`),
  a browser without PRF (token form only, no remember option).

- [ ] **Step 2: Implement the `admin.html` and `admin.js` changes listed above**

- [ ] **Step 3: Check that nothing else broke**

Run: `node --test`
Expected: all pass. Run: `grep -n "inRemember\|rememberWarn\|localStorage.setItem(TK" admin.js admin.html`
Expected: no output.

- [ ] **Step 4: Browser check with a virtual authenticator.** Serve the repository with
  `python3 -m http.server 8765` from its root. In Chrome through the Playwright MCP tools, add a CDP virtual
  authenticator (`WebAuthn.enable`, then `WebAuthn.addVirtualAuthenticator` with `protocol: "ctap2"`,
  `transport: "internal"`, `hasResidentKey: true`, `hasUserVerification: true`, `isUserVerified: true`,
  `hasPrf: true`). Walk through the checklist items that don't need a real GitHub token, using a fake
  `api.github.com` answer via Playwright route interception (`GET /repos/PieterWittebol/City-Walks` →
  `{ default_branch: "main", permissions: { push: true } }`, `GET …/contents/cities.json` → the repository's
  `cities.json`, base64). Expected: enable → reload → unlock lands in the city list; `localStorage["cw:unlock"]`
  contains no `github_pat_`; `sessionStorage` contains no `github_pat_`.

- [ ] **Step 5: Commit**

`git add admin.html admin.js admin.css README.md && git commit -m "Editor: unlock with Touch ID (passkey); token stored only encrypted"`

- [ ] **Step 6: Owner check.** The owner runs the README checklist in Safari and Firefox on macOS with a real
  token, then creates a new token and revokes the old one (spec, rollout step 3).

---

### Task 5: Point the build at the new address (after infra steps 1–5 are done)

**Files:**

- Modify: `.github/workflows/build.yml` ("Build walk data" env)
- Modify: `README.md` (live address and the Editor URL)

- [ ] **Step 1: Check the new address serves the site**

Run: `curl -sI https://walks.wittebol.be/built/index.json | head -1`
Expected: `HTTP/2 200`

- [ ] **Step 2: Add `SITE_URL: https://walks.wittebol.be/`** to the "Build walk data" step's `env`.
  Change the README's live address to `https://walks.wittebol.be/` and the editor address to
  `https://walks.wittebol.be/admin.html`.

- [ ] **Step 3: Check the workflow is still valid YAML and the tests pass**

Run: `ruby -ryaml -e 'YAML.load_file(".github/workflows/build.yml"); puts "ok"' && node --test`
Expected: `ok`, all tests pass

- [ ] **Step 4: Commit**

`git add .github/workflows/build.yml README.md && git commit -m "Site moves to walks.wittebol.be"`
