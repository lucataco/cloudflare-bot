import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {env, RpcStub as NativeRpcStub, RpcTarget as NativeRpcTarget} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {createHash} from "node:crypto";
import {RpcStub} from "capnweb";
import {keyString} from "@gadgets/typed-storage";
import type {AgentProfile, AiChatAuthorInfo, GatekeeperCreationSpec, NamedDelegationReceipt} from "@gadgets/workshop-shared/api";
import type {ApprovalQueue, HookController} from "@gadgets/workshop-shared/gatekeeper";
import {runAgent, type ChatBindingEntry} from "../src/agent.js";
import type {OverseerDurableObject} from "../src/overseer.js";
import type {UserAiModelRecord, UserChatContext} from "../src/user.js";

vi.mock("../src/agent.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/agent.js")>(), runAgent: vi.fn(),
}));

declare global {
  namespace Cloudflare {
    interface Env { TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>; }
  }
}

type Impl = OverseerDurableObject["impl"];
const OWNER = "a".repeat(64);
const COLLABORATOR = "b".repeat(64);
const USER: AiChatAuthorInfo = {type: "user", id: "owner", name: "Owner"};
const EDITOR: AiChatAuthorInfo = {type: "user", id: "editor", name: "Editor"};
const MODEL: UserAiModelRecord = {profile: {type: "agent", id: "frozen-model", name: "Model"},
  config: {provider: "anthropic", model: "claude-sonnet-4-5", apiToken: "PRIVATE_MODEL_TOKEN"}};
const EMPTY = {changes: [], createdGadgets: [], addedBindings: []};
const READ: Record<string, ChatBindingEntry> = {READ: {type: "workpiece", id: 7}};
const CAPSULE = {gatekeeperId: 8, position: 0, length: 3, description: {url: "https://example.com/8",
  title: "PRIVATE_RESOURCE", snippet: "PRIVATE_SNIPPET", suggestedBindingName: "PRIVATE", tsType: "PrivateResource"}};
const WRITE = {title: "Explicit write", description: "Await approval", implementsRevert: false, autoApprovable: false, awaitDecision: true};

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Isolation tests forbid provider calls"));
  vi.mocked(runAgent).mockReset().mockResolvedValue({disposition: {status: "finished", reason: "model_stop"}});
});
afterEach(() => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); }
});

function resource(impl: Impl, id: number, creationSpec: GatekeeperCreationSpec = {
  type: "gatekeeper", vendorId: "test", resourceUrl: `https://example.com/${id}`,
  typeUrlPattern: "https://example.com/:id",
}) {
  // No facet is invoked by binding preparation; tests substitute the remote facet only when needed.
  impl.storage.gatekeepers.put({id, resourceTitle: id === 7 ? "Source grant" : "PRIVATE_RESOURCE",
    creationSpec, class: {} as Parameters<Impl["addGatekeeper"]>[0]});
}

function setup(impl: Impl) {
  impl.ownerId = OWNER;
  impl.ownerProfileId = USER.id;
  const source: AgentProfile = {id: "source", name: "Source", title: "Source", description: "PRIVATE_SOURCE_INSTRUCTIONS",
    workspaceId: impl.ctx.id.toString(), defaultModelId: "source-model", created: new Date(1), updated: new Date(1)};
  const target: AgentProfile = {...source, id: "target", name: "Frozen researcher", description: "Frozen task instructions",
    workspaceId: "PRIVATE_TARGET_WORKSPACE", defaultModelId: MODEL.profile.id, defaultBindings: [987]};
  const user = {
    id: {toString: () => OWNER}, whoami: vi.fn(async () => USER),
    getChatContext: vi.fn(async (_model?: string | null, _workspace?: string, _agent?: string): Promise<UserChatContext> =>
      ({profile: USER, aiModel: MODEL})),
    getAgent: vi.fn(async (id: string) => structuredClone(id === "target" ? target : source)),
    getAgentByWorkspaceId: vi.fn(async () => structuredClone(source)),
    getGroupByWorkspaceId: vi.fn(async () => null), recordSharedGadgetOpen: vi.fn(async () => {}),
    setGadgetLastActive: vi.fn(async () => {}),
  };
  const collaborator = {...user, id: {toString: () => COLLABORATOR}, whoami: vi.fn(async () => EDITOR),
    getChatContext: vi.fn(async (): Promise<UserChatContext> => {throw new Error("Collaborator cannot resolve the owner's model");})};
  Object.assign(impl, {users: {idFromString: (id: string) => id, idFromName: () => user.id,
    get: (id: string) => {
      if (id === OWNER) return user;
      if (id === COLLABORATOR) return collaborator;
      throw new Error("Unexpected user lookup");
    }},
    getSharingManager: async () => ({getEffectiveRole: () => "build"})});
  vi.spyOn(impl, "ensureAmbientCapsules").mockResolvedValue(undefined);
  vi.spyOn(impl, "ensureObserver").mockResolvedValue(undefined);
  vi.spyOn(impl, "markOutputsDirty").mockImplementation(() => {});
  vi.spyOn(impl, "syncOutputsTo").mockResolvedValue(true);
  vi.spyOn(impl, "joinOutputsFanout").mockReturnValue(() => {});
  vi.spyOn(impl, "recordGadgetAnalytics").mockImplementation(() => {});
  resource(impl, 7);
  resource(impl, 8);

  // Minimal admitted state, not a second implementation of preparation/admission. All records,
  // indexes, task transitions, and enforcement below use the production impl over workerd SQLite.
  const parent = impl.nextChatId();
  const child = impl.nextChatId();
  const timestamp = impl.getChatTimestamp();
  for (const id of [parent, child]) {
    impl.storage.chatMeta.put({id, title: id === parent ? "Parent" : "Child", started: timestamp, lastActive: timestamp});
    impl.addChatMessages(id, USER, [{type: "message", message: id === parent ? "PRIVATE_PARENT_TASK" : "Explicit child task"}]);
  }
  impl.storage.chatContext.put({chatId: parent, agentId: source.id, bindings: {SOURCE: 8}});
  const parentRun = impl.admitTaskRun(parent, 0, {type: "prompt"});
  const input = {requestId: "research", targetAgentId: target.id, title: "Research", prompt: "Explicit child task", bindingNames: ["READ"]};
  const id = createHash("sha256").update(JSON.stringify([impl.ctx.id.toString(), parentRun.id, input.requestId])).digest("hex");
  const receipt: NamedDelegationReceipt = {id, parentRunId: parentRun.id, parentChatId: parent, parentAttempt: 1,
    parentSequence: 1, childChatId: child, targetAgentId: target.id, targetName: target.name};
  impl.storage.namedDelegations.put({id, receipt, input, canceled: false,
    inputDigest: createHash("sha256").update(JSON.stringify([input.requestId, input.targetAgentId, input.title, input.prompt, input.bindingNames])).digest("hex")});
  impl.storage.chatMeta.put({...impl.getChatMetaOrThrow(child), namedDelegation: receipt});
  impl.storage.chatContext.put({chatId: child, namedDelegation: receipt, bindings: {READ: 7},
    spawnerConfig: {displayName: target.name, modelId: MODEL.profile.id, env: {READ: 7}},
    agentInstructions: target.description, alwaysAvailableCapsuleIds: [], alwaysAvailableCatalogs: []});
  impl.addChatMessages(parent, MODEL.profile, [{type: "namedDelegation", delegation: receipt}]);
  const run = impl.admitTaskRun(child, 0, {type: "delegation", parent: {chatId: parent, runId: parentRun.id,
    attempt: 1, targetAgentId: target.id, targetName: target.name}}, id);
  impl.storage.taskRuns.put({...run, attempt: 1, status: "waiting", reason: "action_approval"});
  return {impl, user, collaborator, source, target, parent, child, receipt};
}

