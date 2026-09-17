import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub, RpcTarget as NativeRpcTarget } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { RpcStub } from "capnweb";
import { keyString, type Subscriber } from "@gadgets/typed-storage";
import type { AgentProfile, AiChatAuthorInfo, TaskRun, TaskRunDisposition } from "@gadgets/workshop-shared/api";
import type { ChatGatewayRpcTarget, GadgetResponse } from "@gadgets/workshop-shared/external-message-gateway";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserAiModelRecord, UserChatContext } from "../src/user.js";
import { runAgent } from "../src/agent.js";
import { enqueueChatQueueItem, publicChatQueue } from "../src/chat-queue.js";
import { putAction } from "./fixtures.js";

vi.mock("../src/agent.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/agent.js")>(),
  runAgent: vi.fn(),
}));

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    }
  }
}

type Impl = OverseerDurableObject["impl"];
const OWNER = "task-owner";
const USER: AiChatAuthorInfo = { type: "user", id: "owner", name: "Owner" };
const MODEL: UserAiModelRecord = {
  profile: { type: "agent", id: "test-model", name: "Test model" },
  config: { provider: "anthropic", model: "claude-sonnet-4-5", apiToken: "unused" },
};
const FINISHED: TaskRunDisposition = { status: "finished", reason: "model_stop" };
const WAITING: TaskRunDisposition = { status: "waiting", reason: "connection" };
const NO_CHANGES = { changes: [], createdGadgets: [], addedBindings: [] };

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Task-run tests forbid provider calls"));
  vi.mocked(runAgent).mockReset().mockImplementation(async (hooks, _model, chatId, author,
      _messages, _signal, _initiator, _callback, _compaction, execution) => {
    await hooks.commitAgentStep(chatId, author, [{ type: "message", message: "Draft ready." }], {
      ...NO_CHANGES, run: execution && { ...execution, disposition: FINISHED },
    });
    return { disposition: FINISHED };
  });
});

afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

function inOverseer(name: string, fn: (impl: Impl, instance: OverseerDurableObject) => Promise<void>) {
  return runInDurableObject(env.TEST_OVERSEER.getByName(`task-runs-${name}`),
    (instance: OverseerDurableObject) => fn(instance["impl"], instance));
}

// Same real SQLite/Overseer fixture as automation-pause. Only remote User/configuration and
// model execution are substituted; admission, barriers, decisions, recovery and APIs are real.
function setup(impl: Impl, role: "build" | "use" = "build") {
  impl.ownerId = OWNER;
  impl.ownerProfileId = USER.id;
  const user = {
    id: { toString: () => OWNER },
    whoami: vi.fn(async () => USER),
    getChatContext: vi.fn(async (_modelId?: string | null): Promise<UserChatContext> => ({ profile: USER, aiModel: MODEL })),
    getAgent: vi.fn(async (): Promise<AgentProfile | undefined> => undefined),
    getGroupByWorkspaceId: vi.fn(async () => null),
    getAgentByWorkspaceId: vi.fn(async () => undefined),
    recordSharedGadgetOpen: vi.fn(async () => {}),
    setGadgetLastActive: vi.fn(async () => {}),
  };
  Object.assign(impl, {
    users: { idFromString: (id: string) => id, get: () => user },
    getSharingManager: async () => ({ getEffectiveRole: () => role }),
  });
  vi.spyOn(impl, "ensureAmbientCapsules").mockResolvedValue(undefined);
  vi.spyOn(impl, "ensureObserver").mockResolvedValue(undefined);
  vi.spyOn(impl, "markOutputsDirty").mockImplementation(() => {});
  vi.spyOn(impl, "syncOutputsTo").mockResolvedValue(true);
  vi.spyOn(impl, "joinOutputsFanout").mockReturnValue(() => {});
  vi.spyOn(impl, "recordGadgetAnalytics").mockImplementation(() => {});
  return user;
}

async function open(instance: OverseerDurableObject, userId = OWNER) {
  using closed = new NativeRpcStub<() => void>(() => {});
  return new RpcStub(await instance.open(userId, userId === OWNER ? USER.id : userId, closed));
}

function addChat(impl: Impl, id = 1) {
  impl.storage.chatMeta.put({ id, title: "Task history", started: new Date(id), lastActive: new Date(id) });
}

function messages(impl: Impl, chatId = 1) {
  return [...impl.storage.chats.list({ prefix: `${keyString(chatId)}.` })];
}

function currentRun(impl: Impl, chatId = 1): TaskRun {
  const id = impl.getChatMetaOrThrow(chatId).currentRunId;
  const run = id && impl.storage.taskRuns.get(id);
  if (!run) throw new Error("Expected a persisted task run");
  return run;
}

function admit(impl: Impl, chatId = 1) {
  impl.addChatMessages(chatId, USER, [{ type: "message", message: "Make a draft" }]);
  const sequence = messages(impl, chatId).at(-1)!.sequence;
  return impl.admitTaskRun(chatId, sequence, { type: "prompt" });
}

function connection(chatId: number) {
  return { type: "connectionRequest" as const, requestId: `${chatId}:connection`,
    bindingName: "SOURCE", vendorId: "test", vendorName: "Test", resourceUrl: "https://example.com",
    state: "pending" as const, reason: "Read the selected source" };
}

function waitForConnection() {
  vi.mocked(runAgent).mockImplementationOnce(async (hooks, _model, chatId, author,
      _messages, _signal, _initiator, _callback, _compaction, execution) => {
    await hooks.commitAgentStep(chatId, author, [connection(chatId)], {
      ...NO_CHANGES, run: execution && { ...execution, disposition: WAITING },
    });
    return { disposition: WAITING };
  });
}

