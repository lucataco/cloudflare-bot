# Delegation Roadmap

The user pilot is deliberately excluded. This roadmap is delivered in dependency order, with
backend/shared security changes reviewed separately from the UI. The first stage does not claim
that the later stages are implemented.

## Stage 1: Workflows and Safety Foundations

This changeset provides:

- Three editable starting points: meeting briefs, customer-feedback summaries, and weekly project
  updates. Selecting one seeds a message; it does not send, connect an account, or enable a routine.
- Synthetic kernel workflow-contract evaluations. See [workflow-evals.md](workflow-evals.md) for
  the exact coverage and the distinction from full model-quality or end-to-end evaluations.
- Owner-controlled browser access, disabled by default. Human control excludes agent access.
  Agent control is an explicit, coarse grant covering browser reads and writes, including signed-in
  websites. It is **not** a per-action or per-origin approval system. Sensitive workspaces cannot
  grant agent browser control. Existing connector approval rules are unchanged.
- A durable workspace automation pause, exposed in bot/workspace controls. Pause prevents new
  automation admission and cancels active turns. Resume preserves explicit per-chat queue pauses;
  canceled turns are not replayed. Scheduled occurrences during pause are skipped, not accumulated.
- Fences for stale asynchronous work, queued prompt admission, human takeover continuation, and
  routine activation/pause races. A queued prompt remains durable during preparation and is removed
  with its committed message rather than before asynchronous work starts.

Already-dispatched external calls and admitted code may finish. Pause is not rollback or a hard
sandbox shutdown. Disabling browser access closes its running resource but does not erase saved
cookies or revoke sessions at external websites. In-memory cleanup is not a durable reconciliation
service for every possible process failure.

## Stage 2: Conversational Proposals

Implemented as creation-only proposals in a bot's owned dedicated workspace:

- `proposeRoutine` and `proposeSkill` stage inert drafts with the assistant's step. They create no
  routine, skill, hook, or permission until the owner confirms the persisted card.
- The owner reviews the exact task/schedule or reusable instructions. Accept/deny decisions are
  durable; accepting across objects can be retried with the same ID. Receipt tombstones prevent
  retries from overwriting later edits or recreating deleted artifacts.
- Routine acceptance saves an ordinary **paused** routine. Activation remains a separate explicit
  action in Routines; proposal acceptance never calls the registration/enablement path. Skills
  become ordinary per-bot reusable instructions for future turns, not immediate execution.
- Pending and accepting proposals stay outside compaction checkpoints. Replay reports canonical
  dispositions without repeating writes. Decisions do not restart the proposing turn; new user
  messages and independently authorized callbacks remain separate work.
- Shared collaborators and group/spawner contexts cannot use this flow to change an owner's bot.
  Existing browser grants, connection scope, automatic-approval rules, and workspace pause remain
  unchanged. In-flight authorized creation can finish after chat deletion, but cannot recreate it.

To revise a pending draft, deny it and ask for a new proposal. To edit a saved item, use the existing
Routines or Skills controls. Each routine run starts a new conversation; proposal acceptance does
not transfer attachments or chat-only connections. These receipts record creation, not current
activation or task success. See [conversational-proposals.md](conversational-proposals.md).

## Stage 3: Durable Outcomes

Implemented for newly admitted work:

- Logical task IDs link prompts, queue admissions, routine occurrences, and existing capability-scoped
  callbacks/spawns to their conversation and committed evidence. Authorized continuations and retries
  retain the source ID while incrementing an execution attempt. Human-only messages and historical
  untracked work do not acquire invented execution outcomes. `/compact` is maintenance, not a new task.
- Execution records distinguish finished, waiting, canceled, failed, and incomplete. Stop reasons
  commit with the final model step; restart does not replay a committed stop. An idle agent, accepted
  output, or delivered callback is never labeled verified task success.