type Fixture = ReturnType<typeof setup>;
function withChild(test: (f: Fixture, instance: OverseerDurableObject) => Promise<void>) {
  return runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    const f = setup(instance["impl"]);
    const parentContext = f.impl.storage.chatContext.get(f.parent);
    try { await test(f, instance); } finally {
      await f.impl.waitForAllAgentsToComplete();
      expect(f.impl.storage.chatContext.get(f.parent)).toEqual(parentContext);
    }
  });
}

async function open(instance: OverseerDurableObject, userId = OWNER, profileId = USER.id) {
  using closed = new NativeRpcStub<() => void>(() => {});
  return new RpcStub(await instance.open(userId, profileId, closed));
}

function transcript(impl: Impl, chatId: number) {
  return [...impl.storage.chats.list({prefix: `${keyString(chatId)}.`})];
}

function pendingWrite(impl: Impl, child: number, receipt: NamedDelegationReceipt) {
  impl.storage.actions.put({id: 1, type: "action", gatekeeperId: 7, action: 100, resourceTitle: "Source grant",
    caller: {from: "agent", chatId: child, runId: receipt.id, attempt: 1}, createdAt: new Date(1), state: "pending",
    description: WRITE});
  impl.storage.nextActionId.put(2);
  impl.addChatMessages(child, {...MODEL.profile, name: receipt.targetName}, [{type: "action", actionId: 1}],
    undefined, undefined, undefined, undefined, receipt.id);
  const applyAction = vi.fn(async (_id: number) => {});
  Object.assign(impl, {getGatekeeperFacet: () => ({applyAction})});
  return applyAction;
}

// This is a loader-definition/RPC-argument test double, NOT execution of a loaded Worker.
// Capture the real tail's routing ID and finish through the production trace resolver.
function captureLoader(impl: Impl) {
  let executionId = "";
  const ctx = impl.ctx;
  const tail = vi.fn((options: Parameters<typeof ctx.exports.CodeModeTailLoopback>[0]) => {
    executionId = options.props!.executionId;
    return ctx.exports.CodeModeTailLoopback(options);
  });
  const self = vi.fn((options: Parameters<typeof ctx.exports.AgentSelfLoopback>[0]) => ctx.exports.AgentSelfLoopback(options));
  impl.ctx = new Proxy(ctx, {get(target, key) {
    if (key === "exports") return {...target.exports, CodeModeTailLoopback: tail, AgentSelfLoopback: self};
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  }});
  const verify = vi.fn(async () => {});
  const run = vi.fn(async (..._args: unknown[]) => {
    await impl.deliverCodeModeTrace(executionId, {logs: [{message: ["captured trace"], level: "log", timestamp: Date.now()}],
      exceptions: [], outcome: "ok", event: null, eventTimestamp: Date.now(), scriptName: null, diagnosticsChannelEvents: [],
      executionModel: "stateless", truncated: false, cpuTime: 0, wallTime: 0});
  });
  const load = vi.fn((_definition: WorkerLoaderWorkerCode) => ({getEntrypoint: () => ({verify, run})}));
  Object.assign(impl, {env: {...impl.env, LOADER: {load}}});
  return {load, verify, run, self};
}

