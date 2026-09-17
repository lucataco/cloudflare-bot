import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { exports, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcStub } from "capnweb";
import type {
  AgentProfile, AuthenticatedApi, NamedDelegationReceipt, Overseer, PublicApi,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer";
import type { UserDurableObject } from "../src/user";
import type { PreparedNamedDelegation } from "../src/named-delegation";
import { validateNamedDelegation } from "./worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Impl = OverseerDurableObject["impl"];
const model = { type: "agent" as const, id: "delegation-test-model", name: "Test model" };
const emptyStep = { changes: [], createdGadgets: [], addedBindings: [] };
const touched: (() => DurableObjectStub)[] = [];

beforeEach(() => {
  // Keep background deadlines beyond the real clock; no alarm/push or provider is part of this test.
  const now = Date.now() + 3_600_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Named delegation integration forbids external network"));
});

afterEach(async () => {
  try {
    for (const getStub of touched.splice(0)) {
      await runInDurableObject(getStub(), (_instance, state) => state.storage.deleteAlarm());
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});

async function connect() {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("Expected WebSocket response");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function account(root: RpcStub<PublicApi>) {
  const name = "delegation" + crypto.randomUUID().replaceAll("-", "");
  const token = await root.createAccount(name, name, new Uint8Array([1, 2, 3]));
  if (!token) throw new Error("Account creation failed");
  const user = exports.UserDurableObject.get(exports.UserDurableObject.idFromName(name));
  touched.push(() => exports.UserDurableObject.get(exports.UserDurableObject.idFromName(name)));
  return { token, user };
}

function workspace(id: string) {
  const stub = exports.OverseerDurableObject.get(exports.OverseerDurableObject.idFromString(id));
  touched.push(() => exports.OverseerDurableObject.get(exports.OverseerDurableObject.idFromString(id)));
  return stub;
}

async function bots(api: RpcStub<AuthenticatedApi>) {
  await api.addModel(model, { provider: "anthropic", model: "claude-sonnet-4-5", apiToken: "PRIVATE_MODEL_TOKEN" });
  const source = await api.createAgent("Source", "", "Source standing instructions", model.id);
  const target = await api.createAgent("Researcher", "", "Snapshot instructions", model.id, undefined, [987]);
  using sourceClient = api.openGadget(source.workspaceId);
  using targetClient = api.openGadget(target.workspaceId);
  await Promise.all([sourceClient.getMetadata(), targetClient.getMetadata()]);
  workspace(source.workspaceId);
  workspace(target.workspaceId);
  return { source, target };
}

async function expectRejection(user: DurableObjectStub<UserDurableObject>, workspaceId: string,
    method: keyof Overseer, args: unknown[], message: string) {
  // Root forwarding reports rejected native futures twice in this pool, even with raw batches.
  // Exercise the real authorized public interface/validators locally for denials, not impl methods.
  const profile = await user.whoami();
  await runInDurableObject(workspace(workspaceId), async (instance: OverseerDurableObject) => {
    using closed = new NativeRpcStub(() => {});
    const client = await instance.open(user.id.toString(), profile.id, closed);
    using _owned = new RpcStub(client);
    // workerd reports the inner send promise before the public method adopts its rejection.
    // Observe that promise without replacing the implementation, result, or error under test.
    const impl = instance["impl"];
    const send = impl.sendChatMessage.bind(impl);
    const spy = method === "sendChatMessage" ? vi.spyOn(impl, "sendChatMessage").mockImplementation((...params) => {
      const pending = send(...params);
      void pending.catch(() => {});
      return pending;
    }) : undefined;
    try {
      await expect(async () => await Reflect.apply(client[method], client, args)).rejects.toThrow(message);
    } finally { spy?.mockRestore(); }
  });
}

async function parent(impl: Impl, source: AgentProfile) {
  const user = impl.users.get(impl.users.idFromString(impl.ownerId!));
  const initiator = await user.whoami();
  const chatId = impl.nextChatId();
  const timestamp = impl.getChatTimestamp();
  // Trusted test-only active execution fixture, not a public API for forging parent authority.
  impl.storage.chatMeta.put({ id: chatId, title: "Parent", started: timestamp, lastActive: timestamp, activeAgent: model });
  impl.storage.chatContext.put({ chatId, agentId: source.id });
  impl.addChatMessages(chatId, initiator, [{ type: "message", message: "PRIVATE_PARENT_HISTORY" }]);
  const run = impl.admitTaskRun(chatId, 0, { type: "prompt" });
  impl.storage.taskRuns.put({ ...run, status: "running", reason: undefined, attempt: 1 });
  const execution = { id: run.id, attempt: 1 };
  impl.storage.activeAgents.put({ chatId, initiatorUserId: impl.ownerId!, initiator,
    modelId: model.id, callbackInitiated: false, run: execution });
  return { chatId, execution };
}

function commit(impl: Impl, prepared: PreparedNamedDelegation) {
  return impl.commitAgentStep(prepared.parentChatId, model, [{ type: "message", message: "Delegating explicit task",
    toolCalls: [{ toolName: "delegateToBot", toolCallId: prepared.input.requestId,
      input: prepared.input, delegationId: prepared.id }] }],
  { ...emptyStep, run: prepared.execution, delegations: [prepared] });
}

async function admit(source: AgentProfile, target: AgentProfile, changeProfile = false,
    bindings: Record<string, number> = {}) {
  return runInDurableObject(workspace(source.workspaceId), async (instance: OverseerDurableObject) => {
    const impl = instance["impl"];
    const p = await parent(impl, source);
    const input = { requestId: "research-1", targetAgentId: target.id, title: "Research", prompt: "Only this explicit task",
      bindingNames: Object.keys(bindings) };
    const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, input);
    expect(prepared).toMatchObject({ bindings, targetName: target.name, targetInstructions: target.description,
      model: { profile: model } });
    expect([...impl.storage.namedDelegations.list()]).toEqual([]);
    expect([...impl.storage.chatMeta.list()]).toHaveLength(1);
    if (changeProfile) {
      // Real Native RPC update after preparation must not change the admitted snapshot.
      await impl.users.get(impl.users.idFromString(impl.ownerId!)).updateAgentRecord(target.id,
        { name: "Later name", description: "Later instructions", defaultModelId: null });
    }
    const entered = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const reconcile = vi.spyOn(impl, "reconcilePendingGadgets").mockImplementationOnce(chatId => {
      entered.resolve(chatId);
      return release.promise;
    });
    try {
      await commit(impl, prepared);
      const receipt = impl.getNamedDelegation(prepared.id).receipt;
      expect(await entered.promise).toBe(receipt.childChatId);
      expect(impl.storage.activeAgents.get(receipt.childChatId)).toMatchObject({
        modelId: model.id, run: { id: receipt.id, attempt: 1 }, initiatorUserId: impl.ownerId,
      });
      expect(impl.getChatAgentContext(receipt.childChatId)).toEqual({ chatId: receipt.childChatId,
        spawnerConfig: { displayName: target.name, modelId: model.id, env: bindings }, bindings,
        agentInstructions: target.description, namedDelegation: receipt,
        alwaysAvailableCapsuleIds: [], alwaysAvailableCatalogs: [] });
      expect(await impl.prepareChatBindings(receipt.childChatId, [...impl.storage.chats.list()])).toEqual(
        Object.entries(bindings).map(([name, id]) => ({ name, target: id,
          title: impl.storage.gatekeepers.get(id)!.resourceTitle, isGadget: false })));
      expect(impl.getEnvForAgent(receipt.childChatId, {
        PRIVATE: { type: "workpiece", id: 987 }, MEMORY: { type: "value", messageSequence: 0 },
      })).toEqual({});
      return { receipt, input };
    } finally {
      // Cancel before releasing the real turn's pre-inference await, including on assertion failure.
      impl.cancelAgent(p.chatId);
      release.resolve();
      await impl.waitForAllAgentsToComplete();
      reconcile.mockRestore();
    }
  });
}

describe("named delegation through real UserDO, Overseer and root RPC", () => {
  it("defaults to NONE, uses canonical same-owner profiles, enforces owner-only settings and stale CAS", async () => {
    using root = await connect();
    const owner = await account(root);
    const foreign = await account(root);
    using api = root.authenticate(owner.token);
    using foreignApi = root.authenticate(foreign.token);
    const { source, target } = await bots(api);
    const foreignTarget = await foreignApi.createAgent(target.name, "", target.description, null);
    using client = await api.openGadget(source.workspaceId);
    const validated = validateNamedDelegation(client);
    expect(await validated.getNamedDelegationConfig()).toEqual({ revision: 0, targets: [], resources: [] });
    expect(await owner.user.getAgentByWorkspaceId(source.workspaceId)).toEqual(source);
    expect(await owner.user.getAgent(target.id)).toEqual(target);
    expect(await owner.user.getAgent(foreignTarget.id)).toBeNull();
    await runInDurableObject(workspace(source.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      expect(impl.ownerId).toBe(owner.user.id.toString());
      expect(impl.ctx.id.toString()).not.toBe(owner.user.id.toString());
      const p = await parent(impl, source);
      try {
        expect(await impl.listNamedDelegates(p.chatId)).toEqual([]);
        await expect(impl.prepareNamedDelegation(p.chatId, p.execution, {
          requestId: "none", targetAgentId: target.id, title: "Not enabled", prompt: "Task",
        })).rejects.toThrow("not configured");
      } finally { impl.cancelAgent(p.chatId); }
    });
    for (const id of [source.id, foreignTarget.id]) {
      await expectRejection(owner.user, source.workspaceId, "setNamedDelegationConfig",
        [[{ targetAgentId: id, bindings: {} }], 0], "other bots owned");
    }
    await expectRejection(owner.user, source.workspaceId, "setNamedDelegationConfig",
      [[{ targetAgentId: target.id, bindings: { SECRET: { value: "literal" } } }], 0], "expected number");
    const config = await validated.setNamedDelegationConfig([{ targetAgentId: target.id, bindings: {} }], 0);
    expect(config).toEqual({ revision: 1, targets: [{ targetAgentId: target.id, bindings: {} }], resources: [] });
    await expectRejection(owner.user, source.workspaceId, "setNamedDelegationConfig", [[], 0], "changed");
    expect(await validated.getNamedDelegationConfig()).toEqual(config);
    await client.addCollaborator((await foreignApi.whoami()).id, "build");
    using shared = await foreignApi.openGadget(source.workspaceId);
    expect((await shared.getMetadata()).id).toBe(source.workspaceId);
    for (const method of ["getNamedDelegationConfig", "setNamedDelegationConfig"] as const) {
      await expectRejection(foreign.user, source.workspaceId, method,
        method.startsWith("set") ? [[], 1] : [], "workspace owner");
    }
    expect(await validated.getNamedDelegationConfig()).toEqual(config);
    using ordinary = await api.newGadget();
    const ordinaryId = (await ordinary.getMetadata()).id;
    workspace(ordinaryId);
    await expectRejection(owner.user, ordinaryId, "getNamedDelegationConfig", [], "dedicated source bot");
  });

  it("serializes admitted receipts and chat events while isolating target state and rejecting child send/retry", async () => {
    using root = await connect();
    const owner = await account(root);
    using api = root.authenticate(owner.token);
    const { source, target } = await bots(api);
    await api.addMemory(target.id, "PRIVATE_MEMORY_SECRET private-account-id-987");
    await api.createSkill(target.id, "private", "PRIVATE_SKILL_DESCRIPTION", "PRIVATE_SKILL_BODY");
    using targetClient = await api.openGadget(target.workspaceId);
    const privateChat = await targetClient.newChat("PRIVATE_TARGET_HISTORY", null);
    await targetClient.setComputerControl(target.id, "human"); // Consent only, no browser session.
    using client = await api.openGadget(source.workspaceId);
    const validated = validateNamedDelegation(client);
    await validated.setNamedDelegationConfig([{ targetAgentId: target.id, bindings: {} }], 0);
    const { receipt } = await admit(source, target, true);
    const result = await validated.getNamedDelegation(receipt.id);
    expect(result).toMatchObject({ receipt, deleted: false, canceled: true, run: {
      id: receipt.id, chatId: receipt.childChatId, attempt: 1, status: "canceled", reason: "user_stop",
      source: { type: "delegation", parent: { runId: receipt.parentRunId, chatId: receipt.parentChatId,
        attempt: 1, targetAgentId: target.id, targetName: target.name } },
    } });
    expect(result.run!.startedAt).toBeInstanceOf(Date);
    expect(result.run!.updatedAt).toBeInstanceOf(Date);
    const history = await validated.getChatHistory(receipt.parentChatId);
    expect(history.messages).toContainEqual(expect.objectContaining({ type: "namedDelegation", delegation: receipt, result }));
    expect(history.messages).toContainEqual(expect.objectContaining({ type: "message", toolCalls: [expect.objectContaining({
      toolName: "delegateToBot", delegationId: receipt.id,
    })] }));
    const child = await validated.getChatHistory(receipt.childChatId);
    expect(child.messages).toHaveLength(2);
    expect(child.messages[0]).toMatchObject({ message: "Only this explicit task", runId: receipt.id });
    expect(child.messages[1]).toMatchObject({ type: "error", message: "Named delegation canceled.", runId: receipt.id });
    const before = await runInDurableObject(workspace(source.workspaceId), (instance: OverseerDurableObject) =>
      instance["impl"].storage.chatContext.get(receipt.childChatId));
    await expectRejection(owner.user, source.workspaceId, "sendChatMessage",
      [receipt.childChatId, "/private", null, undefined, undefined, undefined, target.id], "parent conversation");
    // A nonexistent model proves retry rejects before attempting any private model lookup.
    await expectRejection(owner.user, source.workspaceId, "retryAgent", [receipt.childChatId, "missing-model"], "instead of retrying");
    await runInDurableObject(workspace(source.workspaceId), (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      expect(impl.storage.chatContext.get(receipt.childChatId)).toEqual(before);
      expect([...impl.storage.chatQueue.list()]).toEqual([]);
      expect(JSON.stringify([...impl.ctx.storage.kv.list()])).not.toMatch(/PRIVATE_MODEL_TOKEN|PRIVATE_MEMORY|PRIVATE_SKILL|PRIVATE_TARGET|private-account-id/);
      expect(impl.storage.computerControl.get()).toBeUndefined();
    });
    expect(await validated.getChatHistory(receipt.childChatId)).toEqual(child);
    expect(await owner.user.getAgent(target.id)).toMatchObject({ name: "Later name", defaultModelId: null });
    expect(await targetClient.getComputerControl(target.id)).toBe("human");
    expect((await targetClient.getChatHistory(privateChat)).messages[0]).toMatchObject({ message: "PRIVATE_TARGET_HISTORY" });
    expect(await api.listMemory(target.id)).toHaveLength(1);
    expect(await api.listSkills(target.id)).toHaveLength(1);

    for (const role of ["build", "use"] as const) {
      const collaborator = await account(root);
      using collaboratorApi = root.authenticate(collaborator.token);
      await client.addCollaborator((await collaboratorApi.whoami()).id, role);
      using shared = await collaboratorApi.openGadget(source.workspaceId);
      if (role === "build") expect(await shared.getNamedDelegation(receipt.id)).toEqual(result);
      else await expectRejection(collaborator.user, source.workspaceId, "getNamedDelegation", [receipt.id], "only has permission to use");
      for (const method of ["getNamedDelegationConfig", "setNamedDelegationConfig"] as const) {
        await expectRejection(collaborator.user, source.workspaceId, method,
          method.startsWith("set") ? [[], 1] : [], role === "build" ? "workspace owner" : "only has permission to use");
      }
    }
    await expectRejection(owner.user, target.workspaceId, "getNamedDelegation", [receipt.id], "No such named delegation");
    await expectRejection(owner.user, source.workspaceId, "getNamedDelegation", [42], "expected string");
    expect(history.messages.every(event => event.timestamp instanceof Date)).toBe(true);
    // Prove the generated client validator checks the receipt, not just the outer result shape.
    const sourceDo = workspace(source.workspaceId);
    await runInDurableObject(sourceDo, (instance: OverseerDurableObject) => {
      const record = instance["impl"].storage.namedDelegations.get(receipt.id)!;
      Reflect.set(record.receipt, "parentAttempt", "invalid");
      instance["impl"].storage.namedDelegations.put(record);
    });
    try {
      const error = await validated.getNamedDelegation(receipt.id).then(() => null, cause => cause);
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toContain("parentAttempt");
    } finally {
      await runInDurableObject(sourceDo, (instance: OverseerDurableObject) => {
        const record = instance["impl"].storage.namedDelegations.get(receipt.id)!;
        instance["impl"].storage.namedDelegations.put({ ...record, receipt });
      });
    }
  });

  it("builder approval resumes the same child with the owner's frozen model and resource grant", async () => {
    using root = await connect();
    const owner = await account(root);
    const builder = await account(root);
    using api = root.authenticate(owner.token);
    using builderApi = root.authenticate(builder.token);
    const { source, target } = await bots(api);
    const ownerProfile = await api.whoami();
    const builderProfile = await builderApi.whoami();
    expect(builder.user.id.toString()).not.toBe(owner.user.id.toString());
    expect((await owner.user.getChatContext(model.id)).aiModel?.profile).toEqual(model);
    await runInDurableObject(builder.user, async (instance: UserDurableObject) => {
      expect(instance["storage"].aiModels.get(model.id)).toBeUndefined();
      await expect(instance.getChatContext(model.id)).rejects.toThrow(`No such model: ${model.id}`);
    });
    using client = await api.openGadget(source.workspaceId);
    await client.addCollaborator(builderProfile.id, "build");
    using shared = await builderApi.openGadget(source.workspaceId);
    expect(await shared.getMetadata()).toMatchObject({ id: source.workspaceId, role: "build", owner: ownerProfile });
    const sourceDo = workspace(source.workspaceId);
    await runInDurableObject(sourceDo, (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      // Inert external-resource registry fixture; only its apply RPC is substituted below.
      impl.storage.gatekeepers.put({ id: 7, resourceTitle: "Explicit resource",
        class: {} as Parameters<Impl["addGatekeeper"]>[0],
        creationSpec: { type: "gatekeeper", vendorId: "test", resourceUrl: "https://resource.invalid/7",
          typeUrlPattern: "https://resource.invalid/:id" } });
    });
    await client.setNamedDelegationConfig([{ targetAgentId: target.id, bindings: { WRITE: 7 } }], 0);
    const { receipt } = await admit(source, target, false, { WRITE: 7 });
    await api.updateAgent(target.id, { defaultModelId: "later-profile-model", description: "Later instructions", defaultBindings: [987, 988] });

    const fixture = await runInDurableObject(sourceDo, (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      const child = receipt.childChatId;
      // The admission helper cancels before inference. Stage a trusted persisted approval wait
      // from its real receipt/context; this is fixture setup, not a public cancellation bypass.
      const delegation = impl.storage.namedDelegations.get(receipt.id)!;
      impl.storage.namedDelegations.put({ ...delegation, canceled: false });
      impl.storage.taskRuns.put({ ...impl.storage.taskRuns.get(receipt.id)!, status: "waiting", reason: "action_approval" });
      impl.storage.taskRuns.put({ ...impl.storage.taskRuns.get(receipt.parentRunId)!, status: "finished", reason: "model_stop" });
      const parentMeta = impl.getChatMetaOrThrow(receipt.parentChatId);
      delete parentMeta.activeAgent;
      impl.storage.chatMeta.put(parentMeta);
      impl.storage.actions.put({ id: 1, type: "action", gatekeeperId: 7, action: 100, resourceTitle: "Explicit resource",
        caller: { from: "agent", chatId: child, runId: receipt.id, attempt: 1 }, createdAt: impl.getChatTimestamp(), state: "pending",
        description: { title: "Explicit write", description: "Await builder approval", implementsRevert: false,
          autoApprovable: false, awaitDecision: true } });
      impl.storage.nextActionId.put(2);
      // Neither the latest transcript author nor the updated target profile may pick the model.
      impl.addChatMessages(child, { ...model, id: "later-history-model" }, [{ type: "action", actionId: 1 }],
        undefined, undefined, undefined, undefined, receipt.id);
      const waiting = impl.storage.taskRuns.get(receipt.id)!;
      const context = impl.storage.chatContext.get(child)!;
      expect(waiting).toMatchObject({ status: "waiting", reason: "action_approval", attempt: 1 });
      expect(impl.canResumeTask(child, receipt.id, 1)).toBe(true);
      expect(impl.storage.activeAgents.get(child)).toBeUndefined();
      expect(impl.getChatMetaOrThrow(child).activeAgent).toBeUndefined();
      const apply = vi.fn(async (_id: number) => {});
      const getFacet = vi.spyOn(impl, "getGatekeeperFacet").mockImplementation(id => {
        expect(id).toBe(7);
        return { applyAction: apply } as ReturnType<Impl["getGatekeeperFacet"]>;
      });
      const release = Promise.withResolvers<void>();
      const reconcile = vi.spyOn(impl, "reconcilePendingGadgets").mockImplementationOnce(() => release.promise);
      return { waiting, context, apply, getFacet, release, reconcile };
    });
    try {
      await shared.approveAction(1);
      await runInDurableObject(sourceDo, async (instance: OverseerDurableObject) => {
        const impl = instance["impl"];
        const child = receipt.childChatId;
        const { waiting, context, apply, reconcile } = fixture;
        expect(apply).toHaveBeenCalledExactlyOnceWith(100);
        expect(impl.storage.actions.get(1)).toMatchObject({ state: "approved", resolvedBy: builderProfile,
          autoApproved: false, appliedAt: expect.any(Date) });
        expect(reconcile).toHaveBeenCalledExactlyOnceWith(child);
        expect(impl.storage.activeAgents.get(child)).toMatchObject({ initiatorUserId: owner.user.id.toString(),
          initiator: ownerProfile, modelId: model.id, callbackInitiated: false, run: { id: receipt.id, attempt: 2 } });
        expect(impl.storage.taskRuns.get(receipt.id)).toMatchObject({ id: receipt.id, chatId: child,
          source: waiting.source, sourceSequence: waiting.sourceSequence, startedAt: waiting.startedAt,
          status: "running", attempt: 2 });
        expect(impl.storage.chatContext.get(child)).toEqual(context);
        expect(context).toMatchObject({ bindings: { WRITE: 7 }, spawnerConfig: { modelId: model.id, env: { WRITE: 7 } },
          agentInstructions: target.description, alwaysAvailableCapsuleIds: [], alwaysAvailableCatalogs: [] });
        expect(context).not.toHaveProperty("agentId");
        expect(await impl.prepareChatBindings(child, [...impl.storage.chats.list()])).toEqual([
          { name: "WRITE", target: 7, title: "Explicit resource", isGadget: false },
        ]);
      });
    } finally {
      await runInDurableObject(sourceDo, async (instance: OverseerDurableObject) => {
        const impl = instance["impl"];
        impl.cancelAgent(receipt.childChatId);
        fixture.release.resolve();
        await impl.waitForAllAgentsToComplete();
        fixture.reconcile.mockRestore();
        fixture.getFacet.mockRestore();
        expect(impl.storage.activeAgents.get(receipt.childChatId)).toBeUndefined();
      });
    }
    expect((await shared.listActions()).entries).toMatchObject([{ id: 1, state: "approved", resolvedBy: builderProfile }]);
    expect(await shared.getNamedDelegation(receipt.id)).toMatchObject({ receipt, canceled: true,
      run: { id: receipt.id, status: "canceled", attempt: 2 } });
  });

  it("restores canceled receipts and dedupes parent retries across deletion using real durable storage", async () => {
    let token: string;
    let source: AgentProfile;
    let receipt: NamedDelegationReceipt;
    let input: Awaited<ReturnType<typeof admit>>["input"];
    {
      using root = await connect();
      const owner = await account(root);
      token = owner.token;
      using api = root.authenticate(token);
      const pair = await bots(api);
      source = pair.source;
      using client = await api.openGadget(source.workspaceId);
      await client.setNamedDelegationConfig([{ targetAgentId: pair.target.id, bindings: {} }], 0);
      ({ receipt, input } = await admit(source, pair.target));
    }
    await abortAllDurableObjects();
    using root = await connect();
    using api = root.authenticate(token);
    using client = await api.openGadget(source.workspaceId);
    const validated = validateNamedDelegation(client);
    expect(await validated.getNamedDelegation(receipt.id)).toMatchObject({ receipt, canceled: true, deleted: false,
      run: { id: receipt.id, status: "canceled", attempt: 1 } });
    expect(await validated.getNamedDelegationConfig()).toMatchObject({ revision: 1, targets: [{ targetAgentId: input.targetAgentId }] });
    await client.deleteChat(receipt.childChatId);
    await client.setNamedDelegationConfig([], 1);
    const tombstone = await validated.getNamedDelegation(receipt.id);
    expect(tombstone).toEqual({ receipt, canceled: true, deleted: true, run: undefined, response: undefined });
    await runInDurableObject(workspace(source.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
      expect(impl.storage.namedDelegations.get(receipt.id)?.input).toBeUndefined();
      expect(impl.canResumeTask(receipt.childChatId, receipt.id, 1)).toBe(false);
      // Represent a retry of the same logical parent, without starting a provider turn.
      const execution = { id: receipt.parentRunId, attempt: 2 };
      const initiator = await impl.users.get(impl.users.idFromString(impl.ownerId!)).whoami();
      impl.storage.chatMeta.put({ ...impl.getChatMetaOrThrow(receipt.parentChatId), activeAgent: model });
      impl.storage.taskRuns.put({ ...impl.storage.taskRuns.get(execution.id)!, status: "running", reason: undefined, attempt: 2 });
      impl.storage.activeAgents.put({ chatId: receipt.parentChatId, initiator, initiatorUserId: impl.ownerId!,
        modelId: model.id, callbackInitiated: false, run: execution });
      try {
        const prepared = await impl.prepareNamedDelegation(receipt.parentChatId, execution, { ...input, bindingNames: [] });
        expect(prepared).toMatchObject({ id: receipt.id, existing: receipt });
        await commit(impl, prepared);
        expect(impl.getNamedDelegation(receipt.id)).toEqual(tombstone);
        expect([...impl.storage.chatMeta.list()].map(chat => chat.id)).toEqual([receipt.parentChatId]);
        expect([...impl.storage.namedDelegations.list()]).toHaveLength(1);
        await expect(impl.prepareNamedDelegation(receipt.parentChatId, execution, { ...input, prompt: "Conflicting retry" }))
          .rejects.toThrow("different input");
      } finally { impl.cancelAgent(receipt.parentChatId); }
    });
    expect(await validated.getNamedDelegation(receipt.id)).toEqual(tombstone);
  });
});
