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
