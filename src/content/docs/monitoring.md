---
title: "Monitoring: health probes, metrics, logging, and audit events"
description: "This document covers the operational observability surface of a running Issuerd server: the liveness and readiness probes, the Prometheus /metrics endpoint, how logging is configured and…"
---

This document covers the operational observability surface of a running Issuerd server: the liveness and readiness probes, the Prometheus `/metrics` endpoint, how logging is configured and correlated, and the two audit-trail APIs (login events and admin events) with their retention behavior. It is written for system operators and administrators running Issuerd in production. Production wiring (systemd units, reverse proxies, full Kubernetes manifests) is covered in [deployment.md](/deployment/); multi-node specifics in [CLUSTERING.md](/clustering/).

## Contents

- [Health probes](#health-probes)
- [Prometheus metrics](#prometheus-metrics)
- [Logging](#logging)
- [Login events](#login-events)
- [Admin events](#admin-events)
- [Audit best practices](#audit-best-practices)

## Health probes

Issuerd exposes three probe routes (registered in `crates/issuerd-server/src/routes.rs`, handlers in `crates/issuerd-server/src/routes/system.rs`):

| Route | Purpose | Success | Failure |
|---|---|---|---|
| `GET /health` | Liveness | `200 {"status":"ok"}` | never fails while the process serves HTTP |
| `GET /ready` | Readiness | `200 {"status":"ready"}` | `503 {"status":"not_ready","dependency":"storage"\|"cache"}` |
| `GET /health/ready` | Alias of `/ready` | same as `/ready` | same as `/ready` |

**Liveness** (`/health`) is a static response — it touches no dependencies and only proves the HTTP stack is alive. Use it to detect a wedged process, not a broken deployment.

**Readiness** (`/ready`) performs two real probes, in order:

1. **Storage** — runs `list_realms` against the configured storage backend. With PostgreSQL this is an actual database round-trip (so it catches a dead DB, dropped connections, and missing migrations); with the in-memory or JSON-file backends it is an in-process read that effectively always succeeds.
2. **Cache** — runs `get("__ready_probe__")` against the configured `DistributedCache`. With Redis this is a real round-trip to the server; with the in-memory cache it is an in-process read.

The first failing probe short-circuits the response, so the `dependency` field tells you which subsystem is down, and a WARN line — `readiness check failed: storage unreachable` or `readiness check failed: cache unreachable` — is written to the log with the underlying error as a structured `error` field.

> **Note:** In clustered mode a failing cache probe is deliberate and important: authorization codes, pending authentication state, and the token-revocation blocklist live in the shared cache, so a node that lost Redis must be drained by the load balancer even though it can still sign tokens. Point your LB health check at `/ready` (or `/health/ready`) — see [CLUSTERING.md](/clustering/) and the reverse-proxy section of [deployment.md](/deployment/).

Example Docker healthcheck (the one used by the root demo stack, `docker-compose.yml`).
The runtime image ships no curl/wget, so the check uses the binary's own
`healthcheck` subcommand (plain HTTP; add `--insecure` for self-signed TLS):

```yaml
healthcheck:
  test: ["CMD", "issuerd", "healthcheck", "--url", "http://localhost:8080/ready"]
  interval: 10s
  timeout: 5s
  retries: 12
  start_period: 15s
```

Example Kubernetes probes:

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /ready
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 3
```

Quick manual check:

```bash
curl -s http://localhost:8080/health   # {"status":"ok"}
curl -s -w '\n%{http_code}\n' http://localhost:8080/ready
```

## Prometheus metrics

`GET /metrics` serves Prometheus text exposition format (`text/plain; charset=utf-8`) rendered by the `metrics-exporter-prometheus` recorder, which the daemon installs at startup (`crates/issuerd-server/src/routes/system.rs`, `src/main.rs`). If the recorder is not initialized the endpoint returns `404 metrics recorder not initialized`.

> **Warning:** The exporter plumbing is in place, but the current codebase does **not emit any application-level counters, histograms, or gauges** through the `metrics` facade — a scrape today returns an empty exposition with no Issuerd-specific series. Until series are added, build your monitoring on three pillars that do exist: the scrape's own `up` metric, the health probes above (via blackbox-style probing), and the audit-event APIs described below, which carry per-login and per-mutation detail no counter would.

**Per-node caveat in clusters:** metrics (and the recorder) are per process — there is no aggregation between nodes. Scrape **every node**, not just the load balancer, or you will silently miss all but one backend. See the state-model table in [CLUSTERING.md](/clustering/).

Example Prometheus scrape configuration:

```yaml
scrape_configs:
  - job_name: issuerd
    scrape_interval: 30s
    static_configs:
      # List every node; the LB alone only samples one backend per request.
      - targets: ["issuerd-1:8080", "issuerd-2:8080"]
```

Starter alert ideas (suggestions — tied to signals that exist today, not to application metrics):

- **Instance down / scrape failing** — `up{job="issuerd"} == 0` for more than one scrape interval.
- **Readiness failing** — probe `/ready` with the Prometheus blackbox exporter (or your LB's health-check state) and alert on a non-200 response: `probe_success{instance=~".*:8080/ready"} == 0`. A 503 here names the failing dependency (`storage` or `cache`) in the response body.
- **Login-failure spike** — no counter exists, but the events API does: poll `GET /admin/realms/{realm}/events/count?event_type=login_error&date_from=...` on a schedule and alert when the count over a sliding window crosses your baseline (see [Login events](#login-events)).
- **HTTP 5xx rate** — not exported as a metric; today this signal lives in the access log, where every 5xx response is logged at ERROR with method, path, status, latency, and request id (see [Logging](#logging)). Ship logs to your stack and alert on the ERROR-rate, or place a reverse proxy with request metrics in front.

## Logging

### Destinations and format

The daemon initializes `tracing` at startup (`src/logging.rs`) with two possible outputs:

- **stdout (default)** — console formatting with the module target and line numbers. `format = "pretty"` (the default) renders human-readable text; `format = "json"` in `[logging]` renders one JSON object per event for log shippers. ANSI colors are emitted only when stdout is a terminal (and never in JSON), so piped and container logs stay clean. Under a container runtime this lands in the container log and is collected by the platform's log shipper.
- **journald (Linux + systemd only)** — when the `JOURNAL_STREAM` environment variable is present (i.e. the process runs under systemd with default `StandardOutput=journal`), logs go through the `tracing-journald` layer instead of the console formatter, in journald's own structured format (the `[logging].format` setting applies to the console only). If journald initialization fails, the daemon prints a notice to stderr and falls back to console formatting. See the systemd unit in [deployment.md](/deployment/); follow logs with `journalctl -u issuerd -f`.

Dependencies that emit through the `log` facade (ldap3, redis, reqwest, rustls, sqlx, …) are bridged into tracing at startup (`tracing-log`'s `LogTracer`), so their records appear in the same output and are filtered by the same directives.

### Level control

The effective log level is decided at startup, in this order:

1. **`RUST_LOG`** — if set, it wins completely. Any standard `tracing` EnvFilter directive string is accepted, e.g. `RUST_LOG=issuerd_server=debug,issuerd_storage=warn` or `RUST_LOG=debug,sqlx=warn`.
2. **`-v` / `-q` CLI flags** — global, repeatable, and combinable; the default (no flags) falls through to the config:

   | Flags | Level |
   |---|---|
   | `-qq` (or quieter) | ERROR |
   | `-q` | WARN |
   | `-v` | DEBUG |
   | `-vv` (or more) | TRACE |

3. **`[logging].level`** in the config file — one of `error`, `warn`, `info` (default), `debug`, `trace`. Unparsable values fall back to `info` with a WARN at startup. See [configuration.md](/configuration/#logging).

The flag/config-derived level is applied to Issuerd's own crates (`issuerd`, `issuerd_server`, `issuerd_core`, `issuerd_auth_flow`, `issuerd_protocol`, `issuerd_token`, `issuerd_storage`, `issuerd_cluster`, `issuerd_admin_api`, `issuerd_federation`); use `RUST_LOG` when you also need to tune dependencies such as `sqlx` or `tower`.

### Request logging and correlation

Every HTTP request is wrapped in a tracing span (`crates/issuerd-server/src/routes.rs`) carrying `method`, `path`, `status`, and `request_id`, and exactly one response event is emitted per request with a `latency_ms` field:

| Outcome | Level |
|---|---|
| 5xx | ERROR |
| 4xx | WARN |
| 2xx/3xx on a "noisy" path | DEBUG |
| everything else | INFO |

Only the URL **path** is recorded — never the query string, which can carry live credentials on GET flows (authorization codes, action tokens, `id_token_hint` and JAR request JWTs).

Noisy paths (demoted to DEBUG on success so health checks, SPA assets and polling clients don't flood INFO) are: `/health`, `/ready`, `/health/ready`, `/metrics`, `/.well-known/*`, `/assets/*`, the JWKS endpoint (`/realms/{realm}/protocol/openid-connect/certs`), `/`, `/config.js`, `/favicon.ico`, `/robots.txt`, `/site.webmanifest`, and any path ending in a common static extension (`.js`, `.css`, `.png`, `.svg`, `.html`, fonts, etc.). Errors on these paths still surface at WARN/ERROR.

**Request correlation:** the request-id middleware (`crates/issuerd-server/src/middleware/request_id.rs`) honors an inbound **`x-request-id`** header — sanitized to `[A-Za-z0-9._-]`, at most 64 characters — and otherwise generates a UUID v4. The effective id is returned in the `x-request-id` response header and recorded as the `request_id` span field, so a correlation id assigned by your load balancer or an upstream client follows the request through the logs. To trace one request end-to-end, take the header value and grep the logs for it.

**Multi-node identity:** at boot every node logs a `node identity` line with `node_id` and `cluster_enabled` fields (`crates/issuerd-server/src/state.rs`). The id comes from `[cluster] node_id`, falling back to the `HOSTNAME` environment variable, then to a random id. It is logged once at startup — per-line node attribution should come from your log pipeline (journald's `_HOSTNAME`, Kubernetes pod metadata, or your shipper's source tagging).

**Audit trail in the log:** realms with the built-in `logging` event listener (the default) additionally mirror every login event and admin event to the log at INFO as structured `user event` / `admin event` records with fields like `realm`, `event_type`, `user_id`, `client_id`, `resource_path`, and `error` (`crates/issuerd-server/src/event_listeners.rs`). If you ship stdout/journald to a log stack, you get the audit trail there for free; the sections below describe the queryable form.

## Login events

Login (user-facing) events record authentication activity: logins, logouts, token issuance, and their failures. Recording is gated per realm by `events_enabled` — **Issuerd defaults it to ON** (a deliberate Keycloak parity break, so a fresh realm has an audit trail immediately). If the realm record cannot be re-read when an event fires, recording **fails open** — the event is written rather than silently dropped (gating logic in `crates/issuerd-server/src/routes/oidc.rs`).

Each event (`crates/issuerd-core/src/events.rs`) carries: event type, timestamp, realm, optional client id, user id, session id, client IP address (as seen after proxy-IP resolution), an error message for failures, and a free-form `details` map (e.g. `username`, `auth_method`, `redirect_uri`).

### Event types

The built-in types (snake_case; also listed at runtime by `GET /admin/enums/event-types`):

| Type | Meaning |
|---|---|
| `login` | Successful user login |
| `login_error` | Failed user login |
| `logout` | User logout |
| `code_to_token` | Authorization code exchanged for tokens |
| `code_to_token_error` | Failed code exchange |
| `client_login` | Successful client authentication (e.g. client credentials) |
| `refresh_token` | Token refresh |
| `refresh_token_error` | Failed token refresh |
| `token_exchange` | Successful RFC 8693 token exchange |
| `token_exchange_error` | Failed RFC 8693 token exchange |
| `ciba_auth` | CIBA backchannel authentication request accepted |
| `ciba_auth_error` | CIBA backchannel request or approval submission rejected (`invalid_scope`, disabled client, unknown/expired `auth_req_id`, …) |
| `ciba_approve` | CIBA request approved by the user |
| `ciba_deny` | CIBA request denied by the user |

A successful CIBA poll (token issuance) is recorded as a `login` event with `details.method=ciba`; a denied or expired poll is a `login_error` with `access_denied` / `expired_token`. Pending (`authorization_pending`) and throttled (`slow_down`) polls record nothing.

The model additionally defines `register`, `register_error`, `logout_error`, `client_login_error`, and `invalid_signature`, and supports free-form custom types. Several one-off user actions are recorded as custom types: `register` / `register_error` (self-registration), `reset_password` (email reset link used), and `update_password` / `update_profile` / `verify_email` (required-action completion).

### Querying events

```
GET /admin/realms/{realm}/events
GET /admin/realms/{realm}/events/count
```

Both require a `view-realm` or `manage-realm` token (see [administration.md](/administration/) for obtaining one) and accept the same query parameters (`crates/issuerd-admin-api/src/dto.rs`):

| Parameter | Meaning | Default |
|---|---|---|
| `event_type` | Filter by type, e.g. `login_error` | none |
| `date_from` | RFC 3339 start of range | none (but see retention clamping below) |
| `date_to` | RFC 3339 end of range | none |
| `first` | Zero-based offset for pagination | `0` |
| `max` | Page size | `20` |

`events` returns a JSON array of representations: `id`, `time` (Unix timestamp), `event_type`, `realm_id`, `client_id`, `user_id`, `username`, `session_id`, `ip_address`, `details`, `error`. `username` is resolved against the realm's users at query time; when the user no longer exists (deleted, or a federated user never imported) it falls back to the `username` recorded in the event's `details`. `events/count` returns `{"count": N}` for the same filters with pagination ignored — use it for totals and dashboard-style checks.

> **Note:** The HTTP surface currently filters by event type and date range only — there are no `client`, `user`, or `session` query parameters, even though `client_id`, `user_id`, and `session_id` are returned in each representation. Filter those client-side after fetching.

Examples (token acquisition is covered in [administration.md](/administration/#getting-an-admin-token)):

```bash
IC=http://localhost:8080

# Failed logins in the last hour
FROM=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)
curl -s "$IC/admin/realms/myrealm/events?event_type=login_error&date_from=$FROM&max=100" \
  -H "Authorization: Bearer $TOKEN"

# How many token exchanges failed today? (total for a dashboard/alert)
curl -s "$IC/admin/realms/myrealm/events/count?event_type=code_to_token_error&date_from=$FROM" \
  -H "Authorization: Bearer $TOKEN"

# Page through a realm's event log, 100 at a time
curl -s "$IC/admin/realms/myrealm/events?first=0&max=100" -H "Authorization: Bearer $TOKEN"
```

### Retention and clearing

Retention is configured per realm via `events_expiration` (seconds; `0` = never expire) in `GET/PUT /admin/realms/{realm}/events/config` — the configuration surface is documented in [administration.md](/administration/#events-management-for-administrators).

Two behaviors matter operationally (both in `crates/issuerd-admin-api/src/events.rs`):

- **Retention is read-path clamping, not deletion.** With `events_expiration > 0`, every query (list *and* count) clamps `date_from` to at most `now - expiration` — even if you ask for an older start, and even when you pass no `date_from` at all. Expired rows are **never physically removed** by the server; they keep consuming storage until cleared.
- **`DELETE /admin/realms/{realm}/events`** (requires `manage-realm`) deletes *all* stored login events of the realm and then records the wipe itself as one fresh admin event (`DELETE` on `realms/{realm}/events`), so the audit log retains the fact that someone cleared the trail.

## Admin events

Admin events are the audit trail for the Admin REST API: every mutating call under `/admin/...` records who changed what (`crates/issuerd-admin-api/src/audit.rs`).

Each admin event stores:

- **What** — `operation_type` (`CREATE`, `UPDATE`, `DELETE`, `ACTION`), `resource_type` (`REALM`, `USER`, `CLIENT`, `CLIENT_SCOPE`, `GROUP`, `ROLE`, `SESSION`, `IDENTITY_PROVIDER`, `USER_FEDERATION`, `INITIAL_ACCESS_TOKEN`), and the `resource_path` (e.g. `users/6f3c…`, `realms/myrealm/events/config`). Valid filter values are listed at runtime by `GET /admin/enums/operation-types` and `GET /admin/enums/resource-types`.
- **Who** — `auth_realm_id` (resolved from the realm **name** in the token's issuer — this is how master-realm admins are attributed when acting on other realms), `auth_client_id` (the token's `azp`), and `auth_user_id` (the token's `sub`).
- **Payload (optional)** — `representation`, the request body of the mutation, stored only when the realm opted in (below).
- **Failures** — failed admin operations are recorded with `operation_type: "ACTION"` and the error message in `error`.

### Per-realm gating

Recording is gated per realm (`crates/issuerd-admin-api/src/audit.rs`), configurable via `GET/PUT /admin/realms/{realm}/events/config`:

| Setting | Default | Effect |
|---|---|---|
| `admin_events_enabled` | **ON** (Keycloak parity break) | When off, no admin events are written for the realm |
| `admin_events_details_enabled` | OFF | When off, `representation` is stripped before persistence (event kept, payload dropped) |

Two deliberate behaviors to know:

- **Fail-closed realm lookup** — if the realm row is missing or cannot be loaded when an event fires (e.g. transient storage error), the event is still recorded — the mutation has already happened and the audit trail must survive — but its representation is stripped: a realm whose preferences are unknown has not opted into storing request bodies.
- **Persistence is non-fatal** — a failed admin-event write never fails the underlying mutation (which has already happened); it is logged as an `admin event persistence failed` warning. If you see that warning, your audit trail has gaps — treat it as an alertable condition.

Full config-field semantics and the console UI are covered in [administration.md](/administration/#events-management-for-administrators).

### Querying admin events

```
GET /admin/realms/{realm}/admin-events
GET /admin/realms/{realm}/admin-events/count
DELETE /admin/realms/{realm}/admin-events
```

Query parameters: `operation_type`, `resource_type`, `date_from`, `date_to` (RFC 3339), `first` (default `0`), `max` (default `20`). Reads require `view-realm` or `manage-realm`; the delete requires `manage-realm`. Responses add `auth_username`, resolved at query time against the *issuing* realm (`auth_realm_id`) — correct even when a master-realm admin acted on another realm. The same `events_expiration` read-path clamping as login events applies, and `DELETE .../admin-events` likewise records its own wipe as one fresh admin event.

Examples:

```bash
# Everything deleted in the realm this week
FROM=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)
curl -s "$IC/admin/realms/myrealm/admin-events?operation_type=DELETE&date_from=$FROM&max=100" \
  -H "Authorization: Bearer $TOKEN"

# All client changes (creates, updates, deletes)
curl -s "$IC/admin/realms/myrealm/admin-events?resource_type=CLIENT&max=100" \
  -H "Authorization: Bearer $TOKEN"

# Total admin actions matching a filter (for paging or alerting)
curl -s "$IC/admin/realms/myrealm/admin-events/count?operation_type=ACTION&date_from=$FROM" \
  -H "Authorization: Bearer $TOKEN"
```

## Audit best practices

**Ship events to a SIEM.** There are two paths, complementary and independent:

1. **Poll the events API** — on a schedule, fetch `events` and `admin-events` per realm with a `date_from`/`date_to` window (or page with `first`/`max` using the `/count` endpoints for totals), and forward the JSON to your SIEM. Overlapping windows are safe — events are append-only and id-keyed, so deduplicate on `id`.
2. **Ship the log stream** — realms with the default `logging` listener emit every event as a structured INFO record (`user event` / `admin event`); forwarding stdout/journald (see [Logging](#logging)) gets you the same content without an API poller. The API path is richer for retroactive queries; the log path has no polling lag.

**Plan retention deliberately.** `events_expiration` only *hides* old events from queries — it never deletes rows (see [Retention and clearing](#retention-and-clearing)). On a busy realm every login, logout, code exchange, and refresh writes a row, so decide per realm:

- Set `events_expiration` to bound what queries return (e.g. 90 days: `{"eventsExpiration": 7776000}` via `PUT .../events/config`).
- Schedule an export-then-clear job: pull the window you need to keep (API poll into your SIEM), then `DELETE /admin/realms/{realm}/events` (and `admin-events`) to reclaim storage. Remember the wipe itself leaves one admin event — your SIEM will see it, which is what you want.

**Alert on sensitive admin operations.** Practical, API-driven checks worth wiring up:

- **Audit-trail wipes** — alert on admin events whose `resource_path` is `realms/{realm}/events` or `realms/{realm}/admin-events`. Clearing the trail is sometimes legitimate housekeeping, but it is also how an attacker covers tracks; it should always be a reviewed action.
- **Destructive operations** — poll `admin-events?operation_type=DELETE` on a short interval and page on unexpected resources (realm, clients, identity providers, federation configs).
- **Events-config tampering** — alert on `UPDATE` events with `resource_path` ending in `/events/config`: someone disabling `admin_events_enabled` is a classic pre-attack move.
- **Authentication anomalies** — sliding-window counts of `login_error` (per realm) and `refresh_token_error` / `code_to_token_error` from `events/count`; spikes indicate brute force or a broken/misconfigured client. Per-IP/per-user brute-force lockout itself is enforced at login time and configured per realm — see [administration.md](/administration/).
- **Admin-event persistence warnings** — alert on the `admin event persistence failed` log warning; it means your audit trail is losing records.

For performance context on the endpoints these pollers call (token issuance/validation cost), see [PERFORMANCE.md](/performance/).
