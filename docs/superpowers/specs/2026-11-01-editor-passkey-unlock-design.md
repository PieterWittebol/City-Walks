# Editor: own address + unlock with Touch ID (passkey)

Date: 2026-11-01 · Status: draft for review

Cloudflare and GitHub settings (sections A and B) are applied by the owner from their Ansible project, following
`2026-11-01-walks-subdomain-infra-handoff.md`. This repository only contains the code and workflow changes.

## Why

The editor (`admin.html`) signs in with a GitHub fine-grained personal access token. Creating and renewing
the token is fine. The annoying part is that **after 60 minutes without activity the editor signs you out and you
have to find and paste the token again**. Editing happens mostly on a Mac laptop, in Safari and Firefox.

The fix must not make the editor less safe than it is today. Ideally it ends up safer.

## What exists today

- Static site on GitHub Pages, deployed by `.github/workflows/build.yml`. No server.
- Served at `https://wittebol.be/City-Walks/`. `wittebol.be` is the owner's other website (the GitHub user site with a
  custom domain). DNS for `wittebol.be` is on Cloudflare and the site is proxied through Cloudflare (HTTP→HTTPS
  redirect and HSTS with `includeSubDomains; preload` are already in place).
- Because both sites live on the origin `https://wittebol.be`, **they share browser storage and WebAuthn scope**.
- The token is kept in memory + `sessionStorage` (tab only), or in `localStorage` in plain text when the user ticks
  "Remember on this device". After 60 minutes idle (when not remembered) the editor signs out.
- Existing protections to keep: only `github_pat_…` tokens accepted; the token only goes to `api.github.com`
  (CSP `connect-src`); only `cities.json` / `walk-*.json` can be read or written; everything validated with
  `schema.js`; content rendered as text only; JavaScript frame-busting; `sha`-based conflict detection.
- `guessRepo()` only recognises `*.github.io` hostnames, so on `wittebol.be` the repository field starts empty.

## Goals

1. Getting back into the editor after it has locked is **one Touch ID touch** (or the device's equivalent).
2. The token is **never stored in plain text** in the browser.
3. City Walks no longer shares an origin with the other website.
4. Security headers that a `<meta>` tag can't provide (frame blocking) are sent as real HTTP headers.

## Non-goals

- Replacing the GitHub token with "Sign in with GitHub" (OAuth). That would need a server-side component, and
  the token itself isn't the pain point.
- Accounts, user management, or multiple editors.
- Changing the walker app's behaviour, apart from it moving to a new address.

## Anti-goals (would count as failure even if it "works")

- A plain-text token anywhere in persistent browser storage.
- Any new server, third-party script or external dependency for signing in.
- The editor becoming unusable in a browser without passkey support (it must fall back to pasting the token).
- Weakening any existing protection listed above.

## Decisions

### A. Own address: `walks.wittebol.be` (decided by the owner; name is my call)

- Cloudflare DNS: `walks` CNAME → `pieterwittebol.github.io`, proxied (orange cloud), like the main site.
- GitHub repository → Settings → Pages → Custom domain: `walks.wittebol.be`; enable "Enforce HTTPS" once GitHub
  has issued the certificate.
- The app, editor and built data then live at `https://walks.wittebol.be/`. All app paths are already relative
  (`manifest.webmanifest` uses `./`, the service worker registers `sw.js`), so no path changes are needed.
- `build.mjs`: set `SITE_URL: https://walks.wittebol.be/` in the workflow so the build fetches the previous
  `built/index.json` from the new address directly (today it derives a `github.io` URL and relies on redirects).
- Old address: `https://wittebol.be/City-Walks/*` must keep working for people with the old link or home-screen
  icon, by redirecting (301) to the same path on `walks.wittebol.be`. If GitHub doesn't do this by itself once the
  project has its own domain, add a Cloudflare redirect rule on `wittebol.be`.
- Accepted consequences: walkers' progress and settings are stored per origin, so they start fresh at the new
  address; people who added the app to their home screen need to add it again.

### B. Security headers on `walks.wittebol.be` (my call)

GitHub Pages can't set response headers, but Cloudflare can (Rules → Transform Rules → Modify response header,
matching hostname `walks.wittebol.be`):

