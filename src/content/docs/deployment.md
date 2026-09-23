---
title: "Deployment"
description: "This guide covers running Issuerd in production: choosing a topology, deploying with containers or as a bare-metal systemd service, TLS, reverse-proxy requirements, Kubernetes probes, and a…"
---

This guide covers running Issuerd in production: choosing a topology, deploying with containers or as a bare-metal systemd service, TLS, reverse-proxy requirements, Kubernetes probes, and a go-live checklist. It is written for system operators and administrators. For the full configuration key reference see [configuration.md](/configuration/); for first-time local setup see [getting-started.md](/getting-started/); for running more than one node see [CLUSTERING.md](/clustering/).

## Contents

- [Deployment topologies](#deployment-topologies)
- [Container deployment](#container-deployment)
- [Bare-metal / VM deployment](#bare-metal--vm-deployment)
- [TLS](#tls)
- [Reverse proxy requirements](#reverse-proxy-requirements)
- [Kubernetes notes](#kubernetes-notes)
- [Production checklist](#production-checklist)

## Deployment topologies

Issuerd is a single `issuerd` binary whose state model decides the topology. Durable state (realms, users, clients, sessions, signing keys) lives in the storage backend; transient coordination state (authorization codes, pending login flows, single-use tokens, the revocation blocklist, login-failure counters) lives in the cache. Tokens themselves are self-contained JWTs stored nowhere.

### Development / evaluation (single node, no dependencies)

With no `[storage]` section the daemon uses the in-memory backend; `[storage.json_file]` persists the full state to a JSON snapshot. Both are single-node modes for development, evaluation, and demos — never production. They are covered in [getting-started.md](/getting-started/) and the [configuration.md](/configuration/) storage reference; the rest of this guide assumes PostgreSQL + Redis.

### Single-node production (PostgreSQL + Redis)

The baseline production topology is one Issuerd node with:

- **PostgreSQL** for all durable state (`[storage.postgres]`). Signing keys live in the shared `signing_keys` table, so tokens and sessions survive restarts and redeploys. Schema migrations run automatically at boot.
- **Redis** for transient state (`redis = "redis://…"`). Redis is ephemeral by design: wiping it loses in-flight login flows (users retry) and blocklist entries for tokens that would expire anyway; issued JWTs and sessions are unaffected. The demo and cluster compose stacks run it with `--maxmemory 256mb --maxmemory-policy allkeys-lru` and no persistence; the integration stack enables `--appendonly yes` with a volume.

> **Warning:** With PostgreSQL storage the automatic master-realm bootstrap does **not** run. A fresh deployment must define the `master` realm in a provision file (as `examples/provision.demo.yaml` does) or apply one with `issuerd provision --file …` — otherwise there is no admin user. See [provisioning.md](/provisioning/).

### Multi-node behind a load balancer

When you need horizontal scalability or rolling deploys, run N identical nodes behind a load balancer — any request can be served by any node, **no sticky sessions required**. This mode requires PostgreSQL and Redis shared by all nodes, an identical `issuer_url` (the LB's public URL) on every node, and `cluster.enabled = true`, which makes boot fail unless both dependencies are configured. Signing keys are shared through the `signing_keys` table and propagate between nodes via storage polling.

The full multi-node guide — state model, configuration, LB contract, scaling — is [CLUSTERING.md](/clustering/). The reverse-proxy rules below also apply.

## Container deployment

### Building the image

The root `Dockerfile` is the canonical production image. It is a multi-stage build:

1. **Builder** — compiles the embedded web client (`npm ci && npm run generate-api && npm run build` in `webclientsrc/`, regenerated from the committed `openapi.json`) and then the release binary (`cargo auditable build --bin issuerd --release --locked`). The web client is embedded into the binary at compile time (`include_dir!`), so the runtime image contains only the binary plus its shared libraries. The `cargo auditable` wrapper embeds the Cargo dependency tree so image-only SBOM scans (syft) can see the Rust crates.
2. **Runtime** — a Google **distroless** userland (`gcr.io/distroless/cc-debian13:nonroot`: glibc + OpenSSL 3 + CA certs — no shell, no package manager, non-root uid 65532 by default). The Kerberos GSS-API libraries the binary links for LDAP federation are copied from the builder stage; libpq is not needed (sqlx is a pure-Rust PostgreSQL driver). `EXPOSE 8080`; the entrypoint is `issuerd` with default arguments `daemon -c /etc/issuerd/issuerd.toml`. Container healthchecks should use the binary itself (`issuerd healthcheck --url ...`), since the image ships no curl/wget.

```bash
docker build -t issuerd:local .

# Base images are overridable (useful where Docker Hub is restricted):
docker build --build-arg BUILDER_IMAGE=mcr.microsoft.com/playwright:v1.59.1-jammy \
             --build-arg RUNTIME_IMAGE=gcr.io/distroless/cc-debian13:nonroot \
             -t issuerd:local .
```

Running the image directly requires a configuration file mounted at `/etc/issuerd/issuerd.toml` (or override the default command arguments):

```bash
docker run --rm -p 8080:8080 \
  -v "$PWD/my-issuerd.toml:/etc/issuerd/issuerd.toml:ro" \
  issuerd:local
```

### The demo stack (`docker-compose.yml`)

The root compose file (project name `issuerd-demo`) is the quickest way to see a production-shaped deployment: one Issuerd node backed by PostgreSQL and Redis, built from the repository.

```bash
docker compose up --build      # first build compiles the release binary + web client
docker compose down            # stop; the postgres-data volume keeps all state
docker compose down -v         # stop AND wipe the volume (next start re-seeds)
```

| Service | Container | Role | Exposure |
|---|---|---|---|
| `issuerd` | `issuerd-demo-server` | Server built from the root `Dockerfile`; healthcheck polls `/ready`; starts only after PostgreSQL and Redis are healthy | `http://localhost:8080` |
| `postgres` | `issuerd-demo-postgres` | PostgreSQL 15 Alpine, state in the `postgres-data` volume | internal only (no host port) |
| `redis` | `issuerd-demo-redis` | Redis 7 Alpine, `--maxmemory 256mb --maxmemory-policy allkeys-lru`, no persistence | internal only (no host port) |

The server container mounts `examples/issuerd.demo.toml` → `/etc/issuerd/issuerd.toml` and `examples/provision.demo.yaml` → `/etc/issuerd/provision.yaml`. On first start against an empty database the provision file runs exactly once and seeds the `master` realm (`admin`/`admin`), the `myrealm` demo realm (`alice`/`changeme`, groups `developers`/`ops`), the console clients (`admin-cli`, `account-console`), and the sample clients `my-app` (confidential, secret `my-app-secret`) and `public-app` (public, PKCE).

- Admin console: <http://localhost:8080/admin/console> (`admin`/`admin`)
- Account console: <http://localhost:8080/realms/myrealm/account> (`alice`/`changeme`)
- Discovery: <http://localhost:8080/realms/myrealm/.well-known/openid-configuration>

The seeded content and first-login flow are walked through in [getting-started.md](/getting-started/).

> **Warning:** The demo stack serves plain HTTP with well-known credentials checked into the repository. It is an evaluation rig, not a production starting point — see the [Production checklist](#production-checklist).

### Configuring containers with environment variables

Every configuration key can be overridden with an `ISSUERD_`-prefixed environment variable; `__` (double underscore) is the nesting separator (see [configuration.md](/configuration/)). This is how the shipped stacks inject per-container values without editing the mounted TOML:

```yaml
services:
  issuerd:
    image: issuerd:local
    volumes:
      - ./issuerd.toml:/etc/issuerd/issuerd.toml:ro
    environment:
      ISSUERD_ISSUER_URL: "https://id.example.com"
      ISSUERD_REDIS: "redis://redis:6379"
      ISSUERD_CLUSTER__ENABLED: "true"        # cluster.enabled
      ISSUERD_CLUSTER__NODE_ID: "node-1"      # cluster.node_id
      ISSUERD_SMTP__PASSWORD: "${SMTP_PASSWORD}"
```

List-valued keys (`cors.allowed_origins`, `proxy.trusted_proxies`, `cluster.redis_nodes`) cannot be expressed reliably as a single environment variable — keep them in the config file. The cluster demo uses exactly this split: one shared `cluster/issuerd.toml` mounted into both nodes, with per-node identity injected as `ISSUERD_CLUSTER__NODE_ID` (`docker-compose.cluster.yml`).

### The other compose stacks

- **`docker-compose.cluster.yml`** (project `issuerd-cluster`) — two Issuerd nodes behind an nginx load balancer on `http://localhost:8088`, sharing PostgreSQL + Redis, with per-node ports `18081`/`18082` exposed for debugging. This is the reference for the multi-node contract; see [CLUSTERING.md](/clustering/).
- **`docker-compose.integration.yml`** — contributor test infrastructure, not a deployment model: a reference Keycloak 24 (host port 8081) for protocol comparison, Samba AD DC and OpenLDAP for federation testing, Bind9 DNS, and a dedicated PostgreSQL (host port 5433). Not intended for production use.

## Bare-metal / VM deployment

### Building the release binary

Prerequisites: Rust 1.95+ toolchain and Node.js 20+ (for the embedded consoles). From the repository root:

```bash
# 1. Build the web client first — release builds FAIL if webclientsrc/dist is
#    missing or empty (crates/issuerd-server/build.rs).
cd webclientsrc && npm ci && npm run generate-api && npm run build && cd ..

# 2. Build the binary.
cargo build --bin issuerd --release --locked
# → target/release/issuerd  (single self-contained binary, consoles embedded)
```

### Filesystem layout

A suggested layout for a systemd-managed install:

| Path | Contents |
|---|---|
| `/usr/local/bin/issuerd` | The release binary |
| `/etc/issuerd/issuerd.toml` | Server configuration |
| `/etc/issuerd/provision.yaml` | Optional provision file (applied once at first boot) |
| `/etc/issuerd/issuerd.env` | Secrets/environment overrides (`root:issuerd`, mode `0640`) |
| `/etc/issuerd/certs/` | PEM certificate/key, only when using direct [`[tls]`](#tls) |
| `/var/lib/issuerd/` | Working directory: JSON-file storage (if used), any writable state |
| `/var/lib/issuerd/themes/` | Login-theme assets, if you use them |

Notes on relative paths: the config file path (`-c`), `tls.cert_path`/`key_path`, `themes.dir`, and `storage.json_file.path` all resolve against the daemon's **working directory**. The systemd unit below pins `WorkingDirectory=/var/lib/issuerd` and uses absolute paths everywhere else. Login-theme assets are read **from disk on every request** (`crates/issuerd-server/src/routes/theme.rs`) — copy the repository's `themes/` directory into the layout (and point `[themes] dir` at it) if you rely on the default login CSS or custom themes.

### systemd unit

```ini
# /etc/systemd/system/issuerd.service
[Unit]
Description=Issuerd Identity and Access Management
Documentation=https://github.com/issuerd/issuerd
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=issuerd
Group=issuerd
WorkingDirectory=/var/lib/issuerd
ExecStart=/usr/local/bin/issuerd daemon -c /etc/issuerd/issuerd.toml
# Secrets and runtime tuning; the file is optional ("-" prefix).
EnvironmentFile=-/etc/issuerd/issuerd.env

Restart=on-failure
RestartSec=5
# SIGTERM triggers graceful shutdown; with direct [tls] the connection drain
# is capped at 30 seconds, so allow some margin.
TimeoutStopSec=40
LimitNOFILE=65536

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/issuerd
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
# AF_UNIX is required: the single-instance guard binds an abstract Unix
# domain socket on Linux ("issuerd-instance").
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now issuerd
systemctl status issuerd
```

Operational notes:

- **`Type=simple` is deliberate.** The daemon emits only `Status` and `Stopping` sd_notify states (`crates/issuerd-server/src/bootstrap.rs`) — no `READY` notification — so `Type=notify` would hang the start.
- **Logs go to journald automatically.** On Linux under systemd (detected via `JOURNAL_STREAM`) the daemon logs through the journald layer instead of console formatting (`src/logging.rs`). Follow them with `journalctl -u issuerd -f`.
- Set verbosity in the environment file instead of editing the unit. `RUST_LOG` takes precedence over everything (standard `tracing` filter syntax):
  ```ini
  # /etc/issuerd/issuerd.env
  RUST_LOG=issuerd_server=info,issuerd_storage=warn
  ISSUERD_SMTP__PASSWORD=change-me
  ```
- **One daemon per host:** a second `issuerd daemon` process exits immediately with `Another Issuerd instance is already running` (OS-level guard held for the process lifetime). This does not interfere with containers; multi-node deployments run one daemon per host/pod anyway.

## TLS

Two supported ways to serve HTTPS; pick one.

**Direct TLS in the binary.** The `[tls]` section makes the daemon itself serve HTTPS via rustls (TLS 1.2 and 1.3 only):

```toml
[tls]
cert_path = "/etc/issuerd/certs/id.example.com.crt"   # PEM certificate chain
key_path  = "/etc/issuerd/certs/id.example.com.key"   # PEM private key
```

Both files are read at startup; unreadable or unparsable PEM fails the boot. There is no hot reload — restart the daemon to pick up renewed certificates.

**TLS termination at a reverse proxy / load balancer** (the more common production shape): the proxy owns the certificates and Issuerd serves plain HTTP behind it — this is exactly what `examples/issuerd.demo.toml` assumes ("Put a TLS-terminating proxy in front for anything beyond local evaluation"). If you terminate TLS upstream:

- `issuer_url` **must still use the public `https:` scheme** — it is baked into every token's `iss` claim and the discovery document, and clients validate it strictly. Plain-HTTP issuer URLs only work while everything stays on `localhost`.
- Configure [`[proxy]`](#reverse-proxy-requirements) so the daemon sees real client IPs.
- The realm `ssl_required` setting (`none` / `external` / `all`, default `external`, per realm) records the HTTPS expectation for the realm and is surfaced through the Admin API/enums — keep it consistent with the actual TLS topology.

Do not expose plain HTTP to untrusted networks. The demo and example configs are HTTP-only because they target `localhost` evaluation.

## Reverse proxy requirements

When Issuerd sits behind a proxy or LB, four things must line up:

1. **Forwarded headers.** The proxy must set `Host`, `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto` (this is the exact set the shipped cluster LB uses).
2. **Trust configuration.** The daemon honors forwarded headers **only** when the direct peer matches `[proxy] trusted_proxies` (IPs or CIDRs) and the corresponding trust flag is on:
   ```toml
   [proxy]
   trusted_proxies       = ["10.0.0.0/8"]   # your LB / ingress subnet
   trust_x_forwarded_for = true             # default
   trust_x_real_ip       = true             # default
   ```
   Within `X-Forwarded-For` the rightmost entry that is not itself a trusted proxy wins. With the default empty `trusted_proxies`, forwarded headers are ignored and the direct peer address is used — safe when there is no proxy, wrong when there is one.

   > **Warning:** This setting directly affects brute-force protection, which keys login-failure counters by client IP. Empty `trusted_proxies` behind an LB funnels every user into one bucket; trusting headers from untrusted peers lets attackers spoof their IP around lockout. See [security.md](/security/).
3. **Correct `issuer_url`** — the proxy's public URL (scheme included), not the node's internal address (see [TLS](#tls) and [configuration.md](/configuration/)).
4. **Health checks target `/ready`** (alias: `/health/ready`), not `/health`. `/health` is a static `{"status":"ok"}` liveness probe; `/ready` actually probes storage and the cache and returns `503 {"status":"not_ready","dependency":"storage"|"cache"}` when a dependency is down — a node that lost PostgreSQL or Redis is drained automatically.

A complete nginx server block, aligned with the shipped `cluster/nginx.conf`:

```nginx
# Passive health checks only (nginx OSS): a peer that errors or times out
# 3 times within 10s is skipped for 10s.
upstream issuerd_nodes {
    least_conn;
    server issuerd-1:8080 max_fails=3 fail_timeout=10s;
    server issuerd-2:8080 max_fails=3 fail_timeout=10s;
}

server {
    listen 443 ssl;
    server_name id.example.com;

    ssl_certificate     /etc/nginx/certs/id.example.com.crt;
    ssl_certificate_key /etc/nginx/certs/id.example.com.key;

    location / {
        proxy_pass http://issuerd_nodes;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        # Retry idempotent-safe failures on the peer that is still up.
        proxy_next_upstream error timeout http_502 http_503;
    }
}
```

One nginx caveat from the field: upstream hostnames are resolved **once at startup**. If a backend container is recreated with a new IP, reload nginx (the cluster stack documents `docker compose -f docker-compose.cluster.yml restart lb`).

## Kubernetes notes

Kubernetes deployment is the container image plus the multi-node contract; there is no operator or Helm chart in this repository. The operational mapping:

- **Probes** (`crates/issuerd-server/src/routes/system.rs`):
  - `livenessProbe` → `GET /health` — static `200 {"status":"ok"}`; fails only when the process is truly stuck.
  - `readinessProbe` → `GET /ready` — probes storage **and** cache; a pod that lost PostgreSQL or Redis returns 503 and drops out of the Service endpoints.
- **Configuration:** mount `issuerd.toml` (and optionally `provision.yaml`) from a ConfigMap at `/etc/issuerd/issuerd.toml` — the image's default command already points there — and use `ISSUERD_*` environment variables for per-environment values and secrets (see [Configuring containers with environment variables](#configuring-containers-with-environment-variables)). List-valued keys stay in the ConfigMap file.
- **Multiple replicas:** set `cluster.enabled = true` (boot then requires PostgreSQL + Redis) and point `issuer_url` at the public ingress URL, identical in every pod. `cluster.node_id` defaults to `$HOSTNAME`, which is the pod name — no per-pod config needed. No sticky sessions: any pod can serve any request because all shared state is in PostgreSQL/Redis.
- **Provisioning at scale:** a provision file referenced by `provision = …` is applied exactly once — the marker claim in storage is atomic, so parallel first boots of several replicas are safe (the cluster demo relies on this).
- **Shutdown:** pods receive SIGTERM and the daemon drains in-flight requests gracefully (a 30-second cap applies when built-in `[tls]` is enabled). Size `terminationGracePeriodSeconds` accordingly.
- **Metrics** are per-pod — scrape every pod's `/metrics` (see [monitoring.md](/monitoring/)).

## Production checklist

- [ ] **`issuer_url` is the public base URL** clients use (e.g. `https://id.example.com`), with the correct scheme/host/port. It is baked into `iss` and discovery; treat it as permanent once realms are in use — changing it later invalidates outstanding tokens, sessions, and stored client configs.
- [ ] **PostgreSQL storage configured** (`[storage.postgres]`) — durable realms/users/sessions/signing keys; migrations run at boot. **Redis configured** for transient state.
- [ ] **`cluster.enabled = true`** whenever more than one node serves the same issuer — boot then fails fast on a split-brain configuration. See [CLUSTERING.md](/clustering/).
- [ ] **TLS end-to-end** — direct `[tls]` or a TLS-terminating proxy with `https:` `issuer_url` and `[proxy].trusted_proxies` listing exactly the proxy subnets.
- [ ] **`master` realm exists** — provision file applied on the fresh PostgreSQL database (no automatic bootstrap on that backend), and **`admin`/`admin` or any seeded default credentials are rotated or deleted**. Demo content (`alice`/`changeme`, `my-app-secret`) removed.
- [ ] **CORS allowlist minimal** — `[cors].allowed_origins` lists only the origins your own browser apps actually use; empty is the secure default.
- [ ] **SMTP configured and tested** before enabling email verification, password reset, or email-code login — with `[smtp] enabled = false` those flows fail loudly for users. See [configuration.md](/configuration/).
- [ ] **Brute-force protection and password policy reviewed** per realm — see [security.md](/security/).
- [ ] **Realm `ssl_required` reviewed** (`none` / `external` / `all`; default `external`) to match the TLS topology.
- [ ] **Metrics scraped** — Prometheus pulls `/metrics` from every node; health probes wired to `/health` + `/ready`. See [monitoring.md](/monitoring/).
- [ ] **Events retention reviewed** per realm: `events_expiration_secs` hides events older than the window from query results (it does not delete rows); actual cleanup is the Admin API wipe endpoints (`DELETE /admin/realms/{realm}/events`, `…/admin-events`) — see [monitoring.md](/monitoring/).
- [ ] **Backups scheduled** for the PostgreSQL database (the only durable state) — see [backup-and-upgrade.md](/backup-and-upgrade/).
