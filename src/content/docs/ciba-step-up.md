---
title: "Human step-up approval for agent actions: CIBA"
description: "Some actions should never ride on a token an agent already holds. Issuerd implements Client-Initiated Backchannel Authentication (CIBA, poll mode) so an agent can escalate a single action to the…"
---

Some actions should never ride on a token an agent already holds. Issuerd implements Client-Initiated Backchannel Authentication (CIBA, poll mode) so an agent can escalate a single action to the human behind it: the user sees an explicit approval request with a binding message, and only an approval mints a short-lived, DPoP-bound step-up token carrying the privileged scope.

- [Why agents need step-up](#why-agents-need-step-up)
- [Issuerd's CIBA at a glance](#issuerds-ciba-at-a-glance)
- [The step-up pattern](#the-step-up-pattern)
- [Walkthrough](#walkthrough)
- [Exact MCP operation approval](#exact-mcp-operation-approval)
- [Recorded demo](#recorded-demo)
- [Limits and notes](#limits-and-notes)
- [Source map](#source-map)

## Why agents need step-up

Least privilege is not only about what a token *can* do — it is about *when* the authority exists at all. An autonomous agent that can list orders should not permanently hold the power to refund them. The healthy shape is:

- The everyday login token carries **no** privileged scope. `refunds:execute` exists nowhere in the agent's standing credentials.
- When a task crosses a policy line the agent itself defined ("refunds above $100 need a human"), the agent asks the identity provider to interrupt the user.
- The user approves or denies, with the action spelled out in a **binding message** they actually read — not a generic consent screen.
- Only then does a token carrying `refunds:execute` come into existence: a short lifetime (the realm's access-token lifespan, 300 s by default), bound to the agent's DPoP key, usable for exactly the approved action.

This is CIBA's consumption-device/authorization-device split applied to agents: the agent is the consumption device, the user's browser session is the authorization device, and the binding message is the contract between them. It is also the practical shape of the human-in-the-loop (HITL) control that agent governance frameworks require for high-risk operations — with the important property that approval is gated by deterministic policy (the privileged scope simply does not exist before approval), not by the agent's own judgment about when to ask.

## Issuerd's CIBA at a glance

| | |
|---|---|
| Backchannel authentication endpoint | `POST /realms/{realm}/protocol/openid-connect/ext/ciba/auth` (advertised in discovery as `backchannel_authentication_endpoint`) |
| User approval endpoint | `POST /realms/{realm}/protocol/openid-connect/ext/ciba/approve` (browser form POST under the user's SSO session) |
| Token polling | `grant_type=urn:openid:params:grant-type:ciba` with `auth_req_id` at the realm token endpoint |
| Delivery modes | **poll** only; ping and push are out of scope |

Authentication request parameters (parsed in `crates/issuerd-protocol/src/ciba.rs`):

| Parameter | Semantics |
|---|---|
| `scope` | Optional; when present, every scope must be assigned to the client (default or optional), otherwise `invalid_scope` — a client cannot pick up authority the admin never granted it |
| `login_hint` / `login_hint_token` / `id_token_hint` | At least one required, identifying the user to interrupt. User resolution currently honors `login_hint` (the username) only — a request carrying just one of the other hints parses but then fails with `400 unknown_user_id` |
| `binding_message` | Up to 100 characters; shown to the user at approval time and echoed in the flow — "Refund $150 for order #123", not "Approve request" |
| `requested_expiry` | Overrides the default 120 s lifetime of the pending request |
| `acr_values`, `user_code`, `client_notification_token` | Parsed per the spec (the notification token matters for ping/push, which are not implemented) |

Polling semantics, per the spec:

- A pending request answers `authorization_pending`; polling faster than the advertised `interval` (default 5 s) answers `slow_down`; user denial answers `access_denied`.
- **Only the client that initiated the request may poll it** (CIBA §7.1) — another client presenting the `auth_req_id` is rejected.
- A disabled client cannot start backchannel authentication at all.

**DPoP threading.** When the polling request carries a DPoP proof, the issued step-up token is bound to that proof key (`cnf.jkt`) — the same binding discipline as every other grant. The privileged token is sender-constrained for its entire (short) lifetime. From there it feeds straight into the [RFC 8693 exchange](/agentic-iam-mcp/): step-up token in, `aud = mcp-server`, `scope = "refunds:execute"` token out, still DPoP-bound.

## The step-up pattern

The configuration that makes the story hold together:

1. Assign the privileged scope (`refunds:execute`) to the agent's client as an **optional** scope — and never request it at ordinary login. The login token then provably lacks it.
2. Assign the same scope to the downstream resource's client (e.g. `mcp-server`) so a step-up token can be exchanged into that audience.
3. Encode the autonomy policy in the agent ("refunds above $100 need approval"), and encode the *enforcement* in the resource server (`refund_order` requires `refunds:execute` or answers `403 insufficient_scope`). The agent's policy is a convenience; the resource's check is the guarantee.
4. Use a binding message that names the action, amount, and target. The user approves a specific decision, not a category.

## Walkthrough

```bash
# 1. The agent starts backchannel authentication (client-authenticated).
curl -X POST \
  https://idp.example.com/realms/myrealm/protocol/openid-connect/ext/ciba/auth \
  -d client_id=app8-chat -d client_secret=<secret> \
  -d scope="openid refunds:execute" \
  -d login_hint=alice \
  -d binding_message="Refund $150 for order #123"
# → {"auth_req_id":"f1b56bd6-…","expires_in":120,"interval":5}

# 2. Alice's browser (SSO session cookie) approves or denies:
curl -b "issuerd_session_<realm>=…" -X POST \
  https://idp.example.com/realms/myrealm/protocol/openid-connect/ext/ciba/approve \
  -d auth_req_id=f1b56bd6-… -d action=approve

# 3. The agent polls with a DPoP proof until approval lands.
curl -u app8-chat:<secret> -X POST \
  https://idp.example.com/realms/myrealm/protocol/openid-connect/token \
  -H "DPoP: <proof for POST .../token>" \
  -d grant_type=urn:openid:params:grant-type:ciba \
  -d auth_req_id=f1b56bd6-…
# pending → {"error":"authorization_pending"}
# approved → access_token: scope="openid refunds:execute", cnf.jkt=<proof key>, expires_in=300  # realm access-token lifespan
# denied  → {"error":"access_denied"}

# 4. Exchange the step-up token into the MCP audience (see agentic-iam-mcp.md)
#    and call refund_order with it. When the token expires, the authority is gone.
```

## Exact MCP operation approval

The realm-scoped [MCP administration endpoint](/mcp-server/) also has a
strict CIBA profile for irreversible and high-impact operations. It is separate
from the legacy scope-based example above and is disabled by default. Enable it
only after every node supports the operation and approval routes:

```toml
[mcp]
enabled = true

[mcp.step_up]
enabled = true
```

The flow binds approval to an exact typed operation, not just a scope:

1. An ordinary DPoP token with `mcp:write` and the necessary manage role calls a
   strict tool. Issuerd stores a five-minute pending operation containing the
   canonical arguments and expected mutation state, then returns
   `step_up_required` with an operation ID and server-generated binding message.
2. A confidential client initiates CIBA with that ID, the exact MCP `resource`,
   `login_hint`, the returned binding message, and
   `scope="openid mcp:step_up"`. The response includes an `approval_url` whose
   ID is independent of `auth_req_id`.
3. The hinted user authenticates freshly before any details are rendered. The
   server displays the exact escaped arguments and expected mutation, checks
   preconditions on GET and POST, and accepts one CSRF-protected decision. The
   legacy JSON approval endpoint cannot be used as a bypass.
4. The client polls with the original DPoP key and exact resource. Approval and
   polling share a per-request serialization lock, so the decision cannot erase
   polling history or reset the pacing interval. The client receives only an
   `openid mcp:step_up` DPoP token, never a refresh token. The durable grant
   lasts at most two minutes and cannot outlive the pending operation.
5. The client repeats the exact tool call. Issuerd atomically consumes the grant,
   checks current-state preconditions, commits the mutation, and stores the
   redacted result. Changed arguments are rejected. A changed precondition is a
   definite 409; an unknown outcome is retryable and never causes blind
   re-execution or an automatic fresh approval.

The step-up token cannot perform unrelated MCP calls or access UserInfo,
Account, or Admin APIs. An exact repeat reconciles the stored result without a
second mutation. `acr_values=0` is supported; other requested contexts are
rejected explicitly. Bearer compatibility cannot create or execute strict
operations.

### Returning to the client after approval

A confidential client may include an optional `return_to` in operation-bound
CIBA initiation. It must exactly match one of the client's registered
`redirect_uris`; arbitrary or merely same-origin URLs are rejected with
`invalid_request`. After approval or denial, Issuerd answers HTTP 303 to that
registered URI, while clients without `return_to` keep the existing static
decision page. The destination is checked again at decision time, so changing
the client registration cannot turn this into an open redirect. The approval
page adds only that validated destination's origin to CSP `form-action`, rather
than blocking a registered cross-origin return or allowing arbitrary sources.
The remaining `default-src 'none'`, `frame-ancestors 'none'`, and `base-uri
'none'` restrictions are unchanged.

This preserves the five-minute pending-operation and fresh-authentication
windows and the at-most-two-minute execution grant. It also supports a same-tab
approval flow without hidden iframes, `window.close()`, or moving the trusted
exact-operation approval page into an untrusted agent application.

Run the real TypeScript confidential profile and three-node approval flow:

```bash
./examples/mcp-admin/scripts/e2e-local.sh
./examples/mcp-admin/scripts/e2e-compose.sh
./examples/mcp-admin/scripts/e2e-step-up-cluster.sh
```

The cluster runner deliberately places approval on node 2, polling on node 3,
and final execution on node 1 while preserving one canonical resource and DPoP
key. See [MCP server](/mcp-server/) and
[`examples/mcp-admin/`](https://github.com/issuerd/issuerd/blob/main/examples/mcp-admin/) for the full operator and client
contracts.

## Recorded demo

The full loop — a refund request that exceeds the agent's autonomous limit, the in-app approval card backed by a real CIBA flow, the DPoP-bound step-up token, and the same call without step-up dying with a real `403` — recorded against a live Issuerd lab rig:

<p align="center"><img src="/images/demo-ciba.gif" alt="Issuerd CIBA demo: human step-up approval, DPoP-bound step-up token, 403 without it" width="100%"></p>

1. **"Refund $150 for order #123"** — over the agent's $100 autonomous limit, so it starts CIBA with `binding_message = "Refund $150 for order #123"`, `scope = "openid refunds:execute"` (trace shows `auth_req_id`, `expires_in: 120`, `interval: 5`).
2. **Approval** — the user clicks *Approve* on the in-app card; the approval rides the existing SSO session. The next poll returns a step-up token: `scope = "openid refunds:execute"`, DPoP-bound, with the realm's access-token lifespan as TTL (300 s by default).
3. **Refund executed** — the agent exchanges the step-up token into `aud = mcp-server` and the MCP server applies the refund; order #123 flips to `refunded`.
4. **The control** — a bare `curl` calling `refund_order` with the ordinary (non-step-up) token: `HTTP/1.1 403`, `error="insufficient_scope"`, `scope="refunds:execute"`. No human said yes, so no such authority exists.

## Limits and notes

- **Poll mode only.** CIBA ping and push delivery are deliberately out of scope (see *Project Scope* in the [README](https://github.com/issuerd/issuerd/blob/main/README.md)); `client_notification_token` is parsed but no outbound notification is attempted.
- Pending requests live in the distributed cache (`ciba:{auth_req_id}`) with their expiry as TTL — they work across a cluster and disappear on their own. An unknown, cross-client, or redeemed `auth_req_id` answers `invalid_grant` at polling; actual expiry answers `expired_token`. The legacy approval endpoint uses its corresponding expired/unknown-request rejection, while operation-bound approval uses the separate exact-operation page.
- The approval endpoint is a browser form POST under the realm SSO session; it is same-site by design (the session cookie is `SameSite=Lax`), which is what allows in-app approval cards on sibling subdomains without any CORS surface.
- **Every CIBA decision is auditable through the realm's login events** (recorded by default): `ciba_auth` when a backchannel request is accepted (details carry the scope, expiry, and the binding message's *length* — never the message text, which can carry PII), `ciba_auth_error` for rejections (`invalid_scope`, disabled or unknown client, missing hint, unknown/expired `auth_req_id` at approval, cross-user approval attempts), `ciba_approve` / `ciba_deny` for the user's decision, and a `login` event with `details.method=ciba` when a poll mints the tokens. A denied or expired poll records `login_error` with `access_denied` / `expired_token`; `authorization_pending` and `slow_down` polls are protocol chatter and record nothing.

## Source map

| Component | Path |
|---|---|
| Request parsing and validation | `crates/issuerd-protocol/src/ciba.rs` |
| Backchannel auth + approval handlers | `crates/issuerd-server/src/routes/oidc.rs` (`ciba_auth_handler`, `ciba_approve_handler`) |
| Polling in the token endpoint | `crates/issuerd-server/src/routes/oidc.rs` + `crates/issuerd-server/src/ciba_step_up.rs` (`urn:openid:params:grant-type:ciba`) |
| Exact-operation approval page | `crates/issuerd-server/src/ciba_approval.rs` |
| Durable grants and atomic execution | `crates/issuerd-core/src/mcp_step_up.rs`, `crates/issuerd-storage/src/step_up.rs`, migration `018_mcp_step_up_grants.sql` |
| Confidential TypeScript acceptance | `examples/mcp-admin/client/src/ciba.ts`, `step-up.ts` |
| DPoP binding of the issued token | `crates/issuerd-server/src/dpop.rs` |
| Discovery advertisement | `crates/issuerd-protocol/src/discovery.rs` (`backchannel_authentication_endpoint`) |

Related: [Agentic IAM: MCP tool calls with DPoP and token exchange](/agentic-iam-mcp/) · [Client integration](/client-integration/) · [Security](/security/)
