# Changelog

All notable changes to the Horizon Trade strategy and platform are documented
here. The strategy version is tracked in `packages/shared/src/constants.ts`
(`STRATEGY_VERSION`) and surfaced in the mobile Settings screen.

## [2.0.0] — 2026-06-19

### Platform
- Standalone, vendor-neutral architecture. No Manus dependency.
- Turborepo monorepo: `apps/mobile`, `apps/server`, `packages/shared`.
- Express + tRPC type-safe backend with JWT (single-user bcrypt) auth.
- Drizzle ORM + MySQL persistence; BullMQ + Redis durable scan queue.
- React Native + Expo Router mobile app (Dashboard, Tokens, History, Settings).
- Docker + docker-compose for local dev and production; GitHub Actions CI/CD.

### Strategy (v2.0.0)
- 32-token universe across DeFi, AI, L2/ecosystem, and micro-cap baskets.
- Three trading modes with distinct risk profiles:
  - **Reversion** — 5% alloc, 3% TP / 2% SL, 1.5% early exit, 4/5 signals, Claude ≥ 0.72.
  - **Breakout** — 8% alloc, 15% TP / 6% SL, 4/4 signals, Claude ≥ 0.65.
  - **Macro** — 10% alloc, 8% TP / 3% SL, 3/4 signals, Claude ≥ 0.72.
- Claude (claude-sonnet-4-6) confirmation layer on every candidate trade.
- Per-token win-rate tracking; allocation cut to 2.5% below 40% win rate.
- Circuit breaker: pauses 2 hours after 3 consecutive losses.
- Market windows (EST): PRIME 08:00–12:00 & 14:00–17:00, ACTIVE 20:00–23:00.
- 30-minute session-open exclusion after 08:00 and 20:00 EST.
- 5-minute scan cadence; max 3 concurrent positions; $500k min 24h volume.

### Safety
- `DRY_RUN` mode (default on) records the full pipeline without sending live
  Coinbase orders — safe for investor demos.
- All high/critical npm vulnerabilities in the server runtime resolved.
