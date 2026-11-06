-- D1 (SQLite) schema. Apply with: npm run db:init:local / db:init:remote

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,           -- random UUID, independent of any login provider
  email      TEXT,
  name       TEXT,
  picture    TEXT,
  created_at INTEGER NOT NULL            -- epoch ms
);

-- One row per (provider, account). Adding GitHub/Microsoft/etc. later means
-- adding a login route and inserting rows here; nothing else changes.
CREATE TABLE IF NOT EXISTS identities (
  provider         TEXT NOT NULL,        -- e.g. 'google'
  provider_user_id TEXT NOT NULL,        -- the provider's stable user id ('sub' for Google)
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, provider_user_id)
);

-- Only a SHA-256 hash of the session token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL            -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- History of submitted circuits. The BOM is recomputed from circuit_text when
-- viewed, so parser improvements apply to old entries too.
CREATE TABLE IF NOT EXISTS queries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  circuit_text TEXT NOT NULL,
  part_count   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL          -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_queries_user ON queries(user_id, id DESC);

-- DigiKey price lookups. Short-lived cache so repeat lookups don't spend API quota.
CREATE TABLE IF NOT EXISTS pricing_cache (
  cache_key  TEXT PRIMARY KEY,           -- "<search>|<quantity>|<in-stock flag>"
  result     TEXT NOT NULL,              -- JSON array of options
  fetched_at INTEGER NOT NULL            -- epoch ms
);

-- Searches made per UTC day, to stay under DigiKey's daily request limit.
CREATE TABLE IF NOT EXISTS api_usage (
  day   TEXT PRIMARY KEY,                -- YYYY-MM-DD (UTC)
  count INTEGER NOT NULL
);

-- Each user's own DigiKey connection (3-legged OAuth). Tokens are AES-GCM encrypted
-- with the TOKEN_ENCRYPTION_KEY secret before they are stored.
CREATE TABLE IF NOT EXISTS digikey_links (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token       TEXT NOT NULL,      -- encrypted
  refresh_token      TEXT NOT NULL,      -- encrypted; DigiKey rotates it on every refresh
  access_expires_at  INTEGER NOT NULL,   -- epoch ms
  refresh_expires_at INTEGER NOT NULL,   -- epoch ms
  version            INTEGER NOT NULL DEFAULT 0,  -- bumped on every refresh (compare-and-swap)
  created_at         INTEGER NOT NULL
);

-- Email + password sign-in. The account itself is an identities row
-- (provider 'email', provider_user_id = lower-cased email); only the hash lives here.
CREATE TABLE IF NOT EXISTS passwords (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,              -- base64 PBKDF2-SHA256 output
  salt       TEXT NOT NULL,              -- base64, random per user
  iterations INTEGER NOT NULL            -- stored per row so the cost can be raised later
);

-- Failed sign-in counters (per email and per IP) to slow down password guessing.
CREATE TABLE IF NOT EXISTS auth_throttle (
  key      TEXT PRIMARY KEY,             -- "e:<email>" or "ip:<address>"
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL              -- epoch ms
);
