# syntax=docker/dockerfile:1

# ---- deps ----
# Separate stage so dependency installation is cached independently of
# source changes; editing routes.js shouldn't re-download node_modules.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# --omit=dev: express/pg/dotenv only. Nothing in the test suite ships.
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

# Run as the unprivileged user that the node image already provides,
# rather than root.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

USER node

EXPOSE 4000

# server.js already handles SIGTERM by draining in-flight requests and
# closing the pg pool, so the platform's normal stop signal results in
# a clean shutdown rather than dropped connections mid-deploy.
CMD ["node", "server.js"]
