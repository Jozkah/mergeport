# Deploying Mergeport

Mergeport runs as two processes from one repository (or one image): a **web** service that serves pages and the API, and a **worker**
that runs background jobs (GitHub sync, webhook upkeep, daily digest). Both need the same PostgreSQL database and the same environment.
This guide is for a self-hosted deployer (a Dockerfile, compose or Nixpacks-style builder) behind a TLS reverse proxy. For the GitHub
App itself see `docs/github-app.md`; for sign-in see `docs/auth.md`.

| Service | Command | Listens | Health check |
| --- | --- | --- | --- |
| web | `npm start` (applies migrations, then serves). In the image: `sh -c "npx prisma migrate deploy && exec node --import tsx scripts/start.ts"` | `HOST:PORT`, default `127.0.0.1:3000`; the image sets `0.0.0.0:3000` | `GET /api/health` |
| worker | `npm run worker` (in the image: `node --import tsx scripts/worker.ts`) | nothing | none (see "Health") |

Files in the repository for this: `Dockerfile`, `docker-compose.yml`, `.env.production.example`, `Procfile`, `nixpacks.toml`, `.nvmrc`.
Node 24 is required (`engines`).

## 1. Create the database

PostgreSQL (the test suite runs against 18; the compose file uses 17). Create an empty database and a user that owns it:

```sql
CREATE USER mergeport WITH PASSWORD '...';
CREATE DATABASE mergeport OWNER mergeport;
```

`DATABASE_URL=postgresql://mergeport:<password>@<host>:5432/mergeport` (percent-encode special characters in the password; add
`?sslmode=require` if the server demands TLS). The schema is created by migrations when the web service starts. The user needs the
right to create tables in the database, not superuser rights.

## 2. Set the environment

Copy `.env.production.example` and fill it in. The file lists every variable with a comment. The minimum for a working hosted server:

| Variable | Why |
| --- | --- |
| `DATABASE_URL` | The database above. |
| `MERGEPORT_PUBLIC_URL` | `https://mergeport.example.com`. Turns hosted mode on. **Also a build argument** (see below). |
| `MERGEPORT_TRUST_PROXY=true` | Required when hosted. The server refuses to start without it. |
| `MERGEPORT_TRUSTED_PROXY_HOPS` | How many proxies you run in front (default 1). |
| `SMTP_URL`, `MAIL_FROM` | Sign-in by email link. (Or an OIDC provider plus `MERGEPORT_AUTH_SECRET`.) |

Then, for the real product: the seven `MERGEPORT_GITHUB_APP_*` values, `MERGEPORT_ENCRYPTION_KEY` (and `MERGEPORT_GITHUB_WRITES=on` if you
want GitHub writes), and `MERGEPORT_FEDERATION*` only if you link instances.

Rules that are easy to miss:

- **`MERGEPORT_PUBLIC_URL` is needed at build time and at run time.** `next.config.ts` reads it to allow Server Actions from the public host.
  In Docker pass it as a build arg (compose does this); on a Nixpacks-style builder make sure it is available to the build step. Change
  the address and you must rebuild.
- **The web and worker services use the same variables.** Give the worker the same `DATABASE_URL`, `MERGEPORT_PUBLIC_URL`,
  `MERGEPORT_ENCRYPTION_KEY` and GitHub App values (it mints installation tokens and decrypts stored tokens).
- **`HOST`.** Default `127.0.0.1` (local behaviour). Inside a container or when the proxy is on another machine set `HOST=0.0.0.0`. The
  server refuses a network-reachable `HOST` unless `MERGEPORT_PUBLIC_URL` is set: without it the app is the local app, which trusts any
  request that claims a loopback `Host`. In hosted mode only the public host is served; loopback names, `/api/local/*` and the demo are refused
  whatever address is bound. `MERGEPORT_PORT` (then `PORT`) sets the port, default 3000.
- Do not set `DEMO_MODE=true`, `MERGEPORT_GITHUB_API_BASE` or `MERGEPORT_FEDERATION_ALLOW_INSECURE` on a deployment.
- Env files read by Docker keep quotes literally. Write `KEY=value` without quotes there. A multi-line PEM goes in
  `MERGEPORT_GITHUB_APP_PRIVATE_KEY` with `\n` for newlines, or better mount a file and set `MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE`.

## 3. Build and run

### Dockerfile or compose

