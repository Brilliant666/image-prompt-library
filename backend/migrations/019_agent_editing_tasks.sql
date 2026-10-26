ALTER TABLE agent_conversations ADD COLUMN editing_tasks TEXT NOT NULL DEFAULT '{}';
CREATE INDEX idx_generation_agent_retry_conversation
ON generation_jobs(json_extract(metadata, '$.agentRetry.conversationId'))
WHERE json_extract(metadata, '$.agentRetry.conversationId') IS NOT NULL;
