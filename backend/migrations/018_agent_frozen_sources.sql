-- Source identity, not image hash, owns an immutable Agent reference.
-- Existing assets and frozen request histories remain untouched; adoption is lazy.
CREATE TABLE agent_frozen_sources (
  source_key TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE REFERENCES agent_assets(id)
);
-- Cheap existence check before the bounded, one-time legacy-history fallback.
CREATE INDEX idx_agent_assets_source_kind ON agent_assets(source, kind);
