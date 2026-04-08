const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { supabase } = require('../config/supabase');
const { broadcastNewMessage } = require('./realtime');
const { notifyNewMessage } = require('./notifications');
const { saveSession, restoreSession, clearSession } = require('./sessionStore');

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

  const puppeteerConfig = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-software-rasterizer',
      '--disable-features=VizDisplayCompositor',
      '--no-zygote',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-translate',
      '--js-flags=--max-old-space-size=256'
    ]
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // Restore session from Supabase before Chromium starts (so LocalAuth finds saved data)
  const restored = await restoreSession(orgId, channelId);
  if (restored) {
    console.log(`Restored WhatsApp session from Supabase for org ${orgId}`);
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `org_${orgId}` }),
    puppeteer: puppeteerConfig
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

      // Persist session to Supabase so it survives deploys
      saveSession(orgId, channelId).catch(err => {
        console.error(`Failed to persist session for org ${orgId}:`, err.message);
      });

      // Import existing chats so the Inbox isn't empty after connecting
      importExistingChats(client, orgId, channelId).catch(err => {
        console.error(`Chat import failed for org ${orgId}:`, err.message);
      });
    });

    // Incoming message handler
    client.on('message', async (msg) => {
      await handleIncomingMessage(orgId, channelId, msg);
    });

    // Auth failure — clear stale session so next attempt gets a fresh QR
    client.on('auth_failure', async (err) => {
      console.error(`WhatsApp auth failed for org ${orgId}:`, err);
      sessionState.status = 'error';

      await supabase
        .from('channels')
        .update({ status: 'error' })
        .eq('id', channelId);

      // Clear persisted session — it's expired/invalid
      clearSession(orgId, channelId).catch(e => {
        console.error(`Failed to clear session for org ${orgId}:`, e.message);
      });

      // Delete local auth dir so LocalAuth starts fresh
      const fs = require('fs');
      const path = require('path');
      const authDir = path.join(process.cwd(), '.wwebjs_auth', `session-org_${orgId}`);
      fs.rm(authDir, { recursive: true, force: true }, () => {});
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
    console.log(`WhatsApp initializing for org ${orgId} (Chromium: ${puppeteerConfig.executablePath || 'bundled'})`);
    client.initialize().catch((err) => {
      console.error(`WhatsApp init error for org ${orgId}:`, err.message || err);
      sessionState.status = 'error';
      sessionState.errorMessage = err.message || String(err);
      sessions.delete(orgId);
      if (!qrResolved) {
        qrResolved = true;
        reject(new Error(`WhatsApp initialization failed: ${err.message || err}`));
      }
    });

    // Timeout if no QR received in 60 seconds (Chromium startup can be slow on Railway)
    setTimeout(() => {
      if (!qrResolved) {
        // Check if we got authenticated from saved session (no QR needed)
        if (sessionState.status === 'ready') {
          resolve({ status: 'already_connected' });
        } else if (sessionState.status === 'error') {
          qrResolved = true;
          reject(new Error(`WhatsApp session failed: ${sessionState.errorMessage || 'unknown error'}`));
        } else {
          qrResolved = true;
          resolve({ status: 'initializing', message: 'Session starting, check status endpoint' });
        }
      }
    }, 60000);
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
 * Import existing WhatsApp chats after QR scan so the Inbox isn't empty.
 * Fetches up to 50 recent 1:1 chats and their last 15 messages each.
 */
async function importExistingChats(client, orgId, channelId) {
  const MAX_CHATS = 50;
  const MSGS_PER_CHAT = 15;

  const MEDIA_LABELS = {
    image: '[תמונה]', video: '[סרטון]', audio: '[הודעה קולית]',
    document: '[קובץ]', sticker: '[מדבקה]', ptt: '[הודעה קולית]'
  };

  console.log(`Starting chat import for org ${orgId}...`);
  let allChats;
  try {
    allChats = await client.getChats();
  } catch (err) {
    console.error(`Failed to get chats for org ${orgId}:`, err.message);
    return;
  }

  // Filter to 1:1 chats only, sort by most recent, limit
  const chats = allChats
    .filter(c => !c.isGroup && c.id?._serialized?.endsWith('@c.us'))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, MAX_CHATS);

  console.log(`Found ${chats.length} 1:1 chats to import (of ${allChats.length} total)`);
  let imported = 0;

  for (const chat of chats) {
    try {
      const phone = chat.id._serialized.replace('@c.us', '');
      const contactName = chat.name || phone;

      // 1. Find or create contact
      let { data: contact } = await supabase
        .from('contacts')
        .select('id')
        .eq('organization_id', orgId)
        .eq('phone', phone)
        .single();

      if (!contact) {
        const { data: newContact } = await supabase
          .from('contacts')
          .insert({
            organization_id: orgId,
            name: contactName,
            phone,
            source_channel: 'whatsapp',
            type: 'lead',
            status: 'new'
          })
          .select()
          .single();
        contact = newContact;
      }
      if (!contact) continue;

      // 2. Find or create conversation
      let { data: conversation } = await supabase
        .from('conversations')
        .select('id')
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
            external_chat_id: chat.id._serialized,
            status: 'open'
          })
          .select()
          .single();
        conversation = newConv;
      }
      if (!conversation) continue;

      // 3. Check if conversation already has messages (skip re-import)
      const { count } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', conversation.id);

      if (count && count > 0) continue;

      // 4. Fetch last N messages from this chat
      let messages;
      try {
        messages = await chat.fetchMessages({ limit: MSGS_PER_CHAT });
      } catch {
        continue;
      }
      if (!messages || messages.length === 0) continue;

      // 5. Insert messages in chronological order
      const rows = messages.map(msg => {
        const direction = msg.fromMe ? 'out' : 'in';
        const type = msg.hasMedia
          ? (msg.type === 'image' || msg.type === 'sticker' ? 'image'
            : msg.type === 'video' ? 'video'
            : msg.type === 'ptt' || msg.type === 'audio' ? 'audio'
            : 'document')
          : 'text';
        const content = msg.body || MEDIA_LABELS[msg.type] || MEDIA_LABELS[type] || '';
        const createdAt = msg.timestamp
          ? new Date(msg.timestamp * 1000).toISOString()
          : new Date().toISOString();

        return {
          conversation_id: conversation.id,
          organization_id: orgId,
          external_message_id: msg.id?._serialized || null,
          direction,
          type,
          content,
          is_read: true,
          created_at: createdAt
        };
      });

      await supabase.from('messages').insert(rows);

      // 6. Update conversation with last message info
      const lastMsg = rows[rows.length - 1];
      await supabase
        .from('conversations')
        .update({
          last_message_at: lastMsg.created_at,
          last_message_text: lastMsg.content || `[${lastMsg.type}]`,
          unread_count: 0
        })
        .eq('id', conversation.id);

      imported++;
    } catch (err) {
      console.error(`Failed to import chat ${chat.id?._serialized}:`, err.message);
    }
  }

  console.log(`Chat import complete for org ${orgId}: ${imported} conversations imported`);
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
  const channelId = session?.channelId;

  if (session?.client) {
    try {
      await session.client.destroy();
    } catch (err) {
      console.error('Destroy session error:', err);
    }
  }

  // Clear persisted session from Supabase
  if (channelId) {
    clearSession(orgId, channelId).catch(err => {
      console.error(`Failed to clear session for org ${orgId}:`, err.message);
    });
  }

  sessions.delete(orgId);
}

module.exports = {
  initSession,
  getSession,
  sendMessage,
  destroySession
};
