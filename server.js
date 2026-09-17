const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const Database = require('better-sqlite3');

const app = express();
const port = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const cookieSecure = isProduction || process.env.COOKIE_SECURE === 'true';
const sessionCookieName = 'perkline_session';
const csrfCookieName = 'perkline_csrf';
const passwordCost = 12;
const jwtExpiry = '12h';
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must be set to a random value of at least 32 characters.');
const dataDirectory = path.join(__dirname, 'data');
fs.mkdirSync(dataDirectory, { recursive: true });
const databasePath = process.env.DATABASE_PATH || path.join(dataDirectory, 'rewards.db');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const platinumActivationPath = process.env.PLATINUM_ACTIVATION_PATH || path.join(path.dirname(databasePath), 'platinum-activation.txt');
if (!fs.existsSync(platinumActivationPath)) fs.writeFileSync(platinumActivationPath, new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), 'utf8');
const platinumActivatedAt = fs.readFileSync(platinumActivationPath, 'utf8').trim();
const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    email TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS point_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES members(id),
    staff_id INTEGER NOT NULL REFERENCES staff(id),
    type TEXT NOT NULL CHECK(type IN ('purchase', 'redemption', 'expiry')),
    points_delta INTEGER NOT NULL CHECK(points_delta <> 0),
    amount_cents INTEGER,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER REFERENCES point_transactions(id),
    staff_id INTEGER REFERENCES staff(id),
    member_id INTEGER REFERENCES members(id),
    action TEXT NOT NULL CHECK(action IN ('purchase', 'redemption', 'failed_redemption', 'login_success', 'failed_login')),
    details TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone);
  CREATE INDEX IF NOT EXISTS idx_transactions_member_created ON point_transactions(member_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_member_created ON audit_logs(member_id, created_at DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL CHECK(event_type = 'tier_crossed'),
    member_id INTEGER NOT NULL REFERENCES members(id),
    transaction_id INTEGER NOT NULL REFERENCES point_transactions(id),
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'sent', 'failed', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error TEXT,
    processing_started_at TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status, next_attempt_at, id);
`);

const outboxSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbox'").get();
if (outboxSchema && !outboxSchema.sql.includes('processing_started_at')) {
  db.transaction(() => {
    db.exec(`CREATE TABLE outbox_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL CHECK(event_type = 'tier_crossed'),
      member_id INTEGER NOT NULL REFERENCES members(id),
      transaction_id INTEGER NOT NULL REFERENCES point_transactions(id),
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'sent', 'failed', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_error TEXT,
      processing_started_at TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('INSERT INTO outbox_new (id, event_key, event_type, member_id, transaction_id, payload, status, attempts, next_attempt_at, last_error, sent_at, created_at) SELECT id, event_key, event_type, member_id, transaction_id, payload, status, attempts, next_attempt_at, last_error, sent_at, created_at FROM outbox');
    db.exec('DROP TABLE outbox');
    db.exec('ALTER TABLE outbox_new RENAME TO outbox');
    db.exec('CREATE INDEX idx_outbox_pending ON outbox(status, next_attempt_at, id)');
  })();
}

const transactionSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'point_transactions'").get();
if (transactionSchema && !transactionSchema.sql.includes("'expiry'")) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`CREATE TABLE point_transactions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL REFERENCES members(id),
      staff_id INTEGER NOT NULL REFERENCES staff(id),
      type TEXT NOT NULL CHECK(type IN ('purchase', 'redemption', 'expiry')),
      points_delta INTEGER NOT NULL CHECK(points_delta <> 0),
      amount_cents INTEGER,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('INSERT INTO point_transactions_new (id, member_id, staff_id, type, points_delta, amount_cents, note, created_at) SELECT id, member_id, staff_id, type, points_delta, amount_cents, note, created_at FROM point_transactions');
    db.exec('DROP TABLE point_transactions');
    db.exec('ALTER TABLE point_transactions_new RENAME TO point_transactions');
    db.exec('CREATE INDEX idx_transactions_member_created ON point_transactions(member_id, created_at DESC)');
  })();
  db.pragma('foreign_keys = ON');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS point_lots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    earn_transaction_id INTEGER NOT NULL UNIQUE REFERENCES point_transactions(id),
    member_id INTEGER NOT NULL REFERENCES members(id),
    original_points INTEGER NOT NULL CHECK(original_points > 0),
    earned_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS lot_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lot_id INTEGER NOT NULL REFERENCES point_lots(id),
    transaction_id INTEGER NOT NULL REFERENCES point_transactions(id),
    points INTEGER NOT NULL CHECK(points > 0),
    kind TEXT NOT NULL CHECK(kind IN ('redemption', 'expiry')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(lot_id, transaction_id)
  );
  CREATE INDEX IF NOT EXISTS idx_point_lots_member_earned ON point_lots(member_id, earned_at, id);
  CREATE INDEX IF NOT EXISTS idx_lot_allocations_lot ON lot_allocations(lot_id);
`);

