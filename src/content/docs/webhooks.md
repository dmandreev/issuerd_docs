---
title: "Webhook event listeners"
description: "Realm-scoped webhooks deliver authentication and administration events to external systems over HTTPS. They are intended for audit pipelines, alerting, user provisioning, and downstream workflows…"
---

Realm-scoped webhooks deliver authentication and administration events to external systems over HTTPS. They are intended for audit pipelines, alerting, user provisioning, and downstream workflows that need an event after Issuerd has committed it.

## Delivery contract

- **At least once:** a receiver can see the same event more than once after a lost response, restart, or lease expiry. Exactly-once delivery is not claimed.
- Every event has a stable UUID, also sent as `Idempotency-Key` and `X-Issuerd-Event-Id`. Deduplicate using that value and the subscription ID.
- Deliveries are queued in the configured storage before any network I/O. Login and admin requests never wait for a receiver. PostgreSQL, SQLite, and JSON snapshots preserve the outbox across restarts; the in-memory backend is process-local and loses it on restart.
- Publication preserves the existing non-fatal audit behavior: a business mutation is not rolled back when event publication fails. At-least-once applies after an outbox entry is committed; atomicity between a business mutation and event creation is not claimed.
- Each `(subscription_id, event_id)` is unique. Retries and manual replay retain the same event ID and idempotency key.
- Subscription secrets are accepted only on create/update and are never returned by the API or logged. Protect database and snapshot backups as secret-bearing material.
- Payload `schemaVersion` is `1`. `kind` is `USER` or `ADMIN`; field names follow Keycloak where practical.
- `events_enabled` controls local user-event audit and legacy listener dispatch. `admin_events_enabled` controls local admin-event persistence. Webhook subscriptions have independent `enabled` flags and do not require local audit retention.

## Configure a subscription

Create a subscription through the Admin API with a `manage-realm` token:

```bash
curl -X POST "https://issuerd.example.com/admin/realms/myrealm/webhooks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://receiver.example.com/issuerd-events",
    "secret": "replace-with-a-long-random-secret",
    "enabled": true,
    "eventTypes": ["USER.LOGIN", "USER.REGISTER", "ADMIN.USER.CREATE"],
    "includeRepresentation": false
  }'
```

The response contains the subscription UUID, filters, and creation metadata, but **not** the secret. Save the secret used for signing verification securely yourself.

Endpoints:

| Method | Path | Purpose | Required role |
|---|---|---|---|
| `GET` | `/admin/realms/{realm}/webhooks` | List subscriptions | `view-realm` or `manage-realm` |
| `POST` | `/admin/realms/{realm}/webhooks` | Create a subscription | `manage-realm` |
| `GET` | `/admin/realms/{realm}/webhooks/{id}` | Get one subscription | `view-realm` or `manage-realm` |
| `PUT` | `/admin/realms/{realm}/webhooks/{id}` | Update fields or rotate the secret | `manage-realm` |
| `DELETE` | `/admin/realms/{realm}/webhooks/{id}` | Delete a subscription and its deliveries | `manage-realm` |
| `GET` | `/admin/realms/{realm}/webhooks/{id}/deliveries` | Delivery status and retry metadata | `view-realm` or `manage-realm` |
| `POST` | `/admin/realms/{realm}/webhooks/{id}/deliveries/{delivery_id}/replay` | Requeue a delivery | `manage-realm` |

Create accepts `url`, `secret`, `enabled`, `eventTypes`, and `includeRepresentation`; `secret` is required. Update accepts the same fields except that all are optional and preserve the previous value when omitted. The URL must be absolute HTTPS without userinfo or a fragment and at most 2048 bytes. Secrets must be 1–1024 bytes without control characters. Filters use 1–64 entries. The same validation applies in the Admin API, provisioning, and every storage backend.

Delivery history contains `sequence`, `id`, `eventId`, `status`, `attempts`, `nextAttemptAt`, `lastError`, and timestamps. It deliberately excludes the event payload and secret material. Pagination uses zero-based `first` and `max`, defaulting to 20 and capped at 1000. Deleting a subscription or its realm deletes both pending deliveries and history, so remove a subscription only when undelivered events may be discarded.

### Provisioning

The same subscription can be declared once in `provision.yaml`:

```yaml
webhooks:
  - realm: myrealm
    url: ${ISSUERD_WEBHOOK_URL}
    secret: ${ISSUERD_WEBHOOK_SECRET}
    enabled: true
    event_types:
      - USER.LOGIN
      - USER.REGISTER
      - ADMIN.USER.CREATE
    include_representation: false
```

`event_types` defaults to `["*"]`, `enabled` to `true`, and `include_representation` to `false`. Existing subscriptions with the same URL are skipped on subsequent provisioning runs. Old provision files without a `webhooks` field are unchanged.

## Filters

| Filter | Matches |
|---|---|
| `*` | Every user and admin event |
| `USER.*` | Every user event |
| `ADMIN.*` | Every admin event |
| `USER.LOGIN` | Successful interactive login |
| `USER.LOGIN_ERROR` | Failed login, including authorization/JAR/PAR failures |
| `USER.REGISTER` | Self-registration |
| `USER.LOGOUT` | Logout and token revocation |
| `ADMIN.USER.CREATE` | Administrator-created user |
| `ADMIN.CLIENT.UPDATE` | Client update |

Admin filters use `ADMIN.<RESOURCE_TYPE>.<OPERATION_TYPE>`. The operation is `CREATE`, `UPDATE`, `DELETE`, or `ACTION`. Self-registration and administrator-created users deliberately remain different event families; no duplicate `USER_CREATED` event is invented.

## Payloads

User events include:

