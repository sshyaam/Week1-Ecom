// auth_worker.js
import { Router } from 'itty-router';
import Joi from 'joi';
import {
  json,
  normalizeEmail,
  normalizePhone,
  sha256Hex,
  encryptText,
  decryptText,
  parseCookies,
  getAuthFromRequest
} from './common.js';

// ---------- Joi schemas ----------
const userRegisterSchema = Joi.object({
  name: Joi.string().min(1).max(200).required(),
  email: Joi.string().email().required(),
  phone: Joi.string().min(5).max(50).optional().allow('', null),
  password: Joi.string().min(8).max(72).required(),
  role: Joi.string().valid('buyer', 'seller', 'admin').default('buyer'),
  avatar_url: Joi.string().uri().optional().allow('', null)
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).max(72).required()
});

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
  new_password: Joi.string().min(8).max(72).required()
});

const userUpdateSchema = Joi.object({
  name: Joi.string().min(1).max(200),
  phone: Joi.string().min(5).max(50),
  avatar_url: Joi.string().uri().optional().allow('', null),
  role: Joi.string().valid('buyer', 'seller', 'admin').default('buyer')
}).min(1);

const addressUpsertSchema = Joi.object({
  name: Joi.string().min(1).max(200).required(),
  line1: Joi.string().min(1).max(255).required(),
  line2: Joi.string().allow('', null).max(255).optional(),
  city: Joi.string().min(1).max(100).required(),
  state: Joi.string().min(1).max(100).required(),
  postal: Joi.string().min(1).max(20).required(),
  country: Joi.string().min(2).max(2).required(),
  is_default_shipping: Joi.boolean().optional(),
  is_default_billing: Joi.boolean().optional()
});

const addressUpdateSchema = Joi.object({
  id: Joi.string().required(),
  name: Joi.string().min(1).max(200),
  line1: Joi.string().min(1).max(255),
  line2: Joi.string().allow('', null).max(255),
  city: Joi.string().min(1).max(100),
  state: Joi.string().min(1).max(100),
  postal: Joi.string().min(1).max(20),
  country: Joi.string().length(2),
  is_default_shipping: Joi.boolean(),
  is_default_billing: Joi.boolean()
}).min(2); // id + at least one field

const addressDeleteSchema = Joi.object({
  id: Joi.string().required()
});

// ---------- Router ----------
const router = Router();