- Scheduler callbacks retain their sealed registration and stable firing identity. A receipt commits
  atomically with chat/task admission, survives chat deletion, and prevents retry duplication. An
  occurrence observed during workspace pause remains skipped after resume. Old registrations cannot
  borrow the current hook's authority. Legacy routine callbacks need explicit re-registration.
- Task history in the conversation loads on demand, with pagination, retry, source metadata, explicit
  execution dispositions, and canonical output/action/proposal decisions. Evidence remains available
  across compaction; errors and late effects keep their original task attribution.

There is no new delegation authority in Stage 3. Legacy group handling executes the first eligible member; it does not
reopen a completed or waiting task for another member. Raw mentions do not start another execution:
an explicit actionable handoff belongs to Stage 5. Unresolved callable-agent RPCs reject when execution
stops rather than implicitly returning success; their transient return capabilities are not durable.
See [durable-outcomes.md](durable-outcomes.md) for guarantees and verification boundaries.

## Stage 4: Attention and Notifications

Implemented with an owner-only Attention inbox and optional Browser Push:

- Canonical task outcomes, requests, proposals, actions, and output decisions project through durable,
  versioned snapshot delivery. Bootstrap and retries continue independently of browser sessions.
- The bounded recent inbox has pagination, retention/catching-up notices, and exact-version seen
  acknowledgments. Seen, source resolution, and transport acceptance remain independent.
- Browser Push requires explicit device consent and deployment VAPID configuration. The existing
  per-bot preference filters delivery without hiding inbox records. Delayed pre-consent events do not
  become new notifications.
- Encrypted payloads contain only a generic attention marker. Source/privacy checks, bounded retries,
  device revocation, persistent local logout suppression, and fixed same-origin notification navigation
  preserve the permission boundary. No private task content is sent to the lock screen.

The transport is implemented and cryptographically tested, but live background delivery requires a
configured deployment and consenting device. See [attention-notifications.md](attention-notifications.md)
for setup, retention limits, and verification boundaries. This is not browser-toasts-only delivery.

## Stage 5: Scoped Named-Bot Delegation

Implemented for owner-configured, same-owner targets:

- Delegation settings belong to the source bot's dedicated workspace and default to no targets or
  resources. Saves use a local revision fence; names, group membership, and raw mentions grant nothing.
- `delegateToBot` stages an isolated child; its receipt, source, run, and restart intent commit with the
  parent's tool evidence. Exact request-key retries reuse the child, including after deletion.
- Children use the target's snapshotted instructions and selected model, but run in the source
  workspace with only explicitly selected external resources. No target history, memory, skills,
  browser, account bindings, ambient catalogs, or callback/restore authority is imported.
- Named delegation is one level deep, with four lifetime children per logical parent. Parent stop,
  child stop, conversation deletion, and workspace pause have distinct durable cancellation scopes.
  Later resource operations are fenced; already dispatched effects are not rolled back.
- Read-only receipts and task history link parents and children. `getDelegationResult` provides a
  bounded current result without automatically resuming the parent or treating execution as success.

Automatic durable parent joins, recursive delegation, cross-owner execution, and target-private
workspace access remain excluded. Legacy configured spawners retain their existing behavior. See
[scoped-delegation.md](scoped-delegation.md) for configuration and exact guarantees.

Voice huddles, screen sharing, and nested-bot demonstrations remain outside this sequence until
the underlying delegation and completion semantics are reliable.

## Tier 3: Isolated Computers and Concurrent Groups

Implemented on top of these foundations: an optional Sandbox SDK computer service with durable R2
workspace checkpoints, explicitly enabled shell/files access, concurrent group authors and bounded
group handoffs through the existing delegation barrier, and six-file messages with Office extraction
and native Gemini audio/video inputs. Existing groups opt in to concurrent authors; new groups use it
by default. Browser-workflow recording remains deferred until computer rollout.

See [Tier 3 setup, semantics, limits and checks](tier-3-computers-groups-attachments.md).
