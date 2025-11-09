import { Router } from 'itty-router';
import Joi from 'joi';
import { json, getAuthFromRequest, decryptText } from './common.js';

// ---------- Local helpers ----------
function slugify(str) {
  return (str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')  // non-alphanumeric -> -
    .replace(/^-+|-+$/g, '')      // trim leading/trailing -
    .slice(0, 80);
}

// KV keys
const PRODUCTS_LIST_KEY = 'products:all';
const productKey = (id) => `product:${id}`;

// ---------- Joi schemas ----------
const productCreateSchema = Joi.object({
  title: Joi.string().min(1).max(200).required(),
  description: Joi.string().allow('').max(2000).optional(),
  price_cents: Joi.number().integer().min(0).required(),
  currency: Joi.string().length(3).uppercase().default('USD'),
  stock: Joi.number().integer().min(0).default(0),
  image_url: Joi.string().uri().optional().allow('', null)
});

const productImageDeleteSchema = Joi.object({
  id: Joi.string().required()
});

const productUpdateSchema = Joi.object({
  title: Joi.string().min(1).max(200),
  description: Joi.string().allow('').max(2000),
  price_cents: Joi.number().integer().min(0),
  currency: Joi.string().length(3).uppercase(),
  status: Joi.string().valid('active', 'inactive', 'deleted'),
  image_url: Joi.string().uri().optional().allow('', null)
}).min(1);

const productStockUpdateSchema = Joi.object({
  product_id: Joi.string().min(1).required(),
  qty: Joi.number().integer().min(1).max(999).required(),
  operation: Joi.string().valid('set', 'add', 'remove').default('set')
});

const sellerOrderStatusSchema = Joi.object({
  order_id: Joi.string().required(),
  status: Joi.string()
    .valid('placed', 'processing', 'shipped', 'completed', 'cancelled')
    .required()
});

const productStatusSchema = Joi.object({
  id: Joi.string().required(),
  status: Joi.string().valid('active', 'inactive', 'deleted').required()
});

// ---------- Router ----------
const router = Router();

// --- Change product status (explicit) ---
router.post('/api/seller/products/status', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  if (auth.user.role !== 'seller' && auth.user.role !== 'admin') {
    return json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  let body; try { body = await request.json(); } catch { 
    return json({ ok:false, error:'Invalid JSON body' }, { status:400 });
  }
  const { error, value } = productStatusSchema.validate(body, { abortEarly:false, stripUnknown:true });
  if (error) return json({ ok:false, error:'Validation failed', details:error.details.map(d=>d.message) }, { status:400 });

  // ownership check
  const row = await env.DB.prepare(`SELECT seller_id FROM products WHERE id = ?`).bind(value.id).first();
  if (!row) return json({ ok:false, error:'Product not found' }, { status:404 });
  if (auth.user.role === 'seller' && row.seller_id !== auth.user.id) {
    return json({ ok:false, error:'You can only modify your own products' }, { status:403 });
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE products SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(value.status, now, value.id).run();

  // cache bust
  if (env.PRODUCT_CACHE) {
    ctx.waitUntil(Promise.all([
      env.PRODUCT_CACHE.delete(PRODUCTS_LIST_KEY),
      env.PRODUCT_CACHE.delete(productKey(value.id))
    ]));
  }

  return json({ ok:true, id:value.id, status:value.status, updated_at:now });
});

// ================== Public product endpoints ==================

// ---- Seller products: upload / update product image ----
router.post('/api/seller/products/:id/image', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }

  if (auth.user.role !== 'seller' && auth.user.role !== 'admin') {
    return json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  if (!env.PRODUCT_IMAGE_BUCKET) {
    return json(
      { ok: false, error: 'PRODUCT_IMAGE_BUCKET is not configured' },
      { status: 500 }
    );
  }

  const productId = request.params?.id;
  if (!productId) {
    return json({ ok: false, error: 'Missing product id' }, { status: 400 });
  }

  try {
    const product = await env.DB.prepare(
      `SELECT id, seller_id FROM products WHERE id = ?`
    )
      .bind(productId)
      .first();

    if (!product) {
      return json({ ok: false, error: 'Product not found' }, { status: 404 });
    }

    if (
      auth.user.role === 'seller' &&
      product.seller_id &&
      product.seller_id !== auth.user.id
    ) {
      return json(
        { ok: false, error: 'You can only modify your own products' },
        { status: 403 }
      );
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!file || !(file instanceof File)) {
      return json(
        { ok: false, error: 'Missing file field' },
        { status: 400 }
      );
    }

    const key = `products/${productId}`;
    await env.PRODUCT_IMAGE_BUCKET.put(key, file, {
      httpMetadata: {
        contentType: file.type || 'image/jpeg'
      }
    });

    const imageUrl = `/product-images/${productId}`;
    const now = new Date().toISOString();

    await env.DB.prepare(
      `UPDATE products
       SET image_url = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(imageUrl, now, productId)
      .run();

    if (env.PRODUCT_CACHE) {
      ctx.waitUntil(
        Promise.all([
          env.PRODUCT_CACHE.delete(PRODUCTS_LIST_KEY),
          env.PRODUCT_CACHE.delete(productKey(productId))
        ])
      );
    }

    return json({ ok: true, image_url: imageUrl });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- Public product image fetch from R2 ----
router.get('/product-images/:id', async (request, env, ctx) => {
  if (!env.PRODUCT_IMAGE_BUCKET) {
    return new Response('PRODUCT_IMAGE_BUCKET not configured', { status: 500 });
  }

  const id = request.params?.id;
  if (!id) {
    return new Response('Missing id', { status: 400 });
  }

  const key = `products/${id}`;
  const obj = await env.PRODUCT_IMAGE_BUCKET.get(key);

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

// ---- Products: list all active products (with KV cache) ----
router.get('/api/products', async (request, env, ctx) => {
  try {
    // Try KV cache first
    if (env.PRODUCT_CACHE) {
      const cached = await env.PRODUCT_CACHE.get(PRODUCTS_LIST_KEY, {
        type: 'json'
      });
      if (cached) {
        return json({ ok: true, products: cached, cached: true });
      }
    }

    const { results } = await env.DB.prepare(
      `SELECT
         p.id,
         p.slug,
         p.title,
         p.description,
         p.image_url,
         p.price_cents,
         p.currency,
         p.status,
         p.seller_id,
         u.name_cipher AS seller_name_cipher,
         i.stock,
         i.reserved
       FROM products p
       LEFT JOIN users u ON u.id = p.seller_id
       LEFT JOIN inventory i ON i.product_id = p.id
       WHERE p.status = 'active'
       ORDER BY p.created_at DESC`
    ).all();

    const products = await Promise.all(
      (results || []).map(async (row) => {
        let sellerName = null;
        if (row.seller_name_cipher) {
          try {
            sellerName = await decryptText(env, row.seller_name_cipher);
          } catch {
            sellerName = null;
          }
        }

        return {
          id: row.id,
          slug: row.slug,
          title: row.title,
          description: row.description,
          image_url: row.image_url,
          price_cents: row.price_cents,
          currency: row.currency,
          status: row.status,
          stock: row.stock,
          reserved: row.reserved,
          seller: row.seller_id
            ? {
                id: row.seller_id,
                name: sellerName
              }
            : null
        };
      })
    );

    // Put into KV cache (short TTL for demo, e.g. 60s)
    if (env.PRODUCT_CACHE) {
      ctx.waitUntil(
        env.PRODUCT_CACHE.put(PRODUCTS_LIST_KEY, JSON.stringify(products), {
          expirationTtl: 60
        })
      );
    }

    return json({ ok: true, products, cached: false });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- Product details: by id (with KV cache) ----
router.get('/api/products/:id', async (request, env, ctx) => {
  const id = request.params?.id;
  if (!id) {
    return json({ ok: false, error: 'Missing product id' }, { status: 400 });
  }

  const key = productKey(id);

  try {
    // KV first
    if (env.PRODUCT_CACHE) {
      const cached = await env.PRODUCT_CACHE.get(key, { type: 'json' });
      if (cached) {
        return json({ ok: true, product: cached, cached: true });
      }
    }

    const row = await env.DB.prepare(
      `SELECT
         p.id,
         p.slug,
         p.title,
         p.description,
         p.image_url,
         p.price_cents,
         p.currency,
         p.status,
         p.seller_id,
         u.name_cipher AS seller_name_cipher,
         i.stock,
         i.reserved
       FROM products p
       LEFT JOIN users u ON u.id = p.seller_id
       LEFT JOIN inventory i ON i.product_id = p.id
       WHERE p.id = ?`
    )
      .bind(id)
      .first();

    if (!row) {
      return json({ ok: false, error: 'Product not found' }, { status: 404 });
    }

    let sellerName = null;
    if (row.seller_name_cipher) {
      try {
        sellerName = await decryptText(env, row.seller_name_cipher);
      } catch {
        sellerName = null;
      }
    }

    const product = {
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      image_url: row.image_url,
      price_cents: row.price_cents,
      currency: row.currency,
      status: row.status,
      stock: row.stock,
      reserved: row.reserved,
      seller: row.seller_id
        ? {
            id: row.seller_id,
            name: sellerName
          }
        : null
    };

    if (env.PRODUCT_CACHE) {
      ctx.waitUntil(
        env.PRODUCT_CACHE.put(key, JSON.stringify(product), {
          expirationTtl: 60
        })
      );
    }

    return json({ ok: true, product, cached: false });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ================== Seller/admin endpoints ==================

// These routes expect AUTH + role seller/admin, but they live in this worker
// (edge router will forward /api/seller/* and /api/products/* here)

// ---- Seller products: list own products ----
router.get('/api/seller/products', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }

  if (auth.user.role !== 'seller' && auth.user.role !== 'admin') {
    return json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    const { results } = await env.DB.prepare(
      `SELECT
         p.id,
         p.slug,
         p.title,
         p.description,
         p.image_url,
         p.price_cents,
         p.currency,
         p.status,
         p.seller_id,
         i.stock,
         i.reserved,
         p.created_at,
         p.updated_at
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id
       WHERE p.seller_id = ?
       ORDER BY p.created_at DESC`
    )
      .bind(auth.user.id)
      .all();

    return json({
      ok: true,
      products: results || []
    });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- Seller products: create product ----
router.post('/api/seller/products', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }

  if (auth.user.role !== 'seller' && auth.user.role !== 'admin') {
    return json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { error, value } = productCreateSchema.validate(body, {
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

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  let slug = slugify(value.title);
  if (!slug) slug = id.slice(0, 8);
  const imageUrl = value.image_url || null;

  try {
    // Create product
    await env.DB.prepare(
      `INSERT INTO products (
        id,
        seller_id,
        slug,
        title,
        description,
        image_url,
        price_cents,
        currency,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        auth.user.id,
        slug,
        value.title,
        value.description || '',
        imageUrl,
        value.price_cents,
        value.currency,
        'active',
        now,
        now
      )
      .run();

    // Initialize inventory
    await env.DB.prepare(
      `INSERT INTO inventory (product_id, stock, reserved, updated_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(product_id)
       DO UPDATE SET stock = excluded.stock, updated_at = excluded.updated_at`
    )
      .bind(id, value.stock, now)
      .run();

    // Invalidate relevant caches
    if (env.PRODUCT_CACHE) {
      ctx.waitUntil(
        Promise.all([
          env.PRODUCT_CACHE.delete(PRODUCTS_LIST_KEY),
          env.PRODUCT_CACHE.delete(productKey(id))
        ])
      );
    }

    return json(
      {
        ok: true,
        product: {
          id,
          seller_id: auth.user.id,
          slug,
          title: value.title,
          description: value.description || '',
          price_cents: value.price_cents,
          currency: value.currency,
          image_url: imageUrl,
          status: 'active',
          stock: value.stock,
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

// ---- Seller products: update product details (id in body) ----
router.put('/api/seller/products', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }

  if (auth.user.role !== 'seller' && auth.user.role !== 'admin') {
    return json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const productId = body.id;
  if (!productId) {
    return json({ ok: false, error: 'Missing product id in body' }, { status: 400 });
  }

  const { error, value } = productUpdateSchema.validate(body, {
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
    // Load product to check ownership
    const product = await env.DB.prepare(
      `SELECT id, seller_id FROM products WHERE id = ?`
    )
      .bind(productId)
      .first();

    if (!product) {
      return json({ ok: false, error: 'Product not found' }, { status: 404 });
    }

    if (
      auth.user.role === 'seller' &&
      product.seller_id &&
      product.seller_id !== auth.user.id
    ) {
      return json(
        { ok: false, error: 'You can only modify your own products' },
        { status: 403 }
      );
    }

    const now = new Date().toISOString();
    const fields = [];
    const binds = [];

    if (value.title !== undefined) {
      fields.push('title = ?');
      binds.push(value.title);
    }
    if (value.description !== undefined) {
      fields.push('description = ?');
      binds.push(value.description);
    }
    if (value.price_cents !== undefined) {
      fields.push('price_cents = ?');
      binds.push(value.price_cents);
    }
    if (value.currency !== undefined) {
      fields.push('currency = ?');
      binds.push(value.currency);
    }
    if (value.status !== undefined) {
      fields.push('status = ?');
      binds.push(value.status);
    }
    if (value.image_url !== undefined) {
      fields.push('image_url = ?');
      binds.push(value.image_url || null);
    }

    if (fields.length === 0) {
      return json(
        { ok: false, error: 'No fields to update' },
        { status: 400 }
      );
    }

    fields.push('updated_at = ?');
    binds.push(now);
    binds.push(productId);

    const sql = `UPDATE products SET ${fields.join(', ')} WHERE id = ?`;
    await env.DB.prepare(sql).bind(...binds).run();

    // Invalidate caches
    if (env.PRODUCT_CACHE) {
      ctx.waitUntil(
        Promise.all([
          env.PRODUCT_CACHE.delete(PRODUCTS_LIST_KEY),
          env.PRODUCT_CACHE.delete(productKey(productId))
        ])
      );
    }

    // Return updated product
    const updated = await env.DB.prepare(
      `SELECT
         p.id,
         p.seller_id,
         p.slug,
         p.title,
         p.description,
         p.price_cents,
         p.currency,
         p.status,
         p.image_url,
         p.created_at,
         p.updated_at,
         i.stock,
         i.reserved
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id
       WHERE p.id = ?`
    )
      .bind(productId)
      .first();

    return json({ ok: true, product: updated });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- Seller products: update/add/remove stock (id + op in body) ----
router.post('/api/seller/products/stock', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }

  if (auth.user.role !== 'seller' && auth.user.role !== 'admin') {
    return json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { error, value } = productStockUpdateSchema.validate(body, {
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

  const { product_id, qty, operation } = value;

  try {
    // Ensure product exists and seller owns it (or admin)
    const product = await env.DB.prepare(
      `SELECT id, seller_id FROM products WHERE id = ?`
    )
      .bind(product_id)
      .first();

    if (!product) {
      return json({ ok: false, error: 'Product not found' }, { status: 404 });
    }

    if (
      auth.user.role === 'seller' &&
      product.seller_id &&
      product.seller_id !== auth.user.id
    ) {
      return json(
        { ok: false, error: 'You can only modify your own products' },
        { status: 403 }
      );
    }

    // Load current inventory (if any)
    const inv = await env.DB.prepare(
      `SELECT stock, reserved
       FROM inventory
       WHERE product_id = ?`
    )
      .bind(product_id)
      .first();

    const currentStock = inv ? Number(inv.stock || 0) : 0;
    let newStock;

    if (operation === 'set') {
      newStock = qty;
    } else if (operation === 'add') {
      newStock = currentStock + qty;
    } else if (operation === 'remove') {
      newStock = currentStock - qty;
    } else {
      return json(
        { ok: false, error: 'Invalid operation' },
        { status: 400 }
      );
    }

    if (newStock < 0) {
      return json(
        { ok: false, error: 'Resulting stock cannot be negative' },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO inventory (product_id, stock, reserved, updated_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(product_id)
       DO UPDATE SET stock = excluded.stock, updated_at = excluded.updated_at`
    )
      .bind(product_id, newStock, now)
      .run();

    // Invalidate caches
    if (env.PRODUCT_CACHE) {
      ctx.waitUntil(
        Promise.all([
          env.PRODUCT_CACHE.delete(PRODUCTS_LIST_KEY),
          env.PRODUCT_CACHE.delete(productKey(product_id))
        ])
      );
    }

    return json({
      ok: true,
      product_id,
      stock: newStock
    });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- Seller products: soft-delete product (id in body) ----
router.delete('/api/seller/products', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }

  if (auth.user.role !== 'seller' && auth.user.role !== 'admin') {
    return json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const productId = body.id;
  if (!productId) {
    return json({ ok: false, error: 'Missing product id in body' }, { status: 400 });
  }

  try {
    const product = await env.DB.prepare(
      `SELECT id, seller_id FROM products WHERE id = ?`
    )
      .bind(productId)
      .first();

    if (!product) {
      return json({ ok: false, error: 'Product not found' }, { status: 404 });
    }

    if (
      auth.user.role === 'seller' &&
      product.seller_id &&
      product.seller_id !== auth.user.id
    ) {
      return json(
        { ok: false, error: 'You can only modify your own products' },
        { status: 403 }
      );
    }

    const now = new Date().toISOString();

    // Soft-delete: mark status 'deleted' and zero stock.
    await env.DB.prepare(
      `UPDATE products
       SET status = 'deleted', updated_at = ?
       WHERE id = ?`
    )
      .bind(now, productId)
      .run();

    await env.DB.prepare(
      `UPDATE inventory
       SET stock = 0, updated_at = ?
       WHERE product_id = ?`
    )
      .bind(now, productId)
      .run();

    // NOT deleting any order_items or orders.

    // Invalidate caches
    if (env.PRODUCT_CACHE) {
      ctx.waitUntil(
        Promise.all([
          env.PRODUCT_CACHE.delete(PRODUCTS_LIST_KEY),
          env.PRODUCT_CACHE.delete(productKey(productId))
        ])
      );
    }

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});


// ================== Orders ==================

router.get('/api/seller/orders', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json(
      { ok: false, error: 'Not authenticated' },
      { status: 401 }
    );
  }

  if (auth.user.role !== 'seller' && auth.user.role !== 'admin') {
    return json(
      { ok: false, error: 'Forbidden' },
      { status: 403 }
    );
  }

  try {
    const { results } = await env.DB.prepare(
      `SELECT
         o.id          AS order_id,
         o.user_id     AS buyer_id,
         o.status      AS order_status,
         o.subtotal_cents,
         o.shipping_cents,
         o.tax_cents,
         o.total_cents,
         o.currency,
         o.created_at,
         o.updated_at,
         oi.product_id,
         oi.title_snapshot,
         oi.price_cents,
         oi.qty,
         u.name_cipher        AS buyer_name_cipher,
         a.name_cipher        AS shipping_name_cipher,
         a.line1_cipher,
         a.line2_cipher,
         a.city_cipher,
         a.state_cipher,
         a.postal_cipher,
         a.country            AS shipping_country
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN products p     ON p.id = oi.product_id
       JOIN users   u      ON u.id = o.user_id
       LEFT JOIN addresses a ON a.id = o.shipping_address_id
       WHERE p.seller_id = ?
       ORDER BY o.created_at DESC`
    )
      .bind(auth.user.id)
      .all();

    const map = new Map();

    for (const row of results || []) {
      let order = map.get(row.order_id);
      if (!order) {
        let buyerName = null;
        let shippingAddress = null;

        try {
          if (row.buyer_name_cipher) {
            buyerName = await decryptText(env, row.buyer_name_cipher);
          }
        } catch {
          buyerName = null;
        }

        if (row.shipping_name_cipher) {
          try {
            const name  = await decryptText(env, row.shipping_name_cipher);
            const line1 = await decryptText(env, row.line1_cipher);
            const line2 = await decryptText(env, row.line2_cipher);
            const city  = await decryptText(env, row.city_cipher);
            const state = await decryptText(env, row.state_cipher);
            const postal = await decryptText(env, row.postal_cipher);

            shippingAddress = {
              name,
              line1,
              line2,
              city,
              state,
              postal,
              country: row.shipping_country
            };
          } catch {
            shippingAddress = null;
          }
        }

        order = {
          id: row.order_id,
          buyer: {
            id: row.buyer_id,
            name: buyerName
          },
          shipping_address: shippingAddress,
          status: row.order_status,
          subtotal_cents: row.subtotal_cents,
          shipping_cents: row.shipping_cents,
          tax_cents: row.tax_cents,
          total_cents: row.total_cents,
          currency: row.currency,
          created_at: row.created_at,
          updated_at: row.updated_at,
          items: []
        };
        map.set(row.order_id, order);
      }

      order.items.push({
        product_id: row.product_id,
        title: row.title_snapshot,
        price_cents: row.price_cents,
        qty: row.qty
      });
    }

    return json({
      ok: true,
      orders: Array.from(map.values())
    });
  } catch (err) {
    return json(
      { ok: false, error: String(err) },
      { status: 500 }
    );
  }
});

router.post('/api/seller/orders/status', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json(
      { ok: false, error: 'Not authenticated' },
      { status: 401 }
    );
  }

  if (auth.user.role !== 'seller' && auth.user.role !== 'admin') {
    return json(
      { ok: false, error: 'Forbidden' },
      { status: 403 }
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

  const { error, value } = sellerOrderStatusSchema.validate(body, {
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

  const { order_id, status } = value;
  const now = new Date().toISOString();

  try {
    if (auth.user.role === 'seller') {
      // Ensure this order has at least one item belonging to this seller
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS cnt
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = ? AND p.seller_id = ?`
      )
        .bind(order_id, auth.user.id)
        .first();

      if (!row || Number(row.cnt || 0) === 0) {
        return json(
          { ok: false, error: 'You are not a seller on this order' },
          { status: 403 }
        );
      }
    }

    await env.DB.prepare(
      `UPDATE orders
       SET status = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(status, now, order_id)
      .run();

    return json({ ok: true });
  } catch (err) {
    return json(
      { ok: false, error: String(err) },
      { status: 500 }
    );
  }
});

router.delete('/api/seller/products/image', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) return json({ ok:false, error:'Not authenticated' }, { status:401 });
  if (auth.user.role !== 'seller' && auth.user.role !== 'admin') {
    return json({ ok:false, error:'Forbidden' }, { status:403 });
  }

  let body; try { body = await request.json(); } catch {
    return json({ ok:false, error:'Invalid JSON body' }, { status:400 });
  }
  const { error, value } = productImageDeleteSchema.validate(body, { abortEarly:false, stripUnknown:true });
  if (error) return json({ ok:false, error:'Validation failed', details:error.details.map(d=>d.message) }, { status:400 });

  // load & ownership
  const product = await env.DB.prepare(
    `SELECT seller_id, image_url FROM products WHERE id = ?`
  ).bind(value.id).first();

  if (!product) return json({ ok:false, error:'Product not found' }, { status:404 });
  if (auth.user.role === 'seller' && product.seller_id !== auth.user.id) {
    return json({ ok:false, error:'You can only modify your own products' }, { status:403 });
  }

  // Try to delete from R2 if it's our bucket path
  if (product.image_url && product.image_url.startsWith('/product-images/')) {
    const idPart = product.image_url.replace('/product-images/', '');
    const key = `products/${idPart}`;
    if (env.PRODUCT_IMAGE_BUCKET) {
      try { await env.PRODUCT_IMAGE_BUCKET.delete(key); } catch { /* ignore */ }
    }
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE products SET image_url = NULL, updated_at = ? WHERE id = ?`)
    .bind(now, value.id).run();

  if (env.PRODUCT_CACHE) {
    ctx.waitUntil(Promise.all([
      env.PRODUCT_CACHE.delete(PRODUCTS_LIST_KEY),
      env.PRODUCT_CACHE.delete(productKey(value.id))
    ]));
  }

  return json({ ok:true, id:value.id, image_url:null, updated_at:now });
});

router.get('/health', async (request, env, ctx) => {
  let db = { ok: false };
  let cache = { ok: false };

  try {
    await env.DB.prepare('SELECT 1').first();
    db = { ok: true };
  } catch (err) {
    db = { ok: false, error: String(err) };
  }

  try {
    await env.PRODUCT_CACHE.get('health-check');
    cache = { ok: true };
  } catch (err) {
    cache = { ok: false, error: String(err) };
  }

  const ok = db.ok && cache.ok;

  return json(
    {
      ok,
      service: 'catalog',
      db,
      cache,
      ts: new Date().toISOString()
    },
    { status: ok ? 200 : 503 }
  );
});


// 404 fallback
router.all('*', () =>
  json({ ok: false, error: 'Not found (catalog worker)' }, { status: 404 })
);

export default {
  fetch: (request, env, ctx) => router.fetch(request, env, ctx)
};