describe("named child binding isolation in workerd", () => {
  it("intersects exact frozen names and IDs, dropping forged aliases, swaps, values, gadgets, spawners and ambient resources", () => withChild(async ({impl, child, parent}) => {
    resource(impl, 9, {type: "ambient", vendorId: "context", accountId: 1});
    resource(impl, 10, {type: "agentSpawner", config: {displayName: "PRIVATE_SPAWNER", modelId: null, env: {}}});
    const gadget = impl.createGadget("PRIVATE_PROVISIONAL_GADGET", "PRIVATE", parent);
    const loopback = vi.spyOn(impl, "makeBindingLoopback");
    expect(Object.keys(impl.getEnvForAgent(child, {...READ, ALIAS: READ.READ, PRIVATE: {type: "workpiece", id: 8},
      AMBIENT: {type: "workpiece", id: 9}, SPAWN: {type: "workpiece", id: 10},
      GADGET: {type: "workpiece", id: gadget.id}, PARAMS: {type: "value", messageSequence: 99}}))).toEqual(["READ"]);
    expect(loopback).toHaveBeenCalledExactlyOnceWith({type: "gatekeeper", id: 7}, expect.objectContaining({from: "agent", chatId: child}));
    loopback.mockClear();
    for (const entry of [{type: "workpiece", id: 8}, {type: "value", messageSequence: 99}] satisfies ChatBindingEntry[]) {
      expect(impl.getEnvForAgent(child, {READ: entry})).toEqual({});
    }
    expect(loopback).not.toHaveBeenCalled();
    expect(impl.storage.gadgets.get(gadget.id)?.pending?.chatId).toBe(parent);
  }));

  it.each(["deleted", "ambient", "spawner", "model", "gadget"] as const)("drops a frozen ID that now resolves to %s", kind => withChild(async ({impl, child}) => {
    impl.storage.gatekeepers.delete(7);
    if (kind === "ambient") resource(impl, 7, {type: "ambient", vendorId: "context", accountId: 1});
    if (kind === "spawner") resource(impl, 7, {type: "agentSpawner", config: {displayName: "Private", modelId: null, env: {}}});
    if (kind === "model") resource(impl, 7, {type: "aiModel", modelId: MODEL.profile.id, provider: "anthropic", modelName: MODEL.config.model});
    if (kind === "gadget") {
      const gadget = impl.createGadget("Private", "PRIVATE", child);
      const record = impl.storage.gadgets.get(gadget.id)!;
      impl.storage.gadgets.delete(gadget.id);
      impl.storage.gadgets.put({...record, id: 7});
    }
    const loopback = vi.spyOn(impl, "makeBindingLoopback");
    expect(impl.getEnvForAgent(child, READ)).toEqual({});
    expect(await impl.prepareChatBindings(child, transcript(impl, child))).toEqual([]);
    expect(loopback).not.toHaveBeenCalled();
  }));

  it("returns frozen externals without default, ambient/catalog, history naming or target-private reads", () => withChild(async ({impl, child, user}) => {
    resource(impl, 9, {type: "ambient", vendorId: "context", accountId: 1});
    const defaults = vi.spyOn(impl, "defaultBindingList").mockReturnValue({PRIVATE_DEFAULT: 8});
    const facet = vi.spyOn(impl, "getGatekeeperFacet").mockImplementation(() => {throw new Error("PRIVATE_CATALOG_READ");});
    const skills = vi.spyOn(impl, "getAgentSkills");
    const memory = vi.spyOn(impl, "listAgentMemory");
    const naming = vi.spyOn(impl, "generateBindingName");
    impl.addChatMessages(child, USER, [{type: "message", message: "Old injected history", capsules: [CAPSULE]}]);
    const before = impl.storage.chatContext.get(child);
    const messages = transcript(impl, child);
    const originalMessages = structuredClone(messages);
    expect(await impl.prepareChatBindings(child, messages)).toEqual([{name: "READ", target: 7, title: "Source grant", isGadget: false}]);
    expect(messages).toEqual(originalMessages);
    expect(transcript(impl, child)).toEqual(originalMessages);
    expect(impl.storage.chatContext.get(child)).toEqual(before);
    for (const hook of [defaults, facet, skills, memory, naming, impl.ensureAmbientCapsules, user.getAgent, user.getChatContext]) {
      expect(hook).not.toHaveBeenCalled();
    }
  }));

  it("an empty frozen grant stays empty rather than falling back to defaults", () => withChild(async ({impl, child}) => {
    impl.storage.chatContext.put({...impl.storage.chatContext.get(child)!, bindings: {},
      spawnerConfig: {displayName: "Frozen researcher", modelId: MODEL.profile.id, env: {}}});
    const defaults = vi.spyOn(impl, "defaultBindingList").mockReturnValue({PRIVATE: 8});
    expect(await impl.prepareChatBindings(child, [])).toEqual([]);
    expect(impl.getEnvForAgent(child, READ)).toEqual({});
    expect(defaults).not.toHaveBeenCalled();
  }));

  it("copies only the source grant, not the target's default resources or mutable private profile state", () => withChild(async ({impl, parent, source, target, user}) => {
    const run = impl.storage.taskRuns.get(impl.getChatMetaOrThrow(parent).currentRunId!)!;
    impl.storage.taskRuns.put({...run, status: "running", reason: undefined, attempt: 1});
    impl.storage.chatMeta.put({...impl.getChatMetaOrThrow(parent), activeAgent: MODEL.profile});
    impl.storage.activeAgents.put({chatId: parent, run: {id: run.id, attempt: 1}, initiatorUserId: OWNER,
      initiator: USER, modelId: MODEL.profile.id, callbackInitiated: false});
    await impl.setNamedDelegationConfig(OWNER, [{targetAgentId: target.id, bindings: {READ: 7, OTHER: 8}}], 0);
    const prepared = await impl.prepareNamedDelegation(parent, {id: run.id, attempt: 1}, {
      requestId: "source-grant-only", targetAgentId: target.id, title: "New child", prompt: "Explicit task", bindingNames: ["READ"],
    });
    expect(prepared).toMatchObject({bindings: {READ: 7}, targetName: target.name, targetInstructions: target.description, model: MODEL});
    expect(user.getChatContext).toHaveBeenCalledExactlyOnceWith(MODEL.profile.id);
    target.defaultBindings = [8, 987];
    target.name = "PRIVATE_LATER_NAME";
    target.description = "PRIVATE_LATER_INSTRUCTIONS";
    await impl.commitAgentStep(parent, MODEL.profile, [{type: "message", message: "Delegate", toolCalls: [{
      toolName: "delegateToBot", toolCallId: "new", input: prepared.input, delegationId: prepared.id,
    }]}], {...EMPTY, run: {id: run.id, attempt: 1}, delegations: [prepared]});
    await impl.waitForAllAgentsToComplete();
    const admitted = impl.getNamedDelegation(prepared.id).receipt;
    expect(impl.storage.chatContext.get(admitted.childChatId)).toEqual({chatId: admitted.childChatId,
      bindings: {READ: 7}, namedDelegation: admitted, agentInstructions: "Frozen task instructions",
      spawnerConfig: {displayName: "Frozen researcher", modelId: MODEL.profile.id, env: {READ: 7}},
      alwaysAvailableCapsuleIds: [], alwaysAvailableCatalogs: []});
    expect(impl.storage.chatContext.get(parent)?.agentId).toBe(source.id);
    expect(JSON.stringify(impl.storage.chatContext.get(admitted.childChatId))).not.toContain("PRIVATE_");
  }));
});

