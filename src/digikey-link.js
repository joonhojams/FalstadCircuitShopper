// Connects a signed-in user to their own DigiKey account (3-legged OAuth) and makes
// API calls on their behalf. Each user's tokens are stored encrypted in D1, so DigiKey
// itself decides what each person may see: there is no shared account.
//
// DigiKey rotates the refresh token on every refresh, so a refresh must save the new
// one. Concurrent requests are handled with a version column (compare-and-swap).

import { DigiKeyError, base } from "./digikey.js";
import { getUser, parseCookies, cookie, randomToken, page, sessionCookie } from "./auth.js";
import { encrypt, decrypt, encryptionConfigured } from "./crypto.js";

export class NotConnectedError extends Error {}

export const ordersConfigured = (env) =>
  Boolean(env.DIGIKEY_CLIENT_ID && env.DIGIKEY_CLIENT_SECRET && encryptionConfigured(env));

// DigiKey requires the redirect URI to match the one registered for the app exactly, over HTTPS.
const redirectUri = (env, url) => env.DIGIKEY_REDIRECT_URI || `${url.origin}/auth/digikey/callback`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

// ---------- token endpoint ----------

async function tokenRequest(env, fields) {
  const res = await fetch(`${base(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DIGIKEY_CLIENT_ID,
      client_secret: env.DIGIKEY_CLIENT_SECRET,
      ...fields,
    }),
  });
  if (res.status === 429) throw new DigiKeyError("DigiKey rate limit reached", 429, Number(res.headers.get("Retry-After")) || null);
  if (!res.ok) throw new DigiKeyError(`DigiKey token request failed (${res.status})`, res.status);
  const data = await res.json();
  if (!data.access_token || !data.refresh_token) throw new DigiKeyError("DigiKey returned no tokens", 502);
  return data;
}

// ---------- storage ----------

const readLink = (env, userId) =>
  env.DB.prepare("SELECT * FROM digikey_links WHERE user_id = ?").bind(userId).first();

export const removeLink = (env, userId) =>
  env.DB.prepare("DELETE FROM digikey_links WHERE user_id = ?").bind(userId).run();

/** True when the user has a link that hasn't expired. Never throws (the table may not exist yet). */
export async function isConnected(env, userId) {
  try {
    const row = await env.DB.prepare("SELECT refresh_expires_at FROM digikey_links WHERE user_id = ?").bind(userId).first();
    return Boolean(row && row.refresh_expires_at > Date.now());
  } catch (e) {
    console.error(e);
    return false;
  }
}

/** Insert/replace a link (casVersion null), or update only if nobody refreshed since we read it. */
async function saveTokens(env, userId, t, casVersion = null) {
  const now = Date.now();
  const access = await encrypt(env, t.access_token, `${userId}:access`);
  const refresh = await encrypt(env, t.refresh_token, `${userId}:refresh`);
  const accessExp = now + (Number(t.expires_in) || 1800) * 1000;
  const refreshExp = now + (Number(t.refresh_token_expires_in) || 90 * 86400) * 1000;

  if (casVersion === null) {
    await env.DB
      .prepare(`INSERT INTO digikey_links (user_id, access_token, refresh_token, access_expires_at, refresh_expires_at, version, created_at)
                VALUES (?, ?, ?, ?, ?, 0, ?)
                ON CONFLICT(user_id) DO UPDATE SET access_token = excluded.access_token,
                  refresh_token = excluded.refresh_token, access_expires_at = excluded.access_expires_at,
                  refresh_expires_at = excluded.refresh_expires_at, version = digikey_links.version + 1`)
      .bind(userId, access, refresh, accessExp, refreshExp, now).run();
    return true;
  }
  const r = await env.DB
    .prepare(`UPDATE digikey_links SET access_token = ?, refresh_token = ?, access_expires_at = ?,
                refresh_expires_at = ?, version = version + 1
              WHERE user_id = ? AND version = ?`)
    .bind(access, refresh, accessExp, refreshExp, userId, casVersion).run();
  return r.meta.changes > 0;
}

// ---------- using the link ----------

async function accessTokenFor(env, userId, { force = false } = {}) {
  const row = await readLink(env, userId);
  if (!row) throw new NotConnectedError();
  if (!force && row.access_expires_at > Date.now() + 60_000) return decrypt(env, row.access_token, `${userId}:access`);
  if (row.refresh_expires_at <= Date.now()) {
    await removeLink(env, userId);
    throw new NotConnectedError();
  }

  const refreshToken = await decrypt(env, row.refresh_token, `${userId}:refresh`);
  try {
    const t = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: refreshToken });
    await saveTokens(env, userId, t, row.version); // if another request got there first, theirs stays
    return t.access_token;
  } catch (e) {
    if (e instanceof DigiKeyError && (e.status === 400 || e.status === 401)) {
      // Either a concurrent request already rotated the refresh token, or the link is dead.
      await sleep(250);
      const again = await readLink(env, userId);
      if (!again) throw new NotConnectedError();
      if (again.version !== row.version && again.access_expires_at > Date.now() + 5_000) {
        return decrypt(env, again.access_token, `${userId}:access`);
      }
      await removeLink(env, userId); // revoked, secret reset, or expired: the user must reconnect
      throw new NotConnectedError();
    }
    throw e;
  }
}

/** GET a DigiKey API path as this user. Returns parsed JSON. */
export async function userFetch(env, userId, path, query = {}) {
  const url = new URL(`${base(env)}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessTokenFor(env, userId, { force: attempt > 0 });
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-DIGIKEY-Client-Id": env.DIGIKEY_CLIENT_ID,
        "X-DIGIKEY-Locale-Site": "US",
        "X-DIGIKEY-Locale-Language": "en",
        Accept: "application/json",
      },
    });
    if (res.status === 401 && attempt === 0) continue; // token rejected: refresh once and retry
    if (res.status === 429) throw new DigiKeyError("DigiKey rate limit reached", 429, Number(res.headers.get("Retry-After")) || null);
    if (res.status === 403) throw new DigiKeyError("DigiKey denied access. Make sure the Order Status API is added to your DigiKey app.", 403);
    if (res.status === 404) throw new DigiKeyError("Not found at DigiKey", 404);
    if (res.status === 400) {
      const body = await res.json().catch(() => null);
      const detail = String(body?.detail || body?.title || "").slice(0, 200);
      throw new DigiKeyError(`DigiKey rejected the request${detail ? `: ${detail}` : ""}`, 400);
    }
    if (!res.ok) throw new DigiKeyError(`DigiKey request failed (${res.status})`, 502);
    return res.json();
  }
  throw new DigiKeyError("DigiKey rejected the access token", 502);
}

