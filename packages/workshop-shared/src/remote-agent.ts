/** Versioned, text-only input to an external agent. No Workshop capabilities are exported. */
export type RemoteAgentRequest = {
  /** Wire contract version. */
  version: 1;
  /** Provider-configured agent identifier. */
  agentId: string;
  /** Standing instructions for this invocation. */
  systemPrompt: string;
  /** Bounded conversation text; private reasoning, tool arguments and binary media are omitted. */
  messages: {role: "user" | "assistant" | "toolResult"; text: string}[];
};

/** Cap'n Web WebSocket endpoint implemented by an external agent's RpcTarget. */
export interface RemoteAgentEndpoint {
  /** Return a plain-text reply, at most 64 KiB UTF-8. This method conveys no local tool authority. */
  run(request: RemoteAgentRequest): Promise<string>;
}
