# Verification and assessment review

Review date: **2026-09-24**. The original two-page `Showpad BE Take Home Test - Candidate Information (3).pdf` was re-extracted and compared with the implemented behavior after the first working version. A separate pass then examined boundaries, concurrency, transport failures, logging, packaging, and documentation.

## PDF requirement audit

| Requirement | Implementation / evidence | Result |
|---|---|---|
| Compile and provide run instructions | Strict TypeScript build; README memory, Redis and Docker commands | Pass |
| Any language/framework | TypeScript, Node 24, Fastify | Pass |
| Implement own rate limiting | Pure transitions plus handwritten Redis Lua; no limiter dependency | Pass |
| Two GET routes with different algorithms | `/foo` fixed window; `/bar` token bucket | Pass |
| Bearer client-ID authentication | Allowlist lookup; malformed/duplicate/unknown values rejected before storage | Pass |
| 200 with successful JSON | `{"success":true}` as in the page-2 HTTP example | Documented ambiguity |
| 429 with required error JSON | `{"error":"rate limit exceeded"}` | Pass |
| Configurable per-client limits | Validated external JSON; individual policies for each route | Pass |
| At least two clients with different quotas | client-1 limit 3; client-2 limit 6 | Pass |
| In-memory and persistent storage | Bounded maps; Redis AOF with retained named volume | Pass |
| Demonstrate two clients × two routes × two stores | Real-HTTP demo asserts all eight combinations | Pass |
| At least one test | 84 unit/HTTP/lifecycle tests plus 21 real Redis tests | Pass |
| Public cloud deployment | Container prepared; no cloud deployment performed | Optional stretch, not done |

The PDF's page-1 `succes` conflicts with page-2 `success`. The code follows the concrete HTTP example and documents the choice in README and the shared response module. Publishing a repository, messaging a recruiter, and inviting collaborators are submission actions described by the document; none were performed.

## Checks actually executed

| Check | Environment / observation | Result |
|---|---|---|
| Dependency installation/audit | Locked dependency install; npm reported zero known vulnerabilities at install time | Pass |
| `npm run check` | Windows, Node 24.9.0: typecheck, build, 84 unit/HTTP/lifecycle tests | Pass |
| `npm run test:integration` | Windows against real Redis 8.10.2; 21 tests | Pass |
| `npm run demo` | Windows; eight real HTTP scenarios | Pass |
| Clean `npm ci` and full checks | Linux container, Node 24.21.0; build, 84 unit tests, 21 integration tests, eight-case demo | Pass |
| Production Docker build | Pinned Node 24.21.0 image, compiled JS, production-only dependencies | Pass |
| Production container HTTP calls | Both GET routes returned 200 with the required selected success body | Pass |
| Runtime restrictions | UID 1000 (`node`), Compose read-only root filesystem | Pass |
| Redis persistence settings | Inspected `appendonly=yes`, `appendfsync=everysec`, `maxmemory-policy=noeviction` | Pass |
| API process restart in Redis mode | Drained both routes; newly spawned compiled API still returned 429 on both | Pass |
| Redis graceful restart/recreation | Same named volume; newly spawned compiled API still returned 429 on both | Pass |
| API process restart in memory mode | Drained both routes; new compiled API returned 200 on both | Pass |
| Real Redis outage | Stopped Redis while container API was running; both routes returned exact 503 bodies | Pass |
| Recovery policy | Starting Redis alone left API closed to admission; restarting API restored 200 on both routes | Pass |
| Graceful container shutdown | SIGTERM emitted the shutdown event; container exited with code 0 | Pass |
| Documentation consistency | Six Markdown files checked; code fences balanced and nine local links resolve | Pass |

The hosted GitHub workflow has not run because the repository has not been published. The Linux check executed its application test/build/demo sequence locally. No load benchmark, public deployment, forced-crash durability claim, or availability claim is inferred from these results.

## What the separate review checked and improved

1. **Algorithm edge cases:** exact reset boundaries, denial without sliding, millisecond token fractions, long-idle caps, and backwards time. Shared concrete expectations and a varied arrival sequence check TypeScript/Lua agreement.
2. **Concurrency:** two independent real Redis connections contend for one quota. Frozen-time tests admit exactly L out of 100 calls. Production-clock tests also exercise the actual adapter.
3. **Transport deadline:** added a direct adapter test proving a stuck operation disposes the connection, is not replayed, rejects subsequent requests, and permits repeated cleanup. The lower-level timer tests verify cancellation and handling of late rejection.
4. **HTTP duplicates:** the real-socket duplicate Authorization test includes a valid Host header so it tests authentication instead of HTTP parser rejection. Duplicate credentials get 401 without store access.
5. **Logging:** checked successful, unauthorized, and unmatched routes for leaking Authorization values or query secrets. Updated the Fastify logging configuration to its current nondeprecated LogController API.
6. **Redis expiry:** checked script-generated TTLs and actual expiration. Assertions allow measured network time instead of incorrectly demanding that PTTL still equal the original TTL.
7. **Persistence evidence:** distinguished API recreation from Redis restart, then tested both. State survived a graceful restart and container recreation with its volume retained.
8. **CI runtime:** changed the Actions integrations from Node-20-era v4 to Node-24-compatible v6, restricted repository permissions, and disabled persisted checkout credentials.
9. **Demo diagnosis:** made assertion failures visible without printing Redis connection details, and print the success summary after cleanup.
10. **Packaging and configuration:** verified the compiled application, a clean Linux dependency install, digest-pinned runtime images, non-root execution, and documented environment-loading behavior.
11. **Actual outage behavior:** stopped the live Redis service, checked both HTTP 503 responses, then confirmed recovery requires the documented API restart. Graceful API shutdown was also exercised in Linux.

## Intentional operational limits

- Configured client IDs are demonstration credentials, not verified identities for a public product.
- Memory quotas belong to one process and reset on restart.
- Redis connection loss/deadline requires restarting the API; there is no readiness endpoint or reconnection supervisor in this version.
- A lost reply can leave a request charged even when it receives 503. Consumes are not automatically retried.
- AOF every-second fsync can lose recent writes after abrupt failure. HA/failover can introduce additional loss.
- Redis time/expiry assumes a reasonably synchronized server clock; arbitrary host-clock changes are outside the guarantee.
- Replica policy/namespace consistency is an operational responsibility. Policy reversion can resume unexpired state.
- Fixed-window boundary bursts and token-bucket burst capacity are intentional algorithm properties.

These limits are reflected in the README and decision guide. The checks found no remaining failing requirement in the required assessment scope, subject to the explicitly documented success-field spelling ambiguity.
