FROM node:24.22.0-bookworm-slim AS base
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_OPTIONS=--use-openssl-ca SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM base
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=30s CMD node -e "fetch('http://127.0.0.1:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
