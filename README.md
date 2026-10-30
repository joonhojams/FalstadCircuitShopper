# CircuitJS BOM (Cloudflare Workers)

A web app that turns a [Falstad CircuitJS1](https://www.falstad.com/circuit/) text export into a parts list. Paste or upload the export, view a summary or per-part table, and copy it into Google Sheets or download a CSV. Signed-in users (Google) get a saved history of their circuits.

- **Hosting:** Cloudflare Workers, with static files served by Workers Static Assets
- **Database:** Cloudflare D1 (SQLite) for users, sessions, and history
- **Auth:** Google OAuth 2.0, implemented with `fetch` (no auth library)
- **Dependencies:** none at runtime; `wrangler` for dev/deploy only

Anonymous use works with no account. Signing in only adds history.

## Project layout

```
public/index.html     Front end (single file: HTML, CSS, JS)
src/index.js          Worker entry: routing and the /api/* endpoints
src/auth.js           Google sign-in, sessions, logout
src/parser.js         CircuitJS export -> BOM (pure functions)
schema.sql            D1 tables
wrangler.jsonc        Worker, static assets, and D1 binding config
test/                 Parser and API tests
```

## Run locally

```
npm install
cp .dev.vars.example .dev.vars      # then fill in Google credentials (optional, see below)
npm run db:init:local
npm run dev                         # http://localhost:8787
```

Without Google credentials the app still works; the "Sign in" button just doesn't appear.

## Set up Google sign-in

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project and configure the **OAuth consent screen** (app name, support email).
2. Go to **Credentials > Create credentials > OAuth client ID > Web application**.
3. Add these **Authorized redirect URIs**:
   - `http://localhost:8787/auth/callback` (local dev)
   - `https://<your-worker>.<your-subdomain>.workers.dev/auth/callback` (production, or your custom domain)
4. Put the client ID and secret in `.dev.vars` for local use, and set them as secrets for production (below).

The app requests only `openid email profile`. While the consent screen is in "Testing" status, only listed test users can sign in; publish it to allow anyone.

## Deploy

```
npx wrangler login
npx wrangler d1 create circuitjs-bom      # copy the database_id it prints into wrangler.jsonc
npm run db:init:remote
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npm run deploy
```

Then add the deployed URL's `/auth/callback` to the Google client's redirect URIs.

## API

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/bom` | optional | Body `{ text, title?, save? }`. Returns `{ count, summary, parts, unknown, id, saved }`. Saves to history when signed in (unless `save: false`). |
| `GET` | `/api/me` | no | `{ user, authConfigured }` |
| `GET` | `/api/history` | yes | Newest 100 saved circuits (id, title, part count, date) |
| `GET` | `/api/history/:id` | yes | One saved circuit, with its BOM recomputed from the stored text |
| `DELETE` | `/api/history/:id` | yes | Delete a saved circuit |
| `GET` | `/auth/login` | no | Start Google sign-in |
| `GET` | `/auth/callback` | no | Google redirect target |
| `POST` | `/auth/logout` | no | End the session |

Limits: 500,000 characters per circuit, 200 saved circuits per user (oldest are dropped). Resubmitting the same circuit twice in a row doesn't create a duplicate entry.

## Adding another sign-in provider

Users and logins are separate tables, so a new provider doesn't require a migration:

1. Add a login/callback route pair in `src/auth.js` modeled on the Google one.
2. After verifying the provider's response, look up `identities` by `(provider, provider_user_id)`, create a `users` row plus an `identities` row if none exists, then call `createSession()`.

Accounts from different providers are not merged automatically, even if the email matches. Linking them safely needs a deliberate "link account" step.

## Security notes

- Session tokens are random, stored only as SHA-256 hashes, and sent in `HttpOnly`, `SameSite=Lax` cookies (`Secure` on HTTPS). Sessions last 30 days.
- OAuth uses a random `state` value checked against a short-lived cookie.
- Write requests with a cross-origin `Origin` header are rejected.
- CSV/TSV export prefixes cells that could be read as spreadsheet formulas (for example starting with `=` or `@`), since circuit files can come from other people.
- Everything the page renders from a circuit file is inserted as text, not HTML.

## Tests

```
npm test
```

Runs the parser tests (both export formats) and API tests (Node 22+). The API tests call the Worker directly against an in-memory SQLite database standing in for D1, with Google's endpoints mocked. They cover anonymous use, validation, history and per-user isolation, session expiry, logout, and the full sign-in flow. They don't start `wrangler dev` or a browser, so do a quick manual check of the page after your first local run.

## Limitations

- Two export formats are supported and detected automatically: the classic line format (`r 176 80 304 80 0 1000`) and the newer XML-style format (`<r x="176 80 304 80" f="0" r="1000"/>`). The XML mapping was checked against one real circuit (`test/fixtures/`). Element types it doesn't recognize are listed as `Unknown (type name)` with their raw attributes in Details, rather than dropped. If you hit one, send me a sample, or add an entry to `XML_COMPONENTS` (XML) or `COMPONENTS` (classic) in `src/parser.js`, plus a prefix in `REF_PREFIX` if you want a specific reference designator.
- Some XML elements (voltage source `v`, inductor `l`, current source `i`, Zener `z`) are mapped from the classic format's names and haven't been checked against a real XML sample. If an attribute name differs, their raw attributes show up in Details instead of a value.
- Share links that store the circuit compressed (`?ctz=...`) aren't supported. Use **File > Export As Text** instead.
- Values reflect the simulated circuit. Package, tolerance, and part numbers aren't in the export, so they aren't in the BOM.
