# Horizon Trade

**Autonomous crypto trading bot — mobile app + standalone backend.**
Built for Horizon Holdings. Fully self-hosted, no vendor lock-in.

Horizon Trade scans a curated 32-token universe every 5 minutes, evaluates each
candidate against three quantitative strategy modes, confirms high-quality
setups with an LLM risk layer (Claude), and manages positions end-to-end with
take-profit / stop-loss / circuit-breaker risk controls. The React Native app is
a real-time cockpit for the running bot.

---

## Architecture

```
horizon-trade/  (Turborepo)
├── apps/
│   ├── mobile/    React Native + Expo Router app (iOS + Android)
│   └── server/    Express + tRPC backend, trading engine, BullMQ worker
└── packages/
    └── shared/    Types + strategy constants shared by both apps
```

| Layer        | Technology                                                        |
| ------------ | ----------------------------------------------------------------- |
| Mobile       | React Native, Expo Router, TanStack Query, Zustand, SecureStore   |
| API          | Express, **tRPC** (end-to-end type safety), JWT auth              |
| Persistence  | Drizzle ORM + MySQL                                                |
| Job queue    | BullMQ + Redis (durable 5-minute scan loop, survives restarts)    |
| Market data  | Coinbase Advanced Trade API (CDP ES256 JWT auth)                  |
| Signal layer | Anthropic Claude (`claude-sonnet-4-6`)                            |
| Infra        | Docker, docker-compose, GitHub Actions                            |

### How the type safety works
The server's root router exports an `AppRouter` type. The mobile app imports that
type directly into its tRPC client (`apps/mobile/lib/trpc.ts`), so every API call
from the app is checked against the backend at compile time. The `packages/shared`
package holds the domain types and the hardcoded strategy constants that both
sides agree on.

---

## The strategy

The full strategy is **fixed and versioned** in
`packages/shared/src/constants.ts` (current: `STRATEGY_VERSION = 2.0.0`). It is
intentionally **not** editable from the app. See `CHANGELOG.md` for the version
history.

### Scan cycle (`apps/server/src/trading/scanner.ts`)
1. **Gatekeeping** — bot running? not paused? circuit breaker clear? inside a
   trading window and outside the session-open exclusion?
2. **Manage open positions** — re-price each holding and exit on take-profit,
   stop-loss, or (reversion only) early-exit.
3. **Scan for entries** — for each active token: volume filter → indicator set →
   best-qualifying mode → Claude confirmation → position open (respecting the
   3-position cap and win-rate based allocation).

### Three modes
| Mode      | Alloc | TP   | SL  | Signals | Claude ≥ | Idea                          |
| --------- | ----- | ---- | --- | ------- | -------- | ----------------------------- |
| Reversion | 5%    | 3%   | 2%  | 4 / 5   | 0.72     | Oversold bounce               |
| Breakout  | 8%    | 15%  | 6%  | 4 / 4   | 0.65     | Momentum + volume expansion   |
| Macro     | 10%   | 8%   | 3%  | 3 / 4   | 0.72     | Established trend continuation |

### Risk controls
- **Win-rate tracking** per token; allocation cut to 2.5% below a 40% win rate.
- **Circuit breaker** — 3 consecutive losses → 2-hour cooldown.
- **Market windows (EST)** — PRIME 08:00–12:00 / 14:00–17:00, ACTIVE 20:00–23:00.
- **Session exclusion** — sits out the first 30 minutes after the 08:00 / 20:00 opens.
- **Volume filter** — ignores anything under $500k 24h volume.

Indicator math (RSI/Wilder, EMA, MACD, Bollinger) is dependency-free and unit
tested in `apps/server/tests`.

---

## Local development

### Prerequisites
- Node 20+, npm 10+
- Docker (for MySQL + Redis)

### 1. Install
```bash
npm install
```

### 2. Configure the server
```bash
cp apps/server/.env.example apps/server/.env
# Fill in JWT_SECRET and (optionally) Coinbase + Anthropic keys.
```

Generate the admin password hash:
```bash
node -e "import('bcryptjs').then(b => b.hash('your-password', 12).then(console.log))"
# paste the result into ADMIN_PASSWORD_HASH
```

### 3. Start infrastructure
```bash
docker-compose up -d        # MySQL + Redis
```

### 4. Apply the schema
```bash
npm run db:push             # pushes Drizzle schema to MySQL
```

### 5. Run
```bash
npm run dev --workspace=server   # backend on http://localhost:3000
npm run dev --workspace=mobile   # Expo dev server (scan QR with Expo Go)
```

Set `EXPO_PUBLIC_API_URL` for the mobile app to point at your backend (defaults
to `http://localhost:3000`).

### Tests & checks
```bash
npm run test        # Vitest (server) + typecheck (mobile)
npm run typecheck   # full monorepo type check
```

---

## Dry-run / demo mode

`DRY_RUN=true` (the default) runs the **entire** pipeline — signals, Claude
confirmation, position tracking, P&L, win-rate stats, circuit breaker — but logs
orders instead of sending them to Coinbase, and assumes a nominal $10k bankroll
for sizing. This makes the three-mode strategy, win-rate tracking, and circuit
breaker demonstrably observable for investor demos without risking capital. Set
`DRY_RUN=false` with live Coinbase credentials to trade for real.

---

## Deployment

The deployable artifact is the server Docker image (`apps/server/Dockerfile`,
built from the repo root). Pick one:

**Railway** — provision MySQL + Redis services, set env vars, `railway up`.
**Fly.io** — `fly launch`, `fly secrets set …`, `fly deploy`.
**Any VPS** — `docker-compose -f docker-compose.prod.yml up -d`.

Mobile builds use EAS (profiles defined in `apps/mobile/eas.json`):
- `eas build --profile development --platform ios` — dev client / simulator
- `eas build --profile preview --platform android` — internal-distribution APK (direct install)
- `eas build --profile production --platform android|ios` — store builds

CI (`.github/workflows/test.yml`) runs typecheck + tests on every PR;
`deploy.yml` builds the image and deploys on merge to `main`.

---

## API surface (tRPC routers)

| Router     | Key procedures                                                    |
| ---------- | ----------------------------------------------------------------- |
| `auth`     | `login`, `me`                                                     |
| `trading`  | `status`, `start`, `stop`, `pause`, `scanNow`, `portfolio`, `positions`, `activity`, `closePosition` |
| `tokens`   | `list`, `setActive`, `volumeFilter`                               |
| `history`  | `list` (infinite scroll + filters), `summary`                    |
| `settings` | `info`, `testConnection`                                          |

---

## Security notes
- All **high/critical** vulnerabilities in the **server runtime** are resolved
  (`npm audit` on the server workspace is clean of high/critical).
- Remaining advisories are confined to dev-only tooling in the Expo/React Native
  build chain and Drizzle Kit's CLI — none ship in the deployed server image.
- Secrets live only in env vars; the mobile app stores its JWT in Expo
  SecureStore and never embeds API keys.

---

*Horizon Holdings · Dylan Scott · 2026*
