---
title: "MCP server"
description: "Issuerd exposes a realm-scoped Model Context Protocol (MCP) server for external agent-native administration. The current surface has 71 curated tools across read-only administration, reversible…"
---

Issuerd exposes a realm-scoped Model Context Protocol (MCP) server for external
agent-native administration. The current surface has 71 curated tools across
read-only administration, reversible admin writes, account self-service, and
strict operation-bound actions, plus three read-only resources. There is no
built-in chat, no LLM provider, and no token passthrough to another API.

## Enable and configure

The surface is disabled by default. Enable it only after provisioning an agent
client and reviewing the DPoP profile on every cluster node:

```toml
[mcp]
enabled = true
require_dpop = true
invocation_rate_limit_per_minute = 60
allowed_origins = []

[mcp.step_up]
enabled = false
```

- `enabled` mounts `POST /realms/{realm}/mcp` and the protected-resource
  metadata routes. A disabled endpoint returns the same 404 as an unknown one.
- `require_dpop=true` is the secure default. `false` is an explicit Bearer
  compatibility choice for clients such as `rmcp` or MCP Inspector; it is not
  an automatic fallback and never relaxes strict operation-bound approval.
- `invocation_rate_limit_per_minute` is a distributed fixed-window limit per
  realm, authorizing client (`azp`), and internal user. Zero rejects every
  invocation rather than disabling the limit. Excess returns 429 with
  `Retry-After`; limiter storage failure returns 503.
- `allowed_origins` contains exact HTTP(S) origins. Empty rejects every present
  `Origin` but permits non-browser requests without that header. Default ports
  are normalized; credentials, paths, queries, fragments, wildcards, and
  `Origin: null` are rejected.
- `[mcp.step_up]` is a separate rollout gate for strict operations. Keep it
  false until every node and approval route supports exact-operation CIBA. It
  does not enable generic CIBA resource issuance or a scope-only approval flow.

Host validation uses the configured `issuer_url` authority. An omitted Host
port is interpreted using the issuer's scheme and must match the configured
port; omitted non-default ports are rejected. Default-port authorities and
valid case-insensitive `Content-Type` or repeated `Accept` representations are
canonicalized before `rmcp` dispatch. Host, Origin, and media checks run before
request-body and OAuth processing, so late SDK rejection cannot consume a proof
or invocation allowance.

## Tools and authorization

