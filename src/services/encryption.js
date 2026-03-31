const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits

function getKey() {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (!raw) {
    // In dev without a key, derive one from service key (not for production)
    return crypto.scryptSync(
      process.env.SUPABASE_SERVICE_KEY || 'dev-fallback',
      'flow-salt-v1',
      KEY_LENGTH
    );
  }
  // Expect a 64-char hex string
  if (raw.length === 64) return Buffer.from(raw, 'hex');
  // Or any string — derive a consistent 32-byte key
  return crypto.scryptSync(raw, 'flow-salt-v1', KEY_LENGTH);
}

/**
 * Encrypt a value (string or object) using AES-256-GCM.
 * Returns a base64-encoded string: iv:authTag:ciphertext
 */
function encrypt(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const key  = getKey();
  const iv   = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64')
  ].join(':');
}

/**
 * Decrypt a value previously encrypted with encrypt().
 * Returns the original string, or parsed object if it was JSON.
 */
function decrypt(encoded) {
  try {
    const [ivB64, tagB64, dataB64] = encoded.split(':');
    const key       = getKey();
    const iv        = Buffer.from(ivB64,  'base64');
    const authTag   = Buffer.from(tagB64, 'base64');
    const encrypted = Buffer.from(dataB64,'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');

    try { return JSON.parse(decrypted); } catch { return decrypted; }
  } catch (err) {
    // Fallback: try legacy base64 (migration from old tokens)
    try {
      const raw = Buffer.from(encoded, 'base64').toString('utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

module.exports = { encrypt, decrypt };
