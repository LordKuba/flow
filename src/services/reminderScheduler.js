const { supabase } = require('../config/supabase');
const { broadcastEventReminder } = require('./realtime');
const { notifyEventReminder } = require('./notifications');

let schedulerInterval = null;

/**
 * Checks every minute for events whose reminder is due.
 *
 * An event's reminder fires when:
 *   NOW() >= start_time - (reminder_minutes * interval '1 minute')
 *   AND reminder_sent = false
 *   AND start_time > NOW()  (event hasn't started yet)
 */
async function checkReminders() {
  try {
    const now = new Date();

    // Fetch all unsent reminders where the reminder window has opened.
    // We use a raw RPC-style filter: start_time - reminder_minutes minutes <= now
    // Supabase doesn't support computed filters directly, so we fetch a
    // near-future window and filter in JS (events starting in next 60 min).
    const windowEnd = new Date(now.getTime() + 60 * 60 * 1000); // +60 min

    const { data: events, error } = await supabase
      .from('events')
      .select('id, title, start_time, end_time, location, location_type, organization_id, reminder_minutes, contact_id')
      .eq('reminder_sent', false)
      .gte('start_time', now.toISOString())      // event hasn't started
      .lte('start_time', windowEnd.toISOString()) // starts within next 60 min
      .order('start_time', { ascending: true });

    if (error) {
      console.error('Reminder check error:', error.message);
      return;
    }

    if (!events || events.length === 0) return;

    for (const event of events) {
      const startTime = new Date(event.start_time);
      const reminderTime = new Date(startTime.getTime() - event.reminder_minutes * 60 * 1000);

      // Only fire if we've passed the reminder time
      if (now < reminderTime) continue;

      // Mark reminder as sent first (prevents double-fire on slow broadcast)
      const { error: updateError } = await supabase
        .from('events')
        .update({ reminder_sent: true })
        .eq('id', event.id)
        .eq('reminder_sent', false); // optimistic lock

      if (updateError) {
        console.error(`Failed to mark reminder sent for event ${event.id}:`, updateError.message);
        continue;
      }

      // Broadcast to all org members
      await broadcastEventReminder(event.organization_id, {
        event: {
          id: event.id,
          title: event.title,
          start_time: event.start_time,
          end_time: event.end_time,
          location: event.location,
          location_type: event.location_type,
          contact_id: event.contact_id,
          reminder_minutes: event.reminder_minutes,
          message: `הפגישה "${event.title}" מתחילה בעוד ${event.reminder_minutes} דקות`
        }
      });

      // In-app notification to all org members
      await notifyEventReminder({
        orgId: event.organization_id,
        eventId: event.id,
        eventTitle: event.title,
        minutesBefore: event.reminder_minutes
      });

      console.log(`Reminder fired for event "${event.title}" (org: ${event.organization_id})`);
    }
  } catch (err) {
    console.error('Reminder scheduler error:', err);
  }
}

function start() {
  if (schedulerInterval) return;
  // Run immediately on start, then every 60 seconds
  checkReminders();
  schedulerInterval = setInterval(checkReminders, 60 * 1000);
  console.log('Reminder scheduler started (checking every 60s)');
}

function stop() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

module.exports = { start, stop, checkReminders };
