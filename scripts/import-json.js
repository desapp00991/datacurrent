const fs = require('node:fs');
const path = require('node:path');
const storage = require('../storage');

function read(file, fallback) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. The import never falls back to local files.');
  const paymentFile = process.env.IMPORT_PAYMENT_DATA_FILE || storage.paymentFile();
  const bundleFile = process.env.IMPORT_DATA_BUNDLE_DATA_FILE || storage.bundleFile();
  if (!fs.existsSync(paymentFile) && !fs.existsSync(bundleFile)) throw new Error('No JSON source files found. Set IMPORT_PAYMENT_DATA_FILE and IMPORT_DATA_BUNDLE_DATA_FILE.');
  const backupDir = process.env.IMPORT_BACKUP_DIR || path.join(path.dirname(paymentFile), `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(paymentFile)) fs.copyFileSync(paymentFile, path.join(backupDir, 'payment-service.json'));
  if (fs.existsSync(bundleFile)) fs.copyFileSync(bundleFile, path.join(backupDir, 'data-bundles.json'));
  await storage.initialize();
  const payment = read(paymentFile, {});
  const bundle = read(bundleFile, {});
  const existingPayment = storage.loadPayment();
  const existingBundle = storage.loadBundle();
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  for (const incoming of payment.transactions || []) {
    const current = existingPayment.transactions.find(item => item.id === incoming.id || (item.siteATransactionId === incoming.siteATransactionId && item.purpose === incoming.purpose));
    if (current && !same(current, incoming)) throw new Error(`Conflicting payment record ${incoming.id || incoming.siteATransactionId}; no records were imported.`);
  }
  for (const incoming of bundle.orders || []) {
    const current = existingBundle.orders.find(item => item.reference === incoming.reference);
    if (current && !same(current, incoming)) throw new Error(`Conflicting bundle order ${incoming.reference}; no records were imported.`);
  }
  await storage.importStores(payment, bundle);
  console.log(JSON.stringify({ backupDir, paymentTransactions: payment.transactions?.length || 0, bundleOrders: bundle.orders?.length || 0 }, null, 2));
  await storage.close();
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
