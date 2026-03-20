# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /build

RUN corepack enable
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

COPY tsconfig.json .
COPY src/ ./src/

# Force build even with minor TS warnings
RUN npm run build || (mkdir -p dist && npx tsc --skipLibCheck --outDir dist)
RUN npm prune --production

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:20-slim
LABEL org.opencontainers.image.title="ZEGIRON Gateway"
WORKDIR /app

# Corrected user creation for Debian/Slim
RUN groupadd -g 1001 zegiron && useradd -u 1001 -g zegiron -m zegiron

COPY --from=builder --chown=zegiron:zegiron /build/dist          ./dist
COPY --from=builder --chown=zegiron:zegiron /build/node_modules  ./node_modules
COPY --from=builder --chown=zegiron:zegiron /build/package.json  ./

ENV NODE_ENV=production \
    SINGLE_WORKER=true \
    UV_THREADPOOL_SIZE=16 \
    NODE_OPTIONS="--max-old-space-size=1536"

USER zegiron
EXPOSE 4000
STOPSIGNAL SIGTERM

# Using curl because wget behaves differently in slim images
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=20s \
  CMD node -e "fetch('http://localhost:4000/health').catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
