const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticateUser, requireRole } = require('../middleware/auth');
const { broadcastDocumentUpdated } = require('../services/realtime');
const { notifyDocumentUpdated } = require('../services/notifications');

router.use(authenticateUser);

// GET /api/documents
router.get('/', async (req, res) => {
  try {
    const { type, status, limit = 50, offset = 0 } = req.query;
    const orgId = req.user.organization_id;

    let query = supabase
      .from('documents')
      .select('*, contact:contacts(id, name, phone), created_by_user:users!documents_created_by_fkey(id, name)', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (type) query = query.eq('type', type);
    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ documents: data, total: count });
  } catch (err) {
    console.error('List documents error:', err);
    res.status(500).json({ error: 'Failed to list documents' });
  }
});

// GET /api/documents/contact/:contactId
router.get('/contact/:contactId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('organization_id', req.user.organization_id)
      .eq('contact_id', req.params.contactId)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ documents: data });
  } catch (err) {
    console.error('List contact documents error:', err);
    res.status(500).json({ error: 'Failed to list documents' });
  }
});

// POST /api/documents
router.post('/', async (req, res) => {
  try {
    const { type, contact_id, amount, currency, description, due_date } = req.body;

    if (!type || !contact_id) {
      return res.status(400).json({ error: 'type and contact_id are required' });
    }
    if (!['quote', 'payment_request'].includes(type)) {
      return res.status(400).json({ error: 'type must be quote or payment_request' });
    }

    // Verify contact belongs to org
    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', contact_id)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (!contact) return res.status(400).json({ error: 'Contact not found' });

    const { data, error } = await supabase
      .from('documents')
      .insert({
        organization_id: req.user.organization_id,
        type, contact_id, amount,
        currency: currency || 'ILS',
        description, due_date,
        status: 'open',
        created_by: req.user.id
      })
      .select('*, contact:contacts(id, name)')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    console.error('Create document error:', err);
    res.status(500).json({ error: 'Failed to create document' });
  }
});

// PUT /api/documents/:id/status — update document status + broadcast to team
router.put('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['open', 'pending', 'paid', 'closed'];

    if (!valid.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${valid.join(', ')}` });
    }

    const { data, error } = await supabase
      .from('documents')
      .update({ status })
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id)
      .select('*, contact:contacts(id, name)')
      .single();

    if (error || !data) return res.status(404).json({ error: 'Document not found' });

    // Broadcast + notify entire team
    broadcastDocumentUpdated(req.user.organization_id, { document: data });
    await notifyDocumentUpdated({
      orgId: req.user.organization_id,
      documentId: data.id,
      documentType: data.type,
      status,
      contactName: data.contact?.name || 'לקוח'
    });

    res.json(data);
  } catch (err) {
    console.error('Update document status error:', err);
    res.status(500).json({ error: 'Failed to update document status' });
  }
});

module.exports = router;
