const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticateUser, requireRole } = require('../middleware/auth');

router.use(authenticateUser);
router.use(requireRole('manager'));

// GET /api/stats/overview — high-level counts
router.get('/overview', async (req, res) => {
  try {
    const orgId = req.user.organization_id;

    const [contacts, conversations, tasks, events] = await Promise.all([
      supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
      supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
      supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
      supabase.from('events').select('id', { count: 'exact', head: true }).eq('organization_id', orgId)
        .gte('start_time', new Date().toISOString())
    ]);

    const [openConvs, pendingTasks] = await Promise.all([
      supabase.from('conversations').select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId).eq('status', 'open'),
      supabase.from('tasks').select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId).eq('status', 'pending')
    ]);

    res.json({
      total_contacts: contacts.count || 0,
      total_conversations: conversations.count || 0,
      open_conversations: openConvs.count || 0,
      total_tasks: tasks.count || 0,
      pending_tasks: pendingTasks.count || 0,
      upcoming_events: events.count || 0
    });
  } catch (err) {
    console.error('Stats overview error:', err);
    res.status(500).json({ error: 'Failed to get overview stats' });
  }
});

// GET /api/stats/leads — new contacts over time
router.get('/leads', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const { days = 30 } = req.query;
    const since = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('contacts')
      .select('id, created_at, status')
      .eq('organization_id', orgId)
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    // Group by date
    const byDate = {};
    for (const c of data || []) {
      const date = c.created_at.slice(0, 10);
      byDate[date] = (byDate[date] || 0) + 1;
    }

    const byStatus = {};
    for (const c of data || []) {
      byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    }

    res.json({
      total: data?.length || 0,
      by_date: byDate,
      by_status: byStatus
    });
  } catch (err) {
    console.error('Stats leads error:', err);
    res.status(500).json({ error: 'Failed to get leads stats' });
  }
});

// GET /api/stats/messages — message volume
router.get('/messages', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const { days = 30 } = req.query;
    const since = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('messages')
      .select('id, created_at, direction, channel')
      .eq('organization_id', orgId)
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const byDate = {};
    const byChannel = {};
    let inbound = 0, outbound = 0;

    for (const m of data || []) {
      const date = m.created_at.slice(0, 10);
      byDate[date] = (byDate[date] || 0) + 1;
      byChannel[m.channel] = (byChannel[m.channel] || 0) + 1;
      if (m.direction === 'inbound') inbound++;
      else outbound++;
    }

    res.json({
      total: data?.length || 0,
      inbound,
      outbound,
      by_date: byDate,
      by_channel: byChannel
    });
  } catch (err) {
    console.error('Stats messages error:', err);
    res.status(500).json({ error: 'Failed to get messages stats' });
  }
});

module.exports = router;
