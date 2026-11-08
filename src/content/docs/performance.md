---
title: "Issuerd Performance"
description: "Measured performance of Issuerd against Keycloak 26.7 under identical container resource limits, plus CPU/RAM/disk/log sizing data. Issuerd is faster than Keycloak 26.7 in every measured scenario…"
---

Measured performance of Issuerd against **Keycloak 26.7** under identical container
resource limits, plus CPU/RAM/disk/log sizing data. **Issuerd is faster than
Keycloak 26.7 in every measured scenario** — up to 7.5× the throughput, with lower
p99 latency in every headline scenario (§2; the agentic-workload nuances are in §4) —
while idling on ~6.3× less memory and shipping a 7.5× smaller image. **Every number
on this page comes from a real run** of the benchmark stack in `tests/perf/` on the
hardware described below — nothing is estimated unless it is explicitly marked
*(extrapolated)*.

> Reproduce / re-measure: `tests/perf/README.md` (or `./scripts/campaign.sh` for the
> full ~1.5 h unattended run). Raw artifacts: `tests/perf/results/<RUN_ID>/`
> (gitignored). Charts: `python tests/perf/scripts/charts.py tests/perf/results/<RUN_ID>`.

## 1. Methodology

### 1.1 Environment

| | |
|---|---|
| Host | Intel Core Ultra 7 265K (20 cores), 128 GiB RAM, Windows 11 |
| Container runtime | Docker Desktop 29.6.2 (WSL2 VM: 16 vCPU / ~101 GiB) |
| Issuerd | `issuerd:perf` — local release build from this repo (distroless image) |
| Keycloak | `keycloak-optimized:26.7.4` — **optimized production build** of `keycloak/keycloak:26.7.4` (`kc.sh build` at image-build time, `start --optimized` at runtime; `tests/perf/keycloak/Dockerfile`) + PostgreSQL 15 backend, realm import with 1,000 users |
| CIBA helper | `ad-simulator` (`python:3.12-alpine`, 0.25 CPU / 128 MiB) — approves Keycloak CIBA requests via KC's auth-channel callback (§1.4) |
| Database (both) | `postgres:15-alpine`, one dedicated instance per server |
| Load generator | `grafana/k6:2.1.0`, running **inside** the isolated network (no host-network noise) |

Topology: one Docker bridge network `172.34.0.0/24` with `internal: true` — **no
internet access in either direction, nothing is published**. Both servers serve plain
HTTP inside the network (TLS is normally terminated at the edge; both sides are
measured identically).

The final dataset is `release-0.2.2-final-20261108`. It combines the complete
`release-0.2.2-fixed-20261108` campaign with a targeted small/large CIBA rerun
(`ciba-cookie-fixed-20261108`) after the harness's SSO-cookie selector was corrected.
The server build is identical across these runs. The k6 harness also normalizes
exported P-256 JWK coordinates to their RFC-required fixed width before creating
DPoP proofs.

### 1.2 Resource tiers

App containers are pinned with Docker `deploy.resources.limits`; PostgreSQL and k6 are
fixed across tiers.

| Tier | App container | PostgreSQL | k6 |
|------|--------------|-----------|-----|
| small | 1 CPU / 512 MiB | 2 CPU / 2 GiB | 4 CPU / 2 GiB |
| medium | 2 CPU / 1 GiB | 2 CPU / 2 GiB | 4 CPU / 2 GiB |
| large | 4 CPU / 2 GiB | 2 CPU / 2 GiB | 4 CPU / 2 GiB |

### 1.3 Fair-comparison rules

- Same machine, same tiers, same k6 scripts, same scenario mix, runs executed
  sequentially (the idle server adds no measurable load: <0.1% CPU).
- Equal functional setup: realm `perf`, confidential + public clients, PKCE (S256) on
  the auth-code flow, password users provisioned in bulk. Password hashing is each
  server's **out-of-box default** — Argon2id on **both** sides since Keycloak 25,
  verified from the stored credential rows: Keycloak 26.7 Argon2id m=7,168 KiB,
  t=5, p=1; Issuerd Argon2id m=19,456 KiB, t=2, p=1 (the Rust `argon2` crate
  default). Neither side was tuned.
- Keycloak 26 persists **user sessions in the database by default** (the
  persistent-user-sessions feature), so both servers now pay per-login DB writes.
  Keycloak's realm still has **event persistence off** (its default); Issuerd
  persists login + admin events by default — Issuerd pays a per-login event write
  that Keycloak skips.
