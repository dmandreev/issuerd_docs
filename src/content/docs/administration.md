---
title: "Administration: admin console and Admin REST API"
description: "This document covers day-to-day administration of a running Issuerd server: how administrative access is authorized, how to obtain an admin token, a tour of the embedded admin console at…"
---

This document covers day-to-day administration of a running Issuerd server: how administrative access is authorized, how to obtain an admin token, a tour of the embedded admin console at `/admin/console`, the layout of the Admin REST API under `/admin/...`, a curl cookbook for the most common operations, the OpenAPI surfaces, and how event recording is gated per realm. It is written for system operators and administrators. First-time setup is covered in [getting started](/getting-started/); declarative, file-driven realm setup is covered in [provisioning](/provisioning/) — everything provisioning can do is also possible through the surfaces described here.

## Contents

- [The admin access model](#the-admin-access-model)
- [Getting an admin token](#getting-an-admin-token)
- [The admin console](#the-admin-console)
- [Admin REST API](#admin-rest-api)
- [Curl cookbook](#curl-cookbook)
- [OpenAPI and Swagger UI](#openapi-and-swagger-ui)
- [Events management for administrators](#events-management-for-administrators)

## The admin access model

Every request to `/admin/...` must carry a valid Issuerd access token in the `Authorization: Bearer` header. Authorization then happens in two stages, enforced by the admin middleware (`crates/issuerd-admin-api/src/auth.rs`):

1. **Realm binding** — the token's issuer (`iss`, whose trailing path segment is a realm **name**) decides which realms the token may administer:
   - A token issued by the **`master`** realm administers **every** realm.
   - A token issued by any other realm administers **only that realm**. Presenting it against another realm's path returns `403 Forbidden`.
   - Paths without a `{realm}` segment — realm creation and listing (`POST/GET /admin/realms`, `GET /admin/realms/count`) — are **master-only**.
2. **Role check** — each handler additionally requires one or more roles from the token's `realm_access` claim (see the table in [Admin REST API](#admin-rest-api)).

### The realm-management roles

Issuerd's administrative roles are seven **realm roles** (created per realm, assigned to users):

| Role | Allows |
|---|---|
| `view-realm` | Read realm settings, roles, groups, sessions, events, keys, flows, identity providers, server info |
| `manage-realm` | All `view-realm` operations plus realm create/update/delete, roles, groups, flows, events config, key rotation/disable, sessions revocation, identity providers, SMTP test, partial import, push-revocation |
| `view-users` | List/search users, read user details, role mappings, groups, sessions, credentials (redacted) |
| `manage-users` | All `view-users` operations plus create/update/delete users, reset passwords, credential CRUD, role mappings, group membership, execute-actions email, attack-detection |
| `view-clients` | List/read clients, client secrets, client roles, client scopes, mappers, scope mappings, service-account user |
| `manage-clients` | All `view-clients` operations plus client create/update/delete, secret rotation, client roles, client scopes, mappers, scope mappings, initial-access tokens |
| `impersonation` | `POST .../users/{id}/impersonation` (also gates token-exchange impersonation) |

Reads accept the `view-*` variant *or* the matching `manage-*` variant; writes require `manage-*`.

> **Note:** Keycloak models these as client roles on a per-realm `realm-management` client. Issuerd has no `realm-management` client — the seven roles are plain realm roles, and the built-in public client used for admin logins is `admin-cli` (auto-created in every realm). Do not create a client named `realm-management` expecting Keycloak semantics.

The roles are seeded automatically **only in the `master` realm**, and only when the master-realm bootstrap runs (in-memory/JSON-file storage) or when your provision file defines them — see `examples/provision.demo.yaml` for the canonical list. A realm created later through the Admin API or the console does **not** contain them automatically.

### Realm revocation cutoff (`notBefore`)

When a realm's `not_before` is set, admin tokens issued before that instant (`iat < not_before`) are rejected with `401`. A master token administering another realm must satisfy **both** realms' cutoffs. Set it via `PUT /admin/realms/{realm}` with `notBefore` — this is Issuerd's actual revocation mechanism (`POST .../push-revocation` is a compatibility stub that only records an admin event and returns 204).

### Recipe: grant a user admin rights over a single realm

Goal: user `ops-admin` may administer realm `acme` but nothing else.

1. Create the realm-management roles you want to delegate in `acme` (they are not seeded in new realms). At minimum:

   ```bash
   for r in view-realm manage-realm view-users manage-users view-clients manage-clients; do
     curl -s -X POST "$IC/admin/realms/acme/roles" \
       -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
       -d "{\"name\": \"$r\"}"
   done
   ```

2. Create the user in `acme` and set a password (see the [cookbook](#curl-cookbook)).
3. Assign the roles to the user (role-mappings recipe below).
4. The user now logs in against the **`acme`** realm — via the console realm switcher, the password grant against `/realms/acme/protocol/openid-connect/token`, or `POST /api/v1/auth/admin-token` with `"realm": "acme"`. The resulting token's issuer binds it to `acme`; requests against other realms return 403, and realm creation/listing remains denied (master-only).

The same result can be achieved declaratively in the provision file (`roles:` + user `realm_roles:`), as `examples/provision.demo.yaml` does for `master` — see [provisioning](/provisioning/).

## Getting an admin token

There are two supported ways, both verified against the server code.

### Standard token endpoint (Keycloak-compatible)

The password grant against the realm's token endpoint with the built-in public client `admin-cli`:

```bash
curl -s -X POST "http://localhost:8080/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" \
  -d "username=admin" \
  -d "password=admin" \
  -d "scope=openid"
```

Response: a standard OIDC token response (`access_token`, `expires_in`, `refresh_token`, …). Role claims land in the access token through the realm's default scope assignments.

### Internal admin-token endpoint (what the console and test harness use)

The embedded consoles and the integration test harness (`tests/harness/mod.rs`) use a JSON convenience endpoint:

```bash
curl -s -X POST "http://localhost:8080/api/v1/auth/admin-token" \
  -H "Content-Type: application/json" \
  -d '{"realm": "master", "username": "admin", "password": "admin"}'
```

Response shape:

```json
{ "access_token": "eyJhbGciOi...", "token_type": "Bearer", "expires_in": 300 }
```

The endpoint verifies the password against the realm's `admin-cli` client, creates a real user session, and applies the same brute-force lockout tracking as browser login; unknown or disabled usernames cost the same as a wrong password (no user enumeration via timing). It returns `401 {"error": "invalid_grant"}` on any authentication failure.

### Token properties

- The token is a **bearer token** for all `/admin/...` endpoints: `Authorization: Bearer <access_token>`.
- Lifetime is the issuing realm's `access_token_lifespan` — **300 seconds by default** (`expires_in` in the response tells you the effective value). Scripted workflows should re-fetch the token per run rather than cache it; interactive API users can raise the lifetime on the realm (Tokens tab, or `access_token_lifespan` in the realm representation — that representation mixes snake_case defaults with selective camelCase renames, and this field keeps the snake_case name).
- Admin sessions are real user sessions: they appear under Sessions and are revoked when the session is deleted, when the user logs out, or when `notBefore` is set.

> **Warning:** The demo credentials (`admin`/`admin` on the in-memory/json bootstrap and the Docker demo stack) are well-known. Change the master admin password before the server is reachable by anyone else — see [getting started](/getting-started/#first-hardening-steps) and [security](/security/).

## The admin console

The admin console is a React SPA embedded in the server binary, served same-origin at:

```
http://<host>:<port>/admin/console
```

(Bare `/` and `/admin` redirect there.) It requires the embedded web UI: binaries built without `webclientsrc` answer `404 Web UI not embedded. Build webclientsrc first.` Login runs an authorization-code flow against the realm's `admin-cli` client (redirect `{base}/admin/console/callback`); you can sign in as any user holding admin roles in the selected realm. A realm picker/switcher in the sidebar selects the realm all screens operate on — a master-realm administrator can switch to any realm, a single-realm administrator sees only their own.

### Realm settings

`Realm settings` edits the realm representation directly (`GET/PUT /admin/realms/{realm}`). Tabs:

- **General** — display name, enabled flag, SSL-required level, themes (login/email/admin theme dropdowns populated from the server's theme list), flow bindings, and default groups.
- **Localization** — internationalization toggle, supported locales, default locale.
- **Login** — login-page behavior flags (registration, forgot-password/reset credentials, remember me, login with email, email-code login).
- **Email** — the realm's SMTP overrides, stored as realm attributes under `smtpServer.*` (`host`, `port`, `from`, `fromDisplayName`, `replyTo`, `user`, `password`, `starttls`, `ssl`). These override the global `[smtp]` configuration for this realm only; sending stays gated on the global `smtp.enabled = true` (see [configuration](/configuration/)). A **Test Connection** box sends a real test mail through the resolved configuration (`POST .../test-smtp-connection`).
- **Tokens** — access/refresh token lifespans, SSO session idle/max, offline session idle, default signature algorithm.
- **Sessions** — session-related realm settings.
- **Security** — password policy, brute-force protection flags, OTP policy.
- **Events** — the events configuration (`GET/PUT .../events/config`, see [Events management](#events-management-for-administrators)).
- **Actions** — destructive/operational realm actions: `notBefore` revocation, partial import, delete realm.

### Keys

The **Keys** page (`GET /admin/realms/{realm}/keys`) lists the signing keys with algorithm, `kid`, and status (ACTIVE/PASSIVE), and offers:

- **Rotate** — `POST .../keys/rotate`, optionally with `{"algorithm": "ES256", "key_size": 2048}` (algorithm defaults to the newest active key's, the server-default EdDSA when no key exists; RSA sizes 2048–8192; HMAC algorithms are rejected). Rotation keeps exactly one active key **per algorithm**: other active keys of the same algorithm are demoted to passive. On an empty key set the rotation establishes the fresh-deployment pair — the requested key plus an active RS256 key (the OIDC Core mandatory-to-implement algorithm) — so discovery advertises RS256 from the start.
- **Disable** — `PUT .../keys/{kid}/disable` marks a key passive: it stays in the JWKS and still validates previously issued tokens, but never signs new ones. The last remaining active key cannot be disabled.

**Choosing an algorithm.** New deployments default to **EdDSA (Ed25519)**: the first-boot EdDSA key signs for realms without an explicit setting — fast verification and small keys. The first boot also creates an active **RS256** key alongside it, because OIDC Core makes RS256 mandatory-to-implement: discovery advertises it and realms pinned to RS256 work without a rotation. Otherwise treat **RS256** as an explicit compatibility choice for clients that only understand RSA (pin the realm's `default_signature_algorithm` attribute to `RS256` on the Tokens tab), and pick **ES256** where Ed25519 is unavailable in your client stack. The `HS*` (HMAC) entries in the algorithm dropdowns are not applicable to realm token signing — the realm attribute ignores them and rotation rejects them. Context: the `rsa` crate is used only for key *generation* (signing/verification use `ring`), so the `RUSTSEC-2023-0071` (Marvin) RSA-decryption padding oracle is unreachable here. See [configuration.md — Token signing algorithm](/configuration/#token-signing-algorithm) for the full policy.

Signing keys are **server-global** (shared by all realms and cluster nodes via the `signing_keys` table); the realm segment in the path is namespace parity with Keycloak only. Rotation/disable reloads this node's keystore immediately; peer cluster nodes pick the change up via JWKS polling — see [CLUSTERING.md](/clustering/).

### Clients

The client list (`GET .../clients`) leads to the client editor with tabs:

- **Settings** — all fields of the client representation: `client_id`, enabled, protocol, public/confidential (`public_client`), bearer-only, redirect URIs, web origins, default/optional scopes, consent required, full scope allowed, service accounts, client-authenticator type, attributes. The **Credentials** area reads the current secret (`GET .../clients/{id}/secret`) and rotates it (`POST .../clients/{id}/client-secret`). **Download adapter config** (`GET .../clients/{id}/installation/providers/{provider_id}`) exports `keycloak-oidc-keycloak-json` or `generic-oidc-json` for application-side adapters — see [client integration](/client-integration/).
- **Roles** — client-role CRUD (`.../clients/{id}/roles[/{role_name}]`) and composites.
- **Mappers** — client-local protocol mappers (`.../clients/{id}/protocol-mappers/models[/{mapper_id}]`).
- **Client Scopes** — scope assignments (`.../default-client-scopes`, `.../optional-client-scopes`).
- **Scope Mappings** — role scope mappings (`.../clients/{id}/scope-mappings/...`).

Enabling **service accounts** provisions the backing `service-account-{client_id}` user immediately; `GET .../clients/{id}/service-account-user` returns it (creating it lazily if needed) so you can assign roles to it. Client create/update/delete requires `manage-clients`.

`clients-initial-access` endpoints (`GET/POST/DELETE .../clients-initial-access[/{id}]`) mint the initial-access tokens consumed by dynamic client registration — see [client integration](/client-integration/).

### Client scopes

Named, reusable bundles of protocol mappers (`.../client-scopes[/{id}]` plus `.../protocol-mappers/models[/{mapper_id}]`). The realm-level tables `.../default-default-client-scopes` and `.../default-optional-client-scopes` control which scopes new clients get assigned automatically; assignments on a client sync the client's scope string lists. Mapper type dropdowns are populated dynamically from `GET /admin/enums/mapper-types`.

### Roles

Realm-role CRUD (`.../roles[/{role_name}]`) with composite-role management (`.../roles/{role_name}/composites[/realm|/clients/{client_uuid}]`). Composite roles expand into effective role sets everywhere roles are evaluated (tokens, `composite` role-mapping sub-resources).

### Users

The user list (`GET .../users?search=...&first=&max=`) searches username, email, first and last name; `GET .../users/count` gives the filtered total. The user detail page has tabs:

- **Details** — username, email (+verified flag), names, enabled, attributes, required actions (`requiredActions` in the representation). Known required-action ids are `VERIFY_EMAIL`, `UPDATE_PASSWORD`, `UPDATE_PROFILE`, `CONFIGURE_TOTP`, `TERMS_AND_CONDITIONS`.
- **Credentials** — lists credentials **redacted** (no secret material ever leaves the API), rename labels, delete (the user's **last** credential cannot be deleted — 400), reorder via `moveAfter` (renumbers priorities `1..n`). **Reset password** (`PUT .../users/{id}/reset-password`) validates against the realm password policy, keeps superseded passwords as inert history entries per `history_size`, and — when `temporary: true` — assigns `UPDATE_PASSWORD` so the user picks a new password at next login.
- **Role Mappings** — realm and client role assignment with `available`/`composite` (effective) views.
- **Groups** — membership management.
- **Sessions** — the user's live sessions (including an Offline badge for offline sessions).

Two user-level actions live behind buttons on the detail page:

- **Impersonate** — `POST .../users/{id}/impersonation` (requires the `impersonation` role). Returns a full token response for a session recorded as the target user with an `impersonator` claim naming the administrator; an admin event and a login event are written. Self-impersonation and disabled users are rejected (400).
- **Execute actions email** — `PUT .../users/{id}/execute-actions-email?redirect_uri=&lifespan=` with a JSON body of action ids (`["UPDATE_PASSWORD","VERIFY_EMAIL"]`). Mails the user a signed action link (default validity 12 h) that opens the required-action flow; the mail template is English-only. Unknown action ids and users without an email address are rejected (400). Requires working SMTP (see the Email tab).

### Groups

Group CRUD with hierarchy: top-level groups via `POST .../groups`, sub-groups via `POST .../groups/{id}/children` (paths computed as `{parent.path}/{name}`; group names are unique realm-wide). Members (`GET .../groups/{id}/members`), realm/client role mappings with `available`/`composite` sub-resources, and **move** by writing `parent_id` on the group representation (explicit `null` moves to root). `sub_groups` inside create/import bodies is rejected — hierarchy is built through the children endpoint or `parent_id`.

### Authentication flows

Flow management (`.../authentication/flows`) with per-execution control: copy (`POST .../flows/{alias}/copy`), add/remove executions and sub-flows, change requirement levels (REQUIRED/ALTERNATIVE/CONDITIONAL/DISABLED), and per-execution authenticator configuration (`.../authentication/executions/{execution_id}/config`). The built-in `browser` and `registration` flows are seeded per realm and are **read-only** — duplicate them to customize, then bind the copy on the realm's General tab. Saving a flow validates the whole stage set, so a flow that cannot resolve at runtime cannot be saved.

### Identity providers and user federation

External identity providers (`.../identity-provider/instances[/{alias}]`) with mappers and a **Test connection** action (`POST .../instances/{alias}/test-connection`). This single registry backs both [identity brokering](/identity-brokering/) (OIDC/social presets) and [user federation](/user-federation/) (`provider_id` `ldap`/`kerberos`). For federation providers, the edit page also exposes **Sync users** — `POST .../user-federation/{provider_id}/sync?strategy=full|incremental` — which reports `{added, updated, removed, failed, last_sync}`.

### Sessions

Realm-wide session list (`GET .../sessions`, `GET .../sessions/count`) and revocation (`DELETE .../sessions/{session}`). Offline sessions are included, typed. Revoking a session kills its refresh tokens; already-issued access tokens remain valid until expiry (stateless validation) unless `notBefore` is set.

### Events

Login/user events (`GET .../events`) and admin events (`GET .../admin-events`) with type/date filters and server-side pagination backed by `GET .../events/count` / `GET .../admin-events/count`. Event rows resolve `user_id` → current `username` at query time; admin events resolve `auth_username` against `auth_realm_id` (so master-realm administrators are named correctly when they act on other realms). Querying details are covered in [monitoring](/monitoring/).

### Server info and the security dashboard

- **Server info** — renders `GET /admin/serverinfo`: all enum lists (protocols, algorithms, authenticators, mapper types, IdP presets, client-installation providers, locales, themes, …) that drive the console's dynamic dropdowns.
- **Security dashboard** — the attack-detection surface (`GET .../attack-detection/brute-force/users` lists currently locked (username, IP) pairs; per-user status and unlock via `GET`/`DELETE .../attack-detection/brute-force/users/{id}`).

## Admin REST API

### Base layout

All endpoints are rooted at `/admin` on the same HTTP listener as everything else. The tree (see `crates/issuerd-admin-api/src/routes.rs` for the authoritative list):

| Prefix | Area |
|---|---|
| `/admin/realms`, `/admin/realms/{realm}` | Realm CRUD (create/list master-only) |
| `/admin/realms/{realm}/users[...]` | Users, credentials, role-mappings, groups membership, sessions, reset-password, execute-actions-email, impersonation |
| `/admin/realms/{realm}/attack-detection/brute-force/users[/{id}]` | Brute-force lockouts |
| `/admin/realms/{realm}/clients[...]` | Clients, secrets, service-account-user, client roles, protocol-mappers, scope assignments, scope-mappings |
| `/admin/realms/{realm}/clients-initial-access[/{id}]` | Initial-access tokens for dynamic registration |
| `/admin/realms/{realm}/clients/{id}/installation/providers/{provider_id}` | Adapter config download |
| `/admin/realms/{realm}/client-scopes[...]` | Client scopes and their mappers |
| `/admin/realms/{realm}/default-default-client-scopes`, `/admin/realms/{realm}/default-optional-client-scopes` | Realm default scope tables |
| `/admin/realms/{realm}/roles[...]` | Realm roles and composites |
| `/admin/realms/{realm}/groups[...]` | Groups, children, members, role-mappings |
| `/admin/realms/{realm}/sessions[...]` | Realm sessions |
| `/admin/realms/{realm}/events`, `/admin/realms/{realm}/admin-events`, `.../events/count`, `.../admin-events/count`, `.../events/config` | Events |
| `/admin/realms/{realm}/identity-provider/instances[...]` | Identity providers (brokering + federation), mappers, test-connection |
| `/admin/realms/{realm}/user-federation/{provider_id}/sync` | Trigger federation sync |
| `/admin/realms/{realm}/keys[...]` | Signing-key metadata, rotate, disable |
| `/admin/realms/{realm}/authentication/flows[...]`, `.../executions[...]` | Flows and executions |
| `/admin/realms/{realm}/partialImport`, `/admin/realms/{realm}/export`, `/admin/realms/{realm}/push-revocation` | Import/export, revocation stub |
| `/admin/realms/{realm}/test-smtp-connection` | SMTP end-to-end test |
| `/admin/serverinfo`, `/admin/enums/*` | Server info and enum lists |
| `/admin/openapi.json` | Admin-API-only OpenAPI document (requires a token like every `/admin` route) |

The `{realm}` path segment is always the realm **name**, never the UUID. The `{id}` segments for users/clients/groups are internal UUIDs (for clients, the `client_id` string addresses nothing in the Admin API — look the UUID up from list/get responses; role-mapping paths spell it `{client_id}` but expect the UUID).

### Authentication and authorization

`Authorization: Bearer <access_token>` on every call. Missing/invalid token → `401`; token bound to another realm, realm-less path without a master token, or missing required role → `403`. Role requirements by area (reads accept view- or manage-; writes require manage-):

| Area | Read roles | Write roles |
|---|---|---|
| Realms, keys, sessions, events, roles, groups, flows, IdPs | `view-realm` / `manage-realm` | `manage-realm` |
| Users, credentials | `view-users` / `manage-users` | `manage-users` |
| Attack-detection | `manage-users` | `manage-users` |
| Clients, client roles/scopes/mappers, initial access | `view-clients` / `manage-clients` | `manage-clients` |
| Federation sync | — | `manage-realm` or `manage-users` |
| Impersonation | — | `impersonation` |
| serverinfo, enums | `view-realm` / `manage-realm` | — |

### Pagination

List endpoints accept `first` (zero-based offset, default 0) and `max` (page size, **default 20**). Filtered totals come from the sibling `.../count` endpoints (`/realms/count`, `/users/count`, `/clients/count`, `/roles/count`, `/groups/count`, `/sessions/count`, `/events/count`, `/admin-events/count`), which return `{"count": <n>}`.

### Error shape

Errors are JSON with camelCase keys, matching Keycloak's wire format (`crates/issuerd-admin-api/src/error.rs`):

```json
{ "errorMessage": "user 'alice' already exists" }
```

Password-setting failures additionally carry machine-readable policy violations:

```json
{
  "errorMessage": "password policy violation: ...",
  "policyViolations": [{ "code": "min_length", "message": "..." }]
}
```

Status codes: `400` validation (including password policy and unknown enum values), `401` missing/invalid/expired token or token issued before `notBefore`, `403` cross-realm token or missing role, `404` unknown realm/resource, `409` duplicates (realm/user/client/group exists; partial-import FAIL), `501` for operations a provider does not support (e.g. incremental sync).

## Curl cookbook

All recipes assume a bash shell with:

```bash
IC=http://localhost:8080
TOKEN=$(curl -s -X POST "$IC/api/v1/auth/admin-token" \
  -H "Content-Type: application/json" \
  -d '{"realm":"master","username":"admin","password":"admin"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
```

(In the demo stack the credentials are `admin`/`admin`; substitute yours.) All requests below add `-H "Authorization: Bearer $TOKEN"`.

### Create a realm

```bash
curl -s -X POST "$IC/admin/realms" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"realm": "acme", "display_name": "Acme Corp", "enabled": true}'
# → 201 with the created RealmRepresentation
```

Creating a realm auto-provisions its built-in `admin-cli` and `account-console` clients and the built-in browser/registration flows. Realm **renames are not supported** (`PUT` rejects a body realm different from the path realm).

### Create a confidential client and read its secret

```bash
curl -s -X POST "$IC/admin/realms/acme/clients" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "client_id": "acme-api",
        "enabled": true,
        "public_client": false,
        "service_accounts_enabled": true,
        "redirect_uris": ["https://app.acme.example/callback"],
        "web_origins": ["https://app.acme.example"]
      }'
# → 201 ClientRepresentation; note the "id" (UUID) from the response or from:
CID=$(curl -s "$IC/admin/realms/acme/clients" -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json; print([c["id"] for c in json.load(sys.stdin) if c["client_id"]=="acme-api"][0])')

curl -s "$IC/admin/realms/acme/clients/$CID/secret" -H "Authorization: Bearer $TOKEN"
# → {"type": "client-secret", "value": "..."}   (rotate with POST .../clients/$CID/client-secret)
```

Secrets are never included in client list/get responses; omitting `secret` in an update body leaves the stored secret unchanged.

### Create a user and set a password

```bash
curl -s -X POST "$IC/admin/realms/acme/users" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "username": "alice",
        "email": "alice@acme.example",
        "enabled": true,
        "credentials": [{"type": "password", "value": "ChangeMe!42", "temporary": false}]
      }'
# → 201 UserRepresentation (initial passwords are policy-checked and Argon2id-hashed)
```

Or set/reset later (also accepts `temporary: true`, which forces `UPDATE_PASSWORD` at next login):

```bash
UID=$(curl -s "$IC/admin/realms/acme/users?search=alice" -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["id"])')

curl -s -X PUT "$IC/admin/realms/acme/users/$UID/reset-password" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type": "password", "value": "NewSecret!42", "temporary": true}'
# → 204 (400 + policyViolations on policy failure)
```

### Assign realm and client roles to a user

Role assignments reference roles **by id** — fetch the representations first, then POST the subset you want to grant:

```bash
# Realm roles
curl -s "$IC/admin/realms/acme/roles" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$IC/admin/realms/acme/users/$UID/role-mappings/realm" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '[{"id": "<role-uuid>", "name": "manage-users"}]'
# → 204

# Client roles: create the role on the client, then assign via the client UUID
curl -s -X POST "$IC/admin/realms/acme/clients/$CID/roles" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "reader"}'
RID=$(curl -s "$IC/admin/realms/acme/clients/$CID/roles/reader" -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
curl -s -X POST "$IC/admin/realms/acme/users/$UID/role-mappings/clients/$CID" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "[{\"id\": \"$RID\", \"name\": \"reader\"}]"
# → 204 (DELETE with the same body removes; .../available and .../composite list assignable/effective)
```

### Create a group and add a member

```bash
curl -s -X POST "$IC/admin/realms/acme/groups" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "developers"}'
# → 201 GroupRepresentation (sub-groups: POST .../groups/{id}/children)

GID=$(curl -s "$IC/admin/realms/acme/groups" -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json; print([g["id"] for g in json.load(sys.stdin) if g["name"]=="developers"][0])')

curl -s -X PUT "$IC/admin/realms/acme/users/$UID/groups/$GID" -H "Authorization: Bearer $TOKEN"
# → 204 (DELETE removes the membership)
```

### Set realm SMTP attributes

Realm SMTP settings are realm **attributes** under `smtpServer.*` (Keycloak model), merged over the global `[smtp]` config. Update the realm representation:

```bash
# Read-modify-write: fetch the realm, patch attributes, PUT it back
curl -s "$IC/admin/realms/acme" -H "Authorization: Bearer $TOKEN" > realm.json
python3 - <<'EOF'
import json
r = json.load(open("realm.json"))
r.setdefault("attributes", {}).update({
    "smtpServer.host": "mail.acme.example",
    "smtpServer.port": "587",
    "smtpServer.from": "no-reply@acme.example",
    "smtpServer.starttls": "true",
    "smtpServer.user": "smtp-user",
    "smtpServer.password": "smtp-secret",
})
json.dump(r, open("realm.json", "w"))
EOF
curl -s -X PUT "$IC/admin/realms/acme" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d @realm.json
# → 204

# End-to-end check (sends a real mail through the resolved config):
curl -s -X POST "$IC/admin/realms/acme/test-smtp-connection" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"email": "ops@acme.example"}'
# → 204, or 400 with errorMessage "SMTP test failed: ..."
```

> **Note:** Sending stays disabled until the **global** `[smtp] enabled = true` is set in the server config — realm attributes only override connection details. See [configuration](/configuration/).

### Trigger user-federation sync

```bash
curl -s -X POST "$IC/admin/realms/acme/user-federation/ldap-main/sync?strategy=full" \
  -H "Authorization: Bearer $TOKEN"
# → {"added": 1520, "updated": 3, "removed": 0, "failed": 0, "last_sync": "2026-09-12T..."}
```

`{provider_id}` accepts the provider's alias **or** id. `strategy=incremental` syncs only changes since the persisted `lastSyncTime` watermark (`501` if the provider does not support it); `full` is the default. Provider configuration itself is covered in [user federation](/user-federation/).

### Rotate signing keys and disable a key

```bash
curl -s "$IC/admin/realms/acme/keys" -H "Authorization: Bearer $TOKEN"
# → {"active": {"EdDSA": "<kid>", "RS256": "<kid2>"}, "passive": [...]}

curl -s -X POST "$IC/admin/realms/acme/keys/rotate" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"algorithm": "ES256"}'
# → 200 key metadata after rotation (same-node reload is immediate; cluster peers follow via JWKS polling)

curl -s -X PUT "$IC/admin/realms/acme/keys/<kid>/disable" -H "Authorization: Bearer $TOKEN"
# → 204; disabling the LAST active key is rejected (400)
```

### Partial import and export

```bash
curl -s -X POST "$IC/admin/realms/acme/partialImport?ifResourceExists=SKIP" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "users": [{"username": "bob", "email": "bob@acme.example", "enabled": true}],
        "groups": [{"name": "ops"}],
        "roles": {"realm": [{"name": "ops-member"}]}
      }'
# → {"added": 3, "skipped": 0, "updated": 0, "results": [...]}
```

Strategy: `FAIL` (default — first conflict aborts with **409** and previously imported resources are **not** rolled back), `SKIP`, or `OVERWRITE`. The body accepts `users`, `groups` (top-level only), `clients`, `roles`, `identityProviders`. Import creates users **without credentials** — set passwords afterwards via `reset-password`.

```bash
curl -s -X POST "$IC/admin/realms/acme/export" -H "Authorization: Bearer $TOKEN" > acme-export.json
```

The export document contains the realm fields plus users, clients, groups, roles, identity providers, and client scopes — with **no secret material** (user credentials absent, client secrets omitted, IdP `clientSecret` masked as `**********`). It is a backup/inspection artifact, not a round-trip import format; for lifecycle backups see [backup and upgrade](/backup-and-upgrade/).

### Read and update the events configuration

```bash
curl -s "$IC/admin/realms/acme/events/config" -H "Authorization: Bearer $TOKEN"
# → {"eventsEnabled": true, "eventsExpiration": 0, "adminEventsEnabled": true,
#    "adminEventsDetailsEnabled": false, "eventsListeners": ["logging"]}

curl -s -X PUT "$IC/admin/realms/acme/events/config" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"eventsExpiration": 7776000, "adminEventsDetailsEnabled": true}'
# → 204

curl -s -X DELETE "$IC/admin/realms/acme/events" -H "Authorization: Bearer $TOKEN"        # wipe login events → 204
curl -s -X DELETE "$IC/admin/realms/acme/admin-events" -H "Authorization: Bearer $TOKEN"  # wipe admin events → 204
```

Both deletes are self-auditing: each records one fresh admin event for the wipe itself (only when admin events are enabled).

### Server info and enum lists

```bash
curl -s "$IC/admin/serverinfo" -H "Authorization: Bearer $TOKEN"
curl -s "$IC/admin/enums/mapper-types" -H "Authorization: Bearer $TOKEN"
```

`/admin/serverinfo` returns every enum list in one document; `/admin/enums/*` exposes them individually (`protocols`, `algorithms`, `authenticators`, `required-actions`, `provider-ids`, `ldap-vendors`, `identity-provider-presets`, `client-installations`, `themes`, `locales`, …). Every enum value carries a `description`. API clients building admin UIs should consume these lists dynamically rather than hardcode values.

### Brute-force lockouts

```bash
curl -s "$IC/admin/realms/acme/attack-detection/brute-force/users" -H "Authorization: Bearer $TOKEN"
# → [{"username": "alice", "ip": "203.0.113.10", "numFailures": 5, "userId": "..."}]

curl -s "$IC/admin/realms/acme/attack-detection/brute-force/users/$UID" -H "Authorization: Bearer $TOKEN"
curl -s -X DELETE "$IC/admin/realms/acme/attack-detection/brute-force/users/$UID" -H "Authorization: Bearer $TOKEN"
```

Lockout state lives in the distributed cache and is keyed per (username, IP); realm brute-force settings are on the realm's Security tab. `userId` is omitted from the response when the username no longer resolves to an existing user. See [security](/security/) for the protection model.

## OpenAPI and Swagger UI

Two OpenAPI surfaces exist:

- **CLI export** — `issuerd openapi -o openapi.json` writes the **full** specification (Admin API plus the account-console, public protocol, and internal SPA endpoints; assembled by `issuerd_server::openapi::full_openapi()`). This is the document to feed code generators and API gateways. The console's own TypeScript SDK is generated from exactly this export.
- **Served documents** — the daemon serves the same full spec at `GET /openapi.json` (unauthenticated) and the Admin-API-only document at `GET /admin/openapi.json` (requires an admin token like every `/admin` route).

A **Swagger UI is served by the daemon** at `/swagger-ui`, backed by the full spec at `/openapi.json`. Its OAuth2 flow is pre-wired for the `admin-cli` public client (scopes `openid profile`, PKCE; the `admin-cli` redirect URIs include `/swagger-ui/oauth2-redirect.html`), so "Authorize" works out of the box on a stock deployment.

## Events management for administrators

Event recording is configured per realm via `GET/PUT /admin/realms/{realm}/events/config` (fields verified in `crates/issuerd-admin-api/src/dto.rs`, gating in `crates/issuerd-admin-api/src/audit.rs`):

| Field | Default | Effect |
|---|---|---|
| `eventsEnabled` | **true** | Record login/user events for the realm |
| `adminEventsEnabled` | **true** | Record admin (audit) events for mutations in the realm |
| `adminEventsDetailsEnabled` | **false** | Also store the request-body representation on admin events |
| `eventsExpiration` | 0 (never) | Retention window in seconds |
| `eventsListeners` | `["logging"]` | Active listener ids; only `logging` is built in (custom ids are accepted for listener SPIs) |

> **Warning:** the wire keys are camelCase, as above. A PUT sent with snake_case keys (`events_expiration`, …) still returns `204` but silently changes nothing — unknown fields are ignored.

What an operator should know:

- **Issuerd defaults differ from Keycloak on purpose**: fresh realms record both event types out of the box (Keycloak defaults both OFF), so a new deployment has an audit trail immediately. Representation capture stays OFF, as in Keycloak — enable `adminEventsDetailsEnabled` only when you need before/after payloads; request bodies in representations are redacted for known secrets (client secrets, user credentials) but can still carry personal data.
- **Admin-event writes degrade safely**: if the realm cannot be loaded at write time (or is already gone), the event is still written — the mutation has already happened and the audit trail must survive — but its representation is stripped, since a realm with unknown preferences has not opted into storing request bodies. Persistence failures are logged but never fail the underlying mutation.
- **Retention is read-path clamping**: with `eventsExpiration > 0`, queries clamp `date_from` to `now - expiration`; expired events are **never physically deleted** by the server. `DELETE /events` and `DELETE /admin-events` are the only removal mechanism (and each wipe records one fresh admin event, itself gated on `adminEventsEnabled`).
- **Attribution**: admin events store the acting realm (`auth_realm_id`, resolved from the token issuer), client (`azp`), and user (`sub`), and resolve usernames at query time.
- Event types and operation/resource types for filters are listed by `GET /admin/enums/event-types`, `/admin/enums/operation-types`, and `/admin/enums/resource-types`.

Query patterns, filters, and operational uses of events are covered in [monitoring](/monitoring/); the security implications of audit data (and what to ship to a SIEM) in [security](/security/). If events stop appearing after config changes, see [troubleshooting](/troubleshooting/).