describe("task-run admission and execution identity", () => {
  it("admits newChat/sendChatMessage prompts and stamps the actual execution and evidence", () =>
    inOverseer("prompts", async (impl, instance) => {
      setup(impl);
      using client = await open(instance);
      const chatId = await client.newChat("First task", MODEL.profile.id);
      await impl.waitForAllAgentsToComplete();
      const first = currentRun(impl, chatId);
      expect(first).toMatchObject({ chatId, source: { type: "prompt" }, sourceSequence: 0,
        attempt: 1, status: "finished", reason: "model_stop" });
      expect(first.lastSequence).toBe(messages(impl, chatId).at(-1)!.sequence);
      expect(first.startedAt).toEqual(messages(impl, chatId)[0].timestamp);
      expect(runAgent).toHaveBeenLastCalledWith(impl, expect.anything(), chatId, MODEL.profile,
        expect.any(Array), expect.any(AbortSignal), USER, false, expect.anything(),
        { id: first.id, attempt: 1 });
      expect(messages(impl, chatId).map(m => m.runId)).toEqual([first.id, first.id]);

      await client.sendChatMessage(chatId, "Second task", MODEL.profile.id);
      await impl.waitForAllAgentsToComplete();
      const second = currentRun(impl, chatId);
      expect(second.id).not.toBe(first.id);
      expect(second).toMatchObject({ source: { type: "prompt" }, attempt: 1, status: "finished" });
      expect(second.sourceSequence).toBeGreaterThan(first.lastSequence);
      expect(second.lastSequence).toBe(messages(impl, chatId).at(-1)!.sequence);
      expect(await client.listTaskRuns(chatId)).toEqual({ runs: [second, first] });
      expect((await client.getTaskRunEvidence(first.id)).entries.map(e => e.message.sequence))
        .toEqual([first.lastSequence, first.sourceSequence]);
      expect(impl.storage.taskRuns.get(first.id)).toEqual(first);
    }));

  it("admits a queue source only when its durable head is consumed", () =>
    inOverseer("queue", async (impl, instance) => {
      const user = setup(impl);
      addChat(impl);
      const head = enqueueChatQueueItem(impl.storage.chatQueue, 1, {
        message: "Queued task", modelId: MODEL.profile.id, initiatorUserId: OWNER,
      });
      const context = Promise.withResolvers<UserChatContext>();
      user.getChatContext.mockReturnValueOnce(context.promise);
      const draining = impl.drainChatQueue(1);
      expect(publicChatQueue(impl.storage.chatQueue, 1)[0].id).toBe(head.id);
      expect([...impl.storage.taskRuns.list()]).toEqual([]);
      context.resolve({ profile: USER, aiModel: MODEL });
      await draining;
      await impl.waitForAllAgentsToComplete();
      const run = currentRun(impl);
      expect(run).toMatchObject({ source: { type: "queue" }, sourceSequence: 0, attempt: 1,
        status: "finished" });
      expect(run.lastSequence).toBe(messages(impl).at(-1)!.sequence);
      expect(publicChatQueue(impl.storage.chatQueue, 1)).toEqual([]);
      using client = await open(instance);
      expect((await client.getTaskRunEvidence(run.id)).entries.map(e => e.message.runId))
        .toEqual([run.id, run.id]);
    }));

  it("does not invent task runs for human-only newChat/sendChatMessage with model null", () =>
    inOverseer("human-only", async (impl, instance) => {
      const user = setup(impl);
      user.getChatContext.mockResolvedValue({ profile: USER });
      using client = await open(instance);
      const chatId = await client.newChat("A note for another person", null);
      await client.sendChatMessage(chatId, "Another human-only note", null);
      expect(user.getChatContext.mock.calls.map(call => call[0])).toEqual([null, null]);
      expect(await client.listTaskRuns(chatId)).toEqual({ runs: [] });
      expect(impl.getChatMetaOrThrow(chatId).currentRunId).toBeUndefined();
      expect(messages(impl, chatId).map(message => message.runId)).toEqual([undefined, undefined]);
      expect([...impl.storage.taskRuns.list()]).toEqual([]);
      expect([...impl.storage.taskRuns.byChatSource.list()]).toEqual([]);
      expect([...impl.storage.chats.byRunSequence.list()]).toEqual([]);
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      expect(runAgent).not.toHaveBeenCalled();
    }));

  it("clears currentRunId on a human-only follow-up so an old approval cannot revive its task", () =>
    inOverseer("human-only-after-wait", async (impl, instance) => {
      const user = setup(impl);
      using client = await open(instance);
      waitForConnection();
      const chatId = await client.newChat("Read a source", MODEL.profile.id);
      await impl.waitForAllAgentsToComplete();
      const waiting = currentRun(impl, chatId);
      user.getChatContext.mockResolvedValueOnce({ profile: USER });
      await client.sendChatMessage(chatId, "Never mind, just leaving a note", null);
      expect(impl.getChatMetaOrThrow(chatId).currentRunId).toBeUndefined();
      expect(messages(impl, chatId).at(-1)).toMatchObject({ type: "message", message: "Never mind, just leaving a note" });
      expect(messages(impl, chatId).at(-1)?.runId).toBeUndefined();
      const lookups = user.getChatContext.mock.calls.length;
      // A model is available again, but this old card is no longer continuation authority.
      await client.acceptConnectionRequest(`${chatId}:connection`, { gatekeeperId: 1 });
      await impl.waitForAllAgentsToComplete();
      expect(user.getChatContext).toHaveBeenCalledTimes(lookups);
      expect(await client.listTaskRuns(chatId)).toEqual({ runs: [waiting] });
      expect((await client.getTaskRunEvidence(waiting.id)).entries[0].message).toMatchObject({ state: "accepted" });
      expect(impl.getChatMetaOrThrow(chatId).currentRunId).toBeUndefined();
      expect(impl.getChatMetaOrThrow(chatId).activeAgent).toBeUndefined();
      expect(runAgent).toHaveBeenCalledOnce();
    }));

  it("batches callbacks into one new logical run, retaining argument storage and return values", () =>
    inOverseer("callbacks", async (impl, instance) => {
      const user = setup(impl);
      addChat(impl);
      const previous = admit(impl);
      impl.finishTaskExecution(previous, FINISHED);
      const context = Promise.withResolvers<UserChatContext>();
      user.getChatContext.mockReturnValue(context.promise);
      const first = impl.deliverAgentCallback(1, "wake", ["first"], OWNER, MODEL.profile.id);
      const second = impl.deliverAgentCallback(1, "wakeAgain", ["second"], OWNER, MODEL.profile.id);
      vi.mocked(runAgent).mockImplementationOnce(async (hooks, _model, chatId, author,
          history, _signal, _initiator, _callback, _compaction, execution) => {
        for (const message of history) {
          if (message.type === "agentCallback") impl.resolveAgentCallback(chatId, message.sequence, message.methodName);
        }
        const disposition: TaskRunDisposition = { status: "finished", reason: "callbacks_resolved" };
        await hooks.commitAgentStep(chatId, author, [{ type: "message", message: "Callbacks resolved" }], {
          ...NO_CHANGES, run: execution && { ...execution, disposition },
        });
        return { disposition };
      });
      context.resolve({ profile: USER, aiModel: MODEL });
      expect(await Promise.all([first, second])).toEqual(["wake", "wakeAgain"]);
      await impl.waitForAllAgentsToComplete();
      const run = currentRun(impl);
      expect(run.id).not.toBe(previous.id);
      expect(run).toMatchObject({ source: { type: "callback" }, sourceSequence: 1,
        attempt: 1, status: "finished", reason: "callbacks_resolved" });
      expect(run.lastSequence).toBe(messages(impl).at(-1)!.sequence);
      expect([...impl.storage.agentCallbackArgs.list()].map(r => r.args)).toEqual([["first"], ["second"]]);
      using client = await open(instance);
      expect((await client.getTaskRunEvidence(run.id)).entries.map(e => e.message.sequence))
        .toEqual([run.lastSequence, 2, 1]);
      expect(runAgent).toHaveBeenCalledOnce();
    }));

  it("does not finish a callback run at model_stop while a callback still needs its return", () =>
    inOverseer("callback-final-barrier", async (impl, instance) => {
      setup(impl);
      addChat(impl);
      const atBarriers: TaskRun[] = [];
      vi.mocked(runAgent).mockImplementationOnce(async (hooks, _model, chatId, author,
          _history, _signal, _initiator, _callback, _compaction, execution) => {
        await hooks.commitAgentStep(chatId, author, [{ type: "message", message: "Premature stop" }], {
          ...NO_CHANGES, run: execution && { ...execution, disposition: FINISHED },
        });
        atBarriers.push(currentRun(impl));
        return { disposition: FINISHED };
      }).mockImplementationOnce(async (hooks, _model, chatId, author,
          history, _signal, _initiator, _callback, _compaction, execution) => {
        for (const message of history) {
          if (message.type === "agentCallback") impl.resolveAgentCallback(chatId, message.sequence, "returned");
        }
        const disposition: TaskRunDisposition = { status: "finished", reason: "callbacks_resolved" };
        await hooks.commitAgentStep(chatId, author, [{ type: "message", message: "Actually returned" }], {
          ...NO_CHANGES, run: execution && { ...execution, disposition },
        });
        atBarriers.push(currentRun(impl));
        return { disposition };
      });
      expect(await impl.deliverAgentCallback(1, "wake", [], OWNER, MODEL.profile.id)).toBe("returned");
      await impl.waitForAllAgentsToComplete();
      expect(atBarriers).toMatchObject([
        { status: "running", attempt: 1 }, { status: "finished", reason: "callbacks_resolved", attempt: 1 },
      ]);
      expect(atBarriers[0].id).toBe(atBarriers[1].id);
      using client = await open(instance);
      const page = await client.getTaskRunEvidence(atBarriers[0].id);
      expect(page.entries.map(e => e.message.type)).toEqual(["message", "agentNudge", "message", "agentCallback"]);
      expect(page.entries.every(e => e.message.runId === atBarriers[0].id)).toBe(true);
    }));

  it("keeps the original source through approval and retry, and fences an earlier attempt's finalizer", () =>
    inOverseer("continuations", async (impl, instance) => {
      setup(impl);
      using client = await open(instance);
      waitForConnection();
      const chatId = await client.newChat("Read a source", MODEL.profile.id);
      await impl.waitForAllAgentsToComplete();
      const waiting = currentRun(impl, chatId);
      expect(waiting).toMatchObject({ ...WAITING, attempt: 1 });
      await client.acceptConnectionRequest(`${chatId}:connection`, { gatekeeperId: 1 });
      await impl.waitForAllAgentsToComplete();
      expect(currentRun(impl, chatId)).toMatchObject({ id: waiting.id, sourceSequence: waiting.sourceSequence,
        source: waiting.source, startedAt: waiting.startedAt, attempt: 2, ...FINISHED });

      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      vi.mocked(runAgent).mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { disposition: FINISHED };
      });
      await client.retryAgent(chatId, MODEL.profile.id);
      await entered.promise;
      try {
        const running = currentRun(impl, chatId);
        expect(running).toMatchObject({ id: waiting.id, status: "running", attempt: 3 });
        expect(running).not.toHaveProperty("reason");
        expect(impl.storage.activeAgents.get(chatId)?.run).toEqual({ id: waiting.id, attempt: 3 });
        impl.finishTaskExecution({ id: waiting.id, attempt: 1 }, { status: "failed", reason: "execution_error" });
        expect(currentRun(impl, chatId)).toEqual(running);
      } finally {
        release.resolve();
        await impl.waitForAllAgentsToComplete();
      }
      expect((await client.listTaskRuns(chatId)).runs).toHaveLength(1);
      expect(currentRun(impl, chatId)).toMatchObject({ id: waiting.id, attempt: 3, ...FINISHED });
    }));

  it.each([WAITING, { status: "incomplete", reason: "step_limit" }] satisfies TaskRunDisposition[])(
    "rejects every outstanding callback RPC result when execution stops $status", disposition =>
    inOverseer(`callback-reject-${disposition.status}`, async (impl, instance) => {
      const user = setup(impl);
      addChat(impl);
      const context = Promise.withResolvers<UserChatContext>();
      user.getChatContext.mockReturnValue(context.promise);
      vi.mocked(runAgent).mockImplementationOnce(async (hooks, _model, chatId, author,
          _history, _signal, _initiator, _callback, _compaction, execution) => {
        await hooks.commitAgentStep(chatId, author, [{ type: "message", message: "Cannot return a result yet" }], {
          ...NO_CHANGES, run: execution && { ...execution, disposition },
        });
        return { disposition };
      });
      const results = Promise.allSettled([
        impl.deliverAgentCallback(1, "wake", [], OWNER, MODEL.profile.id),
        impl.deliverAgentCallback(1, "wakeAgain", [], OWNER, MODEL.profile.id),
      ]);
      context.resolve({ profile: USER, aiModel: MODEL });
      const settled = await results;
      await impl.waitForAllAgentsToComplete();
      expect(settled).toEqual(Array.from({ length: 2 }, () => ({
        status: "rejected", reason: expect.objectContaining({
          message: `Agent did not return a result (${disposition.reason}).`,
        }),
      })));
      const run = currentRun(impl);
      expect(run).toMatchObject({ ...disposition, source: { type: "callback" }, attempt: 1 });
      expect(impl.activeAgentCallbackCount(1)).toBe(0);
      expect(impl.getChatMetaOrThrow(1).activeAgent).toBeUndefined();
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      using client = await open(instance);
      const evidence = (await client.getTaskRunEvidence(run.id)).entries;
      expect(evidence.map(entry => entry.message.type)).toEqual(["message", "agentCallback", "agentCallback"]);
      expect(evidence.every(entry => entry.message.runId === run.id)).toBe(true);
      expect(run.lastSequence).toBe(evidence[0].message.sequence);
      expect(runAgent).toHaveBeenCalledOnce();
    }));

  it("waits for live cleanup before resuming an early approval as exactly one new attempt", () =>
    inOverseer("approval-before-cleanup", async (impl, instance) => {
      const user = setup(impl);
      const cleaning = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const reconcile = impl.reconcilePendingGadgets.bind(impl);
      vi.spyOn(impl, "reconcilePendingGadgets").mockImplementation(reconcile)
        .mockImplementationOnce(reconcile)
        .mockImplementationOnce(async chatId => {
          cleaning.resolve();
          await release.promise;
          await reconcile(chatId);
        });
      using client = await open(instance);
      waitForConnection();
      const chatId = await client.newChat("Read a source", MODEL.profile.id);
      await cleaning.promise;
      const waiting = currentRun(impl, chatId);
      expect(waiting).toMatchObject({ ...WAITING, attempt: 1 });
      expect(impl.getChatMetaOrThrow(chatId).activeAgent).toEqual(MODEL.profile);
      const completed = vi.fn();
      const acceptance = client.acceptConnectionRequest(`${chatId}:connection`, { gatekeeperId: 1 }).then(completed);
      try {
        await vi.waitFor(() => expect(messages(impl, chatId).find(m => m.type === "connectionRequest"))
          .toMatchObject({ state: "accepted" }));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(completed).not.toHaveBeenCalled();
        expect(user.getChatContext).toHaveBeenCalledOnce();
        expect(currentRun(impl, chatId)).toEqual(waiting);
        expect(runAgent).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await acceptance;
        await impl.waitForAllAgentsToComplete();
      }
      const resumed = currentRun(impl, chatId);
      expect(resumed).toMatchObject({ id: waiting.id, source: waiting.source,
        sourceSequence: waiting.sourceSequence, startedAt: waiting.startedAt, attempt: 2, ...FINISHED });
      expect((await client.listTaskRuns(chatId)).runs).toEqual([resumed]);
      expect(vi.mocked(runAgent).mock.calls.map(call => call[9]))
        .toEqual([{ id: waiting.id, attempt: 1 }, { id: waiting.id, attempt: 2 }]);
      expect(completed).toHaveBeenCalledOnce();
      expect(user.getChatContext).toHaveBeenCalledTimes(2);
      expect(impl.storage.activeAgents.get(chatId)).toBeUndefined();
    }));

  it("does not let approval of an older task restart a later finished prompt", () =>
    inOverseer("stale-approval", async (impl, instance) => {
      setup(impl);
      using client = await open(instance);
      waitForConnection();
      const chatId = await client.newChat("Old task", MODEL.profile.id);
      await impl.waitForAllAgentsToComplete();
      const old = currentRun(impl, chatId);
      await client.sendChatMessage(chatId, "Different task", MODEL.profile.id);
      await impl.waitForAllAgentsToComplete();
      const latest = currentRun(impl, chatId);
      await client.acceptConnectionRequest(`${chatId}:connection`, { gatekeeperId: 1 });
      await impl.waitForAllAgentsToComplete();
      expect((await client.getTaskRunEvidence(old.id)).entries[0].message).toMatchObject({ state: "accepted" });
      expect(currentRun(impl, chatId)).toEqual(latest);
      expect(runAgent).toHaveBeenCalledTimes(2);
    }));

  it("rechecks approval's logical identity after the model lookup yields to a new prompt", () =>
    inOverseer("approval-lookup-race", async (impl, instance) => {
      const user = setup(impl);
      using client = await open(instance);
      waitForConnection();
      const chatId = await client.newChat("Old task", MODEL.profile.id);
      await impl.waitForAllAgentsToComplete();
      const context = Promise.withResolvers<UserChatContext>();
      const resolving = Promise.withResolvers<void>();
      user.getChatContext.mockImplementationOnce(() => { resolving.resolve(); return context.promise; });
      const acceptance = client.acceptConnectionRequest(`${chatId}:connection`, { gatekeeperId: 1 });
      await resolving.promise;
      let latest!: TaskRun;
      try {
        await client.sendChatMessage(chatId, "New task", MODEL.profile.id);
        await impl.waitForAllAgentsToComplete();
        latest = currentRun(impl, chatId);
      } finally {
        context.resolve({ profile: USER, aiModel: MODEL });
        await acceptance;
        await impl.waitForAllAgentsToComplete();
      }
      expect(currentRun(impl, chatId)).toEqual(latest);
      expect(runAgent).toHaveBeenCalledTimes(2);
    }));
});