describe("isolated context fail-closed checks", () => {
  it.each(["missing-meta", "missing-context", "meta-receipt", "context-receipt", "different-id", "no-spawner", "no-bindings", "agent-id"] as const)(
    "refuses %s before preparing bindings, constructing env or loading code", kind => withChild(async ({impl, child}) => {
      const meta = impl.getChatMetaOrThrow(child);
      const context = impl.storage.chatContext.get(child)!;
      if (kind === "missing-meta") impl.storage.chatMeta.delete(child);
      if (kind === "missing-context") impl.storage.chatContext.delete(child);
      if (kind === "meta-receipt") impl.storage.chatMeta.put({...meta, namedDelegation: undefined});
      if (kind === "context-receipt") impl.storage.chatContext.put({...context, namedDelegation: undefined});
      if (kind === "different-id") impl.storage.chatContext.put({...context, namedDelegation: {...context.namedDelegation!, id: "forged"}});
      if (kind === "no-spawner") impl.storage.chatContext.put({...context, spawnerConfig: undefined});
      if (kind === "no-bindings") impl.storage.chatContext.put({...context, bindings: undefined});
      if (kind === "agent-id") impl.storage.chatContext.put({...context, agentId: "target"});
      const loader = captureLoader(impl);
      expect(() => impl.getEnvForAgent(child, READ)).toThrow("Invalid isolated delegation context");
      await expect(impl.prepareChatBindings(child, [])).rejects.toThrow("Invalid isolated delegation context");
      await expect(impl.executeCodeMode(child, "", USER, MODEL.profile.id, READ)).rejects.toThrow("Invalid isolated delegation context");
      expect(loader.load).not.toHaveBeenCalled();
    }));

  it.each(["childChatId", "parentRunId"] as const)("rejects mismatched receipt %s even when receipt IDs match", field => withChild(async ({impl, child, receipt}) => {
    impl.storage.chatContext.put({...impl.storage.chatContext.get(child)!, namedDelegation: {
      ...receipt, ...(field === "childChatId" ? {childChatId: child + 100} : {parentRunId: "foreign-parent"}),
    }});
    expect(() => impl.getEnvForAgent(child, READ)).toThrow("Invalid isolated delegation context");
    await expect(impl.prepareChatBindings(child, [])).rejects.toThrow("Invalid isolated delegation context");
  }));

  it("rejects identical receipts pointing at a different child chat", () => withChild(async ({impl, child, receipt}) => {
    const foreign = {...receipt, childChatId: child + 100};
    impl.storage.chatMeta.put({...impl.getChatMetaOrThrow(child), namedDelegation: foreign});
    impl.storage.chatContext.put({...impl.storage.chatContext.get(child)!, namedDelegation: foreign});
    const loader = captureLoader(impl);
    expect(() => impl.getEnvForAgent(child, READ)).toThrow("Invalid isolated delegation context");
    await expect(impl.prepareChatBindings(child, [])).rejects.toThrow("Invalid isolated delegation context");
    await expect(impl.executeCodeMode(child, "", USER, MODEL.profile.id, READ)).rejects.toThrow("Invalid isolated delegation context");
    expect(loader.load).not.toHaveBeenCalled();
  }));
});

