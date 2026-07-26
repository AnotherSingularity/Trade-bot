# Phase 3B §I — Dependency + supply-chain report

## Inventory

- Lockfile: `package-lock.json` (committed, SHA-256 in code-freeze manifest)
- Root dependencies: workspace-managed monorepo (`turbo`, `npm workspaces`)
- Active workspaces: `apps/server`, `apps/desktop`, `packages/shared`
- Deferred workspace: `apps/mobile` (excluded from freeze)

## Production dependencies (headline)

- **apps/server**: express, drizzle-orm, mysql2, ioredis, zod, decimal.js,
  axios (fetch-barrier-guarded), ws, prom-client, node-jose
- **apps/desktop**: electron 33, react 19, react-dom 19, react-router-dom 6,
  keytar 7 (main-process only), zod
- **packages/shared**: zod, decimal.js

## Native modules (audit target)

- `keytar` — Windows: Credential Vault; macOS: Keychain; Linux: libsecret.
  Only loaded in main process (renderer static-source guardrail enforced).

## Versions (locked)

- Node: 20.x (CI + runtime)
- Electron: 33.x
- MariaDB: 10.11 (docker image tag pinned)
- Redis: 7-alpine (docker image tag pinned)

## Docker image digests

Recorded in `phase3b_audit/reports/code_freeze_manifest.json`.

## License inventory

All direct dependencies are MIT / Apache-2.0 / ISC / BSD-3-Clause.
No GPL or SSPL dependencies in the production surface.

## Known vulnerability report (informational)

`npm audit` on the current lockfile reports:

- 35 vulnerabilities (1 low, 2 moderate, 31 high, 1 critical)

Every high-severity item is deep in the dev-dependency tree
(build-time only; not shipped in the installer bundle). No critical or
high-severity vulnerability affects the production runtime path.

- Distribution decision: dev-only vulnerabilities are tracked and
  scheduled for the next dependency-upgrade window. They do NOT block
  the freeze because the installer bundles only production
  dependencies (see `apps/desktop/build/generate-build-manifest.ts`).

## Installer bundling policy

- No test fixtures containing credentials are bundled.
- No development secrets are bundled.
- No `.env` file is bundled.
- The installer includes `build-manifest.json` recording the exact
  file list + checksum.

## Artifact provenance

Recorded via `.github/workflows/desktop-windows.yml`:

- CI run URL
- Commit SHA
- Runner OS
- Node + npm versions
- Electron version
- Installer file list
- Installer SHA-256

## Result

Pass with dev-dependency vulnerability caveats documented.
