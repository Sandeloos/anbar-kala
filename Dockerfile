# Anbar: one Node server (API + app + background sync). The SQLite database lives in /data.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    TZ=Asia/Tehran \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY wordpress-plugin ./wordpress-plugin

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# The seed only creates the first manager (from MANAGER_* variables) when there is none
CMD ["sh", "-c", "node server/seed.js && exec node server/index.js"]
