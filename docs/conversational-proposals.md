# Conversational Proposals

In an owned bot conversation, ask for a recurring task or reusable instructions. Examples:

- "Propose a routine to draft a project update every weekday at 9 AM in America/Los_Angeles."
- "Propose reusable instructions for future meeting briefs: start with decisions, then open questions."

The bot can ask for missing details, then call `proposeRoutine` or `proposeSkill`. A proposal is a
draft, not a saved artifact or a permission grant. Its card appears outside collapsed activity.

## Review and Save

The workspace owner opens Review to inspect the exact suggested fields. Long content can be
scrolled with the keyboard. Routine summaries show the schedule and timezone; raw schedule fields
are available under Technical schedule details.

- **Save paused routine** creates the ordinary routine with no hook or active schedule. Open Manage
  routines to inspect its current configuration and explicitly enable it later.
- **Save reusable instructions** creates an ordinary per-bot skill for future turns. It does not
  rewrite the bot profile, execute the instructions, or change any resource permissions.
- **Deny** records a rejection without creating anything. Canceling the review dialog does not
  decide the proposal. To change the draft, deny it and ask the bot for a revised proposal.

Routine tasks must be standalone. Future runs do not automatically inherit conversation history,
attachments, or connections that existed only in the proposing chat. Saving does not resume the
bot, clear workspace pause, or grant connection, browser, or automatic-approval authority.

## Durability and Recovery

The assistant's tool-call record and staged proposal commit through the existing chat step barrier.
IDs and target bot identity are assigned by the server. The model and browser cannot supply a
different owner, target, artifact ID, or replacement draft to the decision RPC.

The canonical decision state is:

```text
pending -> accepting -> accepted
pending -> denied
```

Acceptance is persisted before cross-object creation. The User Durable Object atomically inserts
the normal routine/skill record and a compact creation receipt keyed by the workspace/proposal.
The receipt checks a canonical hash of the original draft. Retrying the same acceptance returns
the original creation identity and time; it never overwrites subsequent edits or resurrects a
deleted artifact. The first recorded decision wins over an opposing decision.

If saving cannot be confirmed, the card offers **Finish saving**. This retries the same acceptance,
not a new create. A proposal whose acceptance is already recorded cannot then be denied. A receipt
can report that an artifact was removed before recovery. Receipts are historical, not live status.

Pending and accepting proposals protect their raising turn from compaction. Replayed decisions
never repeat artifact creation. Acceptance and denial do not resume the old agent turn, including
after restart; a later user message or independently authorized callback can start new work.

Deleting a conversation does not revoke an acceptance already in flight. The artifact may finish
being created, but the completion cannot recreate the deleted conversation. Saved artifacts remain
manageable independently through the existing bot UI.

## Scope and Checks

This release supports creation, not edits or automatic routine activation. Retry safety applies to
proposal acceptance; it does not add a general restart-safe activation/reconciliation service to
the existing routine registration API. Shared collaborators cannot decide proposals, and group or
spawned-agent chats cannot target a member's private bot configuration.

Backend integration tests use real User and Overseer Durable Objects to cover inert preparation,
step rollback, authorization, racing decisions, lost responses, restart recovery, later edits and
deletion, and absence of hooks after saving a routine. Agent tests use scripted model streams to
cover staging, replay, callback independence, and compaction. Frontend tests cover exact review,
keyboard access, owner-only controls, receipt recovery, and stale-response isolation. These are
deterministic regressions, not a measurement of natural-language model quality.

```sh
pnpm --filter @gadgets/workshop-backend test:run
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @gadgets/workshop-frontend test:run
```
