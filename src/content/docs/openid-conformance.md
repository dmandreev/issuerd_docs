---
title: "Passing the OpenID conformance suite with zero unexpected warnings: what it actually takes"
description: "A green local conformance run and an official OpenID certification are related, but they are not the same artifact. Issuerd uses a hermetic self-hosted matrix for continuous engineering evidence…"
---

A green local conformance run and an official OpenID certification are related, but they are not the same artifact. Issuerd uses a hermetic self-hosted matrix for continuous engineering evidence and separate OIDF-hosted submissions for certification. The official result is version- and profile-specific: **10 OP profiles on v0.1.17 plus RP-Initiated Logout OP on v0.1.19**.

- [Three claims that should not be conflated](#three-claims-that-should-not-be-conflated)
- [The current certification matrix](#the-current-certification-matrix)
- [The self-hosted engineering matrix](#the-self-hosted-engineering-matrix)
- [Why the environment is hermetic and the suite pristine](#why-the-environment-is-hermetic-and-the-suite-pristine)
- [Expected failures, review items, and real key rotation](#expected-failures-review-items-and-real-key-rotation)
- [The failed profile and the resubmission](#the-failed-profile-and-the-resubmission)
- [What certification does not prove](#what-certification-does-not-prove)
- [How to reproduce and inspect the evidence](#how-to-reproduce-and-inspect-the-evidence)

## Three claims that should not be conflated

Conformance work produces three different kinds of claim:

1. **A self-hosted engineering run passes.** This is useful CI evidence: a known source revision, a pinned suite, a controlled environment, raw logs, and per-module results. It does not by itself create an OpenID certification.
2. **An OIDF-hosted run is accepted as evidence.** The official hosted environment executes the plans, including manual review items where required. Evidence is published and packaged for review.
3. **OIDF approves and lists a deployment in a registry.** This is the certification event. It names a particular implementation version and particular profiles; it is not a permanent statement about every future release.

The practical rule is simple: self-hosted results help engineering move quickly, hosted evidence supports a submission, and the registry is the authoritative statement of what was certified.

## The current certification matrix

The official registries currently contain two version-specific entries:

| Deployment | Certified OP profiles | Registry |
|---|---|---|
| **Issuerd v0.1.17** | Config, Basic, Implicit, Hybrid, Dynamic, 3rd Party-Init, Form Post, Session Management, Front-Channel Logout, Back-Channel Logout | [OIDC implementations](https://openid.net/certification/certified-openid-connect-implementations/) and [logout profiles](https://openid.net/certification/certified-openid-providers-for-logout-profiles/) |
| **Issuerd v0.1.19** | RP-Initiated Logout | [Logout profiles](https://openid.net/certification/certified-openid-providers-for-logout-profiles/) |

This means the project has 11 certified OP profiles across two submissions. It does **not** mean v0.1.19 alone is certified for all 11, and it does not transfer either entry to v0.2.x.

The accepted hosted evidence totals **33 plan invocations and 524 finished modules**: 27 plans on v0.1.17 plus six fresh RP-Initiated Logout plans on v0.1.19. The module outcomes are **393 PASSED, 41 declared SKIPPED, and 90 REVIEW with screenshots, with no FAILED or INTERRUPTED results**. Review and declared skip are explicit outcomes, not hidden failures and not a claim that every module passed.

## The self-hosted engineering matrix

The broader continuous matrix runs 43 plan invocations covering Config, Basic, Implicit, Hybrid, Form Post, Dynamic and 3rd-Party-Init across response types, plus all four logout profiles. The latest full run recorded in the repository was on **2026-10-31** with suite `release-v5.3.3`:

- 43 plan invocations and 612 test modules;
- more than 31,000 evaluated conditions;
- **zero unexpected failures and zero unexpected warnings**;
- all plan runners reporting `all plans OK`.

The accepted hosted submissions also used suite `release-v5.3.3`. Earlier engineering baselines used `release-v5.3.2`; their numbers should not be silently mixed with newer runs. The source of truth for the latest self-hosted run is [`tests/conformance/README.md`](https://github.com/issuerd/issuerd/blob/main/tests/conformance/README.md) and [`tests/conformance/COVERAGE.md`](https://github.com/issuerd/issuerd/blob/main/tests/conformance/COVERAGE.md), not an old article or a slide.

## Why the environment is hermetic and the suite pristine

The self-hosted environment is designed to make failures attributable to the implementation rather than to ambient network state:

- Docker's network is `internal: true`; the test environment has no internet access.
- bind9 is the only DNS resolver and has no recursion or forwarders. External names are refused, apart from explicitly mapped CDN names served from a local vendored mirror.
- The OP uses native rustls TLS, and the suite uses native Spring Boot HTTPS. A locally generated root CA is imported into the suite JVM truststore.
- The suite JAR is built from untouched upstream sources. Runner scripts remain pristine, and there is no intercepting or TLS-terminating proxy.
- The realm is bootstrapped for each run with in-memory storage, so old state cannot leak into the result.

This is not a claim that production should use the same topology. It is a test-oracle design: reproducible inputs, no external API dependencies, and no proxy behavior that can hide an implementation defect.

## Expected failures, review items, and real key rotation

"Zero unexpected failures" is more precise than "zero failures." The latest self-hosted matrix contains 24 failures in the declared Dynamic expected set and 12 warnings in the declared Back-Channel proxy-header set. These are reviewed against the run configuration rather than silently ignored.

The Dynamic set includes the three branding modules per response type and the in-plan key-rotation case. Branding behavior can require screenshot evidence, and suite/browser lifecycle behavior must be distinguished from a server protocol failure. Back-Channel warnings concern proxy headers that do not exist in the deliberately proxy-less stack.

The important part is what happens next: an expected in-plan result is not used to avoid real evidence. Standalone `oidcc-server-rotate-keys` evidence is produced by `run-rotation-check.sh`, which performs a real Admin API key rotation. On the hosted side, the actual key-rotation module completed and passed as well. Manual review and screenshots are part of the evidence, not an inconvenience to edit away.

## The failed profile and the resubmission

The certification path also exposed a real product defect. The initial RP-Initiated Logout submission was not accepted: missing and invalid `id_token_hint` values produced incorrect error descriptions, and an invalid hint could still lead to a post-logout redirect.

The fix was released as **v0.1.19**. OIDF allowed resubmission of only the failed package, so the team generated six fresh hosted RP-Initiated Logout plans on v0.1.19 rather than modifying the old evidence. That profile was approved and published on 2026-10-23; the other ten profiles remained accepted on v0.1.17.

Two rules from this episode generalize beyond logout:

- **A defect discovered during review is a reason to fix and produce fresh evidence, not to polish the old package.**
- **A resubmission has version scope.** An approved profile on one version does not rewrite the registry entries for another version.

The same discipline applies to operational evidence details. If screenshots, configuration, or implementation behavior changes, fresh hosted exports are safer than editing signed or already reviewed artifacts.

## What certification does not prove

The registry entries are strong protocol evidence, but they have boundaries:

- They do not certify v0.2.x, future releases, or every Issuerd feature.
- They do not certify MCP, FAPI, PSD2/RTS, SAML, UMA, FGAP, or Organizations.
- They do not prove production security, operational maturity, performance, or suitability for every deployment.
- A self-hosted full-matrix run does not replace an OIDF-hosted certification submission.
- Declared skips and review items are not erased by saying "zero failures"; the meaningful claims are the exact outcome matrix and the absence of unexpected results.

For a new deployment, verify the registry entry for the exact version being evaluated and then inspect the release's own engineering evidence and operational documentation.

## How to reproduce and inspect the evidence

The self-hosted runner clones the pinned suite, builds the environment, generates local PKI, bootstraps the realm, runs the matrix, and exports HTML and JSON evidence:

```bash
git clone https://gitlab.com/openid/conformance-suite.git tests/conformance/conformance-suite
cd tests/conformance/conformance-suite && git checkout release-v5.3.3 && cd -
./tests/conformance/run.sh
```

Results land under the gitignored `tests/conformance/results/`: per-plan HTML reports, JSON exports, and raw runner logs. Release packages additionally include a conformance-evidence archive. For the complete topology, expected-result policy, and standalone rotation command, see the [conformance guide](https://github.com/issuerd/issuerd/blob/main/tests/conformance/README.md). For the broader protocol and deployment context, see the [project README](https://github.com/issuerd/issuerd/blob/main/README.md).

The useful outcome of this process is not a badge in isolation. It is a repeatable chain from source revision to test environment, raw evidence, review, and a narrowly truthful certification claim.