```sh
cp .env.production.example .env.production      # fill it in; set POSTGRES_PASSWORD if you use the bundled Postgres
docker compose --env-file .env.production up -d --build
```

Compose starts `postgres` (named volume, health check), `web` (waits for a healthy database, applies migrations, serves on
`127.0.0.1:3000` of the host) and `worker` (waits for a healthy web service, so migrations are done). Point your reverse proxy at
`127.0.0.1:3000`. Do not publish Postgres.

On a deployer that takes just a Dockerfile: build the image with the build arg `MERGEPORT_PUBLIC_URL`, create **two services from the same image**:

| | web | worker |
| --- | --- | --- |
| Command | image default | `node --import tsx scripts/worker.ts` |
| Port | 3000 | none |
| Extra env | | `MERGEPORT_ROLE=worker` (makes the image health check pass: the worker has no port) |
| Health check | HTTP `GET /api/health` on port 3000, expect 200 | none |

The image does not use `output: standalone`: the worker needs `src/`, `tsx` and the generated Prisma client beside the web build, so it ships
production `node_modules`. It runs as the non-root `node` user and writes only to `.next/cache`.

### Nixpacks or buildpacks

The build runs `npm ci` and `npm run build` (the `build` script generates the Prisma client and builds Next). Create two services from the repository:

- web: start command `npm start`, port 3000, env `HOST=0.0.0.0` (`nixpacks.toml` sets it; the `Procfile` `web` line does too).
- worker: start command `npm run worker` (the `Procfile` `worker` line).

`npm start` runs `prisma migrate deploy` first, so no separate release step is needed (a `release:` phase running `npx prisma migrate deploy` also works).
If your builder prunes dev dependencies before `npm run build`, turn that off: the build needs TypeScript and Tailwind. `tsx` and `dotenv` are
regular dependencies, so `npm ci --omit=dev` is enough to run both services.

## 4. Reverse proxy requirements

Terminate TLS in front of the web service and proxy to it. It must:

- **Use TLS** for the public URL. Session cookies are `Secure` when `MERGEPORT_PUBLIC_URL` is https.
- **Append the client address to `X-Forwarded-For`** (not replace it with a spoofable value). Mergeport takes the client as the Nth entry
  from the **right**, N = `MERGEPORT_TRUSTED_PROXY_HOPS` (the number of proxies you operate: 1 for a single proxy, 2 for a CDN plus a proxy).
  Wrong hops either rate-limits everyone as one address or lets a client choose its own.
- **Preserve `Host` and `Origin`.** The Host the app sees must equal the `MERGEPORT_PUBLIC_URL` host (with port if non-default); anything else
  is answered 403. Do not rewrite Host to the upstream's address. Forms are checked against Origin.
- **Allow request bodies of at least 1 MiB** (GitHub webhook deliveries, MCP calls, backup restore uploads). Many proxies default to 1 MiB or less.
- **Not buffer `/api/mcp` or the page event stream** (`/api/sync/events`, server-sent events with a keep-alive comment every 25 s): disable
  response buffering for them (nginx: `proxy_buffering off`). Long timeouts are not needed; only keep the proxy's read timeout above 30 s so the
  idle event stream is not cut between keep-alives (the page reconnects if it is).
- Pass `/api/github/webhook` through to the app (GitHub posts from the internet, no cookie, signed by HMAC).

Never expose the container port (3000) to the internet directly: the app trusts `X-Forwarded-For` from whoever reaches it, so only your proxy may connect.

An nginx sketch:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 2m;
  proxy_buffering off;
}
```

## 5. Health

`GET /api/health` needs no login and answers for any `Host` (platform probes use the container address). GET and HEAD only.

- `200 {"ok":true,"worker":"fresh"}`: the database answered `SELECT 1`. `worker` is `fresh` (a worker beat within 60 s), `stale` (it did,
  longer ago), or `unknown` (no worker has ever reported, or the heartbeat could not be read). It never changes the status code: a web
  replica is healthy without a worker. Alert on `worker` being `stale` or `unknown` separately.
- `503 {"ok":false}`: the database did not answer within 3 s. Nothing else is in the body.

Results are shared for 2 s, so frequent probes cost the database one query per window. Use it as the web service's health check
(interval 30 s, start period 60 s: the first start applies migrations). The worker has no HTTP port; supervise it by its process and by the `worker` field.
The heartbeat is one row in `RateLimitState` (key `worker:heartbeat`) written every 15 s by each worker.

## 6. First run checklist

1. Open the public URL: the sign-in page loads over https with no certificate warning.
2. Check `https://<host>/api/health` returns `{"ok":true,"worker":"fresh"}` (after the worker's first 15 s).
3. Sign in by email: enter your address, receive the link, open it. If no mail arrives check `SMTP_URL` and `MAIL_FROM` and the web log
   (nothing is ever logged as a link in production: without SMTP the sign-in page says email sign-in is not set up).
