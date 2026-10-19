-- Persist only retry identity, never duplicate prompt text or image bytes here.
CREATE TABLE capture_requests (
  request_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