- `Content-Security-Policy: frame-ancestors 'none'` (header form; the full policies stay in the pages' `<meta>`
  tags so the two pages keep their different policies). Keep the JavaScript frame-busting as a second layer.
- `X-Frame-Options: DENY` (older browsers).
- `Referrer-Policy: strict-origin-when-cross-origin`.
- `Permissions-Policy: camera=(), microphone=(), payment=(), usb=(), geolocation=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)`.
- `Cross-Origin-Opener-Policy: same-origin`.
- `X-Content-Type-Options: nosniff` (already sent by GitHub; harmless to repeat).
- Cloudflare SSL/TLS mode **Full (strict)** for `walks.wittebol.be`, preferably via a per-hostname rule so the
  rest of the zone isn't affected.
- Verify `wittebol.be` with GitHub Pages (TXT record) to prevent subdomain takeover; it isn't verified today.

### C. Passkey unlock (decided by the owner; mechanism is my call)

The token stays the credential towards GitHub. A passkey is used only to encrypt it locally, using the WebAuthn
**PRF extension**. PRF gives a secret that only exists after a successful Touch ID check.

**Turning it on (first sign-in in a browser):**
1. The user pastes the token as today; the editor verifies it with GitHub (existing `connect()`).
2. If the browser supports WebAuthn with PRF, the editor offers "Unlock with Touch ID next time".
3. On yes: `navigator.credentials.create()` with `rp.id = "walks.wittebol.be"`, a random 16-byte user handle,
   `authenticatorSelection: { residentKey: "preferred", userVerification: "required" }`, algorithms ES256 and
   RS256, and `extensions: { prf: {} }`. If the result doesn't report `prf.enabled`, say so and fall back.
4. Immediately call `navigator.credentials.get()` for that credential with `userVerification: "required"` and
   `extensions: { prf: { eval: { first: salt } } }` (salt: 32 random bytes). Some platforms don't return PRF
   output from `create()`, so the second step is always used. This means two Touch ID touches when turning it on.
5. Derive the encryption key: HKDF-SHA-256 over the PRF output, `info = "city-walks editor token v1"`, giving a
   non-extractable AES-GCM-256 `CryptoKey` (Web Crypto only; no own crypto).
6. Encrypt `{ token, repo }` with a fresh random 12-byte IV, with additional authenticated data =
   `"cw-unlock-v1|" + credentialId`.
7. Store in `localStorage` under `cw:unlock`: `{ v: 1, credentialId, salt, iv, ciphertext, repo, created }`
   (base64url). Nothing else about the token is stored.

**Unlocking:** the start screen shows "Unlock with Touch ID" when `cw:unlock` exists. Tap → `get()` with
`allowCredentials: [credentialId]`, the stored salt and `userVerification: "required"` → derive key → decrypt →
existing `connect()`. If the user cancels, nothing changes. If decryption fails or GitHub answers 401 (token
expired or revoked), delete only the encrypted token (`iv`, `ciphertext`) and keep `credentialId` and `salt`, then
show the token form with a clear message. When a new token is pasted, it is encrypted with the same passkey (one
Touch ID touch, no new passkey), so unused passkeys don't pile up with every token renewal (my call, after review).

**While unlocked:** the token lives in memory only. When passkey unlock is on, it is not written to
`sessionStorage`. A page reload therefore asks for one Touch ID touch (my call: one touch is cheap, and it removes
the last readable copy of the token).

**Locking:**
- After 60 minutes without activity (unchanged), or via "Lock": wipe the token from memory and return to the
  start screen with "Unlock with Touch ID". Unsaved changes: same warning as today before locking by hand; on the
  idle timeout, keep today's behaviour.
- "Forget this device" (on the start screen and in the signed-in view): delete `cw:unlock`, then explain how to
  remove the passkey itself (Passwords app / browser settings). Where supported, also call
  `PublicKeyCredential.signalUnknownCredential()` so the passkey manager can hide it.

