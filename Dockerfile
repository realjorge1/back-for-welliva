# syntax=docker/dockerfile:1
#
# Welliva API container. Two stages: compile TypeScript with the full toolchain,
# then ship a slim runtime image carrying only production deps + the built dist.
# The Anthropic key is NEVER baked in — pass it (and the rest of server/.env.example)
# as host secrets/env at deploy time.

# ── build: TS → dist ────────────────────────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── runtime: prod deps + built output ───────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# The server reads PORT from env (defaults to 8787). Most hosts inject PORT.
EXPOSE 8787
CMD ["node", "dist/index.js"]
