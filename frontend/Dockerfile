# syntax=docker/dockerfile:1

# Base images are pinned to the multi-arch manifest digest (tag + @sha256) so the same
# commit always rebuilds byte-identical layers. The tag is kept for readability only;
# the digest wins. Refresh procedure (security patches): docs/DEPLOY.md,
# section 9.1 "Reimprospatarea imaginilor de baza fixate pe digest".

# ---- Build stage -------------------------------------------------------------
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
# Leave empty so the Mini App calls the API on the same origin (/api via nginx).
ARG VITE_API_URL=
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

# ---- Runtime stage: static files + reverse proxy to the API -----------------
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 AS runtime

RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/orar.conf
COPY --from=build /app/dist /usr/share/nginx/html

# Fail the image build on a broken config (upstream is resolved at runtime).
RUN nginx -t

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/nginx-health || exit 1
