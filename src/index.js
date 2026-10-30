import { bom } from "./parser.js";
import { login, callback, logout, getUser, authConfigured } from "./auth.js";

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

      // ----- API -----
      if (pathname === "/api/me" && req.method === "GET") {
        const user = await getUser(req, env);
        return json({
          authConfigured: authConfigured(env),
          user: user && { name: user.name, email: user.email, picture: user.picture },
        });
      }

      if (pathname === "/api/bom" && req.method === "POST") return handleBom(req, env);

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
