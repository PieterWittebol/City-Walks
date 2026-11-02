# City Walks

A phone web app with guided walks in Belgian cities (Brussels, Ghent and Antwerp for now): live GPS position,
an arrow to the next stop, a buzz and the story when you arrive (optionally read aloud), and short notes about
sights you pass on the way. Everything is built from **open data**.

Live: `https://<your-username>.github.io/<this-repo>/`. Add it to your home screen for an app-like experience.

## Languages

Everything a walker reads can be written per language (English, Dutch, French, German): city names, walk
titles, subtitles and descriptions, stop titles and stop texts, and hand-written sights. In the files a field is
either a plain string (in the walk's `lang`) or an object such as `{"en": "Belfry", "nl": "Belfort"}`. In the editor
every such field has a **Translations** section.

What a walker sees, in order of preference: your own text in their language → Wikipedia in their language
(for titles: the article title) → your own text in another language → Wikipedia in another language. A note
shows when a text isn't available in the chosen language.

For heritage in Flanders the build also adds the description from the **Flemish heritage inventory** (Dutch):
as an extra paragraph in Dutch, or as the text when nothing else exists. To switch this off, set the environment
variable `OE_TEXTS: off` for the "Build walk data" step in `.github/workflows/build.yml`.

## Walking a route

- **Turn-by-turn:** the build stores the walking route between each pair of stops, with every turn (OSRM). The
  app shows the next manoeuvre ("In 40 m · Turn left onto Rue du Midi") in the chosen language, cues ~25 m before
  it, and can speak it (☰ → Speak directions at turns).
- **Live routing:** to the first stop, to a stop picked out of order, or after walking more than ~40 m off the
  route for a few seconds, the phone asks OSRM for a fresh route (at most every 20 s). Meanwhile it shows an
  arrow straight to the stop.
- **Arriving:** the app stays on that stop with its story until you tap **Continue to …**. Stops close together
  can't skip each other any more.
- **Cues:** Android vibrates. iPhones don't let websites vibrate, so you get a short chime instead (needs the
  silent switch off) and, on iOS 18+, a light haptic tick (best effort). ☰ → Debug log → Test sound & vibration.

## How the data gets to the phone

A GitHub Action (`.github/workflows/build.yml` + `build.mjs`) runs after every change, every Monday and on demand.
It looks up all open data **once**, for every walk in English, Dutch, French and German, and publishes the
results as ready-made files in `built/` next to the app. Phones load those files from this site and don't
query Wikipedia, Wikidata, OpenStreetMap, the routing service or Nominatim themselves. Only map tiles and
photos still come from OpenStreetMap and Wikimedia.

- **After a change** (e.g. a save in the editor), only the changed walks are looked up again. The rest is
  reused from the published site.
