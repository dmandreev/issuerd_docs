---
title: "Issuerd operations documentation"
description: "This directory contains the operational documentation set for Issuerd — guides and references for the people who deploy, configure, administer, and troubleshoot an Issuerd installation, and for…"
---

This directory contains the operational documentation set for Issuerd — guides and references for the people who **deploy, configure, administer, and troubleshoot** an Issuerd installation, and for application developers integrating their software with it. Every guide below opens with its own table of contents (the two short references, `CLUSTERING.md` and `PERFORMANCE.md`, go straight to the point).

The documentation is written against the repository itself (configuration structs, route definitions, CLI, compose stacks, and test harnesses) and reflects behavior as implemented. Where Issuerd deliberately diverges from Keycloak, the difference is called out and also tracked in [`tests/KEYCLOAK_DIFFS.md`](https://github.com/issuerd/issuerd/blob/main/tests/KEYCLOAK_DIFFS.md).

## Contents

- [Reading paths](#reading-paths)
- [Documents](#documents)
- [Deployment guides](#deployment-guides)
- [Administration and integration](#administration-and-integration)
- [Agentic and MCP workloads](#agentic-and-mcp-workloads)
- [Identity sources](#identity-sources)
- [Operations](#operations)
- [Related references](#related-references)
- [Conventions used in these documents](#conventions-used-in-these-documents)

## Reading paths

Depending on your role, you will typically read the set in this order:

| Role | Suggested path |
|---|---|
| Evaluating Issuerd | [Getting started](/getting-started/) → [Administration](/administration/) → [Client integration](/client-integration/) |
| Deploying to production | [Getting started](/getting-started/) → [Configuration](/configuration/) → [Deployment](/deployment/) → [Security](/security/) → [Monitoring](/monitoring/) |
| Day-2 operator | [Administration](/administration/) → [Monitoring](/monitoring/) → [Backup, restore, and upgrade](/backup-and-upgrade/) → [Troubleshooting](/troubleshooting/) |
| Connecting a user directory | [User federation](/user-federation/) → [LDAP group mapping and token claims](/ldap-group-mapping/) → [Provisioning](/provisioning/) → [Troubleshooting](/troubleshooting/) |
| Connecting external identity providers | [Identity brokering](/identity-brokering/) → [Security](/security/) |
| Application developer | [Client integration](/client-integration/) → [Configuration](/configuration/) (CORS, issuer) |
| Building an AI agent or MCP server | [Agentic IAM: MCP tool calls](/agentic-iam-mcp/) → [Human step-up approval with CIBA](/ciba-step-up/) → [Client integration](/client-integration/) |

## Documents

### First steps and configuration

| Document | What it covers |
|---|---|
| [Getting started](/getting-started/) | Installation (Docker demo stack or build from source), first boot and seeding, verifying the installation, obtaining a first token, first hardening steps. |
| [Configuration](/configuration/) | Complete `issuerd.toml` reference: loading order, environment overrides, and every section — storage, TLS, logging, proxy, CORS, cluster, cache, themes, SMTP including per-realm overrides. |
| [Provisioning](/provisioning/) | Declarative realm seeding with `provision.yaml`: the apply-once marker semantics, the `provision` CLI command, and a field-by-field reference for realms, roles, groups, clients, users, identity providers, and flow configs. |

### Deployment guides

| Document | What it covers |
|---|---|
| [Deployment](/deployment/) | Deployment topologies, container and bare-metal/systemd installation, TLS termination options, reverse-proxy requirements, health checks, and the production checklist. |
| [Clustering](/clustering/) | Multi-node operation: the shared-state model (PostgreSQL + Redis), storage-backed signing keys, load-balancer requirements, and the two-node demo stack. |
| [Performance](/performance/) | Measured performance and sizing: k6 benchmark stack (`tests/perf/`, isolated network, Docker CPU/memory limits), throughput/latency vs Keycloak 26.7, CPU/RAM/disk/log growth, agentic workloads (DPoP/CIBA); plus the in-process micro-benchmarks (`tests/integration/bench.rs`). |

### Administration and integration

| Document | What it covers |
|---|---|
| [Administration](/administration/) | The admin access model (master realm, `realm-management` roles), the admin console, the Admin REST API with a curl cookbook, OpenAPI export, and events management. |
| [Client integration](/client-integration/) | The application developer's guide: discovery and endpoint map, choosing a flow, registering clients, the authorization code flow with PKCE end to end, token handling, logout, client authentication methods, adapter-config download, and advanced OAuth capabilities. |

### Agentic and MCP workloads

| Document | What it covers |
|---|---|
| [Agentic IAM: MCP tool calls with DPoP and token exchange](/agentic-iam-mcp/) | Securing AI-agent tool calls end to end: DPoP sender-constraining (`cnf.jkt`, single-use `jti` replay cache), RFC 8693 audience/scope attenuation per call, the resource-server enforcement checklist, a live failure matrix, and the recorded MCP demo. |
| [Human step-up approval with CIBA](/ciba-step-up/) | Client-Initiated Backchannel Authentication (poll mode) as the human-in-the-loop for privileged agent actions: endpoints and parameters, binding messages, DPoP-bound step-up tokens, the step-up configuration pattern, and the recorded refund-approval demo. |

### Identity sources

| Document | What it covers |
|---|---|
| [User federation](/user-federation/) | LDAP (Samba AD, OpenLDAP, MS Active Directory) and Kerberos/SPNEGO: provider configuration, user synchronization, group-mapping semantics, and operating a federated realm. |
| [LDAP group mapping and token claims](/ldap-group-mapping/) | The end-to-end pipeline: directory memberships → synced Issuerd groups → group role mappings → `realm_access` / `resource_access` / `groups` claims in tokens, with MS AD, Samba, and OpenLDAP specifics. |
| [Identity brokering](/identity-brokering/) | External OIDC and social identity providers (Google, GitHub, Microsoft): configuration, first broker login, account linking, IdP mappers, and `kc_idp_hint`. |

### Operations

| Document | What it covers |
|---|---|
| [Security](/security/) | Hardening: TLS and proxy baseline, signing-key rotation, password policies, brute-force protection, MFA operations (TOTP, WebAuthn, email codes), session and token hardening, admin-surface hygiene. |
| [Monitoring](/monitoring/) | `/health` and `/ready` probes, Prometheus metrics, logging and request correlation, login events and admin events (querying, retention, auditing). |
| [Backup, restore, and upgrade](/backup-and-upgrade/) | Where state lives, PostgreSQL and JSON-snapshot backup/restore procedures, schema migrations, single-node and rolling cluster upgrades, rollback rules, and a disaster-recovery skeleton. |
| [Troubleshooting](/troubleshooting/) | Symptom → cause → fix for startup, login flow, token, email, federation, brokering, and cluster problems, plus how to gather diagnostics and file a useful bug report. |

## Related references

These documents live outside `docs/` but are part of the operational picture:

| Document | Purpose |
|---|---|
| [README.md](https://github.com/issuerd/issuerd/blob/main/README.md) | Project overview, feature list, standards coverage, quickstart. |
| [ARCHITECTURE.md](https://github.com/issuerd/issuerd/blob/main/ARCHITECTURE.md) | High-level design and module contracts. |
| [CHANGELOG.md](https://github.com/issuerd/issuerd/blob/main/CHANGELOG.md) | Project changelog (currently: initial release). |
| [tests/KEYCLOAK_DIFFS.md](https://github.com/issuerd/issuerd/blob/main/tests/KEYCLOAK_DIFFS.md) | Every deliberate behavioral divergence from Keycloak 24. |
| [tests/conformance/README.md](https://github.com/issuerd/issuerd/blob/main/tests/conformance/README.md) | OIDC conformance suite harness and results. |
| [examples/](https://github.com/issuerd/issuerd/blob/main/examples/) | Fully-commented example server and provision configs (regenerable via `issuerd example`). |

## Conventions used in these documents

- **Commands** are shown for a Linux shell and assume the repository root as the working directory unless stated otherwise.
- **Placeholders** use angle brackets (`<db-password>`) or example domains (`idp.example.com`); replace them before running.
- **Admonitions**: `> **Note:**` for clarifications, `> **Warning:**` for actions that can lock users out, invalidate tokens, or lose data.
- **Cross-references** between these documents are relative links; source files are cited by repository path (e.g. `crates/issuerd-server/src/config.rs`).
- Default credentials and demo content (`admin`/`admin`, `alice`/`changeme`) refer to the seeded demo material described in [Getting started](/getting-started/) — never leave them in place on a reachable deployment.
