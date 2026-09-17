import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { RpcStub } from "capnweb";
import { keyString, type Subscriber } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo, AiChatMessage, TaskRunDisposition } from "@gadgets/workshop-shared/api";
import type { Gatekeeper } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserAiModelRecord, UserChatContext } from "../src/user.js";
import { runAgent } from "../src/agent.js";

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
type Caller = Extract<Parameters<Impl["submitAction"]>[3], { from: "agent" }>;
const USER: AiChatAuthorInfo = { type: "user", id: "owner", name: "Owner" };
const MODEL: UserAiModelRecord = {
  profile: { type: "agent", id: "test-model", name: "Test model", agentProfileId: "original-bot" },
  config: { provider: "anthropic", model: "claude-sonnet-4-5", apiToken: "unused" },
};
const FINISHED: TaskRunDisposition = { status: "finished", reason: "model_stop" };
const NO_CHANGES = { changes: [], createdGadgets: [], addedBindings: [] };
const DESCRIPTION = { title: "Send draft", description: "Send the selected draft",
  implementsRevert: false, autoApprovable: false, awaitDecision: true };

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Action attribution tests forbid provider calls"));
  vi.mocked(runAgent).mockReset();
});

afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

function inOverseer(name: string, fn: (impl: Impl, instance: OverseerDurableObject) => Promise<void>) {
  return runInDurableObject(env.TEST_OVERSEER.getByName(`task-run-actions-${name}`),
    (instance: OverseerDurableObject) => fn(instance["impl"], instance));
}

// Real SQLite, admission, turn bookkeeping and barriers. Only remote user/model/facet calls are
// substituted. The promise gates below are semaphores, not timing-dependent sleeps.
async function setup(impl: Impl) {
  impl.ownerId = "task-owner";
  impl.ownerProfileId = USER.id;
  Object.assign(impl, {
    users: { idFromString: (id: string) => id, get: () => ({
      id: { toString: () => "task-owner" },
      whoami: async () => USER,
      getChatContext: async (): Promise<UserChatContext> => ({ profile: USER, aiModel: MODEL }),
      getAgent: async () => undefined,
      getGroupByWorkspaceId: async () => null,
      getAgentByWorkspaceId: async () => undefined,
      recordSharedGadgetOpen: async () => {},
      setGadgetLastActive: async () => {},
    }) },
    getSharingManager: async () => ({ getEffectiveRole: () => "build" }),
  });
  vi.spyOn(impl, "ensureAmbientCapsules").mockResolvedValue(undefined);
  vi.spyOn(impl, "ensureObserver").mockResolvedValue(undefined);
  vi.spyOn(impl, "markOutputsDirty").mockImplementation(() => {});
  vi.spyOn(impl, "syncOutputsTo").mockResolvedValue(true);
  vi.spyOn(impl, "joinOutputsFanout").mockReturnValue(() => {});
  impl.storage.chatMeta.put({ id: 1, title: "Actions", started: new Date(0), lastActive: new Date(0) });
  const commit = await impl.gitStore.writeFilesAsCommit(new Map(), {
    parents: [], author: { name: USER.name, email: "owner@example.com" },
    message: "Create source", timestamp: new Date(0),
  });
  const gadget = impl.createGadget("Source", "SOURCE", undefined, undefined, commit);
  // Stop at the actual binding factory boundary and inspect exactly what getEnvForAgent seals.
  const binding = vi.spyOn(impl, "makeBindingLoopback")
    .mockReturnValue({} as ReturnType<Impl["makeBindingLoopback"]>);
  return { gadget, binding };
}

function messages(impl: Impl) {
  return [...impl.storage.chats.list({ prefix: `${keyString(1)}.` })];
}

async function open(instance: OverseerDurableObject) {
  using closed = new NativeRpcStub<() => void>(() => {});
  return new RpcStub(await instance.open("task-owner", USER.id, closed));
}

