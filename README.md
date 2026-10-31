# City Walks

A phone web app with guided walks in Belgian cities (Brussels, Ghent and Antwerp for now): live GPS position,
an arrow to the next stop, a buzz and the story when you arrive (optionally read aloud), and short notes about
sights you pass on the way. Everything is built from **open data**.

Live: `https://<your-username>.github.io/<this-repo>/`. Add it to your home screen for an app-like experience.

## Open data used

| Source | Used for | Licence |
|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/) (tiles, Overpass API) | Map, positions of murals and artworks, street art walks, sights along the way | ODbL |
| [Wikidata](https://www.wikidata.org/) (Query Service + API) | "Highlights" walks (notable heritage near a point), linking places to articles | CC0 |
| [Wikipedia](https://www.wikipedia.org/) (REST + geosearch) | Texts, photos and precise coordinates, in English, Dutch, French or German | CC BY-SA |
| [Wikimedia Commons](https://commons.wikimedia.org/) | Photos | various free licences |
| [City of Brussels open data](https://opendata.brussels.be/) (dataset `bruxelles_parcours_bd`) | Official positions of the comic strip murals; "every mural" walk | see portal |
| [Flemish heritage inventory](https://inventaris.onroerenderfgoed.be/) (via Wikidata) | Links to the official heritage record | see portal |
| [OSRM](https://routing.openstreetmap.de/) (FOSSGIS) | Walking routes | ODbL data |
| [Nominatim](https://nominatim.openstreetmap.org/) | Address lookup as a last resort | ODbL data |

Not used on purpose: Street Art Cities' data. Its terms don't allow reuse in an app like this without permission.

## Files

| File | What it is |
|---|---|
| `index.html` | The page (no inline scripts; includes the Content Security Policy) |
| `util.js`, `sources.js`, `schema.js`, `app.js`, `app.css` | The app; `sources.js` holds all open data access, `schema.js` the file format rules |
| `admin.html`, `admin.js`, `admin.css` | The editor |
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

How the editor stays safe:

- Only fine-grained tokens are accepted; classic tokens (`ghp_…`, access to all repositories) are refused.
- The token is kept for this browser tab only (sessionStorage) and you're signed out after 60 minutes of
  inactivity. "Remember on this device" is opt-in, with a warning: all sites under `<you>.github.io` share
  browser storage.
- The token is only ever sent to `api.github.com`; the page's CSP blocks any other destination for it.
- The editor can only read and write `cities.json` and `walk-*.json`, never the app's code.
- Everything is checked with the same rules the app uses (`schema.js`) before it's saved; changes use the
  file's version (sha), so edits made elsewhere in the meantime are never overwritten silently.
- Everything is shown as text (never as HTML), and the page refuses to work inside a frame.
- Every change is a normal commit, so you can see and undo it in the repository history.

## Adding a city or walk by hand

1. Create `walk-<city>-<name>.json` (lowercase letters, digits, dashes).
2. Add it under the right city in `cities.json` (or add a new city with `id`, `name`, `lat`, `lon`, `walks`).
3. Commit. GitHub Pages publishes it in about a minute. GitHub's pencil icon works fine on a phone.

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

Results are cached on the phone and rebuilt automatically when the walk file or text language changes,
or via ☰ → Refresh walk data.

## Troubleshooting

☰ → Debug log → **Test data sources** checks every open data service from the phone. **Copy log** gives you
something to paste into a chat or issue. The log contains GPS positions, so share it privately.

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
- **Write access means your GitHub account.** Use two-factor authentication. If a future editor page needs a token,
  use a fine-grained token for this one repository with only "Contents: read and write", a short expiry, and
  store it only in your own browser.

## Credits

Map data © OpenStreetMap contributors. Texts from Wikipedia (CC BY-SA), shown with a link to the article.
Comic characters © their authors and publishers. The murals are part of the City of Brussels' Comic Book Route.
