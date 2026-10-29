# Site B on Render Free with Supabase PostgreSQL

This deployment keeps the existing Node HTTP server and Paystack flows. PostgreSQL is used only as the durable store behind the existing payment and bundle store interfaces.

## 1. Create the Supabase connection

In Supabase, open **Project Settings → Database → Connection string** and copy the **Session pooler** URI (or the direct URI if your Render service can reach it). Replace its password locally only when testing; never commit it.

Use the URI as `DATABASE_URL`. The application also accepts:

```text
DATABASE_SSL=true
DATABASE_POOL_MAX=3
```

The application uses a small pool because Render Free should run one web instance. Do not expose `DATABASE_URL` to browser code.

## 2. Configure Render

Create a Web Service from this repository. Use:

```text
Build Command: npm ci
Start Command: npm start
```

Set these Render environment variables:

```text
NODE_ENV=production
SITE_B_BASE_URL=https://YOUR-SITE-B.onrender.com
SITE_A_BASE_URL=https://YOUR-SITE-A.example
DATABASE_URL=the Supabase PostgreSQL URI
DATABASE_SSL=true
DATABASE_POOL_MAX=3
SITE_A_TO_SITE_B_SECRET=the existing shared secret
SITE_B_TO_SITE_A_SECRET=the existing shared callback secret
PAYSTACK_SECRET_KEY=your Paystack server secret
PAYSTACK_API_BASE_URL=https://api.paystack.co
DATA_BUNDLE_PAYMENT_EMAIL=the Paystack-approved receipt email
DATA_BUNDLE_ADMIN_TOKEN=a long random private token
CALLBACK_RETRY_INTERVAL_MS=30000
CALLBACK_RETRY_INITIAL_DELAY_MS=30000
PAYMENT_RECONCILIATION_INTERVAL_MS=60000
```

Do not set `PAYMENT_DATA_FILE` or `DATA_BUNDLE_DATA_FILE` for production. If `DATABASE_URL` is absent in production, the service refuses to start instead of using ephemeral disk.

After the first deploy, run the migration once from a machine with Node, npm, and network access to Supabase:

```bash
npm ci
DATABASE_URL='your Supabase URI' npm run db:migrate
```

The migration is additive and can be run again safely.

## 3. Import existing JSON records

Before importing, copy the current ignored `data/payment-service.json` and `data/data-bundles.json` somewhere safe. Do not edit them. From the project directory, run:

```bash
DATABASE_URL='your Supabase URI' \
IMPORT_PAYMENT_DATA_FILE='./data/payment-service.json' \
IMPORT_DATA_BUNDLE_DATA_FILE='./data/data-bundles.json' \
npm run db:import
```

The importer creates a timestamped backup beside the payment JSON file, preserves identifiers/statuses/references, and uses upserts so rerunning it does not create duplicates. It prints imported payment-transaction and bundle-order counts. Keep the JSON backup until production has been verified.

If the database already contains records, stop and inspect counts before importing. The importer does not delete database records; conflicting unique identifiers fail rather than silently overwriting a different record.

## 4. Safe verification

Before real payments, check:

```bash
curl -sS https://YOUR-SITE-B.onrender.com/api/health
```

Confirm the response has `ok: true` and `paystackConfigured: true`. Test a bundle order only with Paystack test credentials and test mode. Do not use a live key for a smoke test.

For persistence, create a test record with Paystack test mode or use the existing non-payment API checks, then restart/redeploy the Render service and verify the same order or transaction remains available. A successful Paystack return page alone is not proof of payment; the existing webhook/verification path must confirm it.

For manual fulfillment, use the existing protected endpoints only after confirming `paymentStatus=SUCCESS`:

```bash
curl -H "Authorization: Bearer $DATA_BUNDLE_ADMIN_TOKEN" \
  https://YOUR-SITE-B.onrender.com/api/v1/data-bundles/admin/orders
```

Do not call the fulfillment endpoint in a test unless you intend to mark an order fulfilled. The application does not call a supplier API; fulfillment remains manual as in the existing design.

## 5. Backups and free-tier notes

Use Supabase's database backup/export facilities, or run `pg_dump` against the same `DATABASE_URL` from a trusted machine:

```bash
pg_dump --format=custom --file=site-b-$(date +%Y%m%d).dump "$DATABASE_URL"
pg_restore --clean --if-exists --dbname="$DATABASE_URL" site-b-YYYYMMDD.dump
```

Restore only after taking a fresh backup and stopping the Render service. Supabase and Render free tiers can sleep, pause, or impose connection/resource limits. Render's local filesystem is ephemeral; this is why production does not use the JSON files. Keep one Render instance unless you add a distributed worker/lock design; the current in-process payment locks are intentionally preserved.

The application never stores the Supabase password or Paystack secret in frontend assets. Rotate secrets through Render/Supabase dashboards if they are exposed.
