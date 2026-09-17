# Tier 3: computers, group authors and attachments

## Computer: browser, shell and durable files

The Computer view has **Browser** and **Shell & files** tabs. The browser keeps the existing
owner/human/agent control model. Shell/files are a **separate explicit grant**, disabled by default;
an existing browser grant does not silently acquire terminal authority. The agent's
`computerWorkspace` tool and the owner's terminal/file editor use the same checked computer session.

The optional `services/computer-runtime` Worker uses `@cloudflare/sandbox` and its matching image,
version **0.12.9**. It has no public HTTP shell endpoint. The backend alone supplies a bot-specific
controller key and a live authorization callback. Groups/delegates do not inherit members' private
computers. No Workshop credentials or connected-account capabilities are injected into containers.

### Durability and execution semantics

- A bot's controller serializes operations and owns its checkpoint pointer. Each operation gets a
  fresh private Sandbox incarnation; this avoids stale SDK session state and hidden background work.
- Before an operation, the last `/workspace` archive is restored from the controller's R2 namespace.
- After a mutation, a new archive is streamed to R2 and the durable pointer is advanced. Old archives
  are removed after the new checkpoint is committed. No bucket credentials enter the container.
- Command results are returned after checkpointing, including nonzero shell exit results. An
  infrastructure failure leaves the outcome unconfirmed; it never automatically repeats the command.
- Files under `/workspace` survive container destruction and controller restart. Shell variables,
  working-directory changes, processes and files elsewhere in the container do not.
- Public internet access is disabled. Use explicitly introduced gatekeepers for external services.
  Browser and terminal runtimes are separate resources; browser downloads are not implicitly synced.
- Commands have a 30-second execution deadline and bounded stdout/stderr. File API operations are
  limited to 4 MiB per file, directory listings to 1,000 entries, and checkpoints to 64 MiB.

Disabling shell/files interrupts the active container and fences subsequent operations. As with
other computer operations, an already-dispatched operation may have effects before revocation.

### Deploy the optional runtime

This container service is intentionally separate from the ordinary Worker release manifest. The
current customer release uploader does not build/publish container images. Deploy one runtime per
Workshop trust domain using Docker and a Cloudflare account with Containers enabled:

```sh
pnpm install
pnpm --filter @gadgets/computer-runtime deploy
```

Provision the configured `workshop-computer-workspaces` R2 bucket if your deployment tooling has not
already created it. In the deployed backend's bindings (or your deployment override), add:

```json
{
  "binding": "COMPUTER_RUNTIME",
  "service": "workshop-computer-runtime",
  "entrypoint": "ComputerRuntime"
}
```

Choose the service/bucket names appropriate for that instance. The backend runs without this binding;
the Shell & files tab then reports that the runtime is unavailable. With it bound, take human control
and enable shell/files for the bot. Allowing bot control subsequently lets that bot use the grant.

For local verification:

```sh
pnpm --filter @gadgets/computer-runtime test:run
pnpm --filter @gadgets/computer-runtime test:smoke
```

The first command tests the bounded Python helper and the controller's authorization/checkpoint
protocol over real workerd/R2 with an SDK substitute. The Docker-backed smoke test launches Wrangler,
executes a real shell command, destroys the container, restores its file through R2, and verifies
that a different bot sees an empty workspace. Its fixed synthetic test entrypoint is not the
production entrypoint. Docker can be selected with `DOCKER_HOST` without changing the default context.

## Concurrent group authors

New groups enable concurrent authors by default and contain **one to six distinct bots owned by
the creator**. Existing groups can opt in through **Edit Group → Concurrent group authors and
teammate handoffs**. The old recipient selector is hidden in concurrent groups.

- An unaddressed message or `@everyone` addresses the group. `@Name` or `@bot-id` selects matching
  members. Each addressed member uses its own configured model, falling back to the message's model
  when its profile uses Automatic. Explicit No AI responses remains human-only messaging.
- Each author has an independent child conversation, execution record, model context and stream.
  The shared timeline receives committed assistant steps under each bot's identity. `activeAuthors`
  exposes concurrent presence without mixing incompatible model/tool-call streams.
- Authors receive bounded shared conversation text, the original group attachments, their own
  snapshotted instructions, and explicitly shared group connections. Private member histories,
  memory, skills, browser sessions and account bindings are not copied.
- `delegateToBot` becomes an asynchronous teammate handoff within this context. It reuses Stage 5's
  preparation/commit barrier and exact retry identity. A raw bot-authored mention is just text.
  New handoffs remain inside the frozen peer/resource scope and are admitted only with tool evidence.
- One group prompt can admit at most **12 executions**, including initial authors and handoffs.
  Existing per-step limits still apply. A new user prompt creates a new round; old rounds cannot
  inject new handoffs into it. Admission/model failures remain inspectable on child receipts.
- Stopping a round cancels its authors and handoffs. Workspace pause and conversation deletion reuse
  the existing broader cancellation mechanisms. Group retry is a new group message, not a rerun of
  the first available model against the shared assistant tail.

Messages appear as each assistant step commits. Token streaming stays with the child conversation;
the group does not claim to merge several providers' partially emitted tool calls. A finished group
execution is not proof that the requested real-world task succeeded.

## Rich attachments

The composer and server enforce **six attachments per message**, with a 4 MiB per-file and 12 MiB
aggregate upload limit. Images retain their existing resize path and 1 MiB inlined-image limit.
Concurrent groups additionally cap model-facing attachment bytes at 2 MiB after Office extraction
to bound memory while several models prepare requests simultaneously.

| Type | Model handling |
| --- | --- |
| Text and images | Existing supported provider paths. |
| PDF | Native document input for Anthropic, OpenAI Responses and Gemini; Workers AI/Ollama remain unsupported. |
| DOCX | Bounded paragraph/text extraction. |
| XLSX | Shared strings and cached cell values; formulas are never executed. |
| PPTX | Text extracted in numeric slide order. |
| MP3, WAV, M4A, OGG, WebM audio; MP4/WebM video | Native Gemini media input. Other current adapters reject new media uploads rather than pretending to understand them. |

Original Office files and larger files are stored privately in R2; messages contain canonical
handles and metadata. Authenticated downloads return the original bytes. Model replay gets extracted
Office text or supported native media parts. Switching a conversation to an incompatible model
produces an explicit omitted-file marker, matching the existing PDF fallback behavior.

Office parsing has bounded compressed input, incremental inflation, per-part/aggregate expansion
limits, XML depth/node limits, and a bounded text result. DTDs are rejected; macros, formulas,
embedded programs and external links are not executed. Formatting and embedded Office media are not
recreated. Browser MIME aliases and known file extensions are normalized before signature checks.

## Teach a task

**Deferred as requested.** The computer and authorization/checkpoint model now provide a foundation,
but recording browser workflows into skills needs a separate design for selectors, secrets,
redaction and human review after computer rollout. No input recorder has been silently enabled.
