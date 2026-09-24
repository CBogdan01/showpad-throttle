# Throttle

A small TypeScript API demonstrating **handwritten rate limiting** with two algorithms and two interchangeable storage providers.

| Endpoint   | Algorithm                                               | `client-1`                        | `client-2`                        |
| ---------- | ------------------------------------------------------- | --------------------------------- | --------------------------------- |
| `GET /foo` | Fixed window, beginning with the first admitted request | 3 requests / 10 seconds           | 6 requests / 10 seconds           |
| `GET /bar` | Token bucket, initially full                            | Capacity 3; refill 3 / 10 seconds | Capacity 6; refill 6 / 10 seconds |

Each client has an independent quota on each endpoint. Select process-local memory or disk-persistent Redis at startup. No rate-limiting library is used.

Read [design decisions](docs/DECISIONS.md) for the reasoning, [the presentation guide](docs/PRESENTATION.md) for an interview walkthrough, and [the verification report](docs/REVIEW.md) for the PDF audit and actual check results.

## Quick start: memory

Prerequisite: **Node.js 24**, preferably the **24.21.0** version in `.nvmrc`. Docker is needed only for Redis/container checks. Run commands from the repository root.

```sh
npm ci
npm run check
npm start
```

`npm run check` typechecks, compiles to `dist/`, and runs the unit/HTTP tests. The server listens at `http://127.0.0.1:3000`.

```sh
curl -i http://127.0.0.1:3000/foo -H 'Authorization: Bearer client-1'
curl -i http://127.0.0.1:3000/bar -H 'Authorization: Bearer client-2'
```

On Windows PowerShell, use `npm.cmd` and `curl.exe` if the default names resolve to restricted scripts or PowerShell aliases. `npm run dev` runs the source with automatic restart during development. Production execution uses `npm start`, without a TypeScript runtime dependency.

## Redis mode

Docker Desktop must be running on Windows/macOS. Start the persistent Redis service:

```sh
docker compose up -d --wait redis
```

Then stop any API already using port 3000 and start the API in Redis mode.

PowerShell:

```powershell
$env:RATE_LIMIT_STORE = 'redis'
$env:REDIS_URL = 'redis://127.0.0.1:6379'
npm.cmd start
```

POSIX shell:

```sh
RATE_LIMIT_STORE=redis REDIS_URL=redis://127.0.0.1:6379 npm start
```

Alternatively, run both services in containers:

```sh
docker compose --profile app up --build -d --wait
```

The container API also listens on `http://127.0.0.1:3000`. It uses the `compose` quota namespace, separate from the host application's `local` namespace. Stop it before starting a host API on the same port:

```sh
docker compose --profile app stop api
```

The Redis container uses AOF with `appendfsync everysec`, a named `/data` volume, and `noeviction`. Its port is bound to loopback. A graceful Redis restart retains active quotas; abrupt failures can lose approximately the most recent second of writes. Do not use `docker compose down -v` when you intend to retain counters. `docker compose down` stops/removes containers but retains the named volume.

The application container runs as UID 1000, with a read-only filesystem and dropped Linux capabilities in Compose. Node and Redis images are pinned by digest. Renew the dependency lockfile and image digests deliberately as patched versions become available.

## API contract

Send exactly one `Authorization: Bearer <client-id>` header. The bearer scheme is case-insensitive; client IDs are case-sensitive and must exist in configuration. Missing, malformed, duplicate, and unknown credentials are rejected before storage access.

| Outcome             | Status | JSON body                           |
| ------------------- | ------ | ----------------------------------- |
| Admitted            | 200    | `{"success":true}`                  |
| Quota exhausted     | 429    | `{"error":"rate limit exceeded"}`   |
| Invalid credentials | 401    | `{"error":"unauthorized"}`          |
| Store unavailable   | 503    | `{"error":"service unavailable"}`   |
| Unexpected failure  | 500    | `{"error":"internal server error"}` |

The PDF uses `succes` on page 1 and `success` in the HTTP example on page 2. This implementation follows the example's **`success`** spelling. That assumption is intentional; the shared response constant is in `src/http/responses.ts`.

429 responses include a positive integer `Retry-After` in seconds, rounded up. It is advice based on the current state, not a reservation. Endpoint responses use `Cache-Control: no-store`; 401 also includes `WWW-Authenticate: Bearer`.

