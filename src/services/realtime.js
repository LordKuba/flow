const { supabase } = require('../config/supabase');

/**
 * Broadcast a realtime event to all users in an organization.
 *
 * The frontend subscribes to:
 *   supabase.channel(`org:${orgId}`)
 *
 * Each event has a `type` and a `payload`.
 */
async function broadcast(orgId, type, payload) {
  try {
    await supabase
      .channel(`org:${orgId}`)
      .send({
        type: 'broadcast',
        event: type,
        payload
      });
  } catch (err) {
    // Realtime broadcast failures are non-critical — log and continue
    console.error(`Realtime broadcast error [${type}]:`, err.message);
  }
}

// ─── Event helpers ────────────────────────────────────────────────────────────

/**
 * New incoming message — broadcasts to all org members.
 * Frontend: update inbox unread badge + scroll conversation if open.
 */
function broadcastNewMessage(orgId, { message, conversation, contact }) {
  return broadcast(orgId, 'new_message', { message, conversation, contact });
}

/**
 * Conversation assigned to an agent.
 * Frontend: show notification to assigned agent; update assigned_to in inbox list.
 */
function broadcastConversationAssigned(orgId, { conversation, assignedUserId }) {
  return broadcast(orgId, 'conversation_assigned', { conversation, assignedUserId });
}

/**
 * New task created and assigned.
 * Frontend: show notification to assigned agent; refresh task list.
 */
function broadcastNewTask(orgId, { task, assignedUserId }) {
  return broadcast(orgId, 'new_task', { task, assignedUserId });
}

/**
 * Document status changed (opened / paid / closed).
 * Frontend: refresh documents list for all team members.
 */
function broadcastDocumentUpdated(orgId, { document }) {
  return broadcast(orgId, 'document_updated', { document });
}

/**
 * Meeting starting soon (30 min reminder).
 * Frontend: show reminder notification to all team.
 */
function broadcastEventReminder(orgId, { event }) {
  return broadcast(orgId, 'event_reminder', { event });
}

/**
 * Chat import progress update.
 * Frontend: show progress bar / toast during WhatsApp chat import.
 */
function broadcastChatImportProgress(orgId, { status, imported, total, message }) {
  return broadcast(orgId, 'chat_import_progress', { status, imported, total, message });
}

module.exports = {
  broadcastNewMessage,
  broadcastConversationAssigned,
  broadcastNewTask,
  broadcastDocumentUpdated,
  broadcastEventReminder,
  broadcastChatImportProgress
};
