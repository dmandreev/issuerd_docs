---
title: "Configuration"
description: "This document is the complete reference for the Issuerd server configuration file (issuerd.toml). It is written for system operators and administrators who deploy and run Issuerd. Every key,…"
---

This document is the complete reference for the Issuerd server configuration
file (`issuerd.toml`). It is written for system operators and administrators
who deploy and run Issuerd. Every key, default, and behavior described here is
implemented in `crates/issuerd-server/src/config.rs` and the daemon startup path
(`src/main.rs`, `crates/issuerd-server/src/state.rs`). For first-time setup see
[getting-started.md](/getting-started/); for realm/client content as code see
[provisioning.md](/provisioning/).

## Contents

- [How configuration is loaded](#how-configuration-is-loaded)
- [Minimal configurations](#minimal-configurations)
- [Root keys](#root-keys)
- [[storage]](#storage)
- [[tls]](#tls)
- [[logging]](#logging)
- [[web_ui]](#web_ui)
- [[proxy]](#proxy)
- [[cors]](#cors)
- [[cluster]](#cluster)
- [[cache]](#cache)
- [[themes]](#themes)
- [[smtp]](#smtp)
- [Complete annotated example](#complete-annotated-example)
- [Generating the example config](#generating-the-example-config)

## How configuration is loaded

Configuration is assembled from three layers, later layers winning:

1. **Built-in defaults** — every key has one (see the reference tables below).
   With no file and no environment, the daemon boots on in-memory storage,
   plain HTTP on `0.0.0.0:8080`.
2. **Config file** — passed with `-c` / `--config`:
   ```bash
   issuerd daemon -c /etc/issuerd/issuerd.toml
   ```
   The default path is `issuerd.toml`, resolved against the daemon's working
   directory. The same flag exists on `issuerd provision` (which reads the
   config only for the storage connection and `issuer_url`). The file format is
   inferred from the extension: `.toml`, `.yaml` / `.yml`, or `.json`
   (an unknown or missing extension is parsed as TOML). The examples in this
   document use TOML.
3. **Environment overrides** — every variable prefixed with `ISSUERD_` is
   merged on top of the file. `__` (double underscore) is the nesting
   separator and variable names are lowercased before mapping:

   | Environment variable | Overrides |
   |---|---|
   | `ISSUERD_PORT=9090` | `port` |
   | `ISSUERD_BIND=127.0.0.1` | `bind` |
   | `ISSUERD_ISSUER_URL=https://idp.example.com` | `issuer_url` |
   | `ISSUERD_REDIS=redis://redis:6379` | `redis` |
   | `ISSUERD_CLUSTER__ENABLED=true` | `cluster.enabled` |
   | `ISSUERD_CLUSTER__JWKS_REFRESH_INTERVAL_SECS=15` | `cluster.jwks_refresh_interval_secs` |
   | `ISSUERD_CACHE__READ_CACHE_TTL_SECS=0` | `cache.read_cache_ttl_secs` |
   | `ISSUERD_SMTP__ENABLED=true` / `ISSUERD_SMTP__HOST=mail.example.com` | `smtp.enabled` / `smtp.host` |
   | `ISSUERD_PROXY__TRUST_X_FORWARDED_FOR=false` | `proxy.trust_x_forwarded_for` |

   The shipped cluster stack uses this mechanism for per-node identity
   (`ISSUERD_CLUSTER__NODE_ID` in `docker-compose.cluster.yml`), so the same
   file can be mounted into every node.

> **Warning:** list-valued keys (`cors.allowed_origins`, `proxy.trusted_proxies`,
> `cluster.redis_nodes`) cannot be expressed reliably as a single environment
> variable — set them in the config file (the cluster guide documents
> `cluster.redis_nodes` as TOML-only, see [CLUSTERING.md](/clustering/)).

Behavioral notes:

- **Missing file is not an error.** If the `-c` path does not exist, it is
  silently skipped and the daemon runs on defaults + environment. A typo in
  the path therefore boots a default server instead of failing — check the
  `loaded configuration` startup log line when in doubt.
- **Invalid content fails the boot.** A file that parses but has the wrong
  type for a key (e.g. `port = "abc"`) aborts startup with
  `config load failed: ...`.
- **Unknown keys are ignored.** Misspelled keys do not cause an error — they
  silently have no effect.
- Environment overrides apply to every subcommand that loads configuration
  (`daemon`, `provision`).

## Minimal configurations

**Development / evaluation (in-memory, zero dependencies):**

```toml
# Everything else takes defaults: in-memory storage, plain HTTP on
# 0.0.0.0:8080, no Redis, no TLS.
issuer_url = "http://localhost:8080"
```

The root `issuerd.toml` in the repository is a working example of this rig.
With in-memory (or JSON-file) storage the `master` realm is bootstrapped
automatically on first start (admin user `admin`/`admin`); see
[getting-started.md](/getting-started/).

**Production (PostgreSQL + Redis, TLS terminated at a proxy):**

```toml
bind       = "0.0.0.0"
port       = 8080
issuer_url = "https://idp.example.com"   # public URL, as clients reach the proxy

redis = "redis://redis:6379"

[storage.postgres]
url = "postgres://issuerd:SECRET@postgres:5432/issuerd"

[proxy]
trusted_proxies = ["10.0.0.0/8"]   # your load balancer / ingress subnet
```

Modeled on `examples/issuerd.demo.toml` (the demo stack's production-shaped
config). With PostgreSQL, automatic master-realm bootstrap does **not** run —
define `master` in a provision file (see `examples/provision.demo.yaml` and
[provisioning.md](/provisioning/)) or create it via the Admin API.

## Root keys

| Key | Type | Default | Description |
|---|---|---|---|
| `bind` | string (IP literal) | `"0.0.0.0"` | Interface to bind. Parsed as an IP literal, so IPv6 (`"::"`, `"::1"`) works. A name or invalid literal fails the boot. |
| `port` | integer | `8080` | TCP port for HTTP (or HTTPS when `[tls]` is set). |
| `issuer_url` | string (URL) | `"http://localhost:8080"` | Public base URL of this server. See the deep-dive below. |
| `redis` | string (URL), optional | unset | Single Redis node, e.g. `"redis://localhost:6379"` (`rediss://` for TLS). Unset ⇒ in-process ephemeral cache. Overridden by `cluster.redis_nodes` when that list is non-empty. |
| `provision` | path, optional | unset | Provision file (YAML/TOML/JSON by extension) applied **exactly once** at startup — a marker is claimed in storage before applying, so restarts and concurrent first boots skip it. Relative paths resolve against the working directory. A missing/unreadable file logs an error and boot continues. Format: [provisioning.md](/provisioning/). |

### About `issuer_url`

This is the most consequential value in the file:

- It must be an **absolute `http(s)` URL** — anything else aborts the boot
  with `issuer_url must be an absolute http(s) URL`.
- It is baked into every token's `iss` claim and into the OIDC discovery
  document as `{issuer_url}/realms/{realm-name}` (the realm **name**, never
  the internal UUID). Clients validate `iss` strictly, so `issuer_url` must be
  exactly how browsers and applications reach the server — scheme, host, and
  port included. If you terminate TLS at a proxy, `issuer_url` keeps the
  public `https` scheme even though the daemon itself serves plain HTTP.
- In a cluster it must be the load balancer's URL and **identical on every
  node** (see [CLUSTERING.md](/clustering/)).
- Changing it later effectively changes every realm's issuer: outstanding
  tokens, sessions, and stored client configurations that reference the old
  issuer stop validating, and users must re-authenticate. Treat it as
  permanent once realms are in use.

## [storage]

The persistent store for realms, users, clients, sessions, signing keys, and
events. Exactly one variant is active; the default is in-memory (no section at
all).

| Variant | TOML shape | Durability | Use for |
|---|---|---|---|
| In-memory (default) | *(omit the section)* | None — empty on every boot | Development, tests, demos |
| PostgreSQL | `[storage.postgres]` + `url` | Durable, shared between nodes | Production, clusters |
| JSON file | `[storage.json_file]` + `path` | Durable, single node | Manual testing, small single-node rigs |

```toml
# PostgreSQL — recommended for production.
[storage.postgres]
url = "postgres://issuerd:issuerd_secret@localhost:5432/issuerd"
```

- Schema migrations are **applied automatically at boot** (and by the
  `issuerd provision` subcommand), so upgrades only require starting the new
  binary. See [backup-and-upgrade.md](/backup-and-upgrade/).
- This is the only backend that supports multi-node clusters (see
  [[cluster]](#cluster)) — in a cluster, token issuance is shared between
  nodes via the shared `signing_keys` table.

```toml
# JSON file — full-state snapshot persistence.
[storage.json_file]
path = "issuerd-data.json"
```

- The entire state is loaded from the file at boot and **rewritten in full on
  every write**, serialized through a global lock — correct but slow, so it is
  meant for manual testing and single-node rigs, not production traffic.
- Like in-memory, it triggers the automatic master-realm bootstrap on first
  start.

> **Note:** with in-memory storage, JWT signing keys are generated per boot,
> so all outstanding tokens are invalidated by a restart. The JSON-file
> backend persists them in its snapshot; with PostgreSQL they live in the
> shared `signing_keys` table — both survive restarts and redeploys.

## [tls]

Optional. When present, the daemon itself serves HTTPS via rustls (TLS 1.2+);
when absent, it serves plain HTTP.

| Key | Type | Description |
|---|---|---|
| `cert_path` | path (PEM) | Certificate chain file. |
| `key_path` | path (PEM) | Private key file. |

```toml
[tls]
cert_path = "certs/idp.example.com.crt"
key_path  = "certs/idp.example.com.key"
```

Both files are read at startup; unreadable or unparsable PEM fails the boot.
Paths are resolved against the working directory.

In most production deployments it is simpler to **terminate TLS at a reverse
proxy or load balancer** and run Issuerd on plain HTTP behind it. If you do,
remember that `issuer_url` still uses the public `https` scheme, and configure
[[proxy]](#proxy) so the daemon sees real client IPs. See
[deployment.md](/deployment/) and [security.md](/security/).

## [logging]

| Key | Type | Default |
|---|---|---|
| `format` | string | `"pretty"` |
| `level` | string | `"info"` |

`level` is one of `error`, `warn` (alias `warning`), `info`, `debug`,
`trace`. `format` is
`pretty` (human-readable console text) or `json` (one JSON object per event,
for log shippers). Unparsable values fall back to the defaults with a WARN at
startup.

The effective log level is resolved with this precedence:

1. **`RUST_LOG`** — when set, it wins completely. Any standard `tracing`
   EnvFilter directive string is accepted, e.g.
   `RUST_LOG=issuerd_server=debug,issuerd_storage=warn` for per-crate control.
2. **`-v` / `-q` CLI flags** (global, repeatable): default is `info`;
   `-v` → `debug`; `-vv` (or more) → `trace`; `-q` → `warn`; `-qq` (or
   more) → `error`.
   ```bash
   issuerd -v daemon -c issuerd.toml
   ```
3. **`[logging].level`** from the config file.

The flag/config level is applied to Issuerd's own crates (`issuerd`,
`issuerd_server`, `issuerd_core`, `issuerd_auth_flow`, `issuerd_protocol`, `issuerd_token`,
`issuerd_storage`, `issuerd_cluster`, `issuerd_admin_api`, `issuerd_federation`); use `RUST_LOG`
to also tune dependencies such as `sqlx` or `tower`.

Notes on output:

- `format` applies to the **console** output only. On Linux under systemd
  (when `JOURNAL_STREAM` is set) logs go to **journald** in its own
  structured format instead; if journald initialization fails, the daemon
  prints a notice to stderr and falls back to console formatting.
- ANSI colors are emitted only when stdout is a terminal, so piped and
  container logs stay free of escape codes. (On Windows the console ANSI
  support is enabled explicitly at startup.) The JSON formatter never emits
  ANSI.
- Records from dependencies that log through the `log` facade (ldap3, redis,
  reqwest, rustls, sqlx, …) are bridged into tracing and filtered by the
  same directives.

See [monitoring.md](/monitoring/) for metrics and health endpoints.

## [web_ui]

| Key | Type | Default |
|---|---|---|
| `enabled` | boolean | `true` |

> **Warning:** this key is currently **parsed but not consulted**. The
> consoles are served whenever the SPA assets were embedded
> into the binary at build time — release builds embed them — and there is no
> runtime switch to turn them off.

The served surfaces are the admin console at `/admin/console` and the account
console at `/realms/{realm}/account`. If the assets were not embedded (a
debug build without `webclientsrc/dist`), those paths answer `404`; the Admin
API under `/admin/...` and all protocol endpoints are unaffected either way.

## [proxy]

Controls how the daemon determines the **real client IP** when it sits behind
a reverse proxy or load balancer.

| Key | Type | Default | Description |
|---|---|---|---|
| `trusted_proxies` | list of strings | `[]` | IPs or CIDR ranges of your proxies, e.g. `["10.0.0.1", "172.32.0.0/24"]`. Forwarded headers are honored **only** when the direct peer matches an entry. |
| `trust_x_forwarded_for` | boolean | `true` | Honor `X-Forwarded-For` from trusted peers. Within the header, the rightmost entry that is not itself a trusted proxy wins (entries to its right were appended by proxies you trust). |
| `trust_x_real_ip` | boolean | `true` | Honor `X-Real-IP` from trusted peers (used when XFF yields nothing). |

```toml
[proxy]
trusted_proxies = ["172.32.0.0/24"]   # subnet of your LB / ingress
trust_x_forwarded_for = true
trust_x_real_ip = true
```

With the default empty `trusted_proxies`, the trust flags are inert: every
forwarded header is ignored and the direct peer's address is used — the safe
behavior when no proxy is in front.

> **Warning:** getting this wrong breaks brute-force protection. Login-failure
> counters are keyed by client IP (`login-failure:{realm}:{username}:{ip}`).
> If `trusted_proxies` is empty behind an LB, every user appears to come from
> the LB's address, so per-IP lockouts aggregate all users into one bucket; if
> you trusted headers from untrusted peers, attackers could spoof their IP to
> dodge lockout. List exactly the proxy subnets. See [security.md](/security/)
> and the LB requirements in [CLUSTERING.md](/clustering/).

## [cors]

| Key | Type | Default |
|---|---|---|
| `allowed_origins` | list of strings | `[]` |

Cross-origin browser access is **fully locked down by default**: with an empty
list the server emits no CORS headers, so browsers block all cross-origin
calls. The embedded admin and account consoles are same-origin and need no
CORS; non-browser clients (service-to-service) are unaffected.

Add exact origins — scheme + host + port, no wildcards — only for browser
applications hosted on other origins:

```toml
[cors]
allowed_origins = ["https://app.example.com", "https://spa.internal:3443"]
```

Allowed methods are `GET, POST, PUT, PATCH, DELETE, OPTIONS` and allowed
headers are `Authorization` and `Content-Type`. Entries that are not valid
header values are skipped with a startup warning. Cross-origin applications
also need the origin in their client registration (`web_origins`); see
[client-integration.md](/client-integration/).

## [cluster]

Opt-in multi-node mode. The full guide, including the load balancer contract
and the Docker Compose demo, is [CLUSTERING.md](/clustering/); this section
is the key reference.

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Enforce the multi-node contract at boot (below). |
| `node_id` | string, optional | `$HOSTNAME`, else a random id | Stable node identity, used for log correlation only. |
| `redis_nodes` | list of strings | `[]` | Redis Cluster node URLs, e.g. `["redis://r1:6379", "redis://r2:6379"]`. When non-empty, **overrides** the single-node `redis` URL. |
| `jwks_refresh_interval_secs` | integer | `30` | How often the node re-reads the shared signing-key set from storage and reloads its keystore + JWKS snapshot, so keys rotated by peers propagate without a restart. |

```toml
[cluster]
enabled = true
node_id = "node-1"
redis_nodes = []
jwks_refresh_interval_secs = 30
```

**Boot-time contract:** with `enabled = true`, boot **fails** unless storage
is PostgreSQL **and** a Redis cache is configured (`redis` or
`cluster.redis_nodes`), with the error
``cluster.enabled requires PostgreSQL storage and a Redis cache (set `redis` or `cluster.redis_nodes`)``.
This refuses
split-brain configurations where, for example, an authorization code issued on
node A could not be redeemed on node B. The JWKS refresh task only runs with
PostgreSQL storage — the other backends are single-node by definition and have
nothing to poll.

## [cache]

One knob governs every read-model cache on the token hot paths.

| Key | Type | Default | Description |
|---|---|---|---|
| `read_cache_ttl_secs` | integer | `60` | TTL in seconds of every read-model cache entry. `0` disables all read-model caches (every lookup hits storage — pre-cache behavior). |

The read model keeps per-request work off the database: session-validity
snapshots behind `userinfo`/`introspect`, the realm-by-name resolution cache,
the claims read model (per-user claims bundles, the realm role/scope catalog,
client bundles and default scope assignments), and the rendered
userinfo/discovery response caches.

Mutations through the Admin API and the server's own write paths invalidate
precisely — single-entity changes delete their keys, realm-wide definition
changes bump an epoch — so committed writes are visible immediately. A write
that bypasses both (e.g. a direct database edit) stays hidden for at most
`read_cache_ttl_secs`: the consciously accepted bounded-staleness window, the
same class as Keycloak's Infinispan propagation. Set `0` for pure-DB behavior
(useful in tests, or when debugging unexpected staleness).

## [themes]

| Key | Type | Default |
|---|---|---|
| `dir` | path | `"themes"` |

Root directory of login-theme assets, one subdirectory per theme. Relative
paths resolve against the daemon's working directory. The repository ships the
built-in default theme at `themes/issuerd`.

- A realm's `login_theme` setting (realm configuration in the admin console /
  Admin API — see [administration.md](/administration/)) selects the
  directory; assets are served at `/realms/{realm}/theme/{path}`.
- Fallback is per file: anything a custom theme does not provide is served
  from the built-in `issuerd` theme, so a custom theme only ships the files
  it overrides (e.g. just `login.css`).
- A theme may also carry `messages_{locale}.json` bundles that merge over the
  built-in login/email translations.

## [smtp]

Email is used for address verification, password reset, execute-actions
emails, and the optional email-code login flow.

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Master switch. |
| `host` | string | `"127.0.0.1"` | SMTP server hostname/IP. |
| `port` | integer | `25` | SMTP server port. |
| `from` | string | `"issuerd@localhost"` | Envelope/header sender address. |
| `from_display` | string, optional | unset | Sender display name. |
| `reply_to` | string, optional | unset | `Reply-To` address. |
| `starttls` | boolean | `false` | Upgrade the connection with STARTTLS. |
| `ssl` | boolean | `false` | Implicit TLS (SMTPS) from connect. |
| `username` / `password` | string, optional | unset | SMTP AUTH credentials. |

```toml
[smtp]
enabled      = true
host         = "mail.example.com"
port         = 587
from         = "no-reply@example.com"
from_display = "Example ID"
starttls     = true
username     = "issuerd"
password     = "SECRET"   # prefer ISSUERD_SMTP__PASSWORD over committing this
```

**Disabled-by-default semantics:** with `enabled = false` the server wires a
no-op sender, and any flow that needs to send mail **fails loudly** with
`SMTP is not configured: set [smtp] enabled = true ...` rather than silently
dropping the message. Do not turn on realm email features (email verification,
reset credentials, email-code login) before SMTP works, or users will hit that
error at login/registration.

**Per-realm overrides.** Following the Keycloak model, a realm can override
every SMTP value except `enabled` (which stays a global gate) through realm
attributes named `smtpServer.*`, set via the Admin API / console (see
[administration.md](/administration/)):

| Realm attribute | Overrides config key |
|---|---|
| `smtpServer.host` | `host` |
| `smtpServer.port` | `port` |
| `smtpServer.from` | `from` |
| `smtpServer.fromDisplayName` | `from_display` |
| `smtpServer.replyTo` | `reply_to` |
| `smtpServer.starttls` | `starttls` (`"true"` / anything-else) |
| `smtpServer.ssl` | `ssl` |
| `smtpServer.user` | `username` |
| `smtpServer.password` | `password` |

Note the attribute names are camelCase and the credential attribute is `user`,
not `username`. Realms without these attributes use the global config.

## Complete annotated example

This is `examples/issuerd.example.toml` with every key explained. It is a
**reference, not a runnable default** — it assumes PostgreSQL, Redis, and
certificate files exist. Generate a fresh copy with the CLI (next section).

```toml
# ---- Root keys -------------------------------------------------------------
bind       = "0.0.0.0"                      # listen interface (IP literal; "::" for IPv6 any)
port       = 8080                           # listen port
issuer_url = "http://localhost:8080"        # PUBLIC base URL; baked into iss — see "About issuer_url"
redis      = "redis://localhost:6379"       # ephemeral state: auth codes, pending flows, revocation, login-failure counters
provision  = "provision.yaml"               # applied exactly once at first startup; remove to start empty

# ---- TLS -------------------------------------------------------------------
# Omit the whole section for plain HTTP (e.g. behind a TLS-terminating proxy).
[tls]
cert_path = "certs/issuerd.test.internal.crt"  # PEM certificate chain
key_path  = "certs/issuerd.test.internal.key"  # PEM private key

# ---- Storage ---------------------------------------------------------------
# Omit [storage] entirely for the in-memory default (dev only, empty per boot).
# Alternative: [storage.json_file] path = "issuerd-data.json" (single-node).
[storage.postgres]
url = "postgres://issuerd:issuerd_secret@localhost:5433/issuerd"
# Migrations run automatically at boot. With PostgreSQL, create the master
# realm via the provision file — automatic bootstrap only covers in-memory/json.

# ---- Logging ---------------------------------------------------------------
# Honored at startup; RUST_LOG and -v/-q flags take precedence (see [logging]).
[logging]
format = "pretty"
level  = "info"

# ---- Web UI ----------------------------------------------------------------
# Parsed but currently NOT honored — consoles are served when embedded at build.
[web_ui]
enabled = true

# ---- Reverse proxy ---------------------------------------------------------
[proxy]
trusted_proxies       = []      # LB/ingress IPs or CIDRs, e.g. ["10.0.0.0/8"]; required to honor the headers below
trust_x_forwarded_for = true
trust_x_real_ip       = true

# ---- CORS ------------------------------------------------------------------
[cors]
allowed_origins = []            # empty = browsers blocked cross-origin; add "https://app.example.com" style origins

# ---- Cluster ---------------------------------------------------------------
[cluster]
enabled                   = false   # true REQUIRES [storage.postgres] + redis (boot fails otherwise)
redis_nodes               = []      # Redis Cluster URLs; non-empty overrides the `redis` key above
jwks_refresh_interval_secs = 30     # signing-key set polling interval (PostgreSQL only)
# node_id = "node-1"                # optional; defaults to $HOSTNAME; log correlation only

# ---- SMTP ------------------------------------------------------------------
# Disabled by default; email flows fail loudly until enabled and reachable.
[smtp]
enabled       = false
host          = "127.0.0.1"
port          = 1025              # 25 default; 1025 here matches a local Mailpit-style sink
from          = "issuerd@test.internal"
from_display  = "Issuerd"
starttls      = false
ssl           = false
# reply_to    = "support@example.com"
# username    = "issuerd"
# password    = "SECRET"

# ---- Cache ------------------------------------------------------------------
[cache]
read_cache_ttl_secs = 60        # read-model cache TTL; 0 disables all read-model caches (pure-DB behavior)

# ---- Themes -----------------------------------------------------------------
[themes]
dir = "themes"                  # one subdirectory per login theme
```

## Generating the example config

The binary writes a fully populated example itself — the committed
`examples/issuerd.example.toml` is produced the same way, and a unit test in
`crates/issuerd-server/src/config.rs` verifies it stays loadable:

```bash
# TOML (extension chooses the format: .toml, .yaml/.yml, .json)
issuerd example server-config -o my.toml

# YAML
issuerd example server-config -o my.yaml

# The provision file has a generator too (see provisioning.md)
issuerd example provision-config -o provision.yaml
```

The generated file enables TLS and PostgreSQL with the same placeholder values
shown above — treat it as a checklist to edit, not as-is configuration. The
`-o` default is `examples/issuerd.example.toml` (the repo's committed
reference), so pass an explicit output path.
