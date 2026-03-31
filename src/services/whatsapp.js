const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { supabase } = require('../config/supabase');
const { broadcastNewMessage } = require('./realtime');
const { notifyNewMessage } = require('./notifications');

// In-memory store of active WhatsApp sessions per organization
const sessions = new Map();

function getSession(orgId) {
  return sessions.get(orgId) || null;
}

/**
 * Initialize a WhatsApp session for an organization
 * Returns QR code as data URL for scanning
 */
async function initSession(orgId, channelId) {
  // If session already exists and is ready, skip
  const existing = sessions.get(orgId);
  if (existing && existing.status === 'ready') {
    return { status: 'already_connected' };
  }

  // If already initializing, return current QR
  if (existing && existing.status === 'qr_pending' && existing.qrDataUrl) {
    return { status: 'qr_pending', qr: existing.qrDataUrl };
  }

  // Create new session state
  const sessionState = {
    status: 'initializing',
    client: null,
    qrDataUrl: null,
    channelId,
    orgId
  };
  sessions.set(orgId, sessionState);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `org_${orgId}` }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ]
    }
  });

  sessionState.client = client;

  return new Promise((resolve, reject) => {
    let qrResolved = false;

    // QR code event
    client.on('qr', async (qr) => {
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        sessionState.status = 'qr_pending';
        sessionState.qrDataUrl = qrDataUrl;

        await supabase
          .from('channels')
          .update({ status: 'disconnected' })
          .eq('id', channelId);

        if (!qrResolved) {
          qrResolved = true;
          resolve({ status: 'qr_pending', qr: qrDataUrl });
        }
      } catch (err) {
        console.error('QR generation error:', err);
      }
    });

    // Successfully authenticated
    client.on('ready', async () => {
      console.log(`WhatsApp ready for org ${orgId}`);
      sessionState.status = 'ready';
      sessionState.qrDataUrl = null;

      const info = client.info;
      await supabase
        .from('channels')
        .update({
          status: 'connected',
          phone_number: info?.wid?.user || null,
          account_name: info?.pushname || null
        })
        .eq('id', channelId);
    });

    // Incoming message handler
    client.on('message', async (msg) => {
      await handleIncomingMessage(orgId, channelId, msg);
    });

    // Auth failure
    client.on('auth_failure', async (err) => {
      console.error(`WhatsApp auth failed for org ${orgId}:`, err);
      sessionState.status = 'error';

      await supabase
        .from('channels')
        .update({ status: 'error' })
        .eq('id', channelId);
    });

    // Disconnected
    client.on('disconnected', async (reason) => {
      console.log(`WhatsApp disconnected for org ${orgId}:`, reason);
      sessionState.status = 'disconnected';

      await supabase
        .from('channels')
        .update({ status: 'disconnected' })
        .eq('id', channelId);

      sessions.delete(orgId);
    });

    // Initialize
    client.initialize().catch((err) => {
      console.error(`WhatsApp init error for org ${orgId}:`, err);
      sessionState.status = 'error';
      sessions.delete(orgId);
      if (!qrResolved) {
        reject(err);
      }
    });

    // Timeout if no QR received in 30 seconds
    setTimeout(() => {
      if (!qrResolved) {
        // Check if we got authenticated from saved session (no QR needed)
        if (sessionState.status === 'ready') {
          resolve({ status: 'already_connected' });
        } else {
          qrResolved = true;
          resolve({ status: 'initializing', message: 'Session starting, check status endpoint' });
        }
      }
    }, 30000);
  });
}

/**
 * Handle an incoming WhatsApp message
 */
