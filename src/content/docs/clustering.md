---
title: "Clustering — Multi-Node Issuerd"
description: "Issuerd scales horizontally: run N identical nodes behind a load balancer with no sticky sessions. Any request can be served by any node."
---

Issuerd scales horizontally: run N identical nodes behind a load balancer with
**no sticky sessions**. Any request can be served by any node.

```
                      ┌─────────────────┐
                      │  Load balancer  │
                      └────────┬────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        ┌──────────┐    ┌──────────┐      ┌──────────┐
        │ node 1   │    │ node 2   │ ...  │ node N   │
        └────┬─────┘    └────┬─────┘      └────┬─────┘
             │               │                 │
             └───────┬───────┴───────┬─────────┘
                     ▼               ▼
              ┌────────────┐  ┌────────────┐
              │ PostgreSQL │  │   Redis    │
              └────────────┘  └────────────┘
```

## State model

| State | Where | Shared? |
|---|---|---|
| Realms, users, clients, sessions, **signing keys** | PostgreSQL | Yes (durable) |
| Auth codes, pending auth, device/CIBA state, revocation blocklist, login-failure counters | Redis | Yes (ephemeral) |
| Access/ID/refresh tokens | Nowhere — self-contained JWTs | Validated statelessly by every node against the shared JWKS |
| Metrics (`/metrics`) | Per node | No — scrape each node (or the LB if you only need a sample) |

### Signing keys

The critical cluster invariant: every node must sign with the same active key
(per algorithm) and validate tokens from its peers. Signing keys
live in the `signing_keys` table in PostgreSQL:

- At boot a node loads the full key set. On first boot (empty table) it
  generates the initial pair — an EdDSA key (the signing default) and an
  active RS256 key (OIDC Core §15.1 mandatory-to-implement, advertised in
  discovery) — and persists them. A concurrent first boot may persist a
  second pair — benign: all are published in JWKS and validate; all nodes
  sign with the newest active key of the resolved algorithm.
- Keys survive restarts, so outstanding tokens stay valid across deploys.
- Each node polls the table every `cluster.jwks_refresh_interval_secs` and
  reloads its keystore + JWKS snapshot when the set changes — keys added by a
  peer propagate without a restart.
- The table may hold one active key **per algorithm** (key
  rotation demotes only same-algorithm actives). A realm's
  `default_signature_algorithm` attribute selects which active key signs its
  tokens; all nodes resolve the same key from the shared set.

#### Encrypting the keys at rest

