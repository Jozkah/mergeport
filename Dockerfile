# syntax=docker/dockerfile:1
# Mergeport: one image, two roles (docs/deploy.md).
#   web     (default)  CMD: apply migrations, then serve on 0.0.0.0:3000
#   worker             override the command:  node --import tsx scripts/worker.ts   (or: npm run worker)  and set MERGEPORT_ROLE=worker
#
# Not `output: standalone`: the worker needs src/, tsx and the generated Prisma client next to the web build, so the image ships
# node_modules (production dependencies only) instead of a traced subset.

FROM node:24-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
# openssl: Prisma's schema engine (prisma migrate deploy) needs it on slim images. ca-certificates: TLS to GitHub, OIDC providers, SMTP.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
# Manifests first so the dependency layer is cached. `postinstall` runs `prisma generate`, which needs the schema and prisma.config.ts.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY . .
# The build never connects to the database; this value only has to be a well-formed URL.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build
# Baked into the build (next.config.ts allows Server Actions from this host): set it to the public address, e.g. https://app.example.com.
# Changing the public URL means rebuilding the image.
ARG MERGEPORT_PUBLIC_URL=
RUN npm run build \
 && npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/package.json /app/tsconfig.json /app/next.config.ts /app/prisma.config.ts ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
# Migrations first (several replicas starting together is safe: Prisma takes a Postgres advisory lock), then exec so SIGTERM reaches Node.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node --import tsx scripts/start.ts"]