describe("read-only child follow-ups and approval continuation", () => {
  it.each(["source", "target"])("rejects a public model-free follow-up resolved as %s without backfilling its profile", agentId => withChild(async ({impl, child, user, source, target}, instance) => {
    user.getChatContext.mockResolvedValue({profile: USER, agentProfile: agentId === "source" ? source : target});
    using client = await open(instance);
    const context = impl.storage.chatContext.get(child);
    const meta = impl.getChatMetaOrThrow(child);
    const messages = transcript(impl, child);
    let error: unknown;
    try { await client.sendChatMessage(child, "Follow up", null, undefined, undefined, undefined, agentId); }
    catch (caught) { error = caught; }
    expect(error).toMatchObject({message: expect.stringContaining("parent conversation")});
    expect(user.getChatContext).not.toHaveBeenCalled();
    expect(impl.storage.chatContext.get(child)).toEqual(context);
    expect(impl.getChatMetaOrThrow(child)).toEqual(meta);
    expect(transcript(impl, child)).toEqual(messages);
    expect([...impl.storage.chatQueue.list()]).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  }));

  it.each(["source", "target"])("denies model-free follow-ups without backfilling %s identity, attachments, capabilities, slash commands or queue", agentId => withChild(async ({impl, child, user, source, target}, instance) => {
    using client = await open(instance);
    const clientUser = impl.users.get(impl.users.idFromString(OWNER));
    const userMeta: UserChatContext = {profile: USER, agentProfile: agentId === "source" ? source : target};
    const context = impl.storage.chatContext.get(child);
    const meta = impl.getChatMetaOrThrow(child);
    const messages = transcript(impl, child);
    const runs = [...impl.storage.taskRuns.list()];
    const canonicalize = vi.spyOn(impl, "canonicalizeChatAttachmentRefs");
    const facet = vi.spyOn(impl, "getGatekeeperFacet");
    await expect(impl.sendChatMessage(clientUser, userMeta, child, "Follow up")).rejects.toThrow("parent conversation");
    await expect(impl.sendChatMessage(clientUser, userMeta, child, "Attach", [CAPSULE], [{id: "PRIVATE_ATTACHMENT"}])).rejects.toThrow("parent conversation");
    await expect(impl.sendChatMessage(clientUser, userMeta, child,
      {id: {gatekeeperId: 8, commandId: "private"}, args: "read private context"})).rejects.toThrow("parent conversation");
    await expect(impl.sendChatMessage(clientUser, userMeta, child,
      {id: {builtin: true, commandId: "compact"}, args: ""})).rejects.toThrow("parent conversation");
    // An active child must reject before the ordinary send path can enqueue the prompt.
    impl.storage.chatMeta.put({...meta, activeAgent: MODEL.profile});
    await expect(impl.sendChatMessage(clientUser, userMeta, child, "Queue this")).rejects.toThrow("parent conversation");
    impl.storage.chatMeta.put(meta);
    await expect(client.retryAgent(child, "PRIVATE_REPLACEMENT_MODEL")).rejects.toThrow("parent conversation");
    expect(impl.storage.chatContext.get(child)).toEqual(context);
    expect(impl.getChatMetaOrThrow(child)).toEqual(meta);
    expect(transcript(impl, child)).toEqual(messages);
    expect([...impl.storage.taskRuns.list()]).toEqual(runs);
    expect([...impl.storage.chatQueue.list()]).toEqual([]);
    expect(canonicalize).not.toHaveBeenCalled();
    expect(facet).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(user.getChatContext).not.toHaveBeenCalled();
  }));

  it("rejects child callbacks before recording arguments or admitting work", () => withChild(async ({impl, child, user}) => {
    const messages = transcript(impl, child);
    await expect(impl.deliverAgentCallback(child, "privateHook", [{secret: "PRIVATE_CALLBACK"}], OWNER, "other-model")).rejects.toThrow("do not accept callbacks");
    expect(transcript(impl, child)).toEqual(messages);
    expect([...impl.storage.agentCallbackArgs.list()]).toEqual([]);
    expect(user.getChatContext).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  }));

  it.each([false, true])("approves the pending write without expanding authority or reviving a canceled child (canceled: %s)", canceled => withChild(async ({impl, child, parent, receipt, target, user}, instance) => {
    const applyAction = pendingWrite(impl, child, receipt);
    target.defaultModelId = "PRIVATE_LATER_MODEL";
    target.defaultBindings = [8, 987];
    target.name = "PRIVATE_LATER_NAME";
    target.description = "PRIVATE_LATER_INSTRUCTIONS";
    const context = impl.storage.chatContext.get(child);
    const run = impl.storage.taskRuns.get(receipt.id)!;
    vi.mocked(runAgent).mockImplementationOnce(async (hooks, _model, chatId) => {
      expect(hooks.getChatAgentContext(chatId)).toEqual(context);
      expect(await hooks.prepareChatBindings(chatId, transcript(impl, child))).toEqual([{name: "READ", target: 7, title: "Source grant", isGadget: false}]);
      expect(Object.keys(impl.getEnvForAgent(child, {...READ, PRIVATE: {type: "workpiece", id: 8}}))).toEqual(["READ"]);
      return {disposition: {status: "finished", reason: "model_stop"}};
    });
    using client = await open(instance);
    if (canceled) await client.stopAgent(parent);
    const messages = transcript(impl, child);
    await client.approveAction(1);
    await impl.waitForAllAgentsToComplete();
    expect(applyAction).toHaveBeenCalledExactlyOnceWith(100);
    expect(impl.storage.actions.get(1)).toMatchObject({state: "approved", resolvedBy: USER, autoApproved: false});
    expect(impl.storage.chatContext.get(child)).toEqual(context);
    expect(impl.storage.taskRuns.get(receipt.id)).toMatchObject({source: run.source, sourceSequence: run.sourceSequence,
      attempt: canceled ? 1 : 2, status: canceled ? "canceled" : "finished"});
    if (canceled) {
      expect(transcript(impl, child)).toEqual(messages);
      expect(user.getChatContext).not.toHaveBeenCalled();
      expect(runAgent).not.toHaveBeenCalled();
      expect(() => impl.getEnvForAgent(child, READ)).toThrow("canceled");
      await expect(impl.executeCodeMode(child, "", USER, MODEL.profile.id, READ)).rejects.toThrow("canceled");
      await expect(client.retryAgent(child, "PRIVATE_REPLACEMENT_MODEL")).rejects.toThrow("parent conversation");
      expect(impl.canResumeTask(child, receipt.id, 1)).toBe(false);
      expect(impl.storage.activeAgents.get(child)).toBeUndefined();
    } else {
      expect(user.getChatContext).toHaveBeenCalledExactlyOnceWith(MODEL.profile.id);
      expect(user.getAgent).not.toHaveBeenCalled();
      expect(runAgent).toHaveBeenCalledOnce();
      expect(vi.mocked(runAgent).mock.calls[0][3]).toEqual({...MODEL.profile, name: receipt.targetName});
      expect(vi.mocked(runAgent).mock.calls[0][8]?.modelConfig).toEqual(MODEL.config);
      expect(vi.mocked(runAgent).mock.calls[0][9]).toEqual({id: receipt.id, attempt: 2});
    }
  }));

  it.each(["available", "missing", "error"] as const)("collaborator approval uses the original owner's frozen model (%s)", availability => withChild(async ({impl, child, receipt, user, collaborator, target}, instance) => {
    const applyAction = pendingWrite(impl, child, receipt);
    impl.addChatMessages(child, {...MODEL.profile, id: "PRIVATE_HISTORY_MODEL"}, [{type: "message", message: "Awaiting approval"}],
      undefined, undefined, undefined, undefined, receipt.id);
    target.defaultModelId = "PRIVATE_LATER_MODEL";
    target.defaultBindings = [8];
    const context = impl.storage.chatContext.get(child);
    const run = impl.storage.taskRuns.get(receipt.id)!;
    if (availability === "missing") user.getChatContext.mockResolvedValue({profile: USER});
    if (availability === "error") user.getChatContext.mockRejectedValue(new Error("Model was removed"));
    vi.mocked(runAgent).mockImplementationOnce(async (hooks, _model, chatId, author, _history, _signal, initiator) => {
      expect(author).toEqual({...MODEL.profile, name: receipt.targetName});
      expect(initiator).toEqual(USER);
      expect(impl.storage.activeAgents.get(child)).toMatchObject({initiatorUserId: OWNER, modelId: MODEL.profile.id,
        run: {id: receipt.id, attempt: 2}});
      expect(hooks.getChatAgentContext(chatId)).toEqual(context);
      expect(await hooks.prepareChatBindings(chatId, transcript(impl, child))).toEqual([{name: "READ", target: 7, title: "Source grant", isGadget: false}]);
      expect(Object.keys(impl.getEnvForAgent(child, {...READ, PRIVATE: {type: "workpiece", id: 8}}))).toEqual(["READ"]);
      return {disposition: {status: "finished", reason: "model_stop"}};
    });
    using client = await open(instance, COLLABORATOR, EDITOR.id);
    await client.approveAction(1);
    await impl.waitForAllAgentsToComplete();
    expect(applyAction).toHaveBeenCalledExactlyOnceWith(100);
    expect(impl.storage.actions.get(1)).toMatchObject({state: "approved", resolvedBy: EDITOR});
    expect(user.getChatContext).toHaveBeenCalledExactlyOnceWith(MODEL.profile.id);
    expect(collaborator.getChatContext).not.toHaveBeenCalled();
    expect(user.getAgent).not.toHaveBeenCalled();
    expect(impl.storage.chatContext.get(child)).toEqual(context);
    expect(impl.storage.activeAgents.get(child)).toBeUndefined();
    expect(impl.getChatMetaOrThrow(child).activeAgent).toBeUndefined();
    expect(impl.storage.taskRuns.get(receipt.id)).toMatchObject({source: run.source, sourceSequence: run.sourceSequence,
      attempt: availability === "available" ? 2 : 1,
      status: availability === "available" ? "finished" : "incomplete",
      reason: availability === "available" ? "model_stop" : "model_unavailable"});
    if (availability === "available") {
      expect(runAgent).toHaveBeenCalledOnce();
      expect(vi.mocked(runAgent).mock.calls[0][8]?.modelConfig).toEqual(MODEL.config);
    } else {
      expect(runAgent).not.toHaveBeenCalled();
      expect(impl.canResumeTask(child, receipt.id, 1)).toBe(false);
      expect(transcript(impl, child).at(-1)).toMatchObject({runId: receipt.id,
        message: expect.stringContaining("delegated model could not be resumed")});
    }
  }));
});

