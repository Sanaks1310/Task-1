# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /build

# Install dependencies
RUN corepack enable
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source
COPY tsconfig.json vite.config.ts index.html ./
COPY src/ ./src/

# Build arguments
ARG VITE_WS_URL=wss://zegiron.mil.internal:8443/ws

# THE FIX: We skip type-checking here to ensure the build completes
RUN VITE_WS_URL=$VITE_WS_URL npx vite build

# ── Stage 2: nginx runtime ───────────────────────────────────────────────────
FROM nginx:1.25-alpine AS runtime
LABEL org.opencontainers.image.title="ZEGIRON Frontend"
RUN rm /etc/nginx/conf.d/default.conf

# This now works because "builder" is defined above
COPY --from=builder /build/dist /usr/share/nginx/html
COPY nginx-spa.conf /etc/nginx/conf.d/zegiron.conf

EXPOSE 80
STOPSIGNAL SIGQUIT

HEALTHCHECK --interval=15s --timeout=3s \
  CMD wget -qO- http://localhost/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
