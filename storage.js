const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const usePostgres = () => Boolean(String(process.env.DATABASE_URL || '').trim());
let pool;
let paymentCache;
let bundleCache;
let writeTail = Promise.resolve();

function jsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return value;
}

function paymentFile() { return process.env.PAYMENT_DATA_FILE || path.join(__dirname, 'data/payment-service.json'); }
function bundleFile() { return process.env.DATA_BUNDLE_DATA_FILE || path.join(__dirname, 'data/data-bundles.json'); }
function normalizePayment(value) {
  return { transactions: Array.isArray(value?.transactions) ? value.transactions : [], webhookEvents: Array.isArray(value?.webhookEvents) ? value.webhookEvents : [], requestIds: Array.isArray(value?.requestIds) ? value.requestIds : [] };
}
function normalizeBundle(value) {
  return { orders: Array.isArray(value?.orders) ? value.orders : [], requestIds: Array.isArray(value?.requestIds) ? value.requestIds : [] };
}

async function readPostgres() {
  const payment = { transactions: [], webhookEvents: [], requestIds: [] };
  const bundle = { orders: [], requestIds: [] };
  const tx = await pool.query('SELECT id, data FROM payment_transactions ORDER BY created_at NULLS FIRST, id');
  payment.transactions = tx.rows.map(row => ({ ...(row.data || {}), id: row.id }));
  const events = await pool.query('SELECT data FROM payment_webhook_events ORDER BY received_at NULLS FIRST, id');
  payment.webhookEvents = events.rows.map(row => row.data || {});
  const requests = await pool.query('SELECT request_id, used_at FROM payment_request_ids ORDER BY used_at NULLS FIRST, request_id');
  payment.requestIds = requests.rows.map(row => ({ requestId: row.request_id, usedAt: row.used_at?.toISOString?.() || row.used_at }));
  const orders = await pool.query('SELECT reference, data FROM bundle_orders ORDER BY created_at NULLS FIRST, reference');
  bundle.orders = orders.rows.map(row => ({ ...(row.data || {}), reference: row.reference }));
  const bundleRequests = await pool.query('SELECT request_id, used_at FROM bundle_request_ids ORDER BY used_at NULLS FIRST, request_id');
  bundle.requestIds = bundleRequests.rows.map(row => ({ requestId: row.request_id, usedAt: row.used_at?.toISOString?.() || row.used_at }));
  return { payment, bundle };
}

async function persist(payment, bundle) {
  await pool.query('BEGIN');
  try {
    for (const item of payment.transactions) {
      await pool.query(`INSERT INTO payment_transactions (id, site_a_transaction_id, purpose, paystack_reference, status, amount_minor, currency, created_at, data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET site_a_transaction_id=EXCLUDED.site_a_transaction_id, purpose=EXCLUDED.purpose, paystack_reference=EXCLUDED.paystack_reference, status=EXCLUDED.status, amount_minor=EXCLUDED.amount_minor, currency=EXCLUDED.currency, created_at=EXCLUDED.created_at, data=EXCLUDED.data`,
        [item.id, item.siteATransactionId || null, item.purpose || null, item.paystackReference || null, item.status || null, item.amountMinor || null, item.currency || null, item.createdAt || null, item]);
    }
    for (const item of payment.webhookEvents) {
      await pool.query(`INSERT INTO payment_webhook_events (id, event_id, transaction_reference, event_type, received_at, data)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (event_id) DO UPDATE SET data=EXCLUDED.data, processed=COALESCE(EXCLUDED.processed, payment_webhook_events.processed)`,
        [item.id || `evt_${item.eventId}`, item.eventId, item.transactionReference || null, item.eventType || null, item.receivedAt || null, item]);
    }
    for (const item of payment.requestIds) {
      const requestId = typeof item === 'string' ? item : item.requestId;
      if (requestId) await pool.query('INSERT INTO payment_request_ids (request_id, used_at) VALUES ($1,$2) ON CONFLICT (request_id) DO NOTHING', [requestId, typeof item === 'string' ? null : item.usedAt || null]);
    }
    for (const item of bundle.orders) {
      await pool.query(`INSERT INTO bundle_orders (reference, paystack_reference, payment_status, status, fulfillment_status, created_at, data)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (reference) DO UPDATE SET paystack_reference=EXCLUDED.paystack_reference, payment_status=EXCLUDED.payment_status, status=EXCLUDED.status, fulfillment_status=EXCLUDED.fulfillment_status, created_at=EXCLUDED.created_at, data=EXCLUDED.data`,
        [item.reference, item.paystackReference || null, item.paymentStatus || null, item.status || null, item.fulfillmentStatus || null, item.createdAt || null, item]);
    }
    for (const item of bundle.requestIds) {
      const requestId = typeof item === 'string' ? item : item.requestId;
      if (requestId) await pool.query('INSERT INTO bundle_request_ids (request_id, used_at) VALUES ($1,$2) ON CONFLICT (request_id) DO NOTHING', [requestId, typeof item === 'string' ? null : item.usedAt || null]);
    }
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

async function initialize() {
  if (!usePostgres()) {
    paymentCache = normalizePayment(jsonFile(paymentFile(), {}));
    bundleCache = normalizeBundle(jsonFile(bundleFile(), {}));
    if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production; refusing ephemeral JSON storage.');
    return;
  }
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: Number(process.env.DATABASE_POOL_MAX || 3), idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, application_name: 'site-b' });
  await pool.query('SELECT 1');
  ({ payment: paymentCache, bundle: bundleCache } = await readPostgres());
}

function loadPayment() { return usePostgres() ? (paymentCache || normalizePayment(jsonFile(paymentFile(), {}))) : normalizePayment(jsonFile(paymentFile(), {})); }
function loadBundle() { return usePostgres() ? (bundleCache || normalizeBundle(jsonFile(bundleFile(), {}))) : normalizeBundle(jsonFile(bundleFile(), {})); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function savePayment(value) { paymentCache = normalizePayment(value); if (usePostgres()) { const snapshot = paymentCache; writeTail = writeTail.then(() => persist(snapshot, bundleCache)).catch(error => { console.error('PostgreSQL write failed:', error.message); throw error; }); return writeTail; } writeJson(paymentFile(), paymentCache); return undefined; }
function saveBundle(value) { bundleCache = normalizeBundle(value); if (usePostgres()) { const snapshot = bundleCache; writeTail = writeTail.then(() => persist(paymentCache, snapshot)).catch(error => { console.error('PostgreSQL write failed:', error.message); throw error; }); return writeTail; } writeJson(bundleFile(), bundleCache); return undefined; }
async function flush() { await writeTail; }
async function close() { await flush(); await pool?.end(); }
async function importStores(payment, bundle) { if (!usePostgres()) throw new Error('DATABASE_URL is required for import.'); paymentCache = normalizePayment(payment); bundleCache = normalizeBundle(bundle); await persist(paymentCache, bundleCache); }

module.exports = { initialize, loadPayment, savePayment, loadBundle, saveBundle, flush, close, importStores, usePostgres, paymentFile, bundleFile };
