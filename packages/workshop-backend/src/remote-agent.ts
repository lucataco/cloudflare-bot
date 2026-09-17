import { RpcSession, WebSocketTransport } from "capnweb";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";
import type { RemoteAgentEndpoint, RemoteAgentRequest } from "@gadgets/workshop-shared/remote-agent";
import type { ModelHandle, ModelStreamOptions } from "./ai-models";
import { zeroUsage } from "./ai-invoke";

/** Explicit public HTTPS endpoint; credentials belong in the token field, never the URL. */
export function remoteAgentUrl(input: string | undefined): URL {
  if ((input?.length ?? 0) > 2048) throw new Error("Remote-agent endpoint exceeds 2048 characters.");
  let url: URL;
  try { url = new URL(input ?? ""); } catch { throw new Error("Enter a public HTTPS remote-agent endpoint."); }
  const host = url.hostname.replace(/\.$/, "");
  // The backend's global_fetch_strictly_public flag enforces public IPs after DNS resolution.
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("metadata.") ||
      /\.(localhost|local|internal|invalid)$/.test(host)) {
    throw new Error("Enter a public HTTPS remote-agent endpoint without URL credentials, query or fragment.");
  }
  return url;
}

/** Construct fresh plain data rather than forwarding pi objects, reasoning or callable values. */
export function remoteAgentRequest(agentId: string, context: Context): RemoteAgentRequest {
  const request: RemoteAgentRequest = {version: 1, agentId, systemPrompt: context.systemPrompt ?? "",
    messages: context.messages.map(message => ({role: message.role,
      text: typeof message.content === "string" ? message.content : message.content
        .flatMap(part => part.type === "text" ? [part.text] : part.type === "image" ? ["[Media omitted]"] : []).join("\n")}))};
  if (request.messages.length > 256 || new TextEncoder().encode(JSON.stringify(request)).byteLength > 256 * 1024) {
    throw new Error("Remote-agent conversation exceeds its limit. Compact the chat or start a new one.");
  }
  return request;
}

/** One bounded RPC invocation. Errors are untrusted; the model adapter sanitizes them. */
export async function invokeRemoteAgent(config: AiModelConfig, context: Context, options: ModelStreamOptions): Promise<string> {
  const request = remoteAgentRequest(config.model, context);
  const url = remoteAgentUrl(config.apiUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let socket: WebSocket | undefined;
  const stopped = Promise.withResolvers<never>();
  // Always observed, including a cancellation during the initial HTTP upgrade.
  void stopped.promise.catch(() => {});
  const stop = () => {
    socket?.close(1000, "Invocation ended");
    stopped.reject(new Error("Remote-agent invocation ended."));
  };
  signal.addEventListener("abort", stop, {once: true});
  try {
    signal.throwIfAborted();
    const response = await fetch(url, {headers: {Upgrade: "websocket",
      ...(config.apiToken ? {Authorization: `Bearer ${config.apiToken}`} : {})}, redirect: "manual", signal});
    socket = response.webSocket ?? undefined;
    if (response.status !== 101 || !socket) {
      void response.body?.cancel().catch(() => {});
      throw new Error("Remote-agent endpoint did not accept a WebSocket connection.");
    }
    socket.accept();
    signal.throwIfAborted();
    const transport = new WebSocketTransport(socket);
    let received = 0;
    let messages = 0;
    using remote = new RpcSession<RemoteAgentEndpoint>({
      send: message => transport.send(message),
      receive: async () => {
        const message = await transport.receive();
        received += new TextEncoder().encode(message).byteLength;
        if (received > 512 * 1024 || ++messages > 128) throw new Error("Remote-agent response exceeds its limit.");
        return message;
      },
      abort: reason => transport.abort(reason),
    }, undefined, {limits: {maxMessageSize: 256 * 1024, maxDepth: 32, maxBigIntDigits: 100}}).getRemoteMain();
    using result = remote.run(request);
    const text = await Promise.race([result, stopped.promise]);
    if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > 64 * 1024) {
      throw new Error("Remote-agent reply must be text of at most 64 KiB.");
    }
    return text;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    socket?.close(1000, "Invocation ended");
  }
}

/** Adapt remote replies to pi's stream contract. External errors never echo bodies or credentials. */
export function remoteAgentHandle(config: AiModelConfig): ModelHandle {
  const handle: ModelHandle = {
    model: {id: config.model, name: config.model, api: "capnweb", provider: "capnweb", baseUrl: remoteAgentUrl(config.apiUrl).href,
      reasoning: false, input: ["text"], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
      contextWindow: 32000, maxTokens: 4096},
    stream(model, context, options = {}) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {role: "assistant", content: [], api: model.api, provider: model.provider,
        model: model.id, usage: zeroUsage(), stopReason: "pending", timestamp: Date.now()};
      stream.push({type: "start", partial: message});
      void (async () => {
        try {
          const text = await invokeRemoteAgent(config, context, options);
          message.content = [{type: "text", text}];
          message.stopReason = "stop";
          stream.push({type: "text_start", contentIndex: 0, partial: message});
          stream.push({type: "text_delta", contentIndex: 0, delta: text, partial: message});
          stream.push({type: "text_end", contentIndex: 0, content: text, partial: message});
          stream.push({type: "done", reason: "stop", message});
        } catch {
          message.stopReason = options.signal?.aborted ? "aborted" : "error";
          message.errorMessage = options.signal?.aborted ? "Remote-agent request canceled." :
            "Remote-agent request failed. Check the endpoint, token, conversation size and 60-second deadline.";
          stream.push({type: "error", reason: message.stopReason, error: message});
        }
      })();
      return stream;
    },
  };
  return handle;
}
