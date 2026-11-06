// Email + password sign-in. Passwords are hashed with PBKDF2-SHA256 (WebCrypto) and a random
// per-user salt; only the hash is stored. Cloudflare Workers allows at most 100,000 PBKDF2
// iterations, so that is the default. The count is stored per user, so it can change later.
//
// Email addresses are NOT verified (there is no email service), and an email/password
// account is a separate account from a Google account with the same address. Accounts are
// never merged by email, so nobody can take over another person's account by typing their address.

import { sessionCookie } from "./auth.js";

const DEFAULT_ITERATIONS = 100_000;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const THROTTLE = { email: 8, ip: 40, windowMs: 15 * 60_000 };

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

export const normalizeEmail = (e) => String(e ?? "").trim().toLowerCase();
export const validEmail = (e) => e.length <= 254 && EMAIL_RE.test(e);

export async function hashPassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

function timingSafeEqual(a, b) {
  const x = new Uint8Array(a), y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const iterationsFor = (env) => {
  const n = Math.floor(Number(env.PASSWORD_ITERATIONS));
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, 100_000) : DEFAULT_ITERATIONS;
};

// ---------- throttling ----------

const clientIp = (req) => req.headers.get("CF-Connecting-IP") || "unknown";

async function blocked(env, keys) {
  const now = Date.now();
  for (const [key, limit] of keys) {
    const row = await env.DB.prepare("SELECT count, reset_at FROM auth_throttle WHERE key = ?").bind(key).first();
    if (row && row.reset_at > now && row.count >= limit) return Math.ceil((row.reset_at - now) / 1000);
  }
  return 0;
}

async function recordFailure(env, keys) {
  const now = Date.now();
  await env.DB.batch(keys.map(([key]) =>
    env.DB.prepare(`INSERT INTO auth_throttle (key, count, reset_at) VALUES (?, 1, ?)
                    ON CONFLICT(key) DO UPDATE SET
                      count = CASE WHEN auth_throttle.reset_at > ? THEN auth_throttle.count + 1 ELSE 1 END,
                      reset_at = CASE WHEN auth_throttle.reset_at > ? THEN auth_throttle.reset_at ELSE ? END`)
      .bind(key, now + THROTTLE.windowMs, now, now, now + THROTTLE.windowMs)));
}

const clearFailures = (env, key) => env.DB.prepare("DELETE FROM auth_throttle WHERE key = ?").bind(key).run();

// ---------- routes ----------

async function readBody(req) {
  try { return await req.json(); } catch { return null; }
}

export async function register(req, env) {
  const body = await readBody(req);
  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === "string" ? body.password : "";
  const name = String(body?.name ?? "").trim().slice(0, 80);
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
  if (password.length < MIN_PASSWORD) return json({ error: `Use a password of at least ${MIN_PASSWORD} characters.` }, 400);
  if (password.length > MAX_PASSWORD) return json({ error: `Use a password of at most ${MAX_PASSWORD} characters.` }, 400);

  const ipKey = [`ip:${clientIp(req)}`, THROTTLE.ip];
  const wait = await blocked(env, [ipKey]);
  if (wait) return json({ error: "Too many attempts. Try again later.", retryAfter: wait }, 429, { "Retry-After": String(wait) });

  const taken = await env.DB.prepare("SELECT 1 AS x FROM identities WHERE provider = 'email' AND provider_user_id = ?").bind(email).first();
  if (taken) return json({ error: "An account with that email already exists. Sign in instead." }, 409);

  const iterations = iterationsFor(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, salt, iterations);
  const userId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, name, picture, created_at) VALUES (?, ?, ?, NULL, ?)")
        .bind(userId, email, name || email.split("@")[0], Date.now()),
      env.DB.prepare("INSERT INTO identities (provider, provider_user_id, user_id) VALUES ('email', ?, ?)").bind(email, userId),
      env.DB.prepare("INSERT INTO passwords (user_id, hash, salt, iterations) VALUES (?, ?, ?, ?)")
        .bind(userId, b64(hash), b64(salt), iterations),
    ]);
  } catch {
    // A simultaneous registration for the same email hit the primary key.
    return json({ error: "An account with that email already exists. Sign in instead." }, 409);
  }
  // Registrations count against the IP limit so one address can't mass-create accounts.
  await recordFailure(env, [ipKey]);
  const secure = new URL(req.url).protocol === "https:";
  return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, userId, secure) });
}

export async function signIn(req, env) {
  const body = await readBody(req);
  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === "string" ? body.password.slice(0, MAX_PASSWORD + 1) : "";
  const fail = () => json({ error: "Incorrect email or password." }, 401);
  if (!email || !password || password.length > MAX_PASSWORD) return fail();

  const keys = [[`e:${email}`, THROTTLE.email], [`ip:${clientIp(req)}`, THROTTLE.ip]];
  const wait = await blocked(env, keys);
  if (wait) return json({ error: "Too many failed attempts. Try again later.", retryAfter: wait }, 429, { "Retry-After": String(wait) });

  const row = await env.DB
    .prepare(`SELECT p.user_id, p.hash, p.salt, p.iterations FROM identities i
              JOIN passwords p ON p.user_id = i.user_id
              WHERE i.provider = 'email' AND i.provider_user_id = ?`)
    .bind(email).first();

  // Always do one hash so an unknown email takes about as long as a wrong password.
  const salt = row ? unb64(row.salt) : new Uint8Array(16);
  const got = await hashPassword(password, salt, row ? row.iterations : iterationsFor(env));
  if (!row || !timingSafeEqual(got, unb64(row.hash))) {
    await recordFailure(env, keys);
    return fail();
  }
  await clearFailures(env, `e:${email}`);
  const secure = new URL(req.url).protocol === "https:";
  return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, row.user_id, secure) });
}
