// Exercises the Worker (routing, BOM API, history, sessions, Google OAuth flow)
// directly in Node, with an in-memory SQLite database standing in for D1.
// Requires Node 22+ (node:sqlite). Does not need wrangler or network access.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { SAMPLE } from "./parser.test.mjs";
import "./pricing.test.mjs";
import "./networks.test.mjs";
import "./brands.test.mjs";
import { ORDERS, SALES } from "./orders.test.mjs";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(schema);
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => {
      const r = db.prepare(sql).run(...params);
      return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return { prepare: (sql) => stmt(sql), batch: async (ss) => { const o = []; for (const s of ss) o.push(await s.run()); return o; } };
}

const ORIGIN = "http://localhost:8787";
const env = { DB: makeD1(), ASSETS: { fetch: async () => new Response("static-file") } };

async function call(path, { method = "GET", cookie, body, headers = {}, e = env } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request(ORIGIN + path, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
  const ct = res.headers.get("Content-Type") ?? "";
  return { res, status: res.status, data: ct.includes("json") ? await res.json() : await res.text() };
}

const sha = (s) => createHash("sha256").update(s).digest("hex");
async function seedUser(id, token) {
  await env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, `${id}@example.com`, `User ${id}`, Date.now()).run();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(sha(token), id, Date.now() + 3600_000).run();
  return `sid=${token}`;
}

// ---- static + anonymous ----
{
  const r = await call("/");
  assert.equal(r.data, "static-file", "non-API paths fall through to static assets");

  const me = await call("/api/me");
  assert.deepEqual(me.data, { authConfigured: false, methods: { google: false, email: true, digikey: false }, pricing: false, orders: { configured: false, connected: false }, hasPreferences: false, user: null });

  const bom = await call("/api/bom", { method: "POST", body: { text: SAMPLE } });
  assert.equal(bom.status, 200);
  assert.equal(bom.data.count, 12);
  assert.equal(bom.data.saved, false);
  assert.equal(bom.data.id, null);

  assert.equal((await call("/api/history")).status, 401);
  assert.equal((await call("/api/history/1")).status, 401);
  assert.equal((await call("/api/nope")).status, 404);
}

// ---- validation ----
{
  assert.equal((await call("/api/bom", { method: "POST", body: { text: "  " } })).status, 400);
  assert.equal((await call("/api/bom", { method: "POST", body: { text: "hello world" } })).status, 422);
  assert.equal((await call("/api/bom", { method: "POST", body: { text: "x".repeat(500_001) } })).status, 413);
  const bad = await worker.fetch(new Request(ORIGIN + "/api/bom", { method: "POST", body: "{not json" }), env);
  assert.equal(bad.status, 400);
}

// ---- CSRF origin check ----
{
  const r = await call("/api/bom", { method: "POST", body: { text: SAMPLE }, headers: { Origin: "https://evil.example" } });
  assert.equal(r.status, 403);
  const ok = await call("/api/bom", { method: "POST", body: { text: SAMPLE }, headers: { Origin: ORIGIN } });
  assert.equal(ok.status, 200);
}

// ---- signed-in history ----
const alice = await seedUser("alice", "alice-token");
const bob = await seedUser("bob", "bob-token");
{
  const me = await call("/api/me", { cookie: alice });
  assert.equal(me.data.user.name, "User alice");

  const a = await call("/api/bom", { method: "POST", cookie: alice, body: { text: SAMPLE, title: "Filter" } });
  assert.equal(a.data.saved, true);
  const idA = a.data.id;
  assert.equal(typeof idA, "number");

  const dup = await call("/api/bom", { method: "POST", cookie: alice, body: { text: SAMPLE } });
  assert.equal(dup.data.id, idA, "identical resubmission reuses the latest entry");

  const b = await call("/api/bom", { method: "POST", cookie: alice, body: { text: SAMPLE + "r 0 0 10 0 0 220\n" } });
  assert.notEqual(b.data.id, idA);
  assert.equal(b.data.count, 13);
  assert.equal(b.data.summary.find((s) => s.value === "220 Ω").quantity, 1);

  const nosave = await call("/api/bom", { method: "POST", cookie: alice, body: { text: SAMPLE + "r 0 0 10 0 0 330\n", save: false } });
  assert.equal(nosave.data.saved, false);

  const hist = await call("/api/history", { cookie: alice });
  assert.equal(hist.data.items.length, 2);
  assert.equal(hist.data.items[1].title, "Filter");
  assert.equal(hist.data.items[0].title, "13 parts");
  assert.equal(hist.data.items[0].circuit_text, undefined, "list does not ship circuit text");

  const one = await call(`/api/history/${idA}`, { cookie: alice });
  assert.equal(one.status, 200);
  assert.equal(one.data.count, 12);
  assert.equal(one.data.text, SAMPLE);

  // isolation between users
  assert.equal((await call(`/api/history/${idA}`, { cookie: bob })).status, 404);
  assert.equal((await call(`/api/history/${idA}`, { method: "DELETE", cookie: bob })).status, 404);
  assert.equal((await call("/api/history", { cookie: bob })).data.items.length, 0);

  // delete
  assert.equal((await call(`/api/history/${idA}`, { method: "DELETE", cookie: alice })).status, 200);
  assert.equal((await call(`/api/history/${idA}`, { cookie: alice })).status, 404);
}

// ---- history cap ----
{
  for (let i = 0; i < 205; i++) {
    await call("/api/bom", { method: "POST", cookie: bob, body: { text: SAMPLE + `r 0 0 10 0 0 ${i + 1}\n` } });
  }
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM queries WHERE user_id = 'bob'").first();
  assert.equal(n.n, 200, "history is capped at 200 per user");
  assert.equal((await call("/api/history", { cookie: bob })).data.items.length, 100, "list returns the newest 100");
}

// ---- expired / bogus sessions ----
{
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'alice', ?)")
    .bind(sha("old-token"), Date.now() - 1000).run();
  assert.equal((await call("/api/history", { cookie: "sid=old-token" })).status, 401);
  assert.equal((await call("/api/history", { cookie: "sid=garbage" })).status, 401);
}

// ---- logout ----
{
  const out = await call("/auth/logout", { method: "POST", cookie: alice });
  assert.equal(out.status, 200);
  assert.match(out.res.headers.get("Set-Cookie"), /sid=; .*Max-Age=0/);
  assert.equal((await call("/api/history", { cookie: alice })).status, 401, "session is deleted server-side");
}

