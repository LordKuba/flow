const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticateUser } = require('../middleware/auth');

router.use(authenticateUser);

// GET /api/notifications — get user's notifications
router.get('/', async (req, res) => {
  try {
    const { unread_only, limit = 30, offset = 0 } = req.query;

    let query = supabase
      .from('notifications')
      .select('*', { count: 'exact' })
      .eq('organization_id', req.user.organization_id)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (unread_only === 'true') query = query.eq('is_read', false);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const unreadCount = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', req.user.organization_id)
      .eq('user_id', req.user.id)
      .eq('is_read', false)
      .then(r => r.count || 0);

    res.json({ notifications: data, total: count, unread_count: unreadCount });
  } catch (err) {
    console.error('List notifications error:', err);
    res.status(500).json({ error: 'Failed to list notifications' });
  }
});

// PUT /api/notifications/read-all — mark all as read (must come BEFORE /:id/read)
router.put('/read-all', async (req, res) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', req.user.id)
      .eq('organization_id', req.user.organization_id)
      .eq('is_read', false);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'כל ההתראות סומנו כנקראות' });
  } catch (err) {
    console.error('Mark all read error:', err);
    res.status(500).json({ error: 'Failed to mark all notifications as read' });
  }
});

// PUT /api/notifications/:id/read — mark single notification as read
router.put('/:id/read', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .eq('organization_id', req.user.organization_id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ error: 'התראה לא נמצאה' });
    res.json(data);
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

module.exports = router;
