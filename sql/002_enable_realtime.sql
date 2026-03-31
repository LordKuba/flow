-- =============================================
-- Flow Backend - Enable Supabase Realtime
-- Step 7: Enable Realtime on all relevant tables
-- =============================================

-- Add tables to the Supabase Realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE documents;
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
