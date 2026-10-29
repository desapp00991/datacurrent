const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SITE_A_TO_SITE_B_SECRET = 'site-a-to-site-b-test-secret';
const SITE_B_TO_SITE_A_SECRET = 'site-b-to-site-a-test-secret';
const PAYSTACK_SECRET_KEY = 'sk_test_admin_reconciliation';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function transaction(overrides = {}) {
  return {
    id: 'pay_admin_reconciliation_1',
    siteATransactionId: 'PH-TOPUP-ADMIN-001',
    siteAUserId: 'usr_admin_001',
    amountMinor: 18000,
    currency: 'GHS',
    purpose: 'WALLET_TOPUP',
    paystackReference: 'PCS_admin_reference_001',
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    customerEmail: 'bridgetfegerson2007+1@gmail.com',
    returnUrl: '',
    authorizationUrl: 'https://checkout.paystack.com/test',
    ...overrides
  };
}

function paystackPayment(t, overrides = {}) {
  return {
    reference: t.paystackReference,
    amount: t.amountMinor,
    currency: t.currency,
    status: 'success',
    metadata: {
      service: 'SITE_B_PAYMENT_SERVICE',
      paymentServiceTransactionId: t.id
    },
    ...overrides
  };
}

function signedHeaders(body, requestId = `admin-reconcile-${Date.now()}`) {
  const timestamp = String(Date.now());
  return {
    authorization: `Bearer ${SITE_A_TO_SITE_B_SECRET}`,
    'content-type': 'application/json',
    'x-request-id': requestId,
    'x-timestamp': timestamp,
    'x-sitea-signature': crypto.createHmac('sha256', SITE_A_TO_SITE_B_SECRET)
      .update(`${timestamp}.${requestId}.${body}`)
      .digest('hex')
  };
}

async function request(base, body, headers = signedHeaders(body)) {
  const response = await fetch(`${base}/api/v1/internal/admin/reconcile`, {
    method: 'POST',
    headers,
    body
  });
  return { response, body: await response.json() };
}

