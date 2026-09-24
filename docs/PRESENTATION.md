# Interview walkthrough and reasoning guide

Use this as a speaking outline. Understand the invariants before memorizing the answers. Keep the source open beside the demo.

## A 60-second introduction

> This service implements two kinds of API throttling. `/foo` uses a fixed window and `/bar` uses a continuously refilling token bucket. Clients have independent configurable policies on each route. Both algorithms work with local memory or Redis. The rate-limiting logic is handwritten, and Redis combines the decision and update in atomic Lua scripts so concurrent API instances cannot overspend the same quota. I focused on correctness, reproducible demonstrations, and explicit failure behavior rather than adding unrelated infrastructure.

Then identify the contract: a known bearer client ID, 200 when admitted, 429 when exhausted, 401 for invalid identity, and 503 when storage is unavailable.

## A 10-minute presentation

| Time | Show | Explain |
|---|---|---|
| 0–1 min | README endpoint table | Two algorithms, two stores, per-client/per-route isolation |
| 1–2 min | `config/clients.example.json` and `src/config.ts` | Different quotas, strict startup validation, no hidden defaults |
| 2–4 min | `src/rate-limit/algorithms.ts` | Fixed-window boundary, continuous refill, integer credits |
| 4–5 min | `src/rate-limit/types.ts` and `memory-store.ts` | Why the storage operation is atomic consume |
| 5–7 min | `redis-scripts.ts` and `redis-store.ts` | Shared clock, atomic mutation, safe TTL, bounded failure |
| 7–8 min | `npm run demo` | All eight required combinations verified over HTTP |
| 8–9 min | Tests and `docs/REVIEW.md` | Concurrency, exact time boundaries, persistence evidence |
| 9–10 min | `docs/DECISIONS.md` | Tradeoffs, known production boundaries, likely extensions |

If given only five minutes, show the endpoint/config table, the two pure functions, atomic consume, and the demo. Keep Redis outage and durability discussion for questions.

## Prepare the demo

Run this beforehand:

```sh
npm ci
npm run check
docker compose up -d --wait redis
npm run test:integration
npm run demo
```

Expected summary: 84 unit/HTTP/lifecycle tests and 21 real Redis tests pass. The demo prints eight rows; client-1 is admitted three times per route and client-2 six times, then each is denied. The longer demo period makes this reliable without waiting.

The demo opens temporary HTTP ports and uses an isolated Redis namespace; it does not need the normal server running. It closes its resources and removes only its own counters afterward. Explain that exact time/refill boundaries are verified with deterministic tests, not by timing curl calls during a presentation.

For a visible manual refill, run the normal ten-second configuration with `npm start`. Call `/bar` four times quickly as client-1: three 200 responses, then 429 with approximately four seconds Retry-After. After sufficient time, another call is allowed. Exact real-time counts can vary if you wait between calls; that is expected for a continuously refilling bucket.

Use the README's dedicated restart walkthrough if asked to demonstrate disk persistence. Do not delete the volume or change the namespace during that walkthrough.

## Explain the algorithms at a whiteboard

### Fixed window

Write: `L=3, W=10 seconds`.

1. First call starts the window and sets count to one.
2. Two further calls are admitted; count is now three.
3. More calls return 429 until the same reset timestamp.
4. Exactly at reset, the next call begins a new window.

Important sentence: **A denial does not move the window.** Otherwise an aggressive client could stay blocked indefinitely.

Tradeoff: unused allowance just before reset plus fresh allowance immediately after reset can cause a short burst. This is why a fixed window and a rolling-window limiter are not interchangeable.

### Token bucket

Draw a bucket holding three tokens, refilling at 0.3 tokens per second. Every admitted call removes one token. Idle time refills up to capacity, never beyond it.

Then show why the implementation uses credits:

```text
3 tokens × 10000 ms = 30000 maximum credits
1 request = 10000 credits
1 millisecond = 3 earned credits
```

After draining the bucket, 3333 ms earns 9999 credits: still insufficient. At 3334 ms, 10002 credits permits a request and preserves the remaining two credits. No decimal token rounding is required.

Important sentence: **A denial preserves earned credits and updates the refill timestamp; it does not charge another request.**

## Likely questions and concise answers

**Why not use an existing rate limiter?**

The assignment explicitly requires implementing the logic. Fastify handles HTTP and Redis handles storage, but admission calculations are handwritten and independently tested.

**Why use two algorithms?**

The brief requires different algorithms. These illustrate useful contrasting behavior: fixed allowance over discrete windows versus burst capacity with gradual recovery.