db.prepare(`
  INSERT OR IGNORE INTO point_lots (earn_transaction_id, member_id, original_points, earned_at)
  SELECT id, member_id, points_delta, created_at
  FROM point_transactions
  WHERE type = 'purchase' AND points_delta > 0
`).run();

const auditSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_logs'").get();
if (auditSchema && !auditSchema.sql.includes('failed_login')) {
  db.transaction(() => {
    db.exec(`CREATE TABLE audit_logs_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER REFERENCES point_transactions(id),
      staff_id INTEGER REFERENCES staff(id),
      member_id INTEGER REFERENCES members(id),
      action TEXT NOT NULL CHECK(action IN ('purchase', 'redemption', 'failed_redemption', 'login_success', 'failed_login')),
      details TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.exec('INSERT INTO audit_logs_new (id, transaction_id, staff_id, member_id, action, details, created_at) SELECT id, transaction_id, staff_id, member_id, action, details, created_at FROM audit_logs');
    db.exec('DROP TABLE audit_logs');
    db.exec('ALTER TABLE audit_logs_new RENAME TO audit_logs');
    db.exec('CREATE INDEX idx_audit_member_created ON audit_logs(member_id, created_at DESC)');
  })();
}

app.use(express.json({ limit: '10kb', strict: true }));
app.set('trust proxy', 1);
app.use((req, res, next) => {
  if (isProduction && req.get('x-forwarded-proto') !== 'https') return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));
app.use(express.static(path.join(__dirname, 'public')));

const rateLimits = new Map();
const accountFailures = new Map();
const dummyPasswordHash = bcrypt.hashSync('invalid-login-placeholder', passwordCost);
const notificationServiceUrl = process.env.NOTIFICATION_SERVICE_URL || '';
const outboxRetryDelayMs = Number(process.env.OUTBOX_RETRY_DELAY_MS || 5000);
const outboxMaxAttempts = 5;
const outboxProcessingTimeoutMs = 60 * 1000;
let simulatedNow = null;
function currentTimeIso() { return (simulatedNow || new Date()).toISOString(); }
function currentClockDate() { return simulatedNow || new Date(); }
function parseStoredTime(value) { return value.includes('T') ? Date.parse(value) : Date.parse(`${value.replace(' ', 'T')}Z`); }
function remainingLots(memberId) {
  return db.prepare(`
    SELECT l.id, l.earn_transaction_id, l.member_id, l.original_points, l.earned_at,
      l.original_points - COALESCE(SUM(a.points), 0) AS remaining_points,
      t.staff_id AS earn_staff_id
    FROM point_lots l
    JOIN point_transactions t ON t.id = l.earn_transaction_id
    LEFT JOIN lot_allocations a ON a.lot_id = l.id
    WHERE l.member_id = ?
    GROUP BY l.id
    HAVING remaining_points > 0
    ORDER BY l.earned_at ASC, l.id ASC
  `).all(memberId);
}
function ensureLotsForPurchases() {
  db.prepare(`
    INSERT OR IGNORE INTO point_lots (earn_transaction_id, member_id, original_points, earned_at)
    SELECT id, member_id, points_delta, created_at
    FROM point_transactions
    WHERE type = 'purchase' AND points_delta > 0
  `).run();
}
function allocateLots(transactionId, memberId, points, kind) {
  let remaining = points;
  for (const lot of remainingLots(memberId)) {
    if (remaining === 0) break;
    const allocated = Math.min(remaining, Number(lot.remaining_points));
    db.prepare('INSERT INTO lot_allocations (lot_id, transaction_id, points, kind) VALUES (?, ?, ?, ?)').run(lot.id, transactionId, allocated, kind);
    remaining -= allocated;
  }
  if (remaining > 0) throw new Error('Point lot allocation was incomplete.');
}
function expirePoints() {
  ensureLotsForPurchases();
  const cutoff = new Date(currentClockDate().getTime() - (90 * 24 * 60 * 60 * 1000)).toISOString();
  const expired = db.transaction(() => {
    const lots = db.prepare(`
      SELECT l.id, l.member_id, l.original_points, l.earned_at,
        l.original_points - COALESCE(SUM(a.points), 0) AS remaining_points,
        t.staff_id AS earn_staff_id
      FROM point_lots l
      JOIN point_transactions t ON t.id = l.earn_transaction_id
      LEFT JOIN lot_allocations a ON a.lot_id = l.id
      WHERE l.earned_at < ?
      GROUP BY l.id
      HAVING remaining_points > 0
      ORDER BY l.earned_at ASC, l.id ASC
    `).all(cutoff);
    const entries = [];
    for (const lot of lots) {
      const transaction = db.prepare('INSERT INTO point_transactions (member_id, staff_id, type, points_delta, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(lot.member_id, lot.earn_staff_id, 'expiry', -Number(lot.remaining_points), `EXPIRY lot ${lot.id}`, currentTimeIso());
      db.prepare('INSERT INTO lot_allocations (lot_id, transaction_id, points, kind) VALUES (?, ?, ?, ?)').run(lot.id, transaction.lastInsertRowid, Number(lot.remaining_points), 'expiry');
      entries.push({ lot_id: lot.id, member_id: lot.member_id, points: Number(lot.remaining_points) });
    }
    return entries;
  })();
  return { expired_lots: expired.length, expired_points: expired.reduce((total, entry) => total + entry.points, 0), entries: expired };
}
function writeAudit({ transactionId = null, staffId = null, memberId = null, action, details }) {
  db.prepare('INSERT INTO audit_logs (transaction_id, staff_id, member_id, action, details) VALUES (?, ?, ?, ?, ?)').run(transactionId, staffId, memberId, action, JSON.stringify(details));
}
function enqueueTierEvent(member, transactionId, fromTier, toTier) {
  const eventKey = `tier-crossed:${member.id}:${transactionId}`;
  db.prepare(`INSERT INTO outbox (event_key, event_type, member_id, transaction_id, payload)
    VALUES (?, 'tier_crossed', ?, ?, ?)`).run(eventKey, member.id, transactionId, JSON.stringify({
      event_id: eventKey,
      event_type: 'tier_crossed',
      member_id: member.id,
      member_name: member.name,
      transaction_id: transactionId,
      from_tier: fromTier,
      to_tier: toTier,
      lifetime_points_earned: Number(member.lifetime_points)
    }));
}
async function dispatchOutbox({ limit = 20, notify } = {}) {
  const maximum = Math.min(100, Math.max(1, Number(limit) || 20));
  const notifier = notify || (async (event, eventKey) => {
    if (!notificationServiceUrl) throw new Error('NOTIFICATION_SERVICE_URL is not configured.');
    const response = await fetch(notificationServiceUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': eventKey }, body: JSON.stringify(event) });
    if (!response.ok) throw new Error(`Notification Service returned HTTP ${response.status}.`);
  });
  db.prepare("UPDATE outbox SET status = CASE WHEN attempts >= ? THEN 'dead' ELSE 'failed' END, last_error = COALESCE(last_error, 'Dispatcher reclaim after timeout'), next_attempt_at = CURRENT_TIMESTAMP, processing_started_at = NULL WHERE status = 'processing' AND (processing_started_at IS NULL OR processing_started_at <= datetime('now', '-' || ? || ' seconds'))").run(outboxMaxAttempts, Math.ceil(outboxProcessingTimeoutMs / 1000));
  const claimed = db.prepare(`
    UPDATE outbox
    SET status = 'processing', attempts = attempts + 1, processing_started_at = CURRENT_TIMESTAMP
    WHERE id IN (
      SELECT id FROM outbox
      WHERE status IN ('pending', 'failed') AND attempts < ? AND next_attempt_at <= CURRENT_TIMESTAMP
      ORDER BY id ASC LIMIT ?
    )
    RETURNING id, event_key, payload, attempts
  `).all(outboxMaxAttempts, maximum);
  const results = [];
  for (const row of claimed) {
    try {
      await notifier(JSON.parse(row.payload), row.event_key);
      db.prepare("UPDATE outbox SET status = 'sent', sent_at = CURRENT_TIMESTAMP, last_error = NULL, processing_started_at = NULL WHERE id = ? AND status = 'processing'").run(row.id);
      results.push({ id: row.id, status: 'sent' });
    } catch (error) {
      const terminal = row.attempts >= outboxMaxAttempts;
      db.prepare("UPDATE outbox SET status = ?, last_error = ?, next_attempt_at = datetime(CURRENT_TIMESTAMP, '+' || ? || ' seconds'), processing_started_at = NULL WHERE id = ? AND status = 'processing'").run(terminal ? 'dead' : 'failed', error.message, Math.ceil(outboxRetryDelayMs / 1000), row.id);
      results.push({ id: row.id, status: terminal ? 'dead' : 'failed', error: error.message });
    }
  }
  return { claimed: claimed.length, sent: results.filter((result) => result.status === 'sent').length, failed: results.filter((result) => result.status === 'failed').length, dead: results.filter((result) => result.status === 'dead').length, results };
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').filter(Boolean).map((part) => {
    const separator = part.indexOf('=');
    const key = separator >= 0 ? part.slice(0, separator).trim() : part.trim();
    const value = separator >= 0 ? part.slice(separator + 1).trim() : '';
    try { return [key, decodeURIComponent(value)]; } catch { return [key, value]; }
  }));
}
function issueCsrfCookie(res, existingToken) {
  const token = existingToken || crypto.randomBytes(32).toString('hex');
  res.cookie(csrfCookieName, token, { httpOnly: false, secure: cookieSecure, sameSite: 'strict', path: '/' });
  return token;
}
function csrfProtection(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const suppliedToken = req.get('x-csrf-token');
  const cookieToken = cookies[csrfCookieName];
  const validLengths = cookieToken && suppliedToken && cookieToken.length === suppliedToken.length;
  const validToken = validLengths && crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(suppliedToken));
  if (!validToken) return res.status(403).json({ error: 'CSRF validation failed. Refresh and try again.' });
  next();
}
function rateLimit({ windowMs, max, key, auditAction }) {
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = `${key}:${req.ip}`;
    const bucket = rateLimits.get(bucketKey);
    if (!bucket || now - bucket.startedAt >= windowMs) rateLimits.set(bucketKey, { startedAt: now, count: 1 });
    else if (++bucket.count > max) {
      if (auditAction) {
        const candidateMemberId = Number.isSafeInteger(Number(req.params?.id)) ? Number(req.params.id) : null;
        const member = candidateMemberId ? memberSummary(candidateMemberId) : null;
        writeAudit({ staffId: req.staff?.id || null, memberId: member?.id || null, action: auditAction, details: { reason: 'rate_limited', ip: req.ip } });
      }
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    next();
  };
}

function tierFor(lifetimePoints, platinumEligible = true) {
  if (platinumEligible && lifetimePoints >= 5000) return { name: 'Platinum', multiplier: 0.3, next: null };
  if (lifetimePoints >= 1500) return { name: 'Gold', multiplier: 1.5, next: null };
  if (lifetimePoints >= 500) return { name: 'Silver', multiplier: 1.25, next: 1500 };
  return { name: 'Member', multiplier: 1, next: 500 };
}

function calculatePurchasePoints(amountCents, lifetimePoints, platinumEligible = true) {
  const points = Math.floor((amountCents * tierFor(lifetimePoints, platinumEligible).multiplier) / 100);
  return Math.max(1, points);
}

function memberTier(member) {
  const latestTransactionTime = member.latest_transaction_at ? parseStoredTime(member.latest_transaction_at) : 0;
  return tierFor(Number(member.lifetime_points), latestTransactionTime >= Date.parse(platinumActivatedAt));
}

function memberSummary(memberId) {
  return db.prepare(`
    SELECT m.id, m.name, m.phone, m.email, m.created_at,
      COALESCE(SUM(t.points_delta), 0) AS balance,
      COALESCE(SUM(CASE WHEN t.type = 'purchase' THEN t.points_delta ELSE 0 END), 0) AS lifetime_points,
      COUNT(t.id) AS transaction_count,
      MAX(t.created_at) AS latest_transaction_at
    FROM members m LEFT JOIN point_transactions t ON t.member_id = m.id
    WHERE m.id = ? GROUP BY m.id
  `).get(memberId);
}

function serializeMember(member) {
  const lifetimePoints = Number(member.lifetime_points);
  const tier = memberTier(member);
  return { id: member.id, name: member.name, phone: member.phone, email: member.email, created_at: member.created_at, balance: Number(member.balance), lifetime_points: lifetimePoints, lifetime_points_earned: lifetimePoints, transaction_count: Number(member.transaction_count), tier: tier.name, multiplier: tier.multiplier, points_to_next_tier: tier.next ? Math.max(0, tier.next - lifetimePoints) : 0 };
}

function auth(req, res, next) {
  const token = parseCookies(req.headers.cookie)[sessionCookieName];
  if (!token) return res.status(401).json({ error: 'Sign in is required.' });
  try { req.staff = jwt.verify(token, jwtSecret); next(); } catch { return res.status(401).json({ error: 'Your session has expired. Sign in again.' }); }
}

function normalizePhone(value) { return String(value || '').replace(/\D/g, ''); }
function signStaff(staff) { return jwt.sign({ id: staff.id, name: staff.name, email: staff.email }, jwtSecret, { expiresIn: jwtExpiry }); }
function publicStaff(staff) { return { id: staff.id, name: staff.name, email: staff.email }; }
function setSessionCookie(res, staff) {
  res.cookie(sessionCookieName, signStaff(staff), { httpOnly: true, secure: cookieSecure, sameSite: 'strict', maxAge: 12 * 60 * 60 * 1000, path: '/' });
}
function accountLock(emailAddress) {
  const record = accountFailures.get(emailAddress);
  if (!record) return null;
  if (Date.now() >= record.lockedUntil && Date.now() - record.windowStarted >= 15 * 60 * 1000) {
    accountFailures.delete(emailAddress);
    return null;
  }
  return record;
}
function recordLoginFailure(emailAddress) {
  const now = Date.now();
  const record = accountLock(emailAddress);
  const next = record && now - record.windowStarted < 15 * 60 * 1000
    ? record
    : { count: 0, windowStarted: now, lockedUntil: 0 };
  next.count += 1;
  if (next.count >= 5) next.lockedUntil = now + 15 * 60 * 1000;
  accountFailures.set(emailAddress, next);
  return next;
}
function text(value, field, { min = 1, max = 200, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return null;
    throw new Error(`${field} is required.`);
  }
  if (typeof value !== 'string') throw new Error(`${field} must be text.`);
  const result = value.trim();
  if (result.length < min || result.length > max) throw new Error(`${field} must be between ${min} and ${max} characters.`);
  return result;
}
function email(value, required = true) {
  const result = text(value, 'Email', { max: 254, required });
  if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new Error('Email must be valid.');
  return result?.toLowerCase() || null;
}
function positiveInteger(value, field, max = 1000000000) {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${field} must be a whole number.`);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) throw new Error(`${field} must be a positive whole number.`);
  return Number(value);
}
function memberId(value) { return positiveInteger(value, 'Member id', Number.MAX_SAFE_INTEGER); }
function validationError(res, error) { return res.status(400).json({ error: error.message }); }

app.get('/api/auth/csrf', (req, res) => res.json({ csrfToken: issueCsrfCookie(res, parseCookies(req.headers.cookie)[csrfCookieName]) }));

app.post('/api/auth/register', csrfProtection, async (req, res) => {
  try {
    const name = text(req.body?.name, 'Name', { max: 100 });
    const staffEmail = email(req.body?.email);
    const password = text(req.body?.password, 'Password', { min: 8, max: 128 });
  try {
    const result = db.prepare('INSERT INTO staff (name, email, password_hash) VALUES (?, ?, ?)').run(name, staffEmail, await bcrypt.hash(password, passwordCost));
    const staff = db.prepare('SELECT id, name, email FROM staff WHERE id = ?').get(result.lastInsertRowid);
    setSessionCookie(res, staff);
    res.status(201).json({ staff: publicStaff(staff) });
  } catch (error) { res.status(error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 500).json({ error: error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'An account with that email already exists.' : 'Could not create the account.' }); }
  } catch (error) { return validationError(res, error); }
});

app.post('/api/auth/login', csrfProtection, rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: 'login', auditAction: 'failed_login' }), async (req, res) => {
  let staffEmail;
  let password;
  try { staffEmail = email(req.body?.email); password = text(req.body?.password, 'Password', { min: 8, max: 128 }); } catch (error) {
    writeAudit({ action: 'failed_login', details: { reason: 'validation', message: error.message, ip: req.ip } });
    return validationError(res, error);
  }
  const lock = accountLock(staffEmail);
  if (lock?.lockedUntil > Date.now()) {
    writeAudit({ action: 'failed_login', details: { reason: 'account_locked', email: staffEmail, ip: req.ip } });
    return res.status(423).json({ error: 'This account is temporarily locked. Try again later.' });
  }
  const staff = db.prepare('SELECT * FROM staff WHERE email = ? COLLATE NOCASE').get(staffEmail);
  const passwordMatches = await bcrypt.compare(password || '', staff?.password_hash || dummyPasswordHash);
  if (!staff || !passwordMatches) {
    const failure = recordLoginFailure(staffEmail);
    writeAudit({ staffId: staff?.id || null, action: 'failed_login', details: { reason: failure.lockedUntil > Date.now() ? 'account_locked' : 'invalid_credentials', email: staffEmail, ip: req.ip } });
    return res.status(failure.lockedUntil > Date.now() ? 423 : 401).json({ error: failure.lockedUntil > Date.now() ? 'This account is temporarily locked. Try again later.' : 'Email or password is incorrect.' });
  }
  if (bcrypt.getRounds(staff.password_hash) < passwordCost) db.prepare('UPDATE staff SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, passwordCost), staff.id);
  accountFailures.delete(staffEmail);
  writeAudit({ staffId: staff.id, action: 'login_success', details: { ip: req.ip } });
  setSessionCookie(res, staff);
  res.json({ staff: publicStaff(staff) });
});
app.get('/api/auth/me', auth, (req, res) => res.json({ staff: req.staff }));
app.post('/api/auth/logout', csrfProtection, auth, (req, res) => {
  res.clearCookie(sessionCookieName, { httpOnly: true, secure: cookieSecure, sameSite: 'strict', path: '/' });
  res.status(204).end();
});

