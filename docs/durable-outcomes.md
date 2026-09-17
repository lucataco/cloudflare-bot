# Durable Outcomes

## Identity And Disposition

Each newly admitted executable prompt or callback batch has a workspace-owned task ID. The source
sequence points to the original conversation record; routine sources also retain the routine revision,
registration, schedule, occurrence ID, and intended firing time. Task records survive active-agent
cleanup and conversation compaction. Deleting a conversation deletes its task history, but not the
minimal routine occurrence receipts that prevent a delayed retry from recreating it.

Task identity is not execution identity. Explicit retries and authorized approval continuations advance
an attempt counter while keeping the original source. New prompts and independent callbacks create new
tasks. Approval continuations recheck the originating task and attempt after asynchronous preparation;
an old approval cannot restart a newer task. Human-only messages do not create phantom executions and
cannot let an old approval revive the preceding task. Built-in compaction does not change task status.

Execution dispositions are kernel observations, not interpretations of the assistant's prose:

- `finished`: the model stopped normally, or callbacks were explicitly resolved/rejected. This is not
  verified task success, and does not imply that all proposed writes were approved.
- `waiting`: execution stopped for a connection, proposal, human browser step, or action approval.
- `canceled`: explicit user stop or workspace pause. Already dispatched effects may still finish.
- `failed`: execution/provider error.
- `incomplete`: limits, unknown tools, giving up, stalled callbacks, unavailable models, or interrupted
  work without a recoverable execution result.

The disposition describes the most recent execution stop. Pending decisions are independently
canonical: accepting a creation proposal does not turn a stopped execution into success or restart it.
Use the receipt's state, not the historical waiting reason, to decide whether a proposal still needs
review. Existing untracked history stays untracked; no historical successes are synthesized.

## Evidence And Recovery

Completed model steps atomically store their transcript, code changes, task attribution, and terminal
disposition. Recovery retires already-stopped execution records without running inference again.
Cancellation removes durable restart intent before acknowledgment, and an older attempt's finalizer
cannot overwrite a newer attempt. The existing live-context ownership fence still protects cleanup.

Gatekeeper caller capabilities carry the originating execution identity. Late effects remain with that
task, even if another prompt is running. The approval latch cannot transfer to the replacement turn.
Durable action records whose model step failed are reconciled into evidence rather than disappearing
with an in-memory capture buffer. This does not make external writes exactly-once: applying an action
still crosses a gatekeeper boundary before its local applied receipt is stored.

`listTaskRuns()` returns at most 30 runs; `getTaskRunEvidence()` returns at most 50 attributed transcript
records. Output decisions are resolved against a separate sparse merge/revert history, not by scanning
unrelated prompt and tool bodies. Accepting a batch containing contributions from multiple tasks does
not assign all of those contributions to the task that happened to run last. Action/proposal states
are hydrated from their canonical records. Read-only observer capabilities cannot query task history.

Callback return promises and transient argument stubs do not survive eviction or a durable wait.
Unresolved callable-agent RPCs reject when execution stops; they never implicitly succeed with an
undefined result. After interruption, the run is incomplete rather than falsely treating an empty
in-memory callback map as proof of completion. Durable parent/child cancellation and named-bot
delegation are still Stage 5 work.

## Routine Admission

Each callback is sealed to an immutable registration token; scheduled registrations also retain the
actual scheduler schedule ID. Name/prompt edits preserve registration identity, while the current
routine revision fences each admission's asynchronous preparation. Replacement, disablement, and
workspace generation checks are revalidated immediately before commit.

Occurrence receipts key on routine, registration, schedule, and scheduler firing ID, not attempt time
or prompt text. Concurrent delivery and a lost acknowledgment return the original chat without another
agent start. Receipts record admission or skip, never AI completion. Slack/GitHub callbacks receive the
registration fence but do not gain a fabricated scheduler-style dedupe identity.

Legacy sealed callbacks without a registration token fail closed. Explicitly pause and re-enable their
routine to register a new callback. Registration itself is not an exactly-once cross-object operation;
the previous activation/publication safeguards and their documented recovery limits still apply.

## Verification

Tests exercise real workerd storage and RPC with synthetic model/provider boundaries: admission and
rollback, terminal-barrier recovery, cancellations, stale approvals/finalizers, callback disposition,
late action provenance, scheduler delivery retries, canonical evidence, paging, and observer denial.
UI checks cover lazy loading, errors, pagination, stale replies, keyboard access, and narrow layouts.

The current workerd test pool cannot persist native callback stubs or supply `ctx.restore()` for the
external-response restart fixture. Those specific delivery-reconciliation tests are explicitly skipped,
not claimed as verified. Live model quality, live browser execution, and exactly-once external effects
remain outside this verification. No real user task or automation was started during browser QA.