async function startFixture({ storedTransaction = transaction(), paystackPayment: configuredPayment, callbackFailures = 0, initializeFailures = 0, initializeDelayMs = 0, callbackRetryIntervalMs, paymentReconciliationIntervalMs } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-admin-reconcile-'));
  const dataFile = path.join(tempDir, 'payment-service.json');
  const bundleFile = path.join(tempDir, 'data-bundles.json');
  fs.writeFileSync(dataFile, JSON.stringify({ transactions: [storedTransaction], webhookEvents: [], requestIds: [] }, null, 2));
  fs.writeFileSync(bundleFile, JSON.stringify({ orders: [], requestIds: [] }, null, 2));

  const verifyRequests = [];
  const initializeRequests = [];
  const initializeBodies = [];
  const callbacks = [];
  const paystackServer = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://paystack.test').pathname;
    if (req.method === 'GET' && pathname.startsWith('/transaction/verify/')) {
      verifyRequests.push(decodeURIComponent(pathname.split('/').pop()));
      const payment = typeof configuredPayment === 'function'
        ? configuredPayment(verifyRequests.at(-1), verifyRequests.length)
        : configuredPayment || paystackPayment(storedTransaction);
      return json(res, 200, { status: true, data: payment });
    }
    if (req.method === 'POST' && pathname === '/transaction/initialize') {
      initializeRequests.push(req);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      initializeBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (initializeDelayMs) await new Promise(resolve => setTimeout(resolve, initializeDelayMs));
      if (initializeRequests.length <= initializeFailures) return json(res, 503, { status: false, message: 'temporary Paystack initialization failure' });
      return json(res, 200, { status: true, data: { authorization_url: 'https://checkout.paystack.com/test' } });
    }
    return json(res, 404, { status: false, message: 'Not found' });
  });
  const paystackPort = await listen(paystackServer);

  const siteAServer = http.createServer(async (req, res) => {
    if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });
    const pathname = new URL(req.url, 'http://site-a.test').pathname;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(raw.toString('utf8'));
    if (pathname.startsWith('/api/v1/internal/')) {
      const isKyc = body.siteATransactionId === 'PH-KYC-INIT-001';
      return json(res, 200, {
        userId: isKyc ? 'usr_kyc_001' : body.siteATransactionId === 'PH-TOPUP-INIT-001' ? 'usr_init_001' : 'usr_admin_001',
        amountMinor: isKyc ? 7000 : body.siteATransactionId === 'PH-TOPUP-INIT-001' ? 4200 : 18000,
        currency: 'GHS',
        purpose: isKyc ? 'KYC_BYPASS' : 'WALLET_TOPUP',
        customer: { email: 'bridgetfegerson2007+1@gmail.com' },
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      });
    }
    callbacks.push({ headers: req.headers, body });
    if (callbacks.length <= callbackFailures) return json(res, 503, { error: 'temporary Site A outage' });
    return json(res, 200, { ok: true });
  });
  const siteAPort = await listen(siteAServer);
  const appPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(appPort),
      SITE_B_BASE_URL: base,
      SITE_A_BASE_URL: `http://127.0.0.1:${siteAPort}`,
      SITE_A_TO_SITE_B_SECRET,
      SITE_B_TO_SITE_A_SECRET,
      PAYSTACK_SECRET_KEY,
      PAYSTACK_API_BASE_URL: `http://127.0.0.1:${paystackPort}`,
      PAYMENT_DATA_FILE: dataFile,
      DATA_BUNDLE_DATA_FILE: bundleFile,
      DATA_BUNDLE_PAYMENT_EMAIL: storedTransaction.customerEmail,
      ...(callbackRetryIntervalMs ? { CALLBACK_RETRY_INTERVAL_MS: String(callbackRetryIntervalMs), CALLBACK_RETRY_INITIAL_DELAY_MS: String(callbackRetryIntervalMs) } : {}),
      ...(paymentReconciliationIntervalMs ? { PAYMENT_RECONCILIATION_INTERVAL_MS: String(paymentReconciliationIntervalMs) } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });

  let healthy = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!healthy) {
    child.kill('SIGTERM');
    await close(paystackServer);
    await close(siteAServer);
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`Payment service did not start. Logs: ${logs}`);
  }

  return {
    base,
    dataFile,
    verifyRequests,
    initializeRequests,
    initializeBodies,
    callbacks,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      await close(paystackServer);
      await close(siteAServer);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

test('admin reconciliation rejects invalid authentication', async () => {
  const fixture = await startFixture();
  try {
    const body = JSON.stringify({ siteATransactionId: 'PH-TOPUP-ADMIN-001' });
    const result = await request(fixture.base, body, { 'content-type': 'application/json' });
    assert.equal(result.response.status, 401);
    assert.equal(fixture.verifyRequests.length, 0);
  } finally {
    await fixture.stop();
  }
});

test('authenticated Site A request IDs cannot be replayed', async () => {
  const fixture = await startFixture();
  try {
    const body = JSON.stringify({
      siteATransactionId: 'PH-TOPUP-INIT-001',
      siteAUserId: 'usr_init_001',
      amountMinor: 4200,
      currency: 'GHS',
      purpose: 'WALLET_TOPUP',
      customer: { email: 'bridgetfegerson2007+1@gmail.com' }
    });
    const headers = signedHeaders(body, 'site-a-request-id-replay');
    const first = await fetch(`${fixture.base}/api/v1/payments/initialize`, {
      method: 'POST',
      headers,
      body
    });
    assert.equal(first.status, 201);
    const second = await fetch(`${fixture.base}/api/v1/payments/initialize`, {
      method: 'POST',
      headers,
      body
    });
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: 'Request has already been used.' });
    const stored = JSON.parse(fs.readFileSync(fixture.dataFile, 'utf8'));
    assert.equal(stored.requestIds.filter(item => item.requestId === 'site-a-request-id-replay').length, 1);

    const reconciliationBody = JSON.stringify({ siteATransactionId: 'PH-TOPUP-ADMIN-001' });
    const reconciliationHeaders = signedHeaders(reconciliationBody, 'site-a-reconciliation-request-replay');
    const reconciliation = await request(fixture.base, reconciliationBody, reconciliationHeaders);
    assert.equal(reconciliation.response.status, 200);
    const reconciliationReplay = await request(fixture.base, reconciliationBody, reconciliationHeaders);
    assert.equal(reconciliationReplay.response.status, 409);
    assert.deepEqual(reconciliationReplay.body, { error: 'Request has already been used.' });
  } finally {
    await fixture.stop();
  }
});

