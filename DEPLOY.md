# Deploying Horizon Trade

The deployable artifact is the **server** (`apps/server`). The mobile app is built
separately via EAS and points at the deployed server URL.

> **Monorepo note:** the server Dockerfile (`apps/server/Dockerfile`) builds from
> the **repo root** so it can bundle `packages/shared`. Railway is configured for
> this by the root `railway.json` (`dockerfilePath: apps/server/Dockerfile`). Run
> `railway up` from the **repo root**, not from `apps/server/`.

---

## Railway (recommended)

### 0. Install + authenticate (on your machine)
```bash
npm i -g @railway/cli
railway login            # opens a browser; or: railway login --browserless
```

### 1. Create the project (from repo root)
```bash
cd horizon-trade         # repo root
railway init             # name it "horizon-trade"
```

### 2. Provision MySQL + Redis
```bash
railway add --database mysql
railway add --database redis
# (or run `railway add` and pick them interactively)
```

### 3. Set environment variables
DATABASE_URL and REDIS_URL should **reference** the provisioned plugins so they
stay correct across restarts. Easiest in the dashboard
(Service → Variables → "Add Reference"), or via CLI:

```bash
railway variables \
  --set "NODE_ENV=production" \
  --set "DRY_RUN=true" \
  --set "JWT_SECRET=<paste a fresh 64-hex secret>" \
  --set "ADMIN_PASSWORD_HASH=<paste the bcrypt hash>" \
  --set "COINBASE_KEY_NAME=placeholder" \
  --set "COINBASE_PRIVATE_KEY=placeholder" \
  --set "ANTHROPIC_API_KEY=placeholder"

# Reference variables (set in the dashboard, names depend on the plugin):
#   DATABASE_URL = ${{ MySQL.MYSQL_URL }}
#   REDIS_URL    = ${{ Redis.REDIS_URL }}
```

Generate a fresh JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Generate the admin password hash (choose your own password):
```bash
node -e "require('bcryptjs').hash('YOUR-PASSWORD', 12).then(console.log)"
```

### 4. Deploy
```bash
railway up               # from repo root
railway domain           # generate/print the public URL
```

The container runs DB migrations automatically before starting
(`node dist/migrate.js && node dist/index.js`), so the schema is created on first
deploy.

### 5. Verify health
```bash
curl https://<your-app>.up.railway.app/api/health
# → {"status":"ok","version":"2.0.0","dryRun":true,...}
```

### 6. Wire the mobile app
Set the printed Railway URL as `EXPO_PUBLIC_API_URL` in `apps/mobile/eas.json`
(the `preview` / `production` profiles) before building.

---

## Alternatives

- **Fly.io** — `fly launch` (uses `apps/server/Dockerfile`), `fly secrets set …`,
  provision MySQL + Upstash Redis, `fly deploy`.
- **Any VPS** — `docker-compose -f docker-compose.prod.yml up -d` (bundles
  server + MySQL + Redis). Supply secrets via a root `.env`.

## Going live (real trading)
Flip `DRY_RUN=false` and replace the Coinbase + Anthropic placeholders with real
credentials, then redeploy. Until then the bot runs the full pipeline without
sending live orders.
