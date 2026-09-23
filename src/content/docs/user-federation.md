---
title: "User federation: LDAP, Kerberos, and Active Directory"
description: "This document covers Issuerd's user federation: connecting a realm to an external user directory (LDAP — OpenLDAP, Samba AD DC, Microsoft Active Directory — or a Kerberos KDC) so that users…"
---

This document covers Issuerd's user federation: connecting a realm to an external user directory (LDAP — OpenLDAP, Samba AD DC, Microsoft Active Directory — or a Kerberos KDC) so that users authenticate against the directory while Issuerd issues the tokens. It describes the federation model, every supported configuration key, user synchronization, group-mapping semantics, SPNEGO/Kerberos login, and day-to-day operation of a federated realm. It is written for system operators and administrators. For declaring federation providers in a seed file, see also [provisioning.md](/provisioning/); for the Admin API access model and admin tokens, see [administration.md](/administration/). (External *identity brokering* to OIDC/social IdPs is a different feature — see [identity-brokering.md](/identity-brokering/).)

## Contents

- [How federation works](#how-federation-works)
- [Supported directories](#supported-directories)
- [Configuring an LDAP provider](#configuring-an-ldap-provider)
- [User synchronization](#user-synchronization)
- [Group mapping semantics](#group-mapping-semantics)
- [Kerberos and SPNEGO](#kerberos-and-spnego)
- [Active Directory specifics](#active-directory-specifics)
- [Operating a federated realm](#operating-a-federated-realm)
- [Test rigs reference](#test-rigs-reference)

## How federation works

A federation provider is a **per-realm identity-provider record** whose `provider_id` is `ldap` or `kerberos`, plus a string→string `config` map holding the connection settings. Records are stored with the realm (same storage as everything else) and loaded on demand by the federation manager (`crates/issuerd-federation/src/manager.rs`): disabled records are skipped, and providers are tried in descending `priority` order (default `0`). Provider configuration is re-read from storage on every use — changes made through the Admin API or console take effect immediately, with no restart and no caching layer in between.

### Federated users and `federation_link`

A *federated user* is a normal local user row whose `federation_link` field holds the id of the provider it came from. Federated users appear in the admin console and Admin API like any other user and can hold local group memberships, role mappings, required actions, and (if you choose) local credentials.

### Password validation via LDAP bind

When a federated user logs in through the browser login form, Issuerd validates the password against the directory, not against a local hash (`crates/issuerd-auth-flow/src/built_in.rs`, `UsernamePasswordAuthenticator`):

1. **Local user exists and has a `federation_link`** — the password is checked with the linked provider. The LDAP provider builds the user DN as `{rdnLdapAttribute}={username},{usersDn}` (the username is RFC 4514-escaped, `crates/issuerd-federation/src/ldap/provider.rs`) and performs a simple bind with the supplied password. A rejected bind fails the login with the same generic "invalid credentials" error as a bad local password (and counts toward brute-force lockout). If the provider **errors** (directory down, misconfiguration) or no provider matches the link, Issuerd falls back to the user's local Argon2 credential, so a local break-glass password keeps working during a directory outage.
2. **No local user exists** — Issuerd looks the username up across the realm's providers in priority order. On the first provider that finds the user *and* accepts the bind, the user is **imported on first login**: a local row is created with the federation link and — when a group mapper is configured — the `memberOf` attribute and reconciled group memberships. Only `memberOf`-derived group information is mapped from the directory; email and name attributes are not (see the warning under [What a full sync does](#what-a-full-sync-does)).

To avoid a timing side-channel that would reveal whether a username exists, the LDAP provider performs a bind attempt even when its search found no such user.

The token endpoint's Resource Owner Password Credentials grant (`grant_type=password`) applies the same rules: a federated user is validated against the linked directory first — an active rejection fails the grant (no local fallback), while a provider **error** or a dead link falls back to the local Argon2 credential, mirroring the browser flow.

### Full synchronization vs. first-login import

You do not have to choose one model:

- **First-login import** (always on) creates local rows lazily, the first time each directory user logs in.
- **Full synchronization** (operator-triggered, see [User synchronization](#user-synchronization)) bulk-imports every user the directory search returns, so users exist locally before their first login — useful for assigning groups/roles ahead of time and for searching users in the console.

Both paths create the same kind of local row and reconcile group memberships the same way.

### Resilience behavior

- Each LDAP provider instance holds a **pool of 5 LDAP connections** (`crates/issuerd-federation/src/ldap/pool.rs`); the pool connects eagerly when the provider is instantiated, so a completely unreachable directory surfaces as a provider-load error rather than a per-request hang.
- During cross-provider lookups a provider that errors is **skipped with a warning** and the next provider is tried (`DynamicFederationManager::find_user`).

## Supported directories

| Directory | `provider_id` | `vendor` | Status |
|---|---|---|---|
| Samba AD DC | `ldap` | `SAMBA` (or `ACTIVE_DIRECTORY`) | Primary test target (`tests/integration/federation_samba.rs`) |
| OpenLDAP (generic RFC 4519 schema) | `ldap` | `GENERIC` | Tested (`tests/integration/federation_ldap.rs`) |
| Microsoft Active Directory | `ldap` | `ACTIVE_DIRECTORY` | Tested against an AD DS lab (`tests/integration/federation_ad.rs`) |
| Kerberos KDC (SPNEGO) | `kerberos` | — | Tested against the Samba DC KDC |

The `vendor` key selects directory-flavor defaults (username/UUID attribute names) and, for `ACTIVE_DIRECTORY`, the password-write encoding (`unicodePwd`). `SAMBA` currently shares the `ACTIVE_DIRECTORY` attribute defaults.

> **Warning:** Kerberos/SPNEGO is **Unix-only**. The SPNEGO acceptor is gated on `cfg(unix)` (`crates/issuerd-federation/src/kerberos/provider.rs`); on a Windows build the Kerberos provider returns `NotSupported` for SPNEGO. LDAP federation works on all platforms.

## Configuring an LDAP provider

Three equivalent surfaces write the same per-realm identity-provider record:

- **Admin console** — `/admin/console` → *Identity Providers* → add a provider with type *LDAP*. The form (connection + mapping sections) is driven by the server's enum endpoints, and the vendor selector swaps in the matching attribute presets.
- **Admin API** — `POST /admin/realms/{realm}/identity-provider/instances` (requires `manage-realm`).
- **Provision file** — the `identity_providers:` list (see below and `examples/provision.federation.yaml`).

### Configuration key reference

All keys live in the provider's `config` map and are **strings** (quote numbers and booleans: `"true"`, `"5000"`). Spellings follow Keycloak's camelCase convention; the parser is `LdapConfig::from_hashmap` (`crates/issuerd-federation/src/ldap/config.rs`) — except `priority`, which `DynamicFederationManager` reads directly from the same config map.

| Key | Required | Default | Meaning |
|---|---|---|---|
| `connectionUrl` | yes | — | `ldap://host:389` or `ldaps://host:636`. |
| `bindDn` | | `""` | Service-account DN used for searches. Passed verbatim to the LDAP simple bind. |
| `bindCredential` | | `""` | Service-account password. Stored as part of the provider configuration — protect storage and the Admin API accordingly. |
| `usersDn` | | `""` | Search base for all user lookups and syncs. |
| `baseDn` | | `""` | Parsed for Keycloak parity; not currently used — searches are rooted at `usersDn`. |
| `usernameLdapAttribute` | | `sAMAccountName` (AD/Samba), `uid` (GENERIC) | Attribute matched against the login username. |
| `rdnLdapAttribute` | | same as `usernameLdapAttribute` | Attribute used to build the user DN for bind/password operations. |
| `uuidLdapAttribute` | | `objectGUID` (AD/Samba), `entryUUID` (GENERIC) | Directory's stable entry identifier. |
| `userObjectClasses` | | `inetOrgPerson,organizationalPerson` | Comma-separated object classes; all are ANDed into user search filters — except the username lookup filter drops them when `customUserSearchFilter` is set. |
| `customUserSearchFilter` | | — | Extra RFC 4515 filter ANDed into single-user lookups (e.g. `(employeeType=internal)`). |
| `searchScope` | | `SUBTREE` | `SUBTREE`, `ONELEVEL`, or `BASE`. |
| `useStartTls` | | `"false"` | `"true"` issues StartTLS after connecting (for plain `ldap://` URLs). |
| `noTlsVerify` | | `"false"` | `"true"` disables TLS certificate verification on `ldaps://`/StartTLS connections. **Insecure — dev/lab only** (self-signed directory certs). |
| `pagination` | | `"false"` | Parsed for parity. Note: username lookups and syncs **always** use RFC 2696 paged results with `batchSize` as the page size, regardless of this flag. |
| `batchSize` | | `1000` | Page size for paged searches. Keep it at or below the server's limit (AD's `MaxPageSize` defaults to 1000). |
| `maxConditions` | | `1000` | Parsed for Keycloak parity; not currently used. |
| `vendor` | | `GENERIC` | `GENERIC`, `ACTIVE_DIRECTORY`, or `SAMBA` — see [Supported directories](#supported-directories). |
| `editMode` | | `READONLY` | `READONLY`, `WRITABLE`, or `UNSYNCED`. Currently gates directory password writes at the provider level (`READONLY` rejects them); see [Operating a federated realm](#operating-a-federated-realm). |
| `priority` | | `0` | Integer; providers are consulted highest-priority first during user lookup. |

**Group-mapping keys** (enable the `group-ldap-mapper`; parsed by `GroupMapper::from_config` in `crates/issuerd-federation/src/mapper/group.rs` — see [Group mapping semantics](#group-mapping-semantics)):

| Key | Required | Default | Meaning |
|---|---|---|---|
| `groupsDn` | to enable | — | Base DN of the groups subtree. The mapper is active only when this key is present and non-empty. |
| `groupNameLdapAttribute` | | `cn` | Group name attribute. With the implemented `memberOf` strategy the group name is always the first RDN value of the `memberOf` DN; this key only matters for the not-yet-implemented `LoadGroupsByMemberAttribute` strategy. |
| `memberOfLdapAttribute` | | `memberOf` | User attribute holding membership DNs. The provider explicitly requests it in searches (some directories do not return operational attributes for `"*"`). |
| `groupsInclude` | | — | Comma-separated allowlist of group names (CNs), matched case-insensitively. Absent/empty means "every group under `groupsDn`". |

### Admin API example

```bash
# TOKEN: an admin access token — see administration.md, "Getting an admin token"
curl -s -X POST "http://localhost:8080/admin/realms/acme/identity-provider/instances" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "alias": "corp-ldap",
        "provider_id": "ldap",
        "enabled": true,
        "config": {
          "connectionUrl": "ldaps://dc1.corp.example:636",
          "bindDn": "CN=issuerd-bind,OU=Service Accounts,DC=corp,DC=example",
          "bindCredential": "s3cret",
          "usersDn": "OU=People,DC=corp,DC=example",
          "usernameLdapAttribute": "sAMAccountName",
          "rdnLdapAttribute": "cn",
          "uuidLdapAttribute": "objectGUID",
          "userObjectClasses": "person,organizationalPerson,user",
          "vendor": "ACTIVE_DIRECTORY",
          "searchScope": "SUBTREE",
          "editMode": "READONLY",
          "batchSize": "1000",
          "priority": "1",
          "groupsDn": "OU=Groups,DC=corp,DC=example",
          "groupsInclude": "developers,ops"
        }
      }'
```

The record can then be read/updated/replaced via `GET|PUT /admin/realms/{realm}/identity-provider/instances/{alias}` and removed with `DELETE` on the same path.

### Provision YAML example

Provisioned identity providers are created **only if the alias does not exist yet** (the provisioner never updates existing records — see [provisioning.md](/provisioning/)). A complete multi-directory lab ships as `examples/provision.federation.yaml`:

```yaml
identity_providers:
  - realm: samba
    alias: samba-ldap
    provider_id: ldap
    enabled: true
    config:
      connectionUrl: ldap://localhost:389
      bindDn: CN=Administrator,CN=Users,DC=test,DC=issuerd,DC=local
      bindCredential: AdminPass123!
      usersDn: CN=Users,DC=test,DC=issuerd,DC=local
      usernameLdapAttribute: sAMAccountName
      rdnLdapAttribute: cn
      uuidLdapAttribute: objectGUID
      userObjectClasses: person,organizationalPerson,user
      vendor: ACTIVE_DIRECTORY
      searchScope: SUBTREE
      editMode: WRITABLE
      batchSize: "5000"
      priority: "1"
```

## User synchronization

### Triggering a sync

- **Admin console** — *Identity Providers* → *{alias}* → **Sync Users** button; the result (`added` / `updated` / `removed` / `failed`) is shown when the run finishes.
- **Admin API** — `POST /admin/realms/{realm}/user-federation/{provider_id}/sync`, where `{provider_id}` is the provider's **id or alias**. Requires `manage-realm` or `manage-users`.

```bash
curl -s -X POST \
  "http://localhost:8080/admin/realms/acme/user-federation/corp-ldap/sync" \
  -H "Authorization: Bearer $TOKEN"
# {"added":1180,"updated":12,"removed":0,"failed":0,"last_sync":"2026-09-12T09:41:03Z"}
```

`?strategy=full` (the default) runs a full sync. `?strategy=incremental` resumes from the `lastSyncTime` watermark persisted into the provider config after every successful sync — but the LDAP provider does not implement incremental sync, so it returns `501 Not Implemented`; use full syncs. Every sync run records an admin event (`UserFederation` resource).

### What a full sync does

Implemented by `UserSynchronizer` (`crates/issuerd-federation/src/sync.rs`):

1. **Streams all directory users** with a paged search over `usersDn`, matching the `userObjectClasses` filter (page size = `batchSize`).
2. **Pre-fetches all local users** of the realm (pages of 1000) to avoid per-user lookups.
3. **Inserts new users in batches of 1000** (`Storage::bulk_create_users`; on PostgreSQL this is a single `INSERT ... SELECT * FROM UNNEST(...)` per batch). If a batch fails, the synchronizer falls back to per-user inserts for that batch and counts individual failures.
4. **Updates existing users** whose stored `federation_link` matches the reporting provider: email, email-verified flag, first/last name, enabled flag, and attributes are overwritten from the directory record. An unparsable email value is dropped (stored as no email) rather than failing the user.
5. **Reconciles group memberships** for every added/updated user (see the next section) and logs a summary line (`LDAP group sync reconciled`) with per-run counters.

> **Warning:** No LDAP *attribute* mappers are wired in production — `build_default_mappers` installs only the group mapper (`crates/issuerd-federation/src/manager.rs`), so directory email/first/last-name attributes never reach the `FederatedUser` record. Because step 4 overwrites those fields on every run, **each sync clears an email address or name an administrator set locally on a federated user** (the provider reports them as empty); first-login imports likewise start with these fields empty.

Conflict handling: a directory user whose username matches a **local, non-federated** user (or one linked to a *different* provider) is **not** touched — the run counts it in `failed` and logs a warning. `removed` is always `0`: **synchronization never deletes local users**, even when they disappear from the directory.

### What a synced user looks like

- `federation_link` set to the provider id; **no local password credential** (authentication happens via LDAP bind).
- Username from `usernameLdapAttribute`; enabled (note: directory account-state attributes such as AD's `userAccountControl` are **not** mapped to the enabled flag — see [Active Directory specifics](#active-directory-specifics)).
- A `memberOf` user attribute containing the mapped membership names when a group mapper is configured.

## Group mapping semantics

Group sync activates when the provider config carries a non-empty `groupsDn`. The mapper (`crates/issuerd-federation/src/mapper/group.rs`) implements Keycloak's *group-ldap-mapper* with the `GetGroupsFromUserMemberOf` strategy:

1. Read the user's `memberOf` attribute (`memberOfLdapAttribute`).
2. Keep only DNs **under `groupsDn`**. The suffix test is normalization-aware: case-insensitive, insensitive to cosmetic spacing around commas, and anchored on whole RDN components — `OU=Groups2` does not match base `OU=Groups`.
3. Take the **first RDN value** of each surviving DN as the group name (`CN=Smith\, John,OU=Groups,...` → `Smith, John`), reversing RFC 4514 escaping; escaped commas in group names are handled correctly.
4. Apply the optional `groupsInclude` allowlist (case-insensitive).

Reconciliation into local groups (`issuerd_core::roles::reconcile_group_memberships_indexed`) then applies these rules:

- **`Some` vs `None` is authoritative vs untouched.** When a group mapper is wired, `FederatedUser.groups` is `Some(list)` — authoritative: a user reported with an empty list is *member of nothing*, and stale memberships are removed. When no group mapper is wired (no `groupsDn`), groups are `None` — "provider does not report groups" — and reconciliation leaves every local membership untouched. Removing `groupsDn` from a provider therefore never wipes memberships.
- **The `ldap_sync` marker.** Groups created by sync are top-level groups carrying the attribute `ldap_sync=true`. A pre-existing group (e.g. provisioned) that sync assigns to a user is **adopted**: the marker is set on it so future runs manage its membership.
- **Only marker-carrying memberships are ever removed.** A group membership an administrator granted manually (group without the marker) survives every sync; directory-side group removal propagates by deleting memberships in marked groups that are no longer reported.
- **Group role mappings are never touched** — sync manages membership only.
- Group names match **case-insensitively** (directories like AD treat CNs case-insensitively); a per-sync-run shared index avoids per-user lookups for the same groups, and a find-or-create race with a concurrent reconcile falls back to the existing row. Names that are not valid Issuerd group names are skipped and counted.

The same reconciliation runs for **first-login imports** and for **full syncs**, so both paths produce identical group state.

## Kerberos and SPNEGO

A `provider_id: kerberos` record turns on desktop single sign-on: browsers that already hold a Kerberos ticket log in without seeing the login form.

### Configuration keys

Parsed by `KerberosConfig::from_hashmap` (`crates/issuerd-federation/src/kerberos/config.rs`) — except `priority`, which `DynamicFederationManager` reads directly from the same config map:

| Key | Required | Default | Meaning |
|---|---|---|---|
| `kerberosRealm` | yes | — | Kerberos realm, e.g. `TEST.ISSUERD.LOCAL`. |
| `serverPrincipal` | | `""` | Accept-side service principal, e.g. `HTTP/issuerd.corp.example@CORP.EXAMPLE`. |
| `keyTab` | | `""` | Path to the keytab file, readable by the issuerd process. |
| `allowKerberosAuthentication` | | `"true"` | Master switch for SPNEGO. When `"true"`, the keytab must exist — otherwise provider loading **fails for the whole realm** (every federation lookup errors). |
| `allowPasswordAuthentication` | | `"false"` | Parsed for Keycloak parity. Kerberos password validation is not implemented — it returns `NotSupported` even when enabled. |
| `updateProfileFirstLogin` | | `"true"` | Parsed for Keycloak parity; reserved. |
| `debug` | | `"false"` | Parsed for Keycloak parity; reserved. |
| `priority` | | `0` | Provider ordering, as with LDAP. |

Provision example (from `examples/provision.federation.yaml`):

```yaml
identity_providers:
  - realm: kerberos
    alias: samba-kerberos
    provider_id: kerberos
    enabled: true
    config:
      kerberosRealm: TEST.ISSUERD.LOCAL
      serverPrincipal: HTTP/issuerd.test.issuerd.local@TEST.ISSUERD.LOCAL
      keyTab: tests/fixtures/samba-dc/shared/issuerd.keytab
      allowKerberosAuthentication: "true"
```

### Prerequisites

- **Unix build** — see the warning in [Supported directories](#supported-directories).
- **SPN + keytab** — register the service principal `HTTP/<host>` in the KDC, where `<host>` is the hostname users type into the browser, and export its keytab to the configured path. The Samba fixture shows the mechanics (`tests/fixtures/samba-dc/entrypoint.sh`): `samba-tool spn add HTTP/issuerd.test.issuerd.local issuerd-spn` plus `samba-tool domain exportkeytab ... --principal=HTTP/...`.
- **KDC reachability and working client-side Kerberos config** on the Issuerd host (the acceptor uses the system GSSAPI/`krb5.conf`), plus **synchronized clocks** (Kerberos tolerates only small skew) and **DNS** that resolves the KDC and the service hostname consistently.
- Browsers on client machines must be configured to negotiate (Kerberos ticket present; the Issuerd origin in the browser's negotiate/ trusted-zone list).

### The SPNEGO endpoint

`GET /realms/{realm}/kerberos` (`crates/issuerd-server/src/routes/kerberos.rs`) implements the Keycloak-style negotiation:

- No `Authorization: Negotiate <token>` header → `401` with `WWW-Authenticate: Negotiate` (the browser answers with its ticket).
- Multi-round exchanges return `401` + `WWW-Authenticate: Negotiate <response-token>` until complete.
- On success Issuerd finds or creates the local user (federation link + `KERBEROS_PRINCIPAL` attribute; **disabled users are rejected**), creates an SSO session (auth method `spnego`), and redirects `302` to the client's `redirect_uri` with an authorization `code`.

Because this endpoint grants codes without user interaction, it validates the request like the authorization endpoint: `client_id` must exist and be enabled, `redirect_uri` must match the client's registered URIs, every requested `scope` must be in the client's default/optional scopes, public clients must send a PKCE `code_challenge`, and an explicit `response_mode` (`form_post`, JARM) is honored. Successful logins emit a login event with `method=spnego`.

SPNEGO is also wired into the **built-in browser flow** as an `ALTERNATIVE` stage (`auth-spnego`, right after the cookie stage, `crates/issuerd-core/src/flows.rs`): the authorization handler forwards the browser's `Authorization` header into the flow, so a negotiate-capable browser is signed in transparently while everyone else falls through to the username/password form.

The Kerberos provider does not support user synchronization (`stream_users` → `NotSupported`) — pair it with an LDAP provider against the same directory if you need searchable local users and group sync.

## Active Directory specifics

- Use `vendor: ACTIVE_DIRECTORY` (defaults: `sAMAccountName` / `objectGUID`). The `bindDn` is passed verbatim to the simple bind — use the full DN (e.g. `CN=issuerd-bind,OU=Service Accounts,DC=corp,DC=example`).
- **Password writes require a secure channel.** For the AD vendor the provider writes passwords by replacing `unicodePwd` with the UTF-16LE, quote-wrapped encoding AD expects (`crates/issuerd-federation/src/ldap/provider.rs`); AD only accepts that attribute over LDAPS (or StartTLS) — point `connectionUrl` at `ldaps://<dc>:636` (this is exactly what the Samba integration test does for its password-write case). The generic vendor writes the plaintext `userPassword` attribute instead. For lab directories with self-signed certificates, `noTlsVerify: "true"` disables TLS certificate verification on `ldaps://`/StartTLS connections — **insecure, dev/lab only**.
- **Samba accepts the previous password for a grace period.** Samba AD DC honors the *current and previous* password after a change (verified against the container; Windows AD does this only for computer accounts, OpenLDAP never). Right after a federated password change against Samba, the old password can still authenticate for a while.
- **Account state is not mapped.** A `userAccountControl`/`pwdLastSet` mapper exists in the codebase (`crates/issuerd-federation/src/mapper/msad_account_control.rs`) but is not wired into the runtime mapper chain — sync always imports users as enabled, and AD's "user must change password at next logon" is not surfaced. Disabling an account in AD still blocks federated **password logins**, because AD itself refuses the LDAP bind; to lock a user out of everything (including existing sessions and SPNEGO), disable the local Issuerd user as well.

## Operating a federated realm

### Disabling users

- **Locally** (console/Admin API `enabled: false`): blocks every login path immediately — the browser flow rejects disabled users before any federation check, and the SPNEGO endpoint refuses to issue sessions for them.
- **In the directory**: blocks password logins (the bind fails) but does not, by itself, disable the local row or existing sessions. Prefer disabling in both places for offboarding.

### Password changes

With `editMode: WRITABLE` (or `UNSYNCED`), password changes are **propagated to the directory** (`write_through_federated_password`, `crates/issuerd-auth-flow/src/built_in.rs`). Every password-set path shares the write-through:

- the account console change-password API (verifies the current password against the directory first),
- the `UPDATE_PASSWORD` required action,
- the reset-credentials (forgot-password) email flow,
- the admin `users/{id}/reset-password` endpoint (a `temporary` reset writes the temporary password to the directory and still forces the UPDATE_PASSWORD rotation at next login).

Rules: the write-through only fires when the user's `federation_link` matches a live provider; the directory write replaces the local credential write entirely, and any stale local password credentials are **deleted** on success (login only consults local credentials when the provider errors — a leftover local password would otherwise act as a dormant fallback during directory outages). With `editMode: READONLY` the write fails with a 400-level "the external directory for this user does not accept password changes" error — keep `READONLY` and manage passwords in the directory if you do not want users changing them through Issuerd. Non-federated users and links pointing at removed providers keep the pure local-credential behavior. Remember the AD caveat above: `unicodePwd` writes need `ldaps://` (or StartTLS).

### Monitoring sync results

- The sync response/admin console dialog reports `added` / `updated` / `removed` / `failed` per run; anything in `failed` has a corresponding warning in the server log (username conflicts, per-user insert/update errors).
- Each run persists a `lastSyncTime` watermark into the provider config and writes an admin event.
- Group reconciliation logs a structured summary (`LDAP group sync reconciled`) with memberships added/removed, groups created/adopted, and names skipped.
- For log/metrics plumbing in general, see [monitoring.md](/monitoring/).

### Common pitfalls

- **Bind DN format differs per directory** — AD/Samba accept the full DN form (`CN=...,CN=Users,DC=...`); OpenLDAP typically uses `cn=admin,dc=...`. The value is used verbatim; test it with `ldapsearch -D` before saving.
- **Referrals are not chased** (`crates/issuerd-federation/src/ldap/connection.rs`) — point `usersDn` directly at the partition that holds the users instead of relying on referral following.
- **Paging is always on** for username lookups and syncs (page size `batchSize`); the directory must allow the paged-results control and the size must not exceed the server limit (AD `MaxPageSize` = 1000 by default).
- **A down directory at login time** fails provider loading for the realm; local (non-federated) users can still log in, and federated users fall back to local credentials if they have any.
- **A missing keytab file breaks the whole realm's federation loading** when `allowKerberosAuthentication` is `"true"` — remove or disable the provider instead of leaving a stale path.
- **Clock skew and DNS** are the classic Kerberos failure modes: keep the Issuerd host, KDC, and clients within skew tolerance, and make sure the SPN's hostname matches the URL users actually browse to.
- For diagnosis steps, see [troubleshooting.md](/troubleshooting/).

## Test rigs reference

The contributor integration stack (`docker-compose.integration.yml`) doubles as a local federation lab. It is dev/test infrastructure, not a production topology.

```bash
docker compose -f docker-compose.integration.yml up -d samba-dc openldap
```

| Rig | Endpoint | Bind / credentials | Seeded data |
|---|---|---|---|
| `samba-dc` | LDAP `localhost:389`, LDAPS `localhost:636`, KDC `localhost:88` (tcp+udp) | `CN=Administrator,CN=Users,DC=test,DC=issuerd,DC=local` / `AdminPass123!` | Realm `TEST.ISSUERD.LOCAL`; users `testuser` / `Password123!`, `testuser2` / `Password123!`; group `developers` (with `testuser`); SPN `HTTP/issuerd.test.issuerd.local` with keytab exported to `tests/fixtures/samba-dc/shared/issuerd.keytab` |
| `openldap` | LDAP `localhost:1389` | `cn=admin,dc=test,dc=issuerd,dc=local` / `admin` | Base `dc=test,dc=issuerd,dc=local` (add users via `ldapadd`) |

`examples/provision.federation.yaml` wires ready-made realms (`samba`, `openldap`, `kerberos`, plus an `ad` placeholder realm) against these services — point your server config's `provision` key at it for a one-command lab. The Samba container's healthcheck doubles as a connectivity smoke test (`ldapsearch` against `(sAMAccountName=testuser)`), and `tests/integration/federation_samba.rs` is a known-good reference for the exact attribute layout.
