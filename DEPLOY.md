# Deploy to Railway

This is a persistent Node/Express server with a SQLite file and uploaded PDFs, so
it needs an always-on container **with a persistent volume** (not serverless).

## 1. Create the service
- Railway → **New Project → Deploy from GitHub repo** → `ramshetty01/WHATSHIRED`.
- Railway auto-detects Node (Nixpacks), runs `npm install` then `npm start` (`node index.js`).

## 2. Add a persistent volume (critical)
- Service → **Variables/Settings → Volumes → New Volume**, mount path: `/data`.
- Without this, `bot.db` (user state) and `resumes/` are wiped on every redeploy.

## 3. Set environment variables
Copy every key from `.env.example` and fill real values, **plus** point storage at the volume:

```
MESSAGING_PROVIDER=kapso
KAPSO_API_KEY=...
KAPSO_PHONE_NUMBER_ID=597907523413541
KAPSO_API_URL=https://api.kapso.ai
NVIDIA_API_KEY=...
ADZUNA_APP_ID=...
ADZUNA_APP_KEY=...
JOBS_COUNTRY=in
GREENHOUSE_BOARDS=postman,groww,coinbase,gitlab
RAZORPAY_KEY_ID=...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
# storage on the mounted volume so data survives redeploys:
BOT_DB_PATH=/data/bot.db
UPLOAD_DIR=/data/resumes
# SMTP_* if you want Tier-1 email auto-apply to actually send
```
Do NOT set `PORT` — Railway injects it; the app reads `process.env.PORT`.

## 4. Get the public URL
- Service → **Settings → Networking → Generate Domain** → `https://<app>.up.railway.app`.

## 5. Repoint webhooks to the deployed URL
- Kapso: `kapso whatsapp webhooks new --phone-number-id 597907523413541 --url "https://<app>.up.railway.app/webhook" --event whatsapp.message.received --active`
- Razorpay dashboard → Webhooks → `https://<app>.up.railway.app/razorpay-webhook` (set the same secret as `RAZORPAY_WEBHOOK_SECRET`).

## Notes
- Keep `MESSAGING_PROVIDER=kapso`. `wwebjs` needs Chromium (heavy, stateful) — not for prod.
- Optional build speed-up: set `PUPPETEER_SKIP_DOWNLOAD=true` (whatsapp-web.js pulls Chromium at install but kapso never uses it).
- `better-sqlite3` is a native module; Nixpacks builds it automatically.
- Health check path: `/` returns 200. Point Railway's healthcheck there if desired.
- Scale: SQLite is fine on a single instance for the pilot. For multi-instance, swap `lib/store.js` to Postgres (only that file changes).
