# Handoff: infrastructure for `walks.wittebol.be` (for a Claude session in the owner's Ansible project)

You are working in the owner's Ansible project, which manages their Cloudflare zone and GitHub settings. This file
was written by a Claude session working in the City Walks repository (`PieterWittebol/City-Walks`). Background and
reasons are in `2026-11-01-editor-passkey-unlock-design.md` next to this file. You don't need it to do the work,
but read sections A and B if anything here is unclear.

## Goal

Move the City Walks site from `https://wittebol.be/City-Walks/` to its own origin, `https://walks.wittebol.be/`.
Serve it through Cloudflare with strict TLS and security headers, and redirect the old address. The owner's main
site at `https://wittebol.be` (GitHub user site `PieterWittebol/pieterwittebol.github.io`, custom domain
`wittebol.be`) must keep working unchanged.

## Facts checked on 2026-11-01

- `wittebol.be` DNS is on Cloudflare (`nile.ns.cloudflare.com`, `dee.ns.cloudflare.com`). The apex is proxied.
  Cloudflare already redirects HTTP→HTTPS and sends `Strict-Transport-Security: max-age=15552000; includeSubDomains; preload`.
- GitHub Pages for `PieterWittebol/City-Walks`: `build_type: workflow`, no custom domain, `https_enforced: false`.
- GitHub Pages for `PieterWittebol/pieterwittebol.github.io`: `cname: wittebol.be`, `https_enforced: false`.
- There is **no** `_github-pages-challenge-pieterwittebol.wittebol.be` TXT record, so the domain isn't verified with
  GitHub (a subdomain-takeover risk).
- No CAA records on `wittebol.be`.
- The current Cloudflare SSL/TLS mode for the zone was **not** checked. Read it before changing anything.

## Hard constraints

- **Gate:** don't create the redirect (step 6) until the owner confirms that the City Walks editor update has been
  deployed **and** opened once in Safari and once in Firefox at the old address. That update deletes a plain-text
  token from browser storage on `wittebol.be`; once the redirect is live, that cleanup can never run. Steps 1–5 can
  be done before then.
- **Never replace a whole Cloudflare ruleset.** Each phase entrypoint (`PUT /zones/{zone}/rulesets/phases/{phase}/entrypoint`)
  holds *all* rules of that phase, including ones the owner already has. Read the entrypoint, then add or update
  only the rules described here, identified by a stable `ref` (e.g. `cw-headers`, `cw-redirect`, `cw-ssl`), so
  re-runs stay idempotent and never remove other rules.
- **Don't switch the whole zone's SSL mode** unless you've confirmed every proxied hostname in the zone has a
  valid origin certificate. Prefer a per-hostname Configuration Rule (step 4).
- Store API tokens with Ansible Vault (or however the project already handles secrets); never in plain text.
  Least-privilege Cloudflare token for this zone only: Zone → DNS: Edit, Zone → Config Rules: Edit,
  Zone → Transform Rules: Edit, Zone → Single Redirect / Dynamic Redirect: Edit, Zone → Zone Settings: Read.
  GitHub: a fine-grained token for `PieterWittebol/City-Walks` with Administration (Pages) access is enough for
  step 3. Verifying the domain (step 1) is an account-level setting, done by the owner in the GitHub web UI.
- Use `ansible.builtin.uri` (or the project's existing Cloudflare modules) and make every task idempotent,
  with `--check`/`--diff` support where the project already does this.

## Steps

### 1. Verify `wittebol.be` with GitHub (owner + DNS)
The owner opens GitHub → Settings → Pages → "Add a domain" → `wittebol.be`. GitHub shows a TXT record. Create it in
Cloudflare: name `_github-pages-challenge-pieterwittebol`, value as shown, DNS only. The owner then clicks Verify.
This stops other GitHub accounts from claiming `*.wittebol.be`.

### 2. DNS record
`walks.wittebol.be` CNAME → `pieterwittebol.github.io`. Start with **DNS only (grey cloud)**: GitHub requests its
Let's Encrypt certificate through an HTTP check, which can fail behind the Cloudflare proxy. Switch to proxied in step 5.

### 3. GitHub Pages custom domain
`PUT https://api.github.com/repos/PieterWittebol/City-Walks/pages` with `{"cname": "walks.wittebol.be"}`.
Poll `GET .../pages` (and `GET .../pages/health` if useful) until the certificate is issued. This can take up to
about an hour. Then `PUT .../pages` with `{"https_enforced": true}`.
Check: `curl -sI https://walks.wittebol.be/` returns 200 with a valid certificate (it comes straight from GitHub at
this point).

### 4. TLS mode for this hostname
Read the zone's current SSL/TLS mode and report it to the owner. Add a Configuration Rule (phase
`http_config_settings`, ref `cw-ssl`): expression `(http.host eq "walks.wittebol.be")`, action `set_config`,
`ssl: "strict"` (Full (strict)). Also enable "Always Use HTTPS" for this host if the zone doesn't already.

### 5. Proxy on + security headers
Switch the `walks` record to **proxied**. Then add a Response Header Transform Rule (phase
`http_response_headers_transform`, ref `cw-headers`), expression `(http.host eq "walks.wittebol.be")`, action
`rewrite`, setting these headers:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `frame-ancestors 'none'` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), payment=(), usb=(), geolocation=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `X-Content-Type-Options` | `nosniff` |

Don't add a broader CSP here. The pages have their own full CSP in `<meta>` tags, which differ between the app
and the editor. A header CSP that only sets `frame-ancestors` combines with them safely. `geolocation=(self)` is
required: the walking app uses GPS.

Check:
```
curl -sI https://walks.wittebol.be/admin.html | grep -iE 'content-security|x-frame|referrer|permissions|cross-origin|strict-transport|x-content'
curl -sI https://walks.wittebol.be/index.html | grep -i permissions-policy
```

### 6. Redirect the old address — only after the gate above
Single Redirect (phase `http_request_dynamic_redirect`, ref `cw-redirect`), 301, preserve query string:
- `https://wittebol.be/City-Walks/*` → `https://walks.wittebol.be/${1}`
  (expression `(http.host eq "wittebol.be" and starts_with(http.request.uri.path, "/City-Walks/"))`, target
  `wildcard_replace(http.request.full_uri, "https://wittebol.be/City-Walks/*", "https://walks.wittebol.be/${1}")`).
- `https://wittebol.be/City-Walks` (no trailing slash) → `https://walks.wittebol.be/`.

First check whether GitHub already redirects these once the project has its own domain:
`curl -sI https://wittebol.be/City-Walks/admin.html`. If it already answers 301 to `walks.wittebol.be`, the rule is
optional. Add it anyway for an explicit, permanent redirect, and report what you saw.
Check: `curl -sI 'https://wittebol.be/City-Walks/admin.html?x=1'` → `301`, `location: https://walks.wittebol.be/admin.html?x=1`.
Also confirm that `https://wittebol.be/` (the main site) still returns 200 and is unchanged.

### 7. Optional (ask the owner first)
CAA records to limit which certificate authorities may issue for `wittebol.be`. Only with the owner's agreement:
a wrong CAA set breaks certificate renewal for both GitHub (Let's Encrypt) and Cloudflare (several CAs).

## Not your job (handled in the City Walks repository)

- `SITE_URL: https://walks.wittebol.be/` in `.github/workflows/build.yml`.
- The editor changes (passkey unlock, cleanup of the old plain-text token, default repository name).
- README updates.

## Report back to the owner

The zone's original SSL mode, which rules were added (with their `ref`s), the output of the curl checks above, and
anything you skipped or found unexpected.