describe("task-run persistence barriers and recovery", () => {
  it.each([FINISHED, WAITING, { status: "failed", reason: "execution_error" },
    { status: "incomplete", reason: "step_limit" },
    { status: "canceled", reason: "user_stop" }] satisfies TaskRunDisposition[])(
  "does not replay a stored $status barrier with a stale active record", async disposition => {
    const name = `recovery-${disposition.status}`;
    let saved!: TaskRun;
    await inOverseer(name, async (impl, instance) => {
      setup(impl);
      using client = await open(instance);
      vi.mocked(runAgent).mockImplementationOnce(async (hooks, _model, chatId, author,
          _messages, _signal, _initiator, _callback, _compaction, execution) => {
        await hooks.commitAgentStep(chatId, author, [{ type: "message", message: "Stored final barrier" }], {
          ...NO_CHANGES, run: execution && { ...execution, disposition },
        });
        // The persisted barrier wins even if the in-memory finalizer reports something else.
        return { disposition: { status: "incomplete", reason: "interrupted" } };
      });
      const chatId = await client.newChat("Task", MODEL.profile.id);
      await impl.waitForAllAgentsToComplete();
      saved = currentRun(impl, chatId);
      expect(saved).toMatchObject(disposition);
      // Crash snapshot: final step committed, but active-record cleanup did not.
      impl.storage.chatMeta.put({ ...impl.getChatMetaOrThrow(chatId), activeAgent: MODEL.profile });
      impl.storage.activeAgents.put({ chatId, initiatorUserId: OWNER, initiator: USER,
        modelId: MODEL.profile.id, callbackInitiated: false, run: { id: saved.id, attempt: saved.attempt } });
    });
    vi.mocked(runAgent).mockClear();
    await abortAllDurableObjects();
    await inOverseer(name, async impl => {
      expect(impl.storage.taskRuns.get(saved.id)).toEqual(saved);
      expect(impl.getChatMetaOrThrow(saved.chatId).activeAgent).toBeUndefined();
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      expect(messages(impl, saved.chatId)).toHaveLength(2);
      expect(runAgent).not.toHaveBeenCalled();
    });
  });

  it("marks an interrupted callback incomplete rather than replaying expired return capabilities", async () => {
    const name = "callback-recovery";
    let saved!: TaskRun;
    await inOverseer(name, async impl => {
      addChat(impl);
      const sequence = impl.nextChatSequence(1);
      impl.storage.chats.put({ chatId: 1, sequence, author: USER, timestamp: new Date(100),
        type: "agentCallback", methodName: "wake", argsSummary: "[]" });
      const admitted = impl.admitTaskRun(1, sequence, { type: "callback" });
      saved = { ...admitted, status: "running", reason: undefined, attempt: 1 };
      // The durable half of an in-flight callback; its live return promise died with the isolate.
      impl.storage.taskRuns.put(saved);
      impl.storage.chatMeta.put({ ...impl.getChatMetaOrThrow(1), activeAgent: MODEL.profile });
      impl.storage.activeAgents.put({ chatId: 1, initiatorUserId: OWNER, initiator: USER,
        modelId: MODEL.profile.id, callbackInitiated: true, run: { id: saved.id, attempt: 1 } });
    });
    await abortAllDurableObjects();
    await inOverseer(name, async impl => {
      expect(currentRun(impl)).toMatchObject({ id: saved.id, attempt: 1, source: saved.source,
        sourceSequence: saved.sourceSequence, status: "incomplete", reason: "interrupted" });
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      expect(impl.getChatMetaOrThrow(1).activeAgent).toBeUndefined();
      expect(messages(impl)).toHaveLength(1);
      expect(runAgent).not.toHaveBeenCalled();
    });
  });

  it.for([FINISHED, WAITING])("reconciles a waiting external delivery after a stored $status barrier without inference", async (disposition, { skip }) => {
    const name = `external-recovery-${disposition.status}`;
    const idempotencyKey = `delivery-${disposition.status}`;
    let canRestore = false;
    await inOverseer(name, async impl => { canRestore = typeof impl.ctx.restore === "function"; });
    if (!canRestore) skip("This workerd pool has no ctx.restore() and cannot persist native RPC targets.");
    const delivered = vi.fn(async (_response: GadgetResponse) => {});
    let saved!: TaskRun;
    await inOverseer(name, async (impl, instance) => {
      setup(impl);
      // A transient new RpcStub cannot be serialized. Supply only the external target at the
      // restore boundary; ctx.restore creates the real persistent capability stored below.
      const prototype: Impl = Object.getPrototypeOf(impl);
      vi.spyOn(prototype, "restore").mockImplementation(() => new NativeRpcStub<ChatGatewayRpcTarget>(
        new class extends NativeRpcTarget {
          async onGadgetResponse(response: GadgetResponse) { await delivered(response); }
        }()));
      using target: NativeRpcStub<ChatGatewayRpcTarget> = await impl.ctx.restore({ type: "gadget", gadgetId: 1 });
      using client = await open(instance);
      vi.mocked(runAgent).mockImplementationOnce(async (hooks, _model, chatId, author,
          _history, _signal, _initiator, _callback, _compaction, execution) => {
        await hooks.commitAgentStep(chatId, author, [{ type: "message", message: "Stored response for the gateway" }], {
          ...NO_CHANGES, run: execution && { ...execution, disposition },
        });
        return { disposition };
      });
      const chatId = await client.newChat("External prompt", MODEL.profile.id);
      await impl.waitForAllAgentsToComplete();
      saved = currentRun(impl, chatId);
      // Crash snapshot: the final step committed, but cleanup never consumed the response target.
      impl.registerExternalMessageResponseTarget(idempotencyKey, chatId, saved.sourceSequence, target);
      impl.storage.chatMeta.put({ ...impl.getChatMetaOrThrow(chatId), activeAgent: MODEL.profile });
      impl.storage.activeAgents.put({ chatId, initiatorUserId: OWNER, initiator: USER,
        modelId: MODEL.profile.id, callbackInitiated: false, run: { id: saved.id, attempt: saved.attempt } });
      expect(impl.storage.gadgetResponseDeliveries.get(idempotencyKey)).toMatchObject({ status: "waiting" });
      expect(delivered).not.toHaveBeenCalled();
    });
    vi.mocked(runAgent).mockClear();
    await abortAllDurableObjects();
    await inOverseer(name, async impl => {
      await vi.waitFor(() => expect(impl.storage.gadgetResponseDeliveries.get(idempotencyKey))
        .toMatchObject({ status: "delivered", chatId: saved.chatId, promptSequence: saved.sourceSequence }));
      expect(delivered).toHaveBeenCalledExactlyOnceWith({ text: "Stored response for the gateway" });
      expect(impl.storage.taskRuns.get(saved.id)).toEqual(saved);
      expect(impl.getChatMetaOrThrow(saved.chatId).activeAgent).toBeUndefined();
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      expect(runAgent).not.toHaveBeenCalled();
    });
    await abortAllDurableObjects();
    await inOverseer(name, async impl => {
      expect(impl.storage.gadgetResponseDeliveries.get(idempotencyKey)?.status).toBe("delivered");
      expect(delivered).toHaveBeenCalledOnce();
      expect(runAgent).not.toHaveBeenCalled();
    });
  });

  it.each(["pause", "stop"] as const)("persists %s cancellation across late completion and restart", async kind => {
    const name = `cancel-${kind}`;
    let canceled!: TaskRun;
    await inOverseer(name, async (impl, instance) => {
      setup(impl);
      using client = await open(instance);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      vi.mocked(runAgent).mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { disposition: FINISHED };
      });
      const chatId = await client.newChat("Long task", MODEL.profile.id);
      await entered.promise;
      try {
        if (kind === "pause") await client.setAutomationPaused(true);
        else await client.stopAgent(chatId);
        canceled = currentRun(impl, chatId);
        expect(canceled).toMatchObject({ status: "canceled", attempt: 1,
          reason: kind === "pause" ? "workspace_paused" : "user_stop" });
        expect(impl.storage.activeAgents.get(chatId)).toBeUndefined();
        impl.finishTaskExecution({ id: canceled.id, attempt: canceled.attempt }, FINISHED);
        expect(currentRun(impl, chatId)).toEqual(canceled);
        if (kind === "pause") await client.setAutomationPaused(false);
      } finally {
        release.resolve();
        await impl.waitForAllAgentsToComplete();
      }
      const finishedCleanup = currentRun(impl, chatId);
      const evidence = (await client.getTaskRunEvidence(canceled.id)).entries;
      const error = evidence[0].message;
      expect(error).toMatchObject({ type: "error", runId: canceled.id,
        message: expect.stringContaining(kind === "pause" ? "automation is paused" : "stop agent") });
      expect(error).toEqual(await client.getChatMessage(chatId, error.sequence));
      expect(error.sequence).toBeGreaterThan(canceled.lastSequence);
      expect(finishedCleanup).toEqual({ ...canceled, lastSequence: error.sequence });
      canceled = finishedCleanup;
    });
    vi.mocked(runAgent).mockClear();
    await abortAllDurableObjects();
    await inOverseer(name, async (impl, instance) => {
      setup(impl);
      expect(impl.storage.taskRuns.get(canceled.id)).toEqual(canceled);
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      expect(impl.getChatMetaOrThrow(canceled.chatId).activeAgent).toBeUndefined();
      using client = await open(instance);
      const error = (await client.getTaskRunEvidence(canceled.id)).entries[0].message;
      expect(error).toMatchObject({ type: "error", runId: canceled.id, sequence: canceled.lastSequence });
      expect(error).toEqual(await client.getChatMessage(canceled.chatId, canceled.lastSequence));
      expect(runAgent).not.toHaveBeenCalled();
    });
  });

  it.each(["new", "send"] as const)("rolls back %s admission, source and indexes when storing the run fails", kind =>
    inOverseer(`admission-rollback-${kind}`, async (impl, instance) => {
      setup(impl);
      if (kind === "send") addChat(impl);
      using client = await open(instance);
      const before = [...impl.storage.chatMeta.list()];
      // Fail run insertion after the prompt and metadata writes, inside the real transaction.
      const fault: Subscriber<TaskRun> = {
        add() { throw new Error("injected admission failure"); }, update() {}, remove() {},
      };
      impl.storage.taskRuns.subscribe(fault);
      try {
        await expect(kind === "new" ? client.newChat("Rollback", MODEL.profile.id) :
          client.sendChatMessage(1, "Rollback", MODEL.profile.id)).rejects.toThrow("injected admission failure");
      } finally {
        impl.storage.taskRuns.unsubscribe(fault);
      }
      expect([...impl.storage.taskRuns.list()]).toEqual([]);
      expect([...impl.storage.taskRuns.byChatSource.list()]).toEqual([]);
      expect([...impl.storage.chats.list()]).toEqual([]);
      expect([...impl.storage.chats.byRunSequence.list()]).toEqual([]);
      expect([...impl.storage.chatMeta.list()]).toEqual(before);
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      expect(runAgent).not.toHaveBeenCalled();
    }));

  it("does not let an old post-turn finalizer detach the replacement run after pause/resume", () =>
    inOverseer("replacement-finalizer", async (impl, instance) => {
      setup(impl);
      addChat(impl);
      const cleaning = Promise.withResolvers<void>();
      const releaseCleanup = Promise.withResolvers<void>();
      const reconcile = impl.reconcilePendingGadgets.bind(impl);
      vi.spyOn(impl, "reconcilePendingGadgets").mockImplementation(reconcile)
        .mockImplementationOnce(reconcile)
        .mockImplementationOnce(async chatId => {
          cleaning.resolve();
          await releaseCleanup.promise;
          await reconcile(chatId);
        });
      using client = await open(instance);
      await client.sendChatMessage(1, "First task", MODEL.profile.id);
      await cleaning.promise;
      const first = currentRun(impl);
      expect(first).toMatchObject(FINISHED);
      expect(impl.getChatMetaOrThrow(1).activeAgent).toEqual(MODEL.profile);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      vi.mocked(runAgent).mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { disposition: FINISHED };
      });
      try {
        await client.setAutomationPaused(true);
        impl.destroyLiveChat(1);
        await client.setAutomationPaused(false);
        // Same chat/model/initiator, but a distinct live context owns the replacement execution.
        const replacementRun = admit(impl);
        impl.storage.chatMeta.put({ ...impl.getChatMetaOrThrow(1), activeAgent: MODEL.profile });
        impl.startAgent(1, MODEL, USER, OWNER);
        await entered.promise;
        const replacement = currentRun(impl);
        expect(replacement.id).toBe(replacementRun.id);
        expect(replacement.id).not.toBe(first.id);
        const callbackSettled = vi.fn();
        const callback = impl.deliverAgentCallback(1, "wakeReplacement", [], OWNER, MODEL.profile.id)
          .then(callbackSettled, callbackSettled);
        const idle = vi.fn();
        const waitingForIdle = impl.waitForAllAgentsToComplete().then(idle);
        releaseCleanup.resolve();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(currentRun(impl)).toEqual(replacement);
        expect(impl.storage.taskRuns.get(first.id)).toEqual(first);
        expect(impl.storage.activeAgents.get(1)?.run).toEqual({ id: replacement.id, attempt: 1 });
        expect(impl.getChatMetaOrThrow(1).activeAgent).toEqual(MODEL.profile);
        expect(callbackSettled).not.toHaveBeenCalled();
        expect(idle).not.toHaveBeenCalled();
        await client.setAutomationPaused(true);
        await callback;
        expect(callbackSettled).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: expect.stringContaining("automation is paused") }));
        release.resolve();
        await waitingForIdle;
      } finally {
        releaseCleanup.resolve();
        await client.setAutomationPaused(true);
        release.resolve();
        await impl.waitForAllAgentsToComplete();
      }
      expect(currentRun(impl)).toMatchObject({ status: "canceled", reason: "workspace_paused" });
      expect(impl.storage.taskRuns.get(first.id)).toEqual(first);
      expect(impl.getChatMetaOrThrow(1).activeAgent).toBeUndefined();
    }));

  it("rolls back the disposition, evidence and output stamp together, then permits the same step", () =>
    inOverseer("step-rollback", async (impl, instance) => {
      setup(impl);
      addChat(impl);
      const run = admit(impl);
      const gadget = impl.createGadget("Draft", "DRAFT", 1);
      const step = { run: { id: run.id, attempt: run.attempt, disposition: FINISHED },
        changes: [{ change: { [gadget.id]: [["draft.md", { set: "Draft content" }]] } }],
        createdGadgets: [{ gadgetId: gadget.id, title: gadget.title, bindingName: gadget.bindingName }],
        addedBindings: [],
      } satisfies Parameters<Impl["commitAgentStep"]>[3];
      const before = impl.getChatMetaOrThrow(1);
      const fault: Subscriber<TaskRun> = {
        add() {}, remove() {}, update(_old, next) {
          if (next.status === "finished") throw new Error("injected final barrier failure");
        },
      };
      impl.storage.taskRuns.subscribe(fault);
      try {
        await expect(impl.commitAgentStep(1, MODEL.profile,
          [{ type: "message", message: "Draft ready" }], step)).rejects.toThrow("injected final barrier failure");
      } finally {
        impl.storage.taskRuns.unsubscribe(fault);
      }
      expect(impl.storage.taskRuns.get(run.id)).toEqual(run);
      expect(impl.getChatMetaOrThrow(1)).toEqual(before);
      expect(messages(impl)).toHaveLength(1);
      expect([...impl.storage.chatChanges.list()]).toEqual([]);
      expect(impl.storage.gadgets.get(gadget.id)?.pending).toEqual({ chatId: 1 });
      expect((await impl.buildChatContent(1)).get(gadget.id)?.get("draft.md")).toBeUndefined();
      using client = await open(instance);
      expect((await client.getTaskRunEvidence(run.id)).entries).toHaveLength(1);

      expect(await impl.commitAgentStep(1, MODEL.profile, [{ type: "message", message: "Draft ready" }], step)).toBe(true);
      const evidence = (await client.getTaskRunEvidence(run.id)).entries;
      expect(evidence.map(e => e.message.type)).toEqual(["changes", "message", "message"]);
      expect(evidence.every(e => e.message.runId === run.id)).toBe(true);
      expect(evidence[0]).toMatchObject({ changeState: "proposed", message: { sequence: 2 } });
      expect(impl.storage.gadgets.get(gadget.id)?.pending).toEqual({ chatId: 1, sequence: 2 });
      expect(currentRun(impl)).toMatchObject({ ...FINISHED, lastSequence: 2 });
      expect((await impl.buildChatContent(1)).get(gadget.id)?.get("draft.md")).toBe("Draft content");
    }));
});

