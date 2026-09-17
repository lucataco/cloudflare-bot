import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub } from "capnweb";
import { keyString } from "@gadgets/typed-storage";
import { runAgentLoopContinue } from "@earendil-works/pi-agent-core";
import { validateToolCall, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentProfile, AiChatAuthorInfo, GatekeeperVendorInfo, Group, TaskRunDisposition } from "@gadgets/workshop-shared/api";
import * as agent from "../src/agent.js";
import { zeroUsage } from "../src/ai-invoke.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserAiModelRecord, UserChatContext } from "../src/user.js";
import { putAction } from "./fixtures.js";

vi.mock("@earendil-works/pi-agent-core", async importOriginal => ({
  ...await importOriginal<typeof import("@earendil-works/pi-agent-core")>(),
  runAgentLoopContinue: vi.fn(),
}));

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    }
  }
}

type Impl = OverseerDurableObject["impl"];
const OWNER = "group-owner";
const USER: AiChatAuthorInfo = { type: "user", id: "owner", name: "Owner" };
const MODEL: UserAiModelRecord = {
  profile: { type: "agent", id: "test-model", name: "Test model" },
  config: { provider: "anthropic", model: "claude-sonnet-4-5", apiToken: "unused" },
};
const A: AgentProfile = { id: "a", name: "Alice", title: "Alice", description: "",
  defaultModelId: MODEL.profile.id, workspaceId: "workspace", created: new Date(0), updated: new Date(0) };
const B: AgentProfile = { ...A, id: "b", name: "Bob", title: "Bob" };
const GROUP: Group = { id: "group", name: "Group", workspaceId: "workspace",
  memberAgentIds: [A.id, B.id], created: new Date(0), updated: new Date(0) };
const CONTEXT: UserChatContext = { profile: USER, aiModel: MODEL, group: GROUP };
const FINISHED = { status: "finished", reason: "model_stop" } satisfies TaskRunDisposition;

function assistant(text = "Draft ready. @Bob"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages",
    provider: "anthropic", model: MODEL.config.model, usage: zeroUsage(), stopReason: "stop", timestamp: 0 };
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Group tests forbid provider calls"));
  // Spy only: admission, the real runAgent replay/tool assembly, and the commit barrier all run.
  vi.spyOn(agent, "runAgent");
  vi.mocked(runAgentLoopContinue).mockReset().mockImplementation(async (_context, _config, emit) => {
    const message = assistant();
    await emit({ type: "turn_start" });
    await emit({ type: "turn_end", message, toolResults: [] });
    await emit({ type: "agent_end", messages: [message] });
    return [];
  });
});

afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

function inOverseer(name: string, test: (impl: Impl, instance: OverseerDurableObject) => Promise<void>) {
  return runInDurableObject(env.TEST_OVERSEER.getByName(`task-groups-${name}`),
    (instance: OverseerDurableObject) => test(instance["impl"], instance));
}

function setup(impl: Impl) {
  impl.ownerId = OWNER;
  impl.ownerProfileId = USER.id;
  const user = {
    id: { toString: () => OWNER },
    whoami: vi.fn(async () => USER),
    getChatContext: vi.fn(async (_modelId?: string | null, _workspaceId?: string,
      _agentId?: string): Promise<UserChatContext> => CONTEXT),
    getAgent: vi.fn(async (id: string): Promise<AgentProfile | undefined> => id === A.id ? A : id === B.id ? B : undefined),
    getGroupByWorkspaceId: vi.fn(async (): Promise<Group | null> => GROUP),
    listGatekeeperVendors: vi.fn(async (): Promise<GatekeeperVendorInfo[]> => [{
      id: "test", description: { displayName: "Test", url: "https://example.com" },
      supportedResources: [{ urlPattern: "https://example.com/*", title: "Source", description: "Test source" }],
    }]),
    getAgentByWorkspaceId: vi.fn(async () => undefined),
    recordSharedGadgetOpen: vi.fn(async () => {}),
    setGadgetLastActive: vi.fn(async () => {}),
  };
  Object.assign(impl, { users: { idFromString: (id: string) => id, get: () => user },
    getSharingManager: async () => ({ getEffectiveRole: () => "build" }) });
  vi.spyOn(impl, "ensureAmbientCapsules").mockResolvedValue(undefined);
  vi.spyOn(impl, "ensureObserver").mockResolvedValue(undefined);
  vi.spyOn(impl, "markOutputsDirty").mockImplementation(() => {});
  vi.spyOn(impl, "syncOutputsTo").mockResolvedValue(true);
  vi.spyOn(impl, "joinOutputsFanout").mockReturnValue(() => {});
  vi.spyOn(impl, "recordGadgetAnalytics").mockImplementation(() => {});
  vi.spyOn(impl, "prepareChatBindings").mockResolvedValue([]);
  vi.spyOn(impl, "getInstanceInstructions").mockResolvedValue("");
  vi.spyOn(impl, "getAgentSkills").mockResolvedValue([]);
  vi.spyOn(impl, "listAgentMemory").mockResolvedValue([]);
  vi.spyOn(impl, "describeStandardFormats").mockResolvedValue("");
  vi.spyOn(impl, "listConnectableVendors").mockResolvedValue([]);
  return user;
}