function setClock(req, res) {
  const value = req.body?.now;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return res.status(400).json({ error: 'now must be a valid ISO timestamp.' });
  simulatedNow = new Date(value);
  res.json({ now: currentTimeIso() });
}
app.post(['/clock', '/api/clock'], csrfProtection, auth, setClock);
app.post('/api/jobs/expire-points', csrfProtection, auth, (req, res) => res.json(expirePoints()));
app.post('/api/jobs/dispatch-outbox', csrfProtection, auth, async (req, res) => res.json(await dispatchOutbox()));

app.get('/api/dashboard', auth, (req, res) => {
  const stats = db.prepare(`SELECT COUNT(*) AS members, COALESCE(SUM(CASE WHEN t.type = 'purchase' THEN t.points_delta ELSE 0 END), 0) AS points_issued, COALESCE(SUM(CASE WHEN t.type = 'redemption' THEN -t.points_delta ELSE 0 END), 0) AS points_redeemed FROM members m LEFT JOIN point_transactions t ON t.member_id = m.id`).get();
  const recent = db.prepare(`SELECT t.id, t.type, t.points_delta, t.amount_cents, t.note, t.created_at, m.name, m.phone FROM point_transactions t JOIN members m ON m.id = t.member_id ORDER BY t.created_at DESC, t.id DESC LIMIT 6`).all();
  res.json({ stats: { members: Number(stats.members), points_issued: Number(stats.points_issued), points_redeemed: Number(stats.points_redeemed) }, recent });
});