test('request-ID claims survive concurrent operations for different transactions', async () => {
  const fixture = await startFixture({ initializeDelayMs: 150 });
  try {
    const initializeBody = JSON.stringify({
      siteATransactionId: 'PH-TOPUP-INIT-002',
      siteAUserId: 'usr_admin_001',
      amountMinor: 18000,
      currency: 'GHS',
      purpose: 'WALLET_TOPUP',
      customer: { email: 'bridgetfegerson2007+1@gmail.com' }
    });
    const initializeHeaders = signedHeaders(initializeBody, 'site-a-cross-transaction-init');
    const initialization = fetch(`${fixture.base}/api/v1/payments/initialize`, {
      method: 'POST',
      headers: initializeHeaders,
      body: initializeBody
    });
    await new Promise(resolve => setTimeout(resolve, 40));

    const reconciliationBody = JSON.stringify({ siteATransactionId: 'PH-TOPUP-ADMIN-001' });
    const reconciliationHeaders = signedHeaders(reconciliationBody, 'site-a-cross-transaction-reconcile');
    const reconciliation = await request(fixture.base, reconciliationBody, reconciliationHeaders);
    assert.equal(reconciliation.response.status, 200);
    assert.equal((await initialization).status, 201);

    const replay = await request(fixture.base, reconciliationBody, reconciliationHeaders);
    assert.equal(replay.response.status, 409);
    assert.deepEqual(replay.body, { error: 'Request has already been used.' });
  } finally {
    await fixture.stop();
  }
});