- Keycloak 26.7 runs its **optimized production build** — `kc.sh build` at
  image-build time, `start --optimized` at runtime, the documented production
  container shape (not the `start-dev` quickstart), with the public base URL
  pinned via hostname v2 (`--hostname=http://keycloak:8080`).
- **DPoP** is supported and on by default since Keycloak 26.4: KC binds a token
  whenever a valid proof is presented, exactly like Issuerd. No client attribute
  was set (forcing `dpop.bound.access.tokens` would break the proof-less
  scenarios that share the same client).
- **CIBA** (poll mode) is supported and on by default in Keycloak 26. KC's
  built-in HTTP auth channel is pointed at the `ad-simulator` container, which
  approves every backchannel request through KC's own callback endpoint. The k6
  script waits a **modeled 200 ms device-approval latency** before its first
  poll; Issuerd's approval is an in-loop SSO-cookie call instead (§1.4). Both are
  disclosed in the numbers.
- **Introspection** on Keycloak 25+ requires the calling client in the token's
  `aud`; the imported realm adds an `audience-self` protocol mapper to the
  confidential client (no equivalent needed on Issuerd).
- All reported runs had **0% scenario errors** (k6 `errors` rate), except the
  bulk-provisioning and repeated-tier admin scenarios where 409-conflict skips
  are expected (§3 and §7). Every other scenario also had 0% HTTP failures.

### 1.4 Scenarios and load profiles

| Scenario | What one iteration does | Default load |
|---|---|---|
| `discovery` | `GET /.well-known/openid-configuration` | 50&nbsp;VU,&nbsp;60&nbsp;s |
| `client_credentials` | `POST /token` (grant_type=client_credentials) | 50&nbsp;VU,&nbsp;60&nbsp;s |
| `password_grant` | `POST /token` (ROPC), distinct user per request from a pool | 20&nbsp;VU,&nbsp;60&nbsp;s |
| `userinfo` | `GET /userinfo` with a Bearer token | 100&nbsp;VU,&nbsp;60&nbsp;s |
| `introspect` | `POST /token/introspect` (confidential client) | 50&nbsp;VU,&nbsp;60&nbsp;s |
| `auth_code_flow` | full browser-less login: `GET /authorize` → login POST → code+PKCE token exchange (3 requests) | 15&nbsp;VU,&nbsp;60&nbsp;s |
| `dpop` | two concurrent sub-scenarios (30 VU each): token request with a fresh ES256 DPoP proof, and DPoP-bound `userinfo` (proof carries `ath`, single-use `jti`) | 2×30&nbsp;VU,&nbsp;60&nbsp;s |
| `ciba` | full CIBA cycle: `bc-auth` → user approve → token poll. Issuerd: 3 measured requests, approval via SSO-cookie `ext/ciba/approve`. Keycloak: 2 measured requests, approval out-of-band via the ad-simulator after a modeled 200 ms device-approval latency | 10&nbsp;VU,&nbsp;60&nbsp;s |
| `admin_users` | Admin-API user creation with password (provisioning rate) | 10&nbsp;VU,&nbsp;60&nbsp;s |

## 2. Headline results — medium tier (2 CPU / 1 GiB)

Throughput (requests/second, higher is better):

| Scenario | Issuerd | Keycloak 26.7 | ratio |
|---|---:|---:|---:|
| discovery | **59,872** | 8,371 | 7.2× |
| client_credentials | **2,776** | 660 | 4.2× |
| password_grant (login) | **155** | 106 | 1.5× |
| userinfo | **28,459** | 9,096 | 3.1× |
| introspect | **25,716** | 5,888 | 4.4× |
| auth_code_flow | **361** (120 logins/s) | 283 (94 logins/s) | 1.3× |
| admin_users (provisioning) | **154** | 122 | 1.3× |

p99 latency (ms, lower is better — Issuerd is lower in **every** scenario):

| Scenario | Issuerd p99 | Keycloak 26.7 p99 |
|---|---:|---:|
| discovery | **2.2** | 87.1 |
| client_credentials | **26.4** | 197.4 |
| password_grant | **174.4** | 297.0 |
| userinfo | **7.0** | 90.7 |
| introspect | **4.1** | 85.6 |
| auth_code_flow | **109.7** | 214.3 |
| admin_users | **88.1** | 118.1 |

