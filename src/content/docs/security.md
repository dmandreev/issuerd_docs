---
title: "Security"
description: "This document covers the security-relevant configuration and day-to-day security operations of an Issuerd deployment: transport security, signing-key lifecycle, password policies, brute-force…"
---

This document covers the security-relevant configuration and day-to-day security operations of an
Issuerd deployment: transport security, signing-key lifecycle, password policies, brute-force
protection, multi-factor authentication, session and token hardening, and protecting the admin
surface. It is written for system operators and administrators running Issuerd in production.
Configuration syntax is covered in [configuration.md](/configuration/); the production rollout
checklist lives in [deployment.md](/deployment/).

## Contents

- [Deployment baseline](#deployment-baseline)
- [Signing-key management](#signing-key-management)
- [Password security](#password-security)
- [Brute-force protection](#brute-force-protection)
- [MFA operations](#mfa-operations)
- [Session and token hardening](#session-and-token-hardening)
- [Admin surface](#admin-surface)
- [Vulnerability reporting](#vulnerability-reporting)

## Deployment baseline

### TLS everywhere

Issuerd serves TLS directly when the `[tls]` section is present (via `axum_server` with
`tokio-rustls`):

```toml
issuer_url = "https://sso.example.com"

[tls]
cert_path = "/etc/issuerd/tls.crt"
key_path  = "/etc/issuerd/tls.key"
```

Alternatively, terminate TLS at a reverse proxy or load balancer in front of Issuerd and run the
daemon on plain HTTP behind it. In both cases:

- Set `issuer_url` to the public **https** URL. It is validated at boot (must be an absolute
  `http(s)` URL) and is embedded in discovery documents, token `iss` claims, and generated links.
  Issuer URLs have the form `{issuer_url}/realms/{realm-name}` — once clients have integrated,
  changing the issuer breaks every issued-token consumer, so choose it deliberately.
- The issuer URL also determines the WebAuthn relying party: `rp_id` is the issuer's host
  (`crates/issuerd-auth-flow/src/webauthn.rs`). Changing the issuer host later invalidates every
  registered passkey.

See `examples/issuerd.example.toml` for a full annotated config (generate your own with
`issuerd example server-config`).

### Realm `ssl_required`

Each realm carries an `ssl_required` setting (`none` | `external` | `all`, default `external`),
settable through the Admin API realm representation or the `ssl_required` key in
[provisioning](/provisioning/). Note that Issuerd stores and serves this value for
Keycloak-representation compatibility, but no request path rejects plain-HTTP requests based on
it — transport security is enforced by your `[tls]`/proxy configuration, not by this flag.

### CORS

Cross-origin browser requests are **fully locked down by default**: `[cors] allowed_origins`
starts empty and no cross-origin calls are allowed. The embedded admin console
(`/admin/console`) and account console (`/realms/{realm}/account`) are served same-origin and
need no CORS entries. Add exact origins (scheme + host + port) only for browser applications
hosted on other origins:

```toml
[cors]
allowed_origins = ["https://app.example.com"]
```

Do not use wildcards or broad origin lists: any listed origin may call the OIDC endpoints with
the user's browser credentials.

### Trusted proxies and client-IP correctness

The client IP drives brute-force lockout counters and is recorded in login/admin events, so it
must be correct. `X-Forwarded-For` and `X-Real-IP` are attacker-controlled unless the direct
peer is your proxy, so the ProxyIp middleware honors them only when the trust flag is enabled
**and** the direct peer matches `trusted_proxies` (`crates/issuerd-server/src/middleware/proxy_ip.rs`):

```toml
[proxy]
trusted_proxies = ["10.0.0.0/8", "172.16.5.4"]  # bare IPs or CIDR ranges
trust_x_forwarded_for = true                    # defaults: true / true, empty list
trust_x_real_ip = true
```

Within `X-Forwarded-For`, the rightmost *untrusted* entry wins (entries to the right were
appended by proxies you trust; the leftmost entry is the most spoofable). With the default empty
`trusted_proxies`, forwarded headers are ignored and the direct peer address is used — safe, but
behind a proxy every user then shares the proxy's IP, which breaks per-IP brute-force accounting.
List your proxy addresses explicitly.

### Keeping secrets out of config files

Every config key can be overridden by an environment variable with the `ISSUERD_` prefix, `__`
as the nesting separator, lowercased keys (`crates/issuerd-server/src/config.rs`). Use this to keep
credentials out of the TOML file:

```bash
export ISSUERD_STORAGE__POSTGRES__URL="postgres://issuerd:${DB_PASSWORD}@db:5432/issuerd"
export ISSUERD_SMTP__PASSWORD="$SMTP_PASSWORD"
export ISSUERD_REDIS="redis://:${REDIS_PASSWORD}@redis:6379"
```

Provision YAML files support `${VAR}` environment substitution
(`crates/issuerd-server/src/provisioner.rs`), so bootstrap secrets (initial admin passwords, client
secrets) can be injected the same way — see [provisioning.md](/provisioning/). Restrict file
permissions on any config that still contains secrets (`chmod 600`) and never commit real
credentials; the committed examples under `examples/` use well-known demo values
only.

### Platform hardening

- The official container image runs distroless (`gcr.io/distroless/cc-debian13:nonroot`): the
  process runs as uid 65532 and the image carries no shell or package manager by design. The
  release binary is built with `cargo auditable`, which embeds the Cargo dependency tree as an
  SBOM in the executable (`Dockerfile`).
- The shipped container healthcheck uses the binary's own `issuerd healthcheck` subcommand —
  the runtime image carries no curl/wget (`docker-compose.yml`).
- Request spans record only the URL **path**, never the query string, which carries credentials
  on GET flows (`crates/issuerd-server/src/routes.rs`). An inbound `x-request-id` header is honored
  only after sanitization — `[A-Za-z0-9._-]`, max 64 chars; anything else is replaced with a
  fresh UUID v4 (`crates/issuerd-server/src/middleware/request_id.rs`).

## Signing-key management

### How keys are stored and shared

JWT signing keys live in the shared `signing_keys` storage table (migration
`crates/issuerd-storage/migrations/005_signing_keys.sql`), not on individual nodes. At boot the server
loads the key set from storage, generating one when absent (`bootstrap_crypto_provider`), so every
cluster node signs with the same active key and validates tokens issued by its peers.

> **Note:** Signing keys are **server-global**, not per-realm (a deliberate difference from
> Keycloak). All realms and all nodes share one key set; the realm segment in the Admin API key
> endpoints is namespace parity with Keycloak only. See [CLUSTERING.md](/clustering/) for the
> multi-node contract.

### Per-realm signing algorithm

Supported signing algorithms: **RS256/RS384/RS512** (RSA), **ES256/ES384/ES512** (ECDSA, ES512 via
P-521), and **EdDSA** (`crates/issuerd-core/src/traits.rs`). A realm selects its algorithm with the
realm attribute `default_signature_algorithm` (e.g. `"ES256"`); issuance then picks the newest
active key of that algorithm. Symmetric `HS*` values are ignored (an HMAC "public" JWK exposes no
verification material), and absent/invalid values fall back to the newest active key overall.
Set the attribute via the realm representation's `attributes` map or the provision YAML
`attributes` block (see the [full-replacement PUT warning](#password-policies) below).

### Inspecting keys

```
GET /admin/realms/{realm}/keys            # requires view-realm or manage-realm
```

returns `active` (algorithm → newest active `kid`) and `passive` metadata. Passive keys remain
published in the realm JWKS (`/realms/{realm}/protocol/openid-connect/certs`) and still validate
previously issued tokens — they just never sign new ones.

### Rotating keys

```
POST /admin/realms/{realm}/keys/rotate    # requires manage-realm
Content-Type: application/json

{"algorithm": "ES256", "key_size": 2048}
```

The body is optional and defaults to the newest active key's parameters (RS256/2048 when no key
exists). Rotation generates a new active key and demotes the other active keys **of the same
algorithm** — exactly one active key per algorithm is kept, so realms pinned to other algorithms
are unaffected. RSA `key_size` must be 2048–8192 bits; `HS*` algorithms are rejected with 400.

Effect on outstanding tokens: **none immediately** — the demoted key stays in JWKS as passive and
keeps validating tokens it signed until they expire. The calling node's keystore and JWKS snapshot
reload immediately; the rotation is recorded as an admin event.

### Disabling a compromised key

```
PUT /admin/realms/{realm}/keys/{kid}/disable   # requires manage-realm
```

marks a key passive (Issuerd has a single non-signing state; Keycloak's passive/disabled
distinction does not exist — see `tests/KEYCLOAK_DIFFS.md`). Disabling the **only** active key
fails with 400: rotate first. Suggested compromise procedure:

1. `POST .../keys/rotate` to move signing to a fresh key.
2. `PUT .../keys/{kid}/disable` for the compromised key.
3. Because a passive key still validates its outstanding tokens, set each affected realm's
   `notBefore` (`PUT /admin/realms/{realm}` — mind the
   [full-replacement PUT semantics](#password-policies)) to now to reject tokens issued before
   the cutover — or accept them until natural expiry (default access-token lifespan is 300 s).

### Cluster propagation

Each node polls the shared key set every `cluster.jwks_refresh_interval_secs` (default 30 s) and
reloads its keystore + JWKS snapshot on change, so admin-triggered rotation propagates to peers
within one interval. Admin calls additionally reload the *local* node immediately.

> **Warning — realm recreation:** because keys are server-global, deleting a realm and recreating
> it under the same name lets that realm's still-unexpired tokens verify against the new realm
> (documented in `tests/KEYCLOAK_DIFFS.md`). After recreating a realm, rotate keys or set the new
> realm's `notBefore`.

## Password security

### Hashing at rest

Passwords are hashed with **Argon2id** (via the `argon2` crate) and stored as PHC strings in the
credential's `secret_data`; `credential_data` records `{"hash_algorithm": "argon2id"}`. This
applies to every write path — bootstrap admin, provisioning, admin reset, account console,
registration, and the `UPDATE_PASSWORD` required action.

### Password policies

The realm `password_policy` (`crates/issuerd-core/src/password.rs`) is validated on every password set:
self-registration, the account console, the `UPDATE_PASSWORD` required action, and the admin
`PUT /admin/realms/{realm}/users/{id}/reset-password` endpoint. All rule violations are returned
at once with machine-readable codes (`min_length`, `require_digits`, …).

| Field | Default | Rule |
|-------|---------|------|
| `min_length` | `8` | Minimum length in Unicode characters (not bytes) |
| `max_length` | unset | Optional maximum length |
| `require_digits` | `false` | At least one ASCII digit |
| `require_lower` | `false` | At least one lowercase letter |
| `require_upper` | `false` | At least one uppercase letter |
| `require_special` | `false` | At least one non-alphanumeric character |
| `not_username` | `false` | Password ≠ username (case-insensitive) |
| `not_email` | `false` | Password ≠ email address (case-insensitive) |
| `history_size` | `0` | Previous passwords remembered (see below) |
| `hash_algorithm` | `argon2id` | Declared hash algorithm (`argon2id`; `pbkdf2` exists as a model/enum value) |

Set the policy through the Admin API as a JSON string on the realm representation:

> **Warning:** `PUT /admin/realms/{realm}` is a **full replacement**, not a merge
> (`crates/issuerd-admin-api/src/realms.rs` — the body is converted with `Realm::default()` fallbacks
> for omitted fields). Always GET the current representation, edit it, and PUT it back, or you
> will silently reset lifespans, events config, and every other realm field to model defaults:

```bash
# GET, modify, PUT back (jq required)
curl -s "https://sso.example.com/admin/realms/myrealm" \
  -H "Authorization: Bearer $ADMIN_TOKEN" |
  jq '.password_policy = "{\"min_length\":12,\"require_digits\":true,\"require_special\":true,\"not_username\":true,\"history_size\":5}"' |
  curl -X PUT "https://sso.example.com/admin/realms/myrealm" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d @-
```

### Password history

With `history_size = N`, a new password is rejected (code `password_history`) if it matches the
current password or any of the `N - 1` most recent previous ones. Superseded passwords are kept as
`password-history` credentials, which are never accepted for login; older entries are pruned.
`history_size = 0` (default) disables history checking.

### Imported password hashes

Verification accepts Argon2id PHC strings only; any other stored format simply fails verification
(`crates/issuerd-auth-flow/src/built_in.rs` — foreign formats return "no match"). When migrating users
from another system, either import Argon2id-compatible hashes or force a password reset on first
login (assign the `UPDATE_PASSWORD` required action).

## Brute-force protection

### Realm settings

Brute-force detection is **off by default** (`brute_force_protected = false`) and configured per
realm (`crates/issuerd-core/src/models.rs`, Admin API field names in parentheses):

| Realm field (Admin JSON) | Default | Meaning |
|--------------------------|---------|---------|
| `brute_force_protected` (`bruteForceProtected`) | `false` | Master toggle for tracking + lockout |
| `max_login_failures` (`maxLoginFailures`) | `5` | Consecutive failures before lockout |
| `wait_increment_secs` (`waitIncrementSecs`) | `60` | Progressive wait increment; `0` = fixed lockout |
| `max_failure_wait_secs` (`maxFailureWaitSecs`) | `900` | Cap for the progressive wait (`0` = uncapped) |
| `lockout_duration_secs` (`lockoutDurationSecs`) | `900` | Fixed lockout duration when the increment is `0` |

Enable it on every production realm, at minimum on realms with the password grant or
browser-password login (remember the [full-replacement PUT semantics](#password-policies) —
GET, edit, PUT back):

```bash
curl -s "https://sso.example.com/admin/realms/myrealm" \
  -H "Authorization: Bearer $ADMIN_TOKEN" |
  jq '.bruteForceProtected = true | .maxLoginFailures = 5' |
  curl -X PUT "https://sso.example.com/admin/realms/myrealm" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d @-
```

### Lockout semantics

Tracking is keyed per `(realm, canonical username, source IP)` in the distributed cache
(`crates/issuerd-auth-flow/src/login_failures.rs`):

- `login-failure:{realm}:{username}:{ip}` — atomic failure counter with a 300-second TTL applied
  when the counter is created (the counting window is not realm-configurable).
- `login-lockout:{realm}:{username}:{ip}` — lockout marker whose TTL is the computed lockout
  duration.

Lockout duration: with `wait_increment_secs > 0` the wait grows per attempt past the threshold —
`wait_increment * (failures - max_failures + 1)`, capped at `max_failure_wait_secs` (with the
defaults: 60 s, then 120 s, 180 s … up to 900 s). With `wait_increment_secs = 0` a fixed
`lockout_duration_secs` applies. **All lockouts are temporary** — there is no permanent-lockout
mode; an admin unlocks accounts explicitly (below). A successful login resets the counter and
clears the marker. Enforcement covers the browser login flow (`auth-username-password`), the
token endpoint's password grant, and the device-verification endpoint (the
`POST /realms/{realm}/device` verify handler runs the same lockout check, failure recording, and
reset on success, keyed per username+IP — `crates/issuerd-server/src/routes/oidc.rs`); realms without
the toggle skip failure tracking entirely.

### Cluster-wide counters

Counters use the cache's atomic `increment` (Redis `INCR` plus a conditional `PEXPIRE` Lua script;
`DashMap::entry` on the in-memory backend), so failures aggregate correctly across concurrent
requests and across cluster nodes sharing the Redis cache. For brute-force protection to be
meaningful in a multi-node deployment, all nodes must share the cache (see
[CLUSTERING.md](/clustering/)) — and the client IP must survive proxying (see
[trusted proxies](#trusted-proxies-and-client-ip-correctness)).

### Attack-detection endpoints

Keycloak-compatible inspection and unlock API (`crates/issuerd-admin-api/src/attack_detection.rs`),
all requiring the `manage-users` role:

| Call | Effect |
|------|--------|
| `GET /admin/realms/{realm}/attack-detection/brute-force/users` | List currently locked `(username, IP)` pairs with failure counts |
| `GET /admin/realms/{realm}/attack-detection/brute-force/users/{id}` | Aggregated failure count and lock state for one user |
| `DELETE /admin/realms/{realm}/attack-detection/brute-force/users/{id}` | Clear all counters and lockout markers for the user (204; recorded as an admin event) |

> **Note:** the list endpoint parses cache keys by splitting on `:`, which does not cope with IPv6
> source addresses; the per-user status and clear endpoints are unaffected.

## MFA operations

### TOTP (authenticator apps)

TOTP follows RFC 6238 (`crates/issuerd-auth-flow/src/totp.rs`): 160-bit base32 secrets, enrollment via
an `otpauth://` QR code on the login page, verification over a small time-step window with replay
protection. The per-realm OTP policy (Admin API fields in parentheses):

| Realm field (Admin JSON) | Default |
|--------------------------|---------|
| `otp_policy.algorithm` (`otpPolicyAlgorithm`) | `HmacSHA1` (`HmacSHA256`/`HmacSHA512` also supported) |
| `otp_policy.digits` (`otpPolicyDigits`) | `6` (or `8`) |
| `otp_policy.period_secs` (`otpPolicyPeriod`) | `30` |
| `otp_policy.look_ahead_window` (`otpPolicyLookAheadWindow`) | `1` |

The default browser flow ends with a **conditional second-factor section**
(`conditional-user-configured` + `auth-otp-form` as `CONDITIONAL`, `auth-webauthn` as `OPTIONAL`,
see `crates/issuerd-server/src/state.rs`): users who own a TOTP credential or passkey are challenged
for it; users without one pass with password only.

**To enforce MFA rollout**, assign the `CONFIGURE_TOTP` required action — affected users must
enroll an authenticator at next login, and from then on the conditional OTP stage challenges them:

```bash
# Prompt one user to enroll via email (requires SMTP), or set the action directly:
curl -X PUT "https://sso.example.com/admin/realms/myrealm/users/{id}/execute-actions-email" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '["CONFIGURE_TOTP"]'
```

Users can also self-enroll in the account console
(`/realms/{realm}/account`, TOTP start/verify endpoints under `account/api/credentials/totp`).

### WebAuthn / passkeys

WebAuthn is supported as a **second factor only** (`crates/issuerd-auth-flow/src/webauthn.rs`;
passwordless username-less login is out of scope). The `auth-webauthn` authenticator challenges
users who own a passkey; registration happens in the account console
(`account/api/webauthn/register/start|finish`). The relying-party id is derived from the
`issuer_url` host and ceremony state is cached for 300 s — see the issuer warning in
[TLS everywhere](#tls-everywhere).

### Passwordless email-code realms

A realm can replace passwords entirely with emailed one-time codes: set the realm attribute
`email_code_login = "true"` and the `auth-email-code` authenticator
(`crates/issuerd-auth-flow/src/email_code.rs`) runs as the only factor — the login page asks for an
email address, mails a 6-digit single-use code, and verifies it. Operational attributes:

| Realm attribute | Default | Meaning |
|-----------------|---------|---------|
| `email_code_login` | unset | `"true"` switches the realm to email-code login |
| `email_code_length` | `6` | Code length in digits (max 32) |
| `email_code_ttl_secs` | `300` | Code validity (cache-entry TTL) |

Codes are single-use and burn after 5 wrong submissions; at most 5 codes are mailed per entry
lifetime. Unknown or disabled accounts get the same challenge without a mail, so the endpoint
does not leak account existence. SMTP must be configured (`[smtp]` or per-realm `smtpServer.*`
attributes — see [configuration.md](/configuration/)). In these realms the "no password
credential ⇒ UPDATE_PASSWORD" auto-rule stays silent by design.

### Resetting a user's MFA (recovery)

User credentials are managed through the Admin API (requires `manage-users`):

```bash
# List credentials (redacted — no secrets are returned)
curl "https://sso.example.com/admin/realms/myrealm/users/{id}/credentials" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Delete the lost TOTP credential / passkey
curl -X DELETE \
  "https://sso.example.com/admin/realms/myrealm/users/{id}/credentials/{credentialId}" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

The user's **last** credential cannot be deleted (400) — reset the password first
(`PUT /admin/realms/{realm}/users/{id}/reset-password`) or add a credential. After deleting a
TOTP credential, re-assign `CONFIGURE_TOTP` so the user re-enrolls at next login. Deletions are
recorded as admin events. To sign the user out everywhere at the same time, delete their sessions
(`GET /admin/realms/{realm}/users/{id}/sessions`, then
`DELETE /admin/realms/{realm}/sessions/{session}`).

## Session and token hardening

### Refresh-token rotation and replay handling

Refresh tokens rotate on every use (`crates/issuerd-server/src/routes/oidc.rs`): a successful refresh
revokes the presented token (cache key `revoked_refresh:{token}`, TTL = its remaining lifetime)
and issues a fresh one. Presenting a revoked refresh token is rejected with `invalid_grant` and
logged as a `refresh_token_error` event. Separately, re-presenting an already-exchanged
**authorization code** triggers reuse detection: the access and refresh tokens minted from that
code are revoked (`revoked:` / `revoked_refresh:` markers) and a `code_to_token_error` event is
recorded.

### Session and token lifespans

Per-realm defaults (`crates/issuerd-core/src/models.rs`):

| Realm field | Default | Meaning |
|-------------|---------|---------|
| `access_token_lifespan` | 300 s | Access-token lifetime |
| `refresh_token_lifespan` | 1800 s | Refresh-token lifetime |
| `sso_session_idle_timeout` | 1800 s | SSO session idle window |
| `sso_session_max_lifespan` | 36000 s | Absolute SSO session cap |
| `remember_me_session_idle_secs` | 604800 s | Idle window for "remember me" sessions |
| `offline_session_idle_timeout` | 2592000 s | Idle window for offline sessions |

SSO idle is enforced when the browser SSO cookie is resolved (idle-exceeded sessions are deleted);
remember-me sessions get their separate, longer idle window. The refresh grant requires the
backing session to still exist, so session teardown immediately kills refresh ability. The
`offline_access` scope mints a **separate offline session** that survives SSO expiry and browser
logout, backed by its own idle window — treat clients holding `offline_access` as long-lived
credentials and grant the scope deliberately.

### Revoking tokens

Three mechanisms, in increasing blast radius:

1. **RFC 7009 revocation** — `POST /realms/{realm}/protocol/openid-connect/revoke`
   (client-authenticated). Refresh tokens land in `revoked_refresh:` (checked by the refresh
   grant); access tokens land in `revoked:` (checked by userinfo and introspection), each with a
   TTL matching the token's remaining lifetime.
2. **Session teardown** — `DELETE /admin/realms/{realm}/sessions/{session}` kills refresh
   ability and back-channel-logs out the session's clients; issued access tokens remain
   statelessly valid until expiry.
3. **Realm `notBefore`** — `PUT /admin/realms/{realm}` with `"notBefore": <unix-seconds>` (a
   [full-replacement PUT](#password-policies): GET, edit, PUT back) rejects
   every token issued before the cutoff: the refresh grant fails with `invalid_grant`, userinfo
   returns 401, introspection reports `active: false`, token-exchange subject tokens are rejected,
   and the admin API middleware returns 401 (checking both the issuing realm and the path realm).
   `0` clears the cutoff. `POST /admin/realms/{realm}/push-revocation` exists for Keycloak API
   parity but is a no-op stub (204 + admin event) — real revocation is `notBefore`.

> **Note:** resource servers that validate access tokens purely statelessly (local JWT signature
> checks against JWKS) cannot see revocations or session teardown — only introspection, userinfo,
> and the token endpoint consult the revocation lists. Keep `access_token_lifespan` short for
> such deployments and use DPoP where token theft is a concern.

The read-model caches behind the token hot paths — session-validity snapshots, the realm-by-name
resolution cache, the claims read model, and the rendered userinfo/discovery response caches —
are governed by `[cache] read_cache_ttl_secs` (default 60 s; `crates/issuerd-server/src/config.rs`).
Mutations through the Admin API invalidate precisely (single-entity key deletes plus realm-wide
epoch bumps), so committed writes are visible immediately; a write that bypasses the Admin API —
e.g. a direct database edit — can stay hidden for up to this TTL. Set `read_cache_ttl_secs = 0`
to disable every read-model cache for pure-database behavior.

### Logout channels

The RP-initiated logout endpoint (`/realms/{realm}/protocol/openid-connect/logout`) validates a
real `id_token_hint` before tearing down the session (`crates/issuerd-server/src/routes/logout.rs`).
Whenever a user session is destroyed — RP-initiated logout, SPA/account logout, or admin session
deletion — registered clients are notified:

- **Back-channel:** clients with a `backchannel_logout_uri` attribute receive a signed
  `logout_token` POST. Delivery is fire-and-forget (5 s timeout, one retry) and never blocks the
  user's logout; each delivery outcome is recorded as an admin event.
- **Front-channel:** the logout page embeds a hidden iframe per client with a
  `frontchannel_logout_uri` attribute (called with `iss` and `sid`), then continues to the
  validated `post_logout_redirect_uri`.

### DPoP sender-constraining

DPoP (RFC 9449; mTLS deferred) binds tokens to a client key (`crates/issuerd-server/src/dpop.rs`):
presenting a `DPoP` proof at the token endpoint binds the issued access token (`cnf.jkt` claim,
`token_type: DPoP`). At userinfo, a bound token must be presented with the `DPoP` scheme plus a
fresh proof whose thumbprint matches and whose `ath` ties it to the token — otherwise 401 with a
`WWW-Authenticate: DPoP` challenge. Refresh tokens keep the binding across rotation ("slide");
a bound refresh token presented without its proof fails with `invalid_grant`. Proof `jti` values
are single-use, enforced through the distributed cache (`dpop_jti:{realm}:{jti}`, failing closed
when the cache is down); proofs older than 300 s (60 s future leeway) are rejected. Server-provided
nonces (RFC 9449 §8) are intentionally not implemented.

### PKCE

Public clients must use PKCE on the authorization-code flow: the authorization endpoint (and the
SPNEGO code path) reject a public client's request without `code_challenge`
(`issuerd-protocol/src/authorization.rs`), and the verifier is checked at code exchange per RFC 7636
(43–128 characters; `S256` and `plain` methods — always use `S256`). Confidential clients may add
PKCE for defense in depth.

### PAR and JAR for authorization-request integrity

- **PAR (RFC 9126):** clients push the authorization request to
  `POST /realms/{realm}/protocol/openid-connect/ext/par` (client-authenticated like the token
  endpoint) and receive a single-use `request_uri` valid for 90 s. Force PAR realm-wide with the
  realm attribute `require_pushed_authorization_requests = "true"` (plain requests are then
  refused and discovery advertises the policy) or per client with the client attribute
  `require.pushed.authorization.requests = "true"`.
- **JAR (RFC 9101):** the `request` parameter carries a signed Request Object, verified against
  the client's JWKS (inline via `use.jwks.string` + `jwks.string`, or fetched via
  `use.jwks.url` + `jwks.url`) or the client secret for HMAC. Unsigned objects are always
  rejected; `iss` must equal the query `client_id`; JAR-by-reference (`request_uri` URLs) is not
  implemented — use PAR instead.

### Pairwise subject identifiers

For privacy-sensitive clients, set the client attribute `subject_type = "pairwise"` (OIDC Core
§8): every user-facing `sub` becomes `base64url(HMAC-SHA256(sector_key, sector || user_id))` —
stable within a sector, unlinkable across sectors. The sector is the host of the client's
`sector_identifier_uri` attribute when set (https URL, fetched and validated against the
registered redirect URIs behind an SSRF guard) or the common host of its redirect URIs; multiple
distinct redirect-URI hosts without a `sector_identifier_uri` are rejected. The sector key is a
per-realm secret generated automatically into the realm attributes at realm creation.

## Admin surface

### Master-realm hygiene

Admin tokens are bound to the realm that issued them (Keycloak model): tokens issued by `master`
administer every realm, other tokens only their own; realm creation/listing is master-only
(`crates/issuerd-admin-api/src/auth.rs`). The automatic bootstrap of the master realm with the
well-known `admin`/`admin` user runs **only** for the in-memory/json-file backends; on PostgreSQL
the provision file defines the master realm (see `examples/provision.demo.yaml`).

- The root `docker-compose.yml` demo stack (and any in-memory/json dev rig) seeds `admin`/`admin`
  — **never expose such a rig**. It exists for evaluation only.
- In production, create **named per-person admin users** with the roles they need, then disable or
  delete any shared bootstrap admin. Shared accounts destroy the value of the admin audit trail,
  which resolves `auth_username` per event.

### Least-privilege admin roles

Admin endpoints are gated on fine-grained roles; grant the minimum set per operator:

| Role | Scope |
|------|-------|
| `view-realm` / `manage-realm` | Read / modify realm settings, keys, flows, events config |
| `view-users` / `manage-users` | Read / modify users, credentials, sessions, attack detection |
| `view-clients` / `manage-clients` | Read / modify clients and scopes |
| `impersonation` | Call `POST /admin/realms/{realm}/users/{id}/impersonation` — grant sparingly; impersonated tokens carry an `impersonator` claim and the action is admin-event audited |

The master-realm bootstrap assigns all of these to the bootstrap admin; distribute them
deliberately instead. Role assignment is covered in [administration.md](/administration/).

### Admin audit events

Every admin mutation records an `AdminEvent`. Issuerd defaults `events_enabled` and
`admin_events_enabled` to **on** (a deliberate break from Keycloak, which defaults both off) so a
fresh deployment has an audit trail; `include_representations` (`adminEventsDetailsEnabled`)
defaults **off** — enable it to capture request bodies (key rotations, credential deletes) in the
event representation:

```bash
curl -X PUT "https://sso.example.com/admin/realms/myrealm/events/config" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"eventsEnabled": true, "adminEventsEnabled": true, "adminEventsDetailsEnabled": true, "eventsExpiration": 7776000}'
```

Note on payload sensitivity: user and client representations are redacted before persisting
(`redacted_for_audit` strips credential values, `secret_data`, and client secrets), and the
reset-password endpoint records no representation at all — but everything else in the request
body (realm settings, user attributes, role mappings) is captured verbatim. Weigh retention
(`eventsExpiration`, seconds; expired events are clamped at query time, not physically deleted)
and access to the events API accordingly. Query and alerting on events is covered in
[monitoring.md](/monitoring/).

## Vulnerability reporting

Follow the **Security** section of the project `README.md`: report vulnerabilities privately by
email rather than opening public issues, with reproduction steps, and allow reasonable remediation
time before public disclosure. The current contact address is `security@issuerd.org`.