test('Site A initialization sends only Site B-owned metadata to Paystack', async () => {
  const fixture = await startFixture();
  try {
    const body = JSON.stringify({
      siteATransactionId: 'PH-TOPUP-INIT-001',
      siteAUserId: 'usr_init_001',
      amountMinor: 4200,
      currency: 'GHS',
      purpose: 'WALLET_TOPUP',
      customer: { email: 'bridgetfegerson2007+1@gmail.com' }
    });
    const response = await fetch(`${fixture.base}/api/v1/payments/initialize`, {
      method: 'POST',
      headers: signedHeaders(body, 'site-a-initialize-opaque-metadata'),
      body
    });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.equal(fixture.initializeBodies.length, 1);
    assert.equal(result.authorizationUrl, undefined);
    assert.equal(result.paystackReference, undefined);
    assert.match(fixture.initializeBodies[0].reference, /^SBP_[A-Za-z0-9]+$/);
    const handoff = new URL(result.handoffUrl);
    assert.equal(handoff.origin, fixture.base);
    assert.equal(handoff.pathname, '/payment/handoff');
    assert.deepEqual([...handoff.searchParams.keys()], ['token']);
    assert.match(handoff.searchParams.get('token'), /^[A-Za-z0-9_-]{16,256}$/);
    assert.deepEqual(fixture.initializeBodies[0].metadata, {
      service: 'SITE_B_PAYMENT_SERVICE',
      paymentServiceTransactionId: result.transactionId
    });
    assert.equal(fixture.initializeBodies[0].metadata.site, undefined);
    assert.equal(fixture.initializeBodies[0].metadata.siteATransactionId, undefined);
    assert.equal(fixture.initializeBodies[0].metadata.siteAUserId, undefined);
    assert.equal(fixture.initializeBodies[0].metadata.purpose, undefined);
    assert.doesNotMatch(JSON.stringify(fixture.initializeBodies[0].metadata), /SITE_A|siteATransactionId|siteAUserId/);
    const handoffResponse = await fetch(result.handoffUrl, { redirect: 'manual' });
    assert.equal(handoffResponse.status, 302);
    assert.equal(handoffResponse.headers.get('location'), 'https://checkout.paystack.com/test');
    assert.equal(handoffResponse.headers.get('cache-control'), 'no-store');
    assert.equal(handoffResponse.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    await fixture.stop();
  }
});

test('payment handoff rejects malformed, unknown, and terminal tokens', async () => {
  const fixture = await startFixture();
  try {
    const missing = await fetch(`${fixture.base}/payment/handoff`, { redirect: 'manual' });
    assert.equal(missing.status, 400);

    const malformed = await fetch(`${fixture.base}/payment/handoff?token=short`, { redirect: 'manual' });
    assert.equal(malformed.status, 400);

    const unknownToken = 'unknown_handoff_token_1234567890';
    const unknown = await fetch(`${fixture.base}/payment/handoff?token=${unknownToken}`, { redirect: 'manual' });
    assert.equal(unknown.status, 404);

    const body = JSON.stringify({
      siteATransactionId: 'PH-TOPUP-INIT-001',
      siteAUserId: 'usr_init_001',
      amountMinor: 4200,
      currency: 'GHS',
      purpose: 'WALLET_TOPUP',
      customer: { email: 'bridgetfegerson2007+1@gmail.com' }
    });
    const initialized = await fetch(`${fixture.base}/api/v1/payments/initialize`, {
      method: 'POST',
      headers: signedHeaders(body, 'site-a-handoff-terminal'),
      body
    });
    const result = await initialized.json();
    assert.equal(initialized.status, 201);

    const extraQuery = await fetch(`${result.handoffUrl}&extra=value`, { redirect: 'manual' });
    assert.equal(extraQuery.status, 400);

    const stored = JSON.parse(fs.readFileSync(fixture.dataFile, 'utf8'));
    const savedTransaction = stored.transactions.find(item => item.id === result.transactionId);
    assert.equal(savedTransaction.handoffToken, undefined);
    assert.match(savedTransaction.handoffTokenHash, /^[a-f0-9]{64}$/);
    assert.match(savedTransaction.handoffTokenCiphertext, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    savedTransaction.expiresAt = new Date(Date.now() - 60 * 1000).toISOString();
    fs.writeFileSync(fixture.dataFile, JSON.stringify(stored, null, 2));
    const expired = await fetch(result.handoffUrl, { redirect: 'manual' });
    assert.equal(expired.status, 410);

    const expiredStored = JSON.parse(fs.readFileSync(fixture.dataFile, 'utf8'));
    expiredStored.transactions.find(item => item.id === result.transactionId).status = 'FAILED';
    fs.writeFileSync(fixture.dataFile, JSON.stringify(expiredStored, null, 2));
    const failed = await fetch(result.handoffUrl, { redirect: 'manual' });
    assert.equal(failed.status, 410);

    const terminalStored = JSON.parse(fs.readFileSync(fixture.dataFile, 'utf8'));
    terminalStored.transactions.find(item => item.id === result.transactionId).status = 'SUCCESS';
    fs.writeFileSync(fixture.dataFile, JSON.stringify(terminalStored, null, 2));
    const terminal = await fetch(result.handoffUrl, { redirect: 'manual' });
    assert.equal(terminal.status, 410);

    const terminalInit = await fetch(`${fixture.base}/api/v1/payments/initialize`, {
      method: 'POST',
      headers: signedHeaders(body, 'site-a-handoff-terminal-reinit'),
      body
    });
    assert.equal(terminalInit.status, 409);
  } finally {
    await fixture.stop();
  }
});

test('concurrent initialization reuses one Site B transaction and one Paystack payment', async () => {
  const fixture = await startFixture();
  try {
    const body = JSON.stringify({
      siteATransactionId: 'PH-TOPUP-INIT-001',
      siteAUserId: 'usr_init_001',
      amountMinor: 4200,
      currency: 'GHS',
      purpose: 'WALLET_TOPUP',
      customer: { email: 'bridgetfegerson2007+1@gmail.com' }
    });
    const [first, second] = await Promise.all([
      fetch(`${fixture.base}/api/v1/payments/initialize`, {
        method: 'POST',
        headers: signedHeaders(body, 'site-a-concurrent-init-1'),
        body
      }),
      fetch(`${fixture.base}/api/v1/payments/initialize`, {
        method: 'POST',
        headers: signedHeaders(body, 'site-a-concurrent-init-2'),
        body
      })
    ]);
    const firstResult = await first.json();
    const secondResult = await second.json();
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(secondResult.transactionId, firstResult.transactionId);
    assert.equal(secondResult.handoffUrl, firstResult.handoffUrl);
    assert.equal(fixture.initializeBodies.length, 1);
  } finally {
    await fixture.stop();
  }
});

test('KYC bypass initialization returns a Site B handoff without provider fields', async () => {
  const fixture = await startFixture();
  try {
    const body = JSON.stringify({
      siteATransactionId: 'PH-KYC-INIT-001',
      siteAUserId: 'usr_kyc_001',
      amountMinor: 7000,
      currency: 'GHS',
      purpose: 'KYC_BYPASS',
      customer: { email: 'bridgetfegerson2007+1@gmail.com' },
      returnUrl: 'http://127.0.0.1:3000/?kyc_bypass_reference=withdrawal_001'
    });
    const response = await fetch(`${fixture.base}/api/v1/payments/initialize`, {
      method: 'POST',
      headers: signedHeaders(body, 'site-a-kyc-handoff'),
      body
    });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.equal(result.authorizationUrl, undefined);
    assert.equal(result.paystackReference, undefined);
    assert.equal(new URL(result.handoffUrl).pathname, '/payment/handoff');
    assert.equal(result.expiresAt !== undefined, true);
  } finally {
    await fixture.stop();
  }
});

test('repeated initialization reuses the existing pending transaction and handoff', async () => {
  const fixture = await startFixture();
  try {
    const body = JSON.stringify({
      siteATransactionId: 'PH-TOPUP-ADMIN-001',
      siteAUserId: 'usr_admin_001',
      amountMinor: 18000,
      currency: 'GHS',
      purpose: 'WALLET_TOPUP',
      customer: { email: 'bridgetfegerson2007+1@gmail.com' }
    });
    const first = await fetch(`${fixture.base}/api/v1/payments/initialize`, {
      method: 'POST',
      headers: signedHeaders(body, 'site-a-idempotent-init-1'),
      body
    });
    const firstResult = await first.json();
    const second = await fetch(`${fixture.base}/api/v1/payments/initialize`, {
      method: 'POST',
      headers: signedHeaders(body, 'site-a-idempotent-init-2'),
      body
    });
    const secondResult = await second.json();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(secondResult.transactionId, firstResult.transactionId);
    assert.equal(secondResult.handoffUrl, firstResult.handoffUrl);
    assert.equal(fixture.initializeBodies.length, 0);
  } finally {
    await fixture.stop();
  }
});

test('provider initialization failure leaves a durable recoverable transaction and reuses its reference', async () => {
  const fixture = await startFixture({ initializeFailures: 1 });
  try {
    const body = JSON.stringify({
      siteATransactionId: 'PH-TOPUP-INIT-001',
      siteAUserId: 'usr_init_001',
      amountMinor: 4200,
      currency: 'GHS',
      purpose: 'WALLET_TOPUP',
      customer: { email: 'bridgetfegerson2007+1@gmail.com' }
    });
    const first = await fetch(`${fixture.base}/api/v1/payments/initialize`, {
      method: 'POST',
      headers: signedHeaders(body, 'site-a-init-failure-1'),
      body
    });
    assert.equal(first.status, 502);
    const firstStored = JSON.parse(fs.readFileSync(fixture.dataFile, 'utf8')).transactions.find(item => item.siteATransactionId === 'PH-TOPUP-INIT-001');
    assert.equal(firstStored.status, 'INITIALIZING');
    assert.match(firstStored.paystackReference, /^SBP_[A-Za-z0-9]+$/);
    assert.match(firstStored.handoffTokenHash, /^[a-f0-9]{64}$/);
    assert.equal(firstStored.authorizationUrl, undefined);

    const second = await fetch(`${fixture.base}/api/v1/payments/initialize`, {
      method: 'POST',
      headers: signedHeaders(body, 'site-a-init-failure-2'),
      body
    });
    const secondResult = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondResult.transactionId, firstStored.id);
    assert.equal(fixture.initializeBodies.length, 2);
    assert.equal(fixture.initializeBodies[0].reference, fixture.initializeBodies[1].reference);
  } finally {
    await fixture.stop();
  }
});

test('admin reconciliation looks up by Site A transaction ID and returns 404 when absent', async () => {
  const fixture = await startFixture();
  try {
    const body = JSON.stringify({ siteATransactionId: 'PH-TOPUP-ADMIN-001' });
    const found = await request(fixture.base, body);
    assert.equal(found.response.status, 200);
    assert.equal(found.body.paystackReference, 'PCS_admin_reference_001');

    const missingBody = JSON.stringify({ siteATransactionId: 'PH-TOPUP-ADMIN-MISSING' });
    const missing = await request(fixture.base, missingBody);
    assert.equal(missing.response.status, 404);
  } finally {
    await fixture.stop();
  }
});

test('admin reconciliation rejects a provided Paystack reference mismatch', async () => {
  const fixture = await startFixture();
  try {
    const body = JSON.stringify({ siteATransactionId: 'PH-TOPUP-ADMIN-001', paystackReference: 'PCS_wrong_reference' });
    const result = await request(fixture.base, body);
    assert.equal(result.response.status, 409);
    assert.match(result.body.error, /does not match/);
    assert.equal(fixture.verifyRequests.length, 0);
  } finally {
    await fixture.stop();
  }
});

test('admin reconciliation validates Paystack data before changing status', async () => {
  const stored = transaction();
  const fixture = await startFixture({ storedTransaction: stored, paystackPayment: paystackPayment(stored, { amount: stored.amountMinor + 1 }) });
  try {
    const body = JSON.stringify({ siteATransactionId: stored.siteATransactionId });
    const result = await request(fixture.base, body);
    assert.equal(result.response.status, 409);
    assert.match(result.body.error, /did not match/);
    assert.equal(JSON.parse(fs.readFileSync(fixture.dataFile, 'utf8')).transactions[0].status, 'PENDING');
  } finally {
    await fixture.stop();
  }
});

test('successful admin reconciliation marks success and sends the source-tagged callback', async () => {
  const stored = transaction();
  const fixture = await startFixture({ storedTransaction: stored, paystackPayment: paystackPayment(stored) });
  try {
    const body = JSON.stringify({ siteATransactionId: stored.siteATransactionId, paystackReference: stored.paystackReference });
    const result = await request(fixture.base, body);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, {
      ok: true,
      transactionId: stored.id,
      siteATransactionId: stored.siteATransactionId,
      paystackReference: stored.paystackReference,
      status: 'SUCCESS',
      paystackStatus: 'success',
      callbackDelivered: true,
      amountMinor: stored.amountMinor,
      currency: stored.currency
    });
    assert.equal(fixture.callbacks.length, 1);
    assert.equal(fixture.callbacks[0].body.source, 'admin-reconciliation');
    assert.equal(fixture.callbacks[0].body.status, 'SUCCESS');
    assert.equal(JSON.parse(fs.readFileSync(fixture.dataFile, 'utf8')).transactions[0].status, 'SUCCESS');
  } finally {
    await fixture.stop();
  }
});

