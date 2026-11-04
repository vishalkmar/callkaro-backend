# CallKaro API (server)

Node.js + Express 5 + **PostgreSQL** (Neon in production, `pg` driver), **CommonJS**, plain JavaScript.
The server owns users, credits (wallet + ledger), call authorisation and billing. The app is never trusted with amounts.

## Run locally

```bash
cd server
npm install
cp .env.example .env          # fill in the values (see below)
docker compose up -d          # local PostgreSQL 16 on port 5434 (same major version as Neon)
npm run dev                   # nodemon, http://0.0.0.0:5000
```

`.env` for local dev:

```
DATABASE_URL=postgresql://callkaro:callkaro@localhost:5434/callkaro
PUBLIC_BASE_URL=https://<your-ngrok-id>.ngrok-free.app   # provider webhooks must reach you
JWT_ACCESS_SECRET=<64+ random chars>   # node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_REFRESH_SECRET=<64+ random chars>
BREVO_API_KEY=<from Brevo > SMTP & API > API keys>
BREVO_SENDER_EMAIL=<a sender verified in Brevo>
ADMIN_API_KEY=<long random>
```

Production: create a Neon project, copy the pooled connection string into `DATABASE_URL` (it contains `sslmode=require`; SSL is switched on automatically). Migrations in `migrations/*.sql` run automatically at boot, or by hand with `npm run migrate`.

Test from the phone: open `http://<laptop-LAN-IP>:5000/health` in the phone browser (same Wi-Fi). Allow port 5000 in Windows Firewall if it does not load.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with auto-reload |
| `npm start` | Production start |
| `npm test` | Jest + supertest against a real Postgres (`callkaro_test` DB; override with `TEST_DATABASE_URL`) |
| `npm run migrate` | Apply pending SQL migrations |
| `npm run reconcile` | Checks sum(ledger) == wallet.credits for every user (exit 1 on mismatch) |
| `npm run bill:unbilled` | Bills calls whose billing webhook was missed |
| `npm run cleanup:recordings` | Deletes provider recording copies past retention, anonymises old call metadata |

Background jobs (node-cron, India time) start automatically with the server: unbilled-call retry every 10 min + nightly sweep, recording cleanup 03:00, ledger reconciliation 03:15, telephony spend guard hourly. Set `DISABLE_JOBS=true` to turn them off on extra instances.

## Folder layout

```
src/
  server.js app.js
  config/        env.js (validates env at boot), db.js (pg pool, tx(), migrations, retry), economy.js, disposableDomains.js
  routes/        auth me wallet ads spin orders webhooks voice calls report admin
  controllers/   auth me wallet
  services/      auth brevo token wallet billing voice abuse ssv ads spin payment stats alert
  middlewares/   auth validate rateLimit providerSignature adminAuth deviceIntegrity error
  jobs/          unbilledCalls cleanupRecordings spendGuard index
  utils/         response logger phone serialize time
migrations/      001_init.sql (schema: users, otps, sessions, wallets, ledger_entries, calls, orders, ad_*, spins, caller_numbers, reports, blocked_numbers)
tests/           *.test.js
scripts/         reconcile.js runJob.js
```

## Provider setup (Twilio example)

1. Buy / verify the caller-ID numbers you are allowed to use and put them in `CALLER_ID_POOL`.
2. Create a TwiML App: Voice URL = `POST {PUBLIC_BASE_URL}/voice/outbound`, **Status Callback URL = `POST {PUBLIC_BASE_URL}/voice/status`** (closes calls the user cancels while ringing). Put its SID in `TWILIO_TWIML_APP_SID`.
3. Create an API Key (SID + secret) for access tokens.
4. Set each pool number's "A call comes in" webhook to `POST {PUBLIC_BASE_URL}/voice/inbound`.
5. Every webhook is checked with `X-Twilio-Signature` using `TWILIO_AUTH_TOKEN`.

## Other webhooks

- AdMob SSV callback URL: `GET {PUBLIC_BASE_URL}/ads/ssv`
- Razorpay webhook: `POST {PUBLIC_BASE_URL}/webhooks/payments/razorpay` (secret = `RAZORPAY_WEBHOOK_SECRET`)
- Google Play RTDN (Pub/Sub push): `POST {PUBLIC_BASE_URL}/webhooks/payments/play?token=PLAY_RTDN_TOKEN`

## Deploy on Render

1. Render > **New > Blueprint** > pick this repo (uses `render.yaml`), or **New > Web Service** with
   Build `npm ci --omit=dev`, Start `npm start`, Health check `/health`.
2. Environment variables (dashboard):
   - `DATABASE_URL` - Neon **pooled** connection string (has `sslmode=require`)
   - `PUBLIC_BASE_URL` - `https://<service>.onrender.com`
   - `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ADMIN_API_KEY` - 64+ random chars each
   - `BREVO_API_KEY`, `BREVO_SENDER_EMAIL` (verified sender in Brevo)
   - Twilio keys are optional until you have them: without them calls answer "not configured yet";
     once you add one Twilio key you must add all (`TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`,
     `TWILIO_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN`, `TWILIO_TWIML_APP_SID`, `CALLER_ID_POOL`).
3. Database tables are created automatically on the first start (migrations run at boot).
4. Open `https://<service>.onrender.com/health` -> `{"success":true,"data":{"ok":true,"db":"up"}}`.
5. Put that https URL in the app's `CallKaroApp/.env` as `API_BASE_URL` and build the APK.

Note: the free Render plan sleeps after inactivity; the first request after sleeping takes ~30-60 s.