async function open(instance: OverseerDurableObject) {
  using closed = new NativeRpcStub<() => void>(() => {});
  return new RpcStub(await instance.open(OWNER, USER.id, closed));
}

function addChat(impl: Impl) {
  impl.storage.chatMeta.put({ id: 1, title: "Group", started: new Date(0), lastActive: new Date(0) });
}

function currentRun(impl: Impl, chatId: number) {
  const id = impl.getChatMetaOrThrow(chatId).currentRunId;
  const run = id && impl.storage.taskRuns.get(id);
  if (!run) throw new Error("Expected a task run");
  return run;
}

describe('concurrent group authors', () => {
  it('runs independent authors simultaneously and publishes both identities to the shared timeline', () =>
    inOverseer('multi-author', async (impl, instance) => {
      const user = setup(impl);
      user.getChatContext.mockResolvedValue({ ...CONTEXT, group: { ...GROUP, workspaceId: impl.ctx.id.toString(), multiAuthor: true } });
      const gate = Promise.withResolvers<void>();
      let entered = 0;
      const loop = vi.mocked(runAgentLoopContinue).getMockImplementation()!;
      vi.mocked(runAgentLoopContinue).mockImplementation(async (...args) => { ++entered; await gate.promise; return loop(...args); });
      using client = await open(instance);
      const chatId = await client.newChat('@everyone prepare a draft', MODEL.profile.id);
      try {
        await vi.waitFor(() => expect(entered).toBe(2));
        const meta = impl.getChatMetaOrThrow(chatId);
        expect(meta.activeAuthors?.map(author => author.name).toSorted()).toEqual(['Alice', 'Bob']);
        expect(meta.groupRound?.childChatIds).toHaveLength(2);
        for (const child of meta.groupRound!.childChatIds) {
          expect(impl.getChatAgentContext(child)).toMatchObject({ groupPeers: [{ id: 'a' }, { id: 'b' }], bindings: {}, alwaysAvailableCapsuleIds: [] });
          expect(impl.getChatAgentContext(child).agentId).toBeUndefined();
        }
      } finally { gate.resolve(); }
      await impl.waitForAllAgentsToComplete();
      const history = await client.getChatHistory(chatId);
      const authors = history.messages.filter(message => message.type === 'message' && message.author.type === 'agent')
        .map(message => message.author.type === 'agent' ? message.author.agentProfileId : undefined);
      expect(new Set(authors)).toEqual(new Set(['a', 'b']));
      expect(currentRun(impl, chatId).status).toBe('finished');
      expect(impl.listAgentMemory).not.toHaveBeenCalled();
    }));

  it('admits peer handoffs only at the existing step barrier and cancels the whole round', () =>
    inOverseer('group-handoff', async (impl, instance) => {
      const user = setup(impl);
      user.getChatContext.mockResolvedValue({ ...CONTEXT, group: { ...GROUP, workspaceId: impl.ctx.id.toString(), multiAuthor: true } });
      const gate = Promise.withResolvers<void>();
      let entered = 0;
      vi.mocked(runAgentLoopContinue).mockImplementation(async () => { ++entered; await gate.promise; return []; });
      using client = await open(instance);
      const chatId = await client.newChat('Prepare a draft', MODEL.profile.id);
      try {
        await vi.waitFor(() => expect(entered).toBe(2));
        const child = impl.getChatMetaOrThrow(chatId).groupRound!.childChatIds[0];
        const execution = impl.storage.activeAgents.get(child)!.run!;
        const input = { requestId: 'review-1', targetAgentId: B.id, title: 'Review draft', prompt: 'Review the shared draft', bindingNames: [] };
        const prepared = await impl.prepareNamedDelegation(child, execution, input);
        expect(impl.getChatMetaOrThrow(chatId).groupRound!.childChatIds).toHaveLength(2);
        await impl.commitAgentStep(child, MODEL.profile, [{ type: 'message', message: 'Handing review to Bob', toolCalls: [
          { toolName: 'delegateToBot', toolCallId: input.requestId, input, delegationId: prepared.id },
        ] }], { changes: [], createdGadgets: [], addedBindings: [], run: execution, delegations: [prepared] });
        await vi.waitFor(() => expect(entered).toBe(3));
        expect(impl.getNamedDelegation(prepared.id).receipt.parentChatId).toBe(chatId);
        expect(impl.getChatMetaOrThrow(chatId).groupRound!.childChatIds).toHaveLength(3);
        impl.cancelAgent(chatId);
        expect(currentRun(impl, chatId).status).toBe('canceled');
        expect(impl.getChatMetaOrThrow(chatId).groupRound!.childChatIds.every(id => impl.isNamedDelegationCanceled(id))).toBe(true);
      } finally { impl.cancelAgent(chatId); gate.resolve(); await impl.waitForAllAgentsToComplete(); }
    }));
});

describe.each(["new", "send"] as const)("%s group admission", kind => {
  it("keeps the first member's real model_stop instead of running on its assistant tail", () =>
    inOverseer(`${kind}-finished`, async (impl, instance) => {
      const user = setup(impl);
      if (kind === "send") addChat(impl);
      const active: unknown[] = [];
      const loop = vi.mocked(runAgentLoopContinue).getMockImplementation()!;
      vi.mocked(runAgentLoopContinue).mockImplementation(async (...args) => {
        active.push([...impl.storage.activeAgents.list()]);
        return loop(...args);
      });
      using client = await open(instance);
      const chatId = kind === "new" ? await client.newChat("Make a draft", MODEL.profile.id) :
        (await client.sendChatMessage(1, "Make a draft", MODEL.profile.id), 1);
      await impl.waitForAllAgentsToComplete();
      const run = currentRun(impl, chatId);
      expect(run).toMatchObject({ ...FINISHED, attempt: 1, source: { type: "prompt" } });
      expect(active).toEqual([[expect.objectContaining({ chatId, run: { id: run.id, attempt: 1 } })]]);
      expect(agent.runAgent).toHaveBeenCalledOnce();
      expect(runAgentLoopContinue).toHaveBeenCalledOnce();
      expect(user.getAgent).not.toHaveBeenCalledWith(B.id);
      const evidence = await client.getTaskRunEvidence(run.id);
      expect(evidence.entries.map(e => e.message.runId)).toEqual([run.id, run.id]);
      expect(evidence.entries[0].message).toMatchObject({ type: "message",
        author: { agentProfileId: A.id }, message: "Draft ready. @Bob" });
      expect(impl.getChatMetaOrThrow(chatId).activeAgent).toBeUndefined();
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
    }));

  it("skips unavailable profiles/models but still runs the first eligible member", () =>
    inOverseer(`${kind}-eligible`, async (impl, instance) => {
      const user = setup(impl);
      user.getAgent.mockImplementation(async id => id === "human" ? { ...A, defaultModelId: null } :
        id === A.id ? A : id === B.id ? B : undefined);
      // Alice is configured, but her model is unavailable. Bob should get the original prompt.
      user.getChatContext.mockImplementation(async (_model, _workspace, agentId) =>
        agentId === A.id ? { profile: USER } : { ...CONTEXT, group: { ...GROUP,
          memberAgentIds: ["missing", "human", A.id, B.id] } });
      if (kind === "send") addChat(impl);
      using client = await open(instance);
      const chatId = kind === "new" ? await client.newChat("Make a draft", MODEL.profile.id) :
        (await client.sendChatMessage(1, "Make a draft", MODEL.profile.id), 1);
      await impl.waitForAllAgentsToComplete();
      expect(currentRun(impl, chatId)).toMatchObject({ ...FINISHED, attempt: 1 });
      expect(agent.runAgent).toHaveBeenCalledOnce();
      expect(vi.mocked(agent.runAgent).mock.calls[0][3]).toMatchObject({ agentProfileId: B.id });
    }));

  it("starts the admitted task when unrelated action evidence arrives during member lookup", () =>
    inOverseer(`${kind}-late-action`, async (impl, instance) => {
      const user = setup(impl);
      if (kind === "send") addChat(impl);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      user.getAgent.mockImplementationOnce(async () => {
        entered.resolve(); await release.promise; return A;
      });
      using client = await open(instance);
      const sending = kind === "new" ? client.newChat("Original task", MODEL.profile.id) :
        client.sendChatMessage(1, "Original task", MODEL.profile.id);
      await entered.promise;
      const admitted = [...impl.storage.taskRuns.list()][0];
      try {
        putAction(impl.storage, 1);
        impl.addChatMessages(admitted.chatId, USER, [{ type: "action", actionId: 1 }]);
      } finally {
        release.resolve();
        await sending;
        await impl.waitForAllAgentsToComplete();
      }
      expect(currentRun(impl, admitted.chatId)).toMatchObject({ id: admitted.id,
        sourceSequence: admitted.sourceSequence, ...FINISHED, attempt: 1 });
      expect(agent.runAgent).toHaveBeenCalledOnce();
      expect(vi.mocked(agent.runAgent).mock.calls[0][9]).toEqual({ id: admitted.id, attempt: 1 });
      expect((await client.getTaskRunEvidence(admitted.id)).entries.map(e => e.message.type))
        .toEqual(["message", "message"]);
      expect(impl.getChatMetaOrThrow(admitted.chatId).activeAgent).toBeUndefined();
    }));

  it.each(["profile", "model"] as const)("releases an admission when no member has an available %s", unavailable =>
    inOverseer(`${kind}-no-${unavailable}`, async (impl, instance) => {
      const user = setup(impl);
      if (kind === "send") addChat(impl);
      if (unavailable === "profile") user.getAgent.mockResolvedValue(undefined);
      else user.getChatContext.mockImplementation(async (_model, _workspace, agentId) =>
        agentId ? { profile: USER } : CONTEXT);
      using client = await open(instance);
      const chatId = kind === "new" ? await client.newChat("Task", MODEL.profile.id) :
        (await client.sendChatMessage(1, "Task", MODEL.profile.id), 1);
      const unavailableRun = currentRun(impl, chatId);
      expect(unavailableRun).toMatchObject({ status: "incomplete", reason: "model_unavailable", attempt: 0 });
      expect(impl.getChatMetaOrThrow(chatId).activeAgent).toBeUndefined();
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      expect(agent.runAgent).not.toHaveBeenCalled();
      // The released marker must allow the next prompt, not leave it queued behind a phantom turn.
      user.getAgent.mockImplementation(async id => id === A.id ? A : B);
      user.getChatContext.mockResolvedValue(CONTEXT);
      await client.sendChatMessage(chatId, "Try again", MODEL.profile.id);
      expect(currentRun(impl, chatId)).toMatchObject({ ...FINISHED, attempt: 1 });
      expect(impl.storage.taskRuns.get(unavailableRun.id)).toEqual(unavailableRun);
    }));

  it.each(["profile", "model"] as const)("releases an admission when %s lookup rejects", lookup =>
    inOverseer(`${kind}-${lookup}-reject`, async (impl, instance) => {
      const user = setup(impl);
      if (kind === "send") addChat(impl);
      if (lookup === "profile") user.getAgent.mockRejectedValueOnce(new Error("Member lookup failed"));
      else user.getChatContext.mockImplementation(async (_model, _workspace, agentId) => {
        if (agentId) throw new Error("Member lookup failed");
        return CONTEXT;
      });
      using client = await open(instance);
      await expect(kind === "new" ? client.newChat("Task", MODEL.profile.id) :
        client.sendChatMessage(1, "Task", MODEL.profile.id)).rejects.toThrow("Member lookup failed");
      const run = [...impl.storage.taskRuns.list()][0];
      expect(run).toMatchObject({ status: "incomplete", reason: "model_unavailable", attempt: 0 });
      expect(impl.getChatMetaOrThrow(run.chatId).activeAgent).toBeUndefined();
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      expect(agent.runAgent).not.toHaveBeenCalled();
    }));

  it("preserves pause cancellation when a rejected lookup unwinds after resume", () =>
    inOverseer(`${kind}-paused-reject`, async (impl, instance) => {
      const user = setup(impl);
      if (kind === "send") addChat(impl);
      user.getAgent.mockImplementationOnce(async () => {
        await impl.setAutomationPaused(true);
        await impl.setAutomationPaused(false);
        throw new Error("Member lookup failed");
      });
      using client = await open(instance);
      await expect(kind === "new" ? client.newChat("Task", MODEL.profile.id) :
        client.sendChatMessage(1, "Task", MODEL.profile.id)).rejects.toThrow("Member lookup failed");
      const run = [...impl.storage.taskRuns.list()][0];
      expect(run).toMatchObject({ status: "canceled", reason: "workspace_paused", attempt: 0 });
      expect(impl.getChatMetaOrThrow(run.chatId).activeAgent).toBeUndefined();
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      expect(agent.runAgent).not.toHaveBeenCalled();
    }));

  it("keeps a real connection request waiting without letting the next member bypass approval", () =>
    inOverseer(`${kind}-connection-wait`, async (impl, instance) => {
      const user = setup(impl);
      if (kind === "send") addChat(impl);
      user.getAgent.mockImplementationOnce(async () => {
        const run = [...impl.storage.taskRuns.list()][0];
        impl.storage.chatContext.put({ chatId: run.chatId, agentId: A.id });
        return A;
      });
      vi.mocked(runAgentLoopContinue).mockImplementationOnce(async (context, config, emit, signal) => {
        const call = { type: "toolCall" as const, id: "request", name: "requestConnection", arguments: {
          vendorId: "test", resourceUrl: "https://example.com/source", bindingName: "SOURCE", reason: "Read the source",
        } };
        await emit({ type: "turn_start" });
        const tool = context.tools!.find(entry => entry.name === call.name)!;
        const result: ToolResultMessage = { role: "toolResult", toolCallId: call.id, toolName: call.name,
          ...await tool.execute(call.id, validateToolCall(context.tools!, call), signal), isError: false, timestamp: 0 };
        const message: AssistantMessage = { ...assistant(), content: [...assistant().content, call], stopReason: "toolUse" };
        await emit({ type: "turn_end", message, toolResults: [result] });
        expect(await config.shouldStopAfterTurn!({ message, toolResults: [result], context, newMessages: [] })).toBe(true);
        await emit({ type: "agent_end", messages: [message, result] });
        return [];
      });
      using client = await open(instance);
      const chatId = kind === "new" ? await client.newChat("Read a source", MODEL.profile.id) :
        (await client.sendChatMessage(1, "Read a source", MODEL.profile.id), 1);
      await impl.waitForAllAgentsToComplete();
      const run = currentRun(impl, chatId);
      expect(run).toMatchObject({ status: "waiting", reason: "connection", attempt: 1 });
      expect(agent.runAgent).toHaveBeenCalledOnce();
      expect(user.getAgent).not.toHaveBeenCalledWith(B.id);
      expect(user.getGroupByWorkspaceId).not.toHaveBeenCalled();
      expect((await client.getTaskRunEvidence(run.id)).entries[0].message)
        .toMatchObject({ type: "connectionRequest", state: "pending", runId: run.id });
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
    }));

  it.each(["profile", "model"] as const)("fences a newer admission across the %s lookup", lookup =>
    inOverseer(`${kind}-${lookup}-replacement`, async (impl, instance) => {
      const user = setup(impl);
      if (kind === "send") addChat(impl);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      if (lookup === "profile") user.getAgent.mockImplementationOnce(async () => {
        entered.resolve(); await release.promise; return A;
      });
      else user.getChatContext.mockImplementation(async (_model, _workspace, agentId) => {
        if (agentId === A.id) { entered.resolve(); await release.promise; }
        return CONTEXT;
      });
      using client = await open(instance);
      const sending = kind === "new" ? client.newChat("Old task", MODEL.profile.id) :
        client.sendChatMessage(1, "Old task", MODEL.profile.id);
      await entered.promise;
      const old = [...impl.storage.taskRuns.list()][0];
      // Seed a competing admitted source using the real allocator/admission, with the same model
      // and reservation marker. Neither the model ID nor automation generation identifies a task.
      impl.addChatMessages(old.chatId, USER, [{ type: "message", message: "New task" }]);
      const sequence = impl.nextChatSequencePeek(old.chatId) - 1;
      const replacement = impl.admitTaskRun(old.chatId, sequence, { type: "prompt" });
      release.resolve();
      await sending;
      expect(currentRun(impl, old.chatId)).toEqual(replacement);
      expect(impl.getChatMetaOrThrow(old.chatId).activeAgent).toEqual(MODEL.profile);
      expect(impl.storage.taskRuns.get(old.id)).toEqual(old);
      expect(agent.runAgent).not.toHaveBeenCalled();
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
    }));

  it.each(["profile", "model"] as const)("honors Stop during the %s lookup", lookup =>
    inOverseer(`${kind}-${lookup}-stop`, async (impl, instance) => {
      const user = setup(impl);
      if (kind === "send") addChat(impl);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      if (lookup === "profile") user.getAgent.mockImplementationOnce(async () => {
        entered.resolve(); await release.promise; return A;
      });
      else user.getChatContext.mockImplementation(async (_model, _workspace, agentId) => {
        if (agentId === A.id) { entered.resolve(); await release.promise; }
        return CONTEXT;
      });
      using client = await open(instance);
      const sending = kind === "new" ? client.newChat("Stop this task", MODEL.profile.id) :
        client.sendChatMessage(1, "Stop this task", MODEL.profile.id);
      await entered.promise;
      const run = [...impl.storage.taskRuns.list()][0];
      await client.stopAgent(run.chatId);
      release.resolve();
      await sending;
      expect(currentRun(impl, run.chatId)).toMatchObject({ id: run.id, attempt: 0,
        status: "canceled", reason: "user_stop" });
      expect(agent.runAgent).not.toHaveBeenCalled();
      expect(impl.getChatMetaOrThrow(run.chatId).activeAgent).toBeUndefined();
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
    }));

  it.each([
    { status: "waiting", reason: "connection" }, { status: "canceled", reason: "user_stop" },
    FINISHED, { status: "incomplete", reason: "step_limit" }, { status: "failed", reason: "execution_error" },
  ] satisfies TaskRunDisposition[])("does not reopen a $status disposition during model lookup", disposition =>
    inOverseer(`${kind}-lookup-${disposition.status}`, async (impl, instance) => {
      const user = setup(impl);
      if (kind === "send") addChat(impl);
      user.getChatContext.mockImplementation(async (_model, _workspace, agentId) => {
        if (agentId === A.id) {
          const run = [...impl.storage.taskRuns.list()][0];
          impl.finishTaskExecution(run, disposition);
        }
        return CONTEXT;
      });
      using client = await open(instance);
      const chatId = kind === "new" ? await client.newChat("Task", MODEL.profile.id) :
        (await client.sendChatMessage(1, "Task", MODEL.profile.id), 1);
      expect(currentRun(impl, chatId)).toMatchObject({ ...disposition, attempt: 0 });
      expect(impl.getChatMetaOrThrow(chatId).activeAgent).toBeUndefined();
      expect(agent.runAgent).not.toHaveBeenCalled();
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
    }));

  it("does not replace another active record even when the run and model still match", () =>
    inOverseer(`${kind}-exclusive`, async (impl, instance) => {
      const user = setup(impl);
      if (kind === "send") addChat(impl);
      user.getAgent.mockImplementationOnce(async () => {
        const run = [...impl.storage.taskRuns.list()][0];
        impl.storage.activeAgents.put({ chatId: run.chatId, initiatorUserId: OWNER, initiator: USER,
          modelId: MODEL.profile.id, callbackInitiated: false, run: { id: run.id, attempt: run.attempt } });
        return A;
      });
      using client = await open(instance);
      const chatId = kind === "new" ? await client.newChat("Task", MODEL.profile.id) :
        (await client.sendChatMessage(1, "Task", MODEL.profile.id), 1);
      const run = currentRun(impl, chatId);
      expect(run).toMatchObject({ status: "admitted", attempt: 0 });
      expect(impl.storage.activeAgents.get(chatId)?.run).toEqual({ id: run.id, attempt: 0 });
      expect(impl.getChatMetaOrThrow(chatId).activeAgent).toEqual(MODEL.profile);
      expect(agent.runAgent).not.toHaveBeenCalled();
      impl.storage.activeAgents.delete(chatId);
    }));

  it("does not recreate a chat deleted during model lookup", () =>
    inOverseer(`${kind}-deleted`, async (impl, instance) => {
      const user = setup(impl);
      if (kind === "send") addChat(impl);
      using client = await open(instance);
      user.getChatContext.mockImplementation(async (_model, _workspace, agentId) => {
        if (agentId === A.id) {
          const run = [...impl.storage.taskRuns.list()][0];
          await client.deleteChat(run.chatId);
        }
        return CONTEXT;
      });
      if (kind === "new") await client.newChat("Task", MODEL.profile.id);
      else await client.sendChatMessage(1, "Task", MODEL.profile.id);
      expect([...impl.storage.chatMeta.list()]).toEqual([]);
      expect([...impl.storage.taskRuns.list()]).toEqual([]);
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      expect(agent.runAgent).not.toHaveBeenCalled();
    }));
});

it("does not let an older fanout adopt a queued task drained after its first member", () =>
  inOverseer("queue-after-member", async (impl, instance) => {
    const user = setup(impl);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const loop = vi.mocked(runAgentLoopContinue).getMockImplementation()!;
    vi.mocked(runAgentLoopContinue).mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return loop(...args);
    });
    using client = await open(instance);
    const creating = client.newChat("First task", MODEL.profile.id);
    await entered.promise;
    const first = [...impl.storage.taskRuns.list()][0];
    try {
      await client.sendChatMessage(first.chatId, "Queued task", MODEL.profile.id);
    } finally {
      release.resolve();
      await creating;
      await impl.waitForAllAgentsToComplete();
    }
    const runs = (await client.listTaskRuns(first.chatId)).runs;
    expect(runs).toMatchObject([
      { source: { type: "queue" }, attempt: 1, ...FINISHED },
      { id: first.id, source: { type: "prompt" }, attempt: 1, ...FINISHED },
    ]);
    expect(agent.runAgent).toHaveBeenCalledTimes(2);
    expect(user.getAgent).not.toHaveBeenCalledWith(B.id);
  }));

it.each(["available", "unavailable", "late-action"] as const)("preserves the waiting task during group /compact (%s)", state =>
  inOverseer(`group-compact-${state}`, async (impl, instance) => {
    const user = setup(impl);
    addChat(impl);
    impl.addChatMessages(1, USER, [{ type: "message", message: "Original task" }]);
    const admitted = impl.admitTaskRun(1, 0, { type: "prompt" });
    impl.finishTaskExecution(admitted, { status: "waiting", reason: "connection" });
    const waiting = currentRun(impl, 1);
    user.getAgent.mockImplementation(async id => {
      if (state === "late-action" && id === A.id) {
        putAction(impl.storage, 1);
        impl.addChatMessages(1, USER, [{ type: "action", actionId: 1 }]);
      }
      return state === "unavailable" ? undefined : A;
    });
    using client = await open(instance);
    await client.sendChatMessage(1, { id: { builtin: true, commandId: "compact" }, args: "" }, MODEL.profile.id);
    expect(currentRun(impl, 1)).toEqual(waiting);
    expect(agent.runAgent).toHaveBeenCalledTimes(state === "available" ? 1 : 0);
    if (state === "available") expect(vi.mocked(agent.runAgent).mock.calls[0][9]).toBeUndefined();
    expect(runAgentLoopContinue).not.toHaveBeenCalled();
    expect(impl.getChatMetaOrThrow(1).activeAgent).toBeUndefined();
    expect([...impl.storage.activeAgents.list()]).toEqual([]);
  }));