Denied requests do not spend additional quota. Query strings share the same route quota. `/foo` does not consume `/bar` allowance. Unsupported paths/methods return 404 and do not consume quota; automatic HEAD routing is disabled. Admission is charged even if the caller disconnects before receiving its response.

## Configuration

The checked-in [sample client file](config/clients.example.json) is ready to run. Each client has this shape:

```json
{
  "id": "client-1",
  "foo": { "limit": 3, "periodMs": 10000 },
  "bar": { "limit": 3, "periodMs": 10000 }
}
```

The file's root is `{ "clients": [ ... ] }`. It requires 2–1000 unique clients, both policies per client, integer limits from 1–10000, and integer periods from 1000–86400000 ms. IDs and namespaces match `[A-Za-z0-9_-]{1,64}`. Unknown JSON fields and invalid values fail startup. The loaded policies are immutable; there is no configuration endpoint or hot reload.

For `/bar`, `limit` sets both burst capacity and the number of tokens replenished per period. A token bucket is an average-rate limit with burst capacity, **not** a strict limit over every rolling interval.

| Variable               | Default                         | Notes                                               |
| ---------------------- | ------------------------------- | --------------------------------------------------- |
| `HOST`                 | `127.0.0.1`                     | Container sets `0.0.0.0`                            |
| `PORT`                 | `3000`                          | Integer 1–65535                                     |
| `RATE_LIMIT_STORE`     | `memory`                        | `memory` or `redis`                                 |
| `CLIENTS_FILE`         | `./config/clients.example.json` | Relative to working directory                       |
| `RATE_LIMIT_NAMESPACE` | `local`                         | Same value on replicas sharing quotas               |
| `REDIS_URL`            | None                            | Required in Redis mode; supports `redis:`/`rediss:` |
| `LOG_LEVEL`            | `info`                          | fatal/error/warn/info/debug/trace/silent            |

`.env.example` documents these values. Files named `.env` are **not** loaded implicitly. To load one explicitly after building:

```sh
node --env-file=.env dist/server.js
```

## Deployment

The deployed Railway service uses Redis so rate-limit state survives API restarts and is shared by replicas. The local default remains process-local memory, which is convenient for development and resets when the API restarts.

Railway production variables:

```env
RATE_LIMIT_STORE=redis
REDIS_URL=${{Redis.REDIS_URL}}
RATE_LIMIT_NAMESPACE=railway-production
```

`REDIS_URL` is a Railway service reference to the Redis database in the same project; do not commit a concrete Redis URL or password. Railway supplies `PORT`, and the container already listens on `0.0.0.0`.

The current deployed API is available at:

```text
https://showpad-throttle-production.up.railway.app
```

Smoke-test the deployed service with one of the configured demonstration clients:

```sh
curl -i https://showpad-throttle-production.up.railway.app/foo \
  -H 'Authorization: Bearer client-1'
```

The sample `client-1` and `client-2` credentials are intentionally for demonstration. Replace the client configuration and authentication approach before treating the public deployment as a production API.

Compose additionally accepts `REDIS_PORT` and `API_PORT` to change host port mappings. If Redis's host port changes, adjust the host application's `REDIS_URL` accordingly. The API container always reaches Redis on the internal service port 6379.

Redis keys contain namespace, route, client ID, and policy values. A new policy uses separate state; reverting to an earlier policy can resume its unexpired state. Changing the namespace deliberately resets the logical quota set. All replicas must use the same namespace and policies.

## Tests and repeatable demo

```sh
npm run check
docker compose up -d --wait redis
npm run test:integration
npm run demo
```

Integration tests and the demo use `REDIS_URL`, defaulting to `redis://127.0.0.1:6379`. They fail explicitly if Redis is unavailable. They use isolated namespaces and delete only their own keys. The default unit suite needs no Redis.

The demo starts its own temporary HTTP listeners, so an existing API does not interfere. Its ten-minute policies prevent replenishment during the burst. It asserts the complete **two clients × two endpoints × two providers** matrix:

| Provider | Client   | `/foo`            | `/bar`            |
| -------- | -------- | ----------------- | ----------------- |
| Memory   | client-1 | 3 × 200, then 429 | 3 × 200, then 429 |
| Memory   | client-2 | 6 × 200, then 429 | 6 × 200, then 429 |
| Redis    | client-1 | 3 × 200, then 429 | 3 × 200, then 429 |
| Redis    | client-2 | 6 × 200, then 429 | 6 × 200, then 429 |