- **Every Monday** everything is rebuilt, to pick up improvements on Wikipedia and OpenStreetMap.
- **Fallback:** if a walk has no ready-made file (a build failed, or it's still running), the phone looks
  the data up itself, as before.
- **Same code:** the build runs the app's own `util.js`, `sources.js`, `schema.js` and `builder.js` in a
  sandbox. It identifies itself to the services with a User-Agent, spaces out its requests, retries politely
  and caches identical requests.
- **Report:** each run shows a summary per walk (languages, stops, how they were placed, route length) under
  **Actions**. Problems appear there as warnings.

The build has a time limit: after 20 minutes it stops starting new lookups and keeps the previously published
data for walks that haven't changed (phones look up the rest themselves until the next build). Answers from the
open data services are kept between runs and reused for up to 8 days after an edit; Monday and manual runs ask
everything fresh. An OpenStreetMap search server (Overpass) that keeps timing out is skipped for 10 minutes, and
gets another chance before the retry round.

OpenStreetMap questions (artworks, places linked to Wikipedia/Wikidata) don't go to the public Overpass servers at
all when possible: once a day the build downloads the OpenStreetMap data for Belgium from
[Geofabrik](https://download.geofabrik.de/europe/belgium.html), keeps only those objects (with `osmium`) and
answers from that. Places outside Belgium, or a day when the download fails, still use Overpass as before.

### One-time setup

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. Create `.github/workflows/build.yml` (on github.com: Add file → Create new file, type the full path as the name)
   and paste the workflow.
3. Check **Actions**: the first run takes about 15 minutes. Later runs after an edit are much faster.

The workflow has read-only access to the repository and only the rights needed to publish Pages. It uses no
secrets and only GitHub's own actions, pinned to exact versions.

## Open data used

| Source | Used for | Licence |
|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/) (tiles, Overpass API, [Geofabrik](https://download.geofabrik.de/) extract for the build) | Map, positions of murals and artworks, street art walks, sights along the way | ODbL |
| [Wikidata](https://www.wikidata.org/) (Query Service + API) | "Highlights" walks (notable heritage near a point), linking places to articles | CC0 |
| [Wikipedia](https://www.wikipedia.org/) (REST + geosearch) | Texts, photos and precise coordinates, in English, Dutch, French or German | CC BY-SA |
| [Wikimedia Commons](https://commons.wikimedia.org/) | Photos | various free licences |
| [City of Brussels open data](https://opendata.brussels.be/) (dataset `bruxelles_parcours_bd`) | Official positions of the comic strip murals; "every mural" walk | see portal |
| [Flemish heritage inventory](https://inventaris.onroerenderfgoed.be/) (Agentschap Onroerend Erfgoed) | Dutch descriptions and links for heritage in Flanders, found via Wikidata (P1764) or the agency's geo search service | free to reuse with attribution; reuse conditions being confirmed with info@onroerenderfgoed.be |
| [OSRM](https://routing.openstreetmap.de/) (FOSSGIS) | Walking routes | ODbL data |
| [Nominatim](https://nominatim.openstreetmap.org/) | Address lookup as a last resort | ODbL data |

Not used on purpose: Street Art Cities' data. Its terms don't allow reuse in an app like this without permission.

## Files

| File | What it is |
|---|---|
| `index.html` | The page (no inline scripts; includes the Content Security Policy) |
| `util.js`, `sources.js`, `schema.js`, `app.js`, `app.css` | The app; `sources.js` holds all open data access, `schema.js` the file format rules |
| `admin.html`, `admin.js`, `admin.css` | The editor |
| `unlock.js` | Editor: Touch ID (passkey) unlock; keeps the token in this browser only encrypted |
| `build.test.mjs`, `osm-local.test.mjs`, `unlock.test.mjs` | Tests for the build, the local OpenStreetMap answers and the unlock helpers (`node --test`) |
| `builder.js` | Builds a walk from open data (used by the app and the build) |
| `nav.js` | Turn-by-turn navigation: position on the route, next manoeuvre, wording in EN/NL/FR/DE |
| `build.mjs`, `.github/workflows/build.yml` | The GitHub build that prepares the data |
| `osm-local.mjs` | Answers the build's OpenStreetMap questions from the daily Geofabrik extract (not published) |
| `leaflet.js`, `leaflet.css` | Map library (Leaflet 1.9.4, BSD-2), kept in the repo so no CDN is needed |
| `sw.js` | Service worker: offline use, caches map tiles you've already seen |
| `manifest.webmanifest`, `icon*` | Home-screen name and icon |
| `cities.json` | **Cities and their walks** |
| `walk-*.json` | **One file per walk** |

All files sit in the root folder on purpose: GitHub's upload page on a phone can't upload folders.

## Editor

Open `admin.html` (e.g. `https://<your-username>.github.io/<this-repo>/admin.html`) to manage cities, walks and
stops from your phone: reorder stops, drag pins on the map, add places from nearby Wikipedia articles or a
search, write texts and set up generated walks. Saving creates a commit in this repository; the app shows the
change about a minute later.

Sign in with a **fine-grained personal access token**:
GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token →
*Only select repositories*: this one → *Repository permissions → Contents: Read and write* (nothing else) →
expiration 30–90 days.

**Unlock with Touch ID:** after you sign in with the token, the editor offers to set up a passkey (Touch ID, or
your device's passkey): tap **Set up** (Touch ID creates the passkey), then **Turn on** (Touch ID again, to
encrypt the token). The token is then stored in this browser only encrypted, with a key that only exists after a
successful Touch ID check. Next time, tap **Unlock with Touch ID** instead of pasting the token. **Lock** (top
right) wipes the token from memory; **Forget this device** removes the encrypted token. When the token expires or
is revoked, paste a new one and tap **Encrypt with Touch ID**: it's encrypted with the same passkey (one touch).
Browsers without passkey PRF support work as before: paste the token each time; it's kept for that tab only.

Safari may clear the editor's saved data after about 7 days without a visit (tracking prevention). Then paste the
token again and set up Touch ID again; delete the old passkey in the Passwords app (search the site's address).

How the editor stays safe:

- Only fine-grained tokens are accepted; classic tokens (`ghp_…`, access to all repositories) are refused.
- The token is stored only encrypted; unlocking needs your passkey (Touch ID). Without Touch ID unlock it's kept
  for this browser tab only (sessionStorage). It's never stored in plain text in the browser's long-term storage;
  a plain-text token saved by an older version of the editor is deleted on first load.
- The editor locks (Touch ID unlock) or signs out after 60 minutes of inactivity.
- The token is only ever sent to `api.github.com`; the page's CSP blocks any other destination for it.
- The editor can only read and write `cities.json` and `walk-*.json`, never the app's code.
- Everything is checked with the same rules the app uses (`schema.js`) before it's saved; changes use the
  file's version (sha), so edits made elsewhere in the meantime are never overwritten silently.
- Everything is shown as text (never as HTML), and the page refuses to work inside a frame.
- Every change is a normal commit, so you can see and undo it in the repository history.

## Adding a city or walk by hand

1. Create `walk-<city>-<name>.json` (lowercase letters, digits, dashes).
2. Add it under the right city in `cities.json` (or add a new city with `id`, `name`, `lat`, `lon`, `walks`).
3. Commit. The build publishes it in a few minutes. GitHub's pencil icon works fine on a phone.

There are two kinds of walk.

### 1. Hand-picked stops

```jsonc
{
  "schema": 2, "id": "medieval", "title": "Medieval Ghent", "subtitle": "…", "description": "Shown on the start screen.",
  "lang": "en",                         // language of texts written in this file
  "stops": [                            // in walking order
    {
      "id": "gravensteen",              // unique within the walk; progress is stored per id
      "title": "Gravensteen",
      "lat": 51.0573, "lon": 3.7206,    // rough position is enough when "wiki" is given
      "wiki": ["gravensteen"],          // finds the Wikipedia article near this point: text, photo, exact position
      // or "wikipedia": "nl:Gravensteen"  or  "wikidata": "Q…"
      "text": "",                       // optional own text; if empty the Wikipedia summary is used
      "match": ["tintin", "kuifje"],    // murals: words to find it in the city open data / OpenStreetMap
      "artworkType": "mural",           // optional: "mural" or "statue"
      "fixed": false,                   // true = trust lat/lon exactly
      "artist": "", "year": "", "address": "",
      "image": "photo.jpg"              // optional: file in this repo or upload.wikimedia.org URL
    }
  ],
  "matchSources": [                     // optional: official data to position murals
    { "type": "ods", "host": "opendata.brussels.be", "dataset": "bruxelles_parcours_bd" }
  ],
  "geocodeSuffix": "1000 Bruxelles, Belgium", // optional: for looking up "address" as a last resort
  "sights": [ { "title": "…", "lat": 0, "lon": 0, "text": "…" } ]  // optional own notes
}
```

### 2. Generated from open data

Instead of `stops`, give a `generator`. The app fetches the places, puts them in a walkable order
(nearest neighbour + 2-opt) and calculates the route.

```jsonc
"generator": { "type": "wikidata", "center": [51.0543, 3.7253], "radiusKm": 0.9, "limit": 15, "minSitelinks": 5, "exclude": ["Q…"] }
"generator": { "type": "osm-art",  "center": [51.0549, 3.7259], "radiusKm": 1.5, "limit": 20, "artworkTypes": ["mural", "graffiti"] }
"generator": { "type": "ods", "host": "opendata.brussels.be", "dataset": "bruxelles_parcours_bd", "center": [50.8467, 4.3525], "radiusKm": 1.3,
               "fields": { "title": ["personnage_s"], "artist": ["auteur_s"], "year": ["annee"], "address": ["adresse"], "text": ["description"] } }
```

Opendatasoft portals allowed: `opendata.brussels.be` and `data.stad.gent`. To add another portal, add it to
`ODS_HOSTS` in `sources.js`, to the allow-lists in `util.js` **and** to the CSP in `index.html`.

The build prepares the result. On the phone it's cached and refreshed automatically when the walk file or text language changes,
or via ☰ → Refresh walk data.

## Troubleshooting

☰ → Debug log → **Test data sources** checks every open data service from the phone. **Copy log** gives you
something to paste into a chat or issue. The log contains GPS positions, so share it privately.

**The editor asks for the token again although Touch ID unlock was set up (Safari):** Safari may clear a site's
saved data after about 7 days without a visit (tracking prevention). Paste the token again and set up Touch ID
again, then delete the old passkey in the Passwords app (search the site's address).

## Manual checks (editor)

WebAuthn can't run in the automated tests, so check the editor's sign-in by hand after changing `admin.js`,
`admin.html` or `unlock.js`, in Safari and Firefox on macOS (Touch ID), with a real fine-grained token.
Open the browser's developer tools to look at storage (Storage / Application → Local and Session storage).

**While moving to walks.wittebol.be:** at the old address (wittebol.be/City-Walks), choose **Not now** when the
editor offers Touch ID (or tap **Forget this device** before the redirect goes live); set up Touch ID only at
walks.wittebol.be. Before the redirect, open the editor at the old address in every browser and on every device
where it was used (including the phone). The new token (and revoking the old one) is the backstop.

1. **Enable:** sign in with the token. Expected: "Unlock with Touch ID next time?" → **Set up** → Touch ID →
   "Turn on Touch ID unlock" → **Turn on** → Touch ID → the city list (each prompt starts from its own tap); the
   button top right says **Lock**. `localStorage["cw:unlock"]` exists and contains no `github_pat_`;
   `sessionStorage` contains no `github_pat_`.
2. **Reload:** expected: the start screen shows **Unlock with Touch ID**, **Use a token instead** and **Forget this
   device**; the token form is hidden.
3. **Unlock:** tap **Unlock with Touch ID**, one touch. Expected: the city list.
4. **Cancel Touch ID:** reload, tap **Unlock with Touch ID** and cancel the prompt. Expected: "Unlock
   cancelled. If you deleted the passkey, choose Forget this device."; the three buttons are still there and
   `cw:unlock` is unchanged. Unlocking again works.
5. **Lock:** tap **Lock** (with an unsaved change, you're asked first). Expected: the start screen with **Unlock
   with Touch ID**.
6. **Idle lock:** for a quick check, change the 60-minute limit in `admin.js` to 1 minute in a local copy only
   (never commit that), wait 2 minutes without touching the page. Expected: locked, with "Locked after 60 minutes
   without activity." Without Touch ID unlock: signed out with "Signed out after 60 minutes without activity."
7. **Token expired:** revoke the token on GitHub, then unlock. Expected: the token form with "Your token expired or
   was replaced. Paste a new one; Touch ID unlock stays set up."; `cw:unlock` still has `credentialId` and `salt`
   but no `iv` / `ciphertext`. Paste a new token → "Encrypt this token with Touch ID?" → **Encrypt with Touch
   ID** → one Touch ID touch (no new passkey) → the city list. (**Not now** keeps the token in memory only.)
   Reload → unlock works with the new token.
8. **Passkey deleted elsewhere:** delete the passkey in the Passwords app, then reload and unlock. The browser
   reports this like a cancel. Expected: "Unlock cancelled. If you deleted the passkey, choose Forget this
   device." and **Use a token instead** and **Forget this device** stay visible, so you're never stuck.
9. **Forget:** tap **Forget this device** (start screen, or below the token info in the city list) → confirm.
   Expected: `cw:unlock` is gone; a dialog explains how to delete the passkey (Passwords app → search the site's
   address → delete); then the token form.
10. **Old plain-text token:** in the console run `localStorage.setItem("cw:auth","{}")`, then reload. Expected:
    "A token saved by an older version of the editor was removed from this browser." and `cw:auth` is gone. Do this
    once in a browser with Touch ID unlock and once in one without.
11. **Browser without PRF:** (e.g. an older browser) expected: the token form only, no "remember" option. If the
    browser reports up front that it can't do passkeys with PRF, there's no offer to set up Touch ID. If it only
    turns out while creating the passkey (**Set up** → Touch ID), expected: "This browser can't protect the token
    with a passkey; you'll need to paste it again next time."; no `cw:unlock`; the new passkey is forgotten
    (delete it in the Passwords app if it's still listed); `localStorage["cw:noprf"]` is `"1"`, and the offer
    doesn't come back in this browser. Either way, after signing in the button top right says **Sign out**; a
    reload in the same tab signs in again from `sessionStorage`; a new tab asks for the token.

## Security

The repository and the site are public, so:

- **No secrets.** No API keys or tokens are needed or stored. Never commit one.
- **External content is untrusted.** Walk files, OpenStreetMap, Wikidata, Wikipedia and city data are inserted as
  plain text, never as HTML. Walk files are validated, and only `walk-*.json` files from this site are loaded.
- **Allow-lists** for links (Wikipedia, Wikidata, Commons, OpenStreetMap, the Flemish heritage inventory, the city
  portals) and images (Wikimedia, city portals, files in this repo).
- **Content Security Policy:** scripts only from this site, no inline scripts, frames or plugins. The network is
  limited to the services in the table above. Requests are sent without cookies.
- **No tracking, accounts or server.** Progress, settings and the debug log stay on the phone.
- **Write access means your GitHub account.** Use two-factor authentication. The editor's token is a fine-grained
  token for this one repository with only "Contents: read and write" and a short expiry. It's stored only
  encrypted; unlocking needs your passkey (or it's kept for one browser tab only).

## Credits

Map data © OpenStreetMap contributors. Texts from Wikipedia (CC BY-SA), shown with a link to the article.
Comic characters © their authors and publishers. The murals are part of the City of Brussels' Comic Book Route.
