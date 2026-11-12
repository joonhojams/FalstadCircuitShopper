import { bom } from "./parser.js";
import { login, callback, logout, getUser, authConfigured } from "./auth.js";
import { register, signIn } from "./password.js";
import { analyse, SERIES } from "./networks.js";
import { CATALOG, validatePreferences, loadPreferences, savePreferences } from "./preferences.js";
import { candidates } from "./queries.js";
import { cheapestOptions } from "./pricing.js";
import { DigiKeyError, digikeyConfigured, getToken, searchKeyword } from "./digikey.js";
import {
  NotConnectedError, connectLogin, connectCallback, isConnected, ordersConfigured, removeLink, userFetch,
} from "./digikey-link.js";
import { normalizeOrders, normalizeSalesOrder } from "./orders.js";

const MAX_TEXT = 500_000;   // characters per circuit
const MAX_HISTORY = 200;    // saved queries kept per user

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { pathname } = url;

    try {
      // CSRF defence in depth (cookies are also SameSite=Lax): reject cross-origin writes.
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const origin = req.headers.get("Origin");
        if (origin && origin !== url.origin) return json({ error: "Cross-origin request blocked" }, 403);
      }

      // ----- auth -----
      if (pathname === "/auth/login" && req.method === "GET") return login(req, env);
      if (pathname === "/auth/callback" && req.method === "GET") return callback(req, env);
      if (pathname === "/auth/logout" && req.method === "POST") return logout(req, env);
      if (pathname === "/api/auth/register" && req.method === "POST") return register(req, env);
      if (pathname === "/api/auth/login" && req.method === "POST") return signIn(req, env);
      if (pathname === "/auth/digikey/signin" && req.method === "GET") return connectLogin(req, env, "signin");

      // ----- API -----
      if (pathname === "/api/me" && req.method === "GET") {
        const user = await getUser(req, env);
        return json({
          authConfigured: authConfigured(env), // Google
          methods: { google: authConfigured(env), email: true, digikey: ordersConfigured(env) },
          pricing: digikeyConfigured(env),
          orders: {
            configured: ordersConfigured(env),
            connected: user && ordersConfigured(env) ? await isConnected(env, user.id) : false,
          },
          hasPreferences: user ? Boolean(await loadPreferences(env, user.id)) : false,
          user: user &&{ name: user.name, email: user.email, picture: user.picture },
        });
      }

      if (pathname === "/api/bom" && req.method === "POST") return handleBom(req, env);
      if (pathname === "/api/pricing" && req.method === "POST") return handlePricing(req, env);
      if (pathname === "/api/networks" && req.method === "POST") return handleNetworks(req);
      if (pathname === "/api/settings") return handleSettings(req, env);

      // ----- DigiKey order history (each user connects their own DigiKey account) -----
      if (pathname === "/auth/digikey/login" && req.method === "GET") return connectLogin(req, env);
      if (pathname === "/auth/digikey/callback" && req.method === "GET") return connectCallback(req, env);
      if (pathname === "/auth/digikey/disconnect" && req.method === "POST") {
        const user = await getUser(req, env);
        if (!user) return json({ error: "Sign in required" }, 401);
        await removeLink(env, user.id);
        return json({ ok: true });
      }
      if (pathname === "/api/orders" && req.method === "GET") return handleOrders(req, env, url);
      const om = pathname.match(/^\/api\/orders\/(\d{1,10})$/);
      if (om && req.method === "GET") return handleOrder(req, env, Number(om[1]));

      if (pathname === "/api/history" && req.method === "GET") {
        const user = await getUser(req, env);
        if (!user) return json({ error: "Sign in required" }, 401);
        const { results } = await env.DB
          .prepare(`SELECT id, title, part_count, created_at FROM queries
                    WHERE user_id = ? ORDER BY id DESC LIMIT 100`)
          .bind(user.id).all();
        return json({ items: results });
      }

      const m = pathname.match(/^\/api\/history\/(\d+)$/);
      if (m) {
        const user = await getUser(req, env);
        if (!user) return json({ error: "Sign in required" }, 401);
        const id = Number(m[1]);

        if (req.method === "GET") {
          const row = await env.DB
            .prepare(`SELECT id, title, circuit_text, created_at FROM queries
                      WHERE id = ? AND user_id = ?`)
            .bind(id, user.id).first();
          if (!row) return json({ error: "Not found" }, 404);
          return json({ id: row.id, title: row.title, created_at: row.created_at,
                        text: row.circuit_text, ...bom(row.circuit_text) });
        }
        if (req.method === "DELETE") {
          const r = await env.DB.prepare("DELETE FROM queries WHERE id = ? AND user_id = ?")
            .bind(id, user.id).run();
          return r.meta.changes ? json({ ok: true }) : json({ error: "Not found" }, 404);
        }
        return json({ error: "Method not allowed" }, 405);
      }

      if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) {
        return json({ error: "Not found" }, 404);
      }

      // Anything else: static front end.
      return env.ASSETS.fetch(req);
    } catch (err) {
      console.error(err);
      return json({ error: "Internal error" }, 500);
    }
  },
};

