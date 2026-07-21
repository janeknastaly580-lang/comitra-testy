import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

const db = new Database(join(dataDir, 'payments.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),
    currency    TEXT NOT NULL DEFAULT 'USD',
    active      INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS orders (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    product_id        TEXT NOT NULL REFERENCES products(id),
    amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
    currency          TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | failed
    paypal_order_id   TEXT UNIQUE,
    paypal_capture_id TEXT UNIQUE,                       -- enforces capture idempotency
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
`);

// Seed the catalogue once. In FineLine these map to Premium plans / deposits.
const seed = db.prepare(
  `INSERT OR IGNORE INTO products (id, name, price_cents, currency) VALUES (?, ?, ?, ?)`,
);
seed.run('premium-monthly', 'FineLine Premium — Monthly', 799, 'USD');
seed.run('premium-yearly', 'FineLine Premium — Yearly', 7999, 'USD');

/* ----------------------------------------------------------------- Queries */
// Every query is a prepared statement with bound parameters -> no SQL injection.

const stmts = {
  getProduct: db.prepare('SELECT * FROM products WHERE id = ? AND active = 1'),
  insertOrder: db.prepare(`
    INSERT INTO orders (id, user_id, product_id, amount_cents, currency, status, created_at, updated_at)
    VALUES (@id, @user_id, @product_id, @amount_cents, @currency, 'pending', @now, @now)
  `),
  setPaypalOrderId: db.prepare(
    `UPDATE orders SET paypal_order_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
  ),
  getOrderById: db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?'),
  getOrderByIdAnyUser: db.prepare('SELECT * FROM orders WHERE id = ?'),
  getOrderByPaypalId: db.prepare('SELECT * FROM orders WHERE paypal_order_id = ?'),
  // Idempotent transition: flips pending -> paid exactly once (returns changes count).
  markPaid: db.prepare(`
    UPDATE orders
       SET status = 'paid', paypal_capture_id = @capture_id, updated_at = @now
     WHERE id = @id AND status = 'pending'
  `),
  markFailed: db.prepare(
    `UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'`,
  ),
};

export const ordersRepo = {
  getProduct: (productId) => stmts.getProduct.get(productId),

  createPendingOrder({ userId, product }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    stmts.insertOrder.run({
      id,
      user_id: userId,
      product_id: product.id,
      amount_cents: product.price_cents,
      currency: product.currency,
      now,
    });
    return stmts.getOrderById.get(id, userId);
  },

  attachPaypalOrderId(orderId, paypalOrderId) {
    stmts.setPaypalOrderId.run(paypalOrderId, new Date().toISOString(), orderId);
  },

  getForUser: (orderId, userId) => stmts.getOrderById.get(orderId, userId),
  getById: (orderId) => stmts.getOrderByIdAnyUser.get(orderId), // webhook (no session)
  getByPaypalId: (paypalOrderId) => stmts.getOrderByPaypalId.get(paypalOrderId),

  /** Returns true only the FIRST time the order is marked paid. */
  markPaidOnce(orderId, captureId) {
    const res = stmts.markPaid.run({
      id: orderId,
      capture_id: captureId,
      now: new Date().toISOString(),
    });
    return res.changes === 1;
  },

  markFailed(orderId) {
    stmts.markFailed.run(new Date().toISOString(), orderId);
  },
};

export default db;
