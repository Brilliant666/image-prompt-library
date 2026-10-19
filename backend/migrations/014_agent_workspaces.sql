CREATE TABLE agent_config (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, config TEXT NOT NULL
);
CREATE TABLE agent_conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, active_round_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE agent_rounds (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id),
  parent_round_id TEXT, request_id TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_agent_rounds_conversation ON agent_rounds(conversation_id);
CREATE TABLE agent_requests (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id),
  round_id TEXT NOT NULL UNIQUE REFERENCES agent_rounds(id), fingerprint TEXT NOT NULL,
  body TEXT NOT NULL, frozen TEXT NOT NULL, history TEXT NOT NULL,
  state TEXT NOT NULL, usage TEXT NOT NULL DEFAULT '{"responseStepsStarted":0,"imageJobsCreated":0}',
  error TEXT, stop_requested INTEGER NOT NULL DEFAULT 0,
  upstream_outcome TEXT NOT NULL DEFAULT 'not_sent', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_requests_state ON agent_requests(state);
CREATE TABLE agent_steps (
  request_id TEXT NOT NULL REFERENCES agent_requests(id), step INTEGER NOT NULL,
  state TEXT NOT NULL, output TEXT NOT NULL DEFAULT '[]', response_id TEXT,
  PRIMARY KEY(request_id,step)
);
CREATE TABLE agent_tool_jobs (
  request_id TEXT NOT NULL REFERENCES agent_requests(id), step INTEGER NOT NULL,
  call_id TEXT NOT NULL, item_id TEXT NOT NULL, name TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES generation_jobs(id),
  PRIMARY KEY(request_id,step,call_id,item_id), UNIQUE(job_id)
);
CREATE TABLE agent_assets (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, path TEXT NOT NULL, mime_type TEXT NOT NULL,
  width INTEGER NOT NULL, height INTEGER NOT NULL, sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'reference'
);
CREATE TABLE agent_resumes (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES agent_requests(id)
);
