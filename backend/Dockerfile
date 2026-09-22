# syntax=docker/dockerfile:1

# Base images are pinned to the multi-arch manifest digest (tag + @sha256) so the same
# commit always rebuilds byte-identical layers. The tag is kept for readability only;
# the digest wins. Refresh procedure (security patches): docs/DEPLOY.md,
# section 9.1 "Reimprospatarea imaginilor de baza fixate pe digest".

# ---- Build stage: compile TypeScript and native modules --------------------
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS build
WORKDIR /app

# Toolchain for better-sqlite3 in case no prebuilt musl binary matches.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ---- Runtime stage ----------------------------------------------------------
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS runtime

# tini reaps zombies and forwards SIGTERM so `docker stop` shuts down cleanly.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3001 \
    DATABASE_PATH=/data/orar.sqlite

WORKDIR /app

# Same base image as the build stage (musl, Node ABI) -> native addon is compatible.
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# The SQLite volume must be writable by the unprivileged user. A fresh named
# volume inherits this ownership from the image.
# No `VOLUME ["/data"]`: it would create an anonymous volume on any `docker run` without
# `-v`, and the SQLite database would vanish on `docker rm`. Compose does the mounting
# (named volume or bind mount).
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
