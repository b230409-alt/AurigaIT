const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'perkline-test-'));
process.env.JWT_SECRET = 'automated-test-secret-12345678901234567890';
process.env.COOKIE_SECURE = 'false';
process.env.DATABASE_PATH = path.join(testDirectory, 'rewards.db');
process.env.PLATINUM_ACTIVATION_PATH = path.join(testDirectory, 'platinum-activation.txt');

const { app, db, tierFor, calculatePurchasePoints, dispatchOutbox } = require('../server');
let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

test('tier thresholds and purchase points use the pre-purchase tier', () => {
  assert.equal(tierFor(499).name, 'Member');
  assert.equal(tierFor(500).name, 'Silver');
  assert.equal(tierFor(1499).name, 'Silver');
  assert.equal(tierFor(1500).name, 'Gold');
  assert.equal(tierFor(5000).name, 'Platinum');
  assert.equal(tierFor(5000, false).name, 'Gold');
  assert.equal(calculatePurchasePoints(49900, 0), 499);
  assert.equal(calculatePurchasePoints(100, 499), 1);
  assert.equal(calculatePurchasePoints(400, 500), 5);
  assert.equal(calculatePurchasePoints(1, 1500), 1);
  assert.equal(calculatePurchasePoints(10000, 5000), 30);
});

function cookieValue(setCookie) {
  return setCookie.split(';', 1)[0].split('=', 2);
}

function createSession() {
  const cookies = new Map();
  return {
    cookies,
    header() { return [...cookies].map(([name, value]) => `${name}=${value}`).join('; '); },
    update(response) {
      const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : (response.headers.get('set-cookie') || '').split(/,(?=[^\s;,]+=)/);
      for (const setCookie of setCookies.filter(Boolean)) {
        const [name, value] = cookieValue(setCookie);
        cookies.set(name, value);
      }
    }
  };
}

async function call(session, route, { method = 'GET', body, csrf = method !== 'GET' } = {}) {
  if (csrf && !session.cookies.has('perkline_csrf')) await call(session, '/api/auth/csrf', { csrf: false });
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf) headers['X-CSRF-Token'] = session.cookies.get('perkline_csrf');
  if (session.cookies.size) headers.Cookie = session.header();
  const response = await fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  session.update(response);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function register(session, suffix) {
  const result = await call(session, '/api/auth/register', { method: 'POST', body: { name: `Test Staff ${suffix}`, email: `test-${suffix}-${Date.now()}@example.com`, password: 'password123' } });
  assert.equal(result.response.status, 201);
}

async function addMember(session, phone, name = 'Test Member') {
  const result = await call(session, '/api/members', { method: 'POST', body: { name, phone } });
  assert.equal(result.response.status, 201);
  return result.body.member.id;
}

test('purchase, exact redemption, over-redemption, validation, and phone lookup flow', async () => {
  const session = createSession();
  await register(session, 'flow');
  const memberId = await addMember(session, '001234569', 'Leading Zero Member');

  const search = await call(session, '/api/members?search=12345&page=1&pageSize=10', { csrf: false });
  assert.equal(search.response.status, 200);
  assert.equal(search.body.members.some((member) => member.id === memberId), true);

  const duplicate = await call(session, '/api/members', { method: 'POST', body: { name: 'Duplicate', phone: '+00 123 4569' } });
  assert.equal(duplicate.response.status, 409);

  for (const amountCents of [0, -100]) {
    const invalid = await call(session, `/api/members/${memberId}/purchases`, { method: 'POST', body: { amountCents } });
    assert.equal(invalid.response.status, 400);
  }

  await call(session, `/api/members/${memberId}/purchases`, { method: 'POST', body: { amountCents: 49900 } });
  const boundary = await call(session, `/api/members/${memberId}/purchases`, { method: 'POST', body: { amountCents: 100 } });
  assert.equal(boundary.body.member.balance, 500);
  assert.equal(boundary.body.transaction.points_delta, 1);
  const silverPurchase = await call(session, `/api/members/${memberId}/purchases`, { method: 'POST', body: { amountCents: 400 } });
  assert.equal(silverPurchase.body.transaction.points_delta, 5);

  const exact = await call(session, `/api/members/${memberId}/redemptions`, { method: 'POST', body: { points: 505 } });
  assert.equal(exact.response.status, 201);
  assert.equal(exact.body.member.balance, 0);
  const over = await call(session, `/api/members/${memberId}/redemptions`, { method: 'POST', body: { points: 1 } });
  assert.equal(over.response.status, 400);
});

