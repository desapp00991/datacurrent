# PHANTOM CARDS — DATA BUNDLE SITE

This directory is a standalone Site B deployment. It can be copied to a completely
separate server or folder without copying the Phantom Cards application.

It contains:

- the Ghana data-bundle storefront for MTN, Telecel, and AirtelTigo;
- the separate manual bundle-order ledger;
- Paystack bundle checkout and verification;
- the original Phantom Cards Site B wallet-top-up/KYC payment-service routes;
- the secure Site A ↔ Site B callback contract.

## Run locally

```bash
cp .env.example .env
# For local development, change PAYMENT_DATA_FILE and DATA_BUNDLE_DATA_FILE
# in .env to ./data/payment-service.json and ./data/data-bundles.json.
npm test
npm run dev
```

Site B runs on the port in `.env`, normally `http://localhost:4000`.

`npm run dev` explicitly uses the local test URLs `http://localhost:4000` for
Site B and `http://localhost:3000` for Site A, even if `.env` contains Railway
URLs. In development, a live `PAYSTACK_SECRET_KEY` is ignored; set
`PAYSTACK_TEST_SECRET_KEY` to a Paystack test secret when local payment testing
is needed. Production continues to use the environment supplied to `npm start`.

## Deployment relationship

Site A and Site B must use their real public HTTPS URLs in their respective `.env`
files. The two shared secrets must be identical on both sides, but the Paystack
secret belongs only in this Site B `.env`.

```text
Phantom Cards Site A → signed Site B payment initialization
Site B → signed Phantom Cards payment-status callback
Paystack → Site B webhook and verification
```

Site A can request a secure server-side payment reconciliation without creating
another Paystack transaction:

```text
POST /api/v1/internal/admin/reconcile
Authorization: Bearer $SITE_A_TO_SITE_B_SECRET
```

The request uses the existing signed Site A → Site B headers and contains the
Site A transaction ID plus an optional Paystack reference. Site B verifies the
payment with Paystack, updates only its own payment record, and retries the
signed callback to Site A with `source: "admin-reconciliation"`. Site B never
credits the wallet directly.

Site B also runs two durable recovery loops. Failed Site A callbacks are stored
with attempt counts, errors, and the next retry time. Pending or initializing
payments are periodically verified against Paystack so a missing webhook or
lost initialization response can still reach Site A. Keep the payment data file
on persistent storage and run one Site B worker for this JSON deployment; a
multi-instance deployment should use a transactional database with unique
constraints and a distributed job lock.

New Site A payments are initialized in Paystack with only Site B-owned metadata:
`service: "SITE_B_PAYMENT_SERVICE"` and the Site B payment-service transaction
ID. Site A transaction and user identifiers remain in Site B's private payment
record and are sent only in the signed Site B → Site A callback. Legacy
transactions that were initialized with the previous Site A metadata remain
verifiable for recovery, but new transactions do not add those fields to
Paystack. New provider references use the Site B-owned `SBP_` prefix; existing
provider references are preserved for recovery.

Site A payment initialization returns a Site B handoff URL rather than exposing
the Paystack authorization URL to the browser. The handoff endpoint is:

```text
GET /payment/handoff?token=<opaque-token>
```

The token is short-lived and stored against the Site B payment transaction. Site
B validates it, rejects unknown, expired, or terminal sessions, and redirects
only to the stored HTTPS Paystack checkout URL with `Cache-Control: no-store`
and `Referrer-Policy: no-referrer`. The handoff token contains no Site A
transaction or user identifiers.

## Railway storage

Mount the Railway Volume at `/app/data` and set:

```text
PAYMENT_DATA_FILE=/app/data/payment-service.json
DATA_BUNDLE_DATA_FILE=/app/data/data-bundles.json
```

Do not use `/data` unless the Railway Volume is mounted at that exact path.

Bundle purchases use their own `PULSE_DATA` metadata, references, and
`data/data-bundles.json` file. They do not write to Phantom Cards data.

## Manual fulfillment

After a verified Paystack payment, a bundle order is stored as
`PAID_AWAITING_MANUAL_DELIVERY`. Use the recipient network and phone number to
purchase the bundle manually. The customer receives a 2–5 minute delivery message.

The private manual-order API is:

```text
GET  /api/v1/data-bundles/admin/orders
POST /api/v1/data-bundles/admin/orders/:reference/fulfill
Authorization: Bearer $DATA_BUNDLE_ADMIN_TOKEN
```
