---
title: "One approval, one exact operation: securing agent-native IAM administration with MCP"
description: "A broad Admin API token turns every agent mistake into a potential administration incident. Issuerd's built-in MCP server takes a different approach: ordinary actions stay inside server-enforced…"
---

A broad Admin API token turns every agent mistake into a potential administration incident. Issuerd's built-in MCP server takes a different approach: ordinary actions stay inside server-enforced roles and scopes, while a high-impact action becomes a deterministic transaction approved by a human for one exact operation. The model proposes; Issuerd decides what may execute.

- [Two MCP scenarios that should not be confused](#two-mcp-scenarios-that-should-not-be-confused)
- [What control means for any model](#what-control-means-for-any-model)
- [A curated surface with explicit risk tiers](#a-curated-surface-with-explicit-risk-tiers)
- [The exact-operation transaction](#the-exact-operation-transaction)
- [Failure behavior that makes approval deterministic](#failure-behavior-that-makes-approval-deterministic)
- [Evidence from real clients and three nodes](#evidence-from-real-clients-and-three-nodes)
- [Secure rollout and current limits](#secure-rollout-and-current-limits)

## Two MCP scenarios that should not be confused

Issuerd has two runnable MCP examples with different trust boundaries:

| Example | What Issuerd does | Security story |
|---|---|---|
| [`examples/agentic-mcp/`](https://github.com/issuerd/issuerd/blob/main/examples/agentic-mcp/) | Acts as the identity provider for an external MCP server | RFC 8693 token attenuation, DPoP, PostgreSQL row-level security, and scope-based CIBA approval for a downstream refund |
| [`examples/mcp-admin/`](https://github.com/issuerd/issuerd/blob/main/examples/mcp-admin/) | Exposes Issuerd's own realm-scoped MCP endpoint for administration and self-service | Curated tools and resources, same-realm tokens, DPoP, and exact operation-bound CIBA approval |

The older chat-and-PostgreSQL GIF demonstrates the first scenario. It is not evidence of the built-in administration endpoint. The second scenario has its own acceptance client and does not include a built-in chat, an LLM provider, or token passthrough to another API.

This distinction matters because a REST wrapper with a broad Admin API token is not the security model we want for agent-native administration. A large tool inventory increases both usefulness and the cost of a wrong selection, hallucinated argument, or prompt-injected instruction.

## What control means for any model

The control plane does not depend on a particular LLM. A hosted or local model from any vendor can participate through a compatible MCP client. The model generates a proposed tool call; Issuerd evaluates the call using server-side policy. Safety does not depend on the model faithfully following a prompt.

"Under control" does **not** mean that a human clicks approval for every read or routine change:

- Reads and reversible writes run only within explicitly assigned scopes and realm roles.
- Self-service operations are bound to the authenticated subject.
- Destructive and security-critical operations require a fresh human approval for the exact operation.
- Every tool listing and every invocation repeats authorization checks.

That is a useful boundary: ordinary work remains usable, while high-impact authority appears only after a specific human decision. A manipulated model can request something outside that boundary, but the request does not widen its authority.

## A curated surface with explicit risk tiers

The endpoint is `POST /realms/{realm}/mcp`, mounted only when `[mcp].enabled` is true. It uses stateless Streamable HTTP, exact same-realm resource provenance, and DPoP by default. The current surface contains **67 curated tools** and **three redacted read-only resources**:

| Surface | Count | Initiation and execution policy |
|---|---:|---|
| Administrative reads | 23 | `mcp:read` plus the corresponding view/manage role |
| Reversible administrative writes | 19 | `mcp:write` plus the corresponding manage role; they invoke the existing Admin application handlers |
| Account self-service | 10 | `openid` and strict subject ownership |
| Strict operations | 15 | Ordinary scope plus role/self-scope at initiation, then a fresh exact-operation grant at execution |

Role assignment is not a loophole around the strict tier. Assigning an administrative role, changing administrative composites, or adding a user to a group with an administrative effective closure becomes a strict operation even when the base tool is an ordinary write.

The resources expose redacted `clients`, `roles`, and `config` snapshots. Outputs use curated DTOs rather than raw storage models: client secrets, raw credentials and `credentialData`/`secretData`, TOTP seeds, private keys, SMTP passwords, and arbitrary attribute maps are not returned. Redaction reduces credential exposure; it does not make untrusted directory text safe to follow, so least privilege and client-side confirmation UX remain necessary.

## The exact-operation transaction

Strict approval is an Issuerd profile built around OAuth, DPoP, and CIBA. It is not a generic CIBA scope grant and not a claim of a standardized MCP approval protocol.

1. **The agent calls a strict tool with an ordinary token.** The token has the required scope and role, but no operation grant. Issuerd validates the typed input, canonicalizes `tool + arguments`, captures the expected mutation state, stores a five-minute pending operation, and returns `step_up_required` with an operation ID.

2. **A confidential client starts operation-bound CIBA.** It sends the operation ID, exact canonical resource, `login_hint`, the server-generated binding message, and `scope="openid mcp:step_up"`. The response contains an independent `approval_url`.

3. **The human authenticates before seeing operation details.** Authentication must be fresh. Issuerd renders the normalized arguments, expected state, exact mutation, target, client, realm, binding message, and expiry from server-stored data. GET only renders; the decision is a CSRF-protected POST with one terminal winner. The legacy JSON approval endpoint cannot approve this operation.

4. **The same client polls with the same key and resource.** On approval it receives a DPoP token carrying only `openid mcp:step_up`, without a refresh token. The durable grant expires within at most two minutes and never outlives the pending operation. The token cannot call unrelated tools, UserInfo, Account, or Admin APIs.

5. **The client retries the original typed call.** Issuerd compares the operation, subject, client, realm, resource, DPoP key, operation hash, and precondition. Grant state, conditional target mutation, and the redacted result commit atomically in one storage transaction.

An optional `return_to` can bring the browser back to the agent after approval or denial, but only to an exactly registered `redirect_uri`. The approval page remains on Issuerd rather than moving the trusted ceremony into an untrusted agent UI.

## Failure behavior that makes approval deterministic

Determinism here does not mean deterministic model output. It means that one approved typed operation has one bounded execution outcome, with explicit behavior for retries and failures:

| Condition | Server behavior |
|---|---|
| Changed tool or arguments | Rejected as an operation-binding mismatch; no mutation |
| Changed target precondition | Definite failure with no mutation; a fresh operation and approval are required |
| Unrelated use of the step-up token | Rejected; `mcp:step_up` alone is not general write authority |
| Exact retry after success | Returns the recorded result without a second mutation, audit event, or cache invalidation |
| Unknown execution outcome | Retryable reconciliation path; never blindly repeats a non-idempotent mutation or buys a new approval |
| Reused consumed CIBA request | `invalid_grant` |
| Wrong realm, client, subject, resource, or DPoP key | Rejected before execution |
| Bearer compatibility mode | Cannot create or execute strict operations |

This is the central guarantee: **what the human approved is the only operation the agent can execute**. Prompt injection may influence what the model requests; it cannot rewrite the server-stored operation after approval.

## Evidence from real clients and three nodes

The acceptance example uses the official TypeScript SDK, not a mocked MCP client. From the repository root:

```bash
./examples/mcp-admin/scripts/e2e-local.sh
./examples/mcp-admin/scripts/e2e-compose.sh
./examples/mcp-admin/scripts/e2e-step-up-cluster.sh
```

The local and Compose runs cover real authorization-code + PKCE + DPoP issuance, all 23 administrative read tools in legacy and modern protocol modes, three redacted resource reads, an ordinary `users_update`, and a strict `users_delete`. The strict evidence includes fresh authentication, rejected changed arguments and unrelated calls, one completed deletion, reconciled exact replay, and `invalid_grant` when the consumed CIBA request is polled again.

The three-node runner deliberately separates the flow:

```text
initial issuance on node 1
        ↓
fresh approval on node 2
        ↓
CIBA polling on node 3
        ↓
exact execution and replay on node 1
```

Every node keeps the same canonical issuer, PostgreSQL, Redis, signing keys, resource indicator, and DPoP key. This tests the operation across a real cluster rather than assuming that one process's in-memory state will be shared.

## Secure rollout and current limits

MCP is disabled by default. A cautious starting point is:

```toml
[mcp]
enabled = true
require_dpop = true

[mcp.step_up]
enabled = false
```

Enable reads and ordinary writes only after provisioning an agent client with explicit optional scopes. Enable `[mcp.step_up]` only after every cluster node and approval route supports operation-bound CIBA. Do not enable resource-bearing MCP tokens during a mixed-version rollout. Bearer compatibility is an interoperability choice for ordinary operations, never a strict-operation downgrade.

Current boundaries are deliberate:

- no prompts, cross-realm/master operations, unattended M2M, or built-in chat;
- no secret rotation, raw credentials, TOTP seeds/QR codes, bulk export, impersonation, or audit deletion;
- no FAPI, PSD2/RTS, or OIDF-MCP certification claim from the engineering acceptance runs;
- no transfer of the older version-specific OpenID certification entries to v0.2.x.

The complete operator contract is in [MCP server](/mcp-server/), and the older scope-based CIBA flow is compared with this profile in [Human step-up approval](/ciba-step-up/). The security property is not "the agent is always right"; it is that the agent's authority is deterministic, bounded, and independent of which model produced the request.
