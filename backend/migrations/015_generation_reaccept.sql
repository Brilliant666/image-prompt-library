-- Removing a Library image releases its gallery receipt. The staged result is
-- independent; acceptance still validates its bytes before creating new assets.
CREATE TRIGGER generation_image_deleted
BEFORE DELETE ON images
BEGIN
  UPDATE generation_jobs
  SET status = 'succeeded', accepted_image_id = NULL, accepted_at = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE accepted_image_id = OLD.id AND status = 'accepted'
    AND result_path IS NOT NULL;
END;

-- Older deletions cleared the foreign key without releasing the accepted state.
UPDATE generation_jobs
SET status = 'succeeded', accepted_at = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'accepted' AND accepted_image_id IS NULL
  AND result_path IS NOT NULL;
