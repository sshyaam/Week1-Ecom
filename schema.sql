-- Enable foreign keys (SQLite / D1)
PRAGMA foreign_keys = ON;

-- Drop existing tables if you already had test data
-- DROP TABLE IF EXISTS order_items;
-- DROP TABLE IF EXISTS orders;
-- DROP TABLE IF EXISTS payments;
-- DROP TABLE IF EXISTS cart_items;
-- DROP TABLE IF EXISTS inventory;
-- DROP TABLE IF EXISTS product_images;
-- DROP TABLE IF EXISTS products;
-- DROP TABLE IF EXISTS categories;
-- DROP TABLE IF EXISTS addresses;
-- DROP TABLE IF EXISTS shipping_methods;
-- DROP TABLE IF EXISTS sessions;
-- DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS users;

-- ======================
-- USERS & SESSIONS
-- ======================

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL UNIQUE,        -- SHA-256 or similar of normalized email
  email_cipher BLOB,                      -- encrypted email (future)
  phone_hash TEXT,
  phone_cipher BLOB,
  name_cipher BLOB,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'buyer',     -- 'admin' | 'seller' | 'buyer'
  status TEXT NOT NULL DEFAULT 'active',  -- 'active', 'locked', etc.
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX idx_users_email_hash ON users(email_hash);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ======================
-- CATEGORIES & PRODUCTS
-- ======================

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- 'draft' | 'active' | 'archived'
  category_id TEXT REFERENCES categories(id),
  seller_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  alt TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE inventory (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  stock INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_products_slug ON products(slug);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_inventory_updated_at ON inventory(updated_at);

-- ======================
-- SINGLE CART TABLE
-- ======================

-- One logical cart per user: each row is one item in that user's cart
CREATE TABLE cart_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

CREATE INDEX idx_cart_items_user ON cart_items(user_id);

-- ======================
-- ADDRESSES
-- ======================

CREATE TABLE addresses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name_cipher BLOB,
  line1_cipher BLOB,
  line2_cipher BLOB,
  city_cipher BLOB,
  state_cipher BLOB,
  postal_cipher BLOB,
  country TEXT NOT NULL,
  is_default_shipping INTEGER NOT NULL DEFAULT 0,
  is_default_billing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_addresses_user ON addresses(user_id);

-- ======================
-- SHIPPING METHODS
-- ======================

CREATE TABLE shipping_methods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,               -- e.g. "Standard", "Express"
  zone TEXT NOT NULL,               -- e.g. "IN", "US", "EU"
  speed TEXT NOT NULL,              -- 'normal' | 'express'
  base_cents INTEGER NOT NULL,
  per_kg_cents INTEGER NOT NULL DEFAULT 0,
  free_over_cents INTEGER,          -- optional free shipping threshold
  active INTEGER NOT NULL DEFAULT 1
);

-- ======================
-- ORDERS & ORDER ITEMS
-- ======================

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,              -- 'pending', 'placed', 'packed', 'shipped', 'delivered', etc.
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  shipping_address_id TEXT,
  billing_address_id TEXT,
  shipping_method_id TEXT REFERENCES shipping_methods(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  title_snapshot TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  qty INTEGER NOT NULL
);

CREATE INDEX idx_orders_user ON orders(user_id, created_at);
CREATE INDEX idx_order_items_order ON order_items(order_id);

-- ======================
-- PAYMENTS (placeholder for future real billing)
-- ======================

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT,                      -- e.g. 'stripe', 'razorpay' (future)
  status TEXT NOT NULL,               -- 'initiated', 'succeeded', 'failed'
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TEXT NOT NULL,
  raw_payload TEXT                    -- JSON string from provider
);

-- ======================
-- AUDIT LOGS
-- ======================

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_user_id);

-- ======================
-- OPTIONAL: seed a couple of shipping methods
-- ======================

INSERT INTO shipping_methods (id, name, zone, speed, base_cents, per_kg_cents, free_over_cents, active)
VALUES
  ('standard-IN', 'Standard Shipping India', 'IN', 'normal', 5000, 0, 200000, 1),
  ('express-IN',  'Express Shipping India',  'IN', 'express', 10000, 0, NULL,   1)
ON CONFLICT(id) DO NOTHING;
