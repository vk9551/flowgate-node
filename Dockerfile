# ── Stage 1: build React dashboard ───────────────────────────────────────────
# Alpine: no native deps in the dashboard build, so musl is fine here.
FROM node:20-alpine AS dash-build

WORKDIR /build/dashboard

COPY dashboard/package*.json ./
RUN npm ci

COPY dashboard/ ./
RUN npm run build
# Output lands in /build/dashboard/dist/ per vite.config.ts outDir setting.


# ── Stage 2: compile TypeScript ───────────────────────────────────────────────
# Alpine: only runs tsc. --ignore-scripts skips the better-sqlite3 native
# binary download — we don't need it for compilation, only @types/better-sqlite3.
FROM node:20-alpine AS ts-build

WORKDIR /build

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
COPY --from=dash-build /build/dashboard/dist ./dashboard/dist

RUN npm run build
# Compiled JS lands in /build/dist/


# ── Stage 3: production image ─────────────────────────────────────────────────
# Use node:20-slim (Debian/glibc) so that better-sqlite3 can download its
# prebuilt linux-x64 binary without requiring compilation tools.
# On Alpine (musl) there is no prebuilt binary and apk is needed; Debian avoids that.
FROM node:20-slim

# Create non-root user and data directory.
RUN groupadd -r flowgate \
 && useradd -r -g flowgate flowgate \
 && mkdir -p /data \
 && chown flowgate:flowgate /data

WORKDIR /app

COPY package*.json ./

# Install production deps only. The better-sqlite3 install script downloads
# the prebuilt glibc binary from GitHub — no build tools needed on Debian.
RUN npm ci --omit=dev \
 && rm -rf ~/.npm /tmp/*

COPY --from=ts-build   /build/dist           ./dist
COPY --from=dash-build /build/dashboard/dist ./dashboard/dist

USER flowgate

EXPOSE 7700

ENTRYPOINT ["node", "dist/main.js"]
CMD ["--config", "/etc/flowgate/flowgate.yaml", "--db", "/data/flowgate.db"]
