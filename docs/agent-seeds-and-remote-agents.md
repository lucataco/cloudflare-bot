# Declarative bots and external agents

## Seed from agents.yaml

Edit the root [`agents.yaml`](../agents.yaml), then open **Create bot → Import agents.yaml**.
The authenticated RPC equivalent is `api.seedAgents(yamlText)`.
This explicit import seeds the signed-in owner's roster; a deployment does not silently change all users.

The document has `version: 1` and up to 32 `agents`, within 64 KiB. Each entry has:

- `key`: permanent per-owner seed identity (lowercase letters, digits, `.`, `_`, `-`; 100 characters).
- `name`, `title`, `description`: the bot's name, job and standing instructions.
- Optional `modelId`: an existing ID in **Providers**; omitted/null leaves model selection automatic.
- Optional portable Blueprint `avatar`, `skills`, `routines`, and `pluginIds`.

All new entries and their receipts commit in one transaction. Existing keys are skipped, including
after a bot is edited, hidden or deleted. Changing a key creates another bot. The result reports
`created` profiles and `skipped` keys. An invalid definition or unavailable model rolls back the import.
Repeated and concurrent imports are safe. YAML aliases, duplicate keys and custom tags are rejected.

Seeds include no accounts, resource bindings, history or memory. Connector IDs are suggestions;
connections still require normal configuration. Imported routines start **paused**, without hooks.
Model tokens belong in Providers, never in this file.

## Remote agent backend

In **Providers → Add AI Model**, choose **Remote agent (Cap’n Web)**. Supply a unique agent/model ID,
display name, public HTTPS WebSocket-upgrade endpoint, and optional bearer token. Select that model
in a bot's Advanced settings, or reference its ID from `agents.yaml`.

The adapter opens one Cap’n Web WebSocket session per invocation and calls
`RemoteAgentEndpoint.run(request)` from `@gadgets/workshop-shared/remote-agent`:

```ts
type Request = {
  version: 1;
  agentId: string;
  systemPrompt: string;
  messages: { role: "user" | "assistant" | "toolResult"; text: string }[];
};
// run(request: Request): Promise<string>
```

Implement this interface on an `RpcTarget`, annotated with `@validateRpc()`, and serve it using
Cap’n Web's `newWorkersWebSocketRpcResponse` (or the equivalent WebSocket server in your runtime).
Authenticate the upgrade's `Authorization: Bearer …` header before exposing the target.
The endpoint can wrap an independently hosted agent, including one backed by AG-UI internally.

The request contains only instructions and conversation text, including previous tool-result text.
It omits private reasoning, tool arguments, binary media and tool definitions. No Workshop RPC stubs
are sent, and replies are always treated as text. Remote execution does not gain local tool access.
Remote agents manage their own external resources and billing.

Requests are limited to 256 messages / 256 KiB serialized UTF-8. Replies are at most 64 KiB UTF-8;
the session accepts at most 128 protocol messages / 512 KiB, with bounded decoder depth. A 60-second
deadline and caller cancellation close the session. Redirects and URL-embedded credentials are
rejected. There is no automatic transport retry. The remote endpoint may have continued work after
disconnect; a reply alone is not evidence that its external effects completed.

These models use their own endpoint and token even when AI Gateway is configured. Workshop-wide
usage admission still applies; remote usage/cost is not reported by this text-only protocol.

## Audit before tool execution

**Every model tool-call batch must have durable audit evidence before any tool in it executes.**
The agent loop awaits `auditToolCalls()` at pi's `message_end` boundary. The Overseer records an
append-only `toolCallAudits` row in its existing Durable Object storage and awaits `storage.sync()`.
A failed write/flush stops the batch. This applies to read tools, mutations, browser/computer tools,
proposals, spawners and named/group delegates. Unknown or invalid calls may also have audit entries,
because validation and dispatch occur after the barrier. Duplicate IDs or oversized metadata stop
the whole batch before dispatch.

Each row records a unique batch ID, chat/model/bot identity, task-run ID/attempt when available,
timestamp, and each call's ID and tool name. Arguments, outputs, prompts and credentials are excluded.
The journal is internal workspace storage, retained independently of transcript edits and step
rollback; it is not a new public RPC capability or an external log sink.

An entry proves **admission**, not execution or success. Cancellation or a crash can happen after
admission; inspect committed transcript tool results and existing gatekeeper action/observation
receipts for outcomes. A resumed attempt gets a new batch entry and never dispatches by replaying the
journal. Existing approval and step-commit barriers remain authoritative for effects and delegation.
Remote-agent replies are text, so the Workshop cannot audit tools executed inside a remote service.