| Tool | Required scope | Accepted realm roles (any one) | Result |
|---|---|---|---|
| `realm_get` | `mcp:read` | `view-realm`, `manage-realm` | Curated realm configuration |
| `users_search` | `mcp:read` | `view-users`, `manage-users` | Exact username, exact email, or substring search |
| `users_get` | `mcp:read` | `view-users`, `manage-users` | User by canonical internal UUID, direct realm roles and groups |
| `users_get_groups` | `mcp:read` | `view-users`, `manage-users` | Curated direct group memberships |
| `users_get_role_mappings` | `mcp:read` | `view-users`, `manage-users` | Direct, available, and effective realm/client role mappings |
| `users_get_sessions` | `mcp:read` | `view-users`, `manage-users` | Active sessions with curated Admin fields |
| `users_get_credentials` | `mcp:read` | `view-users`, `manage-users` | Scalar credential metadata without payloads |
| `attack_detection_status` | `mcp:read` | `manage-users` | Aggregated login failures and lockout state |
| `clients_list` | `mcp:read` | `view-clients`, `manage-clients` | Paginated clients or exact public `clientId` |
| `clients_get` | `mcp:read` | `view-clients`, `manage-clients` | Client by internal UUID, without secret configuration |
| `groups_list` | `mcp:read` | `view-realm`, `manage-realm` | Paginated group IDs, names, paths, and parent IDs |
| `groups_get` | `mcp:read` | `view-realm`, `manage-realm` | Group by canonical internal UUID, without attributes |
| `groups_members` | `mcp:read` | `view-users`, `manage-users` | Paginated curated members of an existing group |
| `roles_list` | `mcp:read` | `view-realm`, `manage-realm` | Paginated realm roles, excluding client roles before pagination |
| `roles_get` | `mcp:read` | `view-realm`, `manage-realm` | Role by name with Admin lookup precedence and container metadata |
| `serverinfo_get` | `mcp:read` | `view-realm`, `manage-realm` | Dynamic server capabilities and enum metadata |
| `events_search` | `mcp:read` | `view-realm`, `manage-realm` | Filtered user/admin events with retention clamps and totals |
| `sessions_list` | `mcp:read` | `view-realm`, `manage-realm` | Paginated realm sessions and total count |
| `keys_list` | `mcp:read` | `view-realm`, `manage-realm` | Public signing-key metadata only |
| `client_scopes_list` | `mcp:read` | `view-clients`, `manage-clients` | Scopes with safe mapper and claim-target summaries |
| `idp_list` | `mcp:read` | `view-realm`, `manage-realm` | Identity providers with sensitive configuration omitted |
| `idp_get` | `mcp:read` | `view-realm`, `manage-realm` | Identity provider by alias with sensitive configuration omitted |
| `flows_list` | `mcp:read` | `view-realm`, `manage-realm` | Flows and stages without authenticator configuration |
| `users_create` | `mcp:write` | `manage-users` | Create a user with profile and registered required actions, without credentials |
| `users_update` | `mcp:write` | `manage-users` | Profile, registered required actions, and safe attributes; enabled state is separate |
| `users_set_enabled` | `mcp:write` | `manage-users` | Enable or disable a user |
| `users_clear_lockout` | `mcp:write` | `manage-users` | Clear brute-force failures and lockouts across all source IPs |
| `users_send_actions_email` | `mcp:write` | `manage-users` | Send the existing required-action email |
| `users_request_password_reset` | `mcp:write` | `manage-users` | Send only the signed `UPDATE_PASSWORD` action link; no password input/output |
| `users_update_credential_label` | `mcp:write` | `manage-users` | Rename a credential without exposing material; empty `userLabel` clears the label |
| `users_revoke_sessions` | `mcp:write` | `manage-users` **and** `manage-realm` | Revoke one or all user sessions |
| `users_add_to_group` / `users_remove_from_group` | `mcp:write` | `manage-users` | Reversible group membership changes |
| `users_assign_role` / `users_unassign_role` | `mcp:write` | `manage-users` | Realm/client role mappings |
| `groups_assign_role` / `groups_unassign_role` | `mcp:write` | `manage-realm` | Group role mappings |
| `groups_create` | `mcp:write` | `manage-realm` | Create a top-level group |
| `groups_update` | `mcp:write` | `manage-realm` | Rename or update safe group attributes |
| `groups_add_child` | `mcp:write` | `manage-realm` | Create a child group |
| `roles_create` | `mcp:write` | `manage-realm` | Create a realm role |
| `roles_update` | `mcp:write` | `manage-realm` | Rename/update a realm role |
| `clients_create` | `mcp:write` | `manage-clients` | Safe client creation; never Admin API access |
| `clients_update_profile` | `mcp:write` | `manage-clients` | Display name and description only |
| `clients_set_default_scopes` | `mcp:write` | `manage-clients` | Replace default/optional scopes; never default `mcp:*` |
| `me_get_profile` | `openid` | self only | Own profile and direct realm roles |
| `me_update_profile` | `openid` | self only | Own profile with Account email-verification semantics |
| `me_sessions_list` | `openid` | self only | Own active sessions |
| `me_sessions_logout` | `openid` | self only | Log out one owned session |
| `me_consents_list` | `openid` | self only | Own client consents |
| `me_consents_revoke` | `openid` | self only | Revoke an owned consent |
| `me_linked_accounts_list` | `openid` | self only | Own linked external identities |
| `me_linked_accounts_unlink` | `openid` | self only | Unlink with last-sign-in-method protection |
| `me_totp_enroll` | `openid` | self only | Same-origin TOTP enrollment link only |
| `me_webauthn_register` | `openid` | self only | Same-origin WebAuthn registration link only |
| `users_delete` | `mcp:write` + fresh approval | `manage-users` | Delete one exact user and expected state |
| `users_remove_second_factor` | `mcp:write` + fresh approval | `manage-users` | Remove one exact TOTP/HOTP/second-factor WebAuthn credential with unchanged-set preconditions |
| `groups_delete` | `mcp:write` + fresh approval | `manage-realm` | Delete one exact group and expected state |
| `roles_delete` | `mcp:write` + fresh approval | `manage-realm` | Delete one exact realm role and expected state |
| `clients_delete` | `mcp:write` + fresh approval | `manage-clients` | Delete one exact client and expected state |
| `clients_update_security` | `mcp:write` + fresh approval | `manage-clients` | Change exact client security settings without secrets |
| `realm_update_settings` | `mcp:write` + fresh approval | `manage-realm` | Change exact realm settings and expected state |
| `events_config_update` | `mcp:write` + fresh approval | `manage-realm` | Change event settings; administrative audit cannot be disabled |
| `idp_create` | `mcp:write` + fresh approval | `manage-realm` | Create a disabled IdP without secret-bearing configuration |
| `idp_update` | `mcp:write` + fresh approval | `manage-realm` | Update an IdP without replacing omitted secrets |
| `idp_delete` | `mcp:write` + fresh approval | `manage-realm` | Delete one exact IdP and expected state |
| `flows_update_executions` | `mcp:write` + fresh approval | `manage-realm` | Update custom-flow execution requirements |
| `push_not_before` | `mcp:write` + fresh approval | `manage-realm` | Push exact realm revocation time |
| `realm_delete` | `mcp:write` + fresh approval | `manage-realm` | Delete the current realm after exact name confirmation |
| `me_totp_delete` | `openid` + fresh approval | self only | Delete own TOTP enrollment with exact expected credentials |
| `me_webauthn_delete` | `openid` + fresh approval | self only | Delete one owned WebAuthn credential |

