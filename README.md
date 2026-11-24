# CircuitJS BOM (Cloudflare Workers)

A web app that turns a [Falstad CircuitJS1](https://www.falstad.com/circuit/) text export into a parts list. Paste or upload the export, view a summary or per-part table, and copy it into Google Sheets or download a CSV. Signed-in users (email and password, Google, or DigiKey) get a saved history of their circuits.

- **Hosting:** Cloudflare Workers, with static files served by Workers Static Assets
- **Database:** Cloudflare D1 (SQLite) for users, sessions, and history
- **Auth:** email + password (PBKDF2 via WebCrypto), Google OAuth 2.0, and DigiKey OAuth, all implemented with `fetch` and WebCrypto (no auth library)
- **Dependencies:** none at runtime; `wrangler` for dev/deploy only

Anonymous use works with no account. Signing in only adds history.

## Project layout

```
public/index.html     Front end (single file: HTML, CSS, JS)
src/index.js          Worker entry: routing and the /api/* endpoints
src/auth.js           Google sign-in, sessions, logout
src/password.js       Email + password accounts, sign-in, rate limiting
src/parser.js         CircuitJS export -> BOM (pure functions)
src/queries.js        BOM line -> DigiKey search terms (heuristics)
src/preferences.js    Ranked part-type preferences: catalog, validation, storage
src/brands.js         Manufacturer reputation groups and brand ranking
src/networks.js       Series/parallel alternatives for odd resistor and capacitor values
src/pricing.js        Picks the cheapest option from DigiKey results (price breaks, MOQ, stock)
src/digikey.js        DigiKey OAuth + keyword-search client
src/digikey-link.js   Connect a user's own DigiKey account (3-legged OAuth), token refresh
src/orders.js         Order Status responses -> the small shape the page uses
src/crypto.js         AES-GCM encryption for stored DigiKey tokens
schema.sql            D1 tables
wrangler.jsonc        Worker, static assets, and D1 binding config
test/                 Parser and API tests
```

## PCB export (KiCad 9)

After you generate a parts list, the **PCB (KiCad 9)** card turns the circuit into a KiCad project.

1. Look up prices first (optional but recommended), then press **Check circuit**. **The board follows the parts chosen in the price table** (use *Use this part* on an alternative to change the pick): each part's DigiKey package and mounting type pick its footprint, so a 0603 resistor, a TO-92 BC547 or a DIP-14 `SN74HC00N` lands on the right pads. Parts with no pick use the mounting style selected in the card.
2. Pick an IC for each op-amp (LM358, TL072, MCP6002, LM324). Logic gates and 555 timers get a sensible IC by default (74HC00/02/04/08/10/11/27/32/86, NE555), or the one implied by the part number you chose in the BOM. Channels that share an IC are packed into one package; spare gates have their inputs tied low and spare op-amps are parked.
3. Press **Download KiCad project**.
4. Unzip, open the `.kicad_pro` in KiCad 9 and run ERC. The PCB editor already holds the board (see below); press *Update PCB from Schematic* (F8) once to confirm it matches, then adjust, route, run DRC and order from KiCad.

How it works:

- Pin positions come from Falstad's own geometry (transistor and op-amp pins are computed, not stored), so nets match what you see on screen. Elements connect at coinciding points, wires, grounds and labeled nodes.
- **All DC rails of the same voltage become one net** (for example `+5V`) and a single power connector `J1` carries every supply and ground. IC power pins go to the highest positive rail and ground, with a 100 nF decoupling capacitor per IC.
- Nets are joined by labels on every pin rather than drawn wires; footprints are KiCad standard-library names.

The board (`.kicad_pcb`) and the 3D preview above the parts list:

- Every footprint is **placed automatically** inside a rectangular outline: `J1` on the left edge, then the most-connected part next, each pad aimed at the closest pad on its net (so decoupling capacitors end up beside their IC), no courtyards overlapping. Every pad carries its net, so KiCad shows the ratsnest straight away. With **Route traces** on (the default) the board is also routed, see below.
- The preview draws that same placement: pads in gold, parts as simple boxes sized from the footprints, and the routed copper (a *Bottom copper* toggle shows the back layer); without routing it shows unrouted connections as blue lines.
- **Routing** (`src/router.js`): a built-in 2-layer A* router on a 0.635 mm lattice with 45 degree tracks, the pedal spec's net classes (audio, high-Z, power, ground, VREF, LED), ground pours on both layers with stitching vias, and a Specctra `.dsn` for Freerouting. `src/drc.js` is an independent checker that re-measures clearance, width, vias, edges and connectivity from the result. It is this app's own checker: run KiCad's DRC before ordering. Teardrops (RT-10) are not generated; add them in KiCad with Edit > Teardrops.
- `report.md` follows the spec's D-7 sections and lists every check with its result: a check that was not run says so.
- **Guitar pedal mode** (checkbox in the PCB card; spec in `pedal_pcb_spec_for_model.md`): fits the outline to an enclosure (1590A/B, 125B, 1590BB, 1590DD) with the lid-screw posts cut out, places and locks the panel hardware (pots, in/out jacks, DC jack, 3PDT wire pads, LED), adds the parts the CircuitJS file omits (DC chain with reverse protection, bulk cap, status LED, test points, a Vcc/2 divider, bypass wiring), uses the spec's net names, and writes a drill plan (`drill_plan.json` / `.svg`), mechanical overlay, wiring guide, `netlist.json`, `placement.json` and the `Pedal` footprint library. Anything it has to assume is a typical value tagged [V] and listed in `report.md`: confirm them or upload your own `.kicad_mod`. Analog circuits only: delay and BBD-with-MCU types are blocked because the spec calls for 4 layers. Checks M1-M5, D3, E3-E6, CP-04, A1, A3 and A4 run; **M4** (nut and washer stack-up) and **BO-03** (the board-to-lid gap in sandwich mounting) use typical hardware values from `HW_STACK` in `src/pedal.js`, so they flag likely problems (for example a tall electrolytic under the lid) but are not a substitute for measuring your own hardware.
- Footprints are linked to their schematic symbols, so *Update PCB from Schematic* keeps them. Net names are the schematic's local labels as KiCad names them (`/+5V`, `/GND`).
- Pad geometry, silkscreen, courtyards and 3D-model references are embedded in `src/footprint-data.js`, generated by `scripts/gen-footprints.mjs` from the KiCad footprint libraries. The checked-in copy was generated from the GitHub mirror of the libraries, which stops at 2020, so some pad sizes may differ slightly from KiCad 9's current library. To refresh it from your own install: `node scripts/gen-footprints.mjs /usr/share/kicad/footprints` (macOS: `/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints`). If a footprint has no embedded geometry the `.kicad_pcb` is skipped with a warning and you use *Update PCB from Schematic* as before.

- **Potentiometers** get three pads (1 = one end, 2 = wiper, 3 = other end). Known PCB-mount families (Bourns 3296/3386, Alps RK09K) use their real footprint; a panel-mount pot gets a 3-way screw terminal so it can be wired off-board; anything else gets a generic 3 x 2.54 mm row of holes and a warning.
- **Logic gates** (2- and 3-input AND/NAND/NOR, 2-input OR/XOR, inverters) run from the rail closest to the voltage they were simulated at. **555 timers** use the chip's real pin layout from the simulation, tie ground and reset on the board when the simulation had no such pins, and map to a DIP-8 / SOIC-8.
- The BOM also counts chips, not channels: three op-amps order two dual packages, five NAND gates order two quad packages.

Limits: only resistors, capacitors, inductors, diodes, zeners, LEDs, switches, potentiometers, BJTs, MOSFETs, op-amps, logic gates (up to 3 inputs, where a catalog IC exists) and 555 timers are placed. Anything else (transformers, wider gates, other chips) blocks the export so the board is never silently incomplete. Transistor and IC pinouts differ between exact parts, so check the datasheet. The generator was not run through a real KiCad install here (tests check the files' structure, links and nets only): open the result, run ERC on the schematic and DRC on the board first.

## How to run the app

You need [Node.js](https://nodejs.org/) 20 or newer. Run everything below from the project folder (the one containing `package.json`).

### Run it on your computer

1. **Install**
   ```
   npm install
   ```
2. **Create your settings file** (first time only)
   ```
   cp .dev.vars.example .dev.vars
   ```
   Open `.dev.vars` and fill in what you want to use. Every line is optional, and a feature switches on when its values are present:

   | To get this | Fill in |
   |---|---|
   | Google sign-in (optional; email sign-in needs no settings) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (see [Set up Google sign-in](#set-up-google-sign-in)) |
   | Cheapest-parts price lookup | `DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET` |
   | DigiKey order history | the two DigiKey values above, plus `TOKEN_ENCRYPTION_KEY` (from `openssl rand -base64 32`, pasted whole, including the trailing `=`) |

3. **Create the local database** (first time, and again after updating the app; it is safe to repeat)
   ```
   npm run db:init:local
   ```
4. **Start the app**
   ```
   npm run dev
   ```
   Open http://localhost:8787. Stop it with `Ctrl+C`.

   If you use DigiKey order history locally, start it with `npx wrangler dev --local-protocol https` instead and open https://localhost:8787 (your browser will warn about the self-signed certificate). See [DigiKey order history](#digikey-order-history-optional).

**After changing `.dev.vars` or the code, stop the app and start it again.** Settings are only read at startup.

### Run it on the internet (Cloudflare)

See [Deploy](#deploy). After updating the app, run `npm run db:init:remote` and then `npm run deploy`.

### Check that it is working

Open http://localhost:8787/api/me (or your deployed address followed by `/api/me`). It shows which features are switched on:

- `"methods"` shows which sign-in methods are offered: `email` is always `true`; `google` and `digikey` are `true` when set up. (`"authConfigured"` is the Google one.)
- `"pricing": true` means price lookup is set up.
- `"orders": {"configured": true, ...}` means order history is set up. If `orders` is missing, you are running an old version of the app. If it says `"configured": false`, one of `DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET` or `TOKEN_ENCRYPTION_KEY` is missing.

Without any settings the app still works. The BOM tool runs, people can still sign in with email and password, and the Google, DigiKey, price and order options simply don't appear.

## Sign-in methods

The **Sign in** button opens a dialog with up to three options:

- **Email + password** (always on). Anyone can create an account with an email address and a password of at least 10 characters. Passwords are stored only as a salted PBKDF2-SHA256 hash. After 8 wrong guesses for one email, or 40 from one IP address, sign-in is blocked for 15 minutes.
  - **Emails are not verified.** There is no email service, so the app can't check that an address belongs to the person who typed it, and there is no "forgot password" email. Accounts are never merged by email address: an email account and a Google account that share an address are two separate accounts with separate history, so nobody can take over an account by typing someone else's address.
  - Cloudflare limits PBKDF2 to 100,000 iterations, which is the default. If sign-in fails with a CPU-time error on the Workers Free plan, lower it with a `PASSWORD_ITERATIONS` setting (existing accounts keep the count they were created with) or move to a paid plan.
- **Google** (needs the setup below).
- **DigiKey** (needs the DigiKey order-history setup, including `TOKEN_ENCRYPTION_KEY`). See below.

**How DigiKey sign-in works.** DigiKey's sign-in shows the app a token, but as far as I could find it doesn't document a user ID in it. So the app looks for an account ID in the token response, and if there is none it reads the `CustomerId` from the account's most recent orders (this needs the Order Status API and at least one order in the last year). That ID is what identifies the account here.
- If an ID is found, the first DigiKey sign-in creates an account and later ones sign in to it. Signing in with DigiKey also connects the orders card.
- If no ID is found (for example, the DigiKey account has no recent orders), DigiKey sign-in is refused with an explanation. The person signs in another way and uses **Connect DigiKey account** instead. Connecting records the ID when it can be found, so DigiKey sign-in then lands in that same account.
- Everyone who signs in to the same DigiKey account (for example, colleagues sharing a company account) ends up in the same app account and sees the same history. A DigiKey ID already belonging to another account is never moved.
- **This has only been tested against simulated DigiKey responses.** If your real DigiKey token response contains no ID and the orders lookup finds none, DigiKey sign-in will always be refused and only linking is available.

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
| `GET` / `PUT` | `/api/settings` | yes | Read or save the user's ranked part-type preferences and saved pricing filters |
| `POST` | `/api/networks` | no | Series/parallel alternatives for non-standard resistor and capacitor values. Body: `{ text, resistorSeries?, capacitorSeries?, tolerance? }` |
| `POST` | `/api/pricing` | yes | Body `{ items: [{ component, value, details, quantity, query? }], package?, inStock?, boards? }`. Returns the cheapest DigiKey options per line. See below. |
| `GET` | `/api/orders` | yes | The signed-in user's own DigiKey orders. Query: `start`, `end` (YYYY-MM-DD, default last 30 days), `page`, `pageSize` (max 25), `shared`. `409` with `notConnected: true` if they haven't connected DigiKey. |
| `GET` | `/api/orders/:salesOrderId` | yes | One sales order with line items and shipments |
| `GET` | `/auth/digikey/login` | yes | Start connecting a DigiKey account |
| `GET` | `/auth/digikey/callback` | yes | DigiKey redirect target |
| `POST` | `/auth/digikey/disconnect` | yes | Remove the stored DigiKey connection |
| `GET` | `/api/me` | no | `{ user, authConfigured, methods: { google, email, digikey }, pricing, orders: { configured, connected } }` |
| `GET` | `/api/history` | yes | Newest 100 saved circuits (id, title, part count, date) |
| `GET` | `/api/history/:id` | yes | One saved circuit, with its BOM recomputed from the stored text |
| `DELETE` | `/api/history/:id` | yes | Delete a saved circuit |
| `POST` | `/api/auth/register` | no | Create an email + password account and sign in. Body: `{ email, password, name? }` |
| `POST` | `/api/auth/login` | no | Sign in with email + password. Body: `{ email, password }`. `429` after too many failures |
| `GET` | `/auth/digikey/signin` | no | Start signing in with DigiKey |
| `GET` | `/auth/login` | no | Start Google sign-in |
| `GET` | `/auth/callback` | no | Google redirect target |
| `POST` | `/auth/logout` | no | End the session |

Limits: 500,000 characters per circuit, 200 saved circuits per user (oldest are dropped). Resubmitting the same circuit twice in a row doesn't create a duplicate entry.

## Settings: part preferences

Signed-in users get a **Settings** page (the button in the header, or `/settings.html`) where they rank the part types they prefer, best first. Drag the handle or use the arrow buttons to reorder, and untick a type to never use it:

- **Mounting style:** surface mount (SMD), through-hole
- **Capacitor type:** ceramic, film, aluminum electrolytic, tantalum
- **Resistor type:** metal film, carbon film, thick film (chip)
- **Brand reputation:** premium, standard, budget, unrated (see below)

For example, SMD then through-hole, and aluminum then film then ceramic.

**How the ranking is used.** In the DigiKey price lookup, **Parts** gets a **My preferences** option (selected automatically once you've saved a ranking). Each line is searched with your first choice. If nothing in stock matches, the next choice is searched, up to 3 searches per line, and the row is tagged **next choice** with an explanation. Mounting style is the main ordering: every type is tried in one mounting style before moving to the next. Picking Through-hole, Surface-mount or Any in the **Parts** menu instead overrides the mounting ranking, but your capacitor and resistor type rankings still apply. A search you type in yourself is never rewritten or retried.

**Brand reputation.** Instead of ranking hundreds of manufacturers, each maker belongs to a reputation group, and you rank the groups. For example, Panasonic (premium) versus Teapo (budget). With *Premium, then Standard* saved, each line's top pick is the **cheapest option from the most-preferred group that has stock**, which is not necessarily the cheapest overall. Groups you leave out are never offered, and if nothing acceptable is in stock the lookup moves to the next choice in your ranking. The brand is shown next to each part ("premium brand"), and ranking is applied after DigiKey results are cached, so changing it costs no extra requests.

The groups live in `src/brands.js`, and **they are a rough rule of thumb, not a quality guarantee**. They reflect general reputation for consistency, mostly for passives, so they will be wrong for some product lines. The lists are short on purpose: a maker that isn't listed is **unrated**, not bad. Edit the lists to match your own experience. Matching is by the start of DigiKey's manufacturer name, so `panasonic` also matches "Panasonic Electronic Components".

**Limits.**
- Preferences only guide the price lookup. They don't change the parts list or the alternatives card.
- The voltage rating, size and tolerance in each search are still assumptions (see the price lookup section). Edit any search to change them.
- Fallbacks cost DigiKey requests. A single lookup makes at most 40 searches in total, fallbacks included.
- Preferences are stored per user in the `user_settings` table. Run `npm run db:init:remote` (and `db:init:local`) once after updating. Until then, saving shows a message asking for that.

**Pricing filters save automatically.** For signed-in users, the DigiKey controls (In stock only, Usually stocking only, Include tariffed, Include marketplace items, and the **Parts** menu once you've picked one) are saved a moment after you change them and restored the next time you sign in. They are stored in the same `user_settings` row as the rankings, under a `filters` key, so saving one never overwrites the other and no database change is needed. Signed-out use is unchanged and nothing is stored.

API: `GET /api/settings` returns `{ preferences, filters, catalog }`; `PUT /api/settings` with `{ preferences: { mounting: ["smd","tht"], capacitor: ["aluminum","film","ceramic"] } }` and/or `{ filters: { inStock: true, tariffed: false, package: "smd" } }` saves (anything you leave out is unchanged; filters merge over the saved ones). Both need sign-in. An empty list means no preference for that category.

## Common-value alternatives

The **Common-value alternatives** card finds resistors and capacitors in your parts list whose value isn't a common stock value, and suggests building each from a series or parallel pair of common ones. Click **Find alternatives** after generating a parts list.

- **Settings:** the E-series to treat as "common" for resistors (default E24) and capacitors (default E12), and the allowed error (default ±1%).
- **Single part first:** if the nearest common value is already within the allowed error, the card says so. One part is usually cheaper than two.
- **Ranking:** networks built only from values already on your parts list come first, since reusing a value saves ordering another one. Then fewer new values, then the smallest error.
- **Limits:** pairs only (two parts), and the first 30 non-standard values are checked. Your parts list is never changed; this is advice.
- **Caveats shown on each suggestion:** resistors split power, and series capacitors share voltage unevenly (use balancing resistors at higher voltages). Check ratings and tolerances before using one. Tolerances stack: two 5% parts can be off by more than 5% in total.
- **Not included:** prices. A pair is two parts, so it only saves money if the common values are cheaper than the odd one. Compare with the DigiKey price lookup.
- **CPU:** the finer series (E48, E96) take longer. If requests fail on the Workers Free plan with many odd values, use E24 or E12.

It is an unauthenticated endpoint, `POST /api/networks`, that takes `{ text, resistorSeries?, capacitorSeries?, tolerance? }`.

## DigiKey price lookup (optional)

Signed-in users get a "Cheapest parts" card under the BOM. **Find cheapest** searches DigiKey for each line and shows the cheapest in-stock option for the quantity needed (price breaks and minimum order quantities included), plus alternatives, a total, and a CSV/Sheets export. The card only appears as usable when DigiKey credentials are set.

**Set it up**

1. Create an account at [developer.digikey.com](https://developer.digikey.com/), create an organization and an app, and add the **Product Information V4** API product to it. (Menu names may change.) The app form asks for an OAuth callback URL; this app uses the 2-legged client-credentials flow, which doesn't redirect, so your workers.dev URL is fine.
2. Copy the app's client ID and client secret.
3. Local: add `DIGIKEY_CLIENT_ID` and `DIGIKEY_CLIENT_SECRET` to `.dev.vars`. Deployed: `npx wrangler secret put DIGIKEY_CLIENT_ID` and `npx wrangler secret put DIGIKEY_CLIENT_SECRET`.
4. Re-run `npm run db:init:local` / `npm run db:init:remote`. This adds two small tables (`pricing_cache`, `api_usage`) and is safe to repeat.
5. Optional: set `DIGIKEY_API_BASE=https://sandbox-api.digikey.com` (with sandbox credentials) to test without touching production quota. Sandbox data is not real pricing.

**How it works**

- Each purchasable BOM line becomes one DigiKey keyword search (`src/queries.js`), for example `10 kΩ` becomes `RES 10K OHM 1/4W AXIAL`. Supply rails and voltage/current sources are skipped. Parts the circuit doesn't identify (op-amps, generic transistors, LEDs...) get a common stand-in (LM358, 2N3904...) and are tagged **assumed**. Capacitor voltage ratings are assumed too.
- The search is a guess from the circuit alone, since the BOM has no package, tolerance, voltage rating or part number. Every search can be edited in the page; press Enter to re-check that line. Your edits are kept if you press Find cheapest again.
- Controls: number of boards (multiplies quantities), through-hole / surface-mount / any (or your saved preferences), and four filters:
  - **In stock only** (on by default): only parts with enough stock for the order.
  - **Usually stocking only** (off): only parts DigiKey flags as normally stocked, as opposed to special-order or occasionally stocked parts.
  - **Include tariffed** (on): untick to leave out parts DigiKey flags as having an active tariff. Tariffed parts are tagged "tariffed" in the part details either way.
  - **Include marketplace items** (off): tick to include items sold by third-party sellers through DigiKey Marketplace. They are tagged "marketplace".
  These filters are applied to DigiKey's results using the `NormallyStocking` and `TariffActive` flags on each product, and the marketplace option controls the request's `MarketPlaceFilter`. **I couldn't check these against the live API.** If "Usually stocking only" always returns no matches, DigiKey isn't sending that flag the way this code expects. Untick it and check `NormallyStocking` in `src/pricing.js`. Each combination of filters is cached separately.
- Results are the cheapest among DigiKey's top 30 keyword matches for each search, not a guaranteed global minimum. If buying slightly more drops into a cheaper price break and lowers the total, the page says so.
- Prices are DigiKey list prices in USD (US site).

**Limits and protections**

- DigiKey's Product Information API allows 120 requests/minute and 1,000/day per app. The Worker caps itself at 900 searches per UTC day (`PRICING.dailyLookups` in `src/index.js`), runs 4 at a time, and reports DigiKey's `429` as a per-line message.
- At most 40 BOM lines per request (`PRICING.maxItems`), which also keeps a request under the Workers Free plan's subrequest limit.
- Only signed-in users can look up prices, since every lookup spends the app's shared quota.
- Results are cached in D1 for 1 hour (`PRICING.cacheMs`) so repeat lookups are free. **Check DigiKey's API terms of use about storing price data** before relying on this or lengthening the cache. I couldn't read that agreement when building this. Setting `cacheMs` to `0` stops results being reused; stored rows are purged on the next lookup.

## DigiKey order history (optional)

Signed-in users can connect their **own** DigiKey account and browse their past orders: a list by date range with order and sales-order status, totals and ship method, plus line items and tracking numbers on request, and a CSV export. It uses DigiKey's Order Status V4 API (`/orderstatus/v4/orders` and `/orderstatus/v4/salesorder/{id}`).

Nothing is shared between users. Each person signs in at DigiKey and approves access (3-legged OAuth), and DigiKey itself decides what that token can see, so one user can never see another's orders.

**Set it up**

1. In your DigiKey app (the same one used for price lookup), add the **Order Status API** product. As far as I know it is separate from Product Information V4. Set the app's **OAuth callback URL** to `https://<your-worker>.<your-subdomain>.workers.dev/auth/digikey/callback` (or your custom domain). DigiKey requires HTTPS and an exact match.
2. Make an encryption key and store it as a secret: `openssl rand -base64 32`, then `npx wrangler secret put TOKEN_ENCRYPTION_KEY`. Without it the feature stays off, so tokens are never stored unencrypted. Keep a copy somewhere safe. If it is lost or changed, everyone has to reconnect.
3. Run `npm run db:init:remote` (adds the `digikey_links` table; safe to repeat). Until you do, the app shows the card as not connected instead of failing.
4. Deploy. Signed-in users now see a **DigiKey orders** card with **Connect DigiKey account**.

**Local development.** DigiKey won't redirect to plain `http://`, so run `npx wrangler dev --local-protocol https` (your browser will warn about the self-signed certificate) and register `https://localhost:8787/auth/digikey/callback`. A DigiKey app has one callback URL as far as I know, so make a separate **sandbox** app for this, put its credentials in `.dev.vars`, and set `DIGIKEY_API_BASE=https://sandbox-api.digikey.com`. If the app is served from a different address than the one users visit (custom domain, proxy), set `DIGIKEY_REDIRECT_URI`.

**What is stored and shown**

- Each user's access and refresh tokens are encrypted with AES-GCM (`TOKEN_ENCRYPTION_KEY`) before they go into D1, and each value is bound to its owner, so a copied value won't decrypt for anyone else.
- DigiKey replaces the refresh token every time it is refreshed. The Worker saves the new one each time and handles two requests refreshing at once. If DigiKey says the connection is dead (revoked, secret reset, expired), it is removed and the user is asked to reconnect.
- Orders are fetched live and never stored. Contact emails, phone numbers and street addresses are stripped in the Worker; the page only gets a name and city/state/country for shipping.
- **Disconnect** deletes the stored tokens here. It doesn't revoke the authorization on DigiKey's side.
- DigiKey's rate limits and date-range rules apply. A `429` or a rejected date range is shown as a message.

## CI/CD (GitHub Actions)

`.github/workflows/main.yml` runs the tests on every pull request and every push to `main`. A push to `main` that passes is then deployed to Cloudflare Workers, after applying `schema.sql` to the remote database (it only uses `CREATE ... IF NOT EXISTS`, so that is safe on every deploy). You can also run it by hand from the Actions tab.

**One-time setup** (repository **Settings > Secrets and variables > Actions**):

1. `CLOUDFLARE_ACCOUNT_ID`: your account ID (shown in the Cloudflare dashboard sidebar, or in the `wrangler whoami` output).
2. `CLOUDFLARE_API_TOKEN`: create one at Cloudflare **My Profile > API Tokens** from the **Edit Cloudflare Workers** template, and add **Account > D1 > Edit** so the schema step can run.

The app's own secrets (Google, DigiKey, `TOKEN_ENCRYPTION_KEY`) are not touched by deploys. Set them once with `npx wrangler secret put`, and they stay on the Worker.

The deploy job uses a GitHub **environment** named `production`. To require someone to approve each deploy, add required reviewers under **Settings > Environments > production**. To turn deploys off, delete the `deploy` job.

## Adding another sign-in provider

Users and logins are separate tables, so a new provider doesn't require a migration:

1. Add a login/callback route pair in `src/auth.js` modeled on the Google one (or, for a form-based method, see `src/password.js`). Use `sessionCookie()` from `src/auth.js` to start the session.
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

Runs the parser tests (both export formats), the search-building and cheapest-option tests, and API tests (Node 22+). DigiKey is mocked in the tests, so they check this app's behaviour against DigiKey's documented request and response shapes, not against the live service. The order-history tests also cover connecting, token refresh and rotation, two requests refreshing at once, a revoked connection, and isolation between users. Do one real lookup and one real order load with your credentials after setting up. The API tests call the Worker directly against an in-memory SQLite database standing in for D1, with Google's endpoints mocked. They cover anonymous use, validation, history and per-user isolation, session expiry, logout, the Google sign-in flow, email + password accounts (including lockout and no merging by email), and DigiKey sign-in and linking. They don't start `wrangler dev` or a browser, so do a quick manual check of the page after your first local run.

## Limitations

- Two export formats are supported and detected automatically: the classic line format (`r 176 80 304 80 0 1000`) and the newer XML-style format (`<r x="176 80 304 80" f="0" r="1000"/>`). The XML mapping was checked against one real circuit (`test/fixtures/`). Element types it doesn't recognize are listed as `Unknown (type name)` with their raw attributes in Details, rather than dropped. If you hit one, send me a sample, or add an entry to `XML_COMPONENTS` (XML) or `COMPONENTS` (classic) in `src/parser.js`, plus a prefix in `REF_PREFIX` if you want a specific reference designator.
- Some XML elements (voltage source `v`, inductor `l`, current source `i`, Zener `z`) are mapped from the classic format's names and haven't been checked against a real XML sample. If an attribute name differs, their raw attributes show up in Details instead of a value.
- Share links that store the circuit compressed (`?ctz=...`) aren't supported. Use **File > Export As Text** instead.
- Values reflect the simulated circuit. Package, tolerance, and part numbers aren't in the export, so they aren't in the BOM.
