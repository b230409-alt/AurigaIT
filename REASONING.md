# Reasoning

## Product direction

Perkline is a counter-first rewards tool for café staff. The primary workflow is: find a member by phone or name, inspect the live balance, record a purchase, or redeem points. The UI keeps that path short and makes the resulting balance prominent.

## Correctness model

The important invariant is that a balance must never be manually edited. Every earn and redemption is an immutable row in `point_transactions`. There is no mutable lifetime-points increment: `memberSummary()` computes `lifetime_points_earned` from `SUM(CASE WHEN t.type = 'purchase' THEN t.points_delta ELSE 0 END)`. `applyTransaction()` calls that summary for both routes, but only its purchase branch inserts a positive `points_delta`; the redemption branch inserts a negative delta and therefore never increases lifetime points. Tier is derived from that aggregate: Member below 500, Silver from 500, Gold from 1,500, and Platinum from 5,000. Platinum earns 0.3 points per rupee. The purchase rate is selected from the tier before that purchase, and fractional results are rounded down with a minimum of one point for a non-zero purchase.

Platinum was added without a tier column or data migration. A persistent activation timestamp distinguishes legacy transactions from transactions after the rollout. A legacy member at exactly 5,000 remains Gold until the next successful purchase or redemption; that transaction re-evaluates the tier. Existing purchase rows and their earned-point amounts are never recalculated.

Redemptions are rejected when the proposed balance would be negative. Inserts are performed inside a SQLite transaction, and the database has foreign keys and useful indexes for member phone lookup and transaction history.

## Testing and fixes

I verified the server starts, the browser assets are served, and the application can be exercised through the REST API. The focused smoke test creates a staff account, creates a member, records purchases, checks the tier transition and derived balance, rejects an over-redemption, then records a valid redemption. The source is also checked with the Node runtime before delivery.

### Correctness edge-case pass

- Redeeming the exact full balance succeeds and leaves `balance: 0`; redeeming one more point returns HTTP 400 with an insufficient-balance message.
- Zero-cent and negative-cent purchases are rejected with HTTP 400 by server-side validation.
- Tier boundaries are forward-looking, not retroactive: the purchase that takes lifetime points from 499 to exactly 500 earns at the old Member rate, and the next purchase uses the Silver 1.25x rate. The test reached 500 with a 1-point purchase, then earned 5 points on the next 400-cent purchase.
- A legacy member seeded at exactly 5,000 points remains Gold before any post-rollout transaction, then becomes Platinum after a successful one-point redemption. The original 5,000-point purchase row remains unchanged.
- Two staff sessions concurrently recorded a purchase and a redemption for the same member. Both returned HTTP 201, SQLite serialized the writes, and the final balance was the exact sum of the committed deltas with no negative balance.
- Phone numbers are canonicalized to digits while preserving leading zeros. Partial search returns matching members, leading-zero numbers remain searchable, and equivalent formats such as `001234569` and `+00 123 4569` now produce HTTP 409 instead of duplicate members.

The edge-case pass also found and fixed two lookup defects: SQLite requires a single-quoted empty string in `COALESCE`, and retaining `+` in phone normalization allowed equivalent formatted numbers to bypass the uniqueness constraint.

### Transactional outbox

Tier-crossing notifications use the transactional outbox pattern. During a purchase transaction, the code compares the member's tier before and after the ledger write; when it changes, it inserts one unique `tier_crossed` outbox row in that same transaction. Redemption never creates a tier notification, and the purchase path never calls the Notification Service inline. The row payload includes an event ID used as the downstream `Idempotency-Key`.

`dispatchOutbox()` atomically claims rows with one `UPDATE ... WHERE id IN (SELECT ... LIMIT ?) RETURNING ...` statement. The automatic poller and manual endpoint therefore cannot both claim the same pending row. A row stuck in `processing` is reclaimed after 60 seconds; rows retry up to 5 attempts, then become terminal `dead` with `last_error` and remain visible through `GET /outbox`. The event's `event_key` is stored in the row and reused as `Idempotency-Key` on every retry, never regenerated. Re-running dispatch ignores `sent` and `dead` rows. Point expiry writes only expiry ledger/allocation rows and does not enqueue tier notifications; the automated expiry test confirms no outbox event is created.

### Automated test suite

Added `test/rewards.test.js` using Node's built-in test runner and an isolated temporary SQLite database. The suite has six passing tests covering tier thresholds and purchase-point math, the purchase-to-redeem flow with validation and phone lookup cases, legacy and single-purchase Platinum crossings, transactional outbox retry/idempotency, point expiry without tier notifications, and concurrent purchase plus redemption from two staff sessions. The repeatable command is `npm test`; the latest run passed all 6 tests with 0 failures.

