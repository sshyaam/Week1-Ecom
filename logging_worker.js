import { Router } from 'itty-router';
import Joi from 'joi';
import { json, getAuthFromRequest } from './common.js';

// ----- Joi Schemas -----
const logConfigSchema = Joi.object({
  mode: Joi.string()
    .valid(
      'per_log',
      'per_minute',
      'per_hour',
      'per_day',
      'per_week',
      'per_month',
      'per_year'
    )
    .required()
});

const logEventSchema = Joi.object({
  level: Joi.string().valid('info', 'warn', 'error', 'debug').default('info'),
  event: Joi.string().max(200).required(),
  // keep this generic; avoid putting raw PII here
  ctx: Joi.object().unknown(true).optional()
});

// ----- Helpers: config in KV -----
const LOG_CONFIG_KEY = 'log_config:global';

async function getLogMode(env) {
  // Default if KV not configured
  if (!env.LOG_CONFIG) return 'per_log';

  const raw = await env.LOG_CONFIG.get(LOG_CONFIG_KEY);
  if (!raw) return 'per_log';

  try {
    const data = JSON.parse(raw);
    return data.mode || 'per_log';
  } catch {
    return 'per_log';
  }
}

async function setLogMode(env, mode) {
  if (!env.LOG_CONFIG) {
    throw new Error('LOG_CONFIG KV is not configured');
  }
  const payload = JSON.stringify({ mode });
  await env.LOG_CONFIG.put(LOG_CONFIG_KEY, payload);
}

// Build an R2 key based on mode and timestamp
function buildLogKey(mode, nowIso, level) {
  const d = new Date(nowIso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');

  const baseDate = `${yyyy}/${mm}/${dd}`;

  // For simplicity, we still write one object per log,
  // but path changes based on the chosen mode.
  const id = crypto.randomUUID();

  return `${baseDate}/${mode}/${hh}-${mi}-${ss}-${level}-${id}.json`;
}

// ----- Router -----
const router = Router();

// Admin: get logging config
router.get('/api/admin/logging-config', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }
  if (auth.user.role !== 'admin') {
    return json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  const mode = await getLogMode(env);
  return json({ ok: true, mode });
});

// Admin: set logging config
router.put('/api/admin/logging-config', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }
  if (auth.user.role !== 'admin') {
    return json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { error, value } = logConfigSchema.validate(body, {
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
    await setLogMode(env, value.mode);
    return json({ ok: true, mode: value.mode });
  } catch (err) {
    return json(
      { ok: false, error: String(err) },
      { status: 500 }
    );
  }
});

// System logging endpoint (other workers call this)
router.post('/api/log', async (request, env, ctx) => {
  if (!env.LOG_BUCKET) {
    return json(
      { ok: false, error: 'LOG_BUCKET (R2) is not configured' },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { error, value } = logEventSchema.validate(body, {
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

  const mode = await getLogMode(env);
  const now = new Date().toISOString();
  const key = buildLogKey(mode, now, value.level);

  const payload = {
    ts: now,
    level: value.level,
    event: value.event,
    ctx: value.ctx || {}
  };

  try {
    await env.LOG_BUCKET.put(key, JSON.stringify(payload), {
      httpMetadata: {
        contentType: 'application/json; charset=utf-8'
      }
    });

    return json({ ok: true, mode, key });
  } catch (err) {
    return json(
      { ok: false, error: String(err) },
      { status: 500 }
    );
  }
});

router.get('/health', async (request, env, ctx) => {
  let kv = { ok: false };
  let r2 = { ok: false };

  try {
    await env.LOG_CONFIG.get('health-check');
    kv = { ok: true };
  } catch (err) {
    kv = { ok: false, error: String(err) };
  }

  try {
    await env.LOG_BUCKET.list({ limit: 1 });
    r2 = { ok: true };
  } catch (err) {
    r2 = { ok: false, error: String(err) };
  }

  const ok = kv.ok && r2.ok;

  return json(
    {
      ok,
      service: 'logging',
      kv,
      object_storage: r2,
      ts: new Date().toISOString()
    },
    { status: ok ? 200 : 503 }
  );
});


// Fallback
router.all('*', () =>
  json({ ok: false, error: 'Not found (logging worker)' }, { status: 404 })
);

export default {
  fetch: (request, env, ctx) => router.fetch(request, env, ctx)
};