describe("retained named-child resource capabilities", () => {
  it.each(["stop", "delete"] as const)("rejects later sessions, reads, writes and hooks after %s while the canceled model is still held", operation => withChild(async ({impl, child, receipt}, instance) => {
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const returned = vi.fn();
    const background = vi.spyOn(impl.ctx, "waitUntil");
    vi.mocked(runAgent).mockImplementationOnce(async (_hooks, _model, _chatId, _author, _history, signal) => {
      entered.resolve(signal);
      await release.promise;
      returned();
      return {disposition: {status: "waiting", reason: "action_approval"}};
    });
    impl.startAgent(child, MODEL, USER, OWNER, false, true);
    const turn = background.mock.lastCall![0];
    try {
      const signal = await entered.promise;
      const binding = vi.spyOn(impl, "makeBindingLoopback");
      impl.getEnvForAgent(child, READ);
      const [target, sealed] = binding.mock.calls[0];
      // Copy what the real turn sealed, as an RPC boundary does, rather than fabricating authority.
      const caller = structuredClone(sealed);
      expect(caller).toMatchObject({from: "agent", chatId: child, runId: receipt.id, attempt: 2,
        author: USER, captureId: expect.any(String)});
      // The remote facet seam returns the actual queue target; no mocked authorization methods.
      const startSession = vi.fn(async (queue: ApprovalQueue) => queue);
      const facet = vi.fn(() => ({startSession}));
      Object.assign(impl, {getGatekeeperFacet: facet});
      const queue: ApprovalQueue = await impl.startGatekeeperSession(target, caller);
      const observation = {title: "Read supplied resource", description: "Explicit read"};
      await queue.authorizeObservation(observation);
      await queue.submitAction(100, WRITE);
      const earlier = [...impl.storage.actions.list()];
      expect(earlier).toMatchObject([{type: "observation", state: "approved", caller},
        {type: "action", state: "pending", caller, action: 100}]);

      // Use valid native capabilities so the rejection comes from the child's hook guard, not validation.
      const controller = env.LOADER.load({compatibilityDate: "2026-02-01", mainModule: "controller.js",
        modules: {"controller.js": `import { WorkerEntrypoint } from "cloudflare:workers";
          export default class extends WorkerEntrypoint { async enable() {} async disable() {} }`},
        globalOutbound: null}).getEntrypoint<HookController<NativeRpcTarget>>();
      using callback = new NativeRpcStub(new class extends NativeRpcTarget {}());
      await expect(queue.bindHook(controller, callback, observation)).rejects.toThrow("cannot register persistent hooks");
      expect([...impl.storage.boundHooks.list()]).toEqual([]);
      expect([...impl.storage.actions.list()]).toEqual(earlier);
      // The same sealed caller cannot substitute an external resource outside READ's grant.
      expect(() => impl.startGatekeeperSession({type: "gatekeeper", id: 8}, caller)).toThrow("frozen grant");
      await expect(impl.authorizeObservation(8, observation, caller)).rejects.toThrow("frozen grant");
      await expect(impl.submitAction(8, 101, WRITE, caller)).rejects.toThrow("frozen grant");

      using client = await open(instance);
      if (operation === "stop") await client.stopAgent(child);
      else await client.deleteChat(child);
      expect(signal.aborted).toBe(true);
      expect(returned).not.toHaveBeenCalled();
      expect(impl.storage.activeAgents.get(child)).toBeUndefined();
      if (operation === "delete") {
        expect(impl.storage.chatMeta.get(child)).toBeUndefined();
        expect(impl.storage.taskRuns.get(receipt.id)).toBeUndefined();
        expect(impl.storage.namedDelegations.get(receipt.id)).toMatchObject({receipt, canceled: true});
      }
      const messages = transcript(impl, child);
      expect(() => impl.startGatekeeperSession(target, caller)).toThrow("canceled or deleted");
      await expect(queue.authorizeObservation(observation)).rejects.toThrow("canceled or deleted");
      await expect(queue.submitAction(101, WRITE)).rejects.toThrow("canceled or deleted");
      await expect(queue.bindHook(controller, callback, observation)).rejects.toThrow("canceled or deleted");
      expect(startSession).toHaveBeenCalledOnce();
      expect(facet).toHaveBeenCalledOnce();
      expect([...impl.storage.actions.list()]).toEqual(earlier);
      expect(impl.storage.nextActionId.get()).toBe(2);
      expect([...impl.storage.boundHooks.list()]).toEqual([]);
      expect(transcript(impl, child)).toEqual(messages);
      expect(impl.storage.namedDelegations.get(receipt.id)?.canceled).toBe(true);
      expect(returned).not.toHaveBeenCalled();
    } finally {release.resolve(); await turn;}
  }));

  it("deleting a held child wakes idle waiters immediately and its detached finalizer leaves a replacement chat running", () => withChild(async ({impl, child, receipt}, instance) => {
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const replacementEntered = Promise.withResolvers<AbortSignal>();
    const releaseReplacement = Promise.withResolvers<void>();
    const returned = vi.fn();
    const background = vi.spyOn(impl.ctx, "waitUntil");
    vi.mocked(runAgent)
      .mockImplementationOnce(async (_hooks, _model, _chatId, _author, _history, signal) => {
        entered.resolve(signal);
        await release.promise;
        returned();
        return {disposition: {status: "finished", reason: "model_stop"}};
      })
      .mockImplementationOnce(async (_hooks, _model, _chatId, _author, _history, signal) => {
        replacementEntered.resolve(signal);
        await releaseReplacement.promise;
        return {disposition: {status: "finished", reason: "model_stop"}};
      });
    // keepAlive exposes the actual production turn promise, including its detached finally.
    impl.startAgent(child, MODEL, USER, OWNER, false, true);
    const oldTurn = background.mock.lastCall![0];
    try {
      const signal = await entered.promise;
      const idle = vi.fn();
      const waiting = impl.waitForAllAgentsToComplete().then(idle);
      using client = await open(instance);
      expect(idle).not.toHaveBeenCalled();
      await client.deleteChat(child);
      await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce());
      await waiting;
      // Also cover a waiter registered after deletion, while the old promise is still outstanding.
      await impl.waitForAllAgentsToComplete();
      expect(signal.aborted).toBe(true);
      expect(returned).not.toHaveBeenCalled();
      expect(impl.storage.activeAgents.get(child)).toBeUndefined();
      expect(impl.storage.chatMeta.get(child)).toBeUndefined();
      expect(impl.storage.chatContext.get(child)).toBeUndefined();
      expect(impl.storage.taskRuns.get(receipt.id)).toBeUndefined();
      const tombstone = impl.storage.namedDelegations.get(receipt.id);
      expect(tombstone).toMatchObject({receipt, canceled: true});

      const replacement = await client.newChat("Replacement task", MODEL.profile.id);
      const replacementSignal = await replacementEntered.promise;
      expect(replacement).not.toBe(child);
      const active = impl.storage.activeAgents.get(replacement);
      const meta = impl.getChatMetaOrThrow(replacement);
      const context = impl.storage.chatContext.get(replacement);
      const run = impl.storage.taskRuns.get(meta.currentRunId!);
      const messages = transcript(impl, replacement);
      expect(active).toMatchObject({initiatorUserId: OWNER, modelId: MODEL.profile.id});
      expect(run).toMatchObject({chatId: replacement, status: "running"});
      const replacementIdle = vi.fn();
      const replacementWaiting = impl.waitForAllAgentsToComplete().then(replacementIdle);
      release.resolve();
      await oldTurn;
      expect(returned).toHaveBeenCalledOnce();
      expect(replacementSignal.aborted).toBe(false);
      expect(replacementIdle).not.toHaveBeenCalled();
      expect(impl.storage.activeAgents.get(replacement)).toEqual(active);
      expect(impl.getChatMetaOrThrow(replacement)).toEqual(meta);
      expect(impl.storage.chatContext.get(replacement)).toEqual(context);
      expect(impl.storage.taskRuns.get(meta.currentRunId!)).toEqual(run);
      expect(transcript(impl, replacement)).toEqual(messages);
      expect(impl.storage.namedDelegations.get(receipt.id)).toEqual(tombstone);
      expect(impl.storage.chatMeta.get(child)).toBeUndefined();
      expect(impl.storage.chatContext.get(child)).toBeUndefined();
      expect(impl.storage.taskRuns.get(receipt.id)).toBeUndefined();
      expect(impl.storage.activeAgents.get(child)).toBeUndefined();
      expect(transcript(impl, child)).toEqual([]);
      releaseReplacement.resolve();
      await replacementWaiting;
      expect(replacementIdle).toHaveBeenCalledOnce();
      expect(impl.storage.taskRuns.get(meta.currentRunId!)).toMatchObject({status: "finished", reason: "model_stop"});
    } finally {
      release.resolve();
      releaseReplacement.resolve();
      await oldTurn;
      await impl.waitForAllAgentsToComplete();
    }
  }));
});