// ---- Google OAuth flow (Google endpoints mocked) ----
{
  const gEnv = { ...env, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "secret" };

  // not configured -> 503
  assert.equal((await call("/auth/login")).status, 503);
  assert.equal((await call("/api/me", { e: gEnv })).data.authConfigured, true);

  const login = await call("/auth/login", { e: gEnv });
  assert.equal(login.status, 302);
  const loc = new URL(login.res.headers.get("Location"));
  assert.equal(loc.origin + loc.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(loc.searchParams.get("client_id"), "cid");
  assert.equal(loc.searchParams.get("redirect_uri"), `${ORIGIN}/auth/callback`);
  const state = loc.searchParams.get("state");
  assert.match(login.res.headers.get("Set-Cookie"), new RegExp(`oauth_state=${state}`));

  // bad / missing state is rejected
  assert.equal((await call(`/auth/callback?code=x&state=${state}`, { e: gEnv })).status, 400);
  assert.equal((await call(`/auth/callback?code=x&state=wrong`, { e: gEnv, cookie: `oauth_state=${state}` })).status, 400);

  // successful callback with mocked Google
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push(String(url));
    if (String(url) === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(opts.body);
      assert.equal(p.get("code"), "authcode");
      assert.equal(p.get("client_secret"), "secret");
      assert.equal(p.get("grant_type"), "authorization_code");
      return Response.json({ access_token: "at-123" });
    }
    if (String(url) === "https://openidconnect.googleapis.com/v1/userinfo") {
      assert.equal(opts.headers.Authorization, "Bearer at-123");
      return Response.json({ sub: "g-999", email: "carol@example.com", email_verified: true, name: "Carol", picture: "https://x/p.png" });
    }
    throw new Error("unexpected fetch " + url);
  };
  try {
    const cb = await call(`/auth/callback?code=authcode&state=${state}`, { e: gEnv, cookie: `oauth_state=${state}` });
    assert.equal(cb.status, 302);
    assert.equal(cb.res.headers.get("Location"), "/");
    const cookies = cb.res.headers.getSetCookie();
    const sid = cookies.find((c) => c.startsWith("sid="));
    assert.ok(sid && /HttpOnly/.test(sid) && /SameSite=Lax/.test(sid));
    const sidCookie = sid.split(";")[0];

    const me = await call("/api/me", { e: gEnv, cookie: sidCookie });
    assert.equal(me.data.user.name, "Carol");
    assert.equal(me.data.user.email, "carol@example.com");

    // signing in again with the same Google account reuses the same user
    const cb2 = await call(`/auth/callback?code=authcode&state=${state}`, { e: gEnv, cookie: `oauth_state=${state}` });
    assert.equal(cb2.status, 302);
    const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'carol@example.com'").first();
    assert.equal(users.n, 1);

    // unverified email is refused
    const prev = globalThis.fetch;
    globalThis.fetch = async (url, opts) =>
      String(url).includes("userinfo")
        ? Response.json({ sub: "g-1", email: "x@example.com", email_verified: false })
        : prev(url, opts);
    const bad = await call(`/auth/callback?code=authcode&state=${state}`, { e: gEnv, cookie: `oauth_state=${state}` });
    assert.equal(bad.status, 403);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- DigiKey pricing (DigiKey endpoints mocked) ----
{
  const dkEnv = { ...env, DIGIKEY_CLIENT_ID: "dk-id", DIGIKEY_CLIENT_SECRET: "dk-secret" };
  const dana = await seedUser("dana", "dana-token");
  const price = (items, extra = {}, e = dkEnv, cookie = dana) =>
    call("/api/pricing", { method: "POST", cookie, e, body: { items, ...extra } });
  const resistor = { component: "Resistor", value: "10 kΩ", details: "", quantity: 4 };

  // access control and configuration
  assert.equal((await call("/api/pricing", { method: "POST", body: { items: [resistor] } })).status, 401);
  assert.equal((await price([resistor], {}, env)).status, 503, "503 when DigiKey credentials are not set");
  assert.equal((await call("/api/me", { e: dkEnv })).data.pricing, true);
  assert.equal((await price([])).status, 400);
  assert.equal((await price(Array(41).fill(resistor))).status, 413);

  // mock DigiKey
  const mkProduct = (mpn, price1, stock) => ({
    ManufacturerProductNumber: mpn, Manufacturer: { Name: "Acme" }, Description: { ProductDescription: `RES ${mpn}` },
    ProductUrl: `https://www.digikey.com/p/${mpn}`, QuantityAvailable: stock,
    ProductVariations: [{ DigiKeyProductNumber: `${mpn}-ND`, PackageType: { Name: "Cut Tape (CT)" }, MinimumOrderQuantity: 1,
      QuantityAvailableforPackageType: stock, StandardPricing: [{ BreakQuantity: 1, UnitPrice: price1 }, { BreakQuantity: 10, UnitPrice: price1 / 4 }] }],
  });
  const realFetch = globalThis.fetch;
  let tokenCalls = 0;
  let searches = [];
  let searchStatus = 200;
  globalThis.fetch = async (url, opts) => {
    url = String(url);
    if (url === "https://api.digikey.com/v1/oauth2/token") {
      tokenCalls++;
      const p = new URLSearchParams(opts.body);
      assert.equal(p.get("client_id"), "dk-id");
      assert.equal(p.get("client_secret"), "dk-secret");
      assert.equal(p.get("grant_type"), "client_credentials");
      return Response.json({ access_token: `tok-${tokenCalls}`, expires_in: 599, token_type: "Bearer" });
    }
    if (url === "https://api.digikey.com/products/v4/search/keyword") {
      const body = JSON.parse(opts.body);
      searches.push({ body, headers: opts.headers });
      if (searchStatus !== 200) return new Response("{}", { status: searchStatus, headers: { "Retry-After": "30" } });
      return Response.json({ Products: [mkProduct("EXP", 0.2, 5000), mkProduct("CHEAP", 0.08, 900), mkProduct("GONE", 0.01, 1)], ProductsCount: 3 });
    }
    throw new Error("unexpected fetch " + url);
  };

  try {
    const opamp = { component: "Op-Amp", value: "", details: "", quantity: 3 };
    const rail = { component: "Voltage Rail", value: "5 V", details: "DC", quantity: 5 };
    const xfmr = { component: "Transformer", value: "", details: "Ratio 1", quantity: 1 };
    const r = await price([resistor, rail, opamp, xfmr, { component: "Resistor", value: "1 kΩ", quantity: 0 }]);
    assert.equal(r.status, 200);
    assert.equal(r.data.currency, "USD");
    const [a, b, c, d, e] = r.data.results;

    assert.equal(tokenCalls, 1, "one token request is shared by all lookups");
    assert.equal(searches.length, 2, "only purchasable lines hit DigiKey");
    const s0 = searches.find((s) => s.body.Keywords === "RES 10K OHM 1/4W AXIAL");
    assert.ok(s0, "resistor search built from the BOM row");
    assert.equal(s0.body.Limit, 30);
    assert.deepEqual(s0.body.FilterOptionsRequest.SearchOptions, ["InStock"]);
    assert.equal(s0.body.FilterOptionsRequest.MinimumQuantityAvailable, 4);
    assert.equal(s0.headers.Authorization, "Bearer tok-1");
    assert.equal(s0.headers["X-DIGIKEY-Client-Id"], "dk-id");
    assert.equal(searches.find((s) => s.body.Keywords.startsWith("LM358")).body.FilterOptionsRequest.MinimumQuantityAvailable, 3);

    assert.equal(a.needQty, 4);
    assert.deepEqual(a.options.map((o) => o.mpn), ["CHEAP", "EXP"], "cheapest first; out-of-stock part dropped");
    assert.equal(a.options[0].total, 0.32);
    assert.equal(a.options[0].buyMore.quantity, 10);
    assert.equal(b.skipped, "Supply rail, not a part");
    assert.equal(c.assumed, true);
    assert.match(c.note, /LM358/);
    assert.equal(d.query, "");
    assert.match(d.note, /Type a search/);
    assert.equal(d.options, undefined);
    assert.equal(e.error, "Invalid quantity");

    // second identical request is served from the cache
    const again = await price([resistor, opamp]);
    assert.equal(searches.length, 2, "no new DigiKey requests");
    assert.equal(again.data.results[0].cached, true);
    assert.equal(again.data.results[0].options[0].mpn, "CHEAP");

    // different quantity (2 boards) is a different cache key -> new search
    const two = await price([resistor], { boards: 2 });
    assert.equal(searches.length, 3);
    assert.equal(two.data.boards, 2);
    assert.equal(two.data.results[0].needQty, 8);
    assert.equal(searches[2].body.FilterOptionsRequest.MinimumQuantityAvailable, 8);

    // user-edited search overrides the built one; in-stock filter can be turned off
    const manual = await price([{ ...resistor, query: "RES 10K 1% METAL FILM" }], { inStock: false });
    assert.equal(searches[3].body.Keywords, "RES 10K 1% METAL FILM");
    assert.equal(searches[3].body.FilterOptionsRequest.SearchOptions, undefined);
    assert.equal(manual.data.results[0].query, "RES 10K 1% METAL FILM");
    assert.equal(manual.data.results[0].options.length, 3, "out-of-stock parts allowed when the filter is off");

    // usage counter and cache rows
    const day = new Date().toISOString().slice(0, 10);
    assert.equal((await env.DB.prepare("SELECT count FROM api_usage WHERE day = ?").bind(day).first()).count, 4);
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM pricing_cache").first()).n, 4);

    // 429 from DigiKey becomes a per-line error, not a failed request
    searchStatus = 429;
    const limited = await price([{ ...resistor, query: "something new" }]);
    assert.equal(limited.status, 200);
    assert.match(limited.data.results[0].error, /rate limit/i);
    assert.equal(limited.data.results[0].options, undefined);
    searchStatus = 200;

    // daily budget: nothing is sent once 900 lookups were used today
    await env.DB.prepare("UPDATE api_usage SET count = 900 WHERE day = ?").bind(day).run();
    const before = searches.length;
    const capped = await price([{ ...resistor, query: "another new search" }, resistor]);
    assert.equal(searches.length, before, "no DigiKey requests past the daily budget");
    assert.match(capped.data.results[0].error, /Daily DigiKey lookup limit/);
    assert.equal(capped.data.results[1].cached, true, "cached lines still work when the budget is spent");

    // expired access token: the Worker refreshes once and retries
    await env.DB.prepare("UPDATE api_usage SET count = 0 WHERE day = ?").bind(day).run();
    const realMock = globalThis.fetch;
    let first401 = true;
    globalThis.fetch = async (url, opts) => {
      if (String(url).endsWith("/search/keyword") && first401) { first401 = false; return new Response("{}", { status: 401 }); }
      return realMock(url, opts);
    };
    const tokensBefore = tokenCalls;
    const retried = await price([{ ...resistor, query: "retry search" }]);
    assert.equal(retried.data.results[0].options[0].mpn, "CHEAP");
    assert.equal(tokenCalls, tokensBefore + 1, "token refreshed after a 401");
    globalThis.fetch = realMock;

    // bad credentials -> a clear error
    const badTokenFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) =>
      String(url).endsWith("/oauth2/token") ? new Response("{}", { status: 401 }) : badTokenFetch(url, opts);
    const badEnv = { ...dkEnv, DIGIKEY_CLIENT_ID: "other-id" };
    const bad = await price([{ ...resistor, query: "needs a token" }], {}, badEnv);
    assert.equal(bad.status, 502);
    assert.match(bad.data.error, /sign-in failed/);
    globalThis.fetch = badTokenFetch;
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- DigiKey order history (each user connects their own account; DigiKey mocked) ----
{
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const oEnv = { ...env, DIGIKEY_CLIENT_ID: "dk-id", DIGIKEY_CLIENT_SECRET: "dk-secret", TOKEN_ENCRYPTION_KEY: key };
  const erin = await seedUser("erin", "erin-token");
  const fay = await seedUser("fay", "fay-token");
  const get = (path, user, e = oEnv) => call(path, { cookie: user, e });
  const linkCount = async (id) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM digikey_links WHERE user_id = ?").bind(id).first()).n;
  const expire = (id) => env.DB.prepare("UPDATE digikey_links SET access_expires_at = 0 WHERE user_id = ?").bind(id).run();

  // configuration and access control
  assert.deepEqual((await call("/api/me", { cookie: erin })).data.orders, { configured: false, connected: false });
  assert.equal((await get("/api/orders", erin, env)).status, 503);
  assert.equal((await call("/api/orders", { e: oEnv })).status, 401);
  assert.deepEqual((await get("/api/me", erin)).data.orders, { configured: true, connected: false });
  const notYet = await get("/api/orders", erin);
  assert.equal(notYet.status, 409);
  assert.equal(notYet.data.notConnected, true);
  assert.equal((await get("/api/orders", erin, { ...oEnv, TOKEN_ENCRYPTION_KEY: "short" })).status, 503,
    "a bad encryption key disables the feature instead of storing tokens unencrypted");
  assert.equal((await call("/auth/digikey/login", { e: oEnv })).status, 401, "must be signed in to connect");
  assert.equal((await get("/auth/digikey/login", erin, env)).status, 503);

  // mock DigiKey
  const realFetch = globalThis.fetch;
  const log = { token: [], orders: [], sales: [], probe: [] };
  let refreshStatus = 200, refreshesLeft = Infinity, refreshCount = 0, gate = null;
  const okOrders = () => Response.json(ORDERS);
  let ordersReply = okOrders;
  let probeReply = okOrders;
  let salesReply = () => Response.json(SALES);
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.pathname === "/v1/oauth2/token") {
      const p = Object.fromEntries(new URLSearchParams(opts.body));
      log.token.push(p);
      assert.equal(p.client_id, "dk-id");
      assert.equal(p.client_secret, "dk-secret");
      if (p.grant_type === "authorization_code") {
        return Response.json({ access_token: `at-${p.code}`, refresh_token: `rt-${p.code}`, expires_in: 1800, refresh_token_expires_in: 7775999, token_type: "Bearer",
          ...(String(p.code).startsWith("sub-") ? { sub: `dk-${p.code}` } : {}) });
      }
      assert.equal(p.grant_type, "refresh_token");
      if (gate) { // hold the first refresh until a second request is also refreshing
        gate.count++;
        if (gate.count === 1) await gate.second; else gate.release();
      }
      if (refreshStatus !== 200) return new Response("{}", { status: refreshStatus });
      if (refreshesLeft-- <= 0) return new Response("{}", { status: 400 }); // refresh token already rotated
      refreshCount++;
      return Response.json({ access_token: `at-r${refreshCount}`, refresh_token: `rt-r${refreshCount}`, expires_in: 1800, refresh_token_expires_in: 7775999 });
    }
    if (u.pathname === "/orderstatus/v4/orders" && u.searchParams.get("PageSize") === "1" && !opts.userQuery) {
      log.probe.push({ q: Object.fromEntries(u.searchParams), h: opts.headers }); // "which account is this?" lookup
      return probeReply();
    }
    if (u.pathname === "/orderstatus/v4/orders") { log.orders.push({ q: Object.fromEntries(u.searchParams), h: opts.headers }); return ordersReply(); }
    if (u.pathname.startsWith("/orderstatus/v4/salesorder/")) { log.sales.push({ id: u.pathname.split("/").pop(), h: opts.headers }); return salesReply(); }
    throw new Error("unexpected fetch " + u);
  };

  // helper: run the login + callback routes like a browser would
  const connect = async (user, code, e = oEnv) => {
    const login = await get("/auth/digikey/login", user, e);
    const state = new URL(login.res.headers.get("Location")).searchParams.get("state");
    return call(`/auth/digikey/callback?code=${code}&state=${state}`, { cookie: `${user}; dk_state=${state}`, e });
  };

  try {
    // --- connect ---
    const login = await get("/auth/digikey/login", erin);
    assert.equal(login.status, 302);
    const loc = new URL(login.res.headers.get("Location"));
    assert.equal(loc.origin + loc.pathname, "https://api.digikey.com/v1/oauth2/authorize");
    assert.equal(loc.searchParams.get("response_type"), "code");
    assert.equal(loc.searchParams.get("client_id"), "dk-id");
    assert.equal(loc.searchParams.get("redirect_uri"), `${ORIGIN}/auth/digikey/callback`);
    const state = loc.searchParams.get("state");
    assert.match(login.res.headers.get("Set-Cookie"), new RegExp(`dk_state=${state}`));

    const sandbox = await get("/auth/digikey/login", erin, { ...oEnv, DIGIKEY_API_BASE: "https://sandbox-api.digikey.com" });
    assert.ok(sandbox.res.headers.get("Location").startsWith("https://sandbox-api.digikey.com/v1/oauth2/authorize?"));
    const custom = await get("/auth/digikey/login", erin, { ...oEnv, DIGIKEY_REDIRECT_URI: "https://app.example.com/auth/digikey/callback" });
    assert.equal(new URL(custom.res.headers.get("Location")).searchParams.get("redirect_uri"), "https://app.example.com/auth/digikey/callback");

    const cb = (qs, cookie, e = oEnv) => call(`/auth/digikey/callback?${qs}`, { cookie, e });
    assert.equal((await cb(`code=c&state=bad`, `${erin}; dk_state=${state}`)).status, 400, "wrong state");
    assert.equal((await cb(`code=c&state=${state}`, erin)).status, 400, "missing state cookie");
    assert.equal((await cb(`error=access_denied&state=${state}`, `${erin}; dk_state=${state}`)).status, 400, "user declined");
    assert.equal((await cb(`code=c&state=${state}`, `dk_state=${state}`)).status, 401, "must still be signed in");
    assert.equal(log.token.length, 0, "no token request until the state checks out");

    const done = await cb(`code=code-e&state=${state}`, `${erin}; dk_state=${state}`);
    assert.equal(done.status, 302);
    assert.equal(done.res.headers.get("Location"), "/?digikey=connected");
    assert.deepEqual(log.token[0], { client_id: "dk-id", client_secret: "dk-secret", code: "code-e", redirect_uri: `${ORIGIN}/auth/digikey/callback`, grant_type: "authorization_code" });
    const stored = JSON.stringify(await env.DB.prepare("SELECT * FROM digikey_links WHERE user_id = 'erin'").first());
    assert.ok(!stored.includes("at-code-e") && !stored.includes("rt-code-e"), "tokens are stored encrypted");
    assert.deepEqual((await get("/api/me", erin)).data.orders, { configured: true, connected: true });

    // --- list orders ---
    const list = await get("/api/orders?start=2026-10-01&end=2026-10-31&page=2&pageSize=100&shared=true", erin);
    assert.equal(list.status, 200);
    assert.deepEqual(log.orders[0].q, { StartDate: "2026-10-01", EndDate: "2026-10-31", PageNumber: "2", PageSize: "25", Shared: "true" });
    assert.equal(log.orders[0].h.Authorization, "Bearer at-code-e");
    assert.equal(log.orders[0].h["X-DIGIKEY-Client-Id"], "dk-id");
    assert.equal(list.data.total, 27);
    assert.equal(list.data.page, 2);
    assert.equal(list.data.orders.length, 2);
    assert.equal(list.data.orders[1].total, 8.75);
    const leaked = JSON.stringify(list.data);
    for (const secret of ["Secret Street", "555-0100", "sam@example.com"]) assert.ok(!leaked.includes(secret));

    await get("/api/orders", erin);
    assert.equal(log.orders.at(-1).q.PageNumber, "1");
    assert.equal(log.orders.at(-1).q.PageSize, "25", "page size defaults to DigiKey's maximum, not 1");
    assert.equal(log.orders.at(-1).q.Shared, "false");
    assert.match(log.orders.at(-1).q.StartDate, /^\d{4}-\d{2}-\d{2}$/, "defaults to the last 30 days");

    const callsBefore = log.orders.length;
    assert.equal((await get("/api/orders?start=nope", erin)).status, 400);
    assert.equal((await get("/api/orders?start=2026-11-01&end=2026-10-01", erin)).status, 400);
    assert.equal(log.orders.length, callsBefore, "bad input never reaches DigiKey");

    // --- one sales order ---
    const one = await get("/api/orders/700001", erin);
    assert.equal(one.status, 200);
    assert.equal(log.sales[0].id, "700001");
    assert.equal(log.sales[0].h.Authorization, "Bearer at-code-e");
    assert.equal(one.data.items[0].mpn, "RC0603FR-0710KL");
    assert.equal(one.data.items[0].shipments[0].tracking, "1Z999AA10123456784");
    assert.equal((await get("/api/orders/abc", erin)).status, 404);
    assert.equal((await call("/api/orders/700001", { e: oEnv })).status, 401);

    // --- refresh and rotation ---
    await expire("erin");
    assert.equal((await get("/api/orders", erin)).status, 200);
    assert.equal(log.token.at(-1).grant_type, "refresh_token");
    assert.equal(log.token.at(-1).refresh_token, "rt-code-e");
    assert.equal(log.orders.at(-1).h.Authorization, "Bearer at-r1");
    await expire("erin");
    await get("/api/orders", erin);
    assert.equal(log.token.at(-1).refresh_token, "rt-r1", "the rotated refresh token is the one saved and reused");
    assert.equal(log.orders.at(-1).h.Authorization, "Bearer at-r2");

    // --- two requests refresh at once: one wins, the other picks up the winner's tokens ---
    await expire("erin");
    refreshesLeft = 1;
    let release;
    gate = { count: 0, second: new Promise((r) => { release = r; }) };
    gate.release = release;
    const tokensBefore = log.token.length;
    const [a, b] = await Promise.all([get("/api/orders", erin), get("/api/orders", erin)]);
    gate = null; refreshesLeft = Infinity;
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(log.token.length - tokensBefore, 2, "both requests were refreshing at the same time");
    assert.equal(await linkCount("erin"), 1, "the link survives the race");

    // --- the link is dead (revoked / secret reset): back to 'connect' ---
    await expire("erin");
    refreshStatus = 400;
    const dead = await get("/api/orders", erin);
    refreshStatus = 200;
    assert.equal(dead.status, 409);
    assert.equal(dead.data.notConnected, true);
    assert.equal(await linkCount("erin"), 0, "dead link is removed");
    assert.equal((await get("/api/me", erin)).data.orders.connected, false);

    // --- reconnect; DigiKey rejects a still-valid-looking token once: refresh and retry ---
    assert.equal((await connect(erin, "code-e2")).status, 302);
    let rejected = false;
    ordersReply = () => { if (!rejected) { rejected = true; return new Response("{}", { status: 401 }); } return okOrders(); };
    const refreshesBefore = log.token.length;
    assert.equal((await get("/api/orders", erin)).status, 200);
    assert.equal(log.token.length, refreshesBefore + 1, "one refresh, then the retry succeeds");
    assert.match(log.orders.at(-1).h.Authorization, /^Bearer at-r\d+$/);

    // --- DigiKey errors become clear messages ---
    ordersReply = () => new Response("{}", { status: 429, headers: { "Retry-After": "30" } });
    const limited = await get("/api/orders", erin);
    assert.equal(limited.status, 429);
    assert.equal(limited.data.retryAfter, 30);
    ordersReply = () => new Response("{}", { status: 403 });
    const denied = await get("/api/orders", erin);
    assert.equal(denied.status, 403);
    assert.match(denied.data.error, /Order Status API/);
    ordersReply = () => Response.json({ title: "Bad Request", detail: "StartDate range is too large" }, { status: 400 });
    const bad = await get("/api/orders", erin);
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /range is too large/);
    ordersReply = () => new Response("oops", { status: 500 });
    assert.equal((await get("/api/orders", erin)).status, 502);
    ordersReply = okOrders;
    salesReply = () => new Response("{}", { status: 404 });
    assert.equal((await get("/api/orders/123", erin)).status, 404);
    salesReply = () => Response.json(SALES);

    // --- users are isolated: each request carries that user's own token ---
    assert.equal((await connect(fay, "code-f")).status, 302);
    await get("/api/orders", fay);
    assert.equal(log.orders.at(-1).h.Authorization, "Bearer at-code-f");
    await get("/api/orders", erin);
    assert.notEqual(log.orders.at(-1).h.Authorization, "Bearer at-code-f");
    assert.equal(await linkCount("erin"), 1);
    assert.equal(await linkCount("fay"), 1);

    // --- disconnect ---
    assert.equal((await call("/auth/digikey/disconnect", { method: "POST", e: oEnv })).status, 401);
    assert.equal((await call("/auth/digikey/disconnect", { method: "POST", cookie: erin, e: oEnv, headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await call("/auth/digikey/disconnect", { method: "POST", cookie: erin, e: oEnv })).status, 200);
    assert.equal((await get("/api/orders", erin)).status, 409);
    assert.equal((await get("/api/orders", fay)).status, 200, "other users are unaffected");

    // --- the 90-day refresh token ran out ---
    await env.DB.prepare("UPDATE digikey_links SET refresh_expires_at = ?, access_expires_at = 0 WHERE user_id = 'fay'").bind(Date.now() - 1000).run();
    assert.equal((await get("/api/me", fay)).data.orders.connected, false);
    assert.equal((await get("/api/orders", fay)).status, 409);
    assert.equal(await linkCount("fay"), 0);

    // ===== Sign in with DigiKey (no existing session) =====
    const probeFor = (id) => () => Response.json({ Orders: id === null ? [] : [{ CustomerId: id }] });
    const dkSignin = async (code, e = oEnv) => {
      const start = await call("/auth/digikey/signin", { e });
      const state = new URL(start.res.headers.get("Location") ?? "http://x/").searchParams.get("state");
      const cb = await call(`/auth/digikey/callback?code=${code}&state=${state}`, { cookie: `dk_state=${state}`, e });
      return { start, state, cb, sid: (cb.res.headers.get("Set-Cookie") ?? "").match(/sid=([^;]+)/)?.[1] };
    };
    const countUsers = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).n;
    const identityOwner = async (id) =>
      (await env.DB.prepare("SELECT user_id FROM identities WHERE provider='digikey' AND provider_user_id=?").bind(id).first())?.user_id;

    // not configured -> 503; needs no session otherwise
    assert.equal((await call("/auth/digikey/signin", { e: env })).status, 503);
    const s1 = await dkSignin("code-s1");
    assert.equal(s1.start.status, 302);
    assert.ok(s1.state.startsWith("signin."));
    assert.equal(new URL(s1.start.res.headers.get("Location")).origin + "/v1/oauth2/authorize", "https://api.digikey.com/v1/oauth2/authorize");

    // identity from the orders lookup (CustomerId 501): first sign-in creates an account
    probeReply = probeFor(501);
    const before = await countUsers();
    const sa = await dkSignin("code-a");
    assert.equal(sa.cb.status, 302);
    assert.ok(sa.sid, "sign-in starts a session");
    assert.equal(await countUsers(), before + 1);
    const uA = await identityOwner("501");
    assert.ok(uA);
    const meA = await call("/api/me", { cookie: `sid=${sa.sid}`, e: oEnv });
    assert.equal(meA.data.user.name, "DigiKey account 501");
    assert.equal(meA.data.orders.connected, true, "signing in with DigiKey also connects the orders");
    assert.equal(log.probe.at(-1).h.Authorization, "Bearer at-code-a");
    // and the orders are that DigiKey user's own
    assert.equal((await get("/api/orders", `sid=${sa.sid}`, oEnv)).status, 200);
    assert.equal(log.orders.at(-1).h.Authorization, "Bearer at-code-a");

    // signing in again finds the same account
    const sa2 = await dkSignin("code-sa2");
    assert.equal(await countUsers(), before + 1);
    assert.equal((await call("/api/me", { cookie: `sid=${sa2.sid}`, e: oEnv })).data.user.name, "DigiKey account 501");
    assert.equal(await identityOwner("501"), uA);

    // a stable id in the token response is used, with no orders lookup
    const probes = log.probe.length;
    const sb = await dkSignin("sub-b");
    assert.ok(sb.sid);
    assert.equal(log.probe.length, probes);
    assert.ok(await identityOwner("dk-sub-b"));

    // no identity available (no recent orders): refuse, no session, no account
    probeReply = probeFor(null);
    const users = await countUsers();
    const none = await dkSignin("code-none");
    assert.equal(none.cb.status, 403);
    assert.equal(none.sid, undefined);
    assert.equal(await countUsers(), users);
    probeReply = () => new Response("{}", { status: 400 });
    assert.equal((await dkSignin("code-none2")).cb.status, 403);

    // an existing user links DigiKey; later "sign in with DigiKey" lands in that same account
    probeReply = probeFor(777);
    const gina = await seedUser("gina", "tok-gina");
    assert.equal((await connect(gina, "code-g")).status, 302);
    assert.equal(await identityOwner("777"), "gina");
    const g2 = await dkSignin("code-g2");
    assert.equal((await call("/api/me", { cookie: `sid=${g2.sid}`, e: oEnv })).data.user.name, "User gina");

    // another user connecting the same DigiKey account does not take the identity over
    const hal = await seedUser("hal", "tok-hal");
    assert.equal((await connect(hal, "code-h")).status, 302);
    assert.equal(await identityOwner("777"), "gina");

    // state checks
    const st = await call("/auth/digikey/signin", { e: oEnv });
    const ckState = new URL(st.res.headers.get("Location")).searchParams.get("state");
    assert.equal((await call(`/auth/digikey/callback?code=x&state=${ckState}`, { e: oEnv })).status, 400, "no state cookie");
    assert.equal((await call(`/auth/digikey/callback?code=x&state=${ckState}`, { cookie: "dk_state=other", e: oEnv })).status, 400);
    assert.equal((await call(`/auth/digikey/callback?error=access_denied&state=${ckState}`, { cookie: `dk_state=${ckState}`, e: oEnv })).status, 400);
    // the "link" flow still needs a session
    assert.equal((await call("/auth/digikey/login", { e: oEnv })).status, 401);
    // a signin state can't be turned into a link for someone else's session: it just signs in as the DigiKey account
    probeReply = okOrders;
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- email + password sign-in ----
{
  const e = { ...env, PASSWORD_ITERATIONS: "2000" }; // fast for tests; production default is 100000
  const post = (path, body, extra = {}) => call(path, { method: "POST", body, e, ...extra });
  const sidOf = (r) => (r.res.headers.get("Set-Cookie") ?? "").match(/sid=([^;]+)/)?.[1];

  // validation
  assert.equal((await post("/api/auth/register", { email: "nope", password: "long-enough-pw" })).status, 400);
  assert.equal((await post("/api/auth/register", { email: "a@example.com", password: "short" })).status, 400);
  assert.equal((await post("/api/auth/register", { email: "a@example.com", password: "x".repeat(201) })).status, 400);
  assert.equal((await post("/api/auth/register", "not json")).status, 400);

  // register -> signed in, and the account shows up
  const reg = await post("/api/auth/register", { email: "  Ada@Example.COM ", password: "correct horse battery", name: "Ada" });
  assert.equal(reg.status, 200);
  const sid = sidOf(reg);
  assert.ok(sid, "registration starts a session");
  assert.match(reg.res.headers.get("Set-Cookie"), /HttpOnly/);
  const who = await call("/api/me", { cookie: `sid=${sid}`, e });
  assert.equal(who.data.user.email, "ada@example.com", "email is normalised");
  assert.equal(who.data.user.name, "Ada");
  assert.equal(who.data.methods.email, true);

  // only a salted hash is stored
  const pw = await env.DB.prepare("SELECT * FROM passwords").first();
  assert.ok(pw.hash && pw.salt && pw.iterations === 2000);
  assert.ok(!JSON.stringify(pw).includes("correct horse"));

  // duplicate email, in any capitalisation
  assert.equal((await post("/api/auth/register", { email: "ADA@example.com", password: "another long one" })).status, 409);

  // sign in
  const ok = await post("/api/auth/login", { email: "ada@example.com", password: "correct horse battery" });
  assert.equal(ok.status, 200);
  const sid2 = sidOf(ok);
  assert.notEqual(sid2, sid, "each sign-in gets its own session");
  assert.equal((await call("/api/me", { cookie: `sid=${sid2}`, e })).data.user.email, "ada@example.com");
  // history works for this user like any other
  assert.equal((await call("/api/bom", { method: "POST", cookie: `sid=${sid2}`, body: { text: SAMPLE, title: "mine", save: true }, e })).status, 200);
  assert.equal((await call("/api/history", { cookie: `sid=${sid2}`, e })).data.items.length, 1);

  // wrong password / unknown email get the same answer
  const bad = await post("/api/auth/login", { email: "ada@example.com", password: "wrong wrong wrong" });
  const unknown = await post("/api/auth/login", { email: "nobody@example.com", password: "wrong wrong wrong" });
  assert.equal(bad.status, 401);
  assert.deepEqual(unknown.data, bad.data);
  assert.equal(sidOf(bad), undefined);

  // a Google account with the same email is a different account (no merge by email)
  await env.DB.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('g1', 'ada@example.com', 'Google Ada', ?)").bind(Date.now()).run();
  await env.DB.prepare("INSERT INTO identities (provider, provider_user_id, user_id) VALUES ('google', 'sub-1', 'g1')").run();
  assert.equal((await call("/api/history", { cookie: `sid=${sid2}`, e })).data.items.length, 1);
  assert.notEqual(
    (await env.DB.prepare("SELECT user_id FROM identities WHERE provider='email'").first()).user_id, "g1");

  // too many wrong guesses lock the email for a while, even with the right password
  for (let i = 0; i < 8; i++) await post("/api/auth/login", { email: "ada@example.com", password: `guess number ${i}` });
  const locked = await post("/api/auth/login", { email: "ada@example.com", password: "correct horse battery" });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.res.headers.get("Retry-After")) > 0);
  // once the window passes, it works again and the counter resets
  await env.DB.prepare("UPDATE auth_throttle SET reset_at = ? WHERE key LIKE 'e:%'").bind(Date.now() - 1).run();
  assert.equal((await post("/api/auth/login", { email: "ada@example.com", password: "correct horse battery" })).status, 200);
  assert.equal(await env.DB.prepare("SELECT 1 AS x FROM auth_throttle WHERE key = 'e:ada@example.com'").first(), null);

  // cross-origin writes are still refused
  assert.equal((await post("/api/auth/login", { email: "ada@example.com", password: "correct horse battery" },
    { headers: { Origin: "https://evil.example" } })).status, 403);

  // sign out
  await call("/auth/logout", { method: "POST", cookie: `sid=${sid2}`, e });
  assert.equal((await call("/api/me", { cookie: `sid=${sid2}`, e })).data.user, null);
}

// ---- brand reputation ranking ----
{
  const dkEnv = { ...env, DIGIKEY_CLIENT_ID: "dk-id", DIGIKEY_CLIENT_SECRET: "dk-secret" };
  const rita = await seedUser("rita", "rita-token");
  const put = (preferences) => call("/api/settings", { method: "PUT", cookie: rita, body: { preferences }, e: dkEnv });
  const mk = (mpn, maker, unit) => ({
    ManufacturerProductNumber: mpn, Manufacturer: { Name: maker }, Description: { ProductDescription: mpn },
    ProductUrl: `https://www.digikey.com/p/${mpn}`, QuantityAvailable: 9000,
    ProductVariations: [{ DigiKeyProductNumber: `${mpn}-ND`, PackageType: { Name: "Bulk" }, MinimumOrderQuantity: 1,
      QuantityAvailableforPackageType: 9000, StandardPricing: [{ BreakQuantity: 1, UnitPrice: unit }] }],
  });
  const realFetch = globalThis.fetch;
  const searches = [];
  globalThis.fetch = async (url, opts) => {
    url = String(url);
    if (url === "https://api.digikey.com/v1/oauth2/token") return Response.json({ access_token: "tok", expires_in: 599 });
    if (url === "https://api.digikey.com/products/v4/search/keyword") {
      const kw = JSON.parse(opts.body).Keywords;
      searches.push(kw);
      const products = [mk("T1", "Teapo Electronic", 0.05), mk("A1", "Acme Parts", 0.07), mk("Y1", "Yageo", 0.09)];
      // Panasonic only sells the axial one in this pretend catalogue
      if (kw.includes("AXIAL")) products.push(mk("P1", "Panasonic Electronic Components", 0.2), mk("N1", "Nichicon", 0.25));
      return Response.json({ Products: products });
    }
    throw new Error("unexpected fetch " + url);
  };
  const res = (value, extra = {}) => call("/api/pricing", { method: "POST", cookie: rita, e: dkEnv,
    body: { items: [{ component: "Resistor", value, quantity: 10 }], ...extra } });
  const mfrs = (r) => r.data.results[0].options.map((o) => o.manufacturer.split(" ")[0]);

  try {
    // no brand ranking: cheapest first (as before), at most 3, each tagged with its tier
    let r = await res("1.1 kΩ", { package: "tht" });
    assert.deepEqual(mfrs(r), ["Teapo", "Acme", "Yageo"]);
    assert.deepEqual(r.data.results[0].options.map((o) => o.tier), ["budget", "unrated", "standard"]);

    // prefer premium, then standard; Teapo and unknown makers are never offered
    await put({ brand: ["premium", "standard"] });
    searches.length = 0;
    r = await res("1.1 kΩ", { package: "tht" });
    assert.deepEqual(mfrs(r), ["Panasonic", "Nichicon", "Yageo"], "premium first, cheapest within a group");
    assert.deepEqual(searches, [], "same search: served from the cache, brand ranking is applied afterwards");
    assert.equal(r.data.results[0].options[0].total, 2);
    assert.equal(r.data.results[0].fellBack, undefined);

    // order matters: standard before premium, unrated allowed
    await put({ brand: ["standard", "premium", "unrated"] });
    r = await res("1.1 kΩ", { package: "tht" });
    assert.deepEqual(mfrs(r), ["Yageo", "Panasonic", "Nichicon", "Acme"]);

    // premium only, and this search has no premium part: next choice in the ranking is tried
    await put({ brand: ["premium"], mounting: ["smd", "tht"] });
    searches.length = 0;
    r = await res("2.2 kΩ", { package: "pref" });
    assert.equal(searches.length, 2, "first choice had no acceptable brand, so the next was searched");
    assert.match(searches[0], /0805/);
    assert.match(searches[1], /AXIAL/);
    assert.equal(r.data.results[0].fellBack, true);
    assert.match(r.data.results[0].note, /from your preferred brands/);
    assert.deepEqual(mfrs(r), ["Panasonic", "Nichicon"]);

    // nothing acceptable anywhere: no match, not an error, and no more than 3 tries
    await put({ brand: ["budget"], mounting: ["smd", "tht"] });
    r = await res("3.3 kΩ", { package: "pref" });
    assert.deepEqual(mfrs(r), ["Teapo"], "budget makers allowed when the user lists them");
    await put({ brand: ["premium"], mounting: ["smd"] });
    searches.length = 0;
    r = await res("4.3 kΩ", { package: "pref" });
    assert.deepEqual(r.data.results[0].options, []);
    assert.equal(r.data.results[0].error, undefined);
    assert.equal(searches.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- common-value alternatives ----
{
  const circuit = `$ 1 0.000005 10.2 50 5 50 5e-11
r 0 0 64 0 0 4990
r 64 0 128 0 0 4990
r 128 0 192 0 0 1000
c 0 64 64 64 0 6.5e-8 0 0.001
c 0 128 64 128 0 0.000001 0
v 0 0 0 64 0 0 40 5 0 0 0.5
`;
  const post = (body) => call("/api/networks", { method: "POST", body });
  const ok = await post({ text: circuit });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.items.map((i) => i.value).sort(), ["4.99 kΩ", "65 nF"]);
  const res = ok.data.items.find((i) => i.value === "4.99 kΩ");
  assert.equal(res.quantity, 2);
  assert.equal(res.options[0].totalParts, 4);
  assert.equal(ok.data.standardCount, 2);
  // no login needed, and nothing is saved
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM queries WHERE title LIKE '%networks%'").first()).n, 0);
  // settings
  const fine = await post({ text: circuit, resistorSeries: "E96", capacitorSeries: "E24", tolerance: 0.5 });
  assert.deepEqual(fine.data.items.map((i) => i.value), ["65 nF"]);
  assert.equal(fine.data.settings.tolerance, 0.5);
  // validation
  assert.equal((await post({ text: circuit, resistorSeries: "E3" })).status, 400);
  assert.equal((await post({ text: circuit, tolerance: 50 })).status, 400);
  assert.equal((await post({ text: circuit, tolerance: "abc" })).status, 400);
  assert.equal((await post({ text: "" })).status, 400);
  assert.equal((await post({ text: "not a circuit" })).status, 422);
  assert.equal((await post({ text: "x".repeat(2_000_000) })).status, 413);
  assert.equal((await call("/api/networks", { method: "POST", body: undefined })).status, 400);
  assert.equal((await call("/api/networks")).status, 404, "GET is not a route");
  assert.equal((await call("/api/networks", { method: "POST", body: { text: circuit }, headers: { Origin: "https://evil.example" } })).status, 403);
}

// ---- ranked part-type preferences ----
{
  const dkEnv = { ...env, DIGIKEY_CLIENT_ID: "dk-id", DIGIKEY_CLIENT_SECRET: "dk-secret" };
  const put = (cookie, preferences, extra = {}) => call("/api/settings", { method: "PUT", cookie, body: { preferences }, e: dkEnv, ...extra });
  const getS = (cookie) => call("/api/settings", { cookie, e: dkEnv });
  const pat = await seedUser("pat", "pat-token");
  const quinn = await seedUser("quinn", "quinn-token");

  // access
  assert.equal((await call("/api/settings", { e: dkEnv })).status, 401);
  assert.equal((await call("/api/settings", { method: "PUT", body: { preferences: {} }, e: dkEnv })).status, 401);
  assert.equal((await call("/api/settings", { method: "DELETE", cookie: pat, e: dkEnv })).status, 405);

  // nothing saved yet: no preferences, and the catalog the page needs to draw its lists
  const empty = await getS(pat);
  assert.equal(empty.status, 200);
  assert.equal(empty.data.preferences, null);
  assert.deepEqual(Object.keys(empty.data.catalog), ["mounting", "capacitor", "resistor", "brand"]);
  assert.deepEqual(empty.data.catalog.brand.items.map((i) => i.id), ["premium", "standard", "budget", "unrated"]);
  assert.deepEqual(empty.data.catalog.mounting.items.map((i) => i.id), ["smd", "tht"]);
  assert.equal((await call("/api/me", { cookie: pat, e: dkEnv })).data.hasPreferences, false);

  // validation
  assert.equal((await put(pat, "nope")).status, 400);
  assert.equal((await put(pat, [])).status, 400);
  assert.equal((await put(pat, { colour: ["red"] })).status, 400);
  assert.equal((await put(pat, { mounting: "smd" })).status, 400);
  assert.equal((await put(pat, { mounting: ["smd", "dip"] })).status, 400);
  assert.equal((await put(pat, { mounting: ["smd", "smd"] })).status, 400);
  assert.equal((await put(pat, { capacitor: ["ceramic", 7] })).status, 400);
  assert.equal((await call("/api/settings", { method: "PUT", cookie: pat, e: dkEnv, body: "not json" })).status, 400);
  assert.equal((await put(pat, { mounting: ["smd"] }, { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await getS(pat)).data.preferences, null, "failed saves change nothing");

  // save, read back, per-user
  const saved = await put(pat, { mounting: ["smd", "tht"], capacitor: ["aluminum", "ceramic"], resistor: [] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.preferences, { mounting: ["smd", "tht"], capacitor: ["aluminum", "ceramic"] }, "empty lists are dropped");
  assert.deepEqual((await getS(pat)).data.preferences, saved.data.preferences);
  assert.equal((await call("/api/me", { cookie: pat, e: dkEnv })).data.hasPreferences, true);
  assert.equal((await getS(quinn)).data.preferences, null, "other users are unaffected");
  assert.equal((await put(pat, { mounting: ["tht"], capacitor: ["aluminum", "ceramic"] })).data.preferences.mounting[0], "tht", "saving again replaces");
  await put(pat, { mounting: ["smd", "tht"], capacitor: ["aluminum", "ceramic"] });

  // ---- price lookups follow the ranking ----
  const mk = (mpn) => ({
    ManufacturerProductNumber: mpn, Manufacturer: { Name: "Acme" }, Description: { ProductDescription: mpn },
    ProductUrl: `https://www.digikey.com/p/${mpn}`, QuantityAvailable: 5000,
    ProductVariations: [{ DigiKeyProductNumber: `${mpn}-ND`, PackageType: { Name: "Cut Tape (CT)" }, MinimumOrderQuantity: 1,
      QuantityAvailableforPackageType: 5000, StandardPricing: [{ BreakQuantity: 1, UnitPrice: 0.1 }] }],
  });
  const realFetch = globalThis.fetch;
  const searches = [];
  let empties = []; // searches containing any of these words find nothing
  globalThis.fetch = async (url, opts) => {
    url = String(url);
    if (url === "https://api.digikey.com/v1/oauth2/token") return Response.json({ access_token: "tok", expires_in: 599 });
    if (url === "https://api.digikey.com/products/v4/search/keyword") {
      const kw = JSON.parse(opts.body).Keywords;
      searches.push(kw);
      return Response.json({ Products: empties.some((w) => kw.includes(w)) ? [] : [mk("P-" + kw.replace(/\W+/g, "").slice(0, 12))] });
    }
    throw new Error("unexpected fetch " + url);
  };
  const price = (cookie, items, extra = {}) => call("/api/pricing", { method: "POST", cookie, e: dkEnv, body: { items, ...extra } });
  const cap = (value, query) => ({ component: "Capacitor", value, details: "", quantity: 2, ...(query ? { query } : {}) });

  try {
    // first choice has stock: one search only, and it is the top-ranked type in the top-ranked mounting style
    let r = await price(pat, [cap("10 µF")], { package: "pref" });
    assert.deepEqual(searches, ["CAP ALUM 10UF 25V SMD"]);
    assert.equal(r.data.results[0].query, "CAP ALUM 10UF 25V SMD");
    assert.equal(r.data.results[0].fellBack, undefined);

    // nothing matches the first choice: fall back to the next type, with an explanation
    searches.length = 0; empties = ["ALUM"];
    r = await price(pat, [cap("22 µF")], { package: "pref" });
    assert.deepEqual(searches, ["CAP ALUM 22UF 25V SMD", "CAP CER 22UF 25V 0805"]);
    assert.equal(r.data.results[0].query, "CAP CER 22UF 25V 0805");
    assert.equal(r.data.results[0].fellBack, true);
    assert.match(r.data.results[0].note, /Nothing acceptable \(in stock\) matched "CAP ALUM 22UF 25V SMD"/);
    assert.equal(r.data.results[0].options.length, 1);

    // types you left out are never searched; mounting falls back after types; at most 3 searches per line
    searches.length = 0; empties = ["ALUM", "CER"];
    r = await price(pat, [cap("33 µF")], { package: "pref" });
    assert.deepEqual(searches, ["CAP ALUM 33UF 25V SMD", "CAP CER 33UF 25V 0805", "CAP ALUM 33UF 25V RADIAL"]);
    assert.ok(searches.every((q) => !/FILM|TANT/.test(q)));
    assert.deepEqual(r.data.results[0].options, [], "still nothing: shown as no match, not an error");
    assert.equal(r.data.results[0].error, undefined);

    // an explicit mounting choice overrides the ranking's mounting, but type preferences still apply
    searches.length = 0; empties = [];
    await price(pat, [cap("47 µF")], { package: "tht" });
    assert.deepEqual(searches, ["CAP ALUM 47UF 25V RADIAL"]);

    // results are cached per search, so repeating the lookup spends nothing
    searches.length = 0;
    await price(pat, [cap("47 µF")], { package: "tht" });
    assert.deepEqual(searches, []);

    // a typed-in search is never rewritten or retried
    searches.length = 0; empties = ["MYSEARCH"];
    r = await price(pat, [cap("10 µF", "mysearch 1")], { package: "pref" });
    assert.deepEqual(searches, ["mysearch 1"]);

    // someone with no saved preferences gets the old behaviour, even with "pref" selected
    searches.length = 0; empties = [];
    await price(quinn, [{ component: "Resistor", value: "12 kΩ", quantity: 1 }, cap("10 µF")], { package: "pref" });
    assert.deepEqual(searches.sort(), ["CAP ALUM 10UF 25V RADIAL", "RES 12K OHM 1/4W AXIAL"], "through-hole, generic types");

    // resistor types
    await put(quinn, { mounting: ["tht"], resistor: ["metal_film", "carbon_film"] });
    searches.length = 0;
    await price(quinn, [{ component: "Resistor", value: "15 kΩ", quantity: 1 }], { package: "pref" });
    assert.deepEqual(searches, ["RES 15K OHM 1/4W AXIAL METAL FILM"]);

    // parts without a type preference follow the mounting ranking (an LED is a through-hole part for quinn)
    searches.length = 0;
    await price(quinn, [{ component: "LED", value: "", quantity: 1 }], { package: "pref" });
    assert.deepEqual(searches, ["LED 5MM THROUGH HOLE"]);

    // clearing everything removes the saved row
    assert.equal((await put(quinn, {})).data.preferences, null);
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM user_settings WHERE user_id = 'quinn'").first()).n, 0);
    assert.equal((await call("/api/me", { cookie: quinn, e: dkEnv })).data.hasPreferences, false);
  } finally {
    globalThis.fetch = realFetch;
  }

  // a deleted user takes their settings with them
  await env.DB.prepare("DELETE FROM users WHERE id = 'pat'").run();
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM user_settings WHERE user_id = 'pat'").first()).n, 0);
}

console.log("api tests passed");