// Debug DB
router.get('/debug/db', async (request, env, ctx) => {
  try {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();

    return json({
      ok: true,
      tables: tables.results
    });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- User registration ----
router.post('/api/users/register', async (request, env, ctx) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { error, value } = userRegisterSchema.validate(body, {
    abortEarly: false,
    stripUnknown: true
  });

  if (error) {
    return json(
      {
        error: 'Validation failed',
        details: error.details.map((d) => d.message)
      },
      { status: 400 }
    );
  }

  const name = value.name.trim();
  const emailNorm = normalizeEmail(value.email);
  const phoneNorm = value.phone && value.phone !== '' ? normalizePhone(value.phone) : null;
  const avatarUrl = value.avatar_url || null;
  const now = new Date().toISOString();

  try {
    const emailHash = await sha256Hex(emailNorm);
    const emailCipher = await encryptText(env, emailNorm);

    let phoneHash = null;
    let phoneCipher = null;
    if (phoneNorm) {
      phoneHash = await sha256Hex(phoneNorm);
      phoneCipher = await encryptText(env, phoneNorm);
    }

    const nameCipher = await encryptText(env, name);

    const pepper = env.PASSWORD_PEPPER || 'dev-pepper';
    const passwordHash = await sha256Hex(value.password + '|' + pepper);
    const userId = crypto.randomUUID();

    const requestedRole = value.role || 'buyer';
    let finalRole = value.role;
    if (requestedRole === 'seller') {
      if (env.ALLOW_SELLER_SELF_REGISTER === '1') {
        finalRole = 'seller';
      }
    }

    await env.DB.prepare(
      `INSERT INTO users (
        id,
        email_hash,
        email_cipher,
        phone_hash,
        phone_cipher,
        name_cipher,
        password_hash,
        role,
        status,
        created_at,
        updated_at,
        avatar_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        userId,
        emailHash,
        emailCipher,
        phoneHash,
        phoneCipher,
        nameCipher,
        passwordHash,
        finalRole,
        'active',
        now,
        now,
        avatarUrl
      )
      .run();

    return json(
      {
        ok: true,
        user: {
          id: userId,
          name,
          email: emailNorm,
          phone: phoneNorm,
          role: finalRole,
          avatar_url: avatarUrl,
          created_at: now
        }
      },
      { status: 201 }
    );
  } catch (err) {
    const msg = String(err);

    if (msg.includes('UNIQUE constraint failed: users.email_hash')) {
      return json(
        { ok: false, error: 'Email is already registered' },
        { status: 409 }
      );
    }

    return json({ ok: false, error: msg }, { status: 500 });
  }
});

// ---- Upload avatar: store in R2 and update user ----
router.post('/api/users/me/avatar', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json(
      { ok: false, error: 'Not authenticated' },
      { status: 401 }
    );
  }

  if (!env.AVATAR_BUCKET) {
    return json(
      { ok: false, error: 'AVATAR_BUCKET is not configured' },
      { status: 500 }
    );
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json(
      { ok: false, error: 'Expected multipart/form-data' },
      { status: 400 }
    );
  }

  const file = form.get('file');
  if (!file || !(file instanceof File)) {
    return json(
      { ok: false, error: 'Missing file field' },
      { status: 400 }
    );
  }

  const userId = auth.user.id;
  const key = `avatars/${userId}`;

  try {
    await env.AVATAR_BUCKET.put(key, file, {
      httpMetadata: {
        contentType: file.type || 'image/jpeg'
      }
    });

    const avatarUrl = `/avatars/${userId}`;
    const now = new Date().toISOString();

    await env.DB.prepare(
      `UPDATE users
       SET avatar_url = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(avatarUrl, now, userId)
      .run();

    return json({ ok: true, avatar_url: avatarUrl });
  } catch (err) {
    return json(
      { ok: false, error: String(err) },
      { status: 500 }
    );
  }
});

// View full current user profile (decrypted PII)
router.get('/api/users/me/profile', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json(
      { ok: false, error: 'Not authenticated' },
      { status: 401 }
    );
  }

  try {
    const row = await env.DB.prepare(
      `SELECT
         id,
         email_cipher,
         phone_cipher,
         name_cipher,
         role,
         status,
         avatar_url,
         created_at,
         updated_at
       FROM users
       WHERE id = ?`
    )
      .bind(auth.user.id)
      .first();

    if (!row) {
      return json(
        { ok: false, error: 'User not found' },
        { status: 404 }
      );
    }

    // Decrypt; if decryption fails we fall back to nulls, but keep the request alive
    let name = null;
    let email = null;
    let phone = null;

    try {
      if (row.name_cipher)  name  = await decryptText(env, row.name_cipher);
      if (row.email_cipher) email = await decryptText(env, row.email_cipher);
      if (row.phone_cipher) phone = await decryptText(env, row.phone_cipher);
    } catch (e) {
      // Optional: log internally; for now just ignore and return null fields
    }

    return json({
      ok: true,
      user: {
        id: row.id,
        name,
        email,
        phone,
        role: row.role,
        status: row.status,
        avatar_url: row.avatar_url,
        created_at: row.created_at,
        updated_at: row.updated_at
      }
    });
  } catch (err) {
    return json(
      { ok: false, error: String(err) },
      { status: 500 }
    );
  }
});

router.get('/health', async (request, env, ctx) => {
  try {
    await env.DB.prepare('SELECT 1').first();
    return json({
      ok: true,
      service: 'auth',
      db: 'up',
      ts: new Date().toISOString()
    });
  } catch (err) {
    return json(
      {
        ok: false,
        service: 'auth',
        db: 'error',
        error: String(err)
      },
      { status: 500 }
    );
  }
});

router.put('/api/addresses', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json(
      { ok: false, error: 'Not authenticated' },
      { status: 401 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json(
      { ok: false, error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const { error, value } = addressUpdateSchema.validate(body, {
    abortEarly: false,
    stripUnknown: true
  });

  if (error) {
    return json(
      {
        ok: false,
        error: 'Validation failed',
        details: error.details.map((d) => d.message)
      },
      { status: 400 }
    );
  }

  const addressId = value.id;
  const now = new Date().toISOString();

  try {
    const existing = await env.DB.prepare(
      `SELECT id FROM addresses
       WHERE id = ? AND user_id = ?`
    )
      .bind(addressId, auth.user.id)
      .first();

    if (!existing) {
      return json(
        { ok: false, error: 'Address not found' },
        { status: 404 }
      );
    }

    // Handle default flags first
    if (value.is_default_shipping === true) {
      await env.DB.prepare(
        `UPDATE addresses
         SET is_default_shipping = 0
         WHERE user_id = ?`
      )
        .bind(auth.user.id)
        .run();
    }
    if (value.is_default_billing === true) {
      await env.DB.prepare(
        `UPDATE addresses
         SET is_default_billing = 0
         WHERE user_id = ?`
      )
        .bind(auth.user.id)
        .run();
    }

    const fields = [];
    const binds = [];

    // Encrypt fields only if provided
    if (value.name !== undefined) {
      const encName = await encryptText(env, value.name);
      fields.push('name_cipher = ?');
      binds.push(encName);
    }
    if (value.line1 !== undefined) {
      const encLine1 = await encryptText(env, value.line1);
      fields.push('line1_cipher = ?');
      binds.push(encLine1);
    }
    if (value.line2 !== undefined) {
      const encLine2 = await encryptText(env, value.line2 || '');
      fields.push('line2_cipher = ?');
      binds.push(encLine2);
    }
    if (value.city !== undefined) {
      const encCity = await encryptText(env, value.city);
      fields.push('city_cipher = ?');
      binds.push(encCity);
    }
    if (value.state !== undefined) {
      const encState = await encryptText(env, value.state);
      fields.push('state_cipher = ?');
      binds.push(encState);
    }
    if (value.postal !== undefined) {
      const encPostal = await encryptText(env, value.postal);
      fields.push('postal_cipher = ?');
      binds.push(encPostal);
    }
    if (value.country !== undefined) {
      fields.push('country = ?');
      binds.push(value.country);
    }
    if (value.is_default_shipping !== undefined) {
      fields.push('is_default_shipping = ?');
      binds.push(value.is_default_shipping ? 1 : 0);
    }
    if (value.is_default_billing !== undefined) {
      fields.push('is_default_billing = ?');
      binds.push(value.is_default_billing ? 1 : 0);
    }

    if (fields.length === 0) {
      return json(
        { ok: false, error: 'No fields to update' },
        { status: 400 }
      );
    }

    fields.push('updated_at = ?');
    binds.push(now);
    binds.push(addressId, auth.user.id);

    const sql = `
      UPDATE addresses
      SET ${fields.join(', ')}
      WHERE id = ? AND user_id = ?
    `;

    await env.DB.prepare(sql).bind(...binds).run();

    return json({
      ok: true,
      address: {
        id: addressId,
        ...value,
        updated_at: now
      }
    });
  } catch (err) {
    return json(
      { ok: false, error: String(err) },
      { status: 500 }
    );
  }
});

router.delete('/api/addresses', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json(
      { ok: false, error: 'Not authenticated' },
      { status: 401 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json(
      { ok: false, error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const { error, value } = addressDeleteSchema.validate(body, {
    abortEarly: false,
    stripUnknown: true
  });

  if (error) {
    return json(
      {
        ok: false,
        error: 'Validation failed',
        details: error.details.map((d) => d.message)
      },
      { status: 400 }
    );
  }

  try {
    const result = await env.DB.prepare(
      `DELETE FROM addresses
       WHERE id = ? AND user_id = ?`
    )
      .bind(value.id, auth.user.id)
      .run();

    return json({ ok: true });
  } catch (err) {
    return json(
      { ok: false, error: String(err) },
      { status: 500 }
    );
  }
});

router.post('/api/auth/forgot-password', async (request, env, ctx) => {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json(
      { ok: false, error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const { error, value } = forgotPasswordSchema.validate(body, {
    abortEarly: false,
    stripUnknown: true
  });

  if (error) {
    return json(
      {
        ok: false,
        error: 'Validation failed',
        details: error.details.map((d) => d.message)
      },
      { status: 400 }
    );
  }

  const emailNorm = normalizeEmail(value.email);
  const now = new Date().toISOString();

  try {
    const emailHash = await sha256Hex(emailNorm);

    const user = await env.DB.prepare(
      `SELECT id FROM users WHERE email_hash = ?`
    )
      .bind(emailHash)
      .first();

    // You *can* choose to always return ok=true even if user not found
    if (!user) {
      return json({ ok: true }); // avoid leaking which emails exist
    }

    const pepper = env.PASSWORD_PEPPER || 'dev-pepper';
    const newHash = await sha256Hex(value.new_password + '|' + pepper);

    await env.DB.prepare(
      `UPDATE users
       SET password_hash = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(newHash, now, user.id)
      .run();

    // optional: revoke existing sessions for this user
    await env.DB.prepare(
      `UPDATE sessions
       SET revoked = 1
       WHERE user_id = ?`
    )
      .bind(user.id)
      .run();

    return json({ ok: true });
  } catch (err) {
    return json(
      { ok: false, error: String(err) },
      { status: 500 }
    );
  }
});

// ---- Update current user ----
router.put('/api/users/me', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) return json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { error, value } = userUpdateSchema.validate(body, {
    abortEarly: false,
    stripUnknown: true
  });

  if (error) {
    return json(
      { ok: false, error: 'Validation failed', details: error.details.map((d) => d.message) },
      { status: 400 }
    );
  }

  try {
    const now = new Date().toISOString();
    const fields = [];
    const binds = [];

    if (value.name !== undefined) {
      const nameCipher = await encryptText(env, value.name);
      fields.push('name_cipher = ?');
      binds.push(nameCipher);
    }

    if (value.phone !== undefined) {
      const phoneNorm = normalizePhone(value.phone);
      const phoneHash = phoneNorm ? await sha256Hex(phoneNorm) : null;
      const phoneCipher = phoneNorm ? await encryptText(env, phoneNorm) : null;
      fields.push('phone_hash = ?');
      binds.push(phoneHash);
      fields.push('phone_cipher = ?');
      binds.push(phoneCipher);
    }

    if (value.avatar_url !== undefined) {
      fields.push('avatar_url = ?');
      binds.push(value.avatar_url || null);
    }

    if (value.role !== undefined) {
      fields.push('role = ?');
      binds.push(value.role || 'buyer');
    }

    if (fields.length === 0) {
      return json({ ok: false, error: 'No fields to update' }, { status: 400 });
    }

    fields.push('updated_at = ?');
    binds.push(now);
    binds.push(auth.user.id);

    const sql = `UPDATE users SET ${fields.join(', ')} WHERE id = ?`;
    await env.DB.prepare(sql).bind(...binds).run();

    const updated = await env.DB.prepare(
      `SELECT id, role, status, created_at, updated_at FROM users WHERE id = ?`
    )
      .bind(auth.user.id)
      .first();

    return json({ ok: true, user: updated });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- Delete current user ----
router.delete('/api/users/me', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) return json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  try {
    const now = new Date().toISOString();

    await env.DB.prepare(
      `UPDATE users SET status = 'deleted', updated_at = ? WHERE id = ?`
    )
      .bind(now, auth.user.id)
      .run();

    await env.DB.prepare(
      `UPDATE sessions SET revoked = 1 WHERE user_id = ?`
    )
      .bind(auth.user.id)
      .run();

    const clearCookie = [
      'sid=',
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0'
    ].join('; ');

    return json(
      { ok: true },
      { status: 200, headers: { 'Set-Cookie': clearCookie } }
    );
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- Login ----
router.post('/api/auth/login', async (request, env, ctx) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { error, value } = loginSchema.validate(body, {
    abortEarly: false,
    stripUnknown: true
  });

  if (error) {
    return json(
      { error: 'Validation failed', details: error.details.map((d) => d.message) },
      { status: 400 }
    );
  }

  const emailNorm = normalizeEmail(value.email);
  const now = new Date().toISOString();

  try {
    const emailHash = await sha256Hex(emailNorm);

    const user = await env.DB.prepare(
      `SELECT id, password_hash, role, status, created_at, updated_at
       FROM users WHERE email_hash = ?`
    )
      .bind(emailHash)
      .first();

    if (!user) {
      return json({ ok: false, error: 'Invalid email or password' }, { status: 401 });
    }

    if (user.status !== 'active') {
      return json({ ok: false, error: 'Account is not active' }, { status: 403 });
    }

    const pepper = env.PASSWORD_PEPPER || 'dev-pepper';
    const suppliedHash = await sha256Hex(value.password + '|' + pepper);

    if (suppliedHash !== user.password_hash) {
      return json({ ok: false, error: 'Invalid email or password' }, { status: 401 });
    }

    const sessionId = crypto.randomUUID();
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const expiresIso = expires.toISOString();

    await env.DB.prepare(
      `INSERT INTO sessions (
        id, user_id, issued_at, expires_at, revoked, ip, user_agent
      ) VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
      .bind(
        sessionId,
        user.id,
        now,
        expiresIso,
        request.headers.get('cf-connecting-ip') || null,
        request.headers.get('user-agent') || null
      )
      .run();

    const cookieParts = [
      `sid=${encodeURIComponent(sessionId)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${7 * 24 * 60 * 60}`
      // 'Secure'
    ];
    const setCookie = cookieParts.join('; ');

    return json(
      {
        ok: true,
        user: {
          id: user.id,
          email: emailNorm,
          role: user.role,
          created_at: user.created_at
        }
      },
      { status: 200, headers: { 'Set-Cookie': setCookie } }
    );
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- Logout ----
router.post('/api/auth/logout', async (request, env, ctx) => {
  const cookies = parseCookies(request);
  const sid = cookies.sid;

  if (sid) {
    try {
      await env.DB.prepare(
        `UPDATE sessions SET revoked = 1 WHERE id = ?`
      )
        .bind(sid)
        .run();
    } catch {
      // ignore
    }
  }

  const clearCookie = [
    'sid=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ].join('; ');

  return json(
    { ok: true },
    { status: 200, headers: { 'Set-Cookie': clearCookie } }
  );
});

// ---- /api/me (current user minimal info) ----
router.get('/api/me', async (request, env, ctx) => {
  try {
    const auth = await getAuthFromRequest(request, env);
    if (!auth) {
      return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
    }

    return json({
      ok: true,
      user: {
        id: auth.user.id,
        role: auth.user.role,
        status: auth.user.status,
        created_at: auth.user.created_at,
        updated_at: auth.user.updated_at
      }
    });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- Addresses: list ----
router.get('/api/addresses', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) return json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  try {
    const { results } = await env.DB.prepare(
      `SELECT
         id,
         name_cipher,
         line1_cipher,
         line2_cipher,
         city_cipher,
         state_cipher,
         postal_cipher,
         country,
         is_default_shipping,
         is_default_billing,
         created_at,
         updated_at
       FROM addresses
       WHERE user_id = ?
       ORDER BY created_at DESC`
    )
      .bind(auth.user.id)
      .all();

    const addresses = await Promise.all(
      (results || []).map(async (row) => ({
        id: row.id,
        name: await decryptText(env, row.name_cipher),
        line1: await decryptText(env, row.line1_cipher),
        line2: await decryptText(env, row.line2_cipher),
        city: await decryptText(env, row.city_cipher),
        state: await decryptText(env, row.state_cipher),
        postal: await decryptText(env, row.postal_cipher),
        country: row.country,
        is_default_shipping: !!row.is_default_shipping,
        is_default_billing: !!row.is_default_billing,
        created_at: row.created_at,
        updated_at: row.updated_at
      }))
    );

    return json({ ok: true, addresses });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- Addresses: create ----
router.post('/api/addresses', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) return json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { error, value } = addressUpsertSchema.validate(body, {
    abortEarly: false,
    stripUnknown: true
  });

  if (error) {
    return json(
      { ok: false, error: 'Validation failed', details: error.details.map((d) => d.message) },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const encName = await encryptText(env, value.name);
  const encLine1 = await encryptText(env, value.line1);
  const encLine2 = await encryptText(env, value.line2 || '');
  const encCity = await encryptText(env, value.city);
  const encState = await encryptText(env, value.state);
  const encPostal = await encryptText(env, value.postal);

  try {
    if (value.is_default_shipping) {
      await env.DB.prepare(
        `UPDATE addresses SET is_default_shipping = 0 WHERE user_id = ?`
      )
        .bind(auth.user.id)
        .run();
    }
    if (value.is_default_billing) {
      await env.DB.prepare(
        `UPDATE addresses SET is_default_billing = 0 WHERE user_id = ?`
      )
        .bind(auth.user.id)
        .run();
    }

    await env.DB.prepare(
      `INSERT INTO addresses (
        id,
        user_id,
        name_cipher,
        line1_cipher,
        line2_cipher,
        city_cipher,
        state_cipher,
        postal_cipher,
        country,
        is_default_shipping,
        is_default_billing,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        auth.user.id,
        encName,
        encLine1,
        encLine2,
        encCity,
        encState,
        encPostal,
        value.country,
        value.is_default_shipping ? 1 : 0,
        value.is_default_billing ? 1 : 0,
        now,
        now
      )
      .run();

    return json(
      {
        ok: true,
        address: {
          id,
          ...value,
          is_default_shipping: !!value.is_default_shipping,
          is_default_billing: !!value.is_default_billing,
          created_at: now,
          updated_at: now
        }
      },
      { status: 201 }
    );
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- Addresses: update (still using :id for now) ----
router.put('/api/addresses/:id', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) return json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const addressId = request.params?.id;
  if (!addressId) {
    return json({ ok: false, error: 'Missing address id' }, { status: 400 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { error, value } = addressUpsertSchema.validate(body, {
    abortEarly: false,
    stripUnknown: true
  });

  if (error) {
    return json(
      { ok: false, error: 'Validation failed', details: error.details.map((d) => d.message) },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const encName = await encryptText(env, value.name);
  const encLine1 = await encryptText(env, value.line1);
  const encLine2 = await encryptText(env, value.line2 || '');
  const encCity = await encryptText(env, value.city);
  const encState = await encryptText(env, value.state);
  const encPostal = await encryptText(env, value.postal);

  try {
    const existing = await env.DB.prepare(
      `SELECT id FROM addresses WHERE id = ? AND user_id = ?`
    )
      .bind(addressId, auth.user.id)
      .first();

    if (!existing) {
      return json({ ok: false, error: 'Address not found' }, { status: 404 });
    }

    if (value.is_default_shipping) {
      await env.DB.prepare(
        `UPDATE addresses SET is_default_shipping = 0 WHERE user_id = ?`
      )
        .bind(auth.user.id)
        .run();
    }

    if (value.is_default_billing) {
      await env.DB.prepare(
        `UPDATE addresses SET is_default_billing = 0 WHERE user_id = ?`
      )
        .bind(auth.user.id)
        .run();
    }

    await env.DB.prepare(
      `UPDATE addresses
       SET
         name_cipher = ?,
         line1_cipher = ?,
         line2_cipher = ?,
         city_cipher = ?,
         state_cipher = ?,
         postal_cipher = ?,
         country = ?,
         is_default_shipping = ?,
         is_default_billing = ?,
         updated_at = ?
       WHERE id = ? AND user_id = ?`
    )
      .bind(
        encName,
        encLine1,
        encLine2,
        encCity,
        encState,
        encPostal,
        value.country,
        value.is_default_shipping ? 1 : 0,
        value.is_default_billing ? 1 : 0,
        now,
        addressId,
        auth.user.id
      )
      .run();

    return json({
      ok: true,
      address: {
        id: addressId,
        ...value,
        is_default_shipping: !!value.is_default_shipping,
        is_default_billing: !!value.is_default_billing,
        updated_at: now
      }
    });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- Addresses: delete (still using :id for now) ----
router.delete('/api/addresses/:id', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) return json({ ok: false, error: 'Not authenticated' }, { status: 401 });

  const addressId = request.params?.id;
  if (!addressId) {
    return json({ ok: false, error: 'Missing address id' }, { status: 400 });
  }

  try {
    await env.DB.prepare(
      `DELETE FROM addresses WHERE id = ? AND user_id = ?`
    )
      .bind(addressId, auth.user.id)
      .run();

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- Public avatar fetch from R2 ----
router.get('/avatars/:id', async (request, env, ctx) => {
  if (!env.AVATAR_BUCKET) {
    return new Response('AVATAR_BUCKET not configured', { status: 500 });
  }

  const id = request.params?.id;
  if (!id) {
    return new Response('Missing id', { status: 400 });
  }

  const key = `avatars/${id}`;
  const obj = await env.AVATAR_BUCKET.get(key);

  if (!obj || !obj.body) {
    return new Response('Not found', { status: 404 });
  }

  const headers = new Headers();
  headers.set(
    'content-type',
    (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg'
  );
  headers.set('cache-control', 'public, max-age=3600');

  return new Response(obj.body, { headers });
});

// Remove my avatar (delete from R2 if it's our path, then clear DB)
router.delete('/api/users/me/avatar', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) return json({ ok:false, error:'Not authenticated' }, { status:401 });

  // load current url
  const row = await env.DB.prepare(`SELECT avatar_url FROM users WHERE id = ?`)
    .bind(auth.user.id).first();

  if (!row) return json({ ok:false, error:'User not found' }, { status:404 });

  if (row.avatar_url && row.avatar_url.startsWith('/avatars/')) {
    const idPart = row.avatar_url.replace('/avatars/', '');
    const key = `avatars/${idPart}`;
    if (env.AVATAR_BUCKET) {
      try { await env.AVATAR_BUCKET.delete(key); } catch { /* ignore */ }
    }
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE users SET avatar_url = NULL, updated_at = ? WHERE id = ?`)
    .bind(now, auth.user.id).run();

  return json({ ok:true, avatar_url:null, updated_at:now });
});

// 404 fallback
router.all('*', () => json({ error: 'Not found (auth worker)' }, { status: 404 }));

export default {
  fetch: (request, env, ctx) => router.fetch(request, env, ctx)
};
