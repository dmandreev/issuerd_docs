---
title: "Human step-up approval for agent actions: CIBA"
description: "Some actions should never ride on a token an agent already holds. Issuerd implements Client-Initiated Backchannel Authentication (CIBA, poll mode) so an agent can escalate a single action to the…"
---

Some actions should never ride on a token an agent already holds. Issuerd implements Client-Initiated Backchannel Authentication (CIBA, poll mode) so an agent can escalate a single action to the human behind it: the user sees an explicit approval request with a binding message, and only an approval mints a short-lived, DPoP-bound step-up token carrying the privileged scope.

- [Why agents need step-up](#why-agents-need-step-up)
- [Issuerd's CIBA at a glance](#issuerds-ciba-at-a-glance)
- [The step-up pattern](#the-step-up-pattern)
- [Walkthrough](#walkthrough)
- [Recorded demo](#recorded-demo)
- [Limits and notes](#limits-and-notes)
- [Source map](#source-map)

## Why agents need step-up

Least privilege is not only about what a token *can* do — it is about *when* the authority exists at all. An autonomous agent that can list orders should not permanently hold the power to refund them. The healthy shape is:

- The everyday login token carries **no** privileged scope. `refunds:execute` exists nowhere in the agent's standing credentials.
- When a task crosses a policy line the agent itself defined ("refunds above $100 need a human"), the agent asks the identity provider to interrupt the user.
- The user approves or denies, with the action spelled out in a **binding message** they actually read — not a generic consent screen.
- Only then does a token carrying `refunds:execute` come into existence: a short lifetime (the realm's access-token lifespan, 300 s by default), bound to the agent's DPoP key, usable for exactly the approved action.

This is CIBA's consumption-device/authorization-device split applied to agents: the agent is the consumption device, the user's browser session is the authorization device, and the binding message is the contract between them.

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
curl -u app8-chat:<secret> -X POST \
  https://idp.example.com/realms/myrealm/protocol/openid-connect/ext/ciba/auth \
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

## Recorded demo

The full loop — a refund request that exceeds the agent's autonomous limit, the in-app approval card backed by a real CIBA flow, the DPoP-bound step-up token, and the same call without step-up dying with a real `403` — recorded against a live Issuerd lab rig:

<p align="center"><img src="/images/demo-ciba.gif" alt="Issuerd CIBA demo: human step-up approval, DPoP-bound step-up token, 403 without it" width="100%"></p>

1. **"Refund $150 for order #123"** — over the agent's $100 autonomous limit, so it starts CIBA with `binding_message = "Refund $150 for order #123"`, `scope = "openid refunds:execute"` (trace shows `auth_req_id`, `expires_in: 120`, `interval: 5`).
2. **Approval** — the user clicks *Approve* on the in-app card; the approval rides the existing SSO session. The next poll returns a step-up token: `scope = "openid refunds:execute"`, DPoP-bound, with the realm's access-token lifespan as TTL (300 s by default).
3. **Refund executed** — the agent exchanges the step-up token into `aud = mcp-server` and the MCP server applies the refund; order #123 flips to `refunded`.
4. **The control** — a bare `curl` calling `refund_order` with the ordinary (non-step-up) token: `HTTP/1.1 403`, `error="insufficient_scope"`, `scope="refunds:execute"`. No human said yes, so no such authority exists.

## Limits and notes

- **Poll mode only.** CIBA ping and push delivery are deliberately out of scope (see *Project Scope* in the [README](https://github.com/issuerd/issuerd/blob/main/README.md)); `client_notification_token` is parsed but no outbound notification is attempted.
- Pending requests live in the distributed cache (`ciba:{auth_req_id}`) with their expiry as TTL — they work across a cluster and disappear on their own. An unknown or expired `auth_req_id` answers `expired_token` at both the approval and polling endpoints.
- The approval endpoint is a browser form POST under the realm SSO session; it is same-site by design (the session cookie is `SameSite=Lax`), which is what allows in-app approval cards on sibling subdomains without any CORS surface.
- **Every CIBA decision is auditable through the realm's login events** (recorded by default): `ciba_auth` when a backchannel request is accepted (details carry the scope, expiry, and the binding message's *length* — never the message text, which can carry PII), `ciba_auth_error` for rejections (`invalid_scope`, disabled or unknown client, missing hint, unknown/expired `auth_req_id` at approval, cross-user approval attempts), `ciba_approve` / `ciba_deny` for the user's decision, and a `login` event with `details.method=ciba` when a poll mints the tokens. A denied or expired poll records `login_error` with `access_denied` / `expired_token`; `authorization_pending` and `slow_down` polls are protocol chatter and record nothing.

## Source map

| Component | Path |
|---|---|
| Request parsing and validation | `crates/issuerd-protocol/src/ciba.rs` |
| Backchannel auth + approval handlers | `crates/issuerd-server/src/routes/oidc.rs` (`ciba_auth_handler`, `ciba_approve_handler`) |
| Polling in the token endpoint | `crates/issuerd-server/src/routes/oidc.rs` (`urn:openid:params:grant-type:ciba`) |
| DPoP binding of the issued token | `crates/issuerd-server/src/dpop.rs` |
| Discovery advertisement | `crates/issuerd-protocol/src/discovery.rs` (`backchannel_authentication_endpoint`) |

Related: [Agentic IAM: MCP tool calls with DPoP and token exchange](/agentic-iam-mcp/) · [Client integration](/client-integration/) · [Security](/security/)
