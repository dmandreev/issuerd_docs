---
title: "Identity brokering"
description: "Identity brokering lets users sign in to Issuerd realms with an external identity provider (IdP) — a corporate OIDC provider or a social login such as Google, GitHub, or Microsoft — instead of (or…"
---

Identity brokering lets users sign in to Issuerd realms with an external identity provider (IdP) — a corporate OIDC provider or a social login such as Google, GitHub, or Microsoft — instead of (or in addition to) a local password. Issuerd acts as a broker: your applications only ever talk OIDC to Issuerd, and Issuerd handles the upstream federation, account creation, and account linking. This document covers configuring external providers, the login and account-linking flows, claim mappers, and operational caveats. It is aimed at system operators and realm administrators. For LDAP/Kerberos *user federation* (a different feature — Issuerd validates credentials against a directory directly), see [user-federation.md](/user-federation/).

## Contents

- [How brokering works](#how-brokering-works)
- [Adding an external OIDC provider](#adding-an-external-oidc-provider)
- [Social provider presets](#social-provider-presets)
- [First broker login](#first-broker-login)
- [Account linking](#account-linking)
- [Identity provider mappers](#identity-provider-mappers)
- [Sending users straight to a provider](#sending-users-straight-to-a-provider)
- [Logout semantics](#logout-semantics)
- [Troubleshooting](#troubleshooting)

## How brokering works

A brokered login is an OIDC authorization-code flow nested inside another one: the application runs a code flow against Issuerd, and Issuerd runs its own code flow (as a confidential client) against the external IdP.

1. The application sends the browser to Issuerd's authorization endpoint, `/realms/{realm}/protocol/openid-connect/auth`. Issuerd pauses a browser flow and either renders the login page — which shows a **"Continue with {display name}"** button for every enabled broker provider (fed by the unauthenticated `GET /realms/{realm}/login/context` endpoint) — or, when the request carries a `kc_idp_hint`, redirects straight to the provider (see [Sending users straight to a provider](#sending-users-straight-to-a-provider)).
2. The button (or hint redirect) lands on `GET /realms/{realm}/broker/{alias}/login?flow={id}`. Issuerd verifies the paused flow and its correlation cookie, stores a single-use broker-state entry (nonce, PKCE verifier, flow id; 10-minute TTL) in the distributed cache, and 303-redirects the browser to the external IdP's authorization endpoint with `response_type=code`, the configured `clientId`, the broker callback URL as `redirect_uri`, the configured scopes, `state`, `nonce`, and an S256 PKCE challenge (enabled by default).
3. The user authenticates at the IdP, which redirects back to the broker callback: `GET /realms/{realm}/broker/{alias}/endpoint?code=...&state=...`. A `POST` variant of the same path accepts IdPs that deliver the code via `response_mode=form_post`. The `state` key is single-use and consumed on arrival.
4. Issuerd exchanges the code server-to-server at the IdP's token endpoint (client authentication per `clientAuthMethod`, PKCE verifier attached). Broker HTTP calls have a 10-second timeout so a hung IdP cannot stall logins.
5. The identity is verified:
   - If the IdP returned an **`id_token`**, it is validated against the IdP's JWKS (signature, `exp`/`nbf` with 60 s leeway, `aud` must contain the configured `clientId`, `iss` must equal the configured/discovered issuer when one is set, `nonce` must match). Only asymmetric signatures (RSA/EC/EdDSA) are accepted — `HS*` id_tokens are rejected. The JWKS is cached per (realm, alias) for one hour; an unknown `kid` triggers one immediate refetch-and-retry. If the id_token carries no profile claims (`email`, `preferred_username`, `name` all absent — legal per OIDC Core §5.4) and a userinfo endpoint is available, Issuerd fetches userinfo and merges it; the signed id_token wins conflicts, and a `sub` mismatch rejects the login.
   - If there is **no `id_token`** (GitHub-style OAuth providers), Issuerd falls back to the userinfo endpoint with the access token.
6. The verified identity is normalized (subject from `sub`, or `id` for GitHub; username from `preferred_username`/`login`; plus `email`, `email_verified`, `given_name`, `family_name`, `name`) and looked up in the realm's link table:
   - **Known link** → the login completes immediately (a disabled local account is rejected with 403).
   - **Unknown identity** → the first-broker-login decision (see [First broker login](#first-broker-login)): silent create/link, or a review/link page.
7. Completion issues a normal Issuerd session — the standard consent gate applies, required actions are enforced (with one exception: the "no password ⇒ UPDATE_PASSWORD" auto-rule never fires on broker logins), and the browser is redirected to the application with an Issuerd authorization code. The session's auth method is `identity_provider`, and the LOGIN event carries `method=identity_provider` in its details.

Endpoint resolution and caching: when the provider is configured with an `issuer`, Issuerd fetches `{issuer}/.well-known/openid-configuration` and caches it per (realm, alias) for one hour in the distributed cache. In a [clustered deployment](/clustering/) this cache is Redis, so broker state and metadata are shared across nodes and the callback may land on any node.

## Adding an external OIDC provider

An identity provider is a per-realm `IdentityProviderConfig` record: `alias`, `provider_id` (`oidc` for a generic provider; `google`/`github`/`microsoft` for the social presets), `enabled`, and a free-form string map `config`. All broker behavior is driven by the `config` keys below — spellings follow Keycloak's OIDC IdP config where Keycloak defines one, and **all values are strings** (quote booleans in JSON/YAML: `"true"`).

| Key | Required | Default | Meaning |
|-----|----------|---------|---------|
| `clientId` | yes | — | Client id registered for Issuerd at the external IdP. |
| `clientSecret` | yes | — | Client secret for the token-endpoint exchange. |
| `issuer` | with discovery | — | OIDC issuer URL. The discovery document is fetched from `{issuer}/.well-known/openid-configuration`. |
| `authorizationUrl` | without discovery | — | Explicit authorization endpoint (overrides discovery). |
| `tokenUrl` | without discovery | — | Explicit token endpoint (overrides discovery). |
| `userInfoUrl` | no | discovered | Explicit userinfo endpoint; also the fallback identity source when the IdP issues no `id_token`. |
| `jwksUrl` | no | discovered | Explicit JWKS endpoint for id_token validation. |
| `useDiscovery` | no | `"true"` when `issuer` is set | Set `"false"` to use only the explicit `*Url` keys. |
| `defaultScope` | no | `openid profile email` | Space-separated scopes requested at the IdP. |
| `clientAuthMethod` | no | `client_secret_basic` | `client_secret_basic` or `client_secret_post`. |
| `pkceEnabled` | no | `"true"` | Send an S256 PKCE challenge to the IdP and hold the verifier for the exchange. |
| `trustEmail` | no | `"false"` | Trust the IdP's email claim: skip the review page and auto-link on verified-email conflicts (see [First broker login](#first-broker-login)). |
| `syncMode` | no | `import` | `import` = run mappers when a user is created/linked; `force` = re-run mappers on every brokered login. |
| `storeTokens` | no | `"false"` | Persist the external refresh token on the link row (see note below). |
| `displayName` | no | the alias | Label of the login-page button ("Continue with …"). |
| `mappers` | no | `[]` | JSON array of mapper objects — see [Identity provider mappers](#identity-provider-mappers). |

Explicit `*Url` keys always win over discovered values. The `iss` check on incoming id_tokens uses the configured `issuer`, falling back to the discovered `issuer` — configure an `issuer` even alongside explicit URLs when the IdP signs tokens with a stable issuer.

> **Note:** `storeTokens` persists the IdP's refresh token on the link record (stored as plain text in the database, **never exposed through any API response**). Nothing in Issuerd currently consumes the stored token — there is no upstream refresh path — so enabling it only widens what a database leak exposes.

Provider ids `ldap`, `kerberos`, and `saml` are not broker providers — LDAP/Kerberos are user-federation providers ([user-federation.md](/user-federation/)) and SAML brokering is not implemented. Such a provider never appears on the login page and its broker endpoints answer "this identity provider is not available for sign-in".

### Admin console

In the admin console (`/admin/console`, see [administration.md](/administration/)) select the realm and open **Identity Providers**. The create dialog offers the provider presets (see below) and pre-fills their config; everything remains editable. The edit page manages the config map and the provider's mappers, and can run a connection test.

### Admin API

CRUD lives under `/admin/realms/{realm}/identity-provider/instances` (reads require the `view-realm` or `manage-realm` role; writes require `manage-realm`):

```bash
# Obtain an admin token first — see administration.md (password grant on the
# master realm's admin-cli client).
TOKEN=...

curl -s -X POST "http://localhost:8080/admin/realms/myrealm/identity-provider/instances" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "alias": "corporate-idp",
        "display_name": "Corporate SSO",
        "provider_id": "oidc",
        "enabled": true,
        "config": {
          "clientId": "issuerd-broker",
          "clientSecret": "s3cr3t",
          "issuer": "https://idp.example.com",
          "defaultScope": "openid profile email",
          "trustEmail": "true"
        }
      }'
```

The representation fields are `alias`, `display_name` (a shorthand that maps to the `displayName` config key — an explicit `config.displayName` entry wins), `provider_id`, `enabled` (defaults to `true`), and `config`. Further endpoints:

- `GET|PUT|DELETE /admin/realms/{realm}/identity-provider/instances/{alias}`
- `GET|POST .../instances/{alias}/mappers`, `PUT|DELETE .../instances/{alias}/mappers/{name}`
- `POST .../instances/{alias}/test-connection` — validates the config and, with discovery enabled, actually fetches and parses the discovery document; returns `{"status": "ok"|"error", "problems": [...]}`.
- `GET /admin/enums/identity-provider-presets` — the preset list below (also embedded in `GET /admin/serverinfo`).

### Provision YAML

The provision file's `identity_providers` section registers providers at boot/provision time (see [provisioning.md](/provisioning/) for apply semantics and `${VAR}` environment interpolation):

```yaml
identity_providers:
  - realm: myrealm
    alias: corporate-idp
    provider_id: oidc
    enabled: true
    config:
      clientId: issuerd-broker
      clientSecret: ${CORP_IDP_CLIENT_SECRET}
      issuer: https://idp.example.com
      defaultScope: openid profile email
      trustEmail: "true"
      syncMode: import
```

## Social provider presets

Presets are pure configuration templates (listed by `identity_provider_presets()` in `crates/issuerd-core/src/broker.rs`, served at `/admin/enums/identity-provider-presets`). Choosing a preset sets the `provider_id` and pre-fills the `config` map; nothing is hardcoded elsewhere. What you must still do at every provider: **register an OAuth/OIDC client (app) for Issuerd and paste its client id and secret into `clientId`/`clientSecret`.** The redirect URI to register at the provider is the broker callback of your realm and alias:

```
{issuer_url}/realms/{realm-name}/broker/{alias}/endpoint
```

For example `https://sso.example.com/realms/myrealm/broker/google/endpoint` for alias `google` in realm `myrealm` (realm **name**, never the UUID). `issuer_url` is the public base URL from `issuerd.toml` — see [configuration.md](/configuration/).

| Preset (`provider_id`) | Pre-filled config | Registration notes |
|------------------------|-------------------|--------------------|
| `google` | `issuer=https://accounts.google.com`, `defaultScope="openid profile email"`, `trustEmail=true` | Create an OAuth 2.0 client (Web application) in Google Cloud Console and add the broker endpoint URL as an authorized redirect URI. |
| `microsoft` | `issuer=https://login.microsoftonline.com/common/v2.0`, `defaultScope="openid profile email"`, `trustEmail=true` | Register an app in Microsoft Entra ID. The preset uses the multi-tenant `/common` endpoint; replace the issuer with `https://login.microsoftonline.com/{tenant}/v2.0` to pin a single tenant. |
| `github` | `authorizationUrl=https://github.com/login/oauth/authorize`, `tokenUrl=https://github.com/login/oauth/access_token`, `userInfoUrl=https://api.github.com/user`, `defaultScope="read:user user:email"`, `useDiscovery=false` | Register an OAuth App under GitHub developer settings; the "Authorization callback URL" is the broker endpoint URL. |

Provider-specific behavior worth knowing:

- **GitHub** issues no OIDC `id_token` and has no discovery — hence the explicit URLs and `useDiscovery=false`. The identity comes from the userinfo call: the subject is the numeric GitHub user `id`, the username is the GitHub `login`. GitHub's `/user` response only contains `email` when the user has a *public* email address; users with private emails arrive with no email at all (the review-profile page then shows an empty email field and no auto-linking by email can occur).
- **Google and Microsoft presets set `trustEmail=true`** because both assert verified addresses. Do not copy that flag blindly to a generic OIDC provider — `trustEmail` lets any external account whose (verified-claimed) email matches a local user take that account over without a password prompt.
- The **generic `oidc` preset** only sets `defaultScope="openid profile email"`; supply `issuer` (preferred) or explicit endpoint URLs plus credentials.

## First broker login

When no link exists for the external identity, `decide_first_broker_login` (in `crates/issuerd-core/src/broker.rs`) picks one of four paths from three inputs: whether the identity's email already belongs to a local user, the provider's `trustEmail` flag, and the IdP's `email_verified` claim.

| Situation | Decision | What happens |
|-----------|----------|--------------|
| Email conflict, `trustEmail=true`, IdP asserted `email_verified` | **Auto-link** | The external identity is silently linked to the existing local user and the login completes. |
| Email conflict, otherwise | **Link-or-create page** | "Link your account": the user proves ownership of the existing local account by entering its password (linking then completes the login), or chooses "Create a separate account instead", which switches to the review-profile page. |
| No conflict, `trustEmail=true` | **Auto-create** | A local user is created on the fly and the login completes with no page. |
| No conflict, otherwise | **Review-profile page** | "Review your profile": username, email, first and last name pre-filled from the external identity, all editable. Submission validates the username (valid and unique) and the email (valid; duplicates rejected unless the realm allows duplicate emails). |

The pages are served at `GET|POST /realms/{realm}/broker/first-login/{execution}` with a 10-minute TTL; a flow cookie guards the POST against CSRF, and failed submissions re-render with an error banner (post/redirect/get).

Account creation details (applies to auto-create, review-create, and the separate-account path):

- The username suggestion is `preferred_username` → the email local part → `{alias}.{subject}`; taken names fall back to `{alias}.{subject}` and then a random suffix.
- `email_verified` is kept only when the IdP asserted it **and** the address survived the review form unedited. If the realm has verify-email enabled and the address is unverified, the new user gets the `VERIFY_EMAIL` required action.
- Created users carry `federation_link = "idp:{alias}"`, receive the realm's default role and default groups, and have no local password — their sign-in method is the IdP (they can set a password later in the account console).
- Mapper rules apply at creation/link time — see the next section.
- A new user whose link row cannot be created (race: the external account got linked elsewhere meanwhile) is rolled back, so a retry starts cleanly.

Subsequent logins through an established link skip all of this and complete immediately.

## Account linking

Users manage their own linked identities in the account console at `/realms/{realm}/account` (Linked accounts page), backed by these account-API endpoints (bearer token of the signed-in user):

- `GET /realms/{realm}/account/api/linked-accounts` — list links (`alias`, `provider_id`, `display_name`, `external_username`, `created_at`).
- `POST /realms/{realm}/account/api/linked-accounts/{alias}` — start the linking ceremony. Returns `{"redirect_url": "/realms/{realm}/broker/{alias}/login?link={token}"}`; the SPA navigates there. Answers `409` when the alias is already linked to this account (re-linking is delete-then-link).
- `DELETE /realms/{realm}/account/api/linked-accounts/{alias}` — unlink. Idempotent (`204` whether or not the link existed), but refuses with `400` when this is the account's only link and the account has no password credential — unlinking would strand the account with no sign-in method.

The ceremony reuses the broker login route in **link mode**: `?link=` carries a signed action token (purpose `broker-link`, 5-minute TTL, intentionally not single-use so a browser restart mid-ceremony does not strand the user). The round-trip to the IdP is identical to a brokered login, but at the callback Issuerd links the external identity to the **currently signed-in** user instead of issuing a session: the realm's SSO cookie (`issuerd_session_{realm-id}`) must be present and its subject must match the token's subject. This blocks login-CSRF link injection (steering a victim's external identity onto an attacker's account). Outcomes redirect back to the account console:

- success → `/realms/{realm}/account/linked-accounts?linked={alias}` (linking the same external account to the same user again is idempotent),
- session cookie missing/mismatched → `?error=link-session-mismatch`,
- external account already linked to a *different* local user → `?error=already-linked`,
- anything else → `?error=link-failed`.

Uniqueness invariants enforced by storage: one external `(alias, subject)` maps to at most one local user, and a local user has at most one link per provider alias.

## Identity provider mappers

Mappers translate external claims into local user data. They live in the IdP's `mappers` config key as a JSON array of objects `{"name", "mapper_type", "config"}` and are managed via the mapper sub-resources of the Admin API (or the admin console's mapper tab). The mapper-type list is exposed at `GET /admin/enums/idp-mapper-types`. A malformed `mappers` value is treated as an empty list — a broken mapper set never locks users out.

| `mapper_type` | Config keys | Effect |
|---------------|-------------|--------|
| `attribute` | `claim`, `attribute` | Copy the claim's values into the user attribute (multi-valued; strings, and string/number/bool array members). When the claim is absent, the attribute is **removed**. |
| `role` | `claim`, `claim_value`, `role` | Grant the named **realm role** when any value of the claim equals `claim_value`. The role must already exist — mappers never create roles; unknown names are skipped with a warning in the log. |
| `username_template` | `template` | Render a username from `${ALIAS}` and `${CLAIM.<name>}` placeholders. Accepted by the API, but the rendered value is currently not consumed by the login paths — auto-created usernames always follow the suggestion logic described in [First broker login](#first-broker-login). |

Example (as stored in the `mappers` config key):

```json
[
  {"name": "org", "mapper_type": "attribute",
   "config": {"claim": "org", "attribute": "organization"}},
  {"name": "admins", "mapper_type": "role",
   "config": {"claim": "groups", "claim_value": "admins", "role": "realm-admin"}}
]
```

When mappers run is governed by `syncMode`:

- `import` (default) — mappers run when a user is created and when a new link is established on an existing account (auto-link, link-via-password). Later logins leave the local record alone, so admin edits and user profile changes survive.
- `force` — mappers additionally re-run on every brokered login, overwriting mapped attributes with the current claim values and re-granting mapped roles (removing the role out of band does not stick). Unmapped attributes and roles are never touched.

## Sending users straight to a provider

Applications can skip the Issuerd login page entirely by adding the Keycloak-compatible `kc_idp_hint` parameter to the authorization request:

```
GET /realms/{realm}/protocol/openid-connect/auth?response_type=code&client_id=...&redirect_uri=...&kc_idp_hint={alias-or-provider-id}
```

Behavior (implemented by the `auth-idp-redirect` stage of the built-in browser flow):

- The hint matches an **enabled** provider by alias *or* by `provider_id` — `kc_idp_hint=google` finds the provider whose id is `google` even if its alias is `gmail`.
- A matching provider challenges the flow with a redirect straight into `/realms/{realm}/broker/{alias}/login?flow={id}` — the user never sees the login form.
- An unknown or disabled hint is ignored: the flow falls through to the ordinary login page (no error).
- The redirect stage runs *after* the cookie/SPNEGO stages, so an existing SSO session still wins over the hint (Keycloak's ordering).
- The hint is evaluated when the authorization request starts the flow; it is not persisted into a resumed flow.

## Logout semantics

Brokered sessions are ordinary Issuerd sessions. RP-initiated logout (`/realms/{realm}/protocol/openid-connect/logout`), account-console sign-out, and admin session deletion all tear the session down and notify clients per their back-/front-channel logout configuration (see [client-integration.md](/client-integration/)). What deliberately does **not** happen:

- **No upstream IdP logout.** The external IdP's session is left untouched — Issuerd parses the discovery `end_session_endpoint` but never calls it. After logging out of your application, the user is typically still signed in at the external IdP, so the next brokered login may complete silently without a credential prompt. Users who want a full sign-out must also log out at the IdP itself.
- **No upstream token revocation.** A stored external refresh token (`storeTokens`) is not revoked when the session ends or the link is deleted.
- **Unlinking does not invalidate active sessions**; it only affects the next brokered login.

## Troubleshooting

For general diagnostics (logs, events, metrics), see [troubleshooting.md](/troubleshooting/) and [monitoring.md](/monitoring/). Broker-specific symptoms:

- **The provider rejects the redirect or returns an error immediately after login.** Almost always a redirect-URI mismatch: the URI registered at the IdP must be exactly `{issuer_url}/realms/{realm-name}/broker/{alias}/endpoint` (realm *name*; any trailing slash on `issuer_url` is trimmed). Behind a reverse proxy, `issuer_url` must be the external base URL, not the internal listener — see [deployment.md](/deployment/). IdP-side errors (`access_denied`, user cancelled) land the user back on the login page with `error=identity_provider_error`, as do code-exchange and token-validation failures; the log line `identity provider ... failed` / `brokered code exchange failed` (WARN, with realm and alias) carries the cause — unreachable host, token endpoint rejection (`invalid_grant`, e.g. wrong secret), or id_token validation failure.
- **"The sign-in session is invalid or has expired — please start again"** at the callback: the broker `state` was unknown — the 10-minute round-trip TTL elapsed, the state was already consumed (single-use; browser back button or a double-submitted callback), or the cache lost the entry. Start the login again.
- **"this identity provider could not be reached" / "not configured correctly"** on the broker login kickoff: the IdP config failed validation or discovery. Run `POST /admin/realms/{realm}/identity-provider/instances/{alias}/test-connection` for a precise problem list.
- **Missing email or profile on the created user.** Code-flow id_tokens may legally carry only the subject (OIDC Core §5.4); Issuerd then fetches userinfo when an endpoint is configured/discovered. If the IdP has no userinfo endpoint, or the claims are absent there too, the identity has no email — the review page shows an empty email field and email-based auto-linking cannot happen. GitHub-specific: `/user` only returns `email` when the user's address is public.
- **Logins failing after the provider rotated signing keys.** The JWKS is cached for one hour; an unknown `kid` already triggers one immediate refetch, so a single retry usually succeeds. Endpoint changes at the IdP (new authorization/token URLs) wait on the one-hour discovery cache — restart the node or flush the `broker_meta:*` cache keys to pick them up sooner.
- **Clock skew.** External id_token `exp`/`nbf` are validated with 60 seconds of leeway; beyond that, validation fails and the user sees `identity_provider_error`. Keep NTP healthy on both Issuerd and the IdP.
- **Accounts linked to the wrong user / unexpected auto-linking.** That is `trustEmail` doing exactly what it says: it auto-links any external identity whose (IdP-asserted) verified email matches a local account, with no password prompt. Only enable it for providers that truly verify addresses; otherwise users get the link-via-password page instead.
- **Provider button missing from the login page.** The provider is disabled, its `provider_id` is a federation type (`ldap`/`kerberos`/`saml`), or the login page was opened outside an authorization flow (buttons render only mid-flow). Check `GET /realms/{realm}/login/context` — it lists exactly what the page will show.