![Throughput by scenario, medium tier](/images/perf/throughput_vs_keycloak_medium.png)
![p99 latency by scenario, medium tier](/images/perf/p99_vs_keycloak_medium.png)

Reading the table honestly:

- Both servers hash passwords with Argon2id by default (parameters in §1.3), and
  Issuerd additionally persists the audit events that Keycloak skips in this setup.
- **Session-checked reads (`userinfo`/`introspect`): Issuerd wins at every tier.**
  Medium tier: `userinfo` 28,459 vs 9,096 rps (3.1×), `introspect` 25,716 vs 5,888
  rps (4.4×). Large tier: `userinfo` 51,976 vs 20,514 rps, `introspect` 46,786 vs
  12,947 rps. Issuerd serves the read path from a generation-validated read model,
  while token-signature, expiry, revocation, realm `not_before`, and session-validity
  checks still run before a cached response is used.
- Keycloak's medians on cached reads are good, but its tail latency is much higher:
  medium-tier p99 is 90.7 ms for `userinfo` and 85.6 ms for `introspect`, versus
  7.0 ms and 4.1 ms for Issuerd.
- The throughput lead is not a claim that every path scales linearly. In particular,
  client-credentials issuance is nearly flat across the tested tiers (§3), and CIBA
  has lower per-request p99 on Keycloak despite Issuerd's higher cycle rate (§4).

## 3. Tier scaling (1 → 2 → 4 CPU)

Requests/second:

| Scenario | server | small | medium | large |
|---|---|---:|---:|---:|
| discovery | Issuerd | **43,952** | **59,872** | **97,384** |
| | Keycloak | 1,706 | 8,371 | 22,586 |
| client_credentials | Issuerd | **2,490** | **2,776** | **2,730** |
| | Keycloak | 112 | 660 | 1,763 |
| password_grant | Issuerd | **94.3** | **155** | **264** |
| | Keycloak | 41.2 | 106 | 115 |
| userinfo | Issuerd | **16,662** | **28,459** | **51,976** |
| | Keycloak | 2,731 | 9,096 | 20,514 |
| introspect | Issuerd | **15,384** | **25,716** | **46,786** |
| | Keycloak | 1,928 | 5,888 | 12,947 |
| auth_code_flow | Issuerd | **239** | **361** | **549** |
| | Keycloak | 106 | 283 | 317 |

![Issuerd throughput vs tier](/images/perf/issuerd_scaling.png)
![Throughput, small tier](/images/perf/throughput_vs_keycloak_small.png)
![p99, small tier](/images/perf/p99_vs_keycloak_small.png)
![Throughput, large tier](/images/perf/throughput_vs_keycloak_large.png)
![p99, large tier](/images/perf/p99_vs_keycloak_large.png)

Observations:

- **`userinfo` and `introspect` scale close to linearly** across these tiers:
  16.7k → 28.5k → 52.0k and 15.4k → 25.7k → 46.8k respectively.
- **`client_credentials` does not scale linearly in this campaign**: it stays around
  2.5–2.8k rps. Every grant also writes its client-login event and client session;
  these results replace the older pre-audit-fix figures, which were collected while
  PostgreSQL rejected the synthetic subject's event row.
- `password_grant` scales 94 → 155 → 264 logins/s, and `auth_code_flow` scales
  239 → 361 → 549 requests/s. `discovery` reaches 97,384 rps at the large tier;
  scaling flattens as the fixed 50 k6 VUs become the limiting factor.
- Keycloak also serves at the small tier, but with much larger tails: client-credentials
  p99 is 1.60 s, password-grant p99 1.19 s, and auth-code p99 690 ms there.
- `admin_users` is compared at the medium tier only: the small/large runs reused
  the deterministic user-name space on the same database, so most requests were
  409-conflict skips rather than new provisioning, and are excluded from the
  comparison. The medium rows above ran against a fresh namespace for both servers.

## 4. Agentic workloads (DPoP / CIBA)

Issuerd implements **DPoP (RFC 9449)** and **CIBA (poll mode)**. Keycloak 26.7
supports both, so this section is a head-to-head. DPoP is measured in proof-carrying
HTTP requests/s; CIBA is measured in complete cycles/s.

