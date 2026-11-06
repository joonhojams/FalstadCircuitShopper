// Google OAuth 2.0 (authorization-code flow) + cookie sessions stored in D1.
// No dependencies. To add another provider (GitHub, Microsoft...), add a
// login/callback pair that ends in createSession(), and store its ids in `identities`.

const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---------- small helpers ----------

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.get("Cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) {
      try { out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1)); } catch { /* skip bad cookie */ }
    }
  }
  return out;
}

export function cookie(name, value, { maxAge, secure }) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const page = (msg, status) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>Sign-in</title>
<body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<p>${msg}</p><p><a href="/">Back to the app</a></p></body>`,
  { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

export const authConfigured = (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

// ---------- session lookup ----------

/** Returns { id, email, name, picture } for the signed-in user, or null. */
export async function getUser(req, env) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  return await env.DB
    .prepare(`SELECT u.id, u.email, u.name, u.picture
              FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(await sha256Hex(sid), Date.now())
    .first();
}

async function createSession(env, userId) {
  const token = randomToken(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await sha256Hex(token), userId, Date.now() + SESSION_MS),
  ]);
  return token;
}

/** Start a session for userId and return the Set-Cookie value for it. Shared by every sign-in method. */
export async function sessionCookie(env, userId, secure) {
  return cookie("sid", await createSession(env, userId), { maxAge: SESSION_MS / 1000, secure });
}

// ---------- routes ----------

export async function login(req, env) {
  if (!authConfigured(env)) return page("Sign-in is not configured on this server.", 503);
  const url = new URL(req.url);
  const secure = url.protocol === "https:";
  const state = randomToken(16);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      "Set-Cookie": cookie("oauth_state", state, { maxAge: 600, secure }),
    },
  });
}

export async function callback(req, env) {
  if (!authConfigured(env)) return page("Sign-in is not configured on this server.", 503);
  const url = new URL(req.url);
  const secure = url.protocol === "https:";
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return page("Sign-in was cancelled.", 400);
  if (!code || !state || state !== parseCookies(req).oauth_state) {
    return page("Sign-in failed: invalid or expired state. Please try again.", 400);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return page("Sign-in failed while contacting Google.", 502);
  const tokens = await tokenRes.json();

  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoRes.ok) return page("Sign-in failed while reading your Google profile.", 502);
  const info = await infoRes.json();
  if (!info.sub || info.email_verified === false) return page("Your Google account email is not verified.", 403);

  // Find or create the user for this (provider, id) identity.
  let userId = (await env.DB
    .prepare("SELECT user_id FROM identities WHERE provider = 'google' AND provider_user_id = ?")
    .bind(info.sub).first())?.user_id;

  if (userId) {
    await env.DB.prepare("UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?")
      .bind(info.email ?? null, info.name ?? null, info.picture ?? null, userId).run();
  } else {
    userId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(userId, info.email ?? null, info.name ?? null, info.picture ?? null, Date.now()),
      env.DB.prepare("INSERT INTO identities (provider, provider_user_id, user_id) VALUES ('google', ?, ?)")
        .bind(info.sub, userId),
    ]);
  }

  const token = await createSession(env, userId);
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", cookie("sid", token, { maxAge: SESSION_MS / 1000, secure }));
  headers.append("Set-Cookie", cookie("oauth_state", "", { maxAge: 0, secure }));
  return new Response(null, { status: 302, headers });
}

export async function logout(req, env) {
  const secure = new URL(req.url).protocol === "https:";
  const sid = parseCookies(req).sid;
  if (sid) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(sid)).run();
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie("sid", "", { maxAge: 0, secure }),
    },
  });
}
