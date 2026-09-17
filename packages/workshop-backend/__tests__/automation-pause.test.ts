import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { RpcStub } from "capnweb";
import type { AiChatAuthorInfo, AgentProfile, GadgetMetadata } from "@gadgets/workshop-shared/api";
import { keyString } from "@gadgets/typed-storage";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserAiModelRecord, UserChatContext, UserDurableObject } from "../src/user.js";
import { enqueueChatQueueItem, publicChatQueue } from "../src/chat-queue.js";
import { putAction } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];
const OWNER = "owner-id";
const USER: AiChatAuthorInfo = { type: "user", id: "owner", name: "Owner" };
const MODEL: UserAiModelRecord = {
  profile: { type: "agent", id: "test-model", name: "Test model" },
  config: { provider: "anthropic", model: "test-model", apiToken: "unused" },
};
const AGENT: AgentProfile = {
  id: "bot", name: "Bot", title: "Bot", description: "", defaultModelId: MODEL.profile.id,
  workspaceId: "workspace", created: new Date(0), updated: new Date(0),
};

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Pause tests forbid provider calls"));
});
afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

function inOverseer(name: string, fn: (impl: Impl, instance: OverseerDurableObject) => Promise<void>) {
  return runInDurableObject(env.TEST_OVERSEER.getByName(name), (instance: OverseerDurableObject) =>
    fn(instance["impl"], instance));
}

