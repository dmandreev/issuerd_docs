---
title: "Getting started: installation and first login"
description: "From a fresh checkout to a verified access token in about five minutes. This guide walks a system operator through the two supported ways to run Issuerd locally — the Docker demo stack (one…"
---

From a fresh checkout to a verified access token in about five minutes. This guide walks a system operator through the two supported ways to run Issuerd locally — the Docker demo stack (one command, zero prerequisites beyond Docker) and a build from source — explains what happens on first boot, verifies the installation end to end, and finishes with the minimum hardening steps before going further. Production topology, TLS, and externalized configuration are covered in [deployment](/deployment/) and [security](/security/); this guide is deliberately local and hands-on.

## Contents

- [What you will have at the end](#what-you-will-have-at-the-end)
- [Prerequisites](#prerequisites)
- [Installation option A — the Docker demo stack](#installation-option-a--the-docker-demo-stack)
- [Installation option B — build from source](#installation-option-b--build-from-source)
- [The CLI at a glance](#the-cli-at-a-glance)
- [First boot explained](#first-boot-explained)
- [Verifying the installation](#verifying-the-installation)
- [Getting your first access token](#getting-your-first-access-token)
- [First hardening steps](#first-hardening-steps)
- [Where to go next](#where-to-go-next)

## What you will have at the end

Whichever installation option you pick, you end up with:

- A running Issuerd server on `http://localhost:8080` with health, readiness, metrics, and OIDC discovery endpoints.
- The `master` realm with an administrator account (`admin` / `admin`) and the embedded **admin console** at `http://localhost:8080/admin/console`.
- A demo realm **`myrealm`** with a user `alice` / `changeme`, the sample clients `my-app` (confidential) and `public-app` (public), and the **account console** at `http://localhost:8080/realms/myrealm/account`.
- A verified access token for `alice`, obtained directly from the token endpoint with `curl`.

Everything in this guide is seeded demo content with well-known credentials — fine for evaluation, not for anything reachable by others (see [First hardening steps](#first-hardening-steps)).

## Prerequisites

| Installation option | Requirements |
|---|---|
| A — Docker demo stack | Docker with the Compose plugin (`docker compose`). Nothing else — the image build compiles the server and the web client inside Docker. |
| B — Build from source | Rust toolchain **1.95+** (the workspace MSRV). Node.js **20+** is additionally required if you want the embedded browser consoles (admin console, account console, login pages). |

No database is needed for a first run: option B uses the in-memory storage backend by default, and option A brings its own PostgreSQL and Redis containers.

## Installation option A — the Docker demo stack

The root `docker-compose.yml` is the self-contained local demo stack (compose project name `issuerd-demo`). From the repository root:

```bash
docker compose up --build
```

The first build compiles the release binary and the embedded web client inside the container (see the multi-stage root `Dockerfile`), so expect it to take a while; subsequent starts reuse the image and come up in seconds.

The stack starts three services:

| Service | Container | Role | Exposure |
|---|---|---|---|
| `issuerd` | `issuerd-demo-server` | Issuerd server, built from the repository | `http://localhost:8080` |
| `postgres` | `issuerd-demo-postgres` | PostgreSQL 15 (persistent state) | internal only, no host port |
| `redis` | `issuerd-demo-redis` | Redis 7 (transient state: auth codes, pending flows, single-use tokens, login-failure counters) | internal only, no host port |

The server container reads `/etc/issuerd/issuerd.toml` (mounted from `examples/issuerd.demo.toml`) and `/etc/issuerd/provision.yaml` (mounted from `examples/provision.demo.yaml`). Its healthcheck polls `/ready`, and it only starts after PostgreSQL and Redis report healthy.

### What gets seeded

On the very first start (empty database), `examples/provision.demo.yaml` is applied exactly once and creates:

| Entity | Details |
|---|---|
| Realm `master` | User `admin` / `admin` holding the realm-management roles (`manage-realm`, `manage-users`, `manage-clients`, `impersonation`, …) — full access to the admin console and Admin API |
| Realm `myrealm` | Demo realm; registration, reset-password, and remember-me enabled |
| User `alice` / `changeme` | In `myrealm`, member of group `developers`, realm roles `admin` + `user` |
| Groups | `developers` and `ops` in `myrealm` |
| Client `admin-cli` | Public client in `master` used by the admin console SPA |
| Client `account-console` | Public client in `master` and `myrealm` used by the account console SPA |
| Client `my-app` | **Confidential** client in `myrealm`, secret **`my-app-secret`**, redirect URIs `http://localhost:3000/callback` and `http://localhost:3000/login` |
| Client `public-app` | **Public** client in `myrealm` (PKCE), redirect URI `http://localhost:4000/callback` |

Then open:

- **Admin console:** <http://localhost:8080/admin/console> — sign in as `admin` / `admin`
- **Account console:** <http://localhost:8080/realms/myrealm/account> — sign in as `alice` / `changeme`
- **Discovery document:** <http://localhost:8080/realms/myrealm/.well-known/openid-configuration>

### Stopping and wiping

```bash
docker compose down        # stop the stack; the postgres-data volume keeps all state
docker compose down -v     # stop AND delete the volume — next start re-seeds from scratch
```

Provisioning runs exactly once per database (see [First boot explained](#first-boot-explained)), so changes you make through the admin console survive `docker compose down`/`up` but are discarded by `down -v`.

> **Warning:** The demo stack serves plain HTTP on `localhost` with well-known demo credentials. It is meant for local evaluation only — put a TLS-terminating proxy in front and re-provision before exposing it to anyone else.

## Installation option B — build from source

Prerequisites from the table above. From the repository root:

```bash
# 1. Build the embedded web client (admin console, account console, login pages)
#    `generate-api` is required on a fresh clone: the TypeScript SDK under
#    webclientsrc/generated is gitignored and regenerated from the committed
#    openapi.json (the root Dockerfile runs the same three commands).
cd webclientsrc && npm ci && npm run generate-api && npm run build && cd ..

# 2. Run the server (debug build, in-memory storage, no external dependencies)
cargo run --bin issuerd -- daemon
```

The server listens on `http://localhost:8080` and seeds the `master` realm (admin/admin) plus the `myrealm` demo content (alice/changeme, sample clients). For a production-style artifact, `cargo build --bin issuerd --release` produces the standalone binary at `target/release/issuerd`.

The checked-in root `issuerd.toml` is a zero-dependency development rig:

```toml
bind = "127.0.0.1"
port = 8080
issuer_url = "http://localhost:8080"
provision = "examples/provision.example.yaml"   # adds myrealm, alice, sample clients
# no [storage] section  → in-memory backend (state is lost on restart)
# no [tls] section      → plain HTTP
```

The full annotated reference for every key is `examples/issuerd.example.toml` (regenerate it with `issuerd example server-config`); the configuration model is documented in [configuration.md](/configuration/).

Two operational details of the web client build (`crates/issuerd-server/build.rs`):

- **Skip step 1 and the server still works** as a pure OIDC/OAuth2 + Admin REST API server; the browser consoles and login pages are simply not embedded, and console URLs answer `404 Web UI not embedded. Build webclientsrc first.` A `cargo` warning at build time tells you the same.
- **Release builds require the web client**: `cargo build --release` fails hard if `webclientsrc/dist` is missing or empty. Debug builds only warn.

> **Note:** Option B seeds `myrealm` from `examples/provision.example.yaml`, which declares the `my-app` client **without** a secret — the provisioner generates a random one at first boot. Use the public client `public-app`, or `admin-cli` in the `master` realm, for token experiments here. The fixed `my-app-secret` only exists in the Docker demo stack.

## The CLI at a glance

The single `issuerd` binary has five subcommands (verified against `src/cli.rs`):

```
issuerd [-v...] [-q...] <COMMAND>
```

| Command | Flags | What it does |
|---|---|---|
| `daemon` | `-c, --config <path>` (default `issuerd.toml`) | Run the server in the foreground until Ctrl+C/SIGTERM (graceful shutdown). |
| `provision` | `-c, --config <path>` (default `issuerd.toml`), `-f, --file <path>` (required) | Connect to the storage configured in the server config, apply a provision file (YAML/TOML/JSON) **exactly once**, and exit. For PostgreSQL it also runs pending schema migrations first. |
| `openapi` | `-o, --output <path>` (default `openapi.json`) | Write the merged OpenAPI 3.0 specification (Admin API + account/protocol endpoints) and exit. |
| `example` | `<server-config\|provision-config>` (positional), `-o, --output <path>` | Write a fully-commented example configuration file and exit. |
| `healthcheck` | `--url <url>` (default `http://localhost:8080/ready`), `--insecure` (skip TLS verification), `--timeout-secs <n>` (default 5) | Probe a URL and exit non-zero unless the response is 2xx; intended for container healthchecks so the runtime image needs no curl. |

Global flags:

- `-v` / `--verbose` — repeatable; default level is INFO, `-v` gives DEBUG, `-vv` gives TRACE.
- `-q` / `--quiet` — repeatable; `-q` gives WARN, `-qq` gives ERROR.

Operational notes:

- Relative config paths are resolved against the **current working directory** of the process.
- `example` defaults its output to `examples/issuerd.example.toml` for *both* kinds — always pass `-o` explicitly (e.g. `issuerd example provision-config -o my-provision.yaml`).
- Only one daemon can run at a time: a second `issuerd daemon` process exits immediately with `Another Issuerd instance is already running`.

## First boot explained

Knowing what the server does on its first start saves confusion later. All of this lives in `crates/issuerd-server/src/state.rs` and `crates/issuerd-server/src/provisioner.rs`.

**On every boot, all backends:**

- The JSON-file backend loads its snapshot; PostgreSQL runs pending schema migrations automatically.
- The signing-key set is loaded from shared storage; if it is empty (first ever boot), the initial pair — a fresh EdDSA (Ed25519) key (the signing default) and an active RS256 key (mandatory-to-implement per OIDC Core, so discovery advertises it) — is generated and persisted so restarts — and every node of a cluster — converge on the same keys.

**Automatic master-realm bootstrap — in-memory and JSON-file backends only:**

If (and only if) the storage backend is `in-memory` or `json-file` **and** no realms exist yet, the server creates the `master` realm with:

- user `admin` / `admin` (Argon2id-hashed),
- the realm-management roles `manage-realm`, `view-realm`, `manage-users`, `view-users`, `manage-clients`, `view-clients`, `impersonation`, all assigned to `admin`,
- the built-in public clients `admin-cli` and `account-console`, with redirect URIs derived from the configured `issuer_url`.

Every realm creation (bootstrap, provisioning, or Admin API) also seeds the built-in browser and registration authentication flows and the built-in client scopes.

> **Warning:** With **PostgreSQL** storage there is **no** automatic master bootstrap. A fresh PostgreSQL deployment must create the `master` realm through a provision file (as `examples/provision.demo.yaml` does) or via `issuerd provision --file ...`. Without it there is no admin user and no way to log into the admin console.

**Provision file application (`provision = "<path>"` in the server config):**

- The file (YAML/TOML/JSON, detected by extension) is applied **exactly once**: a marker record (`marker:` key in the file, default `default`) is claimed in storage before applying, so restarts and concurrent first boots skip it. With in-memory storage the marker vanishes on restart, so provisioning re-applies on every boot — harmless, since existing entities are skipped.
- `${VAR}` environment-variable substitution is performed on all string values; an unresolved variable fails the run.
- Entities are created in a fixed order — realms → roles → clients → groups → users → identity providers → flow configs — so cross-references resolve. Already-existing entities are skipped with a warning.
- Each provisioned realm automatically gets the built-in `account-console` and `admin-cli` clients (redirect URIs derived from `issuer_url`).
- A confidential client provisioned without an explicit `secret` gets a **randomly generated** one.
- Top-level provisioning failures are logged at **ERROR** level (`failed to load provision config` for a missing/unparsable file, `provision failed` for an apply error) and do not abort startup — only per-entity skips are warnings. Check the log for `provision` if seeded content is missing.

For the full provision-file schema see [provisioning.md](/provisioning/) and `examples/provision.example.yaml`.

## Verifying the installation

All checks below work for both installation options.

**Liveness and readiness** (`crates/issuerd-server/src/routes/system.rs`):

```bash
curl -s http://localhost:8080/health
# {"status":"ok"}

curl -s -w '\n%{http_code}\n' http://localhost:8080/ready
# {"status":"ready"}
# 200
# (503 with {"status":"not_ready","dependency":"storage"|"cache"} while a
#  dependency is unreachable)
```

`/health` is a static liveness probe; `/ready` actually probes storage and the cache, so it is the endpoint to wire into load balancers and orchestrators. Prometheus metrics are at `/metrics`.

**OIDC discovery** — the realm segment in URLs is the realm *name*:

```bash
curl -s http://localhost:8080/realms/myrealm/.well-known/openid-configuration | jq .issuer
# "http://localhost:8080/realms/myrealm"
```

The issuer is always `{issuer_url}/realms/{realm-name}`; if it shows something other than how clients will reach the server, fix `issuer_url` now (see [First hardening steps](#first-hardening-steps)).

**Browser checks:**

1. Open <http://localhost:8080/admin/console>, sign in as `admin` / `admin` — you should land in the `master` realm and see `myrealm` in the realm picker.
2. Open <http://localhost:8080/realms/myrealm/account>, sign in as `alice` / `changeme` — the account console shows her profile.

## Getting your first access token

The fastest smoke test is the OAuth2 Resource Owner Password Credentials (ROPC) grant against the token endpoint — no browser redirect dance required. Client authentication accepts the secret either as a form field (`client_secret`) or as an HTTP Basic header.

**Against the Docker demo stack** (confidential client `my-app` with its seeded secret):

```bash
curl -s -X POST http://localhost:8080/realms/myrealm/protocol/openid-connect/token \
  -d "grant_type=password" \
  -d "client_id=my-app" \
  -d "client_secret=my-app-secret" \
  -d "username=alice" \
  -d "password=changeme" \
  -d "scope=openid profile"
```

**Against any fresh install** (public client `admin-cli` in the auto-created `master` realm — no secret needed; this is the same request shape the E2E test suite uses):

```bash
curl -s -X POST http://localhost:8080/realms/master/protocol/openid-connect/token \
  -d "grant_type=password" \
  -d "client_id=admin-cli" \
  -d "username=admin" \
  -d "password=admin" \
  -d "scope=openid"
```

A successful response is `200 OK` with `Cache-Control: no-store` and a JSON body:

```json
{
  "access_token": "eyJhbGciOi...",
  "token_type": "Bearer",
  "expires_in": 300,
  "refresh_token": "eyJhbGciOi...",
  "id_token": "eyJhbGciOi...",
  "scope": "openid profile"
}
```

`expires_in` is the realm's access-token lifespan (300 s unless changed), and `id_token` is present because the requested scope contains `openid`. Use the access token as a Bearer credential, e.g.:

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/realms/myrealm/protocol/openid-connect/token \
  -d "grant_type=password" -d "client_id=my-app" -d "client_secret=my-app-secret" \
  -d "username=alice" -d "password=changeme" -d "scope=openid profile" | jq -r .access_token)

curl -s http://localhost:8080/realms/myrealm/protocol/openid-connect/userinfo \
  -H "Authorization: Bearer $TOKEN"
```

Typical failure causes: a wrong password yields `401 {"error":"invalid_grant"}`; an unknown/disabled client or wrong secret yields `invalid_client`; a user with pending required actions (e.g. a temporary password) is rejected with `invalid_grant` — ROPC cannot render setup pages. Repeated wrong passwords can trip the realm's brute-force lockout, which also surfaces as `invalid_grant`.

> **Note:** ROPC is a smoke-test and legacy-integration tool. Real browser applications should use the authorization code flow with PKCE — see [client-integration.md](/client-integration/).

## First hardening steps

Before the server leaves your laptop, in rough order of urgency (details in [security.md](/security/) and [deployment.md](/deployment/)):

1. **Change the `admin` password** — admin console → Users → `admin` → Credentials, or sign into `http://localhost:8080/realms/master/account` as `admin`. The `admin`/`admin` default is public knowledge.
2. **Remove or re-secret the demo content** — `alice`/`changeme` and `my-app-secret` are checked into the repository. Delete the demo realm/clients or provision your own instead.
3. **Set `issuer_url` to the public base URL** of the deployment (e.g. `https://id.example.com`). It is baked into the `iss` claim and the discovery document, so it must match how clients reach the server *before* they integrate; changing it later changes the issuer of all realms.
4. **Turn on TLS** — either the built-in `[tls]` section (`cert_path`/`key_path`) or a TLS-terminating reverse proxy in front; plain HTTP is for local evaluation only.
5. **Move persistent state to PostgreSQL** — the in-memory backend loses everything on restart and cannot cluster. Remember that PostgreSQL deployments need the `master` realm defined in a provision file (see [First boot explained](#first-boot-explained)).
6. **Keep CORS locked down** — no cross-origin origins are allowed unless explicitly listed in `[cors] allowed_origins`; only add the origins your own SPAs actually use.

## Where to go next

- [configuration.md](/configuration/) — every server configuration key, environment overrides, and defaults.
- [provisioning.md](/provisioning/) — declarative realm/client/user seeding with provision files.
- [deployment.md](/deployment/) — production deployment: TLS, reverse proxies, PostgreSQL/Redis, systemd and containers.
- [administration.md](/administration/) — day-2 operations with the admin console and the Admin REST API.
- [client-integration.md](/client-integration/) — connecting applications: authorization code flow + PKCE, client types, adapter config download.
- [user-federation.md](/user-federation/) — LDAP/Kerberos user federation and synchronization.
- [identity-brokering.md](/identity-brokering/) — external OIDC and social identity providers.
- [security.md](/security/) — hardening: brute-force protection, password policies, secrets, token security.
- [monitoring.md](/monitoring/) — Prometheus metrics, health probes, events, and audit logging.
- [backup-and-upgrade.md](/backup-and-upgrade/) — backups, schema migrations, and upgrading Issuerd.
- [troubleshooting.md](/troubleshooting/) — common failure modes and how to diagnose them.
- [CLUSTERING.md](/clustering/) — running multiple Issuerd nodes behind a load balancer.
- [PERFORMANCE.md](/performance/) — performance targets and the benchmark harness.
