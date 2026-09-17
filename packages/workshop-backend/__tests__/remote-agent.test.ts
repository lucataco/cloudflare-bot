import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { RpcTarget, newWorkersWebSocketRpcResponse } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type { Context } from "@earendil-works/pi-ai";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";
import type { RemoteAgentRequest } from "@gadgets/workshop-shared/remote-agent";
import { invokeRemoteAgent, remoteAgentHandle, remoteAgentRequest, remoteAgentUrl } from "../src/remote-agent";
import { getModel } from "../src/ai-models";
import { zeroUsage } from "../src/ai-invoke";

// This synthetic external server deliberately returns invalid payloads; only the client is under test.
vi.mock("capnweb-validate", () => ({validateRpc: () => () => undefined}));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const config: AiModelConfig = {provider: "capnweb", model: "research", apiUrl: "https://agent.example.com/rpc", apiToken: "ENDPOINT_TOKEN"};
const context: Context = {systemPrompt: "Use sources", messages: [{role: "user", content: "Hello", timestamp: 0}]};

function serve(reply: (request: RemoteAgentRequest) => Promise<unknown>) {
  @validateRpc()
  class Endpoint extends RpcTarget {
    async run(request: RemoteAgentRequest): Promise<unknown> { return reply(request); }
  }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return newWorkersWebSocketRpcResponse(request, new Endpoint());
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("remote Cap'n Web agents", () => {
  it("performs a real Cap'n Web round trip", async () => {
    serve(async () => "Hello");
    await expect(invokeRemoteAgent(config, context, {})).resolves.toBe("Hello");
  });
  it("uses the configured token despite gateway routing and returns a text-only pi stream", async () => {
    const reply = vi.fn(async () => "Remote reply");
    const fetchMock = serve(reply);
    const handle = getModel({...env, CF_AI_GATEWAY: "platform"}, config,
      {type: "user", id: "owner", name: "Owner"}, {userGateway: {accountId: "private-account", apiKey: "GATEWAY_TOKEN"}});
    const events = [];
    const stream = handle.stream(handle.model, context);
    for await (const event of stream) events.push(event.type);
    expect(await stream.result()).toMatchObject({stopReason: "stop", content: [{type: "text", text: "Remote reply"}]});
    expect(events).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(reply).toHaveBeenCalledWith({version: 1, agentId: "research", systemPrompt: "Use sources", messages: [{role: "user", text: "Hello"}]});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(config.apiUrl);
    expect(init).toMatchObject({redirect: "manual", headers: {Authorization: "Bearer ENDPOINT_TOKEN", Upgrade: "websocket"}});
    expect(handle.aiGatewayLogRoute).toBeUndefined();
    expect(JSON.stringify(reply.mock.calls)).not.toContain("TOKEN");
  });
  it("omits tool definitions, arguments, reasoning, images and result details", () => {
    const request = remoteAgentRequest("research", {...context, tools: [{name: "PRIVATE_TOOL", description: "SECRET", parameters: {}}],
      messages: [{role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "test", usage: zeroUsage(), stopReason: "toolUse", timestamp: 0,
        content: [{type: "thinking", thinking: "PRIVATE_REASONING"}, {type: "toolCall", id: "id", name: "PRIVATE_TOOL", arguments: {secret: "PRIVATE_ARGUMENT"}}]},
      {role: "toolResult", toolCallId: "id", toolName: "PRIVATE_TOOL", isError: false, timestamp: 0,
        content: [{type: "text", text: "Visible result"}, {type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE"}], details: {secret: "PRIVATE_DETAILS"}}]});
    expect(JSON.stringify(request)).not.toContain("PRIVATE");
    expect(request.messages[1].text).toBe("Visible result\n[Media omitted]");
  });
  it.each(["http://agent.example.com", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://api.internal", "https://user:pass@agent.example.com", "https://agent.example.com/?token=secret"])("rejects invalid endpoints: %s", url => {
    expect(() => remoteAgentUrl(url)).toThrow();
  });
  it("rejects oversized input before connecting", async () => {
    const fetchMock = serve(async () => "Should not run");
    const handle = remoteAgentHandle(config);
    expect((await handle.stream(handle.model, {...context, systemPrompt: "x".repeat(262145)}).result()).stopReason).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["x".repeat(65537), {tools: [{name: "executeCode"}]}])("rejects oversized and non-text replies", async value => {
    const reply = vi.fn(async () => value);
    serve(reply);
    const handle = remoteAgentHandle(config);
    expect((await handle.stream(handle.model, context).result()).stopReason).toBe("error");
    expect(reply).toHaveBeenCalledOnce();
  });
  it("sanitizes transport errors and never retries them", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("PRIVATE_RESPONSE_BODY"));
    vi.stubGlobal("fetch", fetchMock);
    const handle = remoteAgentHandle(config);
    const result = await handle.stream(handle.model, context).result();
    expect(result.stopReason).toBe("error");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_RESPONSE_BODY");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects redirects without forwarding credentials", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {status: 302, headers: {Location: "https://elsewhere.example.com"}}));
    vi.stubGlobal("fetch", fetchMock);
    const handle = remoteAgentHandle(config);
    expect((await handle.stream(handle.model, context).result()).stopReason).toBe("error");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("cancels a running invocation", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    serve(async () => { entered.resolve(); return release.promise; });
    const controller = new AbortController();
    const handle = remoteAgentHandle(config);
    const result = handle.stream(handle.model, context, {signal: controller.signal}).result();
    await entered.promise;
    controller.abort();
    expect((await result).stopReason).toBe("aborted");
    release.resolve("Late reply");
  });
  it("enforces its deadline on a non-responding endpoint", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    serve(async () => { entered.resolve(); return release.promise; });
    const handle = remoteAgentHandle(config);
    const result = handle.stream(handle.model, context).result();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(60000);
    expect((await result).stopReason).toBe("error");
    release.resolve("Late reply");
  });
});
