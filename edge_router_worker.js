import { Router } from 'itty-router';
import { json } from './common.js';

// ---- Simple helper to proxy to a bound service ----
async function proxyToService(service, request, newPath) {
  if (!service || typeof service.fetch !== 'function') {
    return json(
      { ok: false, error: 'Service binding not configured correctly' },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  if (newPath) {
    url.pathname = newPath;
  }

  const proxiedRequest = new Request(url.toString(), request);
  return service.fetch(proxiedRequest);
}

// ---- Helper: format amounts without /100 ----
// If price_cents = 130, we show "130" (no decimals).
function formatAmountRaw(v) {
  const n = Number(v || 0);
  return n.toString();
}

// ---- Helper: call auth service to get current user ----
async function getMe(env, request) {
  try {
    if (!env.AUTH_SERVICE || typeof env.AUTH_SERVICE.fetch !== 'function') {
      return null;
    }
    const url = new URL(request.url);
    url.pathname = '/api/me';
    const res = await env.AUTH_SERVICE.fetch(
      new Request(url.toString(), request)
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) return null;
    return data.user || null;
  } catch {
    return null;
  }
}

// ---- Build nav based on auth status ----
async function buildNav(env, request) {
  const user = await getMe(env, request);

  const links = [
    `<a href="/">Home</a>`,
    `<a href="/products">Products</a>`,
    `<a href="/cart">Cart</a>`,
    `<a href="/orders">Orders</a>`
  ];

  if (!user) {
    links.push(`<a href="/login">Login</a>`);
    links.push(`<a href="/signup">Signup</a>`);
  } else {
    links.push(`<a href="/profile">Profile</a>`);
    links.push(`<a href="/addresses">Addresses</a>`);
    if (user.role === 'seller' || user.role === 'admin') {
      links.push(`<a href="/seller/products">My products</a>`);
      links.push(`<a href="/seller/orders">Sold orders</a>`);
    }
    links.push(`<a href="#" id="navLogout">Logout</a>`);
  }

  return `<nav>${links.join('')}</nav>`;
}

// ---- Render HTML layout (sync) ----
function renderLayout(title, navHtml, body, options = {}) {
  const extraHead = options.extraHead || '';
  const pageScript = options.extraScript || '';

  const globalScript = `
    <script>
      (function() {
        const logoutLink = document.getElementById('navLogout');
        if (logoutLink) {
          logoutLink.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
              await fetch('/api/auth/logout', { method: 'POST' });
            } catch (err) {}
            window.location.href = '/login';
          });
        }
      })();
    </script>
  `;

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; margin: 2rem; max-width: 960px; }
      header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
      nav a { margin-left: 0.75rem; text-decoration: none; color: #0070f3; font-size: 0.9rem; }
      nav a:hover { text-decoration: underline; }
      .btn { padding: 0.4rem 0.9rem; border-radius: 4px; border: 1px solid #333; background: #111; color: white; cursor: pointer; font-size: 0.9rem; }
      .btn.secondary { background: #fff; color: #111; }
      .btn.sm { padding: 0.25rem 0.6rem; font-size: 0.8rem; }
      input, select, textarea { padding: 0.3rem 0.45rem; border-radius: 4px; border: 1px solid #ccc; font-size: 0.9rem; width: 100%; box-sizing: border-box; }
      label { display: block; margin-bottom: 0.25rem; font-size: 0.85rem; color: #444; }
      form > div { margin-bottom: 0.75rem; }
      table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.9rem; }
      th, td { padding: 0.45rem; border-bottom: 1px solid #eee; text-align: left; }
      th { background: #fafafa; }
      .pill { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 999px; background: #eee; font-size: 0.75rem; }
      .msg { margin-top: 0.75rem; font-size: 0.85rem; }
      .msg.error { color: #b00020; }
      .msg.ok { color: #007500; }
      .link { color: #0070f3; text-decoration: none; }
      .link:hover { text-decoration: underline; }
    </style>
    ${extraHead}
  </head>
  <body>
    <header>
      <h1>Week1 Ecommerce</h1>
      ${navHtml}
    </header>
    ${body}
    ${globalScript}
    ${pageScript}
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
}

// ---- Async helper: get nav + render layout ----
async function layout(env, request, title, body, options = {}) {
  const nav = await buildNav(env, request);
  return renderLayout(title, nav, body, options);
}

// ================== SSR PAGES ==================

// ---- Home: product list ----
async function renderHomePage(env, request) {
  const url = new URL(request.url);
  url.pathname = '/api/products';
  const apiReq = new Request(url.toString(), request);

  const res = await env.CATALOG_SERVICE.fetch(apiReq);
  if (!res.ok) {
    return layout(
      env,
      request,
      'Week1 Store – Home',
      `<h2>Products</h2><p>Failed to load products (status ${res.status}).</p>`
    );
  }

  const data = await res.json();
  const products = data.products || [];

  const itemsHtml = products
    .map((p) => {
      const price = formatAmountRaw(p.price_cents);
      return `
        <a class="card" href="/product/${p.id}" style="border:1px solid #ddd;border-radius:8px;padding:0.75rem;text-decoration:none;color:inherit;display:flex;gap:0.75rem;align-items:flex-start;margin-bottom:0.75rem;">
          <div style="width:80px;height:80px;border-radius:6px;overflow:hidden;background:#fafafa;flex-shrink:0;display:flex;align-items:center;justify-content:center;">
            ${
              p.image_url
                ? `<img src="${p.image_url}" alt="${p.title}" style="width:100%;height:100%;object-fit:cover;" />`
                : `<span style="color:#aaa;font-size:0.8rem;">No image</span>`
            }
          </div>
          <div style="flex:1;">
            <div style="font-weight:600;">${p.title}</div>
            <div style="font-size:0.9rem;margin-top:0.15rem;">$${price}</div>
            ${
              p.seller && p.seller.name
                ? `<div style="font-size:0.8rem;color:#666;margin-top:0.1rem;">by ${p.seller.name}</div>`
                : ''
            }
          </div>
        </a>
      `;
    })
    .join('');

  const body = `
    <h2>Products</h2>
    <p style="font-size:0.9rem;color:#555;">Browse products below. Click on a product to view details and add it to your cart.</p>
    <div>
      ${itemsHtml || '<p>No products yet.</p>'}
    </div>
  `;

  return layout(env, request, 'Week1 Store – Home', body);
}

// ---- Product detail page ----
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

// ---- Login page ----
async function renderLoginPage(env, request) {
  const body = `
    <h2>Login</h2>
    <form id="loginForm" style="max-width:360px;margin-top:1rem;">
      <div>
        <label>Email</label>
        <input name="email" type="email" required />
      </div>
      <div>
        <label>Password</label>
        <input name="password" type="password" required minlength="8" />
      </div>
      <button type="submit" class="btn">Login</button>
      <a href="/signup" class="link" style="margin-left:0.5rem;font-size:0.85rem;">Create account</a>
      <div style="margin-top:0.4rem;">
        <a href="#" id="forgotLink" class="link" style="font-size:0.8rem;">Forgot password (instant reset demo)</a>
      </div>
    </form>
    <div id="loginMsg" class="msg"></div>
  `;

  const extraScript = `
    <script>
      (function() {
        const form = document.getElementById('loginForm');
        const msg = document.getElementById('loginMsg');

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          msg.textContent = '';
          msg.className = 'msg';
          const formData = new FormData(form);
          const body = {
            email: formData.get('email'),
            password: formData.get('password')
          };
          try {
            const res = await fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              msg.textContent = data.error || 'Login failed.';
              msg.className = 'msg error';
              return;
            }
            msg.textContent = 'Logged in! Redirecting…';
            msg.className = 'msg ok';
            setTimeout(() => { window.location.href = '/'; }, 600);
          } catch (err) {
            msg.textContent = 'Error logging in.';
            msg.className = 'msg error';
          }
        });

        document.getElementById('forgotLink').addEventListener('click', async (e) => {
          e.preventDefault();
          const email = prompt('Enter your email to reset (demo: new password = "new-password-123")');
          if (!email) return;
          try {
            const res = await fetch('/api/auth/forgot-password', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                email,
                new_password: 'new-password-123'
              })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              alert(data.error || 'Reset failed');
            } else {
              alert('Password reset to "new-password-123". Please login with that.');
            }
          } catch (err) {
            alert('Error performing reset');
          }
        });
      })();
    </script>
  `;

  return layout(env, request, 'Login – Week1 Store', body, { extraScript });
}

// ---- Signup page ----
async function renderSignupPage(env, request) {
  const body = `
    <h2>Create account</h2>
    <form id="signupForm" style="max-width:420px;margin-top:1rem;">
      <div>
        <label>Name</label>
        <input name="name" required />
      </div>
      <div>
        <label>Email</label>
        <input name="email" type="email" required />
      </div>
      <div>
        <label>Phone (optional)</label>
        <input name="phone" />
      </div>
      <div>
        <label>Password</label>
        <input name="password" type="password" required minlength="8" />
      </div>
      <div>
        <label>Role</label>
        <select name="role">
          <option value="buyer">Buyer</option>
          <option value="seller">Seller</option>
        </select>
      </div>
      <button type="submit" class="btn">Sign up</button>
      <a href="/login" class="link" style="margin-left:0.5rem;font-size:0.85rem;">Already have an account?</a>
    </form>
    <div id="signupMsg" class="msg"></div>
  `;

  const extraScript = `
    <script>
      (function() {
        const form = document.getElementById('signupForm');
        const msg = document.getElementById('signupMsg');

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          msg.textContent = '';
          msg.className = 'msg';
          const fd = new FormData(form);
          const body = {
            name: fd.get('name'),
            email: fd.get('email'),
            phone: fd.get('phone') || null,
            password: fd.get('password'),
            role: fd.get('role') || 'buyer'
          };
          try {
            const res = await fetch('/api/users/register', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              msg.textContent = (data.error || 'Signup failed.') + (data.details ? ' ' + data.details.join(', ') : '');
              msg.className = 'msg error';
              return;
            }
            msg.textContent = 'Account created! Redirecting to login…';
            msg.className = 'msg ok';
            setTimeout(() => { window.location.href = '/login'; }, 800);
          } catch (err) {
            msg.textContent = 'Error signing up.';
            msg.className = 'msg error';
          }
        });
      })();
    </script>
  `;

  return layout(env, request, 'Signup – Week1 Store', body, { extraScript });
}

// ---- Cart page ----
async function renderCartPage(env, request) {
  const body = `
    <h2>Your cart</h2>
    <p style="font-size:0.9rem;color:#555;">You must be logged in to see your cart.</p>
    <div id="cartContainer" style="margin-top:1rem;">Loading…</div>
    <div style="margin-top:1rem;">
      <button class="btn" id="btnCheckout">Go to checkout</button>
      <button class="btn secondary" id="btnReload" style="margin-left:0.5rem;">Reload cart</button>
    </div>
    <div id="cartMsg" class="msg"></div>
  `;

  const extraScript = `
    <script>
      (function() {
        const container = document.getElementById('cartContainer');
        const msg = document.getElementById('cartMsg');

        async function loadCart() {
          container.textContent = 'Loading…';
          msg.textContent = '';
          msg.className = 'msg';
          try {
            const res = await fetch('/api/cart');
            if (res.status === 401) {
              container.innerHTML = '<p>You are not logged in. <a href="/login" class="link">Login</a> to view your cart.</p>';
              return;
            }
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              container.textContent = data.error || 'Failed to load cart.';
              return;
            }
            const items = data.items || [];
            if (!items.length) {
              container.innerHTML = '<p>Your cart is empty.</p>';
              return;
            }
            let rows = items.map(item => {
              const unit = Number(item.price_cents || 0);
              const line = unit * Number(item.qty || 0);
              return \`
                <tr data-product-id="\${item.product_id}">
                  <td>\${item.title}</td>
                  <td>$\${unit}</td>
                  <td>
                    <button class="btn sm btn-minus">-</button>
                    <span class="qty" style="display:inline-block;width:1.5rem;text-align:center;">\${item.qty}</span>
                    <button class="btn sm btn-plus">+</button>
                  </td>
                  <td>$\${line}</td>
                </tr>
              \`;
            }).join('');
            container.innerHTML = \`
              <table>
                <thead>
                  <tr><th>Product</th><th>Price</th><th>Qty</th><th>Line total</th></tr>
                </thead>
                <tbody>\${rows}</tbody>
              </table>
              <p style="margin-top:0.75rem;font-weight:600;">Subtotal: $\${data.subtotal_cents}</p>
            \`;
          } catch (err) {
            container.textContent = 'Error loading cart.';
          }
        }

        container.addEventListener('click', async (e) => {
          const btn = e.target.closest('button');
          if (!btn) return;
          const row = btn.closest('tr');
          if (!row) return;
          const productId = row.getAttribute('data-product-id');
          let op;
          if (btn.classList.contains('btn-plus')) {
            op = 'add';
          } else if (btn.classList.contains('btn-minus')) {
            op = 'remove';
          } else {
            return;
          }
          try {
            const res = await fetch('/api/cart/items', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                product_id: productId,
                qty: 1,
                operation: op
              })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              msg.textContent = data.error || 'Failed to update cart.';
              msg.className = 'msg error';
              return;
            }
            await loadCart();
          } catch (err) {
            msg.textContent = 'Error updating cart.';
            msg.className = 'msg error';
          }
        });

        document.getElementById('btnCheckout').addEventListener('click', () => {
          window.location.href = '/checkout';
        });
        document.getElementById('btnReload').addEventListener('click', loadCart);

        loadCart();
      })();
    </script>
  `;

  return layout(env, request, 'Cart – Week1 Store', body, { extraScript });
}

// ---- Checkout page ----
async function renderCheckoutPage(env, request) {
  const body = `
    <h2>Checkout</h2>
    <p style="font-size:0.9rem;color:#555;">Review your cart, choose a shipping address and method, then place your order.</p>
    <div id="checkoutContainer" style="margin-top:1rem;">Loading…</div>
    <div id="checkoutMsg" class="msg"></div>
  `;

  const extraScript = `
    <script>
      (function() {
        const container = document.getElementById('checkoutContainer');
        const msg = document.getElementById('checkoutMsg');

        async function loadSummary() {
          container.textContent = 'Loading…';
          msg.textContent = '';
          msg.className = 'msg';
          try {
            const res = await fetch('/api/checkout/summary');
            const data = await res.json().catch(() => ({}));
            if (res.status === 401) {
              container.innerHTML = '<p>You are not logged in. <a href="/login" class="link">Login</a> to checkout.</p>';
              return;
            }
            if (!res.ok || !data.ok) {
              container.innerHTML = '<p>' + (data.error || 'Failed to load checkout summary.') + '</p>';
              return;
            }
            const items = data.items || [];
            const addresses = data.addresses || [];
            const shipping = data.shipping_options || [];

            const itemsHtml = items.map(item => {
              const unit = Number(item.price_cents || 0);
              const line = unit * Number(item.qty || 0);
              return \`
                <tr>
                  <td>\${item.title}</td>
                  <td>$\${unit}</td>
                  <td>\${item.qty}</td>
                  <td>$\${line}</td>
                </tr>
              \`;
            }).join('');

            const addressOptions = addresses.map(a => {
              const label = \`\${a.name} – \${a.line1}, \${a.city}, \${a.country}\`;
              return \`<option value="\${a.id}" \${a.id === data.selected_shipping_address_id ? 'selected' : ''}>\${label}</option>\`;
            }).join('');

            const shippingOptions = shipping.map(s => {
              return \`<option value="\${s.id}">\${s.name} (\${s.speed}) – $\${s.cost_cents}\</option>\`;
            }).join('');

            container.innerHTML = \`
              <h3>Items</h3>
              <table>
                <thead><tr><th>Product</th><th>Price</th><th>Qty</th><th>Line total</th></tr></thead>
                <tbody>\${itemsHtml}</tbody>
              </table>
              <p style="margin-top:0.5rem;font-weight:600;">Subtotal: $\${data.subtotal_cents}</p>

              <h3 style="margin-top:1.25rem;">Shipping & address</h3>
              <form id="checkoutForm" style="max-width:420px;margin-top:0.5rem;">
                <div>
                  <label>Shipping address</label>
                  <select name="shipping_address_id">\${addressOptions}</select>
                </div>
                <div>
                  <label>Shipping method</label>
                  <select name="shipping_method_id">\${shippingOptions}</select>
                </div>
                <button type="submit" class="btn">Place order</button>
              </form>
            \`;
          } catch (err) {
            container.textContent = 'Error loading checkout summary.';
          }
        }

        document.addEventListener('submit', async (e) => {
          const form = e.target;
          if (form.id !== 'checkoutForm') return;
          e.preventDefault();
          msg.textContent = '';
          msg.className = 'msg';

          const fd = new FormData(form);
          const body = {
            shipping_address_id: fd.get('shipping_address_id'),
            shipping_method_id: fd.get('shipping_method_id')
          };

          try {
            const res = await fetch('/api/checkout/place-order', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              msg.textContent = data.error || 'Failed to place order.';
              msg.className = 'msg error';
              return;
            }
            msg.textContent = 'Order placed! Redirecting to order details…';
            msg.className = 'msg ok';
            const orderId = data.order && data.order.id;
            if (orderId) {
              setTimeout(() => { window.location.href = '/orders/' + orderId; }, 700);
            }
          } catch (err) {
            msg.textContent = 'Error placing order.';
            msg.className = 'msg error';
          }
        });

        loadSummary();
      })();
    </script>
  `;

  return layout(env, request, 'Checkout – Week1 Store', body, { extraScript });
}

// ---- Buyer orders list ----
async function renderOrdersPage(env, request) {
  const body = `
    <h2>Your orders</h2>
    <p style="font-size:0.9rem;color:#555;">You must be logged in to see your orders.</p>
    <div id="ordersContainer" style="margin-top:1rem;">Loading…</div>
    <div id="ordersMsg" class="msg"></div>
  `;

  const extraScript = `
    <script>
      (function() {
        const container = document.getElementById('ordersContainer');
        const msg = document.getElementById('ordersMsg');

        async function loadOrders() {
          container.textContent = 'Loading…';
          msg.textContent = '';
          msg.className = 'msg';
          try {
            const res = await fetch('/api/orders');
            if (res.status === 401) {
              container.innerHTML = '<p>You are not logged in. <a href="/login" class="link">Login</a> to view your orders.</p>';
              return;
            }
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              container.textContent = data.error || 'Failed to load orders.';
              return;
            }
            const orders = data.orders || [];
            if (!orders.length) {
              container.innerHTML = '<p>You have no orders yet.</p>';
              return;
            }
            const rows = orders.map(o => {
              const total = o.total_cents;
              return \`
                <tr>
                  <td><a href="/orders/\${o.id}" class="link">\${o.id}</a></td>
                  <td><span class="pill">\${o.status}</span></td>
                  <td>$\${total}</td>
                  <td>\${o.created_at || ''}</td>
                </tr>
              \`;
            }).join('');
            container.innerHTML = \`
              <table>
                <thead><tr><th>Order ID</th><th>Status</th><th>Total</th><th>Created at</th></tr></thead>
                <tbody>\${rows}</tbody>
              </table>
            \`;
          } catch (err) {
            container.textContent = 'Error loading orders.';
          }
        }

        loadOrders();
      })();
    </script>
  `;

  return layout(env, request, 'Orders – Week1 Store', body, { extraScript });
}

// ---- Single order page with WebSocket ----
async function renderOrderDetailPage(env, request, orderId) {
  const body = `
    <a href="/orders" class="link">← Back to orders</a>
    <h2 style="margin-top:0.75rem;">Order <code>${orderId}</code></h2>
    <div id="orderMeta" style="margin-top:0.5rem;font-size:0.9rem;">Loading…</div>
    <div id="orderItems" style="margin-top:1rem;"></div>
    <div id="orderMsg" class="msg"></div>
  `;

  const extraScript = `
    <script>
      (function() {
        const orderId = ${JSON.stringify(orderId)};
        const metaEl = document.getElementById('orderMeta');
        const itemsEl = document.getElementById('orderItems');
        const msgEl = document.getElementById('orderMsg');

        async function loadOrder() {
          metaEl.textContent = 'Loading…';
          itemsEl.textContent = '';
          msgEl.textContent = '';
          msgEl.className = 'msg';

          try {
            const res = await fetch('/api/orders/' + encodeURIComponent(orderId));
            if (res.status === 401) {
              metaEl.innerHTML = '<p>You are not logged in. <a href="/login" class="link">Login</a>.</p>';
              return;
            }
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              metaEl.textContent = data.error || 'Order not found.';
              return;
            }
            const o = data.order || {};
            metaEl.innerHTML =
              '<div>Status: <span id="orderStatus" class="pill">' + o.status + '</span> · Total: $' +
              (o.total_cents || 0) +
              '</div>' +
              '<div style="margin-top:0.25rem;">Placed at: ' + (o.created_at || '') + '</div>';

            const items = (o.items || []);
            if (!items.length) {
              itemsEl.innerHTML = '<p>No items recorded for this order.</p>';
              return;
            }
            const rows = items.map(it => {
              const unit = Number(it.price_cents || 0);
              const line = unit * Number(it.qty || 0);
              const title = it.title_snapshot || it.title || it.product_id;
              return '<tr><td>' + title +
                     '</td><td>$' + unit +
                     '</td><td>' + it.qty +
                     '</td><td>$' + line +
                     '</td></tr>';
            }).join('');
            itemsEl.innerHTML =
              '<h3>Items</h3><table><thead><tr><th>Product</th><th>Price</th><th>Qty</th><th>Line total</th></tr></thead><tbody>' +
              rows + '</tbody></table>';
          } catch (err) {
            metaEl.textContent = 'Error loading order.';
          }
        }

        function connectWebSocket() {
          try {
            const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = proto + '//' + window.location.host + '/ws/orders';
            const ws = new WebSocket(wsUrl);

            ws.onopen = () => {
              msgEl.textContent = 'Connected for live status updates.';
              msgEl.className = 'msg ok';
            };

            ws.onmessage = (event) => {
              try {
                const data = JSON.parse(event.data);
                if (data.type === 'order_status' && data.order_id === orderId) {
                  const statusEl = document.getElementById('orderStatus');
                  if (statusEl) statusEl.textContent = data.status;
                  msgEl.textContent = 'Order status updated: ' + data.status;
                  msgEl.className = 'msg ok';
                }
              } catch (e) {}
            };

            ws.onerror = () => {
              msgEl.textContent = 'WebSocket error. Live updates may not work.';
              msgEl.className = 'msg error';
            };
          } catch (err) {
            msgEl.textContent = 'Could not connect WebSocket.';
            msgEl.className = 'msg error';
          }
        }

        loadOrder();
        connectWebSocket();
      })();
    </script>
  `;

  return layout(env, request, `Order ${orderId} – Week1 Store`, body, { extraScript });
}

// ---- Profile page ----
async function renderProfilePage(env, request) {
  const body = `
    <h2>Your profile</h2>
    <p style="font-size:0.9rem;color:#555;">View and update your profile information.</p>

    <div style="display:flex;gap:1.5rem;align-items:flex-start;margin-top:1rem;">
      <div>
        <div id="avatarPreview" style="width:96px;height:96px;border-radius:999px;overflow:hidden;background:#eee;display:flex;align-items:center;justify-content:center;font-size:0.8rem;color:#999;">
          No avatar
        </div>
        <form id="avatarForm" style="margin-top:0.5rem;">
          <input type="file" name="file" accept="image/*" />
          <button type="submit" class="btn sm" style="margin-top:0.3rem;">Upload</button>
        </form>
      </div>

      <div style="flex:1;">
        <form id="profileForm" style="max-width:420px;">
          <div>
            <label>Name</label>
            <input name="name" />
          </div>
          <div>
            <label>Email (read-only)</label>
            <input name="email" disabled />
          </div>
          <div>
            <label>Phone</label>
            <input name="phone" />
          </div>
          <button type="submit" class="btn">Save</button>
        </form>
        <button id="deleteAccount" class="btn secondary" style="margin-top:0.75rem;">Delete account</button>
        <div id="profileMsg" class="msg"></div>
      </div>
    </div>
  `;

  const extraScript = `
    <script>
      (function() {
        const form = document.getElementById('profileForm');
        const msg = document.getElementById('profileMsg');
        const deleteBtn = document.getElementById('deleteAccount');
        const avatarBox = document.getElementById('avatarPreview');
        const avatarForm = document.getElementById('avatarForm');
        const avatarInput = avatarForm.querySelector('input[name="file"]');

        function setAvatar(url) {
          if (url) {
            avatarBox.innerHTML = '<img src="' + url + '" style="width:100%;height:100%;object-fit:cover;" />';
          } else {
            avatarBox.textContent = 'No avatar';
          }
        }

        async function loadProfile() {
          msg.textContent = '';
          msg.className = 'msg';
          try {
            const res = await fetch('/api/users/me/profile');
            if (res.status === 401) {
              document.getElementById('profileContainer')?.innerHTML &&
                (document.getElementById('profileContainer').innerHTML =
                  '<p>You are not logged in. <a href="/login" class="link">Login</a>.</p>');
              return;
            }
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              msg.textContent = data.error || 'Failed to load profile.';
              msg.className = 'msg error';
              return;
            }
            const u = data.user || {};
            form.elements.name.value = u.name || '';
            form.elements.email.value = u.email || '';
            form.elements.phone.value = u.phone || '';
            setAvatar(u.avatar_url || '');
          } catch (err) {
            msg.textContent = 'Error loading profile.';
            msg.className = 'msg error';
          }
        }

        // Update name/phone
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          msg.textContent = '';
          msg.className = 'msg';
          const body = {
            name: form.elements.name.value || undefined,
            phone: form.elements.phone.value || undefined
          };
          try {
            const res = await fetch('/api/users/me', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              msg.textContent = data.error || 'Failed to update profile.';
              msg.className = 'msg error';
              return;
            }
            msg.textContent = 'Profile updated.';
            msg.className = 'msg ok';
          } catch (err) {
            msg.textContent = 'Error updating profile.';
            msg.className = 'msg error';
          }
        });

        // Upload avatar
        avatarForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          msg.textContent = '';
          msg.className = 'msg';

          if (!avatarInput.files || !avatarInput.files[0]) {
            msg.textContent = 'Please choose an image file first.';
            msg.className = 'msg error';
            return;
          }

          const fd = new FormData();
          fd.append('file', avatarInput.files[0]);

          try {
            const res = await fetch('/api/users/me/avatar', {
              method: 'POST',
              body: fd
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              msg.textContent = data.error || 'Failed to upload avatar.';
              msg.className = 'msg error';
              return;
            }
            setAvatar(data.avatar_url);
            msg.textContent = 'Avatar updated.';
            msg.className = 'msg ok';
          } catch (err) {
            msg.textContent = 'Error uploading avatar.';
            msg.className = 'msg error';
          }
        });

        // Delete account
        deleteBtn.addEventListener('click', async () => {
          if (!confirm('Are you sure? This will delete your account.')) return;
          try {
            const res = await fetch('/api/users/me', { method: 'DELETE' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              alert(data.error || 'Failed to delete account.');
              return;
            }
            alert('Account deleted.');
            window.location.href = '/signup';
          } catch (err) {
            alert('Error deleting account.');
          }
        });

        loadProfile();
      })();
    </script>
  `;

  return layout(env, request, 'Profile – Week1 Store', body, { extraScript });
}

// ---- Addresses page ----
async function renderAddressesPage(env, request) {
  const body = `
    <h2>Your addresses</h2>
    <p style="font-size:0.9rem;color:#555;">Manage your shipping and billing addresses.</p>
    <div id="addrContainer" style="margin-top:1rem;">Loading…</div>

    <h3 style="margin-top:1.5rem;">Add / edit address</h3>
    <form id="addrForm" style="max-width:480px;margin-top:0.5rem;">
      <input type="hidden" name="id" />
      <div>
        <label>Name</label>
        <input name="name" required />
      </div>
      <div>
        <label>Line 1</label>
        <input name="line1" required />
      </div>
      <div>
        <label>Line 2</label>
        <input name="line2" />
      </div>
      <div>
        <label>City</label>
        <input name="city" required />
      </div>
      <div>
        <label>State</label>
        <input name="state" required />
      </div>
      <div>
        <label>Postal</label>
        <input name="postal" required />
      </div>
      <div>
        <label>Country (2-letter code)</label>
        <input name="country" required maxlength="2" />
      </div>
      <div>
        <label><input type="checkbox" name="is_default_shipping" /> Default shipping</label>
      </div>
      <div>
        <label><input type="checkbox" name="is_default_billing" /> Default billing</label>
      </div>
      <button type="submit" class="btn">Save address</button>
      <button type="button" id="addrFormReset" class="btn secondary" style="margin-left:0.5rem;">Clear form</button>
    </form>
    <div id="addrMsg" class="msg"></div>
  `;

  const extraScript = `
    <script>
      (function() {
        const container = document.getElementById('addrContainer');
        const form = document.getElementById('addrForm');
        const msg = document.getElementById('addrMsg');
        const resetBtn = document.getElementById('addrFormReset');

        function fillForm(addr) {
          form.elements.id.value = addr.id || '';
          form.elements.name.value = addr.name || '';
          form.elements.line1.value = addr.line1 || '';
          form.elements.line2.value = addr.line2 || '';
          form.elements.city.value = addr.city || '';
          form.elements.state.value = addr.state || '';
          form.elements.postal.value = addr.postal || '';
          form.elements.country.value = addr.country || '';
          form.elements.is_default_shipping.checked = !!addr.is_default_shipping;
          form.elements.is_default_billing.checked = !!addr.is_default_billing;
        }

        function clearForm() {
          fillForm({
            id: '',
            name: '',
            line1: '',
            line2: '',
            city: '',
            state: '',
            postal: '',
            country: '',
            is_default_shipping: false,
            is_default_billing: false
          });
          msg.textContent = '';
          msg.className = 'msg';
        }

        async function loadAddresses() {
          container.textContent = 'Loading…';
          try {
            const res = await fetch('/api/addresses');
            if (res.status === 401) {
              container.innerHTML = '<p>You are not logged in. <a href="/login" class="link">Login</a>.</p>';
              return;
            }
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              container.textContent = data.error || 'Failed to load addresses.';
              return;
            }
            const addresses = data.addresses || [];
            if (!addresses.length) {
              container.innerHTML = '<p>You have no addresses yet.</p>';
              return;
            }
            const rows = addresses.map(a => {
              const flags = [
                a.is_default_shipping ? 'default shipping' : '',
                a.is_default_billing ? 'default billing' : ''
              ].filter(Boolean).join(', ');
              return \`
                <tr data-id="\${a.id}">
                  <td>\${a.name}</td>
                  <td>\${a.line1}, \${a.city}, \${a.country}</td>
                  <td>\${flags || '-'}</td>
                  <td>
                    <button class="btn sm addr-edit">Edit</button>
                    <button class="btn sm addr-delete">Delete</button>
                  </td>
                </tr>
              \`;
            }).join('');
            container.innerHTML = \`
              <table>
                <thead><tr><th>Name</th><th>Address</th><th>Flags</th><th></th></tr></thead>
                <tbody>\${rows}</tbody>
              </table>
            \`;
          } catch (err) {
            container.textContent = 'Error loading addresses.';
          }
        }

        container.addEventListener('click', async (e) => {
          const btn = e.target.closest('button');
          if (!btn) return;
          const row = btn.closest('tr');
          if (!row) return;
          const id = row.getAttribute('data-id');

          if (btn.classList.contains('addr-edit')) {
            // For demo, just reload addresses and find this one from last response
            try {
              const res = await fetch('/api/addresses');
              const data = await res.json().catch(() => ({}));
              if (!res.ok || !data.ok) return;
              const addr = (data.addresses || []).find(a => a.id === id);
              if (!addr) return;
              fillForm(addr);
              window.scrollTo({ top: form.offsetTop - 20, behavior: 'smooth' });
            } catch (err) {}
          } else if (btn.classList.contains('addr-delete')) {
            if (!confirm('Delete this address?')) return;
            try {
              const res = await fetch('/api/addresses', {
                method: 'DELETE',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id })
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok || !data.ok) {
                msg.textContent = data.error || 'Failed to delete address.';
                msg.className = 'msg error';
                return;
              }
              msg.textContent = 'Address deleted.';
              msg.className = 'msg ok';
              await loadAddresses();
            } catch (err) {
              msg.textContent = 'Error deleting address.';
              msg.className = 'msg error';
            }
          }
        });

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          msg.textContent = '';
          msg.className = 'msg';

          const body = {
            id: form.elements.id.value || undefined,
            name: form.elements.name.value,
            line1: form.elements.line1.value,
            line2: form.elements.line2.value || '',
            city: form.elements.city.value,
            state: form.elements.state.value,
            postal: form.elements.postal.value,
            country: form.elements.country.value,
            is_default_shipping: form.elements.is_default_shipping.checked,
            is_default_billing: form.elements.is_default_billing.checked
          };

          const isUpdate = !!body.id;
          const url = '/api/addresses' + (isUpdate ? '' : '');
          const method = isUpdate ? 'PUT' : 'POST';

          try {
            const res = await fetch(url, {
              method,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              msg.textContent = data.error || 'Failed to save address.';
              msg.className = 'msg error';
              return;
            }
            msg.textContent = 'Address saved.';
            msg.className = 'msg ok';
            clearForm();
            await loadAddresses();
          } catch (err) {
            msg.textContent = 'Error saving address.';
            msg.className = 'msg error';
          }
        });

        resetBtn.addEventListener('click', clearForm);

        clearForm();
        loadAddresses();
      })();
    </script>
  `;

  return layout(env, request, 'Addresses – Week1 Store', body, { extraScript });
}

// ---- Seller: products list & create ----
async function renderSellerProductsPage(env, request) {
  const body = `
    <h2>My products</h2>
    <p style="font-size:0.9rem;color:#555;">For sellers: list your products, edit them, and upload images.</p>
    <div id="sellerProductsContainer" style="margin-top:1rem;">Loading…</div>

    <h3 style="margin-top:1.5rem;">Create / edit product</h3>
    <form id="sellerProductForm" style="max-width:480px;margin-top:0.5rem;">
      <input type="hidden" name="id" />
      <div>
        <label>Title</label>
        <input name="title" required />
      </div>
      <div>
        <label>Description</label>
        <textarea name="description" rows="3"></textarea>
      </div>
      <div>
        <label>Price (raw, e.g. 130)</label>
        <input name="price" type="number" required />
      </div>
      <div>
        <label>Stock</label>
        <input name="stock" type="number" value="0" />
      </div>
      <div>
        <label>Image</label>
        <input name="image" type="file" accept="image/*" />
      </div>
      <button type="submit" class="btn">Save product</button>
      <button type="button" id="sellerProductClear" class="btn secondary" style="margin-left:0.5rem;">Clear form</button>
    </form>
    <div id="sellerProductsMsg" class="msg"></div>
  `;

  const extraScript = `
    <script>
      (function() {
        const container = document.getElementById('sellerProductsContainer');
        const form = document.getElementById('sellerProductForm');
        const msg = document.getElementById('sellerProductsMsg');
        const clearBtn = document.getElementById('sellerProductClear');
        const imageInput = form.elements.image;

        function fillForm(p) {
          form.elements.id.value = p.id || '';
          form.elements.title.value = p.title || '';
          form.elements.description.value = p.description || '';
          form.elements.price.value = Number(p.price_cents || 0);
          form.elements.stock.value = Number(p.stock || 0);
          if (imageInput) imageInput.value = '';
        }

        function clearForm() {
          fillForm({ id: '', title: '', description: '', price_cents: 0, stock: 0 });
          msg.textContent = '';
          msg.className = 'msg';
        }

        async function loadProducts() {
          container.textContent = 'Loading…';
          msg.textContent = '';
          msg.className = 'msg';
          try {
            const res = await fetch('/api/seller/products');
            if (res.status === 401) {
              container.innerHTML = '<p>You are not logged in. <a href="/login" class="link">Login</a>.</p>';
              return;
            }
            if (res.status === 403) {
              container.innerHTML = '<p>You are not a seller.</p>';
              return;
            }
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              container.textContent = data.error || 'Failed to load products.';
              return;
            }
            const products = data.products || [];
            if (!products.length) {
              container.innerHTML = '<p>You have no products yet.</p>';
              return;
            }
            const rows = products.map(p => {
              const price = Number(p.price_cents || 0);
              const stock = Number(p.stock || 0);
              const img = p.image_url || '';
              return \`
                <tr data-id="\${p.id}" data-title="\${p.title || ''}" data-description="\${p.description || ''}" data-price="\${price}" data-stock="\${stock}">
                  <td>
                    \${img ? '<img src="' + img + '" style="width:32px;height:32px;object-fit:cover;border-radius:4px;margin-right:0.4rem;vertical-align:middle;" />' : ''}
                    <span>\${p.title}</span>
                  </td>
                  <td>$\${price}</td>
                  <td>\${stock}</td>
                  <td>\${p.status}</td>
                  <td>\${p.created_at || ''}</td>
                  <td><button class="btn sm seller-edit">Edit</button></td>
                </tr>
              \`;
            }).join('');
            container.innerHTML = \`
              <table>
                <thead><tr><th>Product</th><th>Price</th><th>Stock</th><th>Status</th><th>Created at</th><th></th></tr></thead>
                <tbody>\${rows}</tbody>
              </table>
            \`;
          } catch (err) {
            container.textContent = 'Error loading products.';
          }
        }

        container.addEventListener('click', (e) => {
          const btn = e.target.closest('button');
          if (!btn || !btn.classList.contains('seller-edit')) return;
          const row = btn.closest('tr');
          if (!row) return;
          const p = {
            id: row.getAttribute('data-id'),
            title: row.getAttribute('data-title'),
            description: row.getAttribute('data-description'),
            price_cents: Number(row.getAttribute('data-price') || 0),
            stock: Number(row.getAttribute('data-stock') || 0)
          };
          fillForm(p);
          window.scrollTo({ top: form.offsetTop - 20, behavior: 'smooth' });
        });

        clearBtn.addEventListener('click', clearForm);

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          msg.textContent = '';
          msg.className = 'msg';

          const fd = new FormData(form);
          const id = fd.get('id') || '';
          const title = fd.get('title');
          const description = fd.get('description') || '';
          const price = Number(fd.get('price') || 0);
          const stock = Number(fd.get('stock') || 0);
          const imageFile = imageInput && imageInput.files && imageInput.files[0];

          try {
            let productId = id;

            if (!productId) {
              // create
              const body = {
                title,
                description,
                price_cents: price,
                stock,
                image_url: null,
                currency: 'USD'
              };
              const res = await fetch('/api/seller/products', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body)
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok || !data.ok) {
                msg.textContent = data.error || 'Failed to create product.';
                msg.className = 'msg error';
                return;
              }
              productId = data.product && data.product.id;
            } else {
              // update basic fields
              const body = {
                id: productId,
                title,
                description,
                price_cents: price
              };
              const res = await fetch('/api/seller/products', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body)
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok || !data.ok) {
                msg.textContent = data.error || 'Failed to update product.';
                msg.className = 'msg error';
                return;
              }

              // update stock
              await fetch('/api/seller/products/stock', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  product_id: productId,
                  qty: stock,
                  operation: 'set'
                })
              }).catch(() => {});
            }

            // Upload image if provided
            if (productId && imageFile) {
              const fd2 = new FormData();
              fd2.append('file', imageFile);
              const resImg = await fetch('/api/seller/products/' + encodeURIComponent(productId) + '/image', {
                method: 'POST',
                body: fd2
              });
              const dataImg = await resImg.json().catch(() => ({}));
              if (!resImg.ok || !dataImg.ok) {
                msg.textContent = (dataImg.error || 'Product saved, but image upload failed.');
                msg.className = 'msg error';
              }
            }

            msg.textContent = 'Product saved.';
            msg.className = 'msg ok';
            clearForm();
            await loadProducts();
          } catch (err) {
            msg.textContent = 'Error saving product.';
            msg.className = 'msg error';
          }
        });

        loadProducts();
      })();
    </script>
  `;

  return layout(env, request, 'My products – Week1 Store', body, { extraScript });
}

// ---- Seller: orders sold ----
async function renderSellerOrdersPage(env, request) {
  const body = `
    <h2>Orders for my products</h2>
    <p style="font-size:0.9rem;color:#555;">For sellers: orders that include your products, including buyer and shipping address.</p>
    <div id="sellerOrdersContainer" style="margin-top:1rem;">Loading…</div>
    <div id="sellerOrdersMsg" class="msg"></div>
  `;

  const extraScript = `
    <script>
      (function() {
        const container = document.getElementById('sellerOrdersContainer');
        const msg = document.getElementById('sellerOrdersMsg');

        async function loadSellerOrders() {
          container.textContent = 'Loading…';
          msg.textContent = '';
          msg.className = 'msg';
          try {
            const res = await fetch('/api/seller/orders');
            if (res.status === 401) {
              container.innerHTML = '<p>You are not logged in. <a href="/login" class="link">Login</a>.</p>';
              return;
            }
            if (res.status === 403) {
              container.innerHTML = '<p>You are not a seller.</p>';
              return;
            }
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              container.textContent = data.error || 'Failed to load seller orders.';
              return;
            }
            const orders = data.orders || [];
            if (!orders.length) {
              container.innerHTML = '<p>No orders yet for your products.</p>';
              return;
            }
            const statusOptions = ['placed','processing','shipped','completed','cancelled'];
            const rows = orders.map(o => {
              const total = o.total_cents;
              const itemsSummary = (o.items || []).map(it => \`\${it.title} x \${it.qty}\`).join(', ');
              const buyer = o.buyer || {};
              const buyerName = buyer.name || buyer.id || '';
              const addr = o.shipping_address;
              const addrStr = addr
                ? \`\${addr.name}, \${addr.line1}, \${addr.city}, \${addr.country}\`
                : '-';
              const optionsHtml = statusOptions.map(s =>
                '<option value="' + s + '"' + (s === o.status ? ' selected' : '') + '>' + s + '</option>'
              ).join('');
              return \`
                <tr data-id="\${o.id}">
                  <td>\${o.id}</td>
                  <td>$\${total}</td>
                  <td>\${itemsSummary}</td>
                  <td>\${buyerName}</td>
                  <td>\${addrStr}</td>
                  <td>
                    <select class="statusSelect">\${optionsHtml}</select>
                  </td>
                  <td>\${o.created_at || ''}</td>
                </tr>
              \`;
            }).join('');
            container.innerHTML = \`
              <table>
                <thead><tr><th>Order ID</th><th>Total</th><th>Items</th><th>Buyer</th><th>Ship to</th><th>Status</th><th>Created at</th></tr></thead>
                <tbody>\${rows}</tbody>
              </table>
            \`;
          } catch (err) {
            container.textContent = 'Error loading seller orders.';
          }
        }

        container.addEventListener('change', async (e) => {
          const select = e.target.closest('select.statusSelect');
          if (!select) return;
          const row = select.closest('tr');
          if (!row) return;
          const orderId = row.getAttribute('data-id');
          const status = select.value;
          msg.textContent = '';
          msg.className = 'msg';

          try {
            const res = await fetch('/api/seller/orders/status', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ order_id: orderId, status })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              msg.textContent = data.error || 'Failed to update order status.';
              msg.className = 'msg error';
              return;
            }
            try {
              const res = await fetch('/internal/order-status', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ user_id: auth.user.id, type: 'order_status', order_id: orderId, status: status })
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok || !data.ok) {
                msg.textContent = data.error || 'Failed to update order status.';
                msg.className = 'msg error';
                return;
              }
            } catch {}
            msg.textContent = 'Order status updated.';
            msg.className = 'msg ok';
          } catch (err) {
            msg.textContent = 'Error updating order status.';
            msg.className = 'msg error';
          }
        });

        loadSellerOrders();
      })();
    </script>
  `;

  return layout(env, request, 'Sold orders – Week1 Store', body, { extraScript });
}

// ================== ROUTER ==================
const router = Router();

// Health: checks DB, KV, R2, and all internal services
router.get('/health', async (request, env, ctx) => {
  let db = { ok: false };
  try {
    await env.DB.prepare('SELECT 1').first();
    db = { ok: true };
  } catch (err) {
    db = { ok: false, error: String(err) };
  }

  let cache = { ok: false };
  try {
    await env.PRODUCT_CACHE.get('health-check');
    cache = { ok: true };
  } catch (err) {
    cache = { ok: false, error: String(err) };
  }

  let object_storage = { ok: false };
  try {
    await env.LOG_BUCKET.list({ limit: 1 });
    object_storage = { ok: true };
  } catch (err) {
    object_storage = { ok: false, error: String(err) };
  }

  async function pingService(binding) {
    if (!binding || typeof binding.fetch !== 'function') {
      return { ok: false, error: 'service binding not configured' };
    }
    try {
      const res = await binding.fetch(
        new Request('https://internal/health', { method: 'GET' })
      );
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return {
        ok: res.ok,
        status: res.status,
        body
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  const [auth, catalog, checkout, realtime, logging] = await Promise.all([
    pingService(env.AUTH_SERVICE),
    pingService(env.CATALOG_SERVICE),
    pingService(env.CHECKOUT_SERVICE),
    pingService(env.REALTIME_SERVICE),
    pingService(env.LOGGING_SERVICE)
  ]);

  const services = { auth, catalog, checkout, realtime, logging };

  const everythingOk =
    db.ok &&
    cache.ok &&
    object_storage.ok &&
    auth.ok &&
    catalog.ok &&
    checkout.ok &&
    realtime.ok &&
    logging.ok;

  return json(
    {
      ok: everythingOk,
      service: 'edge-router',
      ts: new Date().toISOString(),
      db,
      cache,
      object_storage,
      services
    },
    { status: everythingOk ? 200 : 503 }
  );
});

// ---------- Public SSR pages ----------
router.get('/', (request, env, ctx) => renderHomePage(env, request));
router.get('/products', (request, env, ctx) => renderHomePage(env, request));
router.get('/product/:id', (request, env, ctx) =>
  renderProductPage(env, request, request.params.id)
);

router.get('/login', (request, env, ctx) => renderLoginPage(env, request));
router.get('/signup', (request, env, ctx) => renderSignupPage(env, request));
router.get('/cart', (request, env, ctx) => renderCartPage(env, request));
router.get('/checkout', (request, env, ctx) => renderCheckoutPage(env, request));
router.get('/orders', (request, env, ctx) => renderOrdersPage(env, request));
router.get('/orders/:id', (request, env, ctx) =>
  renderOrderDetailPage(env, request, request.params.id)
);
router.get('/profile', (request, env, ctx) => renderProfilePage(env, request));
router.get('/addresses', (request, env, ctx) => renderAddressesPage(env, request));
router.get('/seller/products', (request, env, ctx) =>
  renderSellerProductsPage(env, request)
);
router.get('/seller/orders', (request, env, ctx) =>
  renderSellerOrdersPage(env, request)
);

// ============= API GATEWAY =============

// Auth / users / addresses
router.all('/api/users/*', (request, env, ctx) =>
  proxyToService(env.AUTH_SERVICE, request)
);
router.all('/api/auth/*', (request, env, ctx) =>
  proxyToService(env.AUTH_SERVICE, request)
);
router.all('/api/addresses/*', (request, env, ctx) =>
  proxyToService(env.AUTH_SERVICE, request)
);
router.all('/api/addresses', (request, env, ctx) =>
  proxyToService(env.AUTH_SERVICE, request)
);
router.all('/api/me', (request, env, ctx) =>
  proxyToService(env.AUTH_SERVICE, request)
);

// Catalog
router.all('/api/products/*', (request, env, ctx) =>
  proxyToService(env.CATALOG_SERVICE, request)
);
router.all('/api/products', (request, env, ctx) =>
  proxyToService(env.CATALOG_SERVICE, request)
);
router.all('/api/seller/*', (request, env, ctx) =>
  proxyToService(env.CATALOG_SERVICE, request)
);

// Cart / checkout / orders
router.all('/api/cart/*', (request, env, ctx) =>
  proxyToService(env.CHECKOUT_SERVICE, request)
);
router.all('/api/cart', (request, env, ctx) =>
  proxyToService(env.CHECKOUT_SERVICE, request)
);
router.all('/api/checkout/*', (request, env, ctx) =>
  proxyToService(env.CHECKOUT_SERVICE, request)
);

router.all('/api/orders/*', (request, env, ctx) =>
  proxyToService(env.CHECKOUT_SERVICE, request)
);
router.all('/api/orders', (request, env, ctx) =>
  proxyToService(env.CHECKOUT_SERVICE, request)
);

// Avatar images
router.get('/avatars/*', (request, env, ctx) =>
  proxyToService(env.AUTH_SERVICE, request)
);

// Product images
router.get('/product-images/*', (request, env, ctx) =>
  proxyToService(env.CATALOG_SERVICE, request)
);

// Realtime WebSocket
router.get('/ws/orders', (request, env, ctx) =>
  proxyToService(env.REALTIME_SERVICE, request)
);

router.post('/internal/order-status', (request, env, ctx) =>
  proxyToService(env.REALTIME_SERVICE, request)
);

// Logging
router.all('/api/admin/logging-config', (request, env, ctx) =>
  proxyToService(env.LOGGING_SERVICE, request)
);
router.all('/api/log', (request, env, ctx) =>
  proxyToService(env.LOGGING_SERVICE, request)
);

// Fallback 404
router.all('*', () =>
  json({ ok: false, error: 'Not found (edge router)' }, { status: 404 })
);

export default {
  fetch: (request, env, ctx) => router.fetch(request, env, ctx)
};
