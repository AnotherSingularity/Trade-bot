# ---------------------------------------------------------------------------
# Horizon Trade server — multi-stage build for the Turborepo workspace.
# Build context is the repo root: docker build -f apps/server/Dockerfile .
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /repo

# Install workspace deps (root + server + shared) using the lockfile.
COPY package.json package-lock.json* turbo.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
RUN npm install

# Copy sources and build the server (shared is consumed as TS source).
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN npm run build --workspace=server

# ---------------------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/server/dist ./dist
COPY --from=builder /repo/apps/server/package.json ./package.json
COPY --from=builder /repo/apps/server/drizzle ./drizzle

EXPOSE 3000
CMD ["node", "dist/index.js"]
