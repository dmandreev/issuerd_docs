---
title: "Troubleshooting"
description: "This guide maps the symptoms operators most commonly hit when running Issuerd to their likely causes and fixes: startup failures, browser login flows, token errors, email delivery, user…"
---

This guide maps the symptoms operators most commonly hit when running Issuerd to their likely causes and fixes: startup failures, browser login flows, token errors, email delivery, user federation, identity brokering, and clusters. Every behavior described here is verified against the source tree; where a topic has its own guide (federation, brokering, clustering, monitoring), this document stays short and links there.

## Contents

- [Before you start: gathering diagnostics](#before-you-start-gathering-diagnostics)
- [Startup failures](#startup-failures)
- [Login and browser flow problems](#login-and-browser-flow-problems)
- [Token problems](#token-problems)
- [Email delivery problems](#email-delivery-problems)
- [User federation problems](#user-federation-problems)
- [Identity brokering problems](#identity-brokering-problems)
- [Cluster problems](#cluster-problems)
- [Performance problems](#performance-problems)
- [Still stuck](#still-stuck)

## Before you start: gathering diagnostics

Most Issuerd problems are diagnosable from four sources: the logs, the readiness probe, the `x-request-id` correlation header, and a minimal curl reproduction.

**Raise the log verbosity.** The daemon defaults to INFO. Restart with `-v` (DEBUG) or `-vv` (TRACE), or set `RUST_LOG` for fine-grained control (e.g. `RUST_LOG=issuerd_server=debug,sqlx=warn` — `RUST_LOG` wins over the flags completely). Level control, log destinations (stdout vs journald), and per-request log levels are covered in [monitoring.md](/monitoring/#logging).

> **Note:** The `[logging]` section of the config file is honored by the daemon: level precedence is `RUST_LOG` > explicit `-v`/`-q` flags > `[logging].level` (INFO fallback), and `[logging].format` (`json`/`pretty`) selects the console layer format (`src/logging.rs`). The config file is loaded before logging is initialized so these settings take effect (`src/main.rs`).

**Check liveness vs readiness.** They mean different things (`crates/issuerd-server/src/routes/system.rs`):

```bash
curl -s http://localhost:8080/health    # {"status":"ok"} — process is up, no dependency checks
curl -s http://localhost:8080/ready     # 200 {"status":"ready"} or 503 with the failing dependency
```

`/ready` (also served as `/health/ready`) actually probes storage (a realm listing) and the cache (a GET). A 503 body names the culprit: `{"status":"not_ready","dependency":"storage"}` or `{"status":"not_ready","dependency":"cache"}`. A matching line appears in the logs at WARN: `readiness check failed: storage unreachable` or `readiness check failed: cache unreachable`.

**Correlate one request through the logs.** Every response carries an `x-request-id` header: an inbound `x-request-id` is honored and echoed when it is at most 64 chars of `[A-Za-z0-9._-]`, and missing or unsafe values get a fresh UUID v4 (`crates/issuerd-server/src/middleware/request_id.rs`); the same value is the `request_id` field of that request's tracing span:

```bash
curl -sv http://localhost:8080/realms/myrealm/.well-known/openid-configuration 2>&1 | grep x-request-id
# then: grep that UUID through the daemon logs (or journalctl -u issuerd | grep <uuid>)
```

**Reproduce with curl.** Browser flows hide the real error behind redirects and SPA rendering. Replay the failing step directly — discovery, the token endpoint, the JWKS — before digging deeper:

```bash
curl -s http://localhost:8080/realms/myrealm/.well-known/openid-configuration | head -c 400
curl -s -X POST http://localhost:8080/realms/myrealm/protocol/openid-connect/token \
  -d grant_type=password -d client_id=public-app -d username=alice -d password=changeme
curl -s http://localhost:8080/realms/myrealm/protocol/openid-connect/certs
```

**Know the boot landmarks.** A healthy boot logs, in order: `loaded configuration` (with the resolved `config_path`), `node identity` (with `node_id` and `cluster_enabled`), dependency connection lines, and `starting server` (or `starting TLS server`) with the listen address as a structured `addr` field. The first missing line tells you which boot stage failed.

## Startup failures

Boot order (`src/main.rs` → `crates/issuerd-server/src/state.rs` → `crates/issuerd-server/src/bootstrap.rs`): parse CLI → single-instance guard → config load → `issuer_url` validation → cluster contract check → storage connect → migrations → cache connect → signing-key bootstrap → master-realm bootstrap / provisioning (**warnings only, never fatal**) → HTTP bind.

| Symptom | Likely cause | Fix |
|---|---|---|
| Exits with `config load failed: ...` | The config file does not parse. The format is chosen **by file extension**: `.yaml`/`.yml` → YAML, `.json` → JSON, anything else → TOML (`crates/issuerd-server/src/config.rs`). A TOML file named `config.yaml` fails with a YAML error. | Match extension to content. Compare against a known-good file: `issuerd example server-config -o /tmp/ref.toml`. |
| Daemon ignores your config file | The `-c` path does not exist: a missing file is **silently skipped** and defaults + environment are used (`config.rs`: `if p.exists()`). `-c` is resolved against the daemon's working directory. | Check the `loaded configuration` boot line for the resolved `config_path`. Pass an absolute path, or fix your unit's `WorkingDirectory`. |
| File value X, runtime behaves as Y | Environment overrides win over the file: any `ISSUERD_*` variable is merged on top (`__` is the nesting separator, keys are lowercased) — e.g. `ISSUERD_CLUSTER__ENABLED=true`, `ISSUERD_PORT=9090`. Common source: a systemd `EnvironmentFile` or a container env block left over from testing. | `env \| grep ISSUERD_` on the daemon's environment. List-typed keys (`cluster.redis_nodes`, `cors.allowed_origins`, `proxy.trusted_proxies`) cannot be set via env — use the config file (see [CLUSTERING.md](/clustering/)). |
| `issuer_url must be an absolute http(s) URL` | `issuer_url` is missing the scheme or is a bare host. It is validated before any network I/O (`state.rs`). | Set e.g. `issuer_url = "https://id.example.com"` — the public base URL clients use. |
| `cluster.enabled requires PostgreSQL storage and a Redis cache (set redis or cluster.redis_nodes)` | The split-brain boot guard: `cluster.enabled = true` without both shared dependencies. Validated before opening any connection (`state.rs`). | Configure `[storage.postgres]` and `redis` (or `cluster.redis_nodes`), or set `cluster.enabled = false` for a genuine single node. See [CLUSTERING.md](/clustering/). |
| ERROR `PostgreSQL connection failed: ...` then exit with `db connect failed: ...` | PostgreSQL unreachable, wrong credentials/db name, TLS required by the server but not negotiated. | Test the same URL from the host: `psql "postgres://issuerd:...@host:5432/issuerd"`. Check pg_hba.conf, network policy, and that the database exists. |
| Exit with `migration failed: ...` | Schema migration error: the DB user lacks DDL rights, a migration was edited after being applied (checksum mismatch), or a previous run was interrupted mid-migration. Migration files under `crates/issuerd-storage/migrations/` are append-only — never edit them. | Grant CREATE/ALTER to the Issuerd DB user. If checksums mismatch, the database was built by a different/modified codebase — restore a backup that matches the binary you run (see [backup-and-upgrade.md](/backup-and-upgrade/)). |
| ERROR `redis connection failed: ...` (or `redis cluster connection failed: ...`) | Redis is configured (`redis = "redis://..."`) but unreachable, or `cluster.redis_nodes` points at the wrong ports. Boot fails — there is no silent fallback once Redis is configured. | `redis-cli -u redis://host:6379 ping`. With no `redis` key at all, Issuerd uses an in-process cache (single-node only — see [Cluster problems](#cluster-problems)). |
| ERROR `failed to load TLS configuration` with `cert_path` | `[tls]` cert/key unreadable or mismatched. Underlying causes (`crates/issuerd-server/src/tls.rs`): `failed to read certificate file ...`, `failed to parse certificate ...`, `failed to read private key file ...`, or a cert/key mismatch from rustls. Files must be PEM. | Verify paths are readable by the daemon user; check with `openssl x509 -in cert.pem -noout -subject` and confirm the key matches the cert. |
| Exit with `invalid bind address: ...` | `bind` is not an IP literal (`bootstrap.rs` parses it as an IP so IPv6 works). `bind = "localhost"` fails. | Use `0.0.0.0`, `127.0.0.1`, `::1`, etc. To limit exposure, bind a specific interface IP. |
| Exit with OS error `Address already in use` | Another process holds the port (default 8080 collides with many dev servers — including the reference Keycloak on 8081 in the integration stack). | `ss -ltnp \| grep :8080` to find the holder; change `port` or stop the other process. |
| ERROR `Another Issuerd instance is already running`, exit code 1 | The single-instance guard (`src/main.rs`, lock name `issuerd-instance`) found a live daemon **on the same host**. It does not interfere with containers or other hosts ([CLUSTERING.md](/clustering/)). | Stop the old daemon (check for a zombie `issuerd` process), or run the second instance in a container/VM. |
| Daemon is up but there is no `master` realm / admin login fails (PostgreSQL) | The automatic master-realm bootstrap (admin/admin) runs **only** for the in-memory and JSON-file backends, and only when zero realms exist (`state.rs`). With PostgreSQL, provisioning must create `master` (as `examples/provision.demo.yaml` does). | Provision the master realm — see [provisioning.md](/provisioning/) and [getting-started.md](/getting-started/). |
| ERROR `failed to bootstrap master realm` or ERROR `provision failed` at boot | These are **non-fatal by design**: the daemon keeps starting (`state.rs`). The underlying error is carried as a structured `error` field on the log record, not interpolated into the message. A half-provisioned system is the usual result. | Fix the underlying error (storage, YAML syntax) and re-apply: `issuerd provision -c issuerd.toml --file provision.yaml`. Note provisioning is exactly-once per marker name — see "Re-runs and idempotency" in [provisioning.md](/provisioning/). |

## Login and browser flow problems

| Symptom | Likely cause | Fix |
|---|---|---|
| Authorize request fails with "redirect_uri not registered" (`invalid_request`) | Redirect URIs are matched **exactly**, with one relaxation: a registered entry ending in `*` is a prefix wildcard (`crates/issuerd-core/src/models.rs`, `RedirectUri::matches`). Scheme, host, port, path, and trailing slashes all matter; `https://app.example.com/cb` ≠ `https://app.example.com/cb/`. A `redirect_uri` containing a fragment is rejected outright. Because the URI is unregistered, the error is **not** redirected back to the client (`crates/issuerd-server/src/routes/oidc.rs`) — the user sees an error page and the client log shows nothing. | Register the exact URI the app sends (capture it from the failing `/auth` request), or add a trailing-`*` entry such as `https://app.example.com/*`. Update via the admin console or `PUT /admin/realms/{realm}/clients/{id}` (see [administration.md](/administration/)). |
| Browser console shows CORS errors (preflight blocked, no `Access-Control-Allow-Origin`) | Server CORS is locked down by default: with `[cors] allowed_origins` empty, no CORS headers are emitted and every cross-origin browser request fails (`crates/issuerd-server/src/routes.rs`). Only the `Authorization` and `Content-Type` request headers are allowed, and credentialed (cookie-carrying) cross-origin requests are not enabled. | Add the exact origin — scheme + host + port: `[cors] allowed_origins = ["https://app.example.com"]`. Invalid entries are skipped with a WARN at startup. |
| CORS configured on the **client** (`web_origins`) but the browser is still blocked | `web_origins` is not server CORS: it only feeds the `allowed_origins` token claim via the AllowedWebOrigins protocol mapper (`crates/issuerd-server/src/claims.rs`). | Set `[cors] allowed_origins` for the browser-facing server policy; keep `web_origins` for the claim. See [client-integration.md](/client-integration/). |
| Login succeeds but the browser lands back on the login page (SSO loop) | The SSO cookie `issuerd_session_{realm-id}` never sticks. Authentication cookies carry the `Secure` flag exactly when `issuer_url` is `https://` (`crates/issuerd-server/src/config.rs`, `ServerConfig::secure_cookies`), and browsers drop `Secure` cookies that arrive over `http://` (any origin other than localhost). The classic cause is reaching the server over plain HTTP while `issuer_url` is HTTPS — e.g. hitting a node directly, bypassing the TLS-terminating proxy. | Reach the server the way `issuer_url` advertises: over HTTPS (direct `[tls]` or a TLS-terminating proxy — see [deployment.md](/deployment/)). For plain-HTTP dev rigs point `issuer_url` at an `http://` URL — no `Secure` flag is emitted then — or use `localhost`, which browsers exempt either way. |
| "The sign-in session is invalid or has expired — please start again" mid-login | The pending-auth entry or its `issuerd_flow_{id}` correlation cookie is gone: the 10-minute flow TTL elapsed, Redis was flushed/restarted (pending auth lives in the cache), the login POST came from a different browser/tab than the authorize request, or requests hopped between nodes that do not share a cache (split-brain — see [Cluster problems](#cluster-problems)). | Restart the login. If it reproduces constantly, check Redis stability and, behind an LB, that every node points at the same Redis. |
| Authorize/login otherwise succeeds but the client gets `error=temporarily_unavailable` (browser redirect) or HTTP 503 `{"error":"temporarily_unavailable"}` (SPA/API login) | Authorization-code persistence is **fail-closed**: a code is only released after the cache confirms the write (`auth_code:{code}`). When Redis is down (or the write otherwise fails) the server logs ERROR `failed to persist authorization code`, records a `login_error` event, and never emits the code — an unpersisted code could never be exchanged anyway. | Restore cache health — check `curl -s http://localhost:8080/ready` for `{"dependency":"cache"}` — and retry. The retry is safe and usually transparent: the SSO session was already created, so the user is not re-prompted. |
| Brute-force lockouts hit many users at once / all failures attributed to one IP | `X-Forwarded-For`/`X-Real-IP` are honored **only** when the direct peer matches `[proxy] trusted_proxies` (empty by default), even though the trust flags default to `true` (`crates/issuerd-server/src/middleware/proxy_ip.rs`). With an empty list, every request is attributed to the LB's IP, and login-failure counters (`login-failure:{realm}:{username}:{ip}` — keyed per username and IP) aggregate across users. Within XFF, the rightmost untrusted entry wins. | Set `trusted_proxies` to your LB/proxy subnet, e.g. `["10.0.0.0/8"]` — the cluster compose stack does exactly this ([CLUSTERING.md](/clustering/)). |
| Theme edits have no effect | Theme assets are read from disk **on every request** from `{themes.dir}/{login_theme}/{path}` with a per-file fallback to the built-in `issuerd` theme (`crates/issuerd-server/src/routes/theme.rs`) — there is no server-side cache to flush. The usual causes: editing a different directory than the daemon's `[themes] dir` (relative paths resolve against the daemon's working directory), the realm's `login_theme` not matching the subdirectory name, or the browser's cache. In containers, verify the path **inside** the container/image. | Confirm the realm's theme, the daemon's working directory, and hard-refresh the browser. Unknown files return 404; path-traversal attempts return 400. |

## Token problems

| Symptom | Likely cause | Fix |
|---|---|---|
| After an upgrade, every client gets 401 / issuer validation errors | Issuer URLs embed the realm **name** (`{issuer_url}/realms/{name}`); tokens and session cookies carrying the old realm-**id** issuer are rejected by design (`ServerState::resolve_issuer_realm`, `crates/issuerd-server/src/state.rs`; [CLUSTERING.md](/clustering/) "Rolling-upgrade caveat"). | Users and clients must re-authenticate; outstanding tokens cannot be salvaged. For clusters, do a full restart of all nodes for this transition, not a rolling upgrade. |
| `invalid_grant` on the refresh-token grant | Many distinct causes, all returning the same error (`crates/issuerd-server/src/routes/oidc.rs`, refresh branch). See the breakdown below. | Match the daemon's WARN line for the request to a cause below; fix that one. |
| Resource servers reject tokens right after a key rotation | JWKS staleness. Each node polls the shared `signing_keys` table every `cluster.jwks_refresh_interval_secs` (default 30s); the admin endpoints (`POST /admin/realms/{realm}/keys/rotate`, `PUT .../keys/{kid}/disable`) trigger an **immediate** reload only on the node that served the call — peers converge within one poll interval. Disabled keys stay published in JWKS until tokens signed with them expire (`crates/issuerd-core/src/models.rs`). | Wait one interval, or lower `jwks_refresh_interval_secs`. Compare per-node key sets directly: `curl http://<node>:<port>/realms/{realm}/protocol/openid-connect/certs`. See [security.md](/security/) for rotation procedure. |
| `expired`/`ImmatureSignature`-style validation failures across clients | Clock skew. Issuerd validates `exp`/`nbf`/`iat` with 60 seconds of leeway (the token manager's clock-skew window, `crates/issuerd-server/src/state.rs`); `private_key_jwt` assertions additionally must expire within 300 seconds (`crates/issuerd-token/src/client_assertion.rs`), and DPoP proofs allow 60s of future `iat`. | Sync all parties with NTP. If only one client fails, suspect that client's clock, not the server. |
| UserInfo returns `401` with `{"error":"invalid_token"}` where Keycloak returns an empty 401 | Intentional divergence from Keycloak 24 ([tests/KEYCLOAK_DIFFS.md](https://github.com/issuerd/issuerd/blob/main/tests/KEYCLOAK_DIFFS.md) #3). | Treat any 401 as "token rejected"; do not parse the body for control flow. |
| Client authentication failures return `400` + `invalid_client` where Keycloak returns `401` | Intentional divergence ([tests/KEYCLOAK_DIFFS.md](https://github.com/issuerd/issuerd/blob/main/tests/KEYCLOAK_DIFFS.md) #1): RFC 6749 §5.2 permits `400` for non-Authorization-header client auth. | Accept both status codes in client code. |
| `invalid_grant` on code exchange, and previously issued tokens stop working | Authorization-code **reuse detection**: presenting an already-redeemed code revokes the access/refresh tokens issued for the first redemption and emits a `CODE_TO_TOKEN_ERROR` event (`oidc.rs`). Usual triggers: double form submission, client retry logic without idempotency, or a replayed back-channel request. | Fix the client to redeem each code exactly once. If you did not retry, treat it as a possible code leak. |
| A user/client/role/scope edit made **directly in the database** is not reflected in tokens, userinfo, or discovery for up to 60 s | The read-model caches (`user-claims:`, `realm-catalog:`, `uinfo-resp:`, `discovery-resp:`, …) are invalidated precisely only when the mutation goes through the Admin API or the server's own write paths; a direct DB edit bypasses invalidation, so the entry TTL (`[cache] read_cache_ttl_secs`, default 60 s) is the only bound. | Make changes through the Admin API (precise, immediate invalidation), or set `read_cache_ttl_secs = 0` for pure-DB behavior. |
| DPoP requests fail with `400`/`401` + `use_dpop_nonce` | The server runs `[dpop.nonce] mode = "supported"`/`"required"` and the proof's `nonce` claim is missing, stale, or already used (nonces are single-use with a short TTL). The response carries a fresh nonce in the `DPoP-Nonce` header — this is the RFC 9449 §8/§9 retry signal, not an outage. | Retry the request once with a new proof echoing the header's nonce. If every request fails (not just the first), check that the client actually reads `DPoP-Nonce`; on a cache (Redis) outage nonce verification fails closed, so restore the cache or set `mode = "disabled"`. |

**`invalid_grant` on refresh — cause breakdown** (all verified in the refresh branch of `crates/issuerd-server/src/routes/oidc.rs`):

- **The token was already rotated.** Every successful refresh revokes the *presented* refresh token (cache marker `revoked_refresh:{token}` with TTL = its remaining lifetime). A client that retries with the old token instead of storing the new one fails from then on. Note the revocation blocklist lives in the cache: wiping Redis resurrects still-unexpired rotated tokens ([CLUSTERING.md](/clustering/) "Redis is ephemeral").
- **The session is gone or idle-expired.** The session row must still exist; offline sessions use the realm's `offline_session_idle_timeout`, remembered sessions `remember_me_session_idle_secs`, plain sessions `sso_session_idle_timeout` — an idle-expired session is deleted on the spot. Logout, admin session revocation, and user disable all land here too.
- **Realm `not_before` cutoff.** An admin "revoke tokens before" action invalidates every token issued before the timestamp.
- **Client binding mismatch.** The refresh token's `aud` must equal the presenting client — tokens cannot be laundered across clients.
- **DPoP binding.** A DPoP-bound refresh token requires a proof from the same key; a missing or mismatched proof is rejected.
- **Scope widening** on the refresh request returns `invalid_scope` (not `invalid_grant`): the requested scope must be a subset of the original grant.

## Email delivery problems

Background: email is **disabled by default** — until `[smtp] enabled = true`, the server wires a no-op sender that *fails loudly* (`crates/issuerd-server/src/email.rs`, `NoOpEmailSender`) so a missing SMTP setup can never silently swallow verification mails. Realm-level overrides follow the Keycloak `smtpServer.*` attribute model (`SmtpConfig::for_realm`, `crates/issuerd-server/src/config.rs`).

| Symptom | Likely cause | Fix |
|---|---|---|
| Verify-email / reset-password / execute-actions-email fails with `SMTP is not configured: set [smtp] enabled = true (and host/port/from) before enabling email flows` | Working as designed: an email flow is enabled (realm `verify_email`, reset-credentials, the email-code login authenticator) but SMTP is off. | Configure `[smtp]` (below) or turn the email flow off. |
| Errors `smtp send: ...`, `smtp relay config ...`, or `smtp starttls config ...` in the log; no mail arrives | Wrong host/port/credentials, or the server requires a different TLS mode. SMTP connections time out after 10 seconds. Credentials are sent only when **both** `username` and `password` are set. At DEBUG, each attempt logs `sending email` with the effective host/port. | Probe the server with the raw SMTP recipe below, then align `[smtp]` with what the probe shows. |
| `starttls` vs `ssl` confusion — connection hangs or is refused | The flags select different transports (`email.rs`): `ssl = true` → implicit TLS from the first byte (typical port 465); `starttls = true` → plaintext connect then STARTTLS upgrade (typical port 587); both false → **plaintext** (a local dev sink only — never for production). | Match the flag to your MTA's listener. Do not set both; `ssl` wins if you do. |
| Per-realm overrides ignored | Realm attributes must be named exactly `smtpServer.host`, `smtpServer.port`, `smtpServer.from`, `smtpServer.fromDisplayName`, `smtpServer.replyTo`, `smtpServer.starttls`, `smtpServer.ssl`, `smtpServer.user`, `smtpServer.password`. Each key overrides independently; unset keys fall back to the global `[smtp]`. Flag values are the literal string `"true"`; an unparsable `smtpServer.port` is ignored. **`enabled` is global-only** — a realm cannot turn email on by itself. | Fix the attribute names/values via the realm's attributes (admin console or `PUT /admin/realms/{realm}`). |
| "Link expired" on verify/reset links | Verify-email links live 24 hours; reset-credentials links 15 minutes (`crates/issuerd-server/src/email.rs`). Reset links are also single-use. | Request a fresh email. |

**Testing with a local sink (dev/staging).** Point `[smtp]` at any SMTP sink (e.g. Mailpit on `127.0.0.1:1025`, no auth/TLS):

```toml
[smtp]
enabled = true
host = "127.0.0.1"
port = 1025
from = "issuerd@test.internal"
starttls = false
ssl = false
```

Probe the sink without Issuerd to separate MTA problems from server config:

```bash
printf 'Subject: probe\r\nFrom: a@b.c\r\nTo: d@e.f\r\n\r\nbody\r\n' > /tmp/msg.eml
curl --url smtp://127.0.0.1:1025 --mail-from a@b.c --mail-rcpt d@e.f -T /tmp/msg.eml
```

If the probe fails, the problem is the MTA/network, not Issuerd.

## User federation problems

The full configuration reference (provider keys, sync semantics, test rigs) is [user-federation.md](/user-federation/); this section is the symptom map. The fastest diagnostic is a manual sync, which returns per-user outcome counts and surfaces provider errors directly:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:8080/admin/realms/myrealm/user-federation/<provider-uuid>/sync
# → {"added":...,"updated":...,"removed":...,"failed":...,"last_sync":...}
```

| Symptom | Likely cause | Fix |
|---|---|---|
| Bind failures / `InvalidCredentials` from the directory | `bindDn` is passed **verbatim** to the LDAP simple bind — AD wants a full DN (`CN=issuerd-bind,OU=Service Accounts,DC=corp,DC=example`), generic LDAP its own DN format. Wrong `bindCredential`, or the server requires `useStartTls: "true"`/LDAPS. | Verify the credentials with `ldapsearch -D <bindDn> -w ...` against the same `connectionUrl` before touching Issuerd. |
| Sync completes but zero users imported | `usersDn` points at the wrong subtree, `searchScope` (`SUBTREE`/`ONELEVEL`/`BASE`) is too narrow, `customUserSearchFilter` excludes everything, or the username attribute default does not match the directory (`sAMAccountName` for AD/Samba vendors, `uid` for generic; `crates/issuerd-federation/src/ldap/config.rs`). | Run the equivalent search manually (`ldapsearch -b <usersDn> "<filter>"`), then align `usersDn`/scope/filter. Check the sync result's counters for silent per-user failures. |
| Groups do not appear on synced/federated users | Group mapping is off unless the provider config carries `groupsDn`; group names come from the CNs of the user's `memberOf` DNs under that subtree (optional `groupNameLdapAttribute`/`memberOfLdapAttribute`/`groupsInclude` allowlist). | Set `groupsDn` to the groups subtree and re-sync. See "Group mapping semantics" in [user-federation.md](/user-federation/). |
| Groups were **removed** after a sync | Authoritative semantics: once `groupsDn` is set, the reported group set is authoritative — a user whose `memberOf` matches nothing gets memberships reconciled to empty (only memberships carrying the `ldap_sync` marker are ever removed). A typo'd `groupsDn` therefore wipes marker-carrying memberships instead of failing. | Fix `groupsDn`, re-sync. Keep hand-managed group memberships on groups outside the sync's authority. |
| Kerberos/SPNEGO errors for the **whole realm** after adding a kerberos provider | With `allowKerberosAuthentication: "true"` the `keyTab` file must exist and be readable — otherwise provider loading fails for every federation lookup in that realm. | Fix the keytab path/permissions, or disable the provider. Kerberos also needs a reachable KDC, working `krb5.conf` on the Issuerd host, synchronized clocks (Kerberos tolerates only small skew), and consistent DNS for the KDC and the service hostname. Unix-only: on Windows builds the provider returns `NotSupported`. See [user-federation.md](/user-federation/#kerberos-and-spnego). |
| Password changes for AD users fail | AD only accepts `unicodePwd` writes over a secure channel. | Point `connectionUrl` at `ldaps://<dc>:636` (or enable StartTLS) — details in [user-federation.md](/user-federation/#active-directory-specifics). |

## Identity brokering problems

Broker-specific troubleshooting is covered in depth in [identity-brokering.md](/identity-brokering/#troubleshooting) (redirect-URI registration, state TTL, `test-connection`, claim mapping, clock skew, `trustEmail` behavior). The three most frequent cases:

- **The external IdP rejects the redirect.** The redirect URI registered at the IdP must be exactly `{issuer_url}/realms/{realm-name}/broker/{alias}/endpoint` (realm **name**; a trailing slash on `issuer_url` is trimmed — `callback_url` in `crates/issuerd-server/src/routes/broker.rs`). If `issuer_url` is an internal address, the IdP can never call back correctly — it must be the public base URL.
- **"The sign-in session is invalid or has expired — please start again" at the callback.** The broker `state` entry is single-use with a 10-minute TTL and lives in the shared cache: expired, already consumed (browser back button / double callback), or lost to a cache flush.
- **Code exchange fails after the IdP redirect.** Watch for WARN `brokered code exchange failed` / `IdP token endpoint returned non-success` — wrong client secret, unreachable token endpoint, or id_token validation failure (60s of clock-skew leeway). Run `POST /admin/realms/{realm}/identity-provider/instances/{alias}/test-connection` for a config-level diagnosis.

## Cluster problems

The full multi-node guide is [CLUSTERING.md](/clustering/); its "Operational notes & limitations" section is the authoritative list. The recurring operational issues:

| Symptom | Likely cause | Fix |
|---|---|---|
| A node refuses to boot with the `cluster.enabled requires ...` error | The split-brain boot contract: cluster mode demands shared PostgreSQL + Redis so auth codes, pending logins, and revocation entries are redeemable on every node. | Satisfy the contract — see [Startup failures](#startup-failures). |
| An auth code issued on node A is `invalid_grant` on node B | Some node is silently on the in-process cache (no `redis` key configured → per-node `InMemoryCache`, `crates/issuerd-server/src/state.rs`). This is the exact split-brain the boot guard exists to catch. | Point every node at the same Redis; enable `cluster.enabled` so misconfiguration fails at boot instead of at login. |
| Peers keep rejecting tokens signed with a newly rotated key | The rotating node reloaded immediately (the admin rotate/disable endpoints invoke the same-node reload hook); every other node waits for its storage poll — `cluster.jwks_refresh_interval_secs`, default 30s. | Wait one interval or lower the interval. Verify per node: `curl http://<node>:<port>/realms/{realm}/protocol/openid-connect/certs` (the compose stack exposes nodes on 18081/18082 for exactly this). |
| 502s from nginx after recreating a node container | nginx resolves upstream hostnames **once** at startup; a recreated container with a new IP leaves the LB pointing at the dead one ([CLUSTERING.md](/clustering/)). | `docker compose -f docker-compose.cluster.yml restart lb`. |
| Features depending on the cluster event bus silently absent with `cluster.redis_nodes` | Redis Cluster mode implements the cache commands but **not pub/sub** — the event bus is unavailable there. Key propagation uses storage polling, so clustering correctness is unaffected ([CLUSTERING.md](/clustering/)). | None required; use single-node `redis` if you need pub/sub. |
| Metrics look wrong / differ per scrape | `/metrics` is per-node state; the LB distributes scrapes across nodes. | Scrape each node directly and aggregate in Prometheus ([CLUSTERING.md](/clustering/), [monitoring.md](/monitoring/)). |
| Tokens/sessions die when Redis is restarted | By design Redis is ephemeral: a wipe loses in-flight logins (users retry) and revocation-blocklist entries; sessions and issued JWTs are unaffected. | Treat Redis as disposable; if you see session loss, the real cause is elsewhere (PostgreSQL). |

## Performance problems

If login or token throughput is the complaint, start from the baseline rather than guessing: [PERFORMANCE.md](/performance/) lists the measured targets (token issuance < 2 ms p99, stateless validation < 0.5 ms p99 on the test harness) and how to reproduce them — the ignored integration benchmarks in `tests/integration/bench.rs` (`cargo test --test integration -- --ignored --nocapture`). Before benchmarking, rule out the operational causes above: a saturated PostgreSQL (the storage pool caps at 20 connections, `crates/issuerd-storage/src/postgres.rs`), an unreachable-then-timing-out Redis or SMTP server (each adds its timeout to the request path), or reverse-proxy latency. Prometheus metrics (`/metrics`) and the per-request timing logs at DEBUG are the first stop — see [monitoring.md](/monitoring/).

## Still stuck

- **Check whether the behavior is an intentional Keycloak divergence.** [tests/KEYCLOAK_DIFFS.md](https://github.com/issuerd/issuerd/blob/main/tests/KEYCLOAK_DIFFS.md) records every known behavioral difference from Keycloak 24 with its rationale — including the ones operators actually trip over: `400` vs `401` for `invalid_client` (#1), the JSON 401 body on UserInfo (#3), logout status codes (#4), and the smaller built-in client-scope set. If Keycloak behaves differently, that document tells you whether it is deliberate.
- **Check the conformance evidence.** Issuerd passes the OIDC conformance suite (Config OP, Basic OP, Form Post OP, 0 failures) — results live under `tests/conformance/`. A client that fails against a conformant profile usually has a client-side bug; a failure that the suite covers is a strong bug report.
- **File a useful bug report.** Include:
  1. The exact version (`issuerd --version`).
  2. The configuration **minus secrets** (redact DB URLs, SMTP passwords, client secrets) — plus how it is deployed (binary, container, compose stack) and which storage/cache backends are active.
  3. The failing request/response pair from curl, with its `x-request-id`, and the log lines carrying that request id (at `-v`/DEBUG if reproducible).
  4. `/ready` output at the time of failure.
  5. Reproduction steps, the expected behavior, and — if you compared against Keycloak — how Keycloak 24 behaved for the same request.