// ---------- DigiKey order history ----------

const clampInt = (v, min, max, dflt) => {
  if (v === null || v === undefined || v === "") return dflt; // Number(null) is 0, not "missing"
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

// Orders are never stored here: each request goes to DigiKey with the signed-in user's own token.
async function ordersGate(req, env) {
  const user = await getUser(req, env);
  if (!user) return { res: json({ error: "Sign in required" }, 401) };
  if (!ordersConfigured(env)) return { res: json({ error: "DigiKey order history is not configured on this server." }, 503) };
  return { user };
}

function orderError(e) {
  if (e instanceof NotConnectedError) return json({ error: "Connect your DigiKey account first.", notConnected: true }, 409);
  if (e instanceof DigiKeyError) {
    const status = [400, 403, 404, 429].includes(e.status) ? e.status : 502;
    return json({ error: e.message, retryAfter: e.retryAfter ?? undefined }, status);
  }
  throw e;
}

async function handleOrders(req, env, url) {
  const { user, res } = await ordersGate(req, env);
  if (res) return res;

  const q = url.searchParams;
  const day = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  const start = q.get("start") ?? day(new Date(now.getTime() - 30 * 86_400_000));
  const end = q.get("end") ?? day(now);
  const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  if (!validDate(start) || !validDate(end)) return json({ error: "Dates must look like 2026-11-04" }, 400);
  if (start > end) return json({ error: "The start date is after the end date" }, 400);

  const page = clampInt(q.get("page"), 1, 1000, 1);
  const pageSize = clampInt(q.get("pageSize"), 1, 25, 25); // DigiKey's maximum is 25
  const shared = q.get("shared") === "true";

  try {
    const data = await userFetch(env, user.id, "/orderstatus/v4/orders", {
      StartDate: start, EndDate: end, PageNumber: page, PageSize: pageSize, Shared: shared,
    });
    return json({ start, end, page, pageSize, shared, ...normalizeOrders(data) });
  } catch (e) {
    return orderError(e);
  }
}

async function handleOrder(req, env, salesOrderId) {
  const { user, res } = await ordersGate(req, env);
  if (res) return res;
  try {
    const data = await userFetch(env, user.id, `/orderstatus/v4/salesorder/${salesOrderId}`);
    return json(normalizeSalesOrder(data));
  } catch (e) {
    return orderError(e);
  }
}

const PRICING = {
  maxSearches: 40,              // DigiKey requests per call, fallbacks included (Workers Free allows 50 subrequests)
  maxTries: 3, // searches per line at most: the first choice plus up to two fallbacks from the user's ranking
  maxItems: 40,                 // BOM lines per request (also keeps us under the Workers Free subrequest cap)
  dailyLookups: 900,            // DigiKey allows 1,000 requests/day per app; keep headroom
  cacheMs: 60 * 60 * 1000,      // how long a result is reused
  concurrency: 4,
};

// Signed-in users only: every lookup spends the app's shared DigiKey quota.
async function handlePricing(req, env) {
  const user = await getUser(req, env);
  if (!user) return json({ error: "Sign in required" }, 401);
  if (!digikeyConfigured(env)) return json({ error: "DigiKey price lookup is not configured on this server." }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const items = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) return json({ error: "No items provided" }, 400);
  if (items.length > PRICING.maxItems) return json({ error: `Too many lines (max ${PRICING.maxItems})` }, 413);

  // "pref" means: use the user's own ranking (saved on the server, never taken from the request).
  const prefs = (await loadPreferences(env, user.id)) ?? {};
  const mode = ["tht", "smd", "any", "pref"].includes(body.package) ? body.package : "tht";
  const mounts = mode === "pref" ? (prefs.mounting?.length ? prefs.mounting : ["tht"]) : [mode];
  const inStock = body.inStock !== false;
  const boards = Math.min(1000, Math.max(1, Math.floor(Number(body.boards)) || 1));
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");

  // 1. Decide what to search for on each line: the best choice first, then fallbacks in ranked order.
  const plan = items.map((it) => {
    const qty = Math.floor(Number(it?.quantity));
    if (!(qty >= 1)) return { error: "Invalid quantity" };
    const needQty = Math.min(1_000_000, qty * boards);
    const override = str(it?.query, 250).trim();
    const options = override
      ? [{ query: override }]
      : candidates({ component: str(it?.component, 60), value: str(it?.value, 60), details: str(it?.details, 120) }, mounts, prefs, PRICING.maxTries);
    const first = options[0] ?? { query: null, note: "No automatic search for this part. Type a search in the box and press Enter." };
    if (first.skip) return { skipped: first.skip, needQty };
    if (!first.query) return { query: "", note: first.note, needQty };
    return { candidates: options.filter((c) => c.query), idx: 0, query: first.query, assumed: Boolean(first.assumed), note: first.note ?? "", needQty };
  });
  const keyOf = (p) => `${p.query.toLowerCase()}|${p.needQty}|${inStock ? 1 : 0}`;

  // One pass over some lines: reuse cached results, respect the daily budget, ask DigiKey for the rest.
  // Returns a Response only for a failure that ends the whole request.
  let fetched = 0; // DigiKey searches made so far in this request
  const runPass = async (lines) => {
    // Reuse recent results (one query for all lines).
    const keys = [...new Set(lines.map(keyOf))];
    if (keys.length) {
      const { results } = await env.DB
        .prepare(`SELECT cache_key, result FROM pricing_cache
                  WHERE fetched_at > ? AND cache_key IN (${keys.map(() => "?").join(",")})`)
        .bind(Date.now() - PRICING.cacheMs, ...keys).all();
      const hit = new Map(results.map((r) => [r.cache_key, r.result]));
      for (const p of lines) {
        const h = hit.get(keyOf(p));
        if (h) { p.options = JSON.parse(h); p.cached = true; }
      }
    }

    // Check the daily budget for the lookups that still need DigiKey.
    const misses = lines.filter((p) => !p.cached);
    let runnable = misses;
    if (misses.length) {
      const day = new Date().toISOString().slice(0, 10);
      const used = (await env.DB.prepare("SELECT count FROM api_usage WHERE day = ?").bind(day).first())?.count ?? 0;
      const allowed = Math.max(0, PRICING.dailyLookups - used);
      runnable = misses.slice(0, allowed);
      for (const p of misses.slice(allowed)) p.error = "Daily DigiKey lookup limit reached. Try again tomorrow.";
      if (runnable.length) {
        await env.DB
          .prepare("INSERT INTO api_usage (day, count) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET count = count + excluded.count")
          .bind(day, runnable.length).run();
      }
    }
    if (!runnable.length) return null;
    fetched += runnable.length;

    // Search DigiKey, a few at a time.
    try { await getToken(env); } catch (e) {
      if (e instanceof DigiKeyError) return json({ error: e.message }, e.status === 429 ? 429 : 502);
      throw e;
    }
    let limited = null;
    const queue = [...runnable];
    const worker = async () => {
      for (let p; (p = queue.shift()); ) {
        if (limited) { p.error = "DigiKey rate limit reached. Try again in a minute."; continue; }
        try {
          const products = await searchKeyword(env, p.query, { minQty: p.needQty, inStock });
          p.options = cheapestOptions(products, p.needQty, { inStock });
          p.fresh = true;
        } catch (e) {
          if (e instanceof DigiKeyError) {
            if (e.status === 429) limited = e;
            p.error = e.status === 429 ? "DigiKey rate limit reached. Try again in a minute." : e.message;
          } else {
            console.error(e);
            p.error = "Lookup failed";
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PRICING.concurrency, queue.length) }, worker));

    // Remember what we fetched (a few multi-row inserts, since D1 limits queries per request).
    const rows = [...new Map(runnable.filter((p) => p.fresh).map((p) => [keyOf(p), JSON.stringify(p.options)]))];
    const now = Date.now();
    for (let i = 0; i < rows.length; i += 30) {
      const chunk = rows.slice(i, i + 30);
      await env.DB
        .prepare(`INSERT OR REPLACE INTO pricing_cache (cache_key, result, fetched_at)
                  VALUES ${chunk.map(() => "(?,?,?)").join(",")}`)
        .bind(...chunk.flatMap(([k, v]) => [k, v, now])).run();
    }
    if (rows.length) {
      await env.DB.prepare("DELETE FROM pricing_cache WHERE fetched_at < ?").bind(now - PRICING.cacheMs).run();
    }
    return null;
  };

  let lines = plan.filter((p) => p.query);
  for (let round = 0; round < PRICING.maxTries && lines.length; round++) {
    const failed = await runPass(lines);
    if (failed) return failed;
    // Lines that found nothing move on to the next choice in the user's ranking.
    lines = lines.filter((p) => !p.error && p.options && p.options.length === 0 && p.idx + 1 < p.candidates.length);
    lines = lines.slice(0, Math.max(0, PRICING.maxSearches - fetched));
    for (const p of lines) {
      const next = p.candidates[++p.idx];
      p.tried = [...(p.tried ?? []), p.query];
      p.query = next.query;
      p.assumed = Boolean(next.assumed);
      p.note = [next.note, `Nothing matched ${p.tried.map((q) => `"${q}"`).join(", ")}, so this is the next choice in your ranking.`].filter(Boolean).join(" ");
      p.options = undefined; p.cached = undefined; p.fresh = undefined;
    }
  }

  return json({
    currency: "USD",
    boards,
    results: plan.map((p) => ({
      query: p.query ?? "",
      assumed: Boolean(p.assumed),
      note: p.note ?? "",
      needQty: p.needQty,
      skipped: p.skipped,
      error: p.error,
      options: p.options,
      cached: p.cached ? true : undefined,
      fellBack: p.tried?.length ? true : undefined,
    })),
  });
}

// Ranked part-type preferences (GET to read, PUT to save). Signed-in users only.
async function handleSettings(req, env) {
  if (req.method !== "GET" && req.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  const user = await getUser(req, env);
  if (!user) return json({ error: "Sign in required" }, 401);

  if (req.method === "PUT") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    const checked = validatePreferences(body?.preferences);
    if (!checked.ok) return json({ error: checked.error }, 400);
    try {
      await savePreferences(env, user.id, checked.value);
    } catch (e) {
      console.error(e);
      return json({ error: "Settings can't be saved yet. The database needs updating (npm run db:init:remote)." }, 503);
    }
  }
  return json({ preferences: await loadPreferences(env, user.id), catalog: CATALOG });
}

// Suggest series/parallel networks of common values for resistors and capacitors that aren't
// in a standard E-series. Pure computation: no login, database or DigiKey needed.
async function handleNetworks(req) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) return json({ error: "No circuit text provided" }, 400);
  if (text.length > MAX_TEXT) return json({ error: "Circuit is too large" }, 413);

  const series = (v, dflt) => (v === undefined || v === null || v === "" ? dflt : SERIES.includes(v) ? v : null);
  const resistorSeries = series(body.resistorSeries, "E24");
  const capacitorSeries = series(body.capacitorSeries, "E12");
  if (!resistorSeries || !capacitorSeries) return json({ error: `Series must be one of ${SERIES.join(", ")}` }, 400);
  const tolerance = body.tolerance === undefined || body.tolerance === null || body.tolerance === "" ? 1 : Number(body.tolerance);
  if (!Number.isFinite(tolerance) || tolerance < 0.1 || tolerance > 10) {
    return json({ error: "Tolerance must be between 0.1 and 10 percent" }, 400);
  }

  const result = bom(text);
  if (result.count === 0) return json({ error: "No components found. Is this a CircuitJS \"Export As Text\" file?" }, 422);
  return json(analyse(result.summary, { resistorSeries, capacitorSeries, tolerance }));
}

