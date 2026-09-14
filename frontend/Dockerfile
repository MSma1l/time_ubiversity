# syntax=docker/dockerfile:1

# ---- Build stage -------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
# Leave empty so the Mini App calls the API on the same origin (/api via nginx).
ARG VITE_API_URL=
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

# ---- Runtime stage: static files + reverse proxy to the API -----------------
FROM nginx:1.27-alpine AS runtime

RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/orar.conf
COPY --from=build /app/dist /usr/share/nginx/html

# Fail the image build on a broken config (upstream is resolved at runtime).
RUN nginx -t

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/nginx-health || exit 1