With `[crypto.key_encryption]` configured (see
[configuration.md](/configuration/#cryptokey_encryption)) the table holds
AES-256-GCM ciphertext instead of plaintext DER. Cluster rules:

- **Every node must carry the identical section** (same active `key_id` /
  `key_base64` and the same `previous_keys`): nodes decrypt the shared rows
  with it, and any node may be the one to write a rotated key. A node booted
  with the wrong KEK fails closed at startup.
- **Enable only after every node runs a version that supports it.** Rows
  written by a KEK-enabled binary have `private_der = NULL`, which an older
  binary cannot read — during a rolling upgrade, keep the section off until
  the last node is on the new version.
- Each boot runs a **re-encryption sweep** (after migrations, before the
  keystore loads) that rewrites any plaintext rows or rows encrypted under a
  previous KEK under the active KEK — that is what makes first-time enablement
  and KEK rotation converge across the cluster.

### Login-failure counters

Brute-force lockout counters use an atomic `increment` (Redis `INCR`), so
failures aggregate correctly even when consecutive attempts land on different
nodes.

## Quickstart (Docker Compose)

```bash
# Build the image and start: postgres + redis + 2 nodes + nginx LB
docker compose -f docker-compose.cluster.yml up -d --build

# Wait for health, then:
curl http://localhost:8088/realms/demo/.well-known/openid-configuration

# Run the E2E suite against the stack
ISSUERD_CLUSTER_E2E=1 cargo test --test integration cluster_e2e

# Tear down (drops the database volume)
docker compose -f docker-compose.cluster.yml down -v
```

The stack (`docker-compose.cluster.yml`, its own `issuerd-cluster` project):

- `postgres`, `redis` — internal only (no host ports)
- `issuerd-1`, `issuerd-2` — node ports `18081`/`18082` exposed for
  debugging/tests; per-node identity via `ISSUERD_CLUSTER__NODE_ID`
- `lb` (nginx) — the only client-facing endpoint: `http://localhost:8088`

Provisioned content (`cluster/provision.yaml`): realm `demo` with
`demo`/`demo123` and `lockme`/`lockme123`, public client `demo-app`,
confidential client `demo-service`/`demo-service-secret`; realm `master` with
`admin`/`admin` (admin API + admin SPA at `http://localhost:8088/admin`).

## Configuration reference

```toml
# Must be the public LB URL, identical on every node — it is baked into `iss`.
issuer_url = "http://localhost:8088"
redis = "redis://redis:6379"          # single Redis

[storage.postgres]
url = "postgres://user:pass@postgres:5432/issuerd"

[proxy]
trusted_proxies = ["172.32.0.0/24"]   # the LB's subnet — required so login
                                      # failure keys use the real client IP

[cluster]
enabled = true                        # enforce the multi-node contract at boot
node_id = "node-1"                    # optional; defaults to $HOSTNAME
redis_nodes = []                      # Redis Cluster URLs; overrides `redis`
jwks_refresh_interval_secs = 30       # default; the demo stack (cluster/issuerd.toml) overrides it to 15
```

`cluster.enabled = true` makes boot **fail** unless both PostgreSQL storage and
a Redis cache are configured — this catches split-brain configs where nodes
would diverge (e.g. an auth code issued on node A not redeemable on node B).

All settings are also available as env vars (`ISSUERD_CLUSTER__ENABLED`,
`ISSUERD_CLUSTER__NODE_ID`, ...), except `redis_nodes` which is a list (use
TOML).

> **Rolling-upgrade caveat (name-based issuers):** issuer URLs embed the realm
> **name** (`{issuer_url}/realms/{name}`). Upgrading from a build that embedded
> the realm **id** invalidates all outstanding tokens and session cookies
> (id-spelled issuers are rejected), so users must re-authenticate. Perform a
> full restart of all nodes rather than a rolling upgrade for that transition.

## Load balancer requirements

- **No sticky sessions** — round-robin / least-conn are both fine.
- Set `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto`, `Host`; list the LB
  subnet in `[proxy].trusted_proxies`.
- Health-check `/health/ready`: it probes both PostgreSQL and Redis, so a node
  that lost either dependency is drained automatically.
- nginx caveat: upstream hostnames are resolved once at startup. If a node
  container is recreated with a new IP, reload nginx
  (`docker compose -f docker-compose.cluster.yml restart lb`).

## Scaling beyond two nodes

Add more node services (copy `issuerd-2`, bump the node id and host port) and
add them to the `upstream` block in `cluster/nginx.conf`. Alternatively use
`docker compose -f docker-compose.cluster.yml up -d --scale issuerd-N=...` on
a single templated service — but then you must either rely on Docker DNS
round-robin (with an nginx `resolver` re-resolve) or generate the upstream
list; the static two-node setup is the documented, deterministic default.

## Operational notes & limitations

- **Restarts no longer invalidate tokens**: the boot path persists the generated
  signing key into whatever storage backend is configured, and the JSON-file
  snapshot includes `signing_keys` (loaded again at boot), so both PostgreSQL
  and JSON-file deployments keep keys across restarts. Only pure in-memory mode
  regenerates keys per boot (a single-node mode).
- **Redis is ephemeral** by design: wiping it loses in-flight login flows
  (users retry) and the revocation blocklist entries for tokens that would
  expire anyway; sessions and issued JWTs are unaffected.
- **Redis Cluster mode** (`cluster.redis_nodes`): the cache works (GET/SET/
  GETDEL/CAS/INCR), but Redis pub/sub is not implemented in cluster mode — the
  cluster event bus is unavailable there. Key propagation uses storage polling,
  so this does not affect clustering correctness.
- The `single_instance` guard in the CLI prevents two daemons **on the same
  host** from running with the same lock name; it does not interfere with
  containers.
- **Key rotation**: `POST /admin/realms/{realm}/keys/rotate` and
  `PUT /admin/realms/{realm}/keys/{kid}/disable` rotate/disable keys in the
  shared `signing_keys` table. The administering node reloads its keystore
  immediately; peers pick up the change on their next storage poll.
- Metrics are per-node; aggregate in Prometheus by scraping all nodes.
