---
title: "LDAP Group Mapping and Token Claims"
description: "This document describes, end to end, how group memberships in an LDAP directory (Microsoft Active Directory, Samba AD DC, or OpenLDAP) become Issuerd group memberships, how those drive role…"
---

This document describes, end to end, how group memberships in an LDAP directory (Microsoft Active Directory, Samba AD DC, or OpenLDAP) become Issuerd group memberships, how those drive role resolution, and how the result surfaces in produced tokens as OIDC/Keycloak-shaped claims (`realm_access`, `resource_access`, `groups`). It is written for system operators and client developers.

For the full LDAP-side reference (provider configuration keys, user synchronization, reconciliation rules) see [user-federation.md](/user-federation/) — this page focuses on the mapping pipeline and its effect on token content. For assigning scopes and mappers to clients, see also [client-integration.md](/client-integration/) and [administration.md](/administration/).

## Contents

- [The pipeline at a glance](#the-pipeline-at-a-glance)
- [Stage 1 — Directory memberships to Issuerd groups](#stage-1--directory-memberships-to-issuerd-groups)
- [Vendor specifics (MS AD, Samba, OpenLDAP)](#vendor-specifics-ms-ad-samba-openldap)
- [Stage 2 — Groups to roles (group role mappings)](#stage-2--groups-to-roles-group-role-mappings)
- [Stage 3 — Roles and groups in tokens](#stage-3--roles-and-groups-in-tokens)
- [Worked example](#worked-example)
- [Operational notes](#operational-notes)

## The pipeline at a glance

```
LDAP group (memberOf DN on the user entry)
   │  ① group-ldap-mapper (provider config groupsDn + groupsInclude)
   ▼
Issuerd group (top-level, ldap_sync marker; pre-existing groups adopted)
   │  ② group role mapping (realm roles / client roles assigned to the group)
   ▼
Effective user roles (user + group roles, composites expanded)
   │  ③ client scopes → protocol mappers, evaluated per token target
   ▼
Token claims: realm_access.roles · resource_access.{client}.roles · groups
```

Every stage is optional and independently configurable: sync groups without
role mappings (membership only, usable via the `groups` claim), or map roles
to groups and never expose group names in tokens.

## Stage 1 — Directory memberships to Issuerd groups

When the federation provider config carries a non-empty **`groupsDn`**, the
*group-ldap-mapper* (`GetGroupsFromUserMemberOf` strategy) maps directory
memberships into local group memberships:

1. The mapper reads the user's **`memberOf`** attribute
   (`memberOfLdapAttribute`, default `memberOf`) — a list of group DNs.
2. Only DNs **under `groupsDn`** survive (normalization-aware subtree test).
3. The **first RDN value** of each surviving DN becomes the Issuerd **group
   name** (`CN=developers,OU=Groups,...` → `developers`; RFC 4514 escapes
   reversed).
4. The optional **`groupsInclude`** allowlist (comma-separated CNs,
   case-insensitive) restricts which groups are synced; empty means "all".

Reconciliation (`issuerd_core::roles::reconcile_group_memberships_indexed`) then:

- creates missing groups as **top-level groups carrying the `ldap_sync=true`
  marker attribute**, and **adopts** pre-existing groups by setting the same
  marker when sync first assigns them;
- treats the reported set as **authoritative for marker-carrying
  memberships**: a membership the directory no longer reports is removed;
  manually granted memberships in groups *without* the marker are never
  touched;
- matches group names **case-insensitively** (AD treats CNs
  case-insensitively).

The same reconciliation runs on **first-login import** (unknown user
authenticates via LDAP bind) and on **full synchronization** (the only
strategy LDAP providers implement), so both paths produce identical group
state. Without `groupsDn` the provider reports "no group information"
(`None`) and reconciliation leaves all local memberships untouched —
removing `groupsDn` never wipes memberships.

The full rule set (with the exact marker/adoption semantics) is in
[user-federation.md — Group mapping semantics](/user-federation/#group-mapping-semantics).

## Vendor specifics (MS AD, Samba, OpenLDAP)

The `vendor` key selects attribute presets (`usernameLdapAttribute`,
`rdnLdapAttribute`, `uuidLdapAttribute`); group mapping itself is
vendor-neutral because every supported directory exposes memberships through
a `memberOf`-style user attribute.

| | MS Active Directory | Samba AD DC | OpenLDAP |
|---|---|---|---|
| `vendor` value | `ACTIVE_DIRECTORY` | `ACTIVE_DIRECTORY` or `SAMBA` (identical presets) | `GENERIC` |
| Username attribute | `sAMAccountName` | `sAMAccountName` | `uid` |
| UUID attribute | `objectGUID` | `objectGUID` | `entryUUID` |
| Membership source | `memberOf` (native, always present) | `memberOf` (native, AD-compatible) | `memberOf` **only with the memberOf overlay** |
| Typical `groupsDn` | `OU=Groups,DC=corp,DC=example` | `CN=Users,DC=corp,DC=example` (Samba tools create groups there) | `ou=groups,dc=corp,dc=example` |
| Notes | Paging is always on — keep `batchSize` at or below the directory's page-size limit (AD `MaxPageSize` is 1000) | Behaves like AD for all mapper purposes | See overlay warning below |

**Direct memberships only.** `memberOf` (in all three directories) reports
*direct* group memberships. A user nested into group A which is itself a
member of group B is reported for A only — Issuerd does not expand nested
group hierarchies.

**OpenLDAP warning — the memberOf overlay is mandatory for group sync.**
Stock OpenLDAP has no `memberOf` attribute; it is generated by the `memberof`
overlay (usually paired with `refint`). Two consequences:

- The overlay tracks only the group object class / membership attribute it is
  configured for. The osixia/openldap image, for example, is preconfigured
  for `groupOfUniqueNames` + `uniqueMember` — groups created as
  `groupOfNames` + `member` produce **no** `memberOf` on users. Check your
  overlay configuration (`olcMemberOfGroupOC` / `olcMemberOfMemberAD`) before
  designing the directory layout.
- Semantics are authoritative: if the overlay is missing or misconfigured,
  every user reports an *empty* membership set (`Some([])`), and the next
  sync removes all marker-carrying memberships. Verify with
  `ldapsearch ... -b <user-dn> memberOf` before enabling `groupsDn`.

## Stage 2 — Groups to roles (group role mappings)

Synced groups are ordinary Issuerd groups: they appear in the admin console
(Groups), in the Admin API, and can hold **role mappings**. Assigning a role
to a group makes every member receive it at role-resolution time:

- **Realm roles** — console: Groups → *group* → Role mappings → Assign realm
  role; provision YAML: `realm_roles` on the group; Admin API:
  `POST /admin/realms/{realm}/groups/{id}/role-mappings/realm`.
- **Client roles** — same locations under the client dimension; provision
  YAML: `client_roles`.

Role resolution for tokens uses the **effective user roles**
(`issuerd_core::roles::effective_user_roles`): the user's direct role mappings
plus the mappings of every group the user belongs to, with **composite roles
expanded**. A group role mapping is therefore the standard way to turn
"member of directory group X" into "has role Y in tokens" — the directory
itself never names Issuerd roles.

Because adoption preserves pre-existing groups, the recommended layout is:
provision the group with its role mappings (the group exists with the marker
from the first sync onward), and let sync manage only the *memberships*.

## Stage 3 — Roles and groups in tokens

Token claim content is assembled per issuance from the client's **client
scopes**: each scope's **protocol mappers** are evaluated for the current
token target (access token, ID token, UserInfo response), and
default-assigned scopes always apply. Group-related output comes from three
mapper types:

| Mapper type | Claim produced | Built-in wiring |
|---|---|---|
| User Realm Role (`oidc-usermodel-realm-role-mapper`) | `realm_access: {"roles": [...]}` (Keycloak shape) | `roles` client scope, access-token target |
| User Client Role (`oidc-usermodel-client-role-mapper`) | `resource_access: {"<client_id>": {"roles": [...]}}` | `roles` client scope, access-token target |
| Group Membership (`oidc-group-membership-mapper`) | `groups: [...]` (configurable claim name) | **not wired by default** — add explicitly |

**`realm_access.roles`.** Contains effective *realm* roles (including those
granted via group role mappings), sorted and deduplicated. The built-in
`roles` scope emits it into the **access token** only; `roles` is
default-assigned to every client, so it applies to all flows.

**`resource_access.{client}.roles`.** Same for *client* roles, keyed by the
client's `client_id`. Both claims follow the Keycloak token shape, so
Keycloak-oriented adapters (Spring, ASP.NET role transforms, `keycloak-js`
helpers) work unchanged.

**UserInfo.** The built-in role mappers target the access token only — the
UserInfo response carries no role claims out of the box. To expose roles at
UserInfo (needed by clients that read claims there, e.g. the ASP.NET OIDC
handler with `GetClaimsFromUserInfoEndpoint`), add a User Realm Role mapper
with the **userinfo** target to the client (or to a shared client scope):

```json
{
  "name": "realm roles (userinfo)",
  "protocol": "openid-connect",
  "protocol_mapper": "oidc-usermodel-realm-role-mapper",
  "config": {
    "claim.name": "realm_access",
    "multivalued": "true",
    "access.token.claim": "true",
    "id.token.claim": "false",
    "userinfo.token.claim": "true"
  }
}
```

**The `groups` claim.** Group *names* do not appear in tokens unless you add
a **Group Membership** mapper to a client or client scope. Its configuration:

- `claim.name` — target claim (default `groups`);
- `full.path` — `false` emits bare group names (`"developers"`), `true`
  emits full group paths (`"/developers"`, `"/org/developers"`);
- `access.token.claim` / `id.token.claim` / `userinfo.token.claim` — token
  targets, as usual.

Synced LDAP groups are emitted exactly like local groups — the mapper does
not distinguish them.

**ID tokens from the token endpoint** carry no client-scope overlay (OIDC
Core §5.4 — claims about the user are delivered by UserInfo); UserInfo and
ID tokens issued by the pure-implicit flow do evaluate it. Design clients to
read roles/groups from the **access token** or **UserInfo**, not the ID
token.

**Freshness.** Access tokens are self-contained JWTs validated statelessly —
their claims reflect group and role state **at issuance**. A directory-side
group change reaches tokens only after (a) the next sync (or the user's next
login, for first-login import) updates local state, and (b) the client
obtains a new access token (login or refresh — claims are re-assembled on
every refresh). There is no push channel from the directory into live
tokens.

## Worked example

Requirement: members of the AD group `developers` must pass an ASP.NET
client's `[Authorize(Roles = "developer")]`.

1. **Provider config** (`groupsDn` + allowlist):
   ```yaml
   identity_providers:
     - realm: myrealm
       alias: msad
       provider_id: ldap
       config:
         # ... connection/mapping keys ...
         groupsDn: OU=Groups,DC=corp,DC=example
         groupsInclude: developers
   ```
2. **Group with role mapping** (provision; adopted by sync on first run):
   ```yaml
   groups:
     - realm: myrealm
       name: developers
       realm_roles: [developer]
   ```
3. Sync (or a user's first login) makes AD members of `developers` members of
   the Issuerd group `developers`; the group role mapping resolves the
   realm role `developer` for each of them.
4. The access token (and UserInfo, with the extra mapper above) then carries:
   ```json
   {
     "realm_access": { "roles": ["developer"] },
     "scope": "openid profile email",
     "iss": "https://sso.example.com/realms/myrealm"
   }
   ```
   The client flattens `realm_access.roles` into its role claims and the
   authorization policy passes. Removing the user from the AD group removes
   the role on the next sync + token issuance — the same round trip.

## Operational notes

- **Triggering syncs:** admin console (Identity Providers → *provider* →
  sync action), or
  `POST /admin/realms/{realm}/user-federation/{alias}/sync?strategy=full`
  (LDAP providers implement full sync only; `incremental` answers 501).
  First-login import reconciles groups for that one user even without a sync.
- **Checking state:** console Groups pages show synced groups (look for the
  `ldap_sync` attribute); a user's group memberships are on the user detail
  page; the provider's group-sync config is on Identity Providers → *ldap
  provider* → Mapping (Group Sync section). The provider config records
  `lastSyncTime` after each run.
- **Case sensitivity:** group names reconcile case-insensitively, but token
  claims use the stored group's canonical name.
- **Invalid group names** are skipped during reconciliation and counted in
  the sync summary log line (`LDAP group sync reconciled`).
- **Kerberos providers** do not support group sync — pair Kerberos with an
  LDAP provider against the same directory if you need groups (see
  [user-federation.md](/user-federation/)).
- Symptoms and fixes (groups missing after sync, memberships unexpectedly
  removed, roles absent from tokens) are covered in
  [troubleshooting.md](/troubleshooting/).
