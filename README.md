# Perkline

Perkline is a counter-first café rewards programme. Staff can register, sign in, find members by name or phone, record purchases, redeem points, and see a live balance derived from the complete transaction ledger.

## Run locally

Requirements: Node.js 18+ and npm.

```bash
npm install
export JWT_SECRET="$(openssl rand -base64 32)"
npm start
```

`JWT_SECRET` is required and must be at least 32 characters. Copy `.env.example` as a starting point for local environment configuration. Do not commit real secrets.

Set `NOTIFICATION_SERVICE_URL` to the Notification Service endpoint before enabling delivery. The purchase request never calls that service; it only writes a `tier_crossed` event to the transactional outbox. The dispatcher posts the event later with its stable `Idempotency-Key`, marks successful rows `sent`, and marks failures `failed` with a retry time. It retries up to 5 attempts; an exhausted event becomes `dead` and remains visible through `/outbox`. A dispatcher crash leaves `processing` rows reclaimable after 60 seconds. `OUTBOX_RETRY_DELAY_MS` controls the retry delay.

For production, set `NODE_ENV=production` behind an HTTPS reverse proxy. HTTP requests are redirected to HTTPS, and Helmet sends HSTS for one year with subdomains and preload enabled. Local development intentionally remains on HTTP so `http://localhost:3000` works.

Run the automated correctness suite with:

```bash
npm test
```

The suite uses an isolated temporary SQLite database and covers tier/points unit cases, purchase-to-redeem balance flow, invalid purchases, phone search and duplicate normalization, Platinum crossing, transactional outbox retry/idempotency, point expiry without notifications, plus concurrent purchase and redemption requests from two staff sessions.

Open `http://localhost:3000`. In development, the session cookie is not marked Secure so it can work over local HTTP. Production defaults to Secure cookies; set `COOKIE_SECURE=false` only when using a deliberately HTTPS-terminated development setup. The SQLite database is created at `data/rewards.db` on first start. For development, use `npm run dev`.

The first screen is the product landing page. Use **Staff sign in**, create an account, then add a member. Purchase amounts are entered in dollars, while the API accepts integer cents to avoid floating-point money errors.

## Rules

- Member: 1 point per dollar, below 500 lifetime earned points.
- Silver: 1.25 points per dollar, from 500 lifetime earned points.
- Gold: 1.5 points per dollar, from 1,500 lifetime earned points.
- Platinum: 0.3 points per rupee, from 5,000 lifetime earned points.
- Earned points are rounded down per purchase, with a minimum of 1 point for any non-zero purchase.
- Redemptions cannot make a member's balance negative.
- Balances and `lifetime_points_earned` are calculated from `point_transactions`; tiers are computed from that aggregate and are never stored or bulk-migrated.
- Platinum is a forward-only rollout: a legacy member at exactly 5,000 points keeps the prior tier until their next successful purchase or redemption. That transaction re-evaluates the tier; historical purchase point amounts never change.
- Every purchase and redemption also writes an immutable `audit_logs` row in the same database transaction.
- Login is limited to 10 attempts per 15 minutes per client IP; redemptions are limited to 30 per minute per client IP.
- Staff accounts lock after 5 failed credential attempts for 15 minutes, independently of the per-IP limiter.
- Passwords use bcrypt with cost 12. JWTs expire after 12 hours and are held only in the HttpOnly, Secure-by-default, SameSite=Strict `perkline_session` cookie.
- Helmet supplies a same-origin CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and HSTS in production.

## REST API

Authenticated endpoints use the HttpOnly `perkline_session` cookie. All state-changing endpoints also require the `X-CSRF-Token` header matching the readable `perkline_csrf` cookie; the frontend obtains that token from `GET /api/auth/csrf`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create a staff account. |
| `POST` | `/api/auth/login` | Sign in and receive a JWT. |
| `GET` | `/api/auth/csrf` | Set/return the CSRF double-submit token. |
| `GET` | `/api/auth/me` | Return the signed-in staff member. |
| `POST` | `/api/auth/logout` | Clear the session cookie. |
| `GET` | `/api/dashboard` | Return dashboard totals and recent activity. |
| `GET` | `/api/members?search=&page=&pageSize=&sort=&direction=` | Search, paginate, and sort members. |
| `POST` | `/api/members` | Create a member with `name`, `phone`, and optional `email`. |
| `GET` | `/api/members/:id` | Return a member and calculated live balance. |
| `GET` | `/api/members/:id/transactions` | Return point history. |
| `POST` | `/api/members/:id/purchases` | Record a purchase with integer `amountCents` and optional `note`. |
| `POST` | `/api/members/:id/redemptions` | Redeem positive integer `points` and optional `note`. |
| `GET` | `/outbox` | Inspect outbox counts and the latest event statuses. |
| `POST` | `/api/jobs/dispatch-outbox` | Run one authenticated dispatcher batch. |

## Debugging

Run `JWT_SECRET="$(openssl rand -base64 32)" npm run dev` to restart the server on source changes. The SQLite file is intentionally ignored by git. To reset local data, stop the server and remove `data/rewards.db`; the schema will be recreated on the next start.

See [REASONING.md](REASONING.md) for the product reasoning and verification approach, and [AI_LOGS.md](AI_LOGS.md) for the build log.