import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { runAgentLoopContinue } from "@earendil-works/pi-agent-core";
import { runAgent } from "../src/agent.js";
import { getModel } from "../src/ai-models.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";

vi.mock("@earendil-works/pi-agent-core", async importOriginal => ({
  ...await importOriginal<typeof import("@earendil-works/pi-agent-core")>(),
  runAgentLoopContinue: vi.fn(),
}));

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

afterEach(() => vi.restoreAllMocks());

describe("memory tool cancellation", () => {
  it("does not delete memory when aborted during the note lookup", async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName("memory-forget-pause"), async instance => {
      const impl = instance["impl"];
      const user: AiChatAuthorInfo = { type: "user", id: "test", name: "Test" };
      const author: AiChatAuthorInfo = { type: "agent", id: "model", name: "Model" };
      const modelConfig: AiModelConfig = { provider: "anthropic", model: "claude-sonnet-4-5", apiToken: "unused" };
      const handle = getModel(impl.env, modelConfig, user);
      const stream = vi.spyOn(handle, "stream").mockImplementation(() => { throw new Error("No provider calls allowed"); });
      impl.storage.chatContext.put({ chatId: 1, agentId: "bot" });
      vi.spyOn(impl, "prepareChatBindings").mockResolvedValue([]);
      vi.spyOn(impl, "getInstanceInstructions").mockResolvedValue("");
      vi.spyOn(impl, "getAgentSkills").mockResolvedValue([]);
      vi.spyOn(impl, "describeStandardFormats").mockResolvedValue("");
      vi.spyOn(impl, "listConnectableVendors").mockResolvedValue([]);
      const notes = Promise.withResolvers<{id: string; fact: string}[]>();
      const reading = Promise.withResolvers<void>();
      vi.spyOn(impl, "listAgentMemory").mockResolvedValueOnce([]).mockImplementationOnce(() => {
        reading.resolve();
        return notes.promise;
      });
      const remove = vi.spyOn(impl, "deleteAgentMemory").mockResolvedValue(undefined);
      const controller = new AbortController();
      vi.mocked(runAgentLoopContinue).mockImplementationOnce(async context => {
        // The actual production tool is built by runAgent. Substitute only the model loop so the
        // regression neither asks a provider to choose a tool nor sends any real model request.
        const forget = context.tools?.find(tool => tool.name === "memoryForget");
        expect(forget).toBeDefined();
        const forgetting = forget!.execute("forget", { id: "note" }, controller.signal);
        const rejected = expect(forgetting).rejects.toThrow("paused during lookup");
        await reading.promise;
        controller.abort(new Error("paused during lookup"));
        notes.resolve([{ id: "note", fact: "Keep this fact" }]);
        await rejected;
        return [];
      });
      await expect(runAgent(impl, handle, 1, author, [{ chatId: 1, sequence: 0,
        timestamp: new Date(0), author: user, type: "message", message: "Forget note" }],
      controller.signal, user, false, { modelConfig, measuredTokens: 0 }))
        .rejects.toThrow("paused during lookup");
      expect(remove).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
    });
  });
});