4. Create a workspace (onboarding). You are its owner.
5. Settings, GitHub: connect the GitHub App (needs the `MERGEPORT_GITHUB_APP_*` values; see `docs/github-app.md` for the App's settings, webhook URL
   `https://<host>/api/github/webhook`, and the live checks in `docs/live-github-runbook.md`).
6. Track a repository from "Connect repositories", then watch the sync status page fill in. Webhook deliveries appear in the GitHub App's "Advanced" tab as 2xx.

## 7. Backups

Everything lives in the database. Back it up with `pg_dump`:

```sh
pg_dump --format=custom --file=mergeport-$(date +%F).dump "$DATABASE_URL"
# restore into an empty database:
pg_restore --no-owner --dbname="$NEW_DATABASE_URL" mergeport-2026-12-01.dump
```

With compose: `docker compose exec postgres pg_dump -U mergeport -Fc mergeport > mergeport.dump`. Keep `MERGEPORT_ENCRYPTION_KEY` and
the GitHub App private key with the backup, in a different place from the dump: stored GitHub and federation tokens cannot be read without the key.
A workspace owner can also export one workspace from Settings (a per-workspace export, not a deployment backup).

## 8. Upgrades

1. Back up the database.
2. Build the new version (image or git revision) and deploy the **web** service. It applies new migrations on start, then serves. Prisma takes
   a Postgres advisory lock, so several web replicas starting together are safe; the others wait.
3. Restart the **worker** on the new version once web is healthy (compose does this order for you).

Keep old and new versions running side by side only for the minutes a rolling restart takes: a migration may not suit the old code. There are
no down migrations: roll back by restoring the backup.

## 9. Scaling

- **Worker**: any number can run against one database. Jobs are claimed atomically, recurring jobs are deduplicated by key. One is enough for most
  deployments; add another for throughput or redundancy.
- **Web**: one or many replicas behind the proxy. Sessions and the sign-in rate limits live in the database, not in process memory, and
  all replicas must run the same build. The live "data changed" event stream (`/api/sync/events`) is per process: a page is told about changes
  made through its own web process only, so with several replicas or after a worker job finishes, a page shows the new data on its next load or
  refresh rather than instantly.
- Postgres: each process keeps up to 10 connections. Budget `max_connections` as (web replicas + workers) x 10.

## 10. Security checklist

- TLS everywhere; HSTS at the proxy if you like. Port 3000 reachable only from the proxy.
- `MERGEPORT_TRUST_PROXY=true` and `MERGEPORT_TRUSTED_PROXY_HOPS` equal to the proxies you really run; the proxy appends, never trusts, a client-sent `X-Forwarded-For`.
- `MERGEPORT_PUBLIC_URL` is the one public https host; the proxy forwards that Host unchanged.
- Secrets (`MERGEPORT_ENCRYPTION_KEY`, `MERGEPORT_AUTH_SECRET`, GitHub App secret and key, SMTP password, database password) are random, held
  in the platform's secret store, never in the repository or image. `.env.production` is git-ignored and excluded from the image.
- Postgres is not published to the internet; its password is not the example one.
- `DEMO_MODE` is not `true`; no `MERGEPORT_GITHUB_API_BASE`; no `MERGEPORT_FEDERATION_ALLOW_INSECURE`.
- `MERGEPORT_FEDERATION` stays `off` unless you link instances; if on, prefer `allowlist`.
- The GitHub App has only the permissions in `docs/github-app.md`; `MERGEPORT_GITHUB_WRITES` stays off unless you want writes.
- Backups are tested and stored encrypted, separately from the key.
- `/api/health` is public by design and returns only `ok` and the worker state.

## Not verified here

The Dockerfile and compose file were written and reviewed, `docker compose config` accepts the compose file, and every command the Dockerfile
runs was run natively (install without dev dependencies, build, migrate, start on 0.0.0.0, health, worker). An image build on a Docker
daemon and a run behind a real reverse proxy have not been done.
