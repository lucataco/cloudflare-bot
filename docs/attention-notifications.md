# Attention And Browser Push

## Owner Inbox

`/attention` is an owner-scoped projection of canonical workspace records. Shared-workspace access,
group membership, and agent execution do not grant access to another owner's inbox or notification
devices. Its links only navigate; approvals, browser grants, and automation continuation still use the
existing workspace capabilities and checks.

The inbox distinguishes three independent facts:

- **Source state:** pending, accepting, resolved, or an explicit task execution disposition. A waiting
  task is not an inventory of pending approvals; each action/request/proposal is projected separately.
- **Seen:** the owner acknowledged exactly the displayed source version. A concurrent newer version
  stays unseen. Reading, receiving a notification, and source resolution do not mark an item seen.
- **Transport:** idle, pending, accepted by a push service, or failed. Acceptance is not proof that the
  browser displayed the message, that the owner read it, or that the task succeeded.

Each workspace retains 100 recent projections; each owner retains 500 across workspaces. Pages contain
at most 30 items. Overflow is visible, and canonical requests are never deleted by inbox retention.
This is deliberately a recent attention window, not an exhaustive approval inventory.

Workspace mutations and projection versions commit together. Full, versioned snapshots retry through
durable alarms; an older response cannot replace newer state. Bounded bootstrap examines 50 source
records per workspace pass and 16 owner workspace records per pass. Catch-up continues without an open
browser, reports incomplete work, and never converts historical discoveries into push alerts.

Chat deletion removes message/run attention, but unresolved actions remain available for workspace-level
review. Workspace/bot deletion suppresses late projection writes and queued delivery. This does not add
new automation-teardown guarantees to the existing bot deletion path.

## Explicit Consent

Browser Push requires deployment configuration **and** explicit device enrollment from Attention. The
existing **Notify me about this bot** preference remains a separate filter; its default-true value is
not permission to enroll a device. Muting a bot suppresses delivery without hiding its inbox records.
Delayed transitions predating enrollment or the latest bot unmute are not replayed as new alerts.

At most five devices may be enrolled. Pending notifications coalesce into one bounded job per device,
with up to twenty source/version candidates. Delivery rechecks current ownership, device generation,
bot preference, seen state, exact source version, and the workspace's sensitive-data restriction.
Failing sources do not prevent a healthy source in the same job from producing a generic alert.

The payload is encrypted using RFC 8291 `aes128gcm`, authenticated with VAPID, and padded to a constant
4096-byte envelope. It contains only `{ "type": "attention" }`. The notification-only service worker
uses fixed text and opens the same-origin `/attention` path. Prompts, workspace/bot names, raw errors,
action descriptions, source URLs, screenshots, share fragments, and capability stubs never enter push
payloads. No request interception or offline content cache is installed.

Supported endpoint hosts are Google's FCM, Mozilla's production push service, Apple's Web Push, and
Microsoft's `*.notify.windows.com`. Endpoints must be HTTPS, without credentials, alternate ports, or
fragments. Redirects are not followed. Endpoint URLs and receiver keys are secrets and are not exposed
in device settings or logs.

Retries use bounded exponential backoff, with at most six attempts per job. A 404/410 response removes
an expired device; redirects and authentication rejection fail closed. An acknowledged request can
still be retried after response loss, so delivery is **not exactly once**. A stable topic/tag coalesces
duplicates, and the five-minute push-service TTL limits delayed display. Already dispatched messages
cannot be recalled by server-side revocation.

Logout immediately removes enrollment authority and disables the persistent local display gate, then
attempts server revocation and browser unsubscribe using a retained cleanup capability. Account changes
also disable local display. Closing a tab is not logout. If cleanup cannot be confirmed, the UI reports
that limitation; blocking site notifications in browser settings is the final shared-device control.

## Deployment Setup

Push stays unavailable until the backend has all three values: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
and `VAPID_SUBJECT`. The private key must be a Worker secret. Use a stable operator contact for the
subject, such as `mailto:operator@example.com` or an HTTPS contact page.

Generate one P-256 keypair into a private file **outside the repository**. The destination's parent
directory must already exist; the generator refuses to overwrite a file and writes mode `0600`:

```sh
node scripts/generate-web-push-keys.ts \
  --subject mailto:operator@example.com \
  --out /private/path/web-push-secrets.json
```

Provision the file into the **deployed backend worker**, using that deployment's Wrangler configuration:

```sh
pnpm exec wrangler secret bulk /private/path/web-push-secrets.json \
  --config /path/to/deployed-backend.wrangler.jsonc
```

Do not paste signing keys into source, admin text fields, or command arguments. For local development,
configure the three values in the backend's ignored local secrets file using the normal deployment
secret workflow. Keys were not generated or installed automatically by this changeset.

Serve the Workshop over HTTPS (localhost is allowed for development). From Attention, choose **Enable
browser push** and explicitly allow the browser permission prompt. On iOS/iPadOS 16.4+, use an installed
Home Screen web app. A minimal web manifest is included; unsupported or blocked browsers get an honest
explanation rather than a fake enabled state. Key rotation requires affected devices to re-enroll.

## Verification Boundaries

Workerd tests cover real workspace-to-owner RPC, rollback, lost acknowledgments, ordering, retention,
seen versions, deletion, consent cutoffs, revocation races, source failures, retries, and redirects.
Cryptographic tests independently verify the VAPID signature and decrypt the generated envelope.
Frontend tests cover subscription loss/reconnect, stale replies, pagination, enrollment cancellation,
logout races, local suppression, and constant service-worker navigation.

Browser QA uses synthetic fixtures and the local inbox. It does not request real permission, enroll a
device, or trigger user automation. Actual push-service acceptance, closed-browser delivery, and iOS
installation need a configured deployment and a consenting test device; passing crypto/unit tests does
not establish those end-to-end outcomes. Background email/Slack delivery and named-bot delegation are
not part of this stage.