test('admin reconciliation retries a previously delivered callback when no admin retry was recorded', async () => {
  const stored = transaction({ status: 'SUCCESS', callbackDeliveredAt: new Date(Date.now() - 1000).toISOString() });
  const fixture = await startFixture({ storedTransaction: stored, paystackPayment: paystackPayment(stored) });
  try {
    const result = await request(fixture.base, JSON.stringify({ siteATransactionId: stored.siteATransactionId }));
    assert.equal(result.response.status, 200);
    assert.equal(result.body.status, 'SUCCESS');
    assert.equal(result.body.callbackDelivered, true);
    assert.equal(fixture.callbacks.length, 1);
    assert.equal(fixture.callbacks[0].body.source, 'admin-reconciliation');
  } finally {
    await fixture.stop();
  }
});

test('failed Site A callbacks are durably retried by the Site B worker', async () => {
  const stored = transaction();
  const fixture = await startFixture({ storedTransaction: stored, paystackPayment: paystackPayment(stored), callbackFailures: 1, callbackRetryIntervalMs: 20 });
  try {
    const result = await request(fixture.base, JSON.stringify({ siteATransactionId: stored.siteATransactionId }));
    assert.equal(result.response.status, 502);
    assert.equal(result.body.callbackDelivered, false);
    assert.equal(fixture.callbacks.length >= 1, true);

    const deadline = Date.now() + 1500;
    let saved;
    while (Date.now() < deadline) {
      saved = JSON.parse(fs.readFileSync(fixture.dataFile, 'utf8')).transactions[0];
      if (saved.callbackDelivery?.deliveredAt) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(Boolean(saved.callbackDelivery?.deliveredAt), true);
    assert.equal(saved.callbackDelivery.attempts, 2);
    assert.equal(fixture.callbacks.length >= 2, true);
  } finally {
    await fixture.stop();
  }
});

test('scheduled reconciliation recovers a successful payment when no webhook arrived', async () => {
  const stored = transaction();
  const fixture = await startFixture({ storedTransaction: stored, paystackPayment: paystackPayment(stored), paymentReconciliationIntervalMs: 20 });
  try {
    const deadline = Date.now() + 1500;
    let saved;
    while (Date.now() < deadline) {
      saved = JSON.parse(fs.readFileSync(fixture.dataFile, 'utf8')).transactions[0];
      if (saved.callbackDelivery?.deliveredAt) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(saved.status, 'SUCCESS');
    assert.equal(Boolean(saved.callbackDelivery?.deliveredAt), true);
    assert.equal(fixture.callbacks.length, 1);
    assert.equal(fixture.verifyRequests.length >= 1, true);
  } finally {
    await fixture.stop();
  }
});

test('expired transactions can be confirmed successfully by admin reconciliation', async () => {
  const stored = transaction({ status: 'EXPIRED', expiresAt: new Date(Date.now() - 1000).toISOString() });
  const fixture = await startFixture({ storedTransaction: stored, paystackPayment: paystackPayment(stored) });
  try {
    const result = await request(fixture.base, JSON.stringify({ siteATransactionId: stored.siteATransactionId }));
    assert.equal(result.response.status, 200);
    assert.equal(result.body.status, 'SUCCESS');
    assert.equal(fixture.callbacks.length, 1);
  } finally {
    await fixture.stop();
  }
});

test('previously failed transactions can be rechecked and promoted after Paystack success', async () => {
  const stored = transaction({ status: 'FAILED' });
  const fixture = await startFixture({ storedTransaction: stored, paystackPayment: paystackPayment(stored) });
  try {
    const result = await request(fixture.base, JSON.stringify({ siteATransactionId: stored.siteATransactionId }));
    assert.equal(result.response.status, 200);
    assert.equal(result.body.status, 'SUCCESS');
    assert.equal(fixture.callbacks.length, 1);
  } finally {
    await fixture.stop();
  }
});

test('duplicate admin reconciliation verifies again but does not duplicate callbacks or payments', async () => {
  const stored = transaction();
  const fixture = await startFixture({ storedTransaction: stored, paystackPayment: paystackPayment(stored) });
  try {
    const body = JSON.stringify({ siteATransactionId: stored.siteATransactionId });
    const first = await request(fixture.base, body, signedHeaders(body, 'admin-reconcile-duplicate-1'));
    const second = await request(fixture.base, body, signedHeaders(body, 'admin-reconcile-duplicate-2'));
    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 200);
    assert.equal(first.body.status, 'SUCCESS');
    assert.equal(second.body.status, 'SUCCESS');
    assert.equal(fixture.callbacks.length, 1);
    assert.equal(fixture.initializeRequests.length, 0);
  } finally {
    await fixture.stop();
  }
});

test('legacy Site A metadata remains verifiable for existing transactions', async () => {
  const stored = transaction();
  const fixture = await startFixture({
    storedTransaction: stored,
    paystackPayment: paystackPayment(stored, {
      metadata: {
        site: 'SITE_A',
        siteATransactionId: stored.siteATransactionId,
        siteAUserId: stored.siteAUserId,
        purpose: stored.purpose
      }
    })
  });
  try {
    const result = await request(fixture.base, JSON.stringify({ siteATransactionId: stored.siteATransactionId }));
    assert.equal(result.response.status, 200);
    assert.equal(result.body.status, 'SUCCESS');
  } finally {
    await fixture.stop();
  }
});
