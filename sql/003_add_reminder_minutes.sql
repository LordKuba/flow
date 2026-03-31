-- =============================================
-- Flow Backend - Add reminder_minutes to events
-- Step 8: Configurable reminder time per event
-- Default: 30 minutes before start_time
-- =============================================

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS reminder_minutes INTEGER NOT NULL DEFAULT 30;

-- Index to efficiently find events whose reminder is due:
-- reminder fires when: NOW() >= start_time - (reminder_minutes * interval '1 minute')
-- and reminder hasn't been sent yet
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_events_reminder
  ON events (organization_id, start_time, reminder_sent)
  WHERE reminder_sent = FALSE;
