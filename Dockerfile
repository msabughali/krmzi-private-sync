FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    WEB_PORT=8787

WORKDIR /app

# Base utilities + wget for the container healthcheck
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

# Install Node deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Install Chromium + its system dependencies for Playwright
RUN npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Copy application source (web UI + backend)
COPY src ./src
COPY web ./web
COPY data ./data-seed
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY .env.example ./.env.example

# Runtime data lives on a mounted volume (episodes.json, state.json)
RUN mkdir -p /app/data
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- "http://localhost:${WEB_PORT}/api/health" || exit 1

# Default: run the web UI. The companion worker service overrides this
# with `node src/index.js --loop` in docker-compose.yml.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/webServer.js"]