### Operational user administration

Typical support workflows compose a small set of tools rather than exposing the
whole Admin API:

- **Onboard a user:** `users_create`, then `users_request_password_reset` or
  `users_send_actions_email`. Create/update accepts only registered required
  action IDs, rejects duplicates, and never accepts password or credential
  payloads. Group and role changes remain separate, explicitly authorized calls.
- **"I cannot log in":** inspect `users_get` and `attack_detection_status`;
  re-enable with `users_set_enabled`, clear brute-force state with
  `users_clear_lockout`, and revoke compromised sessions with
  `users_revoke_sessions`. Clearing lockout does not enable a disabled user or
  reset a forgotten password.
- **"I lost my phone / security key":** inspect `users_get_credentials`, then
  remove exactly the affected second factor with `users_remove_second_factor`.
  This is a strict operation with fresh approval and unchanged user, realm, and
  credential-set preconditions. Password, WebAuthn Passwordless, and unknown
  credentials are rejected as removal targets. A supported primary sign-in
  method must remain: an active password, configured LDAP/Kerberos federation,
  an enabled broker link, or a bound email-code browser flow with an email address. Existing
  non-UUID credential IDs are accepted where the backend permits them. The tool
  never returns secret material. Use
  `users_update_credential_label` only for device naming, not as a security
  reset.
- **Offboard:** disable the user, revoke every session, then use `users_delete`
  only when deletion is actually required and separately approved.

User/group role assignment and unassignment remain ordinary T2 writes for
non-administrative roles. They become strict operations whenever the target
role's composite closure contains a view/manage administrative role,
`realm-admin`, or `impersonation`. `roles_update` follows the same rule when
its composites change or when it renames a role to or from an administrative
name; other name/description-only updates stay T2. Adding or
removing a user from a group with an administrative effective closure is also
strict. With `[mcp.step_up].enabled=false`, these privileged operations are
rejected while their non-administrative counterparts remain available.

Assign `mcp:read` explicitly as an **optional** client scope. It is not implied
by `mcp:write` or `mcp:step_up`, and it is not accepted as a default scope or
through anonymous dynamic registration. MCP does not require the Admin API's
`admin_api_access` client attribute, but the user's corresponding realm roles
are still mandatory.

Reversible T2 writes require `mcp:write` explicitly as an optional client scope
and the listed manage roles. `mcp:write` does not imply `mcp:read`. Their
annotations drive external-client confirmation UX; they are not a server-side
approval substitute. Each call invokes the existing Admin application handler,
so validation, audit events, required-action email, logout notification, and
cache invalidation match the Admin API. Secret-bearing attributes are rejected,
and client creation can never set `admin_api_access`. Password-reset lifespans
are positive and capped at 365 days. Generic action-email keeps all previously
valid lifespans; both paths reject timestamp/cache-duration overflow before
token creation or any SMTP side effect.

