-- No credentials, prompt copies or image bytes are stored in this job ledger.
-- A disabled marker also prevents old capture replays from becoming paid jobs.
CREATE TABLE capture_organizer_jobs (
  request_id TEXT PRIMARY KEY REFERENCES capture_requests(request_id),
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('disabled','pending','running','succeeded','failed','uncertain','skipped')),
  config_digest TEXT,
  snapshot TEXT,
  category TEXT NOT NULL DEFAULT '',
  collection TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_capture_organizer_status ON capture_organizer_jobs(status);