describe("group mentions", () => {
  it("does not run a mentioned member on a real completed assistant tail", () =>
    inOverseer("mention-finished", async (impl, instance) => {
      const user = setup(impl);
      user.getChatContext.mockResolvedValue({ ...CONTEXT, agentProfile: A });
      using client = await open(instance);
      const chatId = await client.newChat("Make a draft", MODEL.profile.id);
      await impl.waitForAllAgentsToComplete();
      expect(currentRun(impl, chatId)).toMatchObject({ ...FINISHED, attempt: 1 });
      expect(agent.runAgent).toHaveBeenCalledOnce();
      expect(user.getAgent).not.toHaveBeenCalled();
      expect(user.getGroupByWorkspaceId).not.toHaveBeenCalled();
      expect([...impl.storage.chats.list({ prefix: `${keyString(chatId)}.` })]).toHaveLength(2);
    }));

  it("preserves a newer running task when the previous member's final cleanup returns", () =>
    inOverseer("member-cleanup-replacement", async (impl, instance) => {
      const user = setup(impl);
      user.getChatContext.mockResolvedValue({ ...CONTEXT, agentProfile: A });
      const cleaning = Promise.withResolvers<void>();
      const releaseCleanup = Promise.withResolvers<void>();
      vi.spyOn(impl, "reconcilePendingGadgets").mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => { cleaning.resolve(); return releaseCleanup.promise; });
      using client = await open(instance);
      const chatId = await client.newChat("Old task", MODEL.profile.id);
      await cleaning.promise;
      const old = currentRun(impl, chatId);
      expect(old).toMatchObject({ ...FINISHED, attempt: 1 });
      const running = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const loop = vi.mocked(runAgentLoopContinue).getMockImplementation()!;
      vi.mocked(runAgentLoopContinue).mockImplementationOnce(async (...args) => {
        running.resolve(); await finish.promise; return loop(...args);
      });
      try {
        await impl.setAutomationPaused(true);
        impl.destroyLiveChat(chatId);
        await impl.setAutomationPaused(false);
        // Model the replacement admission while A's cleanup is still parked on its old context.
        impl.storage.chatMeta.put({ ...impl.getChatMetaOrThrow(chatId), activeAgent: undefined });
        await client.sendChatMessage(chatId, "New task", MODEL.profile.id);
        await running.promise;
        const replacement = currentRun(impl, chatId);
        const record = impl.storage.activeAgents.get(chatId);
        expect(replacement).toMatchObject({ status: "running", attempt: 1 });
        expect(replacement.id).not.toBe(old.id);
        releaseCleanup.resolve();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(currentRun(impl, chatId)).toEqual(replacement);
        expect(impl.storage.taskRuns.get(old.id)).toEqual(old);
        expect(impl.storage.activeAgents.get(chatId)).toEqual(record);
        expect(impl.getChatMetaOrThrow(chatId).activeAgent).toEqual(MODEL.profile);
        expect(agent.runAgent).toHaveBeenCalledTimes(2);
        expect(user.getAgent).not.toHaveBeenCalledWith(B.id);
      } finally {
        releaseCleanup.resolve(); finish.resolve();
        await impl.waitForAllAgentsToComplete();
      }
    }));
});
