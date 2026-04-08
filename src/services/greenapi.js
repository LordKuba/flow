const { supabase } = require('../config/supabase');
const { encrypt, decrypt } = require('./encryption');
const { broadcastNewMessage } = require('./realtime');
const { notifyNewMessage } = require('./notifications');

const BASE_URL = 'https://api.green-api.com';

// Active polling intervals per org
const pollers = new Map();

/**
 * Initialize Green API for an organization.
 * Saves encrypted credentials and starts webhook polling.
 */
async function initGreenApi(orgId, channelId, idInstance, apiTokenInstance) {
  // Save encrypted credentials to channels.session_data
  const credentials = encrypt(JSON.stringify({ idInstance, apiTokenInstance }));

  await supabase
    .from('channels')
    .update({
      status: 'connected',
      session_data: credentials,
    })
    .eq('id', channelId);

  // Check instance status
  try {
    const statusRes = await fetch(
      `${BASE_URL}/waInstance${idInstance}/getStateInstance/${apiTokenInstance}`
    );
    const statusData = await statusRes.json();
    console.log(`Green API instance ${idInstance} status:`, statusData.stateInstance);

    if (statusData.stateInstance === 'authorized') {
      await supabase.from('channels').update({ status: 'connected' }).eq('id', channelId);
    } else {
      await supabase.from('channels').update({ status: 'disconnected' }).eq('id', channelId);
    }
  } catch (err) {
    console.error(`Failed to check Green API status:`, err.message);
  }

  // Start polling for incoming messages
  startWebhookPolling(orgId, channelId, idInstance, apiTokenInstance);

  return { status: 'connected', idInstance };
}

/**
 * Get QR code for scanning.
 */
async function getQR(idInstance, apiTokenInstance) {
  const res = await fetch(
    `${BASE_URL}/waInstance${idInstance}/qr/${apiTokenInstance}`
  );
  const data = await res.json();
  // data.message contains base64 QR image when type === 'qrCode'
  return data;
}

/**
 * Get instance status.
 */
async function getStatus(idInstance, apiTokenInstance) {
  const res = await fetch(
    `${BASE_URL}/waInstance${idInstance}/getStateInstance/${apiTokenInstance}`
  );
  return await res.json();
}

/**
 * Send a text message via Green API.
 */
