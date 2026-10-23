---
title: "Client integration"
description: "This document is the OIDC/OAuth2 consumer's guide to Issuerd: how applications (server-side web apps, SPAs, mobile apps, services, devices) authenticate users and obtain tokens from an Issuerd…"
---

This document is the OIDC/OAuth2 consumer's guide to Issuerd: how applications (server-side web apps, SPAs, mobile apps, services, devices) authenticate users and obtain tokens from an Issuerd realm. It is written for system operators and application owners who need to wire an existing or new application to a running Issuerd server. It covers endpoint URLs, flow selection, client registration, a worked authorization-code example, token handling, logout, client authentication, downloadable adapter configs, and the advanced OAuth features Issuerd implements. Managing clients, scopes, and realm settings in detail is covered in [administration.md](/administration/); server-side hardening in [security.md](/security/).

All examples assume a server at `https://auth.example.com` (the configured `issuer_url`) and a realm named `myrealm`. Against the local demo stack ([getting-started.md](/getting-started/)), substitute `http://localhost:8080` — the demo seeds `myrealm` with user `alice` / `changeme`, a confidential client `my-app` / `my-app-secret`, and a public client `public-app`.

## Contents

- [Endpoints and discovery](#endpoints-and-discovery)
- [Choosing a flow](#choosing-a-flow)
- [Registering a client](#registering-a-client)
- [Authorization code flow walkthrough](#authorization-code-flow-walkthrough)
- [Using tokens](#using-tokens)
- [Logout](#logout)
- [Client authentication methods](#client-authentication-methods)
- [Ready-made adapter configuration](#ready-made-adapter-configuration)
- [Advanced capabilities](#advanced-capabilities)
- [Realm token and session settings](#realm-token-and-session-settings)

## Endpoints and discovery

Every realm is a separate OIDC issuer. The issuer URL is:

```
{issuer_url}/realms/{realm-name}
```

The realm segment is the realm **name**, never its internal UUID — e.g. `https://auth.example.com/realms/myrealm`. The same name-based issuer appears in every token's `iss` claim, so the `issuer_url` configured on the server ([configuration.md](/configuration/)) must be exactly the base URL clients use to reach it, including scheme and port. Behind a load balancer, that is the LB URL (see [CLUSTERING.md](/clustering/)).

The discovery document is served per realm:

```bash
curl -s https://auth.example.com/realms/myrealm/.well-known/openid-configuration
```

(A realm-less `/.well-known/openid-configuration` also exists and falls back to the `master` realm; always use the realm-scoped URL.) The document advertises exactly what the server implements — all six OIDC response types (`code`, `id_token`, `code id_token`, `id_token token`, `code token`, `code id_token token`, with the `token id_token` alias listed alongside `id_token token` per the registration-metadata convention); response modes `query`, `fragment`, `form_post`, `jwt`, `query.jwt`, `fragment.jwt`, `form_post.jwt`; grant types `authorization_code`, `implicit`, `refresh_token`, `client_credentials`, device code, CIBA, and token exchange; PKCE method `S256`; client authentication methods `client_secret_basic`, `client_secret_post`, `client_secret_jwt`, `private_key_jwt`.

Protocol endpoints (all under `{issuer}/protocol/openid-connect`, where `{issuer}` is the realm issuer URL above):

| Endpoint | Path | Methods |
|---|---|---|
| Authorization | `{issuer}/protocol/openid-connect/auth` | GET, POST |
| Token | `{issuer}/protocol/openid-connect/token` | POST |
| UserInfo | `{issuer}/protocol/openid-connect/userinfo` | GET, POST |
| JWKS (public signing keys) | `{issuer}/protocol/openid-connect/certs` | GET |
| Logout (end session) | `{issuer}/protocol/openid-connect/logout` | GET, POST |
| Token introspection (RFC 7662) | `{issuer}/protocol/openid-connect/token/introspect` | POST |
| Token revocation (RFC 7009) | `{issuer}/protocol/openid-connect/revoke` | POST |
| Device authorization (RFC 8628) | `{issuer}/protocol/openid-connect/auth/device` | POST |
| Device verification (user enters the code) | `{issuer}/protocol/openid-connect/auth/device-verify` | POST |
| Pushed authorization requests (RFC 9126) | `{issuer}/protocol/openid-connect/ext/par` | POST |
| CIBA backchannel authentication | `{issuer}/protocol/openid-connect/ext/ciba/auth` | POST |
| CIBA approval (user device; see [ciba-step-up.md](/ciba-step-up/)) | `{issuer}/protocol/openid-connect/ext/ciba/approve` | POST |
| Kerberos/SPNEGO (desktop SSO; see [user-federation.md](/user-federation/)) | `/realms/{realm}/kerberos` (realm root, outside `protocol/`) | GET |
| Dynamic client registration (RFC 7591/7592) | `{issuer-fragment}/clients-registrations/...` | see below |

Dynamic client registration lives outside the `protocol/` tree: `POST /realms/{realm}/clients-registrations/default` (open) and `POST /realms/{realm}/clients-registrations/openid-connect` (initial-access-token gated), with `GET/PUT/DELETE .../clients-registrations/openid-connect/{client_id}` for management. It is advertised as `registration_endpoint` in discovery only for realms that opted in (see [Advanced capabilities](#advanced-capabilities)).

Any standards-compliant OIDC client library can configure itself from the discovery document alone.

## Choosing a flow

| Application type | Flow | Client type |
|---|---|---|
| Server-side web app (can hold a secret) | Authorization code + PKCE (`S256`) | Confidential |
| SPA, mobile, or desktop app (cannot hold a secret) | Authorization code + PKCE (`S256`) | Public |
| Machine-to-machine service, daemon, CI job | `client_credentials` (service account) | Confidential |
| Input-constrained device (TV, console, headless CLI) | Device authorization grant (RFC 8628) | Public or confidential |
| Legacy first-party app that cannot redirect | Resource owner password (`password`) | Confidential or public — discouraged |

Notes on the table:

- **Always use PKCE.** Public clients are required to send `code_challenge` on the authorization request and `code_verifier` at the token endpoint; confidential clients should do the same. `S256` is the only accepted method — `plain` (and a challenge sent without a method) is rejected with `invalid_request`, matching the S256-only discovery advertisement.
- All six OIDC response types are accepted (`code`, `id_token`, `id_token token`, `code id_token`, `code token`, `code id_token token`); bare `token` is rejected as unsupported (OAuth2-only, not an OIDC type). New integrations should still use the code flow. A `nonce` is REQUIRED whenever an id_token is issued from the authorization endpoint (implicit/hybrid types; OIDC Core §3.2.2.1/§3.3.2.1) — a realm may opt back into accepting nonce-less hybrid requests with the `compat.nonceless_hybrid` realm attribute during migration.
- The **`password` grant exists** — `grant_type=password` with `username`/`password` against the token endpoint (wrong credentials return `401` with `invalid_grant`) — but it is deliberately **not advertised** in the discovery document. Accounts with an enrolled OTP credential must additionally pass the current code in the `totp` form parameter (Keycloak direct-grant parity; a consumed code cannot be replayed); accounts whose only second factor is a passkey/WebAuthn credential cannot use the grant at all, and accounts with pending required actions are rejected. Do not use it for new integrations: it trains users to hand their password to third parties and bypasses SSO and browser-only factors.
- The **device-verification endpoint applies the same account policy** as the password grant: federated users are validated against their directory (an active directory rejection is final), OTP-enrolled users must include the current `totp` code, and accounts with pending required actions must finish them in the browser flow first.
- For `client_credentials`, enable **service accounts** on the client so the issued token is backed by the `service-account-{client_id}` user and carries its role mappings (see the next section).

## Registering a client

Three equivalent ways to create a client; the result is the same object regardless of channel.

**Admin console** — `https://auth.example.com/admin/console` → select the realm → *Clients* → *Create*. Field-by-field detail is in [administration.md](/administration/).

**Provision YAML** — declarative, applied at first startup (see [provisioning.md](/provisioning/) and `examples/provision.example.yaml`):

```yaml
clients:
  - realm: myrealm
    client_id: my-app
    public_client: false
    secret: my-app-secret
    redirect_uris:
      - https://app.example.com/callback
    web_origins:
      - https://app.example.com
    default_scopes: [openid, profile]
    optional_scopes: [email, offline_access]
    consent_required: false
    full_scope_allowed: true
```

**Admin REST API** — `POST /admin/realms/{realm}/clients` with a Keycloak-style `ClientRepresentation` (an admin token with a `manage-clients` role is required):

```bash
curl -X POST https://auth.example.com/admin/realms/myrealm/clients \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "my-api",
    "public_client": false,
    "service_accounts_enabled": true,
    "redirect_uris": ["https://api.example.com/callback"],
    "default_scopes": ["openid", "profile"],
    "optional_scopes": ["email", "offline_access"]
  }'
```

The fields that matter for protocol behavior:

| Field | Effect |
|---|---|
| `client_id` | The public identifier used in `client_id` parameters (not the internal UUID). |
| `public_client` | `true` = public client: no client authentication at the token endpoint, PKCE mandatory. `false` = confidential: must authenticate (see [Client authentication methods](#client-authentication-methods)). |
| `secret` / `client_authenticator_type` | The shared secret for `client_secret_*` methods (default `client-secret`); or `client-jwt` / `client-secret-jwt` for assertion-based auth. The secret is accepted on create/update but never returned in list responses. |
| `redirect_uris` | Allow-list for `redirect_uri` (and for `post_logout_redirect_uri` when the client has no dedicated post-logout list). Matching is exact, or a trailing `*` wildcard prefix (`https://app.example.com/*`); fragments are rejected. Requests naming an unregistered URI are answered with an error page, never a redirect. |
| attributes: `post_logout_redirect_uris` | Optional JSON array of URI strings (e.g. `["https://app.example.com/logged-out"]`) — the dedicated allow-list for `post_logout_redirect_uri`. When present and non-empty it fully replaces the `redirect_uris` fallback for logout redirects (same exact/trailing-`*` matching). |
| attributes: `frontchannel_logout_uri` / `backchannel_logout_uri` (+ `_session_required`) | Logout notification endpoints for the client — see [Logout](#logout). |
| attributes: `logo_uri` / `policy_uri` / `tos_uri` | Client branding (OIDC registration §2, also settable via DCR): the login page shows the client's logo above the sign-in form and links its policy/terms documents in a footer row while the user authenticates for that client. Absolute `http(s)` URLs; DCR validates https-only at registration while the admin attributes map accepts both (admin trust); absent attributes render nothing. The login-context endpoint (`GET /realms/{realm}/login/context`) exposes them as `client_logo_uri` / `client_policy_uri` / `client_tos_uri` (plus `client_name` as the logo's accessible label) whenever the paused flow's client resolves — that is what a custom login page consumes. |
| `web_origins` | Fed into tokens as the `allowed_origins` claim via the built-in `web-origins` client scope. **It does not relax CORS** (see the warning below). |
| `default_scopes` / `optional_scopes` | Every scope a client may request must be assigned here; both the authorization and token endpoints reject any other `scope` value with `invalid_scope`. Exception: `openid` is the OIDC protocol marker, not a client scope — it is always allowed (Keycloak parity; this is what lets a DCR-registered client without an explicit scope list run OIDC flows). Access tokens always include the mappers of the default-assigned client scopes (Keycloak's "default scopes always apply" rule). Request `offline_access` only appears if assigned (typically as optional). |
| `consent_required` | `true` shows the user a consent screen before the first grant. |
| `full_scope_allowed` | `true` (default): tokens contain the user's full effective role set. `false`: token roles are intersected with the client's (and its granted scopes') scope mappings. |
| `service_accounts_enabled` | Backs the `client_credentials` grant with a client-UUID-linked service-account user — its role mappings flow into tokens and `sub` is that user's deterministic id. Without it, the grant still works but issues a synthetic token (`sub` = the client_id, no role claims). |
| attributes: `admin_api_access` | `"true"` allows tokens issued to this client to call the Admin API (roles are still required). Only `manage-realm` may set it through the Admin API; open dynamic registration strips it. `admin-cli` is enabled by default, other clients are not. |
| `bearer_only` | Informational marker for a client that only consumes tokens (no login flows). Stored and exposed (including in the adapter-config download), but not enforced — no runtime check rejects login flows for a bearer-only client. |
| `enabled` | Disabling a client is the administrative containment action: disabled clients are rejected at every endpoint, including the token endpoint, even with correct credentials. |

Service-account resolution never adopts an existing user by username. If an unlinked legacy account occupies the conventional `service-account-{client_id}` name, it is disabled once the client-UUID-linked account exists, and its roles are not copied. After upgrading, review that account and reassign any intended roles to the linked account.

> **Warning (CORS, SPA operators):** unlike Keycloak, `web_origins` does **not** emit CORS headers. Browser-based apps calling the token or userinfo endpoints cross-origin need their origin in the **server-level** `[cors] allowed_origins` list ([configuration.md](/configuration/)), which is empty — fully locked down — by default. A SPA that works against Keycloak but fails preflight against Issuerd is usually missing this.

## Authorization code flow walkthrough

**1. Generate the PKCE pair** (verifier 43–128 chars, S256 challenge):

```bash
code_verifier=$(openssl rand -base64 64 | tr -d '=' | tr '+/' '-_' | cut -c1-64)
code_challenge=$(printf '%s' "$code_verifier" | openssl dgst -sha256 -binary | openssl base64 | tr -d '=' | tr '+/' '-_')
```

Also generate random `state` (CSRF protection) and `nonce` (ID-token replay protection) values and store them in the user's session.

**2. Send the browser to the authorization endpoint:**

```
https://auth.example.com/realms/myrealm/protocol/openid-connect/auth
  ?response_type=code
  &client_id=my-app
  &redirect_uri=https%3A%2F%2Fapp.example.com%2Fcallback
  &scope=openid%20profile%20email
  &state=af0ifjsldkj
  &nonce=n-0S6_WzA2Mj
  &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
  &code_challenge_method=S256
```

Every requested scope must be assigned to the client. `openid` triggers the ID token; `profile`/`email` map to the built-in client scopes of the same names. The user authenticates through the realm's browser flow (SSO cookie, MFA, identity brokering, consent as configured) — all of that is transparent to the client.

**3. Handle the callback.** On success the browser returns to `redirect_uri` with `?code=...&state=...`. Verify `state` against the stored value before anything else. On failure, the error arrives the same way (`?error=...&error_description=...&state=...`) — except requests with an unregistered `redirect_uri`, which never produce a redirect (RFC 6749 §4.1.2.1).

**4. Exchange the code** (server-side, within the code's 10-minute lifetime — codes are single-use):

```bash
curl -X POST https://auth.example.com/realms/myrealm/protocol/openid-connect/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code' \
  -d 'code=SplxlOBeZQQYbYS6WxSbIA' \
  -d 'redirect_uri=https%3A%2F%2Fapp.example.com%2Fcallback' \
  -d 'client_id=my-app' \
  -d 'client_secret=my-app-secret' \
  -d 'code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
```

A public client omits `client_secret` and authenticates with the `code_verifier` alone. The response (`Cache-Control: no-store`; error responses carry the same `no-store`/`Pragma: no-cache` pair — RFC 6749 §5.1 applies to errors too):

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 300,
  "refresh_token": "eyJhbGciOiJSUzI1NiIs...",
  "id_token": "eyJhbGciOiJSUzI1NiIs...",
  "scope": "openid profile email"
}
```

> **Warning:** presenting the same authorization code twice is treated as token theft: the second exchange fails with `invalid_grant` **and** the tokens minted by the first exchange are revoked. If your callback handler can run twice (double-clicks, retries), guard against parallel exchanges.

**5. Validate the ID token.** Checklist:

1. **Signature** — verify against the JWKS from `{issuer}/protocol/openid-connect/certs`, matching the `kid` header. The algorithm is the realm's signing algorithm (advertised in discovery under `id_token_signing_alg_values_supported`; per realm selectable via the `default_signature_algorithm` realm attribute) unless the client is pinned with its `id_token_signed_response_alg` attribute (client attribute or DCR metadata, e.g. `RS256`) — a pinned client gets exactly that algorithm, and an unpinnable value (unknown algorithm or no active signing key for it) fails issuance loudly rather than silently falling back to another key.
2. **`iss`** — exact string match with `https://auth.example.com/realms/myrealm`.
3. **`aud`** — contains your `client_id` (`azp` identifies the requesting party).
4. **`exp`/`iat`** — within validity.
5. **`nonce`** — equals the value you sent in step 2.

Every mainstream OIDC library performs these five checks given only the discovery URL — prefer that over hand-rolled validation.

## Using tokens

**UserInfo.** Send the access token as `Authorization: Bearer ...` (GET or POST):

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  https://auth.example.com/realms/myrealm/protocol/openid-connect/userinfo
```

The response carries `sub` plus the claims the granted scopes' protocol mappers produce, `authorization_details` for tokens issued with rich authorization requests, and any claims requested via the `claims` parameter (see **Requesting individual claims** under [Advanced capabilities](#advanced-capabilities)). It does not include `iss` or `scope`, and `aud` appears only when an audience mapper adds an extra audience. A client registered with `userinfo_signed_response_alg` (client attribute or DCR metadata, OIDC Core §5.3.2) instead receives the exact same claim set as a signed JWT with `Content-Type: application/jwt` — the envelope (`iss` = realm issuer, `aud` = your `client_id`, `iat`) is added by the server and wins over any mapper-produced collision; verify the signature against the realm JWKS like an ID token. Note that userinfo additionally checks the **server-side session**: after logout or session expiry it returns `401` even for a JWT whose `exp` has not passed. Access-token *validation*, by contrast, is stateless — a resource server can verify signature, `iss`, `aud`, and `exp` locally against the JWKS without any call back to Issuerd.

**Introspection (RFC 7662).** For deployments that cannot validate JWTs locally:

```bash
curl -X POST https://auth.example.com/realms/myrealm/protocol/openid-connect/token/introspect \
  -u my-app:my-app-secret \
  -d "token=$ACCESS_TOKEN"
```

The calling client must authenticate. Per RFC 7662 §2.2, Issuerd discloses `active: true` (with `scope`, `client_id`, `token_type`, `exp`, `sub`, `aud`, `iss`, `jti`, and — for DPoP-bound or RAR tokens — `cnf` / `authorization_details`) **only to the client the token was issued to**, within the same realm; anything else reports `active: false`. A dedicated resource server that introspects tokens issued to a *different* frontend client will therefore always see `inactive` — use local JWT validation for that topology.

**Refresh-token rotation.** Every successful `grant_type=refresh_token` call **rotates** the refresh token: the presented one is revoked and a new one is returned alongside the new access token.

```bash
curl -X POST https://auth.example.com/realms/myrealm/protocol/openid-connect/token \
  -d grant_type=refresh_token \
  -d refresh_token="$REFRESH_TOKEN" \
  -d client_id=my-app \
  -d client_secret=my-app-secret
```

What clients must do:

- **Always overwrite the stored refresh token with the one in the response.** Reusing an already-rotated token fails with `400 invalid_grant` (this reuse detection is intentional — it surfaces token theft and races).
- Serialize refresh calls per session; two parallel refreshes make one of them fail.
- The realm's SSO idle timeout is enforced at refresh time, and a successful refresh extends the idle window — long-lived apps should refresh regularly rather than only at access-token expiry.
- You may request a narrower `scope` than originally granted (a subset); never a wider one (`invalid_scope`).

**Offline tokens.** Request the `offline_access` scope (it must be assigned to the client) to receive an offline refresh token backed by a separate offline session. Offline tokens use the realm's offline idle window (default 30 days) instead of the SSO lifetimes, and they **survive browser logout**: an RP-initiated logout with `id_token_hint` ends the online SSO session but leaves offline grants alive. To terminate an offline grant, revoke the refresh token:

```bash
curl -X POST https://auth.example.com/realms/myrealm/protocol/openid-connect/revoke \
  -u my-app:my-app-secret \
  -d "token=$REFRESH_TOKEN"
```

Revocation (RFC 7009) requires client authentication, honors `token_type_hint`, and returns `200 OK`.

## Logout

**RP-initiated logout** — send the browser to the end-session endpoint:

```
GET /realms/myrealm/protocol/openid-connect/logout
  ?id_token_hint=eyJhbGciOi...
  &post_logout_redirect_uri=https%3A%2F%2Fapp.example.com%2Flogged-out
  &state=xyz
```

- The `id_token_hint` is cryptographically validated (signature, expiry, issuer) and identifies both the session to destroy and the client whose registration constrains `post_logout_redirect_uri`: the client's `post_logout_redirect_uris` attribute (a JSON array of URI strings) when set, otherwise its `redirect_uris`. Without a recognized client (hint or explicit `client_id` parameter), the redirect is refused rather than risking an open redirector.
- `state` is echoed to the post-logout target, like in the authorization response.
- Without a `post_logout_redirect_uri`, the endpoint renders a "You have been signed out" confirmation page (`200 OK`; a POST variant with form parameters exists for non-browser callers).
- Logout destroys the server-side session identified by the hint **and** the browser SSO session from the realm's `issuerd_session_{realm-id}` cookie, so subsequent userinfo and refresh calls fail — this is stronger than discarding tokens locally.

**Front-channel and back-channel logout** tell *your* application about sessions that end elsewhere (admin action, another client's logout, idle expiry):

- **Back-channel** (server-to-server): if the client has a `backchannel_logout_uri` attribute, Issuerd POSTs a signed logout token (with `sid`) to it for every destroyed session, fire-and-forget. Your app must verify the token against the realm JWKS and terminate its own session for that `sid`. A client registered with `backchannel_logout_session_required = false` receives the token **without** `sid` — correlate by `sub` instead.
- **Front-channel** (browser): if the client has a `frontchannel_logout_uri`, the logout response renders hidden iframes calling it with `iss` and `sid` before the browser continues to the post-logout redirect. Your endpoint must clear its local session cookie for that user. With `frontchannel_logout_session_required = false` the iframe URL is called without `iss`/`sid`.

Both capabilities are advertised in discovery (`backchannel_logout_supported`, `frontchannel_logout_supported`, each with `_session_supported`).

**Session Management (OIDC Session Management 1.0).** Every successful authorization response carries `session_state` (the SSO session id — the same value as the `sid` claim in issued tokens), and login sets a JS-readable companion cookie `issuerd_session_state_{realm}` holding it (`Path=/`; `SameSite=None; Secure` on TLS, `SameSite=Lax` otherwise; refreshed on re-auth, cleared on logout). An RP polls session liveness by iframing `{issuer}/protocol/openid-connect/check_session_iframe` (advertised in discovery as `check_session_iframe`) and posting `<client_id> <session_state>` from its own iframe: the page answers `unchanged` / `changed` / `error` via `postMessage` to the message origin. Note the cookie tracks the *browser's* session, not per-client state — a session ended only out-of-band (admin deletion, idle expiry) flips the answer at the next browser-present login or logout.

## Client authentication methods

Confidential clients authenticate at the token, PAR, revocation, and introspection endpoints — the same verifier backs all four. Discovery advertises the supported set in `token_endpoint_auth_methods_supported`:

| Method | How to authenticate | Configuration |
|---|---|---|
| `client_secret_basic` | `Authorization: Basic base64(client_id:client_secret)` header | Default (`client_authenticator_type` = `client-secret`) |
| `client_secret_post` | `client_id` + `client_secret` form fields | Default |
| `private_key_jwt` | `client_assertion` JWT signed with the client's private key | `client_authenticator_type` = `client-jwt` + client JWKS |
| `client_secret_jwt` | `client_assertion` JWT HMAC-signed with the client secret | `client_authenticator_type` = `client-secret-jwt` |

Details that bite in practice:

- Use exactly **one** method per request — sending both a secret and an assertion is rejected. A client pinned to a JWT method cannot fall back to its secret, and vice versa.
- With Basic auth, a matching body `client_id` is legal; a *contradicting* `client_id` or `client_secret` in the body is rejected with `401 invalid_client` and a `WWW-Authenticate` challenge.
- Secret comparison is constant-time.

For `private_key_jwt` / `client_secret_jwt`, send form fields `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and `client_assertion=<jwt>` with claims:

| Claim | Requirement |
|---|---|
| `iss`, `sub` | Both equal the `client_id` |
| `aud` | The realm issuer URL, the token endpoint URL, or the PAR endpoint URL |
| `exp` | At most 300 s in the future (60 s clock-skew leeway) |
| `jti` | Unique per client — single-use enforced via a replay cache |

`private_key_jwt` verifies against the client's JWKS, configured with Keycloak-spelling client attributes: inline via `use.jwks.string=true` + `jwks.string=<JWKS JSON>`, or fetched via `use.jwks.url=true` + `jwks.url=<https URL>` (cached 5 minutes per client; an unknown `kid` triggers at most one refetch per minute, so key rotation propagates quickly). Asymmetric assertion signatures (RS/ES/EdDSA families) are accepted for `private_key_jwt`, HS* HMAC for `client_secret_jwt`; the exact list is in discovery under `token_endpoint_auth_signing_alg_values_supported`. The `client_id` form field may be omitted when the assertion identifies the client (RFC 7523 §2.2): the server peeks at the unverified assertion's `iss` (falling back to `sub`; both present but disagreeing is refused) and then verifies the signature against the resolved client's keys exactly as when `client_id` is sent — so a code exchange can send only `client_assertion`.

## Ready-made adapter configuration

For applications using an existing Keycloak OIDC adapter or a generic OIDC library, the Admin API renders a drop-in configuration file per client:

```
GET /admin/realms/{realm}/clients/{id}/installation/providers/{provider_id}
```

- `{id}` is the client's **internal UUID** (visible in the console URL when editing the client, or via `GET /admin/realms/{realm}/clients`), not the `client_id` string.
- Requires an admin token with the `view-clients` or `manage-clients` role.
- The available providers are listed in `GET /admin/serverinfo` under `client_installations`; the admin console exposes the same download on the client edit page ("Download adapter config").

Three provider ids exist:

| `provider_id` | Output | Use for |
|---|---|---|
| `keycloak-oidc-keycloak-json` | A Keycloak adapter `keycloak.json`: `realm`, `auth-server-url`, `ssl-required`, `resource`, plus `credentials.secret` for clients that can authenticate with a secret and hold one — confidential clients, or bearer-only clients with service accounts enabled (omitted for public and JWT-authenticated clients, and for bearer-only clients without service accounts) | Existing Keycloak OIDC adapters — drop the file in as `keycloak.json` |
| `generic-oidc-json` | Product-neutral JSON: `issuer`, `authorization_endpoint`, `token_endpoint`, `userinfo_endpoint`, `jwks_uri`, `end_session_endpoint`, `introspection_endpoint`, `client_id`, `client_secret` (when applicable), `redirect_uris` | Generic OIDC libraries and hand-rolled integrations |
| `dotenv` | A ready-to-save `.env` body (`ISSUERD_CLIENT_ID` / `ISSUERD_ISSUER` / `ISSUERD_REDIRECT_URI`, double-quoted values) served as `text/plain` | Containerized apps and scripts that consume configuration from environment files |

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://auth.example.com/admin/realms/myrealm/clients/$CLIENT_UUID/installation/providers/keycloak-oidc-keycloak-json" \
  -o keycloak.json
```

Libraries that support OIDC discovery need none of this — point them at the issuer URL.

## Advanced capabilities

One paragraph each on the advanced OAuth surface; all are implemented and advertised in discovery where the spec defines metadata.

**Pushed Authorization Requests — PAR (RFC 9126).** Push the authorization-request parameters to `POST {issuer}/protocol/openid-connect/ext/par` (client-authenticated like the token endpoint) and receive `201` with a `request_uri` of the form `urn:ietf:params:oauth:request_uri:...` (90-second lifetime, single-use). The browser then starts the flow with only `client_id` and `request_uri`, keeping parameters off the front channel. A realm can refuse non-PAR requests via the `require_pushed_authorization_requests` realm attribute, and a single client can be pinned with its `require.pushed.authorization.requests` attribute; discovery reflects the realm policy.

**JWT-Secured Authorization Requests — JAR (RFC 9101).** Send the whole request as a signed Request Object in the `request` parameter, or by reference: a client that registered `request_uris` (client attribute, or the `request_uris` array in dynamic client registration — https-only values, stored verbatim) may pass one of those URIs as `request_uri` (OIDC Core §6.2); the object is fetched server-side through the SSRF-hardened fetcher (https only, publicly routable IPs, no redirects, capped body) and then takes the exact same validation path as an inline object. The object is verified against the client's JWKS (asymmetric) or client secret (HMAC); its claims win per-key over the query parameters, and the query `client_id` is required to select the verification material. Unsigned Request Objects are always rejected, `request` and `request_uri` are mutually exclusive (RFC 9101 §4), and a `request_uri` the client never registered is refused before any fetch.

**JARM and form_post response modes.** `response_mode=form_post` delivers the authorization response as an auto-submitting HTML form POST to the `redirect_uri` (conformance-verified). The JARM family — `jwt`, `query.jwt`, `fragment.jwt`, `form_post.jwt` — wraps the response in a JWT signed with the realm's active signing key, so the client authenticates the authorization response itself.

**Rich Authorization Requests — RAR (RFC 9396).** Include an `authorization_details` JSON array (every element an object with a non-empty `type`) on the authorization request; it rides the grant into the authorization code and is echoed on the token response. The token request for the `authorization_code` and `refresh_token` grants may *narrow* the granted details. A deployment can pin its supported types with the realm attribute `authorization_details_types` (space-separated) — discovery then advertises them and other types are rejected; without the attribute any type is accepted.

**Requesting individual claims (OIDC Core §5.5).** The `claims` request parameter (`{"id_token": {...}, "userinfo": {...}}`) is evaluated per target wherever an ID token or the userinfo response is produced: the `id_token` section resolves into ID tokens issued at the authorization endpoint (implicit/hybrid) and at the token endpoint's code grant (the parameter rides the authorization code); the `userinfo` section is served at the userinfo endpoint. Edge case: with `response_type=id_token` (pure implicit) no access token is minted, so userinfo is unreachable — both sections ride the ID token instead, and that token also carries the full IdToken ∪ UserInfo mapper claim set (§5.4 permits this when userinfo cannot be reached; Keycloak behaves the same way — code/hybrid ID tokens stay lean and userinfo serves the rest). Mapper-produced claims are never overwritten, unknown or unresolvable entries are omitted, and `essential: true`/`false` marks are presence-based. The refresh, password, device and CIBA grants carry no `claims` context and ignore the parameter.

**Token exchange and impersonation (RFC 8693).** `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` with a `subject_token` that is an access token of the same realm. *Internal exchange* mints a token for the `audience` client, which must carry the attribute `token.exchange.enabled=true`. *Impersonation exchange* (`requested_subject` = target user id) requires the subject token's owner to hold the realm `impersonation` role and stamps the `impersonator` claim. Delegation (`actor_token`) and non-access-token subject/requested types are rejected. The response carries RFC 8693's `issued_token_type`. The subject token's own `aud` **must contain the requesting client** (Keycloak's semantics, unconditional): a client can only exchange a token that was issued for it (string or array `aud`), in both modes, otherwise the exchange fails with `invalid_grant`. The former opt-in `require_requester_in_subject_aud` realm/client attribute was removed — leftovers in stored realms/clients are ignored. For the full agentic walkthrough — attenuation per tool call, DPoP binding across the exchange, a live failure matrix, and the recorded MCP demo — see [Agentic IAM: MCP tool calls with DPoP and token exchange](/agentic-iam-mcp/).

**DPoP sender-constraining (RFC 9449).** A client that sends a `DPoP` proof header at the token endpoint receives tokens bound to the proof key via `cnf.jkt`, and must then present them with the `DPoP` scheme plus a fresh proof (userinfo enforces this, including `ath` binding); bearer presentation of a bound token is rejected. Bound refresh tokens keep the binding across rotation. Accepted proof algorithms are advertised in `dpop_signing_alg_values_supported`; mTLS sender-constraining is deliberately not implemented yet. Replay-cache and proof-lifetime details: [Agentic IAM: MCP tool calls with DPoP and token exchange](/agentic-iam-mcp/).

**Dynamic client registration (RFC 7591/7592).** Per-realm opt-in via the `dynamic_client_registration_enabled` realm attribute; disabled realms return a uniform 404 and discovery omits `registration_endpoint`. Two create paths: `POST /realms/{realm}/clients-registrations/default` (open, rate-limited to 50 registrations per hour per IP) and `POST /realms/{realm}/clients-registrations/openid-connect` (gated by an admin-minted initial access token). Requests may use either the Keycloak-shaped `ClientRepresentation` or the RFC 7591 field spellings (`client_name`, `grant_types`, `response_types`, `token_endpoint_auth_method`, `scope`, `subject_type`, `sector_identifier_uri`, inline `jwks` / `jwks_uri`, `initiate_login_uri`, `post_logout_redirect_uris`, the logout metadata fields, `logo_uri`/`policy_uri`/`tos_uri`, `id_token_signed_response_alg`/`userinfo_signed_response_alg`, `request_uris`/`request_object_signing_alg`, `client_secret`) — the RFC fields are validated per spec (`invalid_client_metadata` / `invalid_redirect_uri` 400s; https-only for `initiate_login_uri`, `jwks_uri`, `request_uris` and the logout/logo/policy/tos URLs; `alg=none` is rejected) and folded into the same client model. Responses carry the RFC 7591 §3.2.1 / RFC 7592 fields `registration_access_token` (next to Keycloak's `registrationAccessToken`), `registration_client_uri`, `client_id_issued_at`, `client_secret_expires_at` and `client_secret`, plus an echo of the registered metadata; `GET`/`PUT`/`DELETE` on the returned `registration_client_uri` (authorized by the registration access token, which rotates on every update) manage the client afterwards. Note the open endpoint applies its payload policy to RFC-spelled input too: caller-controlled JWKS-source and `request_uris` attributes are stripped there, and logout-URI attributes with scriptable or non-loopback plain-http schemes are rejected outright (the token-gated and admin paths keep honoring them). Clients created through the open endpoint carry a `dcr.policy=open` marker, and a later `PUT` with the registration access token re-applies the same policy and re-stamps the marker — the token can never resurrect a stripped attribute or shed the marker.

**Pairwise subjects (OIDC Core §8).** Set the client attribute `subject_type=pairwise` (optionally with `sector_identifier_uri`) and the client's `sub` values become irreversible sector-scoped pseudonyms derived from a per-realm secret (realm attribute `pairwise_sector_key`; rotating it changes every pairwise subject). Discovery advertises `["public", "pairwise"]`.

**CIBA (Client-Initiated Backchannel Authentication), poll mode.** Confidential clients start an out-of-band authentication with `POST {issuer}/protocol/openid-connect/ext/ciba/auth` carrying a user hint and receive an `auth_req_id`. The parser accepts `login_hint`, `login_hint_token`, and `id_token_hint`, but the handler currently resolves the user from `login_hint` (a plain username) only — a request carrying only one of the other two hints fails with `400` `unknown_user_id`. After the user approves on their second device, the client polls the token endpoint with `grant_type=urn:openid:params:grant-type:ciba`. Ping and push delivery modes are out of scope. The agent step-up pattern — binding messages, DPoP-bound step-up tokens, and the recorded approval demo — is covered in [Human step-up approval for agent actions: CIBA](/ciba-step-up/).

**Runnable example.** The three capabilities above (DPoP, token exchange, CIBA) come together in [`examples/agentic-mcp/`](https://github.com/issuerd/issuerd/blob/main/examples/agentic-mcp/): a self-contained docker compose stack (Issuerd + chat agent + MCP server + PostgreSQL RLS) that runs the full agentic scenario in a browser — `docker compose up -d`, sign in as alice/changeme, watch the security trace.

## Realm token and session settings

Token and session lifetimes are realm settings; admins change them in the admin console (realm settings), in provision YAML (`examples/provision.example.yaml`), or through the Admin API realm update. Details in [administration.md](/administration/). Defaults:

| Setting | Default | Governs |
|---|---|---|
| `access_token_lifespan` | 300 s | Access-token `exp` and the token response's `expires_in` |
| `refresh_token_lifespan` | 1800 s | Refresh-token `exp` for online (SSO) sessions |
| `sso_session_idle_timeout` | 1800 s | Idle window enforced at refresh time and for SSO cookie resolution; a successful refresh extends it |
| `sso_session_max_lifespan` | 36000 s | Maximum SSO session age setting (Keycloak model); expiry in the token path is driven by the idle timeout and the refresh-token lifespan above |
| `offline_session_idle_timeout` | 2592000 s (30 days) | Offline refresh-token `exp` and idle enforcement for offline sessions |
| `remember_me_session_idle_secs` | 604800 s (7 days) | Idle window for sessions established with "remember me" |

Server-fixed values clients should not hard-code but may rely on: authorization codes live 600 s; pushed authorization requests 90 s; device codes 600 s with a 5 s minimum poll interval; client assertions may live at most 300 s.

Operational guidance:

- Keep access tokens short (the default 5 minutes is intentional) and let refresh rotation do the work — validation is stateless, so short lifetimes cost no database traffic.
- Clients must tolerate any `expires_in` the realm returns; never assume the default.
- A realm `not_before` timestamp revokes all tokens issued before it wholesale (refresh grants, userinfo, and introspection reject them) — this is the emergency "log everyone out" lever, see [security.md](/security/).
- Signing-key rotation is cluster-wide and transparent to clients that follow the JWKS endpoint; pin nothing but the issuer and JWKS URLs in your application configuration. Multi-node considerations (shared keys, issuer URL behind the load balancer) are in [CLUSTERING.md](/clustering/).