`tools/list` is filtered by the caller's actual scope and roles; every
`tools/call` repeats the same checks. Unknown and under-authorized well-formed
calls also consume invocation allowance. A no-`id` `tools/call` notification is
rejected as malformed before authentication and consumes no allowance. Exact
filters take precedence over pagination. Defaults are `first=0`, `max=20`, with
`max <= 100` and bounded input strings. Malformed user, client, or group UUID
input is an input error, not a storage failure. Role names are required and
bounded. Unknown groups and users are not found rather than empty detail pages.
Every user-detail read validates and canonicalizes its internal user UUID and
requires an existing user. Session reads retain the Admin API's bounded
100-record page. Role mappings separate direct assignments from available and
effective roles; effective roles include group inheritance and composite
expansion. `groups_list` retains storage name ordering across pages. Member
pagination is validated before group lookup, and `roles_list` uses bounded
on-demand storage batches rather than unconditionally loading the complete role
catalog.

Outputs use curated DTOs rather than raw storage models. Arbitrary realm,
user, client, group, and role attribute maps, client secrets, raw credential
material, `secretData`/`credentialData` payloads, SMTP passwords, pairwise
sector keys, and protocol-mapper configuration are not returned. Credential
metadata contains only id, type, optional label, creation time, priority, and
the derived temporary flag. Session output omits redirect/state and other
client-session internals. Directory text can still contain indirect prompt
injection: output redaction is not a substitute for least privilege and
external-client approval UX.

## Strict operation-bound approval

With `[mcp.step_up].enabled=true`, strict tools follow one exact transaction
rather than granting general write authority:

1. An ordinary DPoP-bound token with `mcp:write` and the required role (or the
   correct self-service subject) calls the tool. The server canonicalizes the
   typed tool and arguments, captures the expected mutation state, stores a
   five-minute pending operation, and returns HTTP 401 with a
   `step_up_required` body and a DPoP `insufficient_user_authentication`
   challenge. Bearer compatibility cannot create or execute an operation.
2. A confidential client starts CIBA with the returned `operation_id`, binding
   message, exact canonical `resource`, `login_hint`, and
   `scope="openid mcp:step_up"`. `acr_values=0` is supported; other requested
   contexts are rejected explicitly. The operation is atomically claimed and
   the response contains an independent `approval_url`.
3. The hinted user authenticates freshly before the server renders any
   details. The approval page escapes the normalized arguments, expected state,
   exact mutation, target, client, realm, binding message, and expiry. GET has
   no decision side effect; POST requires a session-bound CSRF proof and has
   one terminal winner. Authentication must be no more than five minutes old.
   CIBA and impersonation sessions cannot approve. The legacy JSON approval
   endpoint cannot approve an operation-bound request.
4. The same client polls with the original DPoP key and exact resource. The
   result is a DPoP token carrying only `openid mcp:step_up`, with no refresh
   token. Its durable grant expires at the minimum of two minutes, token
   expiry, and operation expiry. Unknown, cross-client, or consumed request IDs
   return `invalid_grant`; actual expiry returns `expired_token`. Polls are
   serialized and use the advertised five-second interval.
5. The client retries the original tool with byte-equivalent typed arguments.
   The server compares every operation, subject, client, realm, resource, key,
   hash, and precondition binding, then atomically records the grant state,
   target mutation, and redacted result. PostgreSQL, SQLite, in-memory, and JSON
   backends implement the same conditional transaction contract.

The single-purpose token cannot call unrelated tools or UserInfo, Account, or
Admin APIs. A changed precondition returns 409 and a definite failed grant; an
unknown outcome returns a retryable error and never causes a blind second
mutation. Repeating the exact call returns the recorded successful result
without repeating audit, invalidation, or mutation. A new approval is never a
substitute for reconciling an unknown outcome.

After approval or denial, an optional `return_to` returns HTTP 303 to one of the
client's registered `redirect_uris`. The URI must match exactly at initiation
and at decision time; unregistered destinations are rejected, and omitting it
preserves the static decision page. The approval page's CSP `form-action` adds
only the validated destination's origin; all other restrictions stay in place.
This enables a same-tab return to the agent without an open redirect or hidden
iframe.

## Read-only resources

The endpoint advertises resources without `listChanged` or subscriptions:

| URI | Policy | Content |
|---|---|---|
| `issuerd://realm/{realm}/clients` | `mcp:read` + client read role | Complete redacted client catalog |
| `issuerd://realm/{realm}/roles` | `mcp:read` + realm read role | Complete realm-role catalog, excluding client roles |
| `issuerd://realm/{realm}/config` | `mcp:read` + realm read role | Curated non-secret realm configuration |