async function start(impl: Impl, fixture: Awaited<ReturnType<typeof setup>>, newRun = true, legacy = false) {
  if (newRun) {
    impl.addChatMessages(1, USER, [{ type: "message", message: "Make a draft" }]);
    if (!legacy) impl.admitTaskRun(1, messages(impl).at(-1)!.sequence, { type: "prompt" });
  }
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  vi.mocked(runAgent).mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { disposition: FINISHED };
  });
  impl.startAgent(1, MODEL, USER, "task-owner");
  await entered.promise;
  impl.getEnvForAgent(1, { SOURCE: { type: "workpiece", id: fixture.gadget.id } });
  const source = fixture.binding.mock.calls.at(-1)![1];
  if (source.from !== "agent") throw new Error("Expected a sealed agent caller");
  const caller: Caller = structuredClone(source); // RPC does not preserve JS object identity.
  const execution = impl.storage.activeAgents.get(1)?.run;
  return {
    caller, execution,
    finish: async () => { release.resolve(); await impl.waitForAllAgentsToComplete(); },
  };
}

async function submit(impl: Impl, caller: Caller) {
  const id = impl.storage.nextActionId.get();
  await impl.submitAction(7, 900 + id, DESCRIPTION, caller);
  return id;
}

describe("execution-scoped action capture", () => {
  it("captures live actions, built-in observations and gadget access without changing the approval latch", () =>
    inOverseer("live", async impl => {
      const fixture = await setup(impl);
      const turn = await start(impl, fixture);
      try {
        expect(turn.caller).toMatchObject({ runId: turn.execution!.id, attempt: 1, author: USER });
        const id = await submit(impl, turn.caller);
        await impl.recordAgentObservation(1, "Selected source", undefined,
          { title: "Read source", description: "Read the selected source" });
        const observation = impl.storage.actions.get(id + 1)!;
        expect(observation.caller).toEqual(turn.caller);
        using facet = new RpcStub({});
        vi.spyOn(impl, "getGadgetFacet").mockResolvedValue(facet);
        await impl.startGatekeeperSession({ type: "gadget", id: fixture.gadget.id }, turn.caller);
        const captured = impl.consumeCapturedActions(1)!;
        expect(captured).toEqual({ actions: [id, id + 1], accessedGadget: true, awaitDecision: true });
        expect(impl.consumeCapturedActions(1)).toBeUndefined();
        expect(messages(impl).filter(m => m.type === "action")).toEqual([]);
        await impl.commitAgentStep(1, MODEL.profile,
          captured.actions.map(actionId => ({ type: "action", actionId })), {
            ...NO_CHANGES, run: { ...turn.execution!, disposition: { status: "waiting", reason: "action_approval" } },
          });
        impl.flushCapturedActions(1, turn.execution);
        expect(messages(impl).filter(m => m.type === "action").map(m => m.actionId)).toEqual([id, id + 1]);
      } finally { await turn.finish(); }
    }));

  it("posts arrivals after a terminal barrier immediately, even while the original turn is still live", () =>
    inOverseer("barrier", async (impl, instance) => {
      const fixture = await setup(impl);
      const turn = await start(impl, fixture);
      try {
        await impl.commitAgentStep(1, MODEL.profile, [{ type: "message", message: "Finished" }], {
          ...NO_CHANGES, run: { ...turn.execution!, disposition: FINISHED },
        });
        const before = impl.storage.taskRuns.get(turn.execution!.id)!;
        const id = await submit(impl, turn.caller);
        expect(impl.consumeCapturedActions(1)).toBeUndefined();
        expect(messages(impl).at(-1)).toMatchObject({ type: "action", actionId: id,
          author: MODEL.profile, runId: turn.execution!.id });
        using client = await open(instance);
        expect((await client.getTaskRunEvidence(turn.execution!.id)).entries[0].message)
          .toMatchObject({ actionId: id, actionLog: { state: "pending" } });
        expect(impl.storage.taskRuns.get(turn.execution!.id)).toEqual({ ...before,
          lastSequence: messages(impl).at(-1)!.sequence });
      } finally { await turn.finish(); }
    }));

  it.each([false, true])("keeps old arrivals out of a replacement turn (same logical run: %s)", sameRun =>
    inOverseer(`replacement-${sameRun}`, async (impl, instance) => {
      const fixture = await setup(impl);
      const first = await start(impl, fixture);
      await impl.commitAgentStep(1, MODEL.profile, [{ type: "message", message: "Original response" }], {
        ...NO_CHANGES, run: { ...first.execution!, disposition: FINISHED },
      });
      await first.finish();
      const second = await start(impl, fixture, !sameRun);
      try {
        expect(second.caller.captureId).not.toBe(first.caller.captureId);
        expect(second.execution!.attempt).toBe(sameRun ? 2 : 1);
        const replacement = impl.storage.taskRuns.get(second.execution!.id)!;
        const late = await submit(impl, first.caller);
        using facet = new RpcStub({});
        vi.spyOn(impl, "getGadgetFacet").mockResolvedValue(facet);
        await impl.startGatekeeperSession({ type: "gadget", id: fixture.gadget.id }, first.caller);
        expect(impl.consumeCapturedActions(1)).toBeUndefined();
        expect(messages(impl).at(-1)).toMatchObject({ type: "action", actionId: late,
          runId: first.execution!.id, author: MODEL.profile });
        expect(impl.storage.actions.get(late)?.caller).toEqual(first.caller);
        await impl.recordAgentObservation(1, "New source", undefined,
          { title: "New read", description: "Read for the replacement" });
        const captured = impl.consumeCapturedActions(1)!;
        expect(captured).toEqual({ actions: [late + 1], accessedGadget: false, awaitDecision: false });
        await impl.commitAgentStep(1, MODEL.profile,
          captured.actions.map(actionId => ({ type: "action", actionId })), {
            ...NO_CHANGES, run: { ...second.execution!, disposition: FINISHED },
          });
        using client = await open(instance);
        const original = (await client.getTaskRunEvidence(first.execution!.id)).entries;
        expect(original.some(e => e.message.type === "action" && e.message.actionId === late)).toBe(true);
        if (!sameRun) {
          const current = (await client.getTaskRunEvidence(second.execution!.id)).entries;
          expect(current.some(e => e.message.type === "action" && e.message.actionId === late)).toBe(false);
        }
        expect(impl.storage.taskRuns.get(second.execution!.id)).toMatchObject({
          ...replacement, ...FINISHED, lastSequence: messages(impl).at(-1)!.sequence,
          updatedAt: expect.any(Date),
        });
      } finally { await second.finish(); }
    }));

  it("retains the original initiator when no model response committed, not the newer model's author", () =>
    inOverseer("initiator", async impl => {
      const fixture = await setup(impl);
      const first = await start(impl, fixture);
      await first.finish();
      const second = await start(impl, fixture);
      try {
        await impl.commitAgentStep(1, MODEL.profile, [{ type: "message", message: "New task response" }], {
          ...NO_CHANGES, run: second.execution,
        });
        const id = await submit(impl, first.caller);
        expect(messages(impl).at(-1)).toMatchObject({ type: "action", actionId: id,
          author: USER, runId: first.execution!.id });
        expect(impl.consumeCapturedActions(1)).toBeUndefined();
      } finally { await second.finish(); }
    }));

  it.each([false, true])("approves and resumes only the current action's execution (same logical run: %s)", sameRun =>
    inOverseer(`approve-execution-${sameRun}`, async (impl, instance) => {
      const fixture = await setup(impl);
      const first = await start(impl, fixture);
      await impl.commitAgentStep(1, MODEL.profile, [{ type: "message", message: "Original response" }], {
        ...NO_CHANGES, run: { ...first.execution!, disposition: FINISHED },
      });
      await first.finish();
      const second = await start(impl, fixture, !sameRun);
      let current: number;
      let latePending: number;
      let lateApproved: number;
      try {
        current = await submit(impl, second.caller);
        const captured = impl.consumeCapturedActions(1)!;
        expect(captured.actions).toEqual([current]);
        await impl.commitAgentStep(1, MODEL.profile, [
          { type: "message", message: "Awaiting the current decision" },
          ...captured.actions.map(actionId => ({ type: "action" as const, actionId })),
        ], { ...NO_CHANGES, run: { ...second.execution!,
          disposition: { status: "waiting", reason: "action_approval" } } });
        latePending = await submit(impl, first.caller);
        lateApproved = await submit(impl, first.caller);
      } finally { await second.finish(); }

      const applyAction = vi.fn<Gatekeeper<never>["applyAction"]>(async () => {});
      Object.assign(impl, { getGatekeeperFacet: () => ({ applyAction }) });
      const canResume = vi.spyOn(impl, "canResumeTask");
      const waiting = impl.storage.taskRuns.get(second.execution!.id);
      using client = await open(instance);
      await client.approveAction(lateApproved);
      expect(canResume).toHaveBeenCalledWith(1, first.execution!.id, first.execution!.attempt);
      expect(impl.storage.taskRuns.get(second.execution!.id)).toEqual(waiting);
      expect(runAgent).toHaveBeenCalledTimes(2);

      vi.mocked(runAgent).mockResolvedValueOnce({ disposition: FINISHED });
      await client.approveAction(current);
      await impl.waitForAllAgentsToComplete();
      expect(runAgent).toHaveBeenCalledTimes(3);
      expect(vi.mocked(runAgent).mock.calls.at(-1)![9]).toEqual({
        id: second.execution!.id, attempt: second.execution!.attempt + 1,
      });
      expect(impl.storage.actions.get(current)).toMatchObject({ state: "approved", resolvedBy: USER });
      expect(impl.storage.actions.get(latePending)).toMatchObject({ state: "pending", caller: first.caller });
      expect(applyAction.mock.calls).toEqual([[900 + lateApproved], [900 + current]]);
      expect(impl.storage.taskRuns.get(second.execution!.id)).toMatchObject(FINISHED);
    }));

  it("deduplicates a buffered action after cancellation flushes it during code prefetch", () =>
    inOverseer("cancel-prefetch", async impl => {
      const fixture = await setup(impl);
      const turn = await start(impl, fixture);
      const id = await submit(impl, turn.caller);
      const captured = impl.consumeCapturedActions(1)!;
      expect(captured.actions).toEqual([id]);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const getContent = impl.getCurrentChatContent.bind(impl);
      vi.spyOn(impl, "getCurrentChatContent").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return getContent(...args);
      });
      const committing = impl.commitAgentStep(1, MODEL.profile, [
        { type: "message", message: "Tool returned" },
        ...captured.actions.map(actionId => ({ type: "action" as const, actionId })),
      ], { ...NO_CHANGES, changes: [{
        change: { [fixture.gadget.id]: [["draft.md", { set: "Draft content" }]] },
        pin: { gadgetId: fixture.gadget.id, baseCommit: fixture.gadget.commitId! },
      }], run: { ...turn.execution!, disposition: FINISHED } });
      try {
        await entered.promise;
        expect(messages(impl).filter(m => m.type === "action")).toEqual([]);
        impl.cancelAgent(1);
        const posted = messages(impl).filter(m => m.type === "action");
        expect(posted).toMatchObject([{ actionId: id, runId: turn.execution!.id }]);
        release.resolve();
        await expect(committing).resolves.toBe(true);
        expect(messages(impl).filter(m => m.type === "action")).toEqual(posted);
        expect(messages(impl)).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "message", message: "Tool returned", runId: turn.execution!.id }),
          expect.objectContaining({ type: "changes", runId: turn.execution!.id }),
        ]));
        expect(impl.storage.taskRuns.get(turn.execution!.id))
          .toMatchObject({ status: "canceled", reason: "user_stop" });
      } finally {
        release.resolve();
        try { await committing; } finally { await turn.finish(); }
      }
    }));

  it("seals provenance before initial reconciliation even if the first built-in observation arrives after cancellation", () =>
    inOverseer("first-observation-canceled", async impl => {
      const fixture = await setup(impl);
      impl.addChatMessages(1, USER, [{ type: "message", message: "Read a source" }]);
      const run = impl.admitTaskRun(1, messages(impl).at(-1)!.sequence, { type: "prompt" });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const reconcile = impl.reconcilePendingGadgets.bind(impl);
      vi.spyOn(impl, "reconcilePendingGadgets").mockImplementationOnce(async chatId => {
        entered.resolve();
        await release.promise;
        await reconcile(chatId);
      });
      impl.startAgent(1, MODEL, USER, "task-owner");
      try {
        await entered.promise;
        const execution = impl.storage.activeAgents.get(1)!.run!;
        expect(execution).toEqual({ id: run.id, attempt: 1 });
        expect(fixture.binding).not.toHaveBeenCalled();
        impl.cancelAgent(1);
        expect(impl.storage.activeAgents.get(1)).toBeUndefined();
        await impl.recordAgentObservation(1, "Selected source", undefined,
          { title: "First read", description: "Read completed after cancellation" });
        expect([...impl.storage.actions.list()]).toMatchObject([{
          type: "observation", state: "approved",
          caller: { from: "agent", chatId: 1, runId: execution.id, attempt: execution.attempt, author: USER },
        }]);
        expect(messages(impl).at(-1)).toMatchObject({ type: "action", actionId: 0, runId: run.id, author: USER });
      } finally {
        release.resolve();
        await impl.waitForAllAgentsToComplete();
      }
      expect(runAgent).not.toHaveBeenCalled();
      expect(messages(impl).filter(m => m.type === "action")).toHaveLength(1);
      expect(impl.storage.taskRuns.get(run.id)).toMatchObject({ status: "canceled", reason: "user_stop" });
    }));

  it("seals catalog observation attribution before preparing bindings yields to a replacement turn", () =>
    inOverseer("catalog-origin", async impl => {
      const fixture = await setup(impl);
      const first = await start(impl, fixture);
      // Only the remote facet is substituted; the configured ambient set and authorizer are real.
      impl.storage.gatekeepers.put({ id: 7, resourceTitle: "Library",
        class: {} as Parameters<Impl["addGatekeeper"]>[0] });
      impl.storage.chatContext.put({ chatId: 1, agentId: "bot",
        bindings: { LIBRARY: 7 }, alwaysAvailableCapsuleIds: [7] });
      const getAgentCatalog = vi.fn<NonNullable<Gatekeeper<never>["getAgentCatalog"]>>(async authorizer => {
        await authorizer.authorizeObservation({ title: "Library catalog", description: "List available sources" });
        return { entries: [{ id: "source", title: "Selected source", description: "Available to this account" }] };
      });
      Object.assign(impl, { getGatekeeperFacet: () => ({ getAgentCatalog }) });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      vi.mocked(impl.ensureAmbientCapsules).mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
      const preparing = impl.prepareChatBindings(1, messages(impl));
      await entered.promise;
      await first.finish();
      const second = await start(impl, fixture);
      try {
        const before = impl.storage.taskRuns.get(second.execution!.id);
        release.resolve();
        await expect(preparing).resolves.toMatchObject([{ name: "LIBRARY", target: 7,
          catalog: { entries: [{ id: "source" }] } }]);
        expect(getAgentCatalog).toHaveBeenCalledOnce();
        expect([...impl.storage.actions.list()]).toMatchObject([
          { type: "observation", state: "approved", caller: first.caller },
        ]);
        expect(messages(impl).at(-1)).toMatchObject({ type: "action", runId: first.execution!.id });
        expect(impl.consumeCapturedActions(1)).toBeUndefined();
        expect(impl.storage.taskRuns.get(second.execution!.id)).toEqual(before);
      } finally {
        release.resolve();
        try { await preparing; } finally { await second.finish(); }
      }
    }));

  it("keeps an observation's sealed origin across an asynchronous authorization check", () =>
    inOverseer("observation-await", async impl => {
      const fixture = await setup(impl);
      const first = await start(impl, fixture);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const sharing = await impl.getSharingManager();
      vi.spyOn(impl, "getSharingManager").mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return sharing;
      });
      const observation = impl.authorizeObservation(7, {
        title: "Read source", description: "Read the original source", excludeObservers: ["absent-observer"],
      }, first.caller);
      await entered.promise;
      await first.finish();
      const second = await start(impl, fixture);
      try {
        const before = impl.storage.taskRuns.get(second.execution!.id);
        release.resolve();
        await observation;
        expect(messages(impl).at(-1)).toMatchObject({ type: "action", runId: first.execution!.id, author: USER });
        expect([...impl.storage.actions.list()]).toMatchObject([
          { type: "observation", caller: first.caller, state: "approved" },
        ]);
        expect(impl.consumeCapturedActions(1)).toBeUndefined();
        expect(impl.storage.taskRuns.get(second.execution!.id)).toEqual(before);
      } finally {
        release.resolve();
        await observation;
        await second.finish();
      }
    }));

  it("keeps legacy sources untracked and never gives a new tracked turn their approval latch", () =>
    inOverseer("legacy", async impl => {
      const fixture = await setup(impl);
      const first = await start(impl, fixture, true, true);
      expect(first.execution).toBeUndefined();
      await first.finish();
      const second = await start(impl, fixture);
      try {
        const before = impl.storage.taskRuns.get(second.execution!.id);
        for (const caller of [first.caller, { from: "agent", chatId: 1 } satisfies Caller]) {
          const id = await submit(impl, caller);
          expect(messages(impl).at(-1)).toMatchObject({ type: "action", actionId: id, author: USER });
          expect(messages(impl).at(-1)?.runId).toBeUndefined();
        }
        expect(impl.consumeCapturedActions(1)).toBeUndefined();
        expect(impl.storage.taskRuns.get(second.execution!.id)).toEqual(before);
      } finally { await second.finish(); }
    }));

  it.each([false, true])("flushes durable actions after a failed barrier (already consumed: %s)", consumed =>
    inOverseer(`flush-${consumed}`, async impl => {
      const fixture = await setup(impl);
      const first = await start(impl, fixture);
      const id = await submit(impl, first.caller);
      if (consumed) {
        expect(impl.consumeCapturedActions(1)?.actions).toEqual([id]);
        const fault: Subscriber<AiChatMessage> = {
          add(message) { if (message.type === "action") throw new Error("injected barrier failure"); },
          update() {}, remove() {},
        };
        impl.storage.chats.subscribe(fault);
        try {
          await expect(impl.commitAgentStep(1, MODEL.profile, [{ type: "action", actionId: id }], {
            ...NO_CHANGES, run: { ...first.execution!, disposition: FINISHED },
          })).rejects.toThrow("injected barrier failure");
        } finally { impl.storage.chats.unsubscribe(fault); }
        expect(messages(impl).filter(m => m.type === "action")).toEqual([]);
        expect(impl.storage.actions.get(id)).toMatchObject({ state: "pending", caller: first.caller });
      }
      await first.finish();
      const second = await start(impl, fixture);
      try {
        const before = impl.storage.taskRuns.get(second.execution!.id);
        impl.flushCapturedActions(1, first.execution);
        impl.flushCapturedActions(1, first.execution);
        expect(messages(impl).filter(m => m.type === "action")).toMatchObject([
          { actionId: id, runId: first.execution!.id, author: USER },
        ]);
        expect(impl.consumeCapturedActions(1)).toBeUndefined();
        expect(impl.storage.taskRuns.get(second.execution!.id)).toEqual(before);
      } finally { await second.finish(); }
    }));

  it("reconstructs uncommitted cards from durable actions after losing the in-memory capture map", async () => {
    let execution: Awaited<ReturnType<typeof start>>["execution"];
    let id: number;
    await inOverseer("recovery", async impl => {
      const fixture = await setup(impl);
      const first = await start(impl, fixture);
      execution = first.execution;
      id = await submit(impl, first.caller);
      impl.consumeCapturedActions(1);
      await first.finish();
    });
    await abortAllDurableObjects();
    await inOverseer("recovery", async impl => {
      impl.flushCapturedActions(1, execution);
      impl.flushCapturedActions(1, execution);
      expect(messages(impl).filter(m => m.type === "action")).toMatchObject([
        { actionId: id, runId: execution!.id, author: USER },
      ]);
    });
  });

  it("preserves authorization checks and does not resurrect deleted task evidence", () =>
    inOverseer("authorization", async (impl, instance) => {
      const fixture = await setup(impl);
      const first = await start(impl, fixture);
      await first.finish();
      impl.storage.prohibitAllSharing.put(true);
      await expect(submit(impl, first.caller)).rejects.toThrow("prohibited from performing actions");
      expect([...impl.storage.actions.list()]).toEqual([]);
      impl.storage.prohibitAllSharing.put(false);
      using client = await open(instance);
      await client.deleteChat(1);
      await submit(impl, first.caller);
      impl.flushCapturedActions(1, first.execution);
      expect(messages(impl)).toEqual([]);
      expect(impl.storage.taskRuns.get(first.execution!.id)).toBeUndefined();
    }));
});