describe("code-mode loader contract (captured, not live Worker execution)", () => {
  it.each([true, false])("restricts child capabilities while preserving legacy self/ctx/forger behavior (child: %s)", restricted => withChild(async ({impl, child, parent}) => {
    const loader = captureLoader(impl);
    const chatId = restricted ? child : parent;
    impl.storage.agentCallbackArgs.put({chatId, sequence: 4, args: ["legacy argument"]});
    const bindings: Record<string, ChatBindingEntry> = {...READ, PARAMS_1: {type: "value", messageSequence: 4}};
    const code = "export default async (self, env, ctx) => { console.log(typeof ctx); }";
    await expect(impl.executeCodeMode(chatId, code, USER, MODEL.profile.id, bindings)).resolves.toBe("captured trace");
    expect(loader.load).toHaveBeenCalledOnce();
    const definition = loader.load.mock.calls[0][0];
    expect(definition.globalOutbound).toBeNull();
    expect(definition.compatibilityFlags).toContain("disallow_importable_env");
    expect(definition.compatibilityFlags?.includes("allow_irrevocable_stub_storage")).toBe(!restricted);
    expect(definition.modules["agent.js"]).toBe(code);
    expect(definition.mainModule).toBe("harness.js");
    expect(definition.modules["harness.js"]).toContain(restricted
      ? "await agent(undefined, this.env, undefined)" : "await agent(self, env, this.ctx)");
    expect(Object.keys(definition.env!)).toEqual(restricted ? ["READ"] : ["READ", "PARAMS_1"]);
    expect(loader.verify).toHaveBeenCalledOnce();
    if (restricted) {
      expect(definition.modules["harness.js"]).toContain('async verify() { await import("agent.js"); }');
      expect(definition.modules["harness.js"]).not.toContain('import agent from "agent.js"');
      expect(loader.run).toHaveBeenCalledExactlyOnceWith();
      expect(loader.self).not.toHaveBeenCalled();
    } else {
      expect(loader.self).toHaveBeenCalledOnce();
      expect(loader.run).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        PARAMS_1: {resolve: expect.any(Function), reject: expect.any(Function)},
      }, expect.objectContaining({forge: expect.any(Function)}));
    }
  }));

  it.each(["stop", "pause"] as const)("cannot run when %s arrives during verify", kind => withChild(async ({impl, child}) => {
    const loader = captureLoader(impl);
    const verification = Promise.withResolvers<void>();
    const preparation = Promise.withResolvers<void>();
    loader.verify.mockReturnValueOnce(verification.promise);
    // Use the real live-chat registration so executeCodeMode captures the actual cancellation signal.
    vi.spyOn(impl, "reconcilePendingGadgets").mockReturnValueOnce(preparation.promise);
    impl.storage.chatMeta.put({...impl.getChatMetaOrThrow(child), activeAgent: MODEL.profile});
    impl.startAgent(child, MODEL, USER, OWNER);
    const executing = impl.executeCodeMode(child, "export default async () => {}", USER, MODEL.profile.id, READ);
    const rejected = expect(executing).rejects.toThrow(kind === "stop" ? "Named delegation canceled" : "automation is paused");
    try {
      expect(loader.verify).toHaveBeenCalledOnce();
      if (kind === "stop") impl.cancelAgent(child);
      else {await impl.setAutomationPaused(true); await impl.setAutomationPaused(false);}
      verification.resolve();
      await rejected;
      expect(loader.run).not.toHaveBeenCalled();
      expect(loader.self).not.toHaveBeenCalled();
      expect(runAgent).not.toHaveBeenCalled();
    } finally {verification.resolve(); preparation.resolve();}
  }));
});