app.get('/api/members', auth, (req, res) => {
  let search;
  let page;
  let pageSize;
  try {
    search = text(req.query.search || '', 'Search', { max: 100, required: false }) || '';
    page = req.query.page === undefined ? 1 : positiveInteger(req.query.page, 'Page', 1000000);
    pageSize = req.query.pageSize === undefined ? 8 : positiveInteger(req.query.pageSize, 'Page size', 50);
    if (req.query.direction !== undefined && !['asc', 'desc'].includes(String(req.query.direction).toLowerCase())) throw new Error('Direction must be asc or desc.');
  } catch (error) { return validationError(res, error); }
  const allowedSorts = { name: 'm.name COLLATE NOCASE', balance: 'balance', lifetime: 'lifetime_points', newest: 'm.created_at' };
  if (req.query.sort !== undefined && !Object.hasOwn(allowedSorts, req.query.sort)) return res.status(400).json({ error: 'Sort must be name, balance, lifetime, or newest.' });
  const sort = allowedSorts[req.query.sort || 'newest'];
  const direction = String(req.query.direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const where = search ? "WHERE m.name LIKE @search OR m.phone LIKE @search OR COALESCE(m.email, '') LIKE @search" : '';
  const params = search ? { search: `%${search}%` } : {};
  const count = db.prepare(`SELECT COUNT(*) AS total FROM members m ${where}`).get(params).total;
  const rows = db.prepare(`SELECT m.id, m.name, m.phone, m.email, m.created_at, COALESCE(SUM(t.points_delta), 0) AS balance, COALESCE(SUM(CASE WHEN t.type = 'purchase' THEN t.points_delta ELSE 0 END), 0) AS lifetime_points, COUNT(t.id) AS transaction_count FROM members m LEFT JOIN point_transactions t ON t.member_id = m.id ${where} GROUP BY m.id ORDER BY ${sort} ${direction}, m.id DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });
  res.json({ members: rows.map(serializeMember), pagination: { page, pageSize, total: Number(count), pages: Math.max(1, Math.ceil(count / pageSize)) }, sort: { field: req.query.sort || 'newest', direction } });
});

app.post('/api/members', csrfProtection, auth, (req, res) => {
  let name;
  let memberEmail;
  let phone;
  try {
    name = text(req.body?.name, 'Name', { max: 100 });
    memberEmail = email(req.body?.email, false);
    phone = normalizePhone(text(req.body?.phone, 'Phone number', { max: 30 }));
    if (!/^\+?\d{7,15}$/.test(phone)) throw new Error('Phone number must contain 7 to 15 digits.');
  } catch (error) { return validationError(res, error); }
  try {
    const result = db.prepare('INSERT INTO members (name, phone, email) VALUES (?, ?, ?)').run(name, phone, memberEmail);
    res.status(201).json({ member: serializeMember(memberSummary(result.lastInsertRowid)) });
  } catch (error) { res.status(error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 500).json({ error: error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'That phone number is already registered.' : 'Could not create the member.' }); }
});

app.get('/api/members/:id', auth, (req, res) => {
  let id;
  try { id = memberId(req.params.id); } catch (error) { return validationError(res, error); }
  const member = memberSummary(id);
  if (!member) return res.status(404).json({ error: 'Member not found.' });
  res.json({ member: serializeMember(member) });
});
app.get('/api/members/:id/transactions', auth, (req, res) => {
  let id;
  try { id = memberId(req.params.id); } catch (error) { return validationError(res, error); }
  const member = memberSummary(id);
  if (!member) return res.status(404).json({ error: 'Member not found.' });
  const transactions = db.prepare('SELECT id, type, points_delta, amount_cents, note, created_at FROM point_transactions WHERE member_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(member.id);
  res.json({ transactions });
});

function applyTransaction(req, res, type) {
  let id;
  let input;
  try {
    id = memberId(req.params.id);
    input = req.body || {};
    if (type === 'purchase') positiveInteger(input.amountCents, 'Purchase amount in cents', 100000000);
    else positiveInteger(input.points, 'Redemption points', 1000000000);
    if (input.note !== undefined) text(input.note, 'Note', { max: 500, required: false });
  } catch (error) {
    if (type === 'redemption' && Number.isSafeInteger(Number(req.params.id))) writeAudit({ staffId: req.staff.id, memberId: memberSummary(Number(req.params.id))?.id || null, action: 'failed_redemption', details: { reason: 'validation', message: error.message, ip: req.ip } });
    return validationError(res, error);
  }

  let result;
  try {
    const save = db.transaction(() => {
      ensureLotsForPurchases();
      const member = memberSummary(id);
      if (!member) return null;
      let pointsDelta;
      let amountCents = null;
      if (type === 'purchase') {
        amountCents = positiveInteger(input.amountCents, 'Purchase amount in cents', 100000000);
        const latestTransactionTime = member.latest_transaction_at ? parseStoredTime(member.latest_transaction_at) : 0;
        const platinumEligible = latestTransactionTime >= Date.parse(platinumActivatedAt);
        pointsDelta = calculatePurchasePoints(amountCents, Number(member.lifetime_points), platinumEligible);
      } else {
        pointsDelta = -positiveInteger(input.points, 'Redemption points', 1000000000);
        if (Number(member.balance) + pointsDelta < 0) {
          const error = new Error(`Insufficient points. This member has ${member.balance} points available.`);
          error.statusCode = 400;
          error.auditDetails = { reason: 'insufficient_balance', requested_points: -pointsDelta, available_points: Number(member.balance), ip: req.ip };
          throw error;
        }
      }
      const transaction = db.prepare('INSERT INTO point_transactions (member_id, staff_id, type, points_delta, amount_cents, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, req.staff.id, type, pointsDelta, amountCents, input.note?.trim() || null, currentTimeIso());
      if (type === 'purchase') db.prepare('INSERT INTO point_lots (earn_transaction_id, member_id, original_points, earned_at) VALUES (?, ?, ?, ?)').run(transaction.lastInsertRowid, id, pointsDelta, currentTimeIso());
      if (type === 'redemption') allocateLots(transaction.lastInsertRowid, id, -pointsDelta, 'redemption');
      db.prepare('INSERT INTO audit_logs (transaction_id, staff_id, member_id, action, details) VALUES (?, ?, ?, ?, ?)').run(transaction.lastInsertRowid, req.staff.id, id, type, JSON.stringify({ points_delta: pointsDelta, amount_cents: amountCents, note: input.note?.trim() || null }));
      if (type === 'purchase') {
        const updatedMember = memberSummary(id);
        const fromTier = memberTier(member).name;
        const toTier = memberTier(updatedMember).name;
        if (fromTier !== toTier) enqueueTierEvent(updatedMember, transaction.lastInsertRowid, fromTier, toTier);
      }
      return { pointsDelta, amountCents };
    });
    result = save();
    if (!result) {
      if (type === 'redemption') writeAudit({ staffId: req.staff.id, action: 'failed_redemption', details: { reason: 'member_not_found', member_id: id, ip: req.ip } });
      return res.status(404).json({ error: 'Member not found.' });
    }
  } catch (error) {
    if (type === 'redemption') writeAudit({ staffId: req.staff.id, memberId: memberSummary(id)?.id || null, action: 'failed_redemption', details: error.auditDetails || { reason: 'database_error', ip: req.ip } });
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return res.status(500).json({ error: 'Could not record the transaction.' });
  }
  res.status(201).json({ member: serializeMember(memberSummary(id)), transaction: { type, points_delta: result.pointsDelta, amount_cents: result.amountCents } });
}
app.post('/api/members/:id/purchases', csrfProtection, auth, (req, res) => applyTransaction(req, res, 'purchase'));
app.post('/api/members/:id/redemptions', csrfProtection, auth, rateLimit({ windowMs: 60 * 1000, max: 30, key: 'redemption', auditAction: 'failed_redemption' }), (req, res) => applyTransaction(req, res, 'redemption'));
app.get(['/outbox', '/api/outbox'], auth, (req, res) => {
  const counts = db.prepare('SELECT status, COUNT(*) AS count FROM outbox GROUP BY status').all();
  const rows = db.prepare('SELECT id, event_key, event_type, member_id, transaction_id, status, attempts, next_attempt_at, last_error, sent_at, created_at FROM outbox ORDER BY id DESC LIMIT 100').all();
  res.json({ counts: Object.fromEntries(counts.map((row) => [row.status, Number(row.count)])), events: rows.map((row) => ({ ...row, attempts: Number(row.attempts) })) });
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  next(error);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
if (require.main === module) {
  app.listen(port, () => console.log(`Rewards Counter running at http://localhost:${port}`));
  setInterval(expirePoints, 60 * 60 * 1000).unref();
  setInterval(() => dispatchOutbox().catch((error) => console.error('Outbox dispatch failed:', error.message)), 5000).unref();
}

module.exports = { app, db, tierFor, calculatePurchasePoints, expirePoints, dispatchOutbox };
