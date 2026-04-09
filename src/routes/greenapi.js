const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticateUser, requireRole } = require('../middleware/auth');
const greenapi = require('../services/greenapi');
const greenapiImport = require('../services/greenapiImport');

// All routes require authentication
router.use(authenticateUser);

// POST /api/channels/greenapi/connect — connect Green API instance
router.post('/connect', requireRole('main'), async (req, res) => {
  try {
    const { idInstance, apiTokenInstance } = req.body;

    if (!idInstance || !apiTokenInstance) {
      return res.status(400).json({ error: 'idInstance and apiTokenInstance are required' });
    }

    const orgId = req.user.organization_id;

    // Check if already has a Green API channel
    let { data: existing } = await supabase
      .from('channels')
      .select('id')
      .eq('organization_id', orgId)
      .eq('type', 'whatsapp_greenapi')
      .single();

    let channelId;

    if (existing) {
      channelId = existing.id;
    } else {
      const { data: channel, error } = await supabase
        .from('channels')
        .insert({
          organization_id: orgId,
          type: 'whatsapp_greenapi',
          status: 'disconnected',
        })
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      channelId = channel.id;
    }

    // Initialize Green API
    const result = await greenapi.initGreenApi(orgId, channelId, idInstance, apiTokenInstance);

    // Fire-and-forget background history import — don't block the response.
    // Webhook will handle new messages going forward; this just backfills.
    try {
      greenapiImport.importHistoryForOrg(orgId, channelId);
    } catch (importErr) {
      console.error('[GreenAPI] background import failed to start:', importErr.message);
    }

    res.json({ channel_id: channelId, ...result });
  } catch (err) {
    console.error('Green API connect error:', err);
    res.status(500).json({ error: 'Failed to connect Green API' });
  }
});

// POST /api/channels/greenapi/import — manually trigger background history import
router.post('/import', requireRole('main'), async (req, res) => {
  try {
    const orgId = req.user.organization_id;

    const { data: channel } = await supabase
      .from('channels')
      .select('id, status')
      .eq('organization_id', orgId)
      .eq('type', 'whatsapp_greenapi')
      .single();

    if (!channel) return res.status(404).json({ error: 'Green API not connected' });
    if (channel.status !== 'connected') {
      return res.status(400).json({ error: 'Channel not connected' });
    }

    const result = greenapiImport.importHistoryForOrg(orgId, channel.id);
    res.json({ message: 'Import started in background', ...result });
  } catch (err) {
    console.error('Green API import endpoint error:', err);
    res.status(500).json({ error: 'Failed to start import' });
  }
});

// GET /api/channels/greenapi/qr — get QR code for scanning
router.get('/qr', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const creds = await greenapi.getCredentials(orgId);

    if (!creds) {
      return res.status(400).json({ error: 'Green API not configured. Connect first.' });
    }

    const qrData = await greenapi.getQR(creds.idInstance, creds.apiTokenInstance);
    res.json(qrData);
  } catch (err) {
    console.error('Green API QR error:', err);
    res.status(500).json({ error: 'Failed to get QR code' });
  }
});

// GET /api/channels/greenapi/status — check instance status
router.get('/status', async (req, res) => {
  try {
    const orgId = req.user.organization_id;

    // Get channel from DB
    const { data: channel } = await supabase
      .from('channels')
      .select('id, status, phone_number, account_name')
      .eq('organization_id', orgId)
      .eq('type', 'whatsapp_greenapi')
      .single();

    if (!channel) {
      return res.json({ status: 'not_configured' });
    }

    const response = {
      channel_id: channel.id,
      status: channel.status,
      phone_number: channel.phone_number,
      account_name: channel.account_name,
    };

    // Also check live instance status if credentials exist
    const creds = await greenapi.getCredentials(orgId);
    if (creds) {
      try {
        const liveStatus = await greenapi.getStatus(creds.idInstance, creds.apiTokenInstance);
        response.instance_status = liveStatus.stateInstance;
      } catch {}
    }

    res.json(response);
  } catch (err) {
    console.error('Green API status error:', err);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// DELETE /api/channels/greenapi/disconnect — mark disconnected
router.delete('/disconnect', requireRole('main'), async (req, res) => {
  try {
    const orgId = req.user.organization_id;

    await supabase
      .from('channels')
      .update({ status: 'disconnected', session_data: null })
      .eq('organization_id', orgId)
      .eq('type', 'whatsapp_greenapi');

    res.json({ message: 'Green API disconnected' });
  } catch (err) {
    console.error('Green API disconnect error:', err);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

module.exports = router;