**Without PRF support** (older browser, or Firefox if its macOS PRF support turns out to be missing): the editor
works as today, with the token kept for the tab only. The plain-text "Remember on this device" option is
**removed** (my call: it's the one way today to store the token unencrypted, and passkey unlock replaces it).
On first load after the update, any existing plain-text `cw:auth` in `localStorage` is deleted, with a one-line
note.

**Repository name:** default to `PieterWittebol/City-Walks`, read from a `<meta name="cw-repo">` tag in
`admin.html` (my call). The field stays editable. This fixes the empty field on custom domains.

**CSP:** `admin.html`'s policy needs no change for WebAuthn or Web Crypto.

### D. Threats considered (OWASP)

| Threat | Mitigation |
|---|---|
| Another site on the same origin reads the token (A01/A07) | Own origin (A); no plain-text storage (C) |
| Script injection (XSS) in the editor reads or misuses the token (A03) | Existing: CSP `script-src 'self'`, text-only rendering, no inline scripts. Residual risk: while unlocked, injected script could use the token. Unchanged from today |
| Stolen laptop / copied browser profile | Ciphertext is useless without the passkey + Touch ID (`userVerification: "required"`) |
| Clickjacking the editor (A05) | `frame-ancestors 'none'` + `X-Frame-Options` headers (B), JS frame-busting kept |
| Long-lived access (ASVS V3 idle/absolute timeouts) | 60-min idle lock unchanged; token expiry (30–90 days) is the absolute limit, after which `cw:unlock` is deleted |
| Phishing for the passkey | Passkeys are bound to `walks.wittebol.be` by the browser and can't be used by other sites |
| Downgrade to HTTP | HSTS preload already on `wittebol.be` with `includeSubDomains`; GitHub "Enforce HTTPS" on |

## Testing

- No new dependencies: the project has no `package.json`, and a browser-automation dependency (Playwright) would
  be its first. The automated browser test is not added to the repo or CI (my call, after review).
- Unit-test the pure parts (key derivation, encrypt/decrypt round trip, AAD mismatch rejected, record parsing,
  stored-record validation) in Node with Web Crypto (`node --test`, same as `build.test.mjs`). These parts live in
  a separate small file so Node can load them.
- WebAuthn itself can't run in Node. Test it by hand in Safari and Firefox on macOS with a written checklist:
  enable → reload → unlock → idle lock → unlock → token expired (keeps passkey) → forget. The builder may use
  Chrome's virtual authenticator from a throwaway script outside the repo while developing.
- Check the headers with `curl -I https://walks.wittebol.be/admin.html`.

## Rollout order

1. Commit the build fixes (time budget, cache) first; this work builds on them.
2. Release the editor changes while still on the old address, so the cleanup of any plain-text `cw:auth` runs on
   `https://wittebol.be` (where a remembered token would be). The owner opens the editor at the old address in
   every browser and on every device where it was used (Safari, Firefox, and the phone). There, choose **Not now**
   when Touch ID is offered (don't set it up), or tap **Forget this device** before the redirect; set up Touch ID
   only at `walks.wittebol.be` (a passkey and record made at the old address would be left behind).
3. The owner creates a new fine-grained token (decided) and revokes the old one on GitHub, so no copy that might
   have been stored in plain text stays valid. This is the backstop for any browser or device step 2 missed.
4. Then move to `walks.wittebol.be` and add the headers and redirect (infra handoff, steps 1–6). After that, set
   `SITE_URL` in the workflow.

## Left to the builder

- Exact UI wording and layout of the start screen and the lock button.
- Code structure inside `admin.js` (with the crypto helpers in a separate file loaded before it, root folder,
  matching the existing `util.js` / `schema.js` pattern).
- Whether to feature-detect PRF up front via `PublicKeyCredential.getClientCapabilities()` where available, or only
  via the `create()` result.
- README updates (Editor + Security sections) and the in-page explanation.