**Why Redis instead of just a map?**

A map is fast and simple but only coordinates one process and disappears on restart. Redis shares decisions across replicas and can persist state. Both are included because the assignment requires both strategies.

**Is Redis actually persistent here?**

Yes: the local service enables AOF and mounts `/data` to a named volume. An actual Redis restart/recreation was checked. With fsync every second, abrupt crashes can still lose recent writes; I do not claim lossless failure handling.

**What race would a normal read/write implementation have?**

Two callers could read the last token before either writes, and both get admitted. The Lua script serializes the complete read-decide-update operation. The concurrency test uses separate client connections to avoid proving only local serialization.

**Why duplicate TypeScript logic in Lua?**

The TypeScript functions make the algorithm easy to understand and test. Lua puts the decision beside shared Redis state. A common scenario suite and varied arrival comparison check that both implementations agree. WATCH/MULTI would avoid duplicate formulas but add connection isolation and contention retries.

**Does every request cost quota?**

Only a successful admission. Authentication failures, unsupported routes/methods, and 429 denials do not spend quota. Once admitted, disconnecting does not refund the unit.

**What if Redis is slow or unavailable?**

The request returns 503, never an unlimited pass or a fresh memory counter. Calls have deadlines. Automatic replay is disabled because a lost response might already have charged quota. This version requires an API restart to reconnect after failure; production recovery and readiness are identified follow-up work.

**Would fail-open ever be reasonable?**

It depends on the protected resource. A noncritical analytics endpoint might favor availability. This API's purpose is enforcing a quota, so silently losing that guarantee would be misleading. The failure mode is explicit and can be changed as a product decision.

**What is Retry-After promising?**

It rounds up the time until this state could admit another request. Another caller may consume that capacity first; it is not a reservation.

**How do multiple application instances agree on time?**

Redis TIME is read inside the script. They also need identical client policies and namespaces. Memory mode does not support shared quotas across processes.

**Why does the bucket key live for a whole period?**

After a whole refill period of inactivity, the bucket would be full anyway. Expiring at the next-token time would incorrectly recreate a full bucket much earlier.

**What happens when I change a limit?**

Restart with the new validated configuration. Policy values are part of the key, so the new state uses the correct credit units. Reverting to an old policy can resume its unexpired counter. Coordinate configuration across replicas.

**Why does the response say success instead of succes?**

The PDF is inconsistent. I followed its HTTP example and documented the assumption. It is one shared constant if the assessor prefers the literal page-1 spelling.

**Are client IDs secure authentication?**

They implement the assignment's contract. Anyone who knows a configured ID can use it. For a real product, derive the quota identity from verified authentication before calling the limiter.

**What would you change first for actual production traffic?**

Verified identities and TLS/private Redis, followed by readiness and controlled recovery, operational metrics/alerts, realistic load testing, and an explicit HA/durability policy. I would not claim a throughput figure or availability target without measuring the deployment.

## Prepare for the live extension

| Request | First step | Relevant modules | Test to add |
|---|---|---|---|
| Add a client | Add validated policy entry | config | Different allowance, independent state |
| Different quota on `/bar` | Change that route's policy | config | `/foo` unaffected |
| Add an endpoint with an existing algorithm | Extend route/policy definitions | config, routes, types | Auth and independent key |
| Add a sliding-window algorithm | Specify boundary/counting semantics first | algorithms, Lua, types | Exact cutoff and concurrency |
| Share one quota across routes | Change the quota key/grouping explicitly | keys, route mapping | One route exhausts the other's shared allowance |
| Recover after Redis returns | Add controlled connection replacement without retrying consumes | store lifecycle | No replay, bounded retries, readiness changes |
| Expose remaining quota | Define what it means for both algorithms | decision type, scripts, responses | Headers agree with exact post-consumption state |

Before coding a new feature, state its invariant aloud. For example: “Across both endpoints, this client must receive at most three admissions in this window.” Then choose the key and atomic operation that enforce it.

## Statements to avoid

- “JavaScript is single-threaded, so Redis requests cannot race.” Network waits and multiple replicas make that false.
- “Redis always persists everything.” Durability depends on configuration and failure mode.
- “A token bucket guarantees three requests in every ten-second interval.” It allows bursts plus refill.
- “A timeout means the operation never happened.” The response can be lost after the write.
- “The tests prove complete production readiness.” They establish specific invariants; identity, operations, scale, and availability remain deployment concerns.

Be candid about these boundaries. Clear reasoning about a limitation is stronger than an unsupported guarantee.