async function handleIncomingMessage(orgId, channelId, msg) {
  try {
    // Skip status messages, group messages, etc.
    if (msg.isStatus || msg.from.includes('@g.us')) return;

    const senderPhone = msg.from.replace('@c.us', '');
    const contact = await msg.getContact();
    const senderName = contact.pushname || contact.name || senderPhone;

    // 1. Find or create contact
    let { data: existingContact } = await supabase
      .from('contacts')
      .select('id')
      .eq('organization_id', orgId)
      .eq('phone', senderPhone)
      .single();

    if (!existingContact) {
      const { data: newContact } = await supabase
        .from('contacts')
        .insert({
          organization_id: orgId,
          name: senderName,
          phone: senderPhone,
          source_channel: 'whatsapp',
          type: 'lead',
          status: 'new'
        })
        .select()
        .single();
      existingContact = newContact;
    }

    if (!existingContact) return;

    // 2. Find or create conversation
    let { data: conversation } = await supabase
      .from('conversations')
      .select('id, unread_count')
      .eq('organization_id', orgId)
      .eq('contact_id', existingContact.id)
      .eq('channel_id', channelId)
      .single();

    if (!conversation) {
      const { data: newConv } = await supabase
        .from('conversations')
        .insert({
          organization_id: orgId,
          contact_id: existingContact.id,
          channel_id: channelId,
          channel_type: 'whatsapp',
          external_chat_id: msg.from,
          status: 'open'
        })
        .select()
        .single();
      conversation = { ...newConv, unread_count: 0 };
    }

    if (!conversation) return;

    // 3. Determine message type
    let msgType = 'text';
    let mediaUrl = null;
    let mediaType = null;
    let content = msg.body || '';

    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      if (media) {
        msgType = media.mimetype?.startsWith('image') ? 'image'
          : media.mimetype?.startsWith('audio') ? 'audio'
          : media.mimetype?.startsWith('video') ? 'video'
          : 'document';
        mediaType = media.mimetype;

        // Store media in Supabase Storage
        const fileName = `${orgId}/${conversation.id}/${Date.now()}.${media.mimetype?.split('/')[1] || 'bin'}`;
        const { data: upload } = await supabase.storage
          .from('media')
          .upload(fileName, Buffer.from(media.data, 'base64'), {
            contentType: media.mimetype
          });

        if (upload) {
          const { data: urlData } = supabase.storage
            .from('media')
            .getPublicUrl(fileName);
          mediaUrl = urlData?.publicUrl;
        }
      }
    }

    // 4. Save message
    await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        organization_id: orgId,
        external_message_id: msg.id?._serialized,
        direction: 'in',
        type: msgType,
        content,
        media_url: mediaUrl,
        media_type: mediaType,
        is_read: false
      });

    // 5. Update conversation
    await supabase
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        last_message_text: content || `[${msgType}]`,
        unread_count: (conversation.unread_count || 0) + 1,
        status: 'open'
      })
      .eq('id', conversation.id);

    // Create in-app notification for assigned agent (or managers if unassigned)
    await notifyNewMessage({
      orgId,
      conversationId: conversation.id,
      contactName: senderName,
      assignedTo: conversation.assigned_to || null
    });

    // Broadcast to all org members via Realtime
    broadcastNewMessage(orgId, {
      message: { direction: 'in', content, type: msgType, media_url: mediaUrl },
      conversation: { id: conversation.id, channel_type: 'whatsapp', contact_id: existingContact.id },
      contact: { id: existingContact.id, name: senderName, phone: senderPhone }
    });

    console.log(`New WhatsApp message from ${senderPhone} for org ${orgId}`);
  } catch (err) {
    console.error('Handle incoming message error:', err);
  }
}

/**
 * Send a WhatsApp message
 */
async function sendMessage(orgId, phone, content, mediaUrl) {
  const session = sessions.get(orgId);
  if (!session || session.status !== 'ready') {
    throw new Error('WhatsApp session not connected');
  }

  const chatId = phone.replace('+', '') + '@c.us';

  if (mediaUrl) {
    const { MessageMedia } = require('whatsapp-web.js');
    const media = await MessageMedia.fromUrl(mediaUrl);
    await session.client.sendMessage(chatId, media, { caption: content || '' });
  } else {
    await session.client.sendMessage(chatId, content);
  }
}

/**
 * Disconnect and destroy a session
 */
async function destroySession(orgId) {
  const session = sessions.get(orgId);
  if (session?.client) {
    try {
      await session.client.destroy();
    } catch (err) {
      console.error('Destroy session error:', err);
    }
  }
  sessions.delete(orgId);
}

module.exports = {
  initSession,
  getSession,
  sendMessage,
  destroySession
};