`resources/list` exposes only resources allowed by the caller's current scope
and roles. Every `resources/read` repeats policy and consumes the same
invocation allowance as a tool call. Content is JSON text with
`mimeType="application/json"`; list/read results carry zero-TTL private cache
hints. Resource URIs must match the authenticated realm exactly, including
spelling and escaping; there are no cross-realm or secret-bearing resources.

## Resource-specific token profile

The endpoint accepts only interactive, same-realm authorization-code/refresh
tokens with all of the following:

1. a valid, unrevoked token with a live persisted user session;
2. an enabled internal user and an enabled client named by `azp`;
3. an issuer realm identical to the target realm (no master/cross-realm
   widening and no UUID alias);
4. the exact canonical resource `{issuer_url}/realms/{realm}/mcp` both in the
   trusted access-token `resource` claim and in at least one `aud` entry.

The trusted claim distinguishes the RFC 8707 grant from an Audience mapper
that merely adds the same string to `aud`. Older tokens without it, tokens
from direct-access-token response types, password/client-credentials grants,
and marker-client audiences are not MCP onboarding workarounds. Cross-realm
administration and unattended M2M require separate policy work.

MCP resource authorization requests, including SPNEGO entry points, use
`response_type=code` and PKCE S256 for both public and confidential clients.
Wildcard redirects are rejected. Exact matching is required except for the
native loopback-port exception on `127.0.0.1` and `[::1]`; `localhost` is not
that exception. At code redemption `redirect_uri` may be omitted, but is
compared exactly when present. Introducing an allowlisted resource only at
redemption still requires the code to carry a valid S256 challenge. The stored
code redirect is revalidated under the same MCP profile for introduced,
inherited, and legacy resource grants, so a resource-less wildcard flow cannot
be upgraded at redemption.

Refresh tokens carry the granted resource and may only restate it or omit it
to inherit; they cannot widen it. The refresh-derived access token receives
the same resource provenance.

## DPoP and Bearer compatibility

With `require_dpop=true`, use `Authorization: DPoP <token>` and exactly one
valid proof on every POST. The proof is checked for:

- the token's `cnf.jkt` key binding and the access-token hash (`ath`);
- `htm=POST` and the canonical MCP `htu` or an RFC 3986-equivalent form (for
  example an explicit default port or normalized unreserved percent encoding;
  query, fragment, userinfo, backslash, control/whitespace, and UUID aliases
  are rejected);
- signature algorithm, `iat`, and single-use `jti` in the distributed replay
  cache;
- the server nonce when nonce mode is enabled.

Duplicate proof headers, replays, wrong keys/HTU/ATH, DPoP-bound tokens sent as
Bearer, and unbound tokens sent with the DPoP scheme are rejected. Nonce
validation happens before atomic nonce consumption, so an invalid signature
cannot burn another request's nonce. `supported` nonce mode is treated as
`required` at MCP; `disabled` remains disabled. Post-proof success and error
responses carry the fresh nonce when applicable and are uncacheable. If a
mandatory fresh nonce cannot be generated or persisted during a challenge or
after proof validation, the request returns 503 before preflight or tool
execution instead of succeeding without one.

With `require_dpop=false`, genuinely unbound Bearer tokens are accepted for
read-only and ordinary interoperability. Both downgrade directions still fail.
Strict operation-bound approval always requires DPoP regardless of this
compatibility setting.

## Discovery and challenge behavior

Protected-resource metadata is available at:

```text
GET /.well-known/oauth-protected-resource/{issuer-path}/realms/{realm}/mcp
```

The bare `/.well-known/oauth-protected-resource` route is an explicit master
alias, not origin metadata. The document advertises only `mcp:read` as the
minimal basic scope, the actual DPoP requirement and algorithms, and
`bearer_methods_supported=["header"]` only in explicit compatibility mode.

Initial discovery returns 401 without an OAuth error body. Strict mode sends a
DPoP challenge with `resource_metadata`, `algs`, and `scope="mcp:read"`;
compatibility appends separate Bearer and DPoP challenges. Actual scope misses
return 403 `insufficient_scope` with the exact operation scopes. Missing realm
roles return a plain 403. Invalid tokens/proofs use their distinct
`invalid_token`, `invalid_dpop_proof`, and `use_dpop_nonce` challenges.

## MCP transport