// ---------- who is this DigiKey account? ----------

/** Look for a stable account id in the token response. DigiKey's docs don't promise one, so check likely fields. */
function idFromTokens(t) {
  for (const k of ["sub", "customer_id", "customerId", "account_id", "accountId"]) {
    if (t[k] !== undefined && t[k] !== null && String(t[k]).trim()) return String(t[k]).trim();
  }
  try {
    const part = String(t.id_token || "").split(".")[1];
    if (part) {
      const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
      if (claims.sub) return String(claims.sub);
    }
  } catch { /* not a JWT */ }
  return null;
}

/** Orders carry a CustomerId. Needs the Order Status API and at least one order in the window. */
async function idFromOrders(env, accessToken) {
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
  for (const days of [365, 90]) {
    try {
      const url = new URL(`${base(env)}/orderstatus/v4/orders`);
      url.searchParams.set("StartDate", ymd(Date.now() - days * DAY));
      url.searchParams.set("EndDate", ymd(Date.now()));
      url.searchParams.set("PageNumber", "1");
      url.searchParams.set("PageSize", "1");
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "X-DIGIKEY-Client-Id": env.DIGIKEY_CLIENT_ID,
          "X-DIGIKEY-Locale-Site": "US",
          "X-DIGIKEY-Locale-Language": "en",
          Accept: "application/json",
        },
      });
      if (!res.ok) continue; // e.g. the date window is too wide: try the narrower one
      const id = (await res.json())?.Orders?.[0]?.CustomerId;
      if (id !== undefined && id !== null && String(id).trim()) return String(id).trim();
      return null;
    } catch (e) {
      console.error(e);
    }
  }
  return null;
}