it("executes the restricted harness with the real WorkerLoader", async () => {
  expect(env.LOADER).toBeDefined();
  await withChild(async ({impl, child}) => {
    // No mock/fallback: when configured, failure here is a real loader/runtime failure.
    await expect(impl.executeCodeMode(child, `export default async (self, env, ctx) => {
      console.log(JSON.stringify({self: typeof self, ctx: typeof ctx, names: Object.keys(env)}));
    }`, USER, MODEL.profile.id, {})).resolves.toBe('{"self":"undefined","ctx":"undefined","names":[]}');
  });
});

it("freezes the real child harness before evaluating a hostile agent module or its microtasks", () => withChild(async ({impl, child}) => {
  const output = await impl.executeCodeMode(child, `
    import Harness from "harness.js";
    import { WorkerEntrypoint } from "cloudflare:workers";
    const frozenBeforeImport = Object.isFrozen(Harness) && Object.isFrozen(Harness.prototype);
    const chain = [];
    for (let p = Harness.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      chain.push(Object.isFrozen(p));
    }
    const envDescriptor = Object.getOwnPropertyDescriptor(WorkerEntrypoint.prototype, "env");
    const attempts = [];
    queueMicrotask(() => {
      for (const attack of [
        () => { Harness.prototype.run = function () { console.log("ESCAPED", this.ctx); }; },
        () => Object.defineProperty(Harness.prototype, "env", {get() { return {ESCAPED: this.ctx}; }}),
        () => Object.defineProperty(WorkerEntrypoint.prototype, "env", {get() { return {ESCAPED: this.ctx}; }}),
      ]) {
        try { attack(); attempts.push("succeeded"); }
        catch (error) { attempts.push(error instanceof TypeError ? "TypeError" : "unexpected error"); }
      }
    });
    export default async (self, env, ctx) => {
      console.log(JSON.stringify({self: typeof self, ctx: typeof ctx, names: Object.keys(env),
        frozenBeforeImport, chain, objectPrototypeFrozen: Object.isFrozen(Object.prototype),
        envDescriptorAbsent: envDescriptor === undefined,
        nativePrototypeExtensible: Object.isExtensible(WorkerEntrypoint.prototype), attempts}));
    }
  `, USER, MODEL.profile.id, {});
  const result = JSON.parse(output);
  expect(result).toEqual({self: "undefined", ctx: "undefined", names: [], frozenBeforeImport: true,
    chain: expect.any(Array), objectPrototypeFrozen: false, envDescriptorAbsent: true, nativePrototypeExtensible: false,
    attempts: ["TypeError", "TypeError", "TypeError"]});
  expect(result.chain.length).toBeGreaterThanOrEqual(2);
  expect(result.chain.every((frozen: boolean) => frozen)).toBe(true);
}));