// Only remote dependencies are mocked; admission, storage, queue consumption, approvals and turn
// teardown all run through the production OverseerImpl over real SQLite storage in workerd.
function setup(impl: Impl, role: "build" | "use" = "build") {
  impl.ownerId = OWNER;
  let user = {
    id: { toString: () => OWNER },
    whoami: vi.fn(async () => USER),
    getChatContext: vi.fn(async (): Promise<UserChatContext> => ({ profile: USER })),
    getAgent: vi.fn(async () => AGENT),
    getGroupByWorkspaceId: vi.fn(async () => null),
    getAgentByWorkspaceId: vi.fn(async () => AGENT),
    getRoutineById: vi.fn(async (): ReturnType<UserDurableObject["getRoutineById"]> => ({
      id: "routine", agentId: AGENT.id, name: "Routine", prompt: "Do work", paused: false,
      schedule: { kind: "interval", everyMs: 60_000 }, created: new Date(0), updated: new Date(0),
    })),
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
  vi.spyOn(impl, "syncOutputsTo").mockResolvedValue(undefined);
  vi.spyOn(impl, "joinOutputsFanout").mockReturnValue(() => {});
  vi.spyOn(impl, "recordGadgetAnalytics").mockImplementation(() => {});
  return user;
}

function addChat(impl: Impl, id = 1, queuePaused?: true) {
  impl.storage.chatMeta.put({ id, title: "Chat", started: new Date(id), lastActive: new Date(id), queuePaused });
}

function enqueue(impl: Impl, chatId = 1, message = "queued task") {
  return enqueueChatQueueItem(impl.storage.chatQueue, chatId, { message, modelId: null, initiatorUserId: OWNER });
}

function messages(impl: Impl, chatId = 1) {
  return [...impl.storage.chats.list({ prefix: `${keyString(chatId)}.` })];
}

async function open(instance: OverseerDurableObject, userId = OWNER) {
  using closed = new NativeRpcStub<() => void>(() => {});
  return await instance.open(userId, userId === OWNER ? USER.id : userId, closed);
}

describe("workspace automation pause", () => {
  it("persists through restart and fences recovered active agents and queues", async () => {
    const name = "automation-restart";
    await inOverseer(name, async impl => {
      addChat(impl);
      enqueue(impl);
      await impl.setAutomationPaused(true);
      // Simulate a crash after the durable fence but before old-turn cleanup.
      impl.storage.chatMeta.put({ ...impl.getChatMetaOrThrow(1), activeAgent: MODEL.profile });
      impl.storage.activeAgents.put({ chatId: 1, initiatorUserId: OWNER,
        modelId: MODEL.profile.id, initiator: USER, callbackInitiated: false });
    });
    await abortAllDurableObjects();
    await inOverseer(name, async impl => {
      expect(impl.storage.automationPaused.get()).toBe(true);
      expect(() => impl.assertAutomationAllowed()).toThrow("Workspace automation is paused");
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      expect(impl.getChatMetaOrThrow(1).activeAgent).toBeUndefined();
      expect(publicChatQueue(impl.storage.chatQueue, 1)).toHaveLength(1);
      expect(messages(impl).some(m => m.type === "error" && m.message.includes("automation is paused"))).toBe(true);
      await impl.drainChatQueue(1);
      expect(publicChatQueue(impl.storage.chatQueue, 1)).toHaveLength(1);
    });
  });

  it("flushes the pause fence before aborting live callbacks and cancels the current turn", () =>
    inOverseer("automation-flush", async impl => {
      let user = setup(impl);
      addChat(impl);
      impl.storage.chatContext.put({ chatId: 1, agentId: AGENT.id });
      const preparation = Promise.withResolvers<void>();
      vi.spyOn(impl, "reconcilePendingGadgets").mockImplementationOnce(() => preparation.promise);
      impl.storage.chatMeta.put({ ...impl.getChatMetaOrThrow(1), activeAgent: MODEL.profile });
      impl.startAgent(1, MODEL, USER, OWNER);
      let callbackSettled = false;
      let callback = impl.deliverAgentCallback(1, "wake", [], OWNER, MODEL.profile.id)
        .catch(error => { callbackSettled = true; return error; });
      const sync = Promise.withResolvers<void>();
      vi.spyOn(impl.ctx.storage, "sync").mockImplementationOnce(() => {
        expect(impl.storage.automationPaused.get()).toBe(true);
        expect([...impl.storage.activeAgents.list()]).toEqual([]);
        expect(callbackSettled).toBe(false);
        return sync.promise;
      });
      let pausing = impl.setAutomationPaused(true);
      sync.resolve();
      await pausing;
      expect((await callback).message).toContain("automation is paused");
      // An explicit resume does not revive this canceled turn or its callbacks.
      await impl.setAutomationPaused(false);
      preparation.resolve();
      await impl.waitForAllAgentsToComplete();
      expect(impl.getChatMetaOrThrow(1).activeAgent).toBeUndefined();
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      expect(messages(impl).filter(m => m.type === "agentCallback")).toEqual([]);
      expect(user.getAgent).not.toHaveBeenCalled();
    }));

  it("does not let an old finalizer detach a replacement turn after paused cleanup", () =>
    inOverseer("automation-finalizer-owner", async impl => {
      setup(impl);
      addChat(impl);
      let cleaningA = Promise.withResolvers<void>();
      let releaseA = Promise.withResolvers<void>();
      let preparingB = Promise.withResolvers<void>();
      let releaseB = Promise.withResolvers<void>();
      vi.spyOn(impl, "reconcilePendingGadgets").mockResolvedValue(undefined)
        .mockRejectedValueOnce(new Error("test turn A completed without inference"))
        .mockImplementationOnce(() => { cleaningA.resolve(); return releaseA.promise; })
        .mockImplementationOnce(() => { preparingB.resolve(); return releaseB.promise; });
      impl.storage.chatMeta.put({ ...impl.getChatMetaOrThrow(1), activeAgent: MODEL.profile });
      impl.startAgent(1, MODEL, USER, OWNER);
      await cleaningA.promise;
      try {
        await impl.setAutomationPaused(true);
        impl.destroyLiveChat(1);
        await impl.setAutomationPaused(false);
        // Same chat/model/initiator, different live context. A still owns its delayed finalizer.
        impl.storage.chatMeta.put({ ...impl.getChatMetaOrThrow(1), activeAgent: MODEL.profile });
        impl.startAgent(1, MODEL, USER, OWNER);
        await preparingB.promise;
        const recordB = impl.storage.activeAgents.get(1);
        expect(recordB).toBeDefined();
        const callbackSettled = vi.fn();
        const callback = impl.deliverAgentCallback(1, "wakeB", [], OWNER, MODEL.profile.id)
          .then(callbackSettled, callbackSettled);
        const idle = vi.fn();
        const waitingForIdle = impl.waitForAllAgentsToComplete().then(idle);
        releaseA.resolve();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(impl.getChatMetaOrThrow(1).activeAgent).toEqual(MODEL.profile);
        expect(impl.storage.activeAgents.get(1)).toEqual(recordB);
        expect(callbackSettled).not.toHaveBeenCalled();
        expect(idle).not.toHaveBeenCalled();
        // The callback must still be reachable through B's live context, not orphaned by A.
        await impl.setAutomationPaused(true);
        await callback;
        expect(callbackSettled).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: expect.stringContaining("automation is paused") }));
        releaseB.resolve();
        await waitingForIdle;
      } finally {
        releaseA.resolve();
        await impl.setAutomationPaused(true);
        releaseB.resolve();
        await impl.waitForAllAgentsToComplete();
      }
      expect(impl.getChatMetaOrThrow(1).activeAgent).toBeUndefined();
    }));

  it("clears orphan active metadata before draining a queue on restart after resume", async () => {
    const name = "automation-orphan-queue";
    await inOverseer(name, async impl => {
      addChat(impl);
      enqueue(impl);
      await impl.setAutomationPaused(true);
      // State after resume acknowledges but before the canceled live turn cleans up.
      impl.storage.automationPaused.put(false);
      impl.storage.chatMeta.put({ ...impl.getChatMetaOrThrow(1), activeAgent: MODEL.profile });
      const prototype: Impl = Object.getPrototypeOf(impl);
      const drain = prototype.drainChatQueue;
      vi.spyOn(prototype, "drainChatQueue").mockImplementationOnce(function (this: Impl, chatId) {
        setup(this); // Substitute only the newly constructed DO's remote User dependency.
        return drain.call(this, chatId);
      });
    });
    await abortAllDurableObjects();
    await inOverseer(name, async impl => {
      await vi.waitFor(() => expect(messages(impl).some(m => m.type === "message" && m.message === "queued task")).toBe(true));
      expect(publicChatQueue(impl.storage.chatQueue, 1)).toEqual([]);
      expect(impl.getChatMetaOrThrow(1).activeAgent).toBeUndefined();
    });
  });

  it.each(["pause", "stop"])("does not launch code when %s interrupts entrypoint verification", kind =>
    inOverseer(`automation-code-verify-${kind}`, async impl => {
      setup(impl);
      addChat(impl);
      let verification = Promise.withResolvers<void>();
      let verify = vi.fn(() => verification.promise);
      let run = vi.fn(async () => {});
      vi.spyOn(impl, "getEnvForAgent").mockReturnValue({});
      Object.assign(impl, { env: { ...impl.env, LOADER: { load: () => ({ getEntrypoint: () => ({ verify, run }) }) } } });
      // Hold the actual live agent at its first await so executeCodeMode captures its abort signal.
      let preparation = Promise.withResolvers<void>();
      vi.spyOn(impl, "reconcilePendingGadgets").mockResolvedValue(undefined)
        .mockReturnValueOnce(preparation.promise);
      impl.storage.chatMeta.put({ ...impl.getChatMetaOrThrow(1), activeAgent: MODEL.profile });
      impl.startAgent(1, MODEL, USER, OWNER);
      let execution = impl.executeCodeMode(1, "export default async () => {}", USER, MODEL.profile.id, {});
      let rejected = expect(execution).rejects.toThrow(kind === "pause" ? "automation is paused" : "stop agent");
      expect(verify).toHaveBeenCalledOnce();
      if (kind === "pause") {
        await impl.setAutomationPaused(true);
        await impl.setAutomationPaused(false);
      } else {
        impl.cancelAgent(1);
      }
      verification.resolve();
      await rejected;
      expect(run).not.toHaveBeenCalled();
      preparation.resolve();
      await impl.waitForAllAgentsToComplete();
    }));

  it("rejects explicit send, new chat, retry and spawns while paused, without resolving a model", () =>
    inOverseer("automation-explicit", async (impl, instance) => {
      let user = setup(impl);
      addChat(impl);
      using client = await open(instance);
      await client.setAutomationPaused(true);
      await expect(client.sendChatMessage(1, "run", null)).rejects.toThrow("automation is paused");
      await expect(client.newChat("run", null)).rejects.toThrow("automation is paused");
      await expect(client.retryAgent(1, MODEL.profile.id)).rejects.toThrow("automation is paused");
      await expect(instance.spawnAgent("run", "run", {
        displayName: "Spawner", modelId: MODEL.profile.id, env: {},
      })).rejects.toThrow("automation is paused");
      expect(user.getChatContext).not.toHaveBeenCalled();
      expect(messages(impl)).toEqual([]);
    }));

  it("invalidates a send already waiting on the User DO, even across pause then resume", () =>
    inOverseer("automation-stale-send", async (impl, instance) => {
      let user = setup(impl);
      addChat(impl);
      using client = await open(instance);
      let context = Promise.withResolvers<UserChatContext>();
      user.getChatContext.mockReturnValueOnce(context.promise);
      let send = client.sendChatMessage(1, "stale", null);
      let rejected = expect(send).rejects.toThrow("automation is paused");
      await client.setAutomationPaused(true);
      await client.setAutomationPaused(false);
      context.resolve({ profile: USER });
      await rejected;
      expect(messages(impl)).toEqual([]);
    }));

  it("preserves a queue head across an awaited admission and resumes only non-user-paused queues", () =>
    inOverseer("automation-queue", async (impl, instance) => {
      let user = setup(impl);
      addChat(impl);
      addChat(impl, 2, true);
      let head = enqueue(impl);
      enqueue(impl, 2);
      using client = await open(instance);
      let context = Promise.withResolvers<UserChatContext>();
      user.getChatContext.mockReturnValueOnce(context.promise);
      let drain = impl.drainChatQueue(1);
      expect(publicChatQueue(impl.storage.chatQueue, 1)[0].id).toBe(head.id);
      await client.setAutomationPaused(true);
      context.resolve({ profile: USER });
      await drain;
      expect(messages(impl)).toEqual([]);
      expect((await client.listChats()).every(m => m.queuePaused)).toBe(true);
      expect(impl.getChatMetaOrThrow(1).queuePaused).toBeUndefined();
      await client.setAutomationPaused(false);
      await vi.waitFor(() => expect(messages(impl)).toHaveLength(1));
      expect(publicChatQueue(impl.storage.chatQueue, 1)).toEqual([]);
      expect(publicChatQueue(impl.storage.chatQueue, 2)).toHaveLength(1);
      expect(impl.getChatMetaOrThrow(2).queuePaused).toBe(true);
    }));

  it("rechecks a per-chat pause after the queue's User DO await", () =>
    inOverseer("automation-queue-local-pause", async impl => {
      let user = setup(impl);
      addChat(impl);
      enqueue(impl);
      let context = Promise.withResolvers<UserChatContext>();
      user.getChatContext.mockReturnValueOnce(context.promise);
      let drain = impl.drainChatQueue(1);
      impl.setChatQueuePaused(1, true);
      context.resolve({ profile: USER });
      await drain;
      expect(publicChatQueue(impl.storage.chatQueue, 1)).toHaveLength(1);
      expect(messages(impl)).toEqual([]);
    }));

  it("does not lose a queue resume behind an old drain reservation", () =>
    inOverseer("automation-queue-resume-race", async impl => {
      let user = setup(impl);
      addChat(impl);
      enqueue(impl);
      let context = Promise.withResolvers<UserChatContext>();
      user.getChatContext.mockReturnValueOnce(context.promise);
      let drain = impl.drainChatQueue(1);
      await impl.setAutomationPaused(true);
      await impl.setAutomationPaused(false);
      context.resolve({ profile: USER });
      await drain;
      await vi.waitFor(() => expect(messages(impl)).toHaveLength(1));
      expect(user.getChatContext).toHaveBeenCalledTimes(2);
      expect(publicChatQueue(impl.storage.chatQueue, 1)).toEqual([]);
    }));

  it("honors edits and cancellation of the durable head while its admission is pending", () =>
    inOverseer("automation-queue-edit", async impl => {
      let user = setup(impl);
      addChat(impl);
      let first = enqueue(impl, 1, "old");
      let second = enqueue(impl, 1, "cancel me");
      let context = Promise.withResolvers<UserChatContext>();
      user.getChatContext.mockReturnValueOnce(context.promise);
      let drain = impl.drainChatQueue(1);
      impl.updateQueuedMessage(1, first.id, "new");
      impl.cancelQueuedMessage(1, second.id);
      context.resolve({ profile: USER });
      await drain;
      expect(messages(impl)).toMatchObject([{ type: "message", message: "new" }]);
      expect(publicChatQueue(impl.storage.chatQueue, 1)).toEqual([]);
    }));

  it("does not auto-apply while paused, including the next action of an in-flight drain", () =>
    inOverseer("automation-autoapproval", async impl => {
      addChat(impl);
      putAction(impl.storage, 1);
      putAction(impl.storage, 2);
      impl.storage.autoApproveTags.put({ gatekeeperId: 1,
        actionKind: { tag: "edit", label: "Edits" }, enabledBy: USER });
      let applying = Promise.withResolvers<void>();
      let applyAction = vi.fn(async () => {});
      applyAction.mockReturnValueOnce(applying.promise);
      Object.assign(impl, { getGatekeeperFacet: () => ({ applyAction }) });
      let drain = impl.drainAutoApprovals(1);
      await vi.waitFor(() => expect(applyAction).toHaveBeenCalledTimes(1));
      await impl.setAutomationPaused(true);
      applying.resolve();
      await drain;
      await impl.drainAutoApprovals(1);
      expect(applyAction).toHaveBeenCalledTimes(1);
      expect(impl.storage.actions.get(1)?.state).toBe("approved");
      expect(impl.storage.actions.get(2)?.state).toBe("pending");
      await impl.setAutomationPaused(false);
      await vi.waitFor(() => expect(impl.storage.actions.get(2)?.state).toBe("approved"));
      expect(applyAction).toHaveBeenCalledTimes(2);
    }));

  it("allows manual approval but neither resumes the agent nor cascades auto-approval", () =>
    inOverseer("automation-approval", async (impl, instance) => {
      let user = setup(impl);
      addChat(impl);
      putAction(impl.storage, 1);
      putAction(impl.storage, 2);
      let action = impl.storage.actions.get(1)!;
      if (action.type !== "action") throw new Error("Expected action");
      action.description.awaitDecision = true;
      impl.storage.actions.put(action);
      impl.addChatMessages(1, MODEL.profile, [{ type: "action", actionId: 1 }]);
      impl.storage.autoApproveTags.put({ gatekeeperId: 1,
        actionKind: { tag: "edit", label: "Edits" }, enabledBy: USER });
      let applyAction = vi.fn(async () => {});
      Object.assign(impl, { getGatekeeperFacet: () => ({ applyAction }) });
      using client = await open(instance);
      await client.setAutomationPaused(true);
      await client.approveAction(1);
      expect(applyAction).toHaveBeenCalledTimes(1);
      expect(impl.storage.actions.get(1)?.state).toBe("approved");
      expect(impl.storage.actions.get(2)?.state).toBe("pending");
      expect(user.getChatContext).not.toHaveBeenCalled();
      expect(impl.getChatMetaOrThrow(1).activeAgent).toBeUndefined();
      expect(messages(impl)).toHaveLength(1);
    }));

  it("rejects stale callback admission after model lookup and future callbacks while paused", () =>
    inOverseer("automation-callback", async impl => {
      let user = setup(impl);
      addChat(impl);
      let context = Promise.withResolvers<UserChatContext>();
      user.getChatContext.mockReturnValueOnce(context.promise);
      let callback = impl.deliverAgentCallback(1, "wake", [], OWNER, MODEL.profile.id);
      let rejected = expect(callback).rejects.toThrow("automation is paused");
      await impl.setAutomationPaused(true);
      await rejected;
      await expect(impl.deliverAgentCallback(1, "wake", [], OWNER, MODEL.profile.id))
        .rejects.toThrow("automation is paused");
      await impl.setAutomationPaused(false);
      context.resolve({ profile: USER, aiModel: MODEL });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(messages(impl)).toEqual([]);
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
    }));

  it("blocks a suspended-agent approval continuation parked on model lookup", () =>
    inOverseer("automation-approval-resume-race", async (impl, instance) => {
      let user = setup(impl);
      addChat(impl);
      impl.addChatMessages(1, MODEL.profile, [{ type: "connectionRequest", requestId: "1:request",
        bindingName: "RESOURCE", vendorId: "test", vendorName: "Test", resourceUrl: "https://example.com",
        state: "pending", reason: "Needed" }]);
      using client = await open(instance);
      let context = Promise.withResolvers<UserChatContext>();
      let resolving = Promise.withResolvers<void>();
      user.getChatContext.mockImplementationOnce(() => { resolving.resolve(); return context.promise; });
      let acceptance = client.acceptConnectionRequest("1:request", { gatekeeperId: 1 });
      await resolving.promise;
      await client.setAutomationPaused(true);
      await client.setAutomationPaused(false);
      context.resolve({ profile: USER, aiModel: MODEL });
      await acceptance;
      expect(impl.getChatMetaOrThrow(1).activeAgent).toBeUndefined();
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      expect(messages(impl)[0]).toMatchObject({ state: "accepted" });
    }));

  async function setupRoutine(impl: Impl) {
    let user = setup(impl);
    let routine = { ...(await user.getRoutineById())!, hookId: 7 };
    user.getRoutineById.mockResolvedValue(routine).mockClear();
    impl.storage.boundHooks.put({ id: 7, actionId: 7, gatekeeperId: 1, enabled: true,
      controller: null!, callback: null!, description: { title: "Routine", description: "Routine" },
      routine: { id: routine.id, registrationId: "registration", scheduleId: "schedule" } });
    const firing = { scheduleId: "schedule", runId: "occurrence", scheduledTime: 1,
      actualTime: 1, timeZone: "UTC" };
    return { user, firing };
  }

  it("skips workspace-paused and individually-paused routines, including after awaits", () =>
    inOverseer("automation-routine", async impl => {
      let { user, firing } = await setupRoutine(impl);
      await impl.setAutomationPaused(true);
      await impl.handleRoutineFire("routine", "registration", undefined, firing);
      expect(user.getRoutineById).not.toHaveBeenCalled();
      await impl.setAutomationPaused(false);
      await impl.handleRoutineFire("routine", "registration", undefined, firing);
      expect(user.getRoutineById).not.toHaveBeenCalled(); // A lost skip ack cannot replay after resume.
      let routine = await user.getRoutineById();
      user.getRoutineById.mockResolvedValueOnce({ ...routine!, paused: true });
      await impl.handleRoutineFire("routine", "registration", undefined, { ...firing, runId: "paused" });
      expect(user.getAgentByWorkspaceId).not.toHaveBeenCalled();
      let context = Promise.withResolvers<UserChatContext>();
      user.getChatContext.mockImplementationOnce(() => {
        user.getRoutineById.mockResolvedValue({ ...routine!, paused: true });
        return context.promise;
      });
      let delivery = impl.handleRoutineFire("routine", "registration", undefined, { ...firing, runId: "in-flight" });
      context.resolve({ profile: USER });
      await delivery;
      expect([...impl.storage.chatMeta.list()]).toEqual([]);
      expect([...impl.storage.routineOccurrences.list()]).toHaveLength(3);
    }));

  it("skips a routine firing caught in a workspace pause/resume cycle", () =>
    inOverseer("automation-routine-race", async impl => {
      let { user, firing } = await setupRoutine(impl);
      let context = Promise.withResolvers<UserChatContext>();
      let resolving = Promise.withResolvers<void>();
      user.getChatContext.mockImplementationOnce(() => { resolving.resolve(); return context.promise; });
      let delivery = impl.handleRoutineFire("routine", "registration", undefined, firing);
      await resolving.promise;
      await impl.setAutomationPaused(true);
      await impl.setAutomationPaused(false);
      context.resolve({ profile: USER });
      await delivery;
      await impl.handleRoutineFire("routine", "registration", undefined, firing);
      expect([...impl.storage.chatMeta.list()]).toEqual([]);
      expect([...impl.storage.routineOccurrences.list()]).toMatchObject([{ status: "skipped" }]);
    }));

  it.each(["pause", "delete", "stale-read", "revision", "registration", "schedule"])("rechecks routine admission after skill preparation: %s", change =>
    inOverseer(`automation-routine-skill-${change}`, async impl => {
      let { user, firing } = await setupRoutine(impl);
      let routine = { ...(await user.getRoutineById())!, prompt: "/skill", revision: 3, hookId: 7 };
      user.getRoutineById.mockResolvedValue(routine);
      user.getChatContext.mockResolvedValue({ profile: USER, agentProfile: AGENT });
      let skills = Promise.withResolvers<Awaited<ReturnType<UserDurableObject["listSkills"]>>>();
      let preparing = Promise.withResolvers<void>();
      Object.assign(user, { listSkills: () => { preparing.resolve(); return skills.promise; } });
      let delivery = impl.handleRoutineFire(routine.id, "registration", undefined, firing);
      await preparing.promise;
      if (change === "pause") user.getRoutineById.mockResolvedValue({ ...routine, paused: true, revision: 4 });
      if (change === "delete") user.getRoutineById.mockResolvedValue(undefined);
      if (change === "revision") user.getRoutineById.mockResolvedValue({ ...routine, revision: 4 });
      // Even a stale remote read must not bypass the hook deletion acknowledged by pause/delete.
      if (["pause", "delete", "stale-read"].includes(change)) impl.storage.boundHooks.delete(7);
      if (change === "registration" || change === "schedule") {
        let hook = impl.storage.boundHooks.get(7)!;
        if (change === "registration") hook.routine!.registrationId = "replacement";
        else hook.routine!.scheduleId = "replacement";
        impl.storage.boundHooks.put(hook);
      }
      skills.resolve([{ id: "skill", slug: "skill", name: "Skill", description: "",
        body: "Prepared task", created: new Date(0), updated: new Date(0) }]);
      await delivery;
      expect([...impl.storage.chatMeta.list()]).toEqual([]);
      expect(impl.automationGeneration).toBe(0);
    }));

  it.each(["new", "existing"])("stops %s group fanout after awaited member lookup", kind =>
    inOverseer(`automation-group-${kind}`, async (impl, instance) => {
      let user = setup(impl);
      addChat(impl);
      user.getChatContext.mockResolvedValue({ profile: USER, aiModel: MODEL, group: {
        id: "group", workspaceId: impl.ctx.id.toString(), name: "Group",
        memberAgentIds: ["one", "two"], created: new Date(0), updated: new Date(0),
      } });
      user.getAgent.mockImplementationOnce(async () => {
        await impl.setAutomationPaused(true);
        await impl.setAutomationPaused(false);
        return AGENT;
      });
      using client = await open(instance);
      if (kind === "new") await client.newChat("run", MODEL.profile.id);
      else await client.sendChatMessage(1, "run", MODEL.profile.id);
      expect(user.getAgent).toHaveBeenCalledTimes(1);
      expect(user.getChatContext).toHaveBeenCalledTimes(1);
      expect([...impl.storage.chatMeta.list()].every(meta => !meta.activeAgent)).toBe(true);
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
    }));

  it.each(["build", "use"] as const)("does not let a non-owner %s collaborator change the fence", role =>
    inOverseer(`automation-owner-${role}`, async (impl, instance) => {
      setup(impl, role);
      using client = await open(instance, "collaborator");
      expect(await client.getAutomationPaused()).toBe(false);
      await expect(client.setAutomationPaused(true)).rejects.toThrow(role === "build" ? "owner" : "Unauthorized");
      expect(impl.storage.automationPaused.get()).toBe(false);
    }));

  it("publishes pause and resume on the existing metadata feed", () =>
    inOverseer("automation-metadata", async (impl, instance) => {
      setup(impl);
      using client = await open(instance);
      let states: (boolean | undefined)[] = [];
      using callback = new RpcStub<(metadata: GadgetMetadata) => void>(metadata => {
        states.push(metadata.automationPaused);
      });
      using _subscription = await client.subscribeToMetadata(callback);
      await client.setAutomationPaused(true);
      expect((await client.getMetadata()).automationPaused).toBe(true);
      await client.setAutomationPaused(false);
      await vi.waitFor(() => expect(states).toEqual([false, true, false]));
    }));
});