const digikeyIdentity = async (env, tokens) => idFromTokens(tokens) ?? (await idFromOrders(env, tokens.access_token));

const userForIdentity = async (env, id) =>
  (await env.DB.prepare("SELECT user_id FROM identities WHERE provider = 'digikey' AND provider_user_id = ?").bind(id).first())?.user_id;

// ---------- routes ----------

/** mode "link": connect DigiKey for the signed-in user. mode "signin": sign in with DigiKey. */
export async function connectLogin(req, env, mode = "link") {
  if (!ordersConfigured(env)) return page("DigiKey is not configured on this server.", 503);
  if (mode === "link" && !(await getUser(req, env))) {
    return page("Sign in first, then connect your DigiKey account.", 401);
  }

  const url = new URL(req.url);
  const state = `${mode}.${randomToken(16)}`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.DIGIKEY_CLIENT_ID,
    redirect_uri: redirectUri(env, url),
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${base(env)}/v1/oauth2/authorize?${params}`,
      "Set-Cookie": cookie("dk_state", state, { maxAge: 600, secure: url.protocol === "https:" }),
    },
  });
}

export async function connectCallback(req, env) {
  if (!ordersConfigured(env)) return page("DigiKey is not configured on this server.", 503);

  const url = new URL(req.url);
  const secure = url.protocol === "https:";
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return page("The DigiKey connection was cancelled.", 400);
  if (!code || !state || state !== parseCookies(req).dk_state) {
    return page("DigiKey connection failed: invalid or expired state. Please try again.", 400);
  }
  const mode = state.startsWith("signin.") ? "signin" : "link";

  let user = null;
  if (mode === "link") {
    user = await getUser(req, env);
    if (!user) return page("Your session expired. Sign in and try connecting DigiKey again.", 401);
  }

  let tokens;
  try {
    tokens = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri(env, url) });
  } catch (e) {
    console.error(e);
    return page("DigiKey connection failed while exchanging the authorization code. Check the redirect URI registered for your DigiKey app.", 502);
  }

  const headers = new Headers({ Location: "/?digikey=connected" });

  if (mode === "signin") {
    const id = await digikeyIdentity(env, tokens);
    if (!id) {
      return page("DigiKey did not tell this app which account you are, so it can't sign you in with DigiKey. " +
        "(This can happen if the account has no orders in the last year, or if the Order Status API isn't added to the app.) " +
        "Sign in with Google or email instead, then use Connect DigiKey account.", 403);
    }
    let userId = await userForIdentity(env, id);
    if (!userId) {
      userId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users (id, email, name, picture, created_at) VALUES (?, NULL, ?, NULL, ?)")
          .bind(userId, `DigiKey account ${id}`, Date.now()),
        env.DB.prepare("INSERT INTO identities (provider, provider_user_id, user_id) VALUES ('digikey', ?, ?)").bind(id, userId),
      ]);
    }
    await saveTokens(env, userId, tokens);
    headers.append("Set-Cookie", await sessionCookie(env, userId, secure));
  } else {
    await saveTokens(env, user.id, tokens);
    // Best effort: remember which DigiKey account this is so "Sign in with DigiKey" works later.
    // An account that already belongs to someone else is left alone.
    try {
      const id = await digikeyIdentity(env, tokens);
      if (id && !(await userForIdentity(env, id))) {
        await env.DB.prepare("INSERT OR IGNORE INTO identities (provider, provider_user_id, user_id) VALUES ('digikey', ?, ?)")
          .bind(id, user.id).run();
      }
    } catch (e) {
      console.error(e);
    }
  }

  headers.append("Set-Cookie", cookie("dk_state", "", { maxAge: 0, secure }));
  return new Response(null, { status: 302, headers });
}
