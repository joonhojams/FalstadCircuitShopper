// Exercises the Worker (routing, BOM API, history, sessions, Google OAuth flow)
// directly in Node, with an in-memory SQLite database standing in for D1.
// Requires Node 22+ (node:sqlite). Does not need wrangler or network access.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { SAMPLE } from "./parser.test.mjs";

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
  assert.deepEqual(me.data, { authConfigured: false, user: null });

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

console.log("api tests passed");
