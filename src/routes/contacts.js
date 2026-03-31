const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticateUser, requireRole } = require('../middleware/auth');

// All routes require authentication
router.use(authenticateUser);

// GET /api/contacts — list all contacts (with filters)
router.get('/', async (req, res) => {
  try {
    const { type, status, assigned_to, search, limit = 50, offset = 0 } = req.query;
    const orgId = req.user.organization_id;

    let query = supabase
      .from('contacts')
      .select('*, assigned_user:users!contacts_assigned_to_fkey(id, name, email)', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (type) query = query.eq('type', type);
    if (status) query = query.eq('status', status);
    if (assigned_to) query = query.eq('assigned_to', assigned_to);
    if (search) query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ contacts: data, total: count });
  } catch (err) {
    console.error('List contacts error:', err);
    res.status(500).json({ error: 'Failed to list contacts' });
  }
});

// POST /api/contacts — create contact
router.post('/', async (req, res) => {
  try {
    const { name, phone, email, business_name, source_channel, type, status, notes, tags } = req.body;

    if (!name) return res.status(400).json({ error: 'Name is required' });

    const { data, error } = await supabase
      .from('contacts')
      .insert({
        organization_id: req.user.organization_id,
        name, phone, email, business_name, source_channel,
        type: type || 'lead',
        status: status || 'new',
        notes, tags
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    console.error('Create contact error:', err);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// GET /api/contacts/:id — get single contact
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('*, assigned_user:users!contacts_assigned_to_fkey(id, name, email)')
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Contact not found' });
    res.json(data);
  } catch (err) {
    console.error('Get contact error:', err);
    res.status(500).json({ error: 'Failed to get contact' });
  }
});

// PUT /api/contacts/:id — update contact
router.put('/:id', async (req, res) => {
  try {
    const { name, phone, email, business_name, source_channel, type, notes, tags } = req.body;

    const { data, error } = await supabase
      .from('contacts')
      .update({ name, phone, email, business_name, source_channel, type, notes, tags })
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ error: 'Contact not found' });
    res.json(data);
  } catch (err) {
    console.error('Update contact error:', err);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// DELETE /api/contacts/:id — delete contact
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Contact deleted' });
  } catch (err) {
    console.error('Delete contact error:', err);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// PUT /api/contacts/:id/assign — assign contact to agent
router.put('/:id/assign', requireRole('manager'), async (req, res) => {
  try {
    const { assigned_to } = req.body;

    // Verify agent belongs to same org
    if (assigned_to) {
      const { data: agent } = await supabase
        .from('users')
        .select('id')
        .eq('id', assigned_to)
        .eq('organization_id', req.user.organization_id)
        .single();

      if (!agent) return res.status(400).json({ error: 'Agent not found in your organization' });
    }

    const { data, error } = await supabase
      .from('contacts')
      .update({ assigned_to: assigned_to || null })
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ error: 'Contact not found' });
    res.json(data);
  } catch (err) {
    console.error('Assign contact error:', err);
    res.status(500).json({ error: 'Failed to assign contact' });
  }
});

// PUT /api/contacts/:id/status — change contact status
router.put('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status is required' });

    const validLeadStatuses = ['new', 'in_progress', 'quote_sent', 'future_customer', 'not_relevant'];
    const validCustomerStatuses = ['quote_sent', 'active_order', 'ready_for_delivery', 'pending_payment', 'closed'];
    const allStatuses = [...new Set([...validLeadStatuses, ...validCustomerStatuses])];

    if (!allStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Valid: ${allStatuses.join(', ')}` });
    }

    const { data, error } = await supabase
      .from('contacts')
      .update({ status })
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ error: 'Contact not found' });
    res.json(data);
  } catch (err) {
    console.error('Update status error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

module.exports = router;