## Security review fixes

### Parameterized SQL

All user-controlled SQL values use SQLite placeholders (`?` or named parameters). The member list's sort field and direction are selected only from fixed allowlists before being interpolated as SQL identifiers, so user input cannot become SQL syntax.

### Server-side validation

Validation now runs at every JSON input and parameterized query boundary, including registration, login, member creation, member IDs, search, pagination, sorting, purchase amounts, redemption points, and notes. Inputs have type, range, length, email, and phone checks. JSON bodies are limited to 10 KB and malformed JSON receives a controlled 400 response.

### Rate limiting

Login attempts are limited to 10 per 15 minutes per client IP, and redemptions to 30 per minute per client IP. This protects the two most abuse-sensitive operations without adding a dependency; the in-memory limiter is appropriate for this single-process MVP and should move to shared storage for multiple instances.

### Concurrency-safe transactions

Purchase and redemption operations now read the member aggregate, calculate the result, check the redemption balance, and write the point transaction inside one SQLite transaction. SQLite serializes writers, so two concurrent redemptions cannot both pass a stale pre-transaction balance check.

During concurrency testing, the first committed request initially returned a false 404 because the transaction callback result was not assigned to the response path. That was corrected and retested: concurrent requests now return one successful 201 and one insufficient-balance 400, with one redemption recorded.

### Environment-managed secrets

The hardcoded JWT fallback was removed. The server refuses to start unless `JWT_SECRET` is supplied and is at least 32 characters. `.env.example` documents the required configuration without containing a real secret.

### Audit logging

An `audit_logs` table records the staff member, café member, action, point delta, purchase amount, note, transaction ID, and timestamp for every purchase and redemption. The audit row is inserted in the same database transaction as the point transaction, so the records cannot diverge. It also records `login_success`, `failed_login`, and `failed_redemption` actions, including validation failures, invalid credentials, account lockouts, insufficient balances, missing members, and rate-limited attempts. Existing databases are migrated to the nullable foreign keys needed for authentication events.

## Authentication security confirmation

- Staff passwords are hashed with `bcryptjs` using cost factor 12. Existing hashes below cost 12 are upgraded after a successful login.
- JWTs now expire after 12 hours and are stored only in the HttpOnly, Secure-by-default, SameSite=Strict `perkline_session` cookie. The browser cannot read or attach this token manually. Local development derives the Secure flag from `NODE_ENV` so the HTTP Codespace workflow remains usable; production always uses Secure cookies.
- State-changing routes use a double-submit CSRF defense: `GET /api/auth/csrf` sets the readable `perkline_csrf` cookie, and the frontend mirrors it in `X-CSRF-Token`. Registration, login, logout, member creation, purchases, and redemptions are protected.
- The frontend no longer sends an `Authorization` header and removes any legacy `perkline_token` from `localStorage` during startup. The server no longer reads bearer headers, so all pre-migration localStorage JWT sessions are invalid immediately and require a fresh login.
- Migration verification passed: a cookie-authenticated `/api/auth/me` request succeeded, a purchase without the CSRF header returned 403, the same authenticated request with the matching CSRF cookie/header succeeded, and a legacy bearer token returned 401. In production mode, the session/CSRF cookies include `Secure`, and plain HTTP returns a 308 redirect.
- In addition to the 10-attempt per-IP login limiter, each account locks for 15 minutes after 5 failed password attempts. Both controls are currently in-memory and should use shared storage when horizontally scaled.
- Successful and failed login attempts and successful and failed redemption attempts are written to `audit_logs`. Rate-limited attempts are included as failure events.

## Headers, HTTPS, and dependency scan

Helmet is configured with a same-origin Content Security Policy, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and one-year HSTS with subdomains and preload. In `NODE_ENV=production`, requests without `X-Forwarded-Proto: https` receive a permanent HTTPS redirect; local development stays on HTTP for convenience.

`npm audit --audit-level=high` was run before and after the security changes and reported `found 0 vulnerabilities`. Helmet was added without introducing high or critical findings. The final dependency tree uses `better-sqlite3` 13.0.3 for Node 24 compatibility.

Verification results: Node syntax checks and workspace diagnostics reported no errors; the live response included CSP, HSTS, `X-Frame-Options: DENY`, and `X-Content-Type-Options: nosniff`; failed-attempt queries returned both `failed_login` and `failed_redemption` rows; and production mode returned HTTP 308 for plain HTTP plus HTTP 200 with HSTS when the reverse proxy marked the request as HTTPS.

## Deliberate scope

The app uses a single café schema with staff accounts. A future multi-location version would add cafés and staff membership tables, then scope every member and transaction query by café. Planned product features are SMS receipts, multi-location analytics, and digital member cards.