async function sendMessage(orgId, phoneNumber, content) {
  const creds = await getCredentials(orgId);
  if (!creds) throw new Error('Green API not configured for this organization');

  const { idInstance, apiTokenInstance } = creds;

  // Normalize phone: remove +, ensure no @c.us
  const chatId = phoneNumber.replace(/[^0-9]/g, '') + '@c.us';

  const res = await fetch(
    `${BASE_URL}/waInstance${idInstance}/sendMessage/${apiTokenInstance}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, message: content }),
    }
  );

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Green API send failed');
  return data;
}

/**
 * Start polling for incoming webhooks (notifications).
 */
function startWebhookPolling(orgId, channelId, idInstance, apiTokenInstance) {
  // Stop existing poller if any
  stopPolling(orgId);

  console.log(`Starting Green API polling for org ${orgId} (instance ${idInstance})`);

  const poll = async () => {
    try {
      // Receive one notification
      const res = await fetch(
        `${BASE_URL}/waInstance${idInstance}/receiveNotification/${apiTokenInstance}`
      );
      const data = await res.json();

      if (data && data.receiptId) {
        // Process the notification
        await processNotification(orgId, channelId, data);

        // Delete it so we don't get it again
        await fetch(
          `${BASE_URL}/waInstance${idInstance}/deleteNotification/${apiTokenInstance}/${data.receiptId}`,
          { method: 'DELETE' }
        );
      }
    } catch (err) {
      // Network errors are normal — just retry
      if (!err.message?.includes('fetch failed')) {
        console.error(`Green API poll error for org ${orgId}:`, err.message);
      }
    }
  };

  const interval = setInterval(poll, 1000);
  pollers.set(orgId, interval);

  // Run first poll immediately
  poll();
}

/**
 * Stop polling for an org.
 */
function stopPolling(orgId) {
  const existing = pollers.get(orgId);
  if (existing) {
    clearInterval(existing);
    pollers.delete(orgId);
    console.log(`Stopped Green API polling for org ${orgId}`);
  }
}

/**
 * Process a single webhook notification.
 */
async function processNotification(orgId, channelId, notification) {
  const body = notification.body;
  if (!body) return;

  const type = body.typeWebhook;

  // Only handle incoming messages
  if (type === 'incomingMessageReceived' || type === 'incomingMessageReceivedByEvent') {
    await handleIncomingMessage(orgId, channelId, body);
  }

  // Handle status changes
  if (type === 'stateInstanceChanged') {
    const state = body.stateInstance;
    console.log(`Green API instance state changed for org ${orgId}: ${state}`);
    if (state === 'notAuthorized' || state === 'blocked') {
      await supabase.from('channels').update({ status: 'disconnected' }).eq('id', channelId);
    }
  }
}

/**
 * Handle an incoming WhatsApp message — same pattern as old whatsapp.js.
 */
async function handleIncomingMessage(orgId, channelId, body) {
  try {
    const msgData = body.messageData;
    const senderData = body.senderData;
    if (!msgData || !senderData) return;

    const senderPhone = senderData.chatId?.replace('@c.us', '').replace('@g.us', '') || '';
    const senderName = senderData.senderName || senderData.chatName || senderPhone;
    const isGroup = senderData.chatId?.endsWith('@g.us');

    // Skip status messages
    if (body.typeWebhook === 'outgoingMessageStatus') return;

    // 1. Find or create contact
    let { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('organization_id', orgId)
      .eq('phone', senderPhone)
      .single();

    if (!contact) {
      const { data: newContact } = await supabase
        .from('contacts')
        .insert({
          organization_id: orgId,
          name: senderName,
          phone: senderPhone,
          source_channel: 'whatsapp',
          type: 'lead',
          status: 'new',
        })
        .select()
        .single();
      contact = newContact;
    }
    if (!contact) return;

    // 2. Find or create conversation
    let { data: conversation } = await supabase
      .from('conversations')
      .select('id, unread_count')
      .eq('organization_id', orgId)
      .eq('contact_id', contact.id)
      .eq('channel_id', channelId)
      .single();

    if (!conversation) {
      const { data: newConv } = await supabase
        .from('conversations')
        .insert({
          organization_id: orgId,
          contact_id: contact.id,
          channel_id: channelId,
          channel_type: 'whatsapp',
          external_chat_id: senderData.chatId,
          status: 'open',
        })
        .select()
        .single();
      conversation = { ...newConv, unread_count: 0 };
    }
    if (!conversation) return;

    // 3. Determine message type and content
    let msgType = 'text';
    let content = '';

    if (msgData.typeMessage === 'textMessage') {
      content = msgData.textMessageData?.textMessage || '';
    } else if (msgData.typeMessage === 'extendedTextMessage') {
      content = msgData.extendedTextMessageData?.text || '';
    } else if (msgData.typeMessage === 'imageMessage') {
      msgType = 'image';
      content = msgData.imageMessageData?.caption || '[תמונה]';
    } else if (msgData.typeMessage === 'videoMessage') {
      msgType = 'video';
      content = msgData.videoMessageData?.caption || '[סרטון]';
    } else if (msgData.typeMessage === 'audioMessage' || msgData.typeMessage === 'voiceMessage') {
      msgType = 'audio';
      content = '[הודעה קולית]';
    } else if (msgData.typeMessage === 'documentMessage') {
      msgType = 'document';
      content = msgData.documentMessageData?.fileName || '[קובץ]';
    } else if (msgData.typeMessage === 'stickerMessage') {
      msgType = 'image';
      content = '[מדבקה]';
    } else {
      content = '[הודעה]';
    }

    const externalId = body.idMessage || null;

    // 4. Save message
    await supabase.from('messages').insert({
      conversation_id: conversation.id,
      organization_id: orgId,
      external_message_id: externalId,
      direction: 'in',
      type: msgType,
      content,
      is_read: false,
    });

    // 5. Update conversation
    await supabase
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        last_message_text: content || `[${msgType}]`,
        unread_count: (conversation.unread_count || 0) + 1,
        status: 'open',
      })
      .eq('id', conversation.id);

    // 6. Notify
    await notifyNewMessage({
      orgId,
      conversationId: conversation.id,
      contactName: senderName,
      assignedTo: conversation.assigned_to || null,
    });

    // 7. Broadcast
    broadcastNewMessage(orgId, {
      message: { direction: 'in', content, type: msgType },
      conversation: { id: conversation.id, channel_type: 'whatsapp', contact_id: contact.id },
      contact: { id: contact.id, name: senderName, phone: senderPhone },
    });

    console.log(`New WhatsApp message from ${senderPhone} for org ${orgId}`);
  } catch (err) {
    console.error('Green API handleIncomingMessage error:', err.message);
  }
}

/**
 * Get decrypted credentials for an org.
 */
async function getCredentials(orgId) {
  const { data: channel } = await supabase
    .from('channels')
    .select('session_data')
    .eq('organization_id', orgId)
    .eq('type', 'whatsapp_greenapi')
    .single();

  if (!channel?.session_data) return null;

  try {
    return decrypt(channel.session_data);
  } catch {
    return null;
  }
}

/**
 * Check if polling is active for an org.
 */
function isPolling(orgId) {
  return pollers.has(orgId);
}

module.exports = {
  initGreenApi,
  getQR,
  getStatus,
  sendMessage,
  startWebhookPolling,
  stopPolling,
  getCredentials,
  isPolling,
};