```json
{
  "schemaVersion": 1,
  "id": "7a6f3d9c-...",
  "time": 1762800000123,
  "kind": "USER",
  "realmId": "realm-uuid",
  "realmName": "myrealm",
  "type": "LOGIN_ERROR",
  "clientId": "my-app",
  "userId": "user-uuid",
  "sessionId": "session-uuid",
  "ipAddress": "192.0.2.10",
  "error": "invalid_user_credentials",
  "details": {
    "username": "alice",
    "error": "invalid_user_credentials"
  }
}
```

Admin events include `operationType`, `resourceType`, `resourcePath`, optional `representation`, and `authDetails`:

```json
{
  "schemaVersion": 1,
  "id": "8b7e4a1f-...",
  "time": 1762800000456,
  "kind": "ADMIN",
  "realmId": "realm-uuid",
  "realmName": "myrealm",
  "operationType": "CREATE",
  "resourceType": "USER",
  "resourcePath": "users/user-uuid",
  "authDetails": {
    "realmId": "master-uuid",
    "realmName": "master",
    "clientId": "admin-cli",
    "userId": "admin-uuid"
  }
}
```

`time` is Unix time in milliseconds. `clientId` is the public OAuth client identifier, not the internal client UUID. `representation` is omitted by default and is emitted only when both the realm and the subscription permit it. Realm sector keys are redacted using the same rule as the Admin API.

## HMAC-SHA256 verification

Each request includes:

```text
Idempotency-Key: <event UUID>
X-Issuerd-Event-Id: <event UUID>
X-Issuerd-Signature: t=<unix-seconds>,v1=<lowercase-hex-hmac-sha256>
Content-Type: application/json
```

The signature input is exactly `<timestamp>.<raw-request-body>`, with no newline between them. Verify the HMAC over the raw bytes before parsing JSON. Also check the timestamp against a short acceptance window and deduplicate the event ID.

Example verifier:

```python
import hashlib
import hmac
import time


def verify(secret: str, signature_header: str, body: bytes) -> bool:
    timestamp_part, separator, supplied = signature_header.partition(",v1=")
    if not separator or not timestamp_part.startswith("t="):
        return False
    timestamp = timestamp_part[2:]
    if not timestamp.isdigit() or abs(time.time() - int(timestamp)) > 300:
        return False
    if len(supplied) != 64 or any(c not in "0123456789abcdef" for c in supplied):
        return False
    expected = hmac.new(
        secret.encode(),
        timestamp.encode("ascii") + b"." + body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(supplied, expected)
```

Retries generate a new timestamp and signature while preserving the event ID. A receiver should answer a duplicate successfully instead of applying the event again.

## Retry, dead letter, and replay

A background worker claims due deliveries with expiring, unique per-attempt lease tokens; persistent backends restore abandoned leases after a restart. Multiple nodes exclude each other through storage transactions. Settlement checks the lease token, so a late worker cannot overwrite the result of a newer attempt or replay. Replay rejects an active delivery atomically.

The default batch contains up to 32 deliveries, processed concurrently. Claim order follows the outbox sequence, but receiver completion order is not guaranteed. Shutdown cancels in-flight work; a receiver may already have applied an event whose delivery is retried after lease recovery.

- `2xx`: delivered.
- Transport failures, `408`, `425`, `429`, and `5xx`: exponential backoff with jitter. The default starts at one second, caps at 60 seconds, and allows at most eight failed attempts. Numeric `Retry-After` delay-seconds are honored and capped at one hour.
- `3xx` and ordinary `4xx`: the delivery becomes `dead` instead of being retried forever. Redirects are never followed.
- `in_progress` cannot be replayed and returns `409 Conflict`.

`POST .../replay` moves any delivery that is not in progress back to `pending` with zero attempts, preserving the event ID and idempotency key. `lastError` and `deliveredAt` are cleared. A wrong subscription UUID returns `404` even when the delivery exists elsewhere in the realm.

Changing filters or `includeRepresentation` affects newly enqueued events, not payloads already in the outbox. `enabled` is checked when claiming a delivery. URL and secret are also read when claiming it, so an already claimed attempt may still use the previous secret. Accept both old and new secrets briefly during rotation; subsequent claims use the updated values.

## Outbound security

- HTTPS and certificate verification are mandatory. Additional private roots can be supplied with `[outbound_http] extra_ca_bundle`.
- Redirects are rejected. DNS resolution is pinned to the connection.
- Private, loopback, link-local, and other non-public addresses require the explicit `[outbound_http] allow_private_addresses = true` opt-in, intended only for trusted internal integrations and test rigs.
- Requests have a ten-second timeout. Responses are drained with a 64 KiB cap.
- URLs, payloads, and secrets are not written to application logs.

## Operational notes

PostgreSQL migration `019_webhooks.sql` and SQLite migration `020_webhooks.sql` add subscriptions and durable deliveries. JSON snapshots preserve subscriptions, deliveries, and sequence state. The in-memory backend is process-local and does not survive restart. SQLite and JSON are single-node backends; multi-node delivery is supported only through shared PostgreSQL storage.

The persistent outbox is not Redis Pub/Sub and does not depend on cache retention. Backup and restore procedures must include the webhook tables or JSON snapshot, since pending deliveries and subscription secrets live there. Restoring an in-flight delivery can produce a duplicate, as expected for at-least-once delivery.

Delivery history has no automatic expiration and `events_expiration_secs` applies only to the local user-event audit, not to the outbox. Plan database capacity accordingly; deleting a subscription or realm removes its delivery history.

Dynamic Java plugins are not loaded. The existing `EventListener` trait remains the in-process extension point, while webhooks are the supported out-of-process integration contract.
