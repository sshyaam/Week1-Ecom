import { Router } from 'itty-router';
import Joi from 'joi';
import { json, getAuthFromRequest, decryptText, callLogger } from './common.js';

// ---------- Joi schemas ----------

// unified cart update schema
const cartUpdateSchema = Joi.object({
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

const checkoutPlaceSchema = Joi.object({
  shipping_method_id: Joi.string().required(),
  shipping_address_id: Joi.string().required(),
  billing_address_id: Joi.string().optional()
});

// ---------- Router ----------
const router = Router();

// ---- Orders: list current user's orders ----
router.get('/api/orders', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const { results } = await env.DB.prepare(
      `SELECT
         id,
         status,
         subtotal_cents,
         shipping_cents,
         tax_cents,
         total_cents,
         currency,
         shipping_address_id,
         billing_address_id,
         shipping_method_id,
         created_at,
         updated_at
       FROM orders
       WHERE user_id = ?
       ORDER BY created_at DESC`
    )
      .bind(auth.user.id)
      .all();

    return json({
      ok: true,
      orders: results || []
    });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

router.get('/api/orders/:id', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json(
      { ok: false, error: 'Not authenticated' },
      { status: 401 }
    );
  }

  const orderId = request.params?.id;
  if (!orderId) {
    return json(
      { ok: false, error: 'Missing order id' },
      { status: 400 }
    );
  }

  try {
    const order = await env.DB.prepare(
      `SELECT
         id,
         status,
         subtotal_cents,
         shipping_cents,
         tax_cents,
         total_cents,
         currency,
         shipping_address_id,
         billing_address_id,
         shipping_method_id,
         created_at,
         updated_at
       FROM orders
       WHERE id = ? AND user_id = ?`
    )
      .bind(orderId, auth.user.id)
      .first();

    if (!order) {
      return json(
        { ok: false, error: 'Order not found' },
        { status: 404 }
      );
    }

    const itemsRes = await env.DB.prepare(
      `SELECT
         product_id,
         title_snapshot,
         price_cents,
         qty
       FROM order_items
       WHERE order_id = ?`
    )
      .bind(orderId)
      .all();

    return json({
      ok: true,
      order: {
        ...order,
        items: itemsRes.results || []
      }
    });
  } catch (err) {
    return json(
      { ok: false, error: String(err) },
      { status: 500 }
    );
  }
});

// ---- Orders: get single order with items ----
async function renderProductPage(env, request, productId) {
  const url = new URL(request.url);
  url.pathname = `/api/products/${encodeURIComponent(productId)}`;

  const apiReq = new Request(url.toString(), request);
  const res = await env.CATALOG_SERVICE.fetch(apiReq);

  if (!res.ok) {
    return layout(
      env,
      request,
      'Product – Not found',
      `<h2>Product not found</h2><p>Status: ${res.status}</p>`
    );
  }

  const data = await res.json();
  const p = data.product || data;

  const title = p.title || 'Product';
  const price = Number(p.price_cents ?? 0); // raw, e.g. 130
  const img = p.image_url || '';
  const sellerName = p.seller && p.seller.name ? p.seller.name : 'Unknown seller';
  const stockText = p.stock != null ? p.stock : 'Unknown';

  const body = `
    <a href="/" class="link">← Back to home</a>
    <div style="display:flex;gap:2rem;margin-top:1rem;">
      <div>
        ${
          img
            ? `<img src="${img}" alt="${title}" style="max-width:320px;border-radius:8px;object-fit:cover;" />`
            : `<div style="width:320px;height:320px;border-radius:8px;border:1px solid #ddd;display:flex;align-items:center;justify-content:center;color:#aaa;">No image</div>`
        }
      </div>
      <div style="max-width:480px;">
        <h2>${title}</h2>
        <div class="price" style="font-size:1.4rem;font-weight:bold;margin-top:0.5rem;">$${price}</div>
        <div class="seller" style="color:#555;margin-top:0.3rem;">Sold by: <strong>${sellerName}</strong></div>
        <div style="margin-top:0.3rem;font-size:0.9rem;">In stock: <strong>${stockText}</strong></div>
        <p style="margin-top:1rem;white-space:pre-wrap;font-size:0.95rem;">${p.description || ''}</p>
        <div class="actions" style="margin-top:1rem;display:flex;gap:0.5rem;">
          <button class="btn" id="btn-add">Add to cart</button>
          <button class="btn secondary" id="btn-buy">Buy now</button>
        </div>
        <div id="product-msg" class="msg"></div>
      </div>
    </div>
  `;

  const extraScript = `
    <script>
      (function() {
        const productId = ${JSON.stringify(p.id)};
        const msgEl = document.getElementById('product-msg');

        async function addToCart(redirectToCheckout) {
          msgEl.textContent = '';
          msgEl.className = 'msg';
          try {
            const res = await fetch('/api/cart/items', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                product_id: productId,
                qty: 1,
                operation: 'add'
              })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              msgEl.textContent = data.error || 'Failed to add to cart.';
              msgEl.className = 'msg error';
              return;
            }
            msgEl.textContent = redirectToCheckout ? 'Added to cart, redirecting to checkout…' : 'Added to cart.';
            msgEl.className = 'msg ok';
            if (redirectToCheckout) {
              setTimeout(() => { window.location.href = '/checkout'; }, 600);
            }
          } catch (e) {
            msgEl.textContent = 'Error adding to cart.';
            msgEl.className = 'msg error';
          }
        }

        document.getElementById('btn-add')?.addEventListener('click', () => addToCart(false));
        document.getElementById('btn-buy')?.addEventListener('click', () => addToCart(true));
      })();
    </script>
  `;

  return layout(env, request, `${title} – Week1 Store`, body, { extraScript });
}

// ================== Cart ==================

// ---- Cart: get current user's cart ----
router.get('/api/cart', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const { results } = await env.DB.prepare(
      `SELECT
         ci.product_id,
         ci.qty,
         p.title,
         p.price_cents,
         p.currency,
         i.stock,
         i.reserved
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       LEFT JOIN inventory i ON i.product_id = ci.product_id
       WHERE ci.user_id = ?`
    )
      .bind(auth.user.id)
      .all();

    const items = results || [];
    const subtotal_cents = items.reduce(
      (sum, item) =>
        sum +
        Number(item.price_cents || 0) * Number(item.qty || 0),
      0
    );

    return json({
      ok: true,
      items,
      subtotal_cents
    });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- Cart: unified update (set/add/remove) ----
router.post('/api/cart/items', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { error, value } = cartUpdateSchema.validate(body, {
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
  const now = new Date().toISOString();

  try {
    // 1) Check product is active
    const product = await env.DB.prepare(
      `SELECT id, seller_id, status
       FROM products
       WHERE id = ?`
    )
      .bind(product_id)
      .first();

    if (!product || product.status !== 'active') {
      return json(
        { ok: false, error: 'Product is not available' },
        { status: 404 }
      );
    }

    // Sellers cannot buy their own product
    if (product.seller_id && product.seller_id === auth.user.id) {
      return json(
        { ok: false, error: 'You cannot add your own product to cart' },
        { status: 403 }
      );
    }

    // 2) Load inventory for this product
    const inv = await env.DB.prepare(
      `SELECT stock, reserved
       FROM inventory
       WHERE product_id = ?`
    )
      .bind(product_id)
      .first();

    const stock = inv ? Number(inv.stock || 0) : 0;
    const reserved = inv ? Number(inv.reserved || 0) : 0;
    const available = stock - reserved;

    // 3) Load current cart item (for this user + product)
    const existing = await env.DB.prepare(
      `SELECT qty
       FROM cart_items
       WHERE user_id = ? AND product_id = ?`
    )
      .bind(auth.user.id, product_id)
      .first();

    const currentQty = existing ? Number(existing.qty || 0) : 0;
    let newQty;

    // 4) Compute new quantity based on operation
    if (operation === 'set') {
      newQty = qty;
    } else if (operation === 'add') {
      newQty = currentQty + qty;
    } else if (operation === 'remove') {
      if (!existing) {
        return json(
          { ok: false, error: 'Item not found in cart' },
          { status: 404 }
        );
      }
      if (qty > currentQty) {
        return json(
          {
            ok: false,
            error: 'Cannot remove more than currently in cart',
            current_qty: currentQty
          },
          { status: 400 }
        );
      }
      newQty = currentQty - qty;
    } else {
      return json({ ok: false, error: 'Invalid operation' }, { status: 400 });
    }

    // 5) If user is increasing quantity, enforce stock limit
    const isIncreasing =
      (operation === 'set' || operation === 'add') && newQty > currentQty;

    if (isIncreasing) {
      if (available <= 0) {
        return json(
          {
            ok: false,
            error: 'Product is out of stock',
            available: 0
          },
          { status: 400 }
        );
      }

      if (newQty > available) {
        return json(
          {
            ok: false,
            error: 'Requested quantity exceeds available stock',
            available
          },
          { status: 400 }
        );
      }
    }

    // 6) If newQty <= 0, remove item from cart
    if (newQty <= 0) {
      if (existing) {
        await env.DB.prepare(
          `DELETE FROM cart_items
           WHERE user_id = ? AND product_id = ?`
        )
          .bind(auth.user.id, product_id)
          .run();
      }
      return json({ ok: true, qty: 0 });
    }

    // 7) Upsert row with newQty
    await env.DB.prepare(
      `INSERT INTO cart_items (user_id, product_id, qty, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, product_id)
       DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at`
    )
      .bind(auth.user.id, product_id, newQty, now)
      .run();

    return json({ ok: true, qty: newQty, available });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ================== Checkout ==================

// ---- Checkout: summary with normal/express shipping & addresses ----
router.get('/api/checkout/summary', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }

  try {
    // Cart items
    const cartRes = await env.DB.prepare(
      `SELECT
         ci.product_id,
         ci.qty,
         p.title,
         p.price_cents,
         p.currency,
         i.stock,
         i.reserved
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       LEFT JOIN inventory i ON i.product_id = ci.product_id
       WHERE ci.user_id = ?`
    )
      .bind(auth.user.id)
      .all();

    const items = cartRes.results || [];
    if (items.length === 0) {
      return json({ ok: false, error: 'Cart is empty' }, { status: 400 });
    }

    const subtotal_cents = items.reduce(
      (sum, item) =>
        sum +
        Number(item.price_cents || 0) * Number(item.qty || 0),
      0
    );

    // Addresses
    const addrRes = await env.DB.prepare(
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
      (addrRes.results || []).map(async (row) => ({
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

    if (addresses.length === 0) {
      return json(
        {
          ok: false,
          error: 'No addresses found. Please add a shipping address.'
        },
        { status: 400 }
      );
    }

    const shippingAddress =
      addresses.find((a) => a.is_default_shipping) || addresses[0];

    const zone = (shippingAddress.country || 'IN').toUpperCase();

    // Shipping methods
    const shippingRows = await env.DB.prepare(
      `SELECT id, name, zone, speed, base_cents, per_kg_cents, free_over_cents, active
       FROM shipping_methods
       WHERE active = 1 AND zone = ?`
    )
      .bind(zone)
      .all();

    const cap = Math.floor(subtotal_cents * 0.1); // max 10% of subtotal

    const shipping_options = (shippingRows.results || []).map((m) => {
      let cost = Number(m.base_cents || 0);

      if (
        m.free_over_cents != null &&
        subtotal_cents >= Number(m.free_over_cents)
      ) {
        cost = 0;
      }

      if (cost > 0 && cap > 0) {
        cost = Math.min(cost, cap);
      }

      return {
        id: m.id,
        name: m.name,
        zone: m.zone,
        speed: m.speed,
        cost_cents: cost
      };
    });

    if (shipping_options.length === 0) {
      return json(
        {
          ok: false,
          error: 'No shipping methods available for zone ' + zone
        },
        { status: 500 }
      );
    }

    if (shipping_options.length >= 2) {
      const standard = shipping_options.find(m => (m.speed || '').toLowerCase() === 'standard');
      const express  = shipping_options.find(m => (m.speed || '').toLowerCase() === 'express');
      if (standard && express && standard.cost_cents === express.cost_cents) {
        // +60% and +$2 (200 cents) for express (unless free)
        if (express.cost_cents > 0) {
          express.cost_cents = Math.ceil(express.cost_cents * 1.6) + 200;
        }
      }
    }

    return json({
      ok: true,
      items,
      subtotal_cents,
      addresses,
      selected_shipping_address_id: shippingAddress.id,
      shipping_options
    });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

// ---- Checkout: place order (no real payment) ----
router.post('/api/checkout/place-order', async (request, env, ctx) => {
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { error, value } = checkoutPlaceSchema.validate(body, {
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

  const { shipping_method_id, shipping_address_id } = value;

  try {
    // 1) Load cart items
    const cartResult = await env.DB.prepare(
      `SELECT
         ci.product_id,
         ci.qty,
         p.title,
         p.price_cents,
         p.currency,
         i.stock,
         i.reserved
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       LEFT JOIN inventory i ON i.product_id = ci.product_id
       WHERE ci.user_id = ?`
    )
      .bind(auth.user.id)
      .all();

    const items = cartResult.results || [];
    if (items.length === 0) {
      return json({ ok: false, error: 'Cart is empty' }, { status: 400 });
    }

    // 2) Compute subtotal and validate stock
    let subtotal_cents = 0;
    const now = new Date().toISOString();

    for (const item of items) {
      const price = Number(item.price_cents || 0);
      const qty = Number(item.qty || 0);
      const stock = Number(item.stock || 0);
      const reserved = Number(item.reserved || 0);
      const available = stock - reserved;

      if (qty > available) {
        return json(
          {
            ok: false,
            error: `Insufficient stock for product ${item.product_id}`,
            available
          },
          { status: 400 }
        );
      }

      subtotal_cents += price * qty;
    }

    // 3) Load shipping address and determine zone
    const shippingAddress = await env.DB.prepare(
      `SELECT id, country
       FROM addresses
       WHERE id = ? AND user_id = ?`
    )
      .bind(shipping_address_id, auth.user.id)
      .first();

    if (!shippingAddress) {
      return json(
        { ok: false, error: 'Shipping address not found' },
        { status: 400 }
      );
    }

    const zone = (shippingAddress.country || 'IN').toUpperCase();

    // 4) Load shipping method and validate zone
    const shippingMethod = await env.DB.prepare(
      `SELECT id, name, zone, speed, base_cents, per_kg_cents, free_over_cents, active
       FROM shipping_methods
       WHERE id = ? AND active = 1`
    )
      .bind(shipping_method_id)
      .first();

    if (!shippingMethod) {
      return json(
        { ok: false, error: 'Invalid or inactive shipping method' },
        { status: 400 }
      );
    }

    if (shippingMethod.zone !== zone) {
      return json(
        {
          ok: false,
          error: `Shipping method zone ${shippingMethod.zone} does not match address country zone ${zone}`
        },
        { status: 400 }
      );
    }

    // 5) Calculate shipping (with 10% cap)
    let shipping_cents = Number(shippingMethod.base_cents || 0);

    if (
      shippingMethod.free_over_cents != null &&
      subtotal_cents >= Number(shippingMethod.free_over_cents)
    ) {
      shipping_cents = 0;
    }

    // Fallback surcharge if standard/express end up same in DB
    if ((shippingMethod.speed || '').toLowerCase() === 'express' && shipping_cents > 0) {
      // Peek another method in this zone to compare quickly
      try {
        const alt = await env.DB.prepare(
          `SELECT base_cents, speed, free_over_cents FROM shipping_methods WHERE zone = ? AND active = 1`
        ).bind(zone).all();

        const computedPeer = (alt.results || []).find(r => (r.speed || '').toLowerCase() === 'standard');
        if (computedPeer) {
          let peerCost = Number(computedPeer.base_cents || 0);
          if (computedPeer.free_over_cents != null && subtotal_cents >= Number(computedPeer.free_over_cents)) {
            peerCost = 0;
          }
          const capPeer = Math.floor(subtotal_cents * 0.1);
          if (peerCost > 0 && capPeer > 0) peerCost = Math.min(peerCost, capPeer);

          if (peerCost === shipping_cents && shipping_cents > 0) {
            shipping_cents = Math.ceil(shipping_cents * 1.6) + 200;
          }
        }
      } catch { /* ignore */ }
    }

    const cap = Math.floor(subtotal_cents * 0.1);
    if (shipping_cents > 0 && cap > 0) {
      shipping_cents = Math.min(shipping_cents, cap);
    }

    const tax_cents = 0;
    const total_cents = subtotal_cents + shipping_cents;
    const orderId = crypto.randomUUID();
    const billing_address_id = value.billing_address_id || shippingAddress.id;

    // 6) Insert order
    await env.DB.prepare(
      `INSERT INTO orders (
        id,
        user_id,
        status,
        subtotal_cents,
        shipping_cents,
        tax_cents,
        total_cents,
        currency,
        shipping_address_id,
        billing_address_id,
        shipping_method_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        orderId,
        auth.user.id,
        'placed',
        subtotal_cents,
        shipping_cents,
        tax_cents,
        total_cents,
        'USD',
        shippingAddress.id,
        billing_address_id,
        shippingMethod.id,
        now,
        now
      )
      .run();

    // 7) Insert order_items and update inventory sequentially
    for (const item of items) {
      const price = Number(item.price_cents || 0);
      const qty = Number(item.qty || 0);

      await env.DB.prepare(
        `INSERT INTO order_items (
          id,
          order_id,
          product_id,
          title_snapshot,
          price_cents,
          qty
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          orderId,
          item.product_id,
          item.title,
          price,
          qty
        )
        .run();

      await env.DB.prepare(
        `UPDATE inventory
         SET stock = stock - ?, updated_at = ?
         WHERE product_id = ?`
      )
        .bind(qty, now, item.product_id)
        .run();
    }

    // 8) Clear cart
    await env.DB.prepare(
      `DELETE FROM cart_items
       WHERE user_id = ?`
    )
      .bind(auth.user.id)
      .run();

    // 9) Notify realtime + logging services (non-blocking)
    try {
      if (env.REALTIME_SERVICE) {
        const url = new URL(request.url);
        url.pathname = '/internal/order-status';

        const payload = {
          user_id: auth.user.id,
          order_id: orderId,
          status: 'placed'
        };

        const realtimeReq = new Request(url.toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });

        ctx.waitUntil(env.REALTIME_SERVICE.fetch(realtimeReq));
      }
    } catch (e) {
      // ignore realtime failures for now
    }

    try {
      await callLogger("info", "order placed", { user_id: auth.user.id, order_id: orderId, total_cents: total_cents })
    } catch (e) {
      // ignore logging failures for now
    }

    // 10) Return order summary
    return json({
      ok: true,
      order: {
        id: orderId,
        status: 'placed',
        subtotal_cents,
        shipping_cents,
        tax_cents,
        total_cents,
        currency: 'USD',
        shipping_method: {
          id: shippingMethod.id,
          name: shippingMethod.name,
          speed: shippingMethod.speed
        },
        shipping_address_id: shippingAddress.id,
        billing_address_id
      }
    });
  } catch (err) {
    return json({ ok: false, error: String(err) }, { status: 500 });
  }
});

router.get('/health', async (request, env, ctx) => {
  try {
    await env.DB.prepare('SELECT 1').first();
    return json({
      ok: true,
      service: 'checkout',
      db: 'up',
      ts: new Date().toISOString()
    });
  } catch (err) {
    return json(
      {
        ok: false,
        service: 'checkout',
        db: 'error',
        error: String(err)
      },
      { status: 500 }
    );
  }
});


// 404 fallback
router.all('*', () =>
  json({ ok: false, error: 'Not found (checkout worker)' }, { status: 404 })
);

export default {
  fetch: (request, env, ctx) => router.fetch(request, env, ctx)
};