describe("canonical task evidence and API boundaries", () => {
  it.each(["merge", "revert"] as const)("reflects a later %s for every contributing run without rewriting completion", decision =>
    inOverseer(`output-${decision}`, async (impl, instance) => {
      setup(impl);
      addChat(impl);
      using client = await open(instance);
      const first = admit(impl);
      const gadget = impl.createGadget("Report", "REPORT", 1);
      await impl.commitAgentStep(1, MODEL.profile, [{ type: "message", message: "Report ready" }], {
        changes: [{ change: { [gadget.id]: [["report.md", { set: "First draft" }]] } }],
        createdGadgets: [{ gadgetId: gadget.id, title: gadget.title, bindingName: gadget.bindingName }],
        addedBindings: [], run: { id: first.id, attempt: first.attempt, disposition: FINISHED },
      });
      const second = admit(impl);
      await impl.commitAgentStep(1, MODEL.profile, [{ type: "message", message: "Added sources" }], {
        ...NO_CHANGES, changes: [{ change: { [gadget.id]: [["sources.md", { set: "Selected sources" }]] } }],
        run: { id: second.id, attempt: second.attempt, disposition: FINISHED },
      });
      const saved = (await client.listTaskRuns(1)).runs;
      for (const run of saved) {
        expect(run).toMatchObject(FINISHED);
        expect((await client.getTaskRunEvidence(run.id)).entries[0]).toMatchObject({ changeState: "proposed" });
      }
      const historyBefore = await client.getChatHistory(1);
      expect([...impl.storage.taskChangeDecisions.list()]).toEqual([]);
      if (decision === "merge") {
        expect(await client.mergeChanges(1)).toEqual({ outcome: "merged" });
        const head = impl.getGadgetHead(gadget.id)!;
        expect(await impl.gitStore.readCommitFiles(head))
          .toEqual(new Map([["report.md", "First draft"], ["sources.md", "Selected sources"]]));
        expect(impl.storage.gadgets.get(gadget.id)?.pending).toBeUndefined();
      } else {
        const changeSequence = (await client.getTaskRunEvidence(first.id)).entries[0].message.sequence;
        await client.revertChanges(1, changeSequence);
        expect(impl.storage.gadgets.get(gadget.id)).toBeUndefined();
      }
      const historyAfter = await client.getChatHistory(1);
      expect(historyAfter.messages.slice(0, historyBefore.messages.length)).toEqual(historyBefore.messages);
      const canonicalDecisions = historyAfter.messages.filter(m => m.type === "merge" || m.type === "revert");
      expect(canonicalDecisions).toHaveLength(1);
      expect([...impl.storage.taskChangeDecisions.list()]).toEqual(canonicalDecisions);
      for (const run of saved) {
        const page = await client.getTaskRunEvidence(run.id);
        expect(page.entries[0]).toMatchObject({ changeState: decision === "merge" ? "merged" : "reverted" });
        expect(page.entries.every(e => e.message.runId === run.id)).toBe(true);
        expect(page.entries.some(e => e.message.type === "merge" || e.message.type === "revert")).toBe(false);
        expect(impl.storage.taskRuns.get(run.id)).toEqual(run);
      }
      expect(await client.getChatHistory(1)).toEqual(historyAfter);
    }));

  it("keeps sparse decisions canonical across later runs, overlapping decisions, restart and chat deletion", async () => {
    const name = "sparse-decisions";
    let first!: TaskRun;
    let second!: TaskRun;
    let later!: TaskRun;
    let history!: ReturnType<typeof messages>;
    await inOverseer(name, async (impl, instance) => {
      setup(impl);
      addChat(impl);
      addChat(impl, 2);
      using client = await open(instance);
      first = admit(impl);
      const gadget = impl.createGadget("Report", "REPORT", 1);
      await impl.commitAgentStep(1, MODEL.profile, [{ type: "message", message: "Initial draft" }], {
        changes: [{ change: { [gadget.id]: [["report.md", { set: "First draft" }]] } }],
        createdGadgets: [{ gadgetId: gadget.id, title: gadget.title, bindingName: gadget.bindingName }],
        addedBindings: [], run: { id: first.id, attempt: first.attempt, disposition: FINISHED },
      });
      const firstChange = messages(impl).at(-1)!;
      second = admit(impl);
      await impl.commitAgentStep(1, MODEL.profile, [{ type: "message", message: "Review this addition" }], {
        ...NO_CHANGES, changes: [{ change: { [gadget.id]: [["extra.md", { set: "Unwanted addition" }]] } }],
        run: { id: second.id, attempt: second.attempt, disposition: FINISHED },
      });
      const secondChange = messages(impl).at(-1)!;
      later = admit(impl);
      await impl.commitAgentStep(1, MODEL.profile, [{ type: "message", message: "Review the earlier drafts" }], {
        ...NO_CHANGES, run: { id: later.id, attempt: later.attempt, disposition: FINISHED },
      });
      for (let i = 0; i < 60; i++) {
        impl.addChatMessages(1, USER, [{ type: "message", message: `Human review note ${i}` }]);
      }
      const before = messages(impl);
      expect([...impl.storage.taskChangeDecisions.list()]).toEqual([]);
      expect(currentRun(impl).id).toBe(later.id);
      await client.revertChanges(1, secondChange.sequence);
      await client.mergeChanges(1);
      const after = messages(impl);
      expect(after.slice(0, before.length)).toEqual(before);
      const decisions = after.filter(m => m.type === "merge" || m.type === "revert");
      expect(decisions).toHaveLength(2);
      expect(decisions).toMatchObject([
        { type: "revert", revertFrom: secondChange.sequence },
        { type: "merge", mergeThrough: expect.any(Number) },
      ]);
      expect([...impl.storage.taskChangeDecisions.list()]).toEqual(decisions);
      // Both decisions are newer than both batches, and the later merge covers the reverted
      // batch too. The earlier rejection wins; none of this rewrites either source run.
      expect(decisions[0].sequence).toBeGreaterThan(secondChange.sequence);
      const transcriptScan = vi.spyOn(impl.storage.chats, "list");
      const decisionScan = vi.spyOn(impl.storage.taskChangeDecisions, "list");
      expect((await client.getTaskRunEvidence(first.id)).entries[0])
        .toMatchObject({ message: firstChange, changeState: "merged" });
      expect((await client.getTaskRunEvidence(second.id)).entries[0])
        .toMatchObject({ message: secondChange, changeState: "reverted" });
      expect((await client.getTaskRunEvidence(later.id)).entries.every(e => e.changeState === undefined)).toBe(true);
      expect(transcriptScan).not.toHaveBeenCalled();
      expect(decisionScan).toHaveBeenCalledTimes(2);
      expect(decisionScan).toHaveBeenCalledWith({ prefix: `${keyString(1)}.`,
        start: `${keyString(1)}.${keyString(firstChange.sequence)}` });
      transcriptScan.mockRestore();
      decisionScan.mockRestore();
      expect((await client.getChatHistory(1)).messages).toEqual(after);
      history = after;
      expect(await impl.gitStore.readCommitFiles(impl.getGadgetHead(gadget.id)!))
        .toEqual(new Map([["report.md", "First draft"]]));
      first = impl.storage.taskRuns.get(first.id)!;
      second = impl.storage.taskRuns.get(second.id)!;
      later = impl.storage.taskRuns.get(later.id)!;
      // A decision in a different chat cannot participate in this chat's sparse scan.
      impl.addChatMessages(2, USER, [{ type: "revert", revertFrom: 0 }]);
    });
    await abortAllDurableObjects();
    await inOverseer(name, async (impl, instance) => {
      setup(impl);
      using client = await open(instance);
      const before = await client.getChatHistory(1);
      expect(before.messages).toEqual(history);
      expect((await client.getTaskRunEvidence(first.id)).entries[0].changeState).toBe("merged");
      expect((await client.getTaskRunEvidence(second.id)).entries[0].changeState).toBe("reverted");
      expect(await client.listTaskRuns(1)).toEqual({ runs: [later, second, first] });
      expect(await client.getChatHistory(1)).toEqual(before);
      expect([...impl.storage.taskChangeDecisions.list({ prefix: `${keyString(1)}.` })])
        .toEqual(before.messages.filter(m => m.type === "merge" || m.type === "revert"));
      await client.deleteChat(1);
      expect([...impl.storage.taskChangeDecisions.list()]).toEqual(messages(impl, 2));
      expect(runAgent).not.toHaveBeenCalled();
    });
  });

  it("hydrates canonical approved/rejected actions rather than stale embedded cards after completion", () =>
    inOverseer("action-evidence", async (impl, instance) => {
      setup(impl);
      addChat(impl);
      const run = admit(impl);
      putAction(impl.storage, 1);
      putAction(impl.storage, 2);
      await impl.commitAgentStep(1, MODEL.profile, [
        { type: "action", actionId: 1 }, { type: "action", actionId: 2 },
      ], { ...NO_CHANGES, run: { id: run.id, attempt: run.attempt, disposition: FINISHED } });
      using client = await open(instance);
      const saved = currentRun(impl);
      const pending = await client.getTaskRunEvidence(run.id);
      expect(pending.entries.slice(0, 2).map(e => e.message)).toMatchObject([
        { actionLog: { state: "pending" } }, { actionLog: { state: "pending" } },
      ]);
      // Canonical decision snapshots, as persisted by the approval/rejection paths. No remote
      // gatekeeper is invoked: this test isolates evidence hydration from external side effects.
      for (const [id, state] of [[1, "approved"], [2, "rejected"]] as const) {
        const action = impl.storage.actions.get(id);
        if (action?.type !== "action") throw new Error("Expected action fixture");
        impl.storage.actions.put({ ...action, state,
          resolvedBy: USER, appliedAt: new Date(100 + id) });
      }
      const page = await client.getTaskRunEvidence(run.id);
      expect(page.entries.slice(0, 2).map(e => e.message)).toMatchObject([
        { actionId: 2, actionLog: { state: "rejected", resolvedBy: USER } },
        { actionId: 1, actionLog: { state: "approved", resolvedBy: USER } },
      ]);
      for (const { message } of page.entries) {
        expect(message).toEqual(await client.getChatMessage(1, message.sequence));
      }
      expect(currentRun(impl)).toEqual(saved);
      expect(runAgent).not.toHaveBeenCalled();
    }));

  it("reads a canonical connection denial without resuming or changing a waiting run", () =>
    inOverseer("denied-evidence", async (impl, instance) => {
      setup(impl);
      using client = await open(instance);
      waitForConnection();
      const chatId = await client.newChat("Read a source", MODEL.profile.id);
      await impl.waitForAllAgentsToComplete();
      const run = currentRun(impl, chatId);
      await client.denyConnectionRequest(`${chatId}:connection`);
      expect((await client.getTaskRunEvidence(run.id)).entries[0].message).toMatchObject({ state: "denied" });
      expect(currentRun(impl, chatId)).toEqual(run);
      expect(runAgent).toHaveBeenCalledOnce();
    }));

  it("paginates runs by exclusive source sequence, not ID, last update, or another chat", () =>
    inOverseer("run-pages", async (impl, instance) => {
      setup(impl);
      addChat(impl);
      addChat(impl, 2);
      addChat(impl, 3);
      impl.addChatMessages(3, USER, [{ type: "message", message: "Legacy untracked history" }]);
      const runs: TaskRun[] = [];
      for (let i = 0; i < 65; i++) {
        runs.push(admit(impl));
        admit(impl, 2);
      }
      impl.finishTaskExecution(runs[0], FINISHED); // Updating old work must not reorder history.
      using client = await open(instance);
      const first = await client.listTaskRuns(1);
      const second = await client.listTaskRuns(1, first.nextBeforeSequence);
      const third = await client.listTaskRuns(1, second.nextBeforeSequence);
      expect([first.runs.length, second.runs.length, third.runs.length]).toEqual([30, 30, 5]);
      expect(first.nextBeforeSequence).toBe(first.runs.at(-1)!.sourceSequence);
      expect(second.nextBeforeSequence).toBe(second.runs.at(-1)!.sourceSequence);
      expect(third.nextBeforeSequence).toBeUndefined();
      expect([...first.runs, ...second.runs, ...third.runs].map(r => r.id))
        .toEqual(runs.map(r => r.id).toReversed());
      expect(await client.listTaskRuns(1, 0)).toEqual({ runs: [] });
      const exact = await client.listTaskRuns(1, runs[30].sourceSequence);
      expect(exact.runs).toHaveLength(30);
      expect(exact.nextBeforeSequence).toBeUndefined();
      expect(await client.listTaskRuns(3)).toEqual({ runs: [] });
    }));

  it("paginates only attributed evidence across gaps, newer tasks, and legacy messages", () =>
    inOverseer("evidence-pages", async (impl, instance) => {
      setup(impl);
      addChat(impl);
      addChat(impl, 2);
      const run = admit(impl);
      const sequences = [run.sourceSequence];
      for (let i = 0; i < 104; i++) {
        impl.addChatMessages(1, USER, [{ type: "message", message: "Unattributed human edit" }]);
        await impl.commitAgentStep(1, MODEL.profile, [{ type: "message", message: `Evidence ${i}` }], {
          ...NO_CHANGES, run: { id: run.id, attempt: run.attempt },
        });
        sequences.push(messages(impl).at(-1)!.sequence);
      }
      impl.finishTaskExecution(run, FINISHED);
      admit(impl);
      admit(impl, 2);
      using client = await open(instance);
      const first = await client.getTaskRunEvidence(run.id);
      const second = await client.getTaskRunEvidence(run.id, first.nextBeforeSequence);
      const third = await client.getTaskRunEvidence(run.id, second.nextBeforeSequence);
      expect([first.entries.length, second.entries.length, third.entries.length]).toEqual([50, 50, 5]);
      expect(first.nextBeforeSequence).toBe(first.entries.at(-1)!.message.sequence);
      expect(second.nextBeforeSequence).toBe(second.entries.at(-1)!.message.sequence);
      expect(third.nextBeforeSequence).toBeUndefined();
      const entries = [...first.entries, ...second.entries, ...third.entries];
      expect(entries.map(e => e.message.sequence)).toEqual(sequences.toReversed());
      expect(entries.every(e => e.message.runId === run.id && e.message.chatId === 1)).toBe(true);
      expect(await client.getTaskRunEvidence(run.id, 0)).toEqual({ entries: [] });
      const exact = await client.getTaskRunEvidence(run.id, entries[54].message.sequence);
      expect(exact.entries).toHaveLength(50);
      expect(exact.nextBeforeSequence).toBeUndefined();
    }));

  it("deletes only the chat's runs and indexes, and late steps/finalizers cannot resurrect them", async () => {
    const name = "delete";
    let deleted!: TaskRun;
    let kept!: TaskRun;
    await inOverseer(name, async (impl, instance) => {
      setup(impl);
      addChat(impl);
      addChat(impl, 2);
      deleted = admit(impl);
      admit(impl);
      kept = admit(impl, 2);
      impl.finishTaskExecution(kept, FINISHED);
      using client = await open(instance);
      await client.deleteChat(1);
      impl.finishTaskExecution(deleted, FINISHED);
      expect(await impl.commitAgentStep(1, MODEL.profile, [{ type: "message", message: "Late result" }], {
        ...NO_CHANGES, run: { id: deleted.id, attempt: deleted.attempt, disposition: FINISHED },
      })).toBe(false);
      expect([...impl.storage.taskRuns.list()].map(r => r.id)).toEqual([kept.id]);
      expect([...impl.storage.taskRuns.byChatSource.list({ prefix: `${keyString(1)}.` })]).toEqual([]);
      expect([...impl.storage.chats.byRunSequence.list({ prefix: `${deleted.id}.` })]).toEqual([]);
      expect(messages(impl)).toEqual([]);
      await expect(client.getTaskRunEvidence(deleted.id)).rejects.toThrow("No such task run");
      await expect(client.listTaskRuns(1)).rejects.toThrow("No such chatId");
    });
    await abortAllDurableObjects();
    await inOverseer(name, async impl => {
      expect(impl.storage.taskRuns.get(deleted.id)).toBeUndefined();
      expect(impl.storage.chatMeta.get(1)).toBeUndefined();
      expect([...impl.storage.taskRuns.list()].map(r => r.id)).toEqual([kept.id]);
      expect(runAgent).not.toHaveBeenCalled();
    });
  });

  it("rejects missing runs/chats and denies use-only observers even for existing evidence", () =>
    inOverseer("access", async (impl, instance) => {
      setup(impl, "use");
      addChat(impl);
      const run = admit(impl);
      using editor = await open(instance);
      expect((await editor.listTaskRuns(1)).runs).toEqual([run]);
      await expect(editor.getTaskRunEvidence("missing")).rejects.toThrow("No such task run");
      await expect(editor.listTaskRuns(999)).rejects.toThrow("No such chatId");
      using observer = await open(instance, "observer");
      await expect(observer.listTaskRuns(1)).rejects.toThrow("Unauthorized");
      await expect(observer.getTaskRunEvidence(run.id)).rejects.toThrow("Unauthorized");
      await expect(observer.getTaskRunEvidence("missing")).rejects.toThrow("Unauthorized");
      impl.storage.chatMeta.delete(1);
      await expect(editor.getTaskRunEvidence(run.id)).rejects.toThrow("No such task run");
    }));
});
