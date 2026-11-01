-- Physical sticker units: 1000. Each sold pack Q = 3 physical stickers.
CREATE TABLE IF NOT EXISTS inventory (
  sku TEXT PRIMARY KEY,
  available INTEGER NOT NULL CHECK (available >= 0)
);
INSERT INTO inventory (sku, available) VALUES ('Q', 1000) ON CONFLICT(sku) DO NOTHING;
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  qty INTEGER NOT NULL CHECK (qty >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved','paid','released')),
  session_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reservations_expiry ON reservations(status,expires_at);
