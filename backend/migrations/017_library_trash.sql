ALTER TABLE items ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_items_deleted_at ON items(deleted_at);
