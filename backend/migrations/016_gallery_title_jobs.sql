-- Gallery naming is independent of capture receipts. No credentials or image
-- bytes are persisted, and each durable Library item can be named at most once.
CREATE TABLE gallery_title_jobs (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  image_id TEXT REFERENCES images(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('disabled','pending','running','succeeded','failed','uncertain','skipped')),
  config_digest TEXT,
  snapshot TEXT,
  category TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_gallery_title_status ON gallery_title_jobs(status);