| Scenario | server | small | medium | large | p99 (medium) |
|---|---|---:|---:|---:|---:|
| `dpop` | Issuerd | **5,819** | **9,987** | **11,592** | **40.9 ms** |
| | Keycloak | 459 | 1,442 | 3,138 | 110.9 ms |
| `ciba` | Issuerd | **343.9** | **346.7** | **340.9** | 17.9 ms |
| | Keycloak | 41.2 | 46.4 | 46.4 | **11.1 ms** |

![Agentic workloads, medium tier](/images/perf/agentic_medium.png)

- **DPoP**: each iteration mints a fresh ES256 proof in k6 via WebCrypto; the
  server verifies the signature, the single-use `jti`, and (on userinfo) the
  `ath` token binding. Across the three tiers the campaign pushed approximately
  **1.64 million proof-carrying requests through Issuerd and 302k through Keycloak**,
  with zero scenario errors.
- **CIBA cycle rate**: Issuerd completes about 341–347 cycles/s across the tiers;
  Keycloak sits at about 41–47 cycles/s. Keycloak is bounded by the harness here:
  10 VUs × 200 ms modeled approval latency gives a roughly 50 cycles/s ceiling.
- **CIBA latency is a genuine counterexample to an across-the-board latency win**:
  Keycloak's medium-tier HTTP p99 is 11.1 ms versus Issuerd's 17.9 ms. Issuerd's
  measured cycle includes the approval write itself (browser-session authentication,
  approval, and audit), while Keycloak's approval runs in the helper container.
- Across the three tiers Issuerd completed approximately **51.6k full CIBA cycles**
  and Keycloak **8.0k**, all with zero scenario errors.

## 5. Resource usage: CPU, RAM, images

**Memory.** Issuerd's working set is substantially smaller and does not require a JVM
heap. These figures include the application container only, not PostgreSQL:

| | idle RSS | peak under load (medium tier) | worst peak (large tier) |
|---|---:|---:|---:|
| Issuerd app | 91.5 MiB | 80.7–288.7 MiB across 9 scenarios | 386.3 MiB (admin_users) |
| Keycloak 26.7 app | 575.5 MiB | 754.5–810.4 MiB | 1,170.4 MiB (auth_code_flow) |

![Peak memory under load](/images/perf/memory_medium.png)

**CPU.** Read-heavy scenarios approach their container CPU caps on both servers.
CIBA does not saturate the application allocation in this harness; its cycle shape and
approval pacing are more useful for interpreting the result than raw CPU percentage.

**Image footprint.** 34.6 MiB vs 258.2 MiB **compressed pull size** (Docker image
`.Size` under Docker Desktop's containerd image store) — **7.5× smaller**. The
Issuerd image is distroless: no shell or package manager; only the stripped binary,
minimal runtime libraries, and Kerberos shared libraries are shipped.

![Container image footprint](/images/perf/image_size.png)

## 6. Disk and log sizing (measured)

### 6.1 Database size vs user count

Measured on the campaign's seeding ladder (3 → 1,003 → 23,327 → 113,327 users;
`users` + `credentials` table heap):

- Marginal cost per stored user: **≈710 B** (slope between the 1k and 113.3k
  points; includes the Argon2id password credential). PostgreSQL page
  granularity makes small populations look step-wise.
- Whole database at **113,327 users, steady state** (sessions/events wiped):
  **85.7 MiB** total (all tables + indexes), i.e. well under 1 GiB for a
  hundred-thousand-user directory. *(Extrapolated: 1 M users ≈ 0.7 GiB for
  users+credentials, ≈0.8 GiB whole DB — projection, not measured.)*
- The same database **before** wiping transient rows (74,448 live sessions and
  1,112,048 stored login/admin events): **418.7 MiB**. Login churn can exceed
  user data if events/sessions are never expired. Set `events_expiration_secs`
  per realm and rely on session expiry; dead tuples are reclaimed by autovacuum
  in normal operation.

![Database growth](/images/perf/disk_users.png)

### 6.2 Per-login and per-CIBA-cycle churn (Issuerd, measured)

Derived from table-size deltas over runs with known iteration counts:

| Artifact | Size |
|---|---:|
| login event row (`events`) | ≈304 B |
| `user_sessions` row | ≈247 B |
| `client_sessions` row | ≈180 B |
| **total per interactive login** | **≈731 B** (heap; indexes/WAL extra) |
| admin event row (provisioning audit) | ≈220 B |
| full CIBA cycle (bc-auth → approve → poll, all tables) | ≈1.17 KB |

### 6.3 Log volume (stdout, INFO, measured)

