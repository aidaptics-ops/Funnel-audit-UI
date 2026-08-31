# syntax=docker/dockerfile:1

# Multi-stage so the shipped image carries no toolchain and no dev
# dependencies — only the standalone server Next emits and the files it needs
# at runtime.

# ---------------------------------------------------------------- deps ------
FROM node:22-alpine AS deps
WORKDIR /app

# Copied on their own so this layer is only rebuilt when the manifests change,
# not on every source edit. `npm ci` needs the lockfile to be authoritative.
COPY package.json package-lock.json ./
RUN npm ci

# --------------------------------------------------------------- build ------
FROM node:22-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Telemetry would otherwise phone home from the build host.
ENV NEXT_TELEMETRY_DISABLED=1
# No secret is available or needed here: every value this app reads is server
# side and looked up at request time, so nothing is baked into the bundle.
RUN npm run build

# --------------------------------------------------------------- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# An unprivileged user, and a data directory it owns. The volume mounted at
# /app/.data is what makes this deployment better than serverless: the client
# email library, the derived profile and the paid-lookup cache all survive a
# restart, so credits are never respent on a domain already looked up.
RUN addgroup -g 1001 -S nodejs \
 && adduser -S -u 1001 -G nodejs nextjs \
 && mkdir -p /app/.data \
 && chown -R nextjs:nodejs /app

# The standalone bundle plus the two directories its server does not copy.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
# Read at runtime rather than imported, so tracing does not pull them in.
COPY --from=build --chown=nextjs:nodejs /app/seed ./seed

USER nextjs
EXPOSE 3000

# Hits the app's own status route, so an unhealthy dependency shows up as an
# unhealthy container rather than a page that loads and then fails.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
