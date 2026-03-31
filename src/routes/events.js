const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticateUser } = require('../middleware/auth');

router.use(authenticateUser);

// GET /api/events — list events (optionally filtered by date range)
router.get('/', async (req, res) => {
  try {
    const { from, to, limit = 50, offset = 0 } = req.query;
    const orgId = req.user.organization_id;

    let query = supabase
      .from('events')
      .select(`
        *,
        contact:contacts(id, name, phone),
        created_by_user:users!events_created_by_fkey(id, name)
      `, { count: 'exact' })
      .eq('organization_id', orgId)
      .order('start_time', { ascending: true })
      .range(offset, offset + limit - 1);

    if (from) query = query.gte('start_time', from);
    if (to)   query = query.lte('start_time', to);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ events: data, total: count });
  } catch (err) {
    console.error('List events error:', err);
    res.status(500).json({ error: 'Failed to list events' });
  }
});

// POST /api/events — create event
router.post('/', async (req, res) => {
  try {
    const {
      title, description, start_time, end_time,
      location, location_type, contact_id,
      google_event_id, reminder_minutes
    } = req.body;

    if (!title || !start_time || !end_time) {
      return res.status(400).json({ error: 'title, start_time and end_time are required' });
    }

    if (new Date(end_time) <= new Date(start_time)) {
      return res.status(400).json({ error: 'end_time must be after start_time' });
    }

    const { data, error } = await supabase
      .from('events')
      .insert({
        organization_id: req.user.organization_id,
        title, description, start_time, end_time,
        location, location_type, contact_id,
        google_event_id,
        reminder_minutes: reminder_minutes ?? 30,
        reminder_sent: false,
        created_by: req.user.id
      })
      .select(`
        *,
        contact:contacts(id, name, phone),
        created_by_user:users!events_created_by_fkey(id, name)
      `)
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    console.error('Create event error:', err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// GET /api/events/:id — get single event
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('events')
      .select(`
        *,
        contact:contacts(id, name, phone),
        created_by_user:users!events_created_by_fkey(id, name)
      `)
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Event not found' });
    res.json(data);
  } catch (err) {
    console.error('Get event error:', err);
    res.status(500).json({ error: 'Failed to get event' });
  }
});

// PUT /api/events/:id — update event
router.put('/:id', async (req, res) => {
  try {
    const {
      title, description, start_time, end_time,
      location, location_type, contact_id,
      google_event_id, reminder_minutes
    } = req.body;

    if (start_time && end_time && new Date(end_time) <= new Date(start_time)) {
      return res.status(400).json({ error: 'end_time must be after start_time' });
    }

    const updates = {
      title, description, start_time, end_time,
      location, location_type, contact_id, google_event_id
    };

    if (reminder_minutes !== undefined) {
      updates.reminder_minutes = reminder_minutes;
      // Reset reminder_sent so the new reminder fires at the new time
      updates.reminder_sent = false;
    }

    // Remove undefined fields
    Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);

    const { data, error } = await supabase
      .from('events')
      .update(updates)
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id)
      .select(`
        *,
        contact:contacts(id, name, phone)
      `)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Event not found' });
    res.json(data);
  } catch (err) {
    console.error('Update event error:', err);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// DELETE /api/events/:id — delete event
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('events')
      .delete()
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Event deleted' });
  } catch (err) {
    console.error('Delete event error:', err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

module.exports = router;