Measured via `docker logs` byte deltas around dedicated 30–60 s bursts:

| Traffic | Log bytes / request |
|---|---:|
| discovery | ≈0.49 KB |
| client_credentials | ≈1.14 KB |
| CIBA | ≈1.17 KB |
| password_grant (login) | ≈1.81 KB |

Rule of thumb: `log bytes/day ≈ rps × bytes-per-request × 86,400`. Example: **100
logins/s ≈ 15.7 GB/day** at INFO *(arithmetic projection from the measured
per-request rate)*. For high-volume deployments run the app at WARN and/or ship
JSON logs to a collector with rotation. Keycloak writes little per-request output
in this setup, so this line item is primarily an Issuerd sizing consideration — the
trade-off for always-on request and audit detail.

### 6.4 Image + runtime disk budget

| Component | Disk |
|---|---:|
| Issuerd image (distroless) | 34.6 MiB compressed pull size |
| Database, 100k users, steady state | ~0.1 GiB |
| Database churn | ≈731 B × retained logins (until sessions/events expire) |
| Logs at INFO | ≈0.5–1.8 KB × requests (until rotated) |

## 7. Scale test: 100,000+ users

Seeded 100,000 users through the public Admin API (which also measures bulk
provisioning): **161.3 users/s sustained for about 10.3 minutes**, each with an
Argon2id password. The run had 10.03% idempotent 409-skips by design and zero
scenario errors. Together with users created by earlier scenarios, the final database
contained **113,327 users**. Against that database:

- A 120 s, 40-VU `password_grant` scale run completed **152.47 logins/s**, p99
  337.9 ms, with zero errors. A separate 60 s, 20-VU log-sizing burst completed
  **155.08 logins/s**, p99 174.4 ms, also with zero errors.
- A 90 s, 15-VU `auth_code_flow` run completed **120.28 full logins/s**
  (360.83 requests/s), p99 109.7 ms, with zero errors.
- The medium-tier headline rows for `discovery`, `client_credentials`, `ciba`,
  `password_grant`, and `auth_code_flow` were measured against this 113,327-user
  database (the Keycloak rows against its 1,000-user import — the 100k seeding
  ladder is Issuerd-only because it doubles as the provisioning-rate measurement).

## 8. Sizing guide (from the measurements above)

| Deployment | App container | PostgreSQL | Sustains (measured at that tier) |
|---|---|---|---|
| dev / edge | 1 CPU / 512 MiB | 1–2 CPU / 1 GiB | 94 logins/s · 2.49k cc/s · 16.7k userinfo/s · 344 CIBA cycles/s |
| standard | 2 CPU / 1 GiB | 2 CPU / 2 GiB | 155 logins/s · 2.78k cc/s · 28.5k userinfo/s · 347 CIBA cycles/s |
| high-volume | 4 CPU / 2 GiB | ≥4 CPU for write-heavy deployments | 264 logins/s · 2.73k cc/s · 52.0k userinfo/s · 341 CIBA cycles/s |

RAM headroom is comfortable at these tiers: the medium-tier app peaked at 288.7 MiB
against a 1 GiB limit, and the large-tier app peaked at 386.3 MiB against 2 GiB.
Disk: §6.4. Multi-node horizontal scaling (shared PostgreSQL + Redis, signing keys
in storage) is covered in [CLUSTERING.md](/clustering/); single-host k6 results do
not by themselves prove linear multi-node scaling.

---

## Appendix: in-process micro-benchmarks

The numbers above are end-to-end (k6 → Docker → Issuerd → PostgreSQL). The repo also
ships in-process benchmarks (in-process Axum harness, single core, no Docker) used for
regression gating:

> ```bash
> cargo test --test integration -- --ignored --nocapture
> ```

| Metric | Target | Notes |
|--------|--------|-------|
| Token issuance (password grant) | < 2 ms p99 | EdDSA signing + storage write |
| Token validation (stateless JWT) | < 0.5 ms p99 | JWKS lookup + signature verify |
| Auth code flow (password) | < 50 ms p99 | Full redirect + login + code exchange |
| Throughput (token validation) | > 1000 req/s per core | UserInfo endpoint |
| Throughput (token issuance) | > 500 req/s per core | Password grant |

Benchmarks are marked `#[ignore = "benchmark"]` so they do not run in normal CI.
Results are printed to stdout and should be captured by the CI runner for trend analysis.
