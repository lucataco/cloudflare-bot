import { describe, expect, it } from "vitest";
import { processUnknownToolCalls } from "../src/agent.ts";
import type { TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";

describe("processUnknownToolCalls", () => {
  it("only unknown tool named pong returns text with pong, rewriteAsText true, stopFollowUp true", () => {
    let content: ToolCall[] = [
      {type: "toolCall", id: "call_1", name: "pong", arguments: {}},
    ];
    let knownToolNames = new Set(["readFile", "writeFile"]);

    let result = processUnknownToolCalls(content, knownToolNames);

    expect(result.rewriteAsText).toBe(true);
    expect(result.stopFollowUp).toBe(true);
    expect(result.content).toEqual([
      {type: "text", text: "pong"},
    ]);
  });

  it("only a known tool returns unchanged content, stopFollowUp false", () => {
    let content: ToolCall[] = [
      {type: "toolCall", id: "call_1", name: "readFile", arguments: {path: "/foo"}},
    ];
    let knownToolNames = new Set(["readFile", "writeFile"]);

    let result = processUnknownToolCalls(content, knownToolNames);

    expect(result.rewriteAsText).toBe(false);
    expect(result.stopFollowUp).toBe(false);
    expect(result.content).toBe(content);
  });

  it("mixed known and unknown returns content unchanged, stopFollowUp true", () => {
    let content: ToolCall[] = [
      {type: "toolCall", id: "call_1", name: "readFile", arguments: {path: "/foo"}},
      {type: "toolCall", id: "call_2", name: "pong", arguments: {}},
    ];
    let knownToolNames = new Set(["readFile", "writeFile"]);

    let result = processUnknownToolCalls(content, knownToolNames);

    expect(result.rewriteAsText).toBe(false);
    expect(result.stopFollowUp).toBe(true);
    expect(result.content).toBe(content);
  });

  it("no tool calls returns unchanged content, stopFollowUp false", () => {
    let content: TextContent[] = [
      {type: "text", text: "Hello world"},
    ];
    let knownToolNames = new Set(["readFile", "writeFile"]);

    let result = processUnknownToolCalls(content, knownToolNames);

    expect(result.rewriteAsText).toBe(false);
    expect(result.stopFollowUp).toBe(false);
    expect(result.content).toBe(content);
  });

  it("multiple unknown tools returns text with all names joined by newline", () => {
    let content: ToolCall[] = [
      {type: "toolCall", id: "call_1", name: "pong", arguments: {}},
      {type: "toolCall", id: "call_2", name: "invalidTool", arguments: {}},
    ];
    let knownToolNames = new Set(["readFile", "writeFile"]);

    let result = processUnknownToolCalls(content, knownToolNames);

    expect(result.rewriteAsText).toBe(true);
    expect(result.stopFollowUp).toBe(true);
    expect(result.content).toEqual([
      {type: "text", text: "pong\ninvalidTool"},
    ]);
  });

  it("unknown tool with existing text and thinking blocks preserves them", () => {
    let content: (TextContent | ThinkingContent | ToolCall)[] = [
      {type: "text", text: "Let me help"},
      {type: "thinking", thinking: "I should call pong", redacted: false},
      {type: "toolCall", id: "call_1", name: "pong", arguments: {}},
    ];
    let knownToolNames = new Set(["readFile", "writeFile"]);

    let result = processUnknownToolCalls(content, knownToolNames);

    expect(result.rewriteAsText).toBe(true);
    expect(result.stopFollowUp).toBe(true);
    expect(result.content).toEqual([
      {type: "text", text: "Let me help"},
      {type: "thinking", thinking: "I should call pong", redacted: false},
      {type: "text", text: "pong"},
    ]);
  });
});
