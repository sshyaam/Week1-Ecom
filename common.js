// common.js
import { } from 'itty-router'; // no-op import to keep bundlers happy in some setups

// ---------- JSON helper ----------
export const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {})
    }
  });

// ---------- Normalization helpers ----------
export function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

export function normalizePhone(phone) {
  return (phone || '').replace(/[^\d+]/g, '').trim();
}

export function slugify(str) {
  return (str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')  // non-alphanumeric -> -
    .replace(/^-+|-+$/g, '')      // trim leading/trailing -
    .slice(0, 80);
}

// ---------- Crypto helpers ----------
function bufferToHex(buffer) {
  const view = new Uint8Array(buffer);
  return Array.from(view)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bufferToHex(digest);
}

export async function callLogger(level, event, context) {
  if (env.LOGGING_SERVICE) {
    const logReq = new Request('https://week1-edge.shyaamdps.workers.dev/api/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        level: level,
        event: event,
        ctx: context
      })
    });
    ctx.waitUntil(env.LOGGING_SERVICE.fetch(logReq));
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function getEncryptionKey(env) {
  const secret = env.DATA_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('DATA_ENCRYPTION_KEY is not configured');
  }
  const raw = base64ToBytes(secret);
  return crypto.subtle.importKey(
    'raw',
    raw,
    'AES-GCM',
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptText(env, plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(String(plaintext));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(combined);
}

export async function decryptText(env, b64) {
  if (!b64) return null;
  const combined = base64ToBytes(b64);
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const key = await getEncryptionKey(env);
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
  return new TextDecoder().decode(plaintextBuf);
}

// ---------- Cookies + Auth ----------
export function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  const parts = header.split(';').map((p) => p.trim()).filter(Boolean);
  const cookies = {};
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx >= 0) {
      const name = part.slice(0, idx);
      const value = part.slice(idx + 1);
      cookies[name] = decodeURIComponent(value);
    }
  }
  return cookies;
}

export async function getAuthFromRequest(request, env) {
  const cookies = parseCookies(request);
  const sid = cookies.sid;
  if (!sid) return null;

  const now = new Date().toISOString();

  const session = await env.DB.prepare(
    `SELECT * FROM sessions
     WHERE id = ? AND revoked = 0 AND expires_at > ?`
  )
    .bind(sid, now)
    .first();

  if (!session) return null;

  const user = await env.DB.prepare(
    `SELECT id, role, status, created_at, updated_at
     FROM users WHERE id = ?`
  )
    .bind(session.user_id)
    .first();

  if (!user) return null;

  return { session, user };
}
