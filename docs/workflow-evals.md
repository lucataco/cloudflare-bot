# Stage 1 Workflow Evals

These are **deterministic kernel workflow-contract evals**, not LLM quality benchmarks or
end-to-end workflow completion tests. They protect backend contracts needed by the three
workflow starters while keeping models, real accounts, and external services out of the run.

## Run

From the repository root, after installing dependencies with pnpm:

```sh
pnpm --filter @gadgets/workshop-backend exec node build-browser-runtime.mjs
pnpm --filter @gadgets/workshop-backend exec node scripts/build-format-blueprints.mjs
pnpm --filter @gadgets/workshop-backend exec vitest run --config vitest.config.ts __tests__/workflow-evals.test.ts
```

The suite is also discovered by the backend's regular unit-test configuration. It uses the
existing `TEST_OVERSEER` SQLite Durable Object binding and `runInDurableObject` in workerd.
`scripts/assert-workerd.ts` remains enabled: a Node fallback is not a valid passing run.
No deployment, credentials, provider subscription, or real user data is required. Global
`fetch` is rejected during each test; the successful contracts also assert zero HTTP calls.
There is no live-provider mode or production-data runner.

## Fixtures

The three synthetic fixtures live with the tests in
`packages/workshop-backend/__tests__/workflow-evals.test.ts`. Their keys are checked against
the stable IDs exported by `@gadgets/workshop-shared/workflow-starters`. Each run records the
shared starter prompt in its chat, but does **not** interpret that prompt with a model.

| Stable ID | Selected evidence | Scripted artifact | Separate write proposal |
| --- | --- | --- | --- |
| `meeting-brief` | Fictional review date and two prototype notes | Linked facts, suggested agenda, open decision, missing attendees | Send the brief |
| `feedback-summary` | Two fictional feedback IDs with request, bug, and positive feedback | Evidence, illustrative summary table, deduplication convention, coverage caveat | Create an investigation ticket |
| `project-update` | Fictional completed/current/blocked work and a contingent plan | Linked status, planned-vs-completed wording, suggested next steps, missing owner | Post the update |

All identities and URLs use reserved `.invalid` domains. Source bytes are seeded in the real
chat-attachment collection with the production storage schema. A tiny synthetic source adapter
uses `getChatAttachmentData` for chat-scoped retrieval, then calls `authorizeObservation`
before releasing text to the scripted consumer. This is the production method behind
`ApprovalQueueImpl.authorizeObservation`, **not** a claim that normal attachment reads are
automatically audited this way. Gatekeeper IDs stand in for source/write providers; no
gatekeeper facet, OAuth flow, or provider resource is instantiated.

The script quotes the returned source text into `document.md`, adds a fixed outline, creates a
provisional document gadget, and calls the real `commitAgentStep`. It does not implement or
score summarization. The feedback counts and outlines are authored examples, not evidence of
model counting accuracy. The document is a stored Markdown artifact, not a rendered document
blueprint or a tested gadget UI.

## Coverage

The assertions inspect effects produced by real methods, not just fixture equality or prompt
snapshots:

- `authorizeObservation` creates approved observation records with source descriptions, caller
  chat IDs and gatekeeper IDs. `consumeCapturedActions` associates those IDs with chat evidence.
- `commitAgentStep` persists the transcript, creation declaration, change stream watermark and
  pending gadget stamp. Draft content is reconstructed through `getCurrentChatContent`.
- Reconstructed files contain independently asserted evidence fragments and source URLs, retain
  missing-information wording, and exclude the foreign-profile sentinel. The structured
  `createdGadgets` declaration carries the result's ID, title and binding name for the frontend
  result card. These check persistence, not factual entailment or link/card rendering.
- A provisional document has no committed head and is absent from `outputsSnapshot`. Another
  chat/profile cannot discover, resolve, or submit changes to it.
- Explicit `mergeChanges` produces a real git commit whose files retain the draft, clears the
  pending marker, marks the changes merged, and exposes the document in the output snapshot.
- A separate user follow-up proposes an external write via `submitAction`. It is manual-only,
  sets `awaitDecision`, and stays pending through real auto-approval drains and document acceptance.
  The real apply method is spied on, not replaced, and must never be called. No auto-approval
  rule or hook/schedule is enabled. Document acceptance is not external-write approval.
- The existing fake-overseer helper obtains the production use-only capability; it rejects
  attempts to accept changes or approve writes. It does not simulate a browser or authentication.

## Negative Cases

- **Unavailable selected source:** the second source is removed. The first successful read stays
  audited, the second retrieval rejects, and no document, changes batch or completion message is
  produced. An empty `mergeChanges` can return `merged` by design, so the suite never treats that
  return value alone as workflow success; an actual artifact is required.
- **Foreign chat source:** a committed attachment belonging to a different chat is rejected by
  the real content accessor before a successful observation can be recorded.
- **Unauthorized observation:** the real sharing graph authorizes a collaborator profile, but the
  source excludes its observer ID. Authorization rejects, with no audit success, ID allocation,
  output or changes batch. An owner-only source in that shared workspace also rejects.
- **Cross-workspace leakage:** two distinct DOs reuse chat, attachment and gadget IDs. The second
  cannot resolve the first's source or draft, starts without its profile context or audit records,
  and reconstructs only its own evidence after seeding.
- **Restricted collaborator:** a use-only capability cannot merge documents or approve actions.

Agent profiles are not separate security principals inside one workspace. The tested isolation
is per-chat provisional content and per-workspace storage, plus collaborator-profile observation
policy. Once accepted, an output is intentionally visible to other chats in its workspace.

## Limitations

The existing unit/model tests do not provide a reusable full scripted `runAgent` harness spanning
provider streaming, WorkerLoader execution, bindings and output blueprints. Rather than add
production hooks or mock the kernel's behavior, this suite directly exercises existing Overseer
methods. The only fake-overseer use is the restricted-capability denial check.

This suite does **not** evaluate clarification questions, prompt adherence, source selection by an
LLM, hallucinations, deduplication/counting correctness, date filtering, citation entailment,
summary usefulness, resistance to prompt injection, model/provider compatibility, token costs,
latency, retries/resumption, or the model's response to a missing source. In the unavailable case,
the script stops on rejection; it does not prove a model would stop or explain the gap correctly.

It also does not cover agent `defaultBindings` enforcement, account ownership/OAuth, provider
permissions, connected-source discovery, real gatekeeper observation discipline, manual approval
delivery to an external system, frontend review/export behavior, or the owner's denormalized
Outputs index fan-out. It tests the workspace output snapshot, not that downstream index.
The source adapter's read-then-authorize discipline and the fixed document prose are test inputs,
not production behavior being proven. No model-quality percentage should be reported from these
results. A future quality evaluation needs an explicit opt-in runner, synthetic sources, actual
model/tool execution, and an independent rubric; it must never silently use connected user data.
