const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticateUser, requireRole } = require('../middleware/auth');

router.use(authenticateUser);

// GET /api/org — get current organization details
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('organizations')
      .select('*')
      .eq('id', req.user.organization_id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Organization not found' });
    res.json(data);
  } catch (err) {
    console.error('Get org error:', err);
    res.status(500).json({ error: 'Failed to get organization' });
  }
});

// PUT /api/org — update organization details (main only)
router.put('/', requireRole('main'), async (req, res) => {
  try {
    const { name, plan } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (plan !== undefined) updates.plan = plan;

    const { data, error } = await supabase
      .from('organizations')
      .update(updates)
      .eq('id', req.user.organization_id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    console.error('Update org error:', err);
    res.status(500).json({ error: 'Failed to update organization' });
  }
});

// GET /api/org/team — list team members
router.get('/team', requireRole('manager'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, email, role, created_at')
      .eq('organization_id', req.user.organization_id)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ team: data });
  } catch (err) {
    console.error('List team error:', err);
    res.status(500).json({ error: 'Failed to list team' });
  }
});

// PUT /api/org/team/:userId/role — update team member role (main only)
router.put('/team/:userId/role', requireRole('main'), async (req, res) => {
  try {
    const { role } = req.body;
    const validRoles = ['main', 'manager', 'agent'];
    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Valid role required (main, manager, agent)' });
    }

    // Cannot change own role
    if (req.params.userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }

    const { data, error } = await supabase
      .from('users')
      .update({ role })
      .eq('id', req.params.userId)
      .eq('organization_id', req.user.organization_id)
      .select('id, full_name, email, role')
      .single();

    if (error || !data) return res.status(404).json({ error: 'User not found' });
    res.json(data);
  } catch (err) {
    console.error('Update role error:', err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// DELETE /api/org/team/:userId — remove team member (main only)
router.delete('/team/:userId', requireRole('main'), async (req, res) => {
  try {
    if (req.params.userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot remove yourself' });
    }

    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', req.params.userId)
      .eq('organization_id', req.user.organization_id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Team member removed' });
  } catch (err) {
    console.error('Remove team member error:', err);
    res.status(500).json({ error: 'Failed to remove team member' });
  }
});

module.exports = router;