test('legacy 5000-point members re-evaluate as Platinum only on their next transaction', async () => {
  const session = createSession();
  await register(session, 'platinum');
  const staffId = db.prepare('SELECT id FROM staff ORDER BY id DESC LIMIT 1').get().id;
  const memberResult = db.prepare('INSERT INTO members (name, phone) VALUES (?, ?)').run('Legacy Platinum Member', '001234571');
  const memberId = Number(memberResult.lastInsertRowid);
  const activationTime = Date.parse(fs.readFileSync(process.env.PLATINUM_ACTIVATION_PATH, 'utf8'));
  const oldTransactionTime = new Date(activationTime - 1000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('INSERT INTO point_transactions (member_id, staff_id, type, points_delta, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(memberId, staffId, 'purchase', 5000, 500000, oldTransactionTime);

  const before = await call(session, `/api/members/${memberId}`, { csrf: false });
  assert.equal(before.body.member.lifetime_points, 5000);
  assert.equal(before.body.member.tier, 'Gold');
  assert.equal(db.prepare('SELECT points_delta, amount_cents FROM point_transactions WHERE member_id = ?').get(memberId).points_delta, 5000);

  const next = await call(session, `/api/members/${memberId}/redemptions`, { method: 'POST', body: { points: 1 } });
  assert.equal(next.response.status, 201);
  assert.equal(next.body.member.tier, 'Platinum');
  assert.equal(next.body.member.balance, 4999);
  assert.deepEqual(db.prepare('SELECT points_delta, amount_cents FROM point_transactions WHERE member_id = ? ORDER BY id').all(memberId), [{ points_delta: 5000, amount_cents: 500000 }, { points_delta: -1, amount_cents: null }]);
});

test('a purchase crossing 5000 earns at Gold rate, then the next purchase earns Platinum rate', async () => {
  const session = createSession();
  await register(session, 'platinum-crossing');
  const staffId = db.prepare('SELECT id FROM staff ORDER BY id DESC LIMIT 1').get().id;
  const memberResult = db.prepare('INSERT INTO members (name, phone) VALUES (?, ?)').run('Crossing Platinum Member', '001234572');
  const memberId = Number(memberResult.lastInsertRowid);
  const activationTime = Date.parse(fs.readFileSync(process.env.PLATINUM_ACTIVATION_PATH, 'utf8'));
  const oldTransactionTime = new Date(activationTime - 1000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('INSERT INTO point_transactions (member_id, staff_id, type, points_delta, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(memberId, staffId, 'purchase', 4999, 499900, oldTransactionTime);

  const crossingPurchase = await call(session, `/api/members/${memberId}/purchases`, { method: 'POST', body: { amountCents: 200 } });
  assert.equal(crossingPurchase.response.status, 201);
  assert.equal(crossingPurchase.body.transaction.points_delta, 3);
  assert.equal(crossingPurchase.body.member.lifetime_points_earned, 5002);
  assert.equal(crossingPurchase.body.member.tier, 'Platinum');

  const nextPurchase = await call(session, `/api/members/${memberId}/purchases`, { method: 'POST', body: { amountCents: 10000 } });
  assert.equal(nextPurchase.response.status, 201);
  assert.equal(nextPurchase.body.transaction.points_delta, 30);
  assert.equal(nextPurchase.body.member.lifetime_points_earned, 5032);
  assert.deepEqual(db.prepare('SELECT points_delta FROM point_transactions WHERE member_id = ? ORDER BY id').all(memberId).map((row) => row.points_delta), [4999, 3, 30]);

  const queued = db.prepare('SELECT event_key, event_type, status, attempts, payload FROM outbox WHERE member_id = ?').all(memberId);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].event_type, 'tier_crossed');
  assert.equal(queued[0].status, 'pending');
  assert.equal(JSON.parse(queued[0].payload).from_tier, 'Gold');
  assert.equal(JSON.parse(queued[0].payload).to_tier, 'Platinum');
  db.prepare('UPDATE outbox SET status = \'sent\' WHERE member_id <> ?').run(memberId);

  let notifications = 0;
  const firstDispatch = await dispatchOutbox({ notify: async () => { notifications += 1; throw new Error('notification unavailable'); } });
  assert.equal(firstDispatch.failed, 1);
  assert.equal(db.prepare('SELECT status, attempts FROM outbox WHERE member_id = ?').get(memberId).status, 'failed');
  db.prepare("UPDATE outbox SET next_attempt_at = datetime('now') WHERE member_id = ?").run(memberId);
  const retryDispatch = await dispatchOutbox({ notify: async (payload, eventKey) => { notifications += 1; assert.equal(payload.event_id, eventKey); } });
  assert.equal(retryDispatch.sent, 1);
  assert.equal(notifications, 2);
  const idempotentDispatch = await dispatchOutbox({ notify: async () => { throw new Error('must not notify twice'); } });
  assert.equal(idempotentDispatch.claimed, 0);
});

test('concurrent purchase and redemption preserve the exact ledger balance', async () => {
  const staffA = createSession();
  const staffB = createSession();
  await register(staffA, 'concurrent-a');
  await register(staffB, 'concurrent-b');
  const memberId = await addMember(staffA, '001234570', 'Concurrent Member');
  const seed = await call(staffA, `/api/members/${memberId}/purchases`, { method: 'POST', body: { amountCents: 1000 } });
  assert.equal(seed.response.status, 201);

  const [purchase, redemption] = await Promise.all([
    call(staffA, `/api/members/${memberId}/purchases`, { method: 'POST', body: { amountCents: 1000 } }),
    call(staffB, `/api/members/${memberId}/redemptions`, { method: 'POST', body: { points: 10 } })
  ]);
  assert.equal(purchase.response.status, 201);
  assert.equal(redemption.response.status, 201);

  const final = await call(staffA, `/api/members/${memberId}`, { csrf: false });
  assert.equal(final.response.status, 200);
  assert.equal(final.body.member.balance, 10);
  assert.equal(final.body.member.lifetime_points, 20);
});

test('point expiry does not create a tier-crossing notification', async () => {
  const session = createSession();
  await register(session, 'expiry-outbox');
  const staffId = db.prepare('SELECT id FROM staff ORDER BY id DESC LIMIT 1').get().id;
  const memberResult = db.prepare('INSERT INTO members (name, phone) VALUES (?, ?)').run('Expiry Notification Member', '001234573');
  const memberId = Number(memberResult.lastInsertRowid);
  db.prepare('INSERT INTO point_transactions (member_id, staff_id, type, points_delta, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(memberId, staffId, 'purchase', 500, 50000, '2029-01-01 00:00:00');

  const clock = await call(session, '/clock', { method: 'POST', body: { now: '2029-04-10T00:00:00.000Z' } });
  assert.equal(clock.response.status, 200);
  const expiry = await call(session, '/api/jobs/expire-points', { method: 'POST', body: {} });
  assert.equal(expiry.response.status, 200);
  assert.deepEqual(expiry.body.entries.filter((entry) => entry.member_id === memberId).map((entry) => entry.points), [500]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM outbox WHERE member_id = ?').get(memberId).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM point_transactions WHERE member_id = ? AND type = 'expiry'").get(memberId).count, 1);
});