The endpoint is stateless Streamable HTTP over `http` 1.x/Tower. There is no
MCP protocol session, cluster affinity, `Mcp-Session-Id`, or `Last-Event-ID`
resumption. GET and DELETE return 405. Bodies are limited to 4 MiB and
recursive duplicate JSON keys are rejected before authentication.

| Revision | Lifecycle and result behavior |
|---|---|
| `2025-06-18`, `2025-11-25` | `initialize` + `notifications/initialized`; legacy results omit modern cache/result discriminators |
| `2026-07-28` | `server/discover`, required request `_meta` and routing headers, `resultType:"complete"`, private zero-TTL list/discovery hints |

Exactly those three versions are supported on non-initialize paths. Legacy
initialize retains specification version negotiation; stateless operation does
not add a cross-request initialized-session store. Modern missing required
`_meta` returns HTTP 400 `-32602`; header/body mismatches return `-32020`;
unsupported versions return `-32022`; unknown modern methods return HTTP 404
`-32601`. `listChanged` is not advertised.

Successful tool calls include structured output matching the advertised
`outputSchema` and a serialized JSON text mirror. Input, not-found, downstream,
and business failures use `isError:true`; unknown tools and malformed JSON-RPC
messages are protocol errors. JSON responses are used for terminal results;
the test matrix also covers SSE from an SSE-configured service.

## External TypeScript client and rigs

`examples/mcp-admin/` contains the pinned official TypeScript SDK 2.4.0 client
and two finite acceptance rigs. The public native client uses pre-registration,
PKCE S256, exact resource indicators, non-extractable ES256 keys from one SDK
`DpopSession`, and no client secret. It checks RFC 9207 `iss` and `state` on
successful and error authorization responses and never prints tokens, proofs,
keys, cookies, or Authorization headers.

```bash
cd examples/mcp-admin/client
npm ci
npm run build
npm run typecheck
npm test
```

Run the real in-memory daemon scenario from the repository root:

```bash
./examples/mcp-admin/scripts/e2e-local.sh
```

Run the branch-built daemon with PostgreSQL and Redis:

```bash
./examples/mcp-admin/scripts/e2e-compose.sh
```

Run exact-operation CIBA across three nodes sharing PostgreSQL and Redis:

```bash
./examples/mcp-admin/scripts/e2e-step-up-cluster.sh
```

The public native profile completes authorization-code issuance and all 23
legacy admin read tools in legacy and modern modes. The confidential profile
uses `client_secret_basic`, PKCE S256, and one SDK `DpopSession` to read all
three resources, update a user, clear lockout, relabel a credential, approve an
exact second-factor removal and an exact `users_delete` independently, reject
changed arguments and unrelated use, and reconcile exact replays.
The cluster runner requires approval on node 2, polling on node 3, and final
execution on node 1 without changing the canonical URL or DPoP key. Compose
runners remove their own projects and volumes on exit. See
[`examples/mcp-admin/README.md`](https://github.com/issuerd/issuerd/blob/main/examples/mcp-admin/README.md) for interactive
commands, lab-only credentials, and the evidence schema.

The nightly `heavy.yml` workflow runs the same npm checks and all three rigs.
Ordinary `cargo test` does not require npm.

## Other clients and current limits

`rmcp` 3.7 is used for Rust legacy/modern and explicit Bearer interoperability
checks. MCP Inspector 2.12 may be useful for Bearer-only debugging, but is not
DPoP or step-up evidence. VS Code configuration is intentionally absent until
its complete DPoP flow can be verified.

Current boundaries:

- no prompts, cross-realm master operations, unattended M2M, or built-in chat;
- CIBA `resource` and `operation_id` are accepted only for validated strict
  operations, never as a generic scope-only approval or ordinary login path;
- no secret rotation, raw credentials, TOTP seeds/QR codes, bulk export,
  impersonation, or audit deletion;
- service-account provisioning, built-in flow editing, secret-bearing IdP
  configuration, and disabling administrative audit are rejected rather than
  approximated by the strict transaction model.

## Verification

The relevant local gates are:

```bash
cargo test --test integration mcp::
cargo test -p issuerd-mcp
cargo test -p issuerd-server routes::mcp::tests
cargo test -p issuerd-server ciba
cargo test -p issuerd-storage step_up
```

The full increment additionally passes the workspace Rust gates and the npm
and real-client runs above. Test evidence is not a claim of FAPI, PSD2/RTS, or
OIDF MCP certification.
