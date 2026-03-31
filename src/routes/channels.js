const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticateUser, requireRole } = require('../middleware/auth');
const whatsapp = require('../services/whatsapp');

// All routes require authentication
router.use(authenticateUser);

// Disclaimer text
const WHATSAPP_DISCLAIMER = `חיבור זה מתבצע דרך WhatsApp Web ואינו חיבור רשמי של Meta. השימוש כפוף לתנאי השירות של WhatsApp. Flow אינה אחראית לכל הגבלה, חסימה, או שינוי מדיניות מצד WhatsApp. האחריות המלאה על החשבון המחובר היא של המשתמש בלבד. מעדיף חיבור רשמי ומאובטח? עבור להגדרות וחבר את חשבון WhatsApp Business שלך דרך Meta Cloud API.`;

// GET /api/channels — list all connected channels
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('channels')
      .select('*')
      .eq('organization_id', req.user.organization_id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ channels: data });
  } catch (err) {
    console.error('List channels error:', err);
    res.status(500).json({ error: 'Failed to list channels' });
  }
});

// POST /api/channels/whatsapp/qr — start WhatsApp QR connection
router.post('/whatsapp/qr', requireRole('main'), async (req, res) => {
  try {
    const { disclaimer_accepted } = req.body;

    // Step 1: Return disclaimer if not accepted
    if (!disclaimer_accepted) {
      return res.json({
        status: 'disclaimer_required',
        disclaimer: WHATSAPP_DISCLAIMER,
        message: 'Send this request again with disclaimer_accepted: true to proceed'
      });
    }

    const orgId = req.user.organization_id;

    // Check if already has a WhatsApp QR channel
    let { data: existing } = await supabase
      .from('channels')
      .select('id, status')
      .eq('organization_id', orgId)
      .eq('type', 'whatsapp_qr')
      .single();

    let channelId;

    if (existing) {
      channelId = existing.id;
      // Update disclaimer acceptance
      await supabase
        .from('channels')
        .update({ disclaimer_accepted: true })
        .eq('id', channelId);
    } else {
      // Create new channel record
      const { data: channel, error } = await supabase
        .from('channels')
        .insert({
          organization_id: orgId,
          type: 'whatsapp_qr',
          status: 'disconnected',
          disclaimer_accepted: true
        })
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      channelId = channel.id;
    }

    // Initialize WhatsApp session
    const result = await whatsapp.initSession(orgId, channelId);

    res.json({
      channel_id: channelId,
      ...result
    });
  } catch (err) {
    console.error('WhatsApp QR error:', err);
    res.status(500).json({ error: 'Failed to start WhatsApp connection' });
  }
});

// GET /api/channels/whatsapp/qr/status — check QR/connection status
router.get('/whatsapp/qr/status', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const session = whatsapp.getSession(orgId);

    // Get channel info from DB
    const { data: channel } = await supabase
      .from('channels')
      .select('id, status, phone_number, account_name')
      .eq('organization_id', orgId)
      .eq('type', 'whatsapp_qr')
      .single();

    if (!channel) {
      return res.json({ status: 'not_configured' });
    }

    const response = {
      channel_id: channel.id,
      status: channel.status,
      phone_number: channel.phone_number,
      account_name: channel.account_name
    };

    // If session has a QR code, include it
    if (session?.status === 'qr_pending' && session.qrDataUrl) {
      response.qr = session.qrDataUrl;
    }

    // Include in-memory session status if different from DB
    if (session) {
      response.session_status = session.status;
    }

    res.json(response);
  } catch (err) {
    console.error('WhatsApp status error:', err);
    res.status(500).json({ error: 'Failed to get WhatsApp status' });
  }
});

// DELETE /api/channels/:channelId — disconnect a channel
router.delete('/:channelId', requireRole('main'), async (req, res) => {
  try {
    const orgId = req.user.organization_id;

    const { data: channel, error } = await supabase
      .from('channels')
      .select('id, type')
      .eq('id', req.params.channelId)
      .eq('organization_id', orgId)
      .single();

    if (error || !channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // If WhatsApp QR, destroy the session
    if (channel.type === 'whatsapp_qr') {
      await whatsapp.destroySession(orgId);
    }

    // Update channel status
    await supabase
      .from('channels')
      .update({
        status: 'disconnected',
        access_token: null,
        refresh_token: null,
        session_data: null
      })
      .eq('id', channel.id);

    res.json({ message: 'Channel disconnected' });
  } catch (err) {
    console.error('Disconnect channel error:', err);
    res.status(500).json({ error: 'Failed to disconnect channel' });
  }
});

// ─── Meta / WhatsApp Business API ────────────────────────────────────────────

// POST /api/channels/meta/connect — save Meta access token
router.post('/meta/connect', requireRole('main'), async (req, res) => {
  try {
    const { access_token, phone_number_id, account_name } = req.body;
    if (!access_token || !phone_number_id) {
      return res.status(400).json({ error: 'access_token and phone_number_id are required' });
    }

    const { encrypt } = require('../services/encryption');
    const orgId = req.user.organization_id;

    // Upsert the channel record
    const { data: existing } = await supabase
      .from('channels')
      .select('id')
      .eq('organization_id', orgId)
      .eq('type', 'whatsapp_business')
      .single();

    let channel;
    if (existing) {
      const { data } = await supabase
        .from('channels')
        .update({
          status: 'connected',
          access_token: encrypt(access_token),
          account_name: account_name || phone_number_id,
          phone_number: phone_number_id
        })
        .eq('id', existing.id)
        .select()
        .single();
      channel = data;
    } else {
      const { data, error } = await supabase
        .from('channels')
        .insert({
          organization_id: orgId,
          type: 'whatsapp_business',
          status: 'connected',
          access_token: encrypt(access_token),
          account_name: account_name || phone_number_id,
          phone_number: phone_number_id
        })
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      channel = data;
    }

    res.json({ message: 'Meta channel connected', channel_id: channel.id });
  } catch (err) {
    console.error('Meta connect error:', err);
    res.status(500).json({ error: 'Failed to connect Meta channel' });
  }
});

// GET /api/channels/meta/status — check Meta channel status
router.get('/meta/status', async (req, res) => {
  try {
    const { data: channel } = await supabase
      .from('channels')
      .select('id, status, account_name, phone_number')
      .eq('organization_id', req.user.organization_id)
      .eq('type', 'whatsapp_business')
      .single();

    if (!channel) return res.json({ status: 'not_configured' });
    res.json(channel);
  } catch (err) {
    console.error('Meta status error:', err);
    res.status(500).json({ error: 'Failed to get Meta status' });
  }
});

// POST /api/channels/whatsapp/send — send message via WhatsApp
// (Internal use - called from conversations route)
router.post('/whatsapp/send', async (req, res) => {
  try {
    const { phone, content, media_url } = req.body;
    const orgId = req.user.organization_id;

    if (!phone || (!content && !media_url)) {
      return res.status(400).json({ error: 'Phone and content/media_url are required' });
    }

    await whatsapp.sendMessage(orgId, phone, content, media_url);
    res.json({ message: 'Message sent' });
  } catch (err) {
    console.error('WhatsApp send error:', err);
    res.status(500).json({ error: err.message || 'Failed to send message' });
  }
});

module.exports = router;
