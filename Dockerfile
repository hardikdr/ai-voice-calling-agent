FROM cloudflare/cloudflared:2026.9.1 AS cloudflared

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOME=/tmp

WORKDIR /app

COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY public ./public
COPY src ./src
COPY prompt.md ./prompt.md

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app app \
    && mkdir -p /data/runs \
    && chown -R app:app /data/runs

USER app

EXPOSE 8080 5050

CMD ["node", "src/index.js"]
