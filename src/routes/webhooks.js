const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { supabase } = require('../config/supabase');
const { broadcastNewMessage } = require('../services/realtime');
const { notifyNewMessage } = require('../services/notifications');
const { decrypt } = require('../services/encryption');
const { processNotification: processGreenApiNotification } = require('../services/greenapi');

// ─── WhatsApp webhook (whatsapp-web.js events are handled in-process)  ────────
// This endpoint is for external WhatsApp Cloud API if ever migrated to Meta
router.post('/whatsapp', express.json(), async (req, res) => {
  // Acknowledge immediately
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body?.entry) return;

    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value?.messages) continue;

        for (const msg of value.messages) {
          const from = msg.from;
          const text = msg.type === 'text' ? msg.text?.body : null;
          if (!text) continue;

          // Find org by phone number
          const { data: channel } = await supabase
            .from('channels')
            .select('organization_id')
            .eq('phone_number', value.metadata?.display_phone_number)
            .eq('type', 'whatsapp_business')
            .eq('status', 'connected')
            .single();

          if (!channel) continue;

          const orgId = channel.organization_id;

          // Find or create contact
          let { data: contact } = await supabase
            .from('contacts')
            .select('id, full_name')
            .eq('organization_id', orgId)
            .eq('phone', from)
            .single();

          if (!contact) {
            const { data: newContact } = await supabase
              .from('contacts')
              .insert({ organization_id: orgId, phone: from, full_name: from, status: 'lead' })
              .select()
              .single();
            contact = newContact;
          }

          if (!contact) continue;

          // Find or create open conversation
          let { data: conversation } = await supabase
            .from('conversations')
            .select('id, assigned_to')
            .eq('organization_id', orgId)
            .eq('contact_id', contact.id)
            .eq('status', 'open')
            .eq('channel', 'whatsapp')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

          if (!conversation) {
            const { data: newConv } = await supabase
              .from('conversations')
              .insert({ organization_id: orgId, contact_id: contact.id, channel: 'whatsapp', status: 'open' })
              .select()
              .single();
            conversation = newConv;
          }

          if (!conversation) continue;

          // Save message
          const { data: savedMsg } = await supabase
            .from('messages')
            .insert({
              organization_id: orgId,
              conversation_id: conversation.id,
              contact_id: contact.id,
              direction: 'inbound',
              channel: 'whatsapp',
              content: text,
              whatsapp_message_id: msg.id
            })
            .select()
            .single();

          if (savedMsg) {
            await broadcastNewMessage(orgId, savedMsg);
            await notifyNewMessage({
              orgId,
              conversationId: conversation.id,
              contactName: contact.full_name,
              assignedTo: conversation.assigned_to
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err);
  }
});

// ─── Meta (WhatsApp Business / Instagram) webhook verification ────────────────

router.get('/meta', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── Meta webhook events ──────────────────────────────────────────────────────

router.post('/meta', express.raw({ type: 'application/json' }), (req, res) => {
  // Verify X-Hub-Signature-256 if META_APP_SECRET is set
  const appSecret = process.env.META_APP_SECRET;
  if (appSecret) {
    const sig = req.headers['x-hub-signature-256'];
    if (!sig) return res.sendStatus(401);

    const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.body).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.sendStatus(403);
    }
  }

  // Acknowledge immediately
  res.sendStatus(200);

  try {
    const body = JSON.parse(req.body.toString());
    // Same processing logic as /webhooks/whatsapp above can be invoked here
    // for Meta Cloud API messages — handled when platform migrates from QR to Business API
    console.log('Meta webhook event received:', body.object);
  } catch (err) {
    console.error('Meta webhook parse error:', err);
  }
});

// ─── Gmail push notifications ─────────────────────────────────────────────────

router.post('/gmail', express.json(), async (req, res) => {
  res.sendStatus(200);

  try {
    // Google Pub/Sub sends a base64-encoded message
    const message = req.body?.message;
    if (!message?.data) return;

    const decoded = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));
    const emailAddress = decoded?.emailAddress;
    if (!emailAddress) return;

    // Find org by connected Gmail channel email
    const { data: channel } = await supabase
      .from('channels')
      .select('organization_id')
      .eq('type', 'gmail')
      .eq('status', 'connected')
      .eq('account_name', emailAddress)
      .single();

    if (!channel) return;

    // Trigger a Gmail fetch for this org (lazy — let the routes/google do the heavy lifting)
    console.log(`Gmail push notification for org ${channel.organization_id} (${emailAddress})`);
    // Full sync can be triggered by calling fetchGmailMessages — omitted here to keep
    // webhook handler fast; client should poll /api/channels/gmail/messages instead.
  } catch (err) {
    console.error('Gmail webhook error:', err);
  }
});

// ─── Green API webhook ────────────────────────────────────────────────────────
// No auth — Green API posts directly. We identify the channel by idInstance
// from the notification body and route to the existing processNotification.
// The body shape from a real webhook POST differs from the polling shape
// (polling wraps in { receiptId, body: {...} }, webhook posts the inner object
// directly), so we re-wrap to match what processNotification expects.
router.post('/greenapi', express.json({ limit: '2mb' }), async (req, res) => {
  // Acknowledge IMMEDIATELY — Green API retries if we're slow
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body) {
      console.warn('[GreenAPI webhook] empty body');
      return;
    }

    const idInstance = body?.instanceData?.idInstance;
    if (!idInstance) {
      console.warn('[GreenAPI webhook] no idInstance in body:', JSON.stringify(body).substring(0, 300));
      return;
    }

    // Look up channel by idInstance (decrypt each session_data until we match)
    const { data: channels } = await supabase
      .from('channels')
      .select('id, organization_id, session_data')
      .eq('type', 'whatsapp_greenapi')
      .not('session_data', 'is', null);

    let match = null;
    for (const ch of channels || []) {
      try {
        const creds = decrypt(ch.session_data);
        if (creds && String(creds.idInstance) === String(idInstance)) {
          match = { orgId: ch.organization_id, channelId: ch.id };
          break;
        }
      } catch {}
    }

    if (!match) {
      console.warn(`[GreenAPI webhook] no channel matches idInstance ${idInstance}`);
      return;
    }

    console.log(`[GreenAPI webhook] ${body.typeWebhook} for org ${match.orgId}`);

    // Wrap body so it matches what processNotification expects ({ body: <notification> })
    await processGreenApiNotification(match.orgId, match.channelId, { body });
  } catch (err) {
    console.error('[GreenAPI webhook] error:', err.message);
  }
});

module.exports = router;
