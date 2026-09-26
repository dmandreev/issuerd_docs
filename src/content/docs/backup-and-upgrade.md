---
title: "Backup, restore, and upgrade"
description: "This document is the operational reference for protecting an Issuerd deployment: what state exists and where it lives, how to back it up, how to restore it, how schema migrations work, and how to…"
---

This document is the operational reference for protecting an Issuerd deployment: what state exists and where it lives, how to back it up, how to restore it, how schema migrations work, and how to upgrade or roll back single-node and clustered installations. It is written for system operators running Issuerd in production. For day-two cluster operations see [CLUSTERING.md](/clustering/); for the storage and cache configuration keys referenced below see [configuration.md](/configuration/).

## Contents

- [Where state lives](#where-state-lives)
- [Backup procedures](#backup-procedures)
- [Restore procedures](#restore-procedures)
- [Schema migrations](#schema-migrations)
- [Upgrading Issuerd](#upgrading-issuerd)
- [Compatibility guarantees](#compatibility-guarantees)
- [Rollback](#rollback)
- [Disaster-recovery runbook](#disaster-recovery-runbook)

## Where state lives

Issuerd separates **durable** state (PostgreSQL or a JSON snapshot file) from **ephemeral** state (Redis or the in-process cache). Understanding this split is the key to every backup and recovery decision: only durable state needs backups.

| State | Where | Backup needed? |
|---|---|---|
| Realms, users, credentials, clients, roles, groups, client scopes, consents, identity-provider configs and links, flow configs | PostgreSQL | **Yes** |
| SSO sessions (`user_sessions`, `client_sessions`) | PostgreSQL | **Yes** — restoring the DB restores logged-in sessions |
| **Signing keys** (`signing_keys` table: private DER + public JWK) | PostgreSQL | **Yes** — this is what keeps issued tokens valid across restores. With `[crypto.key_encryption]` enabled the rows are ciphertext; the **KEK must be backed up separately** (it is never in the DB — see below) |
| Login/admin event audit trail (`events`, `admin_events`) | PostgreSQL | **Yes** (compliance data) |
| Provision markers (`provision_markers`) | PostgreSQL | **Yes** (comes along automatically) |
| Auth codes, pending login/consent/registration/action flows, device and CIBA state, PAR requests, revocation blocklist, login-failure counters, registration access tokens | Redis | **No** — ephemeral by design |
| Access/ID/refresh tokens | Nowhere — self-contained JWTs | No — validated statelessly against the JWKS built from the stored signing keys |
| Metrics (`/metrics`) | Per node, in memory | No |
| Server configuration | Files on each node (`issuerd.toml`, provision file, themes, TLS material) | **Yes** |

### What exactly is in Redis

All Redis content is short-lived runtime state. The key prefixes below are defined in `crates/issuerd-cluster/src/keys.rs` and the issuerd-server route handlers:

| Key prefix | Contents | TTL |
|---|---|---|
| `auth_code:{code}` | Authorization codes not yet exchanged at the token endpoint | `[oauth] auth_code_ttl_secs` (default 600 s; per-realm `auth_code_ttl_secs` attribute) |
| `used_auth_code:{code}` | Reuse-detection markers for exchanged codes (hold the minted tokens so a replay revokes them) | Remaining lifetime of the minted tokens |
| `pending_auth:{realm}:{flow_id}` | In-flight browser login flows (multi-step authenticators, MFA challenges) | Flow lifetime |
| `pending_consent:{realm}:{execution}` | Consent screens awaiting a user decision | Flow lifetime |
| `pending_registration:{realm}:{flow_id}` | In-flight self-registration flows | Flow lifetime |
| `pending_actions:{realm}:{execution}` | Required-action executions (e.g. UPDATE_PASSWORD) | Flow lifetime |
| `device:{device_code}`, `user_code:{user_code}` | Device authorization grant state | Device flow lifetime |
| `ciba:{auth_req_id}` | CIBA backchannel authentication requests | Request lifetime |
| `par:{realm}:{request_id}` | Pushed authorization request payloads | PAR lifetime |
| `revoked:{token}`, `revoked_refresh:{token}` | Revocation blocklist entries | Sized to the token's own expiry |
| `login-failure:{realm}:{username}:{ip}` | Brute-force failure counters | Counter window |
| `login-lockout:{realm}:{username}:{ip}` | Brute-force lockout markers | Computed lockout duration |
| `action:{token_id}` | Action tokens (reset-credentials / execute-actions email links) | Action-token lifetime |
| `dpop_jti:{realm}:{jti}` | DPoP proof single-use markers | Proof acceptance window |
| `dpop-nonce:{realm}:{nonce}` | Server-provided DPoP nonces (opt-in `[dpop.nonce]`; single-use, consumed on verification) | `[dpop.nonce] lifetime_secs` (default 30 s) |
| `email-code:{realm}:{user_id}` | Passwordless email-login codes | Code lifetime |
| `webauthn-reg:{realm}:{user_id}`, `totp-enroll:{realm}:{user_id}` | In-flight passkey registration ceremonies and unverified TOTP enrollment secrets | Ceremony/enrollment lifetime |
| `broker_state:`, `broker_fbl:` | Identity-brokering SSO state and first-broker-login flows | 600 s |
| `broker_meta:`, `broker_jwks:` | Cached external-IdP discovery documents and JWKS | Cache lifetime |
| `client_jwks:`, `client_jwks_kid_miss:`, `client_assertion_jti:` | Cached client JWKS for JWT client auth (plus kid-miss refetch cooldowns) and assertion single-use markers | 300 s / 60 s / remaining assertion lifetime |
| `registration-rate:{realm}:{ip}` | Dynamic client registration rate-limit counters | 3600 s |
| `registration-access:{realm}:{client_uuid}` | SHA-256 hashes of dynamic-client registration access tokens | None |
| `session:`, `sessv:`, `realm-by-name:` | Session-validity snapshots, per-user session-version counters, realm-name resolution cache | `[cache] read_cache_ttl_secs` (default 60 s; negative session markers 5 s) |
| `user-claims:`, `realm-catalog:`, `client-scopes:`, `client-uuid:`, `claimsepoch:`, `usergen:`, `clientgen:`, `uinfo-resp:`, `discovery-resp:` | Claims read model (user/client/role/scope bundles, generation counters, epoch) and rendered userinfo/discovery response caches | `[cache] read_cache_ttl_secs` (default 60 s) |

**What a Redis wipe loses:**

- In-flight login, consent, registration, and required-action flows — affected users see an error and retry.
- Unredeemed authorization codes, in-progress device/CIBA/PAR requests — affected clients restart the flow.
- Revocation blocklist entries — previously revoked tokens become usable again until their natural expiry (the TTL was sized so entries live exactly as long as the token would). The realm-wide `not_before` revocation cutoff is **not** affected: it is durable realm configuration in PostgreSQL.
- Login-failure counters — brute-force lockouts reset.
- Registration access tokens of dynamically registered clients — those clients can no longer read/update/delete their own registration through the RFC 7592 endpoint.

**What a Redis wipe does NOT lose:** realms, users, clients, SSO sessions (refresh tokens keep working), issued JWTs (validated statelessly), signing keys, audit events. The demo stack exploits this by running Redis with `--maxmemory-policy allkeys-lru` and no persistence (`docker-compose.yml`).

> **Warning:** because single-token revocation entries are lost on a Redis wipe, use the realm-wide `notBefore` cutoff when a revocation must survive a cache flush — set it with `PUT /admin/realms/{realm}` (tokens issued before the cutoff are rejected). The cutoff itself is durable realm state in PostgreSQL.

### Development backends (in-memory, JSON-file)

Both are development/evaluation modes, so their backup story is deliberately short:

- **In-memory** (no `[storage]` section): all state — including signing keys — is generated per boot and lost on restart. There is nothing to back up.
- **JSON-file** (`[storage.json_file] path = "..."`): the entire durable state — realms, users, sessions, events, and signing keys — lives in the one snapshot file. Back it up by stopping the daemon and copying that file (writes rewrite the whole file non-atomically — never copy it live); restore by copying it back to the configured path (relative paths resolve against the daemon's working directory) and starting the daemon.

Both backends trigger the automatic master-realm bootstrap on first start (with PostgreSQL the master realm must come from the provision file — see [provisioning.md](/provisioning/)).

### Files to back up on every node

| Path | Why |
|---|---|
| `issuerd.toml` (the `-c` config file) | DB URL, `issuer_url`, TLS paths, SMTP credentials, CORS, cluster settings |
| Provision file (if used, e.g. `examples/provision.demo.yaml`) | Declarative realm/client/user content applied at first startup |
| Themes directory (`[themes] dir`, default `themes/`) | Custom login themes; the repo ships the default theme in `themes/issuerd/` |
| TLS certificate and key (`[tls] cert_path` / `key_path`) | Needed to serve the same identity on restore |
| Environment overrides | Any `ISSUERD_*` variables set in the systemd unit / container spec override the file — record them alongside it (see [configuration.md](/configuration/)) |
| Signing-key KEK (when `[crypto.key_encryption]` is enabled) | The KEK is **never in the database** — back up the `key_base64` value (and any `previous_keys`) wherever you sourced it: the env definitions of the systemd unit/container spec, or the permission-protected config file |

## Backup procedures

### PostgreSQL (production)

Use `pg_dump` against the database named in `[storage.postgres] url`:

```bash
# Custom-format dump (compressed, restorable with pg_restore)
pg_dump --host=localhost --username=issuerd --format=custom \
  --file=/var/backups/issuerd/issuerd-$(date +%F).dump issuerd
```

A nightly cron entry with 14 days of retention:

```txt
# /etc/cron.d/issuerd-backup
15 3 * * * postgres pg_dump --format=custom --file=/var/backups/issuerd/issuerd-$(date +\%F).dump issuerd && find /var/backups/issuerd -name 'issuerd-*.dump' -mtime +14 -delete
```

**Consistency:** no server quiesce is needed. `pg_dump` produces a transactionally consistent snapshot of the database while Issuerd keeps running (PostgreSQL MVCC). The state model supports this: *all* durable state lives in that one database, so a consistent DB dump is a consistent Issuerd backup. Redis is deliberately excluded — its content is ephemeral (see above). Writes that happen after the dump starts are simply not in that dump, which is the normal RPO trade-off.

For the Docker demo stack (its PostgreSQL publishes no host port), run the dump inside the container:

```bash
docker compose exec -T postgres pg_dump -U issuerd -Fc issuerd > issuerd-$(date +%F).dump
```

### Configuration and assets

Config files, themes, and TLS material change rarely — back them up on change, and at least alongside every database dump:

```bash
tar -czf /var/backups/issuerd/config-$(date +%F).tar.gz \
  /etc/issuerd/issuerd.toml /etc/issuerd/provision.yaml \
  /var/lib/issuerd/themes /var/lib/issuerd/certs
```

### Signing-key encryption KEK

When `[crypto.key_encryption]` is enabled, a database dump contains **only
ciphertext** signing-key material — that is the point of the feature — and the
consequences for backup and recovery invert the usual assumptions:

- **The KEK is not in the dump.** It comes from configuration
  (`key_base64`, preferably the `ISSUERD_CRYPTO__KEY_ENCRYPTION__KEY_BASE64`
  env var) and must be backed up through the same channel that delivers it —
  a secrets manager entry, the systemd unit / container spec, or the
  permission-protected config file. Back up every configured KEK: the active
  one **and** each `previous_keys` entry (rows encrypted under a previous KEK
  still need it until the boot sweep has re-encrypted them).
- **A dump without the KEK cannot recover the signing keys.** Booting a
  restored database without the matching KEK fails closed at startup
  (`signing-key encryption error`). The only KEK-less recovery is to start
  with an empty `signing_keys` table: the server generates fresh keys, every
  previously issued token becomes invalid, and all users must re-authenticate
  (SSO sessions die with the keys). That is a deliberate security property —
  a stolen dump must not yield token-signing capability — plan the KEK backup
  so it never comes to this.
- **Restoring with the KEK is transparent**: point the daemon at the restored
  database with the same `[crypto.key_encryption]` section and the keys
  decrypt on boot; pre-backup tokens and SSO sessions stay valid exactly as
  with plaintext storage.
- **KEK rotation procedure** (manual; an automated KMS-mediated flow is future
  work behind the `KeyEncryptionKeyProvider` SPI):
  1. Generate the new KEK (`openssl rand -base64 32`).
  2. Set the new `key_id` / `key_base64` and move the old pair into
     `previous_keys` (the old KEK stays decrypt-only).
  3. Roll the config to **all** nodes and restart them. Each boot's
     re-encryption sweep rewrites every row under the new active KEK.
  4. Verify convergence: `SELECT DISTINCT kek_kid FROM signing_keys;` must
     return only the new `key_id`.
  5. Remove the old `previous_keys` entry (and retire the old KEK from your
     backup once the retention window for pre-rotation dumps expires — dumps
     taken before step 3 still need it).
- **Schema note:** the encrypted columns arrived in migration
  `017_signing_key_encryption.sql` (expand phase — legacy plaintext rows keep
  working and are swept to ciphertext). Dropping the plaintext `private_der`
  column is a later contract-phase migration, announced in `CHANGELOG.md`.

## Restore procedures

### PostgreSQL restore

1. Create a fresh, empty database and restore the dump into it:

   ```bash
   createdb --host=localhost --username=postgres issuerd_restore
   pg_restore --host=localhost --username=postgres \
     --dbname=issuerd_restore /var/backups/issuerd/issuerd-2026-09-12.dump
   ```

   (For plain-SQL dumps made without `--format=custom`, use `psql --dbname=issuerd_restore --file=...` instead.)

2. Point the server at the restored database — set `[storage.postgres] url` in `issuerd.toml` (or `ISSUERD_STORAGE__POSTGRES__URL`) to the new database name.
3. Start the daemon. Boot applies any pending schema migrations automatically (see below); on a dump from the same version none are pending. The sqlx migration ledger and the `provision_markers` table are part of the dump, so already-applied migrations are skipped and provisioning does **not** re-run against restored data. If the dump holds encrypted signing keys (`[crypto.key_encryption]` was enabled), the **same KEK section must be configured** or boot fails closed — see "Signing-key encryption KEK" above.
4. If you restored under a different database name and are satisfied, you can later drop the old database; alternatively restore over the original name after dropping/recreating it.

### Post-restore verification checklist

```bash
# 1. Readiness — probes both storage and cache; must return 200 {"status":"ready"}
curl -fsS http://localhost:8080/ready

# 2. JWKS — the restored signing keys must be published (kid values match pre-restore)
curl -fsS http://localhost:8080/realms/master/protocol/openid-connect/certs

# 3. A real login — password grant against a public client exercises
#    storage, the token service, and the restored signing key end to end
#    (demo-stack values shown: realm myrealm, client public-app, alice/changeme):
curl -fsS -X POST http://localhost:8080/realms/myrealm/protocol/openid-connect/token \
  -d grant_type=password -d client_id=public-app \
  -d username=alice -d password=changeme

# 4. Admin console — log in at http://localhost:8080/admin/console and spot-check
#    realm count, a few users, and recent events.
```

Because signing keys are restored with the database, tokens and SSO sessions issued **before** the backup was taken remain valid after the restore — clients do not need to re-authenticate unless their tokens have expired.

## Schema migrations

Issuerd manages its PostgreSQL schema with embedded, numbered SQL migrations in `crates/issuerd-storage/migrations/` (`001_initial.sql` … currently through `017_signing_key_encryption.sql`):

- Migrations are compiled into the binary and **applied automatically at startup** (`sqlx::migrate!`, invoked from `ServerState::from_config` in `crates/issuerd-server/src/state.rs` and from `PostgresStorage::run_migrations`). The `issuerd provision` CLI subcommand runs them too before applying a provision file.
- Applied migrations are recorded in the database's sqlx migration ledger, so restarts and subsequent boots only run what is new.
- After the SQL migrations, an idempotent data backfill runs on every boot: built-in client scopes and per-client scope assignments, built-in browser/registration flows, and pairwise sector keys are seeded into realms that predate them (`crates/issuerd-storage/src/seed.rs`).
- The JSON-file backend needs no schema migrations; loading an older snapshot triggers the equivalent idempotent data backfill and persists the result.

**Append-only discipline (project policy):** existing migration files are immutable — never edited, renamed, or reordered. Schema changes ship as new, sequentially numbered files, and destructive changes follow expand-and-contract (add the new shape, migrate data, drop the old shape in a later migration). Combined with the additive-only API policy this means:

> **No operator action is needed for schema upgrades.** Starting the new binary migrates the database in place. In a cluster, whichever node starts first after the upgrade applies the pending migrations while older nodes keep running against the additively-extended schema.

## Upgrading Issuerd

Check the version before and after: `issuerd --version`, and the startup log line `Issuerd v<version> (<git hash>)`. Read `CHANGELOG.md` for the releases you cross — it carries any deprecation notices required by the compatibility policy.

### Single-node runbook

1. **Back up.** Take a fresh `pg_dump` (plus config/themes archive) — this is also your rollback anchor, see [Rollback](#rollback).
2. **Stop the daemon.** Send SIGTERM (`systemctl stop issuerd`); the server shuts down gracefully — when serving TLS directly it allows up to 30 seconds for in-flight requests, while plain HTTP drains them without a hard timeout.
3. **Replace the binary or image.** Install the new package, or bump the image tag and recreate the container (for the compose demo stack: `docker compose pull && docker compose up -d`).
4. **Start.** Boot applies pending migrations automatically; expect the migration log lines on the first start.
5. **Verify** with the [post-restore checklist](#post-restore-verification-checklist): `/ready`, JWKS, a test login, the admin console.

Outstanding tokens and sessions survive the upgrade: signing keys are read back from PostgreSQL, so the new binary signs and validates with the same keys.

### Cluster rolling upgrades

The cluster is designed for node-at-a-time upgrades (background in [CLUSTERING.md](/clustering/)):

1. **Drain one node** at the load balancer (remove it from the upstream/pool; there is no drain endpoint on the node itself). The remaining nodes serve all traffic — there are no sticky sessions.
2. **Stop, replace, start** the drained node as in the single-node runbook. Its first boot applies any pending migrations; additive migrations keep the still-old nodes working.
3. **Verify the node** locally (`curl http://<node>:<port>/ready` — readiness probes both PostgreSQL and Redis, so the LB health check on `/ready` (alias `/health/ready`) would hold an unhealthy node out of rotation anyway), then re-add it to the LB.
4. Repeat for each remaining node.

Mixed-version token validation keeps working throughout: signing keys live in the shared `signing_keys` table, every node reloads its keystore + JWKS snapshot on the `cluster.jwks_refresh_interval_secs` polling tick, and JWTs are validated statelessly against that shared set.

> **Warning — the one full-restart exception:** issuer URLs embed the realm **name** (`{issuer_url}/realms/{name}`). Upgrading from a build old enough to have embedded the realm **id** invalidates every outstanding token and session cookie (id-spelled issuers are rejected), so all users must re-authenticate. For that specific transition, perform a **full restart of all nodes at once** rather than a rolling upgrade (documented in [CLUSTERING.md](/clustering/)). Current builds are all name-based, so this only matters when crossing that historical boundary.

## Compatibility guarantees

Since 2026-09-12 the project enforces a standing backward-compatibility policy (see `AGENTS.md`). Its operational meaning for upgrade planning:

- **Database:** existing migration files are immutable; upgrades arrive only as new, sequentially numbered, additive migrations (expand-and-contract for anything destructive). Any prior schema upgrades in place — you never need to rebuild or re-provision the database. JSON snapshots from older versions keep loading.
- **Admin REST API and OIDC/OAuth2 protocol surface:** changes are additive (new optional fields, new endpoints, new enum values with tolerant parsing). Breaking changes require an explicit deprecation window, a documented migration path, and a `CHANGELOG.md` entry — so clients and integrations keep working across upgrades, and `CHANGELOG.md` is the authoritative place to check before a major jump.
- **Configuration and provisioning:** new config keys and provision YAML fields are optional with sensible defaults — your existing `issuerd.toml` and provision files boot unchanged on newer versions.

Net effect: **in-place, start-the-new-binary upgrades are the supported norm**, roll-forward is preferred over rollback, and the compatibility surface you must re-review on each upgrade is limited to `CHANGELOG.md` deprecations.

## Rollback

Whether a rollback is safe depends on whether the new version has applied a schema migration:

- **Safe — no new migration applied.** If the new binary was started but the release contained no migration (or it never reached the database), simply stop it, reinstall the previous binary/image, and start. Configuration compatibility is guaranteed in this direction too — the old binary understands every key the old config had.
- **Unsafe — the schema advanced.** Once a new migration has run, the old binary must not be started against the advanced schema: it was built against the older shape and can fail boot or misread data (expand-phase additions are usually tolerable, but a later contract-phase migration is not — do not rely on the distinction).

**Rule:** always dump the database **before** upgrading (the single-node runbook does this). To roll back across a migration boundary:

1. Stop the new version.
2. Restore the pre-upgrade dump (see [Restore procedures](#restore-procedures)).
3. Reinstall the previous binary/image and start it.
4. Verify with the post-restore checklist.

Data written between the backup and the rollback (new users, password changes, sessions, events) is lost — that is the cost of rolling back, and why roll-forward is preferred for additive-migration releases.

## Disaster-recovery runbook

Skeleton for a full site loss — adapt names and paths to your environment.

**RPO / RTO considerations:**

- **RPO** is bounded by your `pg_dump` schedule (nightly in the example above). Tighter RPO requires PostgreSQL-native continuous archiving (WAL shipping / PITR), which works transparently with Issuerd since all durable state is in one database. Redis needs no protection: its loss is a retry event, not data loss.
- **RTO** is the time to provision a PostgreSQL instance, restore the dump, and start the daemon — minutes if config/themes/TLS backups and the binary/image are readily available. Keep at least one known-good binary or image tag archived alongside the backups so a DR never depends on a rebuild.

**Ordered recovery checklist:**

1. Provision a fresh PostgreSQL (same or newer major version).
2. Restore the latest dump into it ([Restore procedures](#restore-procedures)).
3. Provision Redis — empty is fine; no restore step exists or is needed.
4. Install the Issuerd binary/image — the **same version** that wrote the dump, or newer (migrations will carry the schema forward; never older).
5. Restore `issuerd.toml`, the provision file (for reference — it will not re-apply over a restored database), the themes directory, and the TLS certificate/key; set `issuer_url` to the recovery-site URL if it changed.
6. Start the daemon; watch the boot log for migration and signing-key loading lines.
7. Run the [post-restore verification checklist](#post-restore-verification-checklist): `/ready`, JWKS `kid` continuity, a test login, admin console.
8. Re-point DNS / the load balancer at the recovered instance. In a cluster, re-add nodes one by one as in the rolling-upgrade procedure.

Because the signing keys, SSO sessions, and `not_before` cutoffs all live in PostgreSQL, a correctly restored service accepts tokens issued before the disaster and users with unexpired sessions stay logged in.