The automated suites cover boundary/refill math, clock regressions, authentication, status/body contracts, store failures, deadlines, privacy of logs, real Redis expiry, corrupted state, and concurrent consumption from independent connections. See [verification details](docs/REVIEW.md).

## Prove persistence yourself

Use a host API, stopping the container API first if necessary. The following PowerShell environment deliberately gives enough time for restarts:

```powershell
$env:RATE_LIMIT_STORE = 'redis'
$env:REDIS_URL = 'redis://127.0.0.1:6379'
$env:CLIENTS_FILE = './config/clients.demo.json'
$env:RATE_LIMIT_NAMESPACE = 'restart-' + [guid]::NewGuid().ToString()
npm.cmd start
```

From another terminal, run each command four times quickly:

```powershell
1..4 | ForEach-Object { curl.exe -s -i http://127.0.0.1:3000/foo -H 'Authorization: Bearer client-1' }
1..4 | ForEach-Object { curl.exe -s -i http://127.0.0.1:3000/bar -H 'Authorization: Bearer client-1' }
```

For each route, the first three calls succeed and the fourth returns 429.

1. Stop and restart the API in the **same terminal**, preserving all environment variables. Both routes should still return 429.
2. Run `docker compose restart redis`, followed by `docker compose up -d --wait redis`. Restart the API again so it reconnects. Both routes should still return 429.
3. Finish before 200 seconds have elapsed since the first `/bar` request; tokens legitimately refill after that. Repeat with a fresh namespace if necessary.
4. Repeat the API restart in memory mode: `$env:RATE_LIMIT_STORE = 'memory'`. Fresh allowance after restart is expected.

For POSIX shells, export the same variables (`export RATE_LIMIT_STORE=redis`, etc.) and use `for i in 1 2 3 4; do curl ...; done`. Keep the same namespace across the restart. Return `CLIENTS_FILE` to the normal example file afterward if you want ten-second policies again.

## Operational behavior and boundaries

- Memory is one-process storage. Use Redis for quotas shared across workers/replicas.
- Redis admission is a single, constant-time Lua operation using Redis's clock. There is no client-side read/modify/write race and no fallback to memory.
- Startup waits at most three seconds for Redis. Commands have a one-second deadline. Lost connections or deadlines require an API restart to recover; requests fail with 503 meanwhile. This deliberately simple recovery policy is explained in [the decisions](docs/DECISIONS.md#9-failure-and-recovery-policy).
- A timed-out command may already have consumed quota. It is not retried. Quotas are admission controls, not billing-grade exactly-once counters.
- SIGINT/SIGTERM triggers shutdown, with a five-second overall deadline. Redis closes after HTTP drains.
- Logs contain generated request IDs, matched routes, statuses, duration, and store type. Authorization values, full query strings, and Redis credentials are excluded.
- The assignment's known client IDs are demonstration credentials. Before exposing a real product, replace this identity lookup with verified authentication, use HTTPS/private Redis with ACLs/TLS, add dependency-aware readiness and controlled recovery, measure capacity, and define availability/durability requirements.

This is a production-minded assessment implementation with tested correctness and explicit operational limits. The repository is published at `CBogdan01/showpad-throttle`, and the Railway deployment is configured with Redis for shared, persistent rate-limit state. The GitHub workflow is provided for hosted CI.

## Code map

```text
src/config.ts                           Validate startup configuration and client policies
src/auth.ts                             Parse a single bearer identity
src/http/routes.ts                      Route → policy → atomic admission → response
src/rate-limit/algorithms.ts            Pure fixed-window and token-bucket transitions
src/rate-limit/memory-store.ts          Process-local atomic state changes
src/rate-limit/redis-scripts.ts         Handwritten atomic Lua transitions
src/rate-limit/redis-store.ts           Redis transport, deadlines, response validation
src/rate-limit/create-store.ts          Provider selection at startup
src/app.ts                              Testable HTTP assembly, logs, error mapping
src/server.ts                           Listening and process lifecycle
test/                                   Unit, HTTP, conformance, and integration checks
scripts/demo.ts                         Real HTTP demonstration across all eight cases
```
