const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticateUser, requireRole, requireOwnConversation } = require('../middleware/auth');
const greenapi = require('../services/greenapi');
const { broadcastNewMessage, broadcastConversationAssigned } = require('../services/realtime');

// All routes require authentication
router.use(authenticateUser);

// GET /api/conversations — list conversations
router.get('/', async (req, res) => {
  try {
    const { status, channel_type, assigned_to, limit, offset = 0 } = req.query;
    const orgId = req.user.organization_id;

    let query = supabase
      .from('conversations')
      .select(`
        *,
        contact:contacts(id, name, phone, email, type, status),
        assigned_user:users!conversations_assigned_to_fkey(id, name, email)
      `, { count: 'exact' })
      .eq('organization_id', orgId)
      .order('last_message_at', { ascending: false, nullsFirst: false });

    if (limit) {
      query = query.range(offset, offset + parseInt(limit) - 1);
    }

    if (status) query = query.eq('status', status);
    if (channel_type) query = query.eq('channel_type', channel_type);
    if (assigned_to) query = query.eq('assigned_to', assigned_to);

    // Agents can only see their own conversations
    if (req.user.role === 'agent') {
      query = query.eq('assigned_to', req.user.id);
    }

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ conversations: data, total: count });
  } catch (err) {
    console.error('List conversations error:', err);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

// GET /api/conversations/:id — get single conversation
router.get('/:id', requireOwnConversation(), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select(`
        *,
        contact:contacts(id, name, phone, email, type, status, business_name, tags),
        channel:channels(id, type, phone_number, account_name),
        assigned_user:users!conversations_assigned_to_fkey(id, name, email)
      `)
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Conversation not found' });
    res.json(data);
  } catch (err) {
    console.error('Get conversation error:', err);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

// PUT /api/conversations/:id/assign — assign conversation to agent
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
      .from('conversations')
      .update({ assigned_to: assigned_to || null })
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ error: 'Conversation not found' });

    // Broadcast to org so assigned agent gets notified
    broadcastConversationAssigned(req.user.organization_id, {
      conversation: data,
      assignedUserId: assigned_to
    });

    res.json(data);
  } catch (err) {
    console.error('Assign conversation error:', err);
    res.status(500).json({ error: 'Failed to assign conversation' });
  }
});

// PUT /api/conversations/:id/read — mark conversation as read
router.put('/:id/read', requireOwnConversation(), async (req, res) => {
  try {
    // Reset unread count on conversation
    const { data, error } = await supabase
      .from('conversations')
      .update({ unread_count: 0 })
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ error: 'Conversation not found' });

    // Mark all messages in this conversation as read
    await supabase
      .from('messages')
      .update({ is_read: true })
      .eq('conversation_id', req.params.id)
      .eq('direction', 'in')
      .eq('is_read', false);

    res.json(data);
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// GET /api/conversations/:id/messages — message history
router.get('/:id/messages', requireOwnConversation(), async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const { data, error, count } = await supabase
      .from('messages')
      .select('*, sent_by_user:users!messages_sent_by_fkey(id, name)', { count: 'exact' })
      .eq('conversation_id', req.params.id)
      .eq('organization_id', req.user.organization_id)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ messages: data, total: count });
  } catch (err) {
    console.error('List messages error:', err);
    res.status(500).json({ error: 'Failed to list messages' });
  }
});

// POST /api/conversations/:id/sync-history — fetch history from WhatsApp on demand
router.post('/:id/sync-history', requireOwnConversation(), async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const conversationId = req.params.id;

    // 1. Get conversation with external_chat_id
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, external_chat_id, channel_id')
      .eq('id', conversationId)
      .eq('organization_id', orgId)
      .single();

    if (convError || !conversation || !conversation.external_chat_id) {
      return res.status(404).json({ error: 'Conversation not found or no WhatsApp chat linked' });
    }

    // 2. Check if already has messages (skip if so)
    const { count } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId);

    if (count && count > 0) {
      // Already has messages — just return them
      const { data: existing } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('organization_id', orgId)
        .order('created_at', { ascending: true });
      return res.json({ messages: existing || [], synced: false });
    }

    // Green API doesn't support fetching old message history.
    // New messages arrive via webhook polling and are saved to DB in real-time.
    res.json({ messages: [], synced: true });
  } catch (err) {
    console.error('Sync history error:', err);
    res.status(500).json({ error: 'Failed to sync history' });
  }
});

// POST /api/conversations/:id/messages — send a message
router.post('/:id/messages', requireOwnConversation(), async (req, res) => {
  try {
    const { content, type = 'text', media_url, media_type } = req.body;

    if (!content && !media_url) {
      return res.status(400).json({ error: 'Content or media_url is required' });
    }

    // Verify conversation exists and belongs to org
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, contact_id, channel_id, channel_type')
      .eq('id', req.params.id)
      .eq('organization_id', req.user.organization_id)
      .single();

    if (convError || !conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Insert message
    const { data: message, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id: req.params.id,
        organization_id: req.user.organization_id,
        direction: 'out',
        type,
        content,
        media_url,
        media_type,
        sent_by: req.user.id,
        is_read: true
      })
      .select()
      .single();

    if (msgError) return res.status(500).json({ error: msgError.message });

    // Update conversation with last message info
    await supabase
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        last_message_text: content || `[${type}]`
      })
      .eq('id', req.params.id);

    // Return response immediately — don't wait for WhatsApp send
    res.status(201).json(message);

    // Send via WhatsApp (Green API) in background (non-blocking)
    if (conversation.channel_type === 'whatsapp') {
      (async () => {
        try {
          const { data: contactData } = await supabase
            .from('contacts')
            .select('phone')
            .eq('id', conversation.contact_id)
            .single();

          if (contactData?.phone) {
            await greenapi.sendMessage(req.user.organization_id, contactData.phone, content);
          }
        } catch (sendErr) {
          console.error('WhatsApp send error:', sendErr.message);
        }
      })();
    }

    // Broadcast new outgoing message to org
    broadcastNewMessage(req.user.organization_id, {
      message,
      conversation: { id: req.params.id, channel_type: conversation.channel_type }
    });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
