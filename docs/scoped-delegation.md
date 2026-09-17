# Scoped Named-Bot Delegation

## Configure Explicitly

Open a source bot's workspace settings, expand the delegation controls, and load its current policy.
Select another bot you own and, optionally, the source-workspace resources it may receive. Save those
delegation settings explicitly. New and existing workspaces default to **no targets and no resources**.
Configuration is separate from the ordinary profile save and is unavailable to collaborators.

The authoritative policy lives in the source Overseer, not in a browser cache or a target-name match.
Its compare-and-swap revision fences preparation and admission after asynchronous profile/model reads.
The source must still be the owner's dedicated bot workspace; group membership, raw `@mentions`, and
knowing a profile ID never authorize a launch.

Only existing external gatekeeper resources are eligible. Gadgets, spawners, ambient singleton account
records, and callback/value capabilities cannot be selected. Resource IDs are resolved in the source
workspace, never copied into the target's private workspace. A resource remains the existing coarse
capability; selecting it does not create a new read-only or per-method attenuation layer.

Removing a target or resource grant blocks new admissions that have not committed. It does not revoke
already admitted children, which retain their frozen resource snapshot. Stop those tasks explicitly
when that is intended. Target instructions, name, and model selection are snapshotted during authorized
preparation: later remote profile edits do not rewrite that task. Deletion before target lookup fails;
an already prepared snapshot is not a cross-Durable-Object revocation transaction.

## Admission And Results

`delegateToBot` accepts a stable request key, target ID, short title, task/context text, and an optional
subset of the configured resource names. Omitted resource names mean none, not all configured resources.
The parent identity, attempt, workspace, payer, and configuration revision come from the kernel, not
model-supplied arguments.

Preparation is inert. The model receives a **staged** identifier, not a completed result. At the parent
step barrier, the kernel validates every delegation success marker and rechecks admission authority.
Parent evidence, the receipt/link, the child's prompt/context/run, and its restart intent commit in one
transaction. Inference begins only afterward. A refused delegation is recorded as a tool error without
discarding unrelated completed effects. Duplicate provider tool-call IDs are rejected before that step
executes any tools.

The delegation ID is the child run ID, derived from workspace, logical parent, and request key. Exact
retries reuse the original receipt; conflicting reuse fails. The key does not include the attempt, so
parent retries cannot reset the budget. Child deletion retains a receipt and input fingerprint rather
than recreating work; its full input is dropped from that receipt record.

Receipt cards stay outside collapsed activity and link to the same-workspace child conversation, not
the target bot's private chat. `getDelegationResult` reads the current run disposition and bounded latest
assistant text. The text is untrusted task output, and `finished` does not establish verified success.
Result reads remain available to the parent conversation after launch grants are removed.

There is no automatic durable join. The parent may finish while children work independently. Inspect
their receipts, or ask the parent for results in a later turn. Follow-up prompts and direct retries in
the child are rejected; further work must be requested from the parent using a new delegation key.

## Isolation And Bounds

The existing scoped-spawner prompt/runtime model is reused, but no legacy spawner capability is created
for a named child. Each child has an isolated conversation in the **source workspace**, an explicit
binding snapshot, and empty ambient discovery state. Target identity is presentation metadata, never
`chatContext.agentId`, which would import private per-bot state.

Children receive only the explicit handoff text, the target's standing-instruction snapshot, and the
selected resources. They do not inherit target or parent conversation history, attachments, memory,
skills, browser sessions, private account bindings, or ambient catalogs.

Their model tools are limited to binding description and code execution. They receive no named
delegation tool, private state tools, connection/proposal tools, or browser tools. Code runs with global
network egress disabled and an exact frozen-resource intersection. The trusted named-child entrypoint
and its inherited prototypes are frozen before dynamically importing untrusted code. No `self`,
execution `ctx`, callback resolvers, or restore-forger capability is passed; persistent restore support
is disabled, and named-child hook registration is rejected.

Bounds for this path are:

- Eight configured targets per source workspace.
- Eight explicit external bindings per child.
- Four lifetime named-child admissions per logical parent, including deleted children.
- One level of named delegation; children cannot delegate again.
- 16 KiB of UTF-8 handoff text and 32 KiB of target standing instructions.
- 8 KiB of returned assistant text, with at most 100 child transcript records examined per result read.
- The existing per-execution model-step limits still apply.

These are not global limits on all workspaces or legacy spawner capabilities. The child conversation
also is not a new privacy boundary against users already authorized to build/read the source workspace.
Existing sharing, sensitive-data, gatekeeper approval, and billing policies remain in force.

## Cancellation And Continuation

Stopping a logical parent cancels its unfinished named children, not children from an older task in the
same conversation. Stopping one child leaves its parent and siblings alone. Normal parent completion
does not cancel children. Deleting a parent conversation cancels children from all its tasks; deleting
a child preserves the deduplication receipt. Workspace pause cancels unfinished named children,
including durable waits, and resume does not revive them.

Cancellation removes restart intent and persists a link fence before aborting live turns. Both new
resource sessions and retained observation/action authorization queues check that fence, including
after chat deletion. Operations already dispatched before cancellation may finish; existing approved
or pending actions are not undone. Manual approval still acts on its canonical action record.

An authorized action approval can resume an uncanceled waiting child. Model resolution uses the original
owner's account and frozen model ID, regardless of which build collaborator approved. The approver is
decision attribution, not a replacement payer. If that model is unavailable, the applied decision stays
recorded and the child becomes incomplete rather than waiting forever for an impossible reapproval.

## Verification And Exclusions

Workerd tests cover owner configuration, same-owner target resolution, default-none grants, atomic
barriers/rollback, malformed and duplicate tool evidence, stable retries, deletion tombstones, bounded
fan-out, cancellation scopes, reconnect catch-up, canonical receipt refresh, and approval continuation.
The real WorkerLoader runs hostile module/prototype tests as well as checks that child `self`/`ctx` are
unavailable. Real UserDO/Overseer integration tests verify profile isolation and collaborator approval
against an owner-only model.

Model behavior is synthetic in these tests; no real LLM-quality benchmark, user task, external resource
write, or private browser session was run for this stage. UI tests cover default-empty configuration,
preserved drafts/CAS failures, owner visibility, receipt navigation, and child follow-up restrictions.
With the regular DevTools connection unavailable, isolated headless Chrome checked the synthetic UI at
1280px and 390px: loading policy, default-empty resource grants, selecting a resource, saving, receipt
rendering, and no horizontal overflow. No real bot settings were changed.

Cross-owner targets, recursive agents, automatic durable parent joins, target-private execution,
portable export of named delegation grants, and voice/screen-sharing demonstrations remain excluded.
