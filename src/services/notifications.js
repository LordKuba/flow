const { supabase } = require('../config/supabase');

/**
 * Create a notification for a user and optionally broadcast via Realtime.
 * All event-driven notifications go through here.
 */
async function createNotification(orgId, userId, { type, title, body, referenceId, referenceType }) {
  const { data, error } = await supabase
    .from('notifications')
    .insert({
      organization_id: orgId,
      user_id: userId,
      type,
      title,
      body,
      reference_id: referenceId,
      reference_type: referenceType,
      is_read: false
    })
    .select()
    .single();

  if (error) {
    console.error('Create notification error:', error.message);
    return null;
  }

  return data;
}

/**
 * Create notifications for all main/manager users in an org.
 */
async function notifyManagers(orgId, payload) {
  const { data: managers } = await supabase
    .from('users')
    .select('id')
    .eq('organization_id', orgId)
    .in('role', ['main', 'manager'])
    .eq('is_active', true);

  if (!managers?.length) return;

  await Promise.all(managers.map(m => createNotification(orgId, m.id, payload)));
}

/**
 * Create notifications for all active users in an org.
 */
async function notifyAll(orgId, payload) {
  const { data: users } = await supabase
    .from('users')
    .select('id')
    .eq('organization_id', orgId)
    .eq('is_active', true);

  if (!users?.length) return;

  await Promise.all(users.map(u => createNotification(orgId, u.id, payload)));
}

// ─── Specific notification helpers ───────────────────────────────────────────

/**
 * New incoming message — notify assigned agent (or managers if unassigned).
 */
async function notifyNewMessage({ orgId, conversationId, contactName, assignedTo }) {
  const payload = {
    type: 'new_message',
    title: `הודעה חדשה מ-${contactName}`,
    body: `קיבלת הודעה חדשה בשיחה עם ${contactName}`,
    referenceId: conversationId,
    referenceType: 'conversation'
  };

  if (assignedTo) {
    await createNotification(orgId, assignedTo, payload);
  } else {
    await notifyManagers(orgId, payload);
  }
}

/**
 * Task assigned to a user — notify the assignee.
 */
async function notifyTaskAssigned({ orgId, taskId, taskTitle, assignedTo }) {
  if (!assignedTo) return;

  await createNotification(orgId, assignedTo, {
    type: 'task_assigned',
    title: `משימה חדשה: ${taskTitle}`,
    body: `הוקצתה אליך משימה חדשה: "${taskTitle}"`,
    referenceId: taskId,
    referenceType: 'task'
  });
}

/**
 * Document status changed — notify all team.
 */
async function notifyDocumentUpdated({ orgId, documentId, documentType, status, contactName }) {
  const typeLabel = documentType === 'quote' ? 'הצעת מחיר' : 'בקשת תשלום';
  const statusLabels = {
    open: 'פתוחה',
    pending: 'ממתינה לאישור',
    paid: 'שולמה',
    closed: 'נסגרה'
  };

  await notifyAll(orgId, {
    type: 'document_opened',
    title: `${typeLabel} עודכנה`,
    body: `${typeLabel} ללקוח ${contactName} ${statusLabels[status] || status}`,
    referenceId: documentId,
    referenceType: 'document'
  });
}

/**
 * Meeting starting soon — notify all team.
 */
async function notifyEventReminder({ orgId, eventId, eventTitle, minutesBefore }) {
  await notifyAll(orgId, {
    type: 'meeting_soon',
    title: `פגישה מתחילה בעוד ${minutesBefore} דקות`,
    body: `"${eventTitle}" מתחילה בקרוב`,
    referenceId: eventId,
    referenceType: 'event'
  });
}

module.exports = {
  createNotification,
  notifyManagers,
  notifyAll,
  notifyNewMessage,
  notifyTaskAssigned,
  notifyDocumentUpdated,
  notifyEventReminder
};