async function handleBom(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) return json({ error: "No circuit text provided" }, 400);
  if (text.length > MAX_TEXT) return json({ error: "Circuit is too large" }, 413);

  const result = bom(text);
  if (result.count === 0) {
    return json({ error: "No components found. Is this a CircuitJS \"Export As Text\" file?" }, 422);
  }

  // Anonymous users get results; signed-in users also get them saved to history.
  const user = await getUser(req, env);
  let id = null;
  if (user && body.save !== false) {
    const last = await env.DB
      .prepare("SELECT id, circuit_text FROM queries WHERE user_id = ? ORDER BY id DESC LIMIT 1")
      .bind(user.id).first();
    if (last && last.circuit_text === text) {
      id = last.id; // identical to the most recent entry: don't duplicate
    } else {
      const title = typeof body.title === "string" && body.title.trim()
        ? body.title.trim().slice(0, 120)
        : `${result.count} parts`;
      const r = await env.DB
        .prepare(`INSERT INTO queries (user_id, title, circuit_text, part_count, created_at)
                  VALUES (?, ?, ?, ?, ?)`)
        .bind(user.id, title, text, result.count, Date.now()).run();
      id = r.meta.last_row_id;
      await env.DB
        .prepare(`DELETE FROM queries WHERE user_id = ?1 AND id NOT IN
                  (SELECT id FROM queries WHERE user_id = ?1 ORDER BY id DESC LIMIT ?2)`)
        .bind(user.id, MAX_HISTORY).run();
    }
  }

  return json({ id, saved: id !== null, ...result });
}
