import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { keyString, type Subscriber } from "@gadgets/typed-storage";
import type { AgentProfile, AiChatAuthorInfo, NamedDelegationInput, NamedDelegationReceipt,
  TaskRun, TaskRunDisposition, GatekeeperCreationSpec, AiChatSubscriber, AiChatMessage,
  AiChatMetadata, AiToolCall } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserAiModelRecord, UserChatContext } from "../src/user.js";
import { runAgent } from "../src/agent.js";
import type { PreparedNamedDelegation } from "../src/named-delegation.js";

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
const USER: AiChatAuthorInfo = {type: "user", id: "owner", name: "Owner"};
const MODEL: UserAiModelRecord = {profile: {type: "agent", id: "test-model", name: "Model"},
  config: {provider: "anthropic", model: "claude-sonnet-4-5", apiToken: "SECRET-MODEL-CREDENTIAL"}};
const FINISHED: TaskRunDisposition = {status: "finished", reason: "model_stop"};
const WAITING: TaskRunDisposition = {status: "waiting", reason: "connection"};
const EMPTY = {changes: [], createdGadgets: [], addedBindings: []};
const INPUT: NamedDelegationInput = {requestId: "research-1", targetAgentId: "target",
  title: "Research", prompt: "Research the explicit task only."};

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Delegation tests forbid provider calls"));
  vi.mocked(runAgent).mockReset().mockImplementation(async (hooks, _model, chatId, author,
      _history, _signal, _initiator, _callback, _compaction, execution) => {
    await hooks.commitAgentStep(chatId, author, [{type: "message", message: "Child response"}],
      {...EMPTY, run: execution && {...execution, disposition: FINISHED}});
    return {disposition: FINISHED};
  });
});
afterEach(() => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); }
});

function inOverseer(name: string, fn: (impl: Impl, instance: OverseerDurableObject) => Promise<void>, keepRestartIntent = false) {
  return runInDurableObject(env.TEST_OVERSEER.getByName(`named-delegation-${name}`),
    async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      try { await fn(impl, instance); } finally {
        // Synthetic parents have durable intent but no live runner. Don't let another suite's
        // abort/alarm wake them after this fixture's remote UserDO substitution has gone away.
        if (!keepRestartIntent) {
          const active = [...impl.storage.activeAgents.list()];
          for (const record of active) impl.cancelAgent(record.chatId);
        }
      }
    });
}

function setup(impl: Impl, role: "build" | "use" = "build") {
  impl.ownerId = OWNER;
  impl.ownerProfileId = USER.id;
  const source: AgentProfile = {id: "source", name: "Source", title: "Source", description: "Source instructions",
    workspaceId: impl.ctx.id.toString(), defaultModelId: MODEL.profile.id, created: new Date(1), updated: new Date(1)};
  const target: AgentProfile = {...source, id: "target", name: "Researcher", description: "Target instructions",
    workspaceId: "private-target-workspace", defaultBindings: [987]};
  const user = {
    id: {toString: () => OWNER}, whoami: vi.fn(async () => USER),
    getChatContext: vi.fn(async (_modelId?: string | null): Promise<UserChatContext> => ({profile: USER, aiModel: MODEL})),
    getAgent: vi.fn(async (id: string): Promise<AgentProfile | undefined> =>
      id === target.id ? structuredClone(target) : id === source.id ? structuredClone(source) : undefined),
    getAgentByWorkspaceId: vi.fn(async (): Promise<AgentProfile | undefined> => structuredClone(source)),
    getGroupByWorkspaceId: vi.fn(async (): Promise<null | {id: string}> => null),
    recordSharedGadgetOpen: vi.fn(async () => {}), setGadgetLastActive: vi.fn(async () => {}),
  };
  Object.assign(impl, {users: {idFromString: (id: string) => id, get: () => user},
    getSharingManager: async () => ({getEffectiveRole: () => role})});
  vi.spyOn(impl, "ensureAmbientCapsules").mockResolvedValue(undefined);
  vi.spyOn(impl, "ensureObserver").mockResolvedValue(undefined);
  vi.spyOn(impl, "markOutputsDirty").mockImplementation(() => {});
  vi.spyOn(impl, "syncOutputsTo").mockResolvedValue(true);
  vi.spyOn(impl, "joinOutputsFanout").mockReturnValue(() => {});
  vi.spyOn(impl, "recordGadgetAnalytics").mockImplementation(() => {});
  return {user, source, target};
}

async function open(instance: OverseerDurableObject, userId = OWNER) {
  using closed = new NativeRpcStub<() => void>(() => {});
  return new RpcStub(await instance.open(userId, userId === OWNER ? USER.id : userId, closed));
}

function parent(impl: Impl) {
  const chatId = impl.nextChatId();
  const timestamp = impl.getChatTimestamp();
  impl.storage.chatMeta.put({id: chatId, title: "Parent", started: timestamp, lastActive: timestamp, activeAgent: MODEL.profile});
  impl.storage.chatContext.put({chatId, agentId: "source"});
  impl.addChatMessages(chatId, USER, [{type: "message", message: "Parent task"}]);
  const run = impl.admitTaskRun(chatId, 0, {type: "prompt"});
  impl.storage.taskRuns.put({...run, status: "running", reason: undefined, attempt: 1});
  const execution = {id: run.id, attempt: 1};
  impl.storage.activeAgents.put({chatId, initiatorUserId: OWNER, initiator: USER,
    modelId: MODEL.profile.id, callbackInitiated: false, run: execution});
  return {chatId, execution};
}

function resource(impl: Impl, id = 7, spec: GatekeeperCreationSpec = {
  type: "gatekeeper", vendorId: "test", resourceUrl: "https://example.com/resource",
  typeUrlPattern: "https://example.com/:resource",
}) {
  impl.storage.gatekeepers.put({id, resourceTitle: "External resource", creationSpec: spec,
    class: {} as Parameters<Impl["addGatekeeper"]>[0]});
}

function messages(impl: Impl, chatId: number) {
  return [...impl.storage.chats.list({prefix: `${keyString(chatId)}.`})];
}

function commit(impl: Impl, prepared: PreparedNamedDelegation[],
    extra: Partial<Parameters<Impl["commitAgentStep"]>[3]> = {}) {
  const first = prepared[0];
  return impl.commitAgentStep(first.parentChatId, MODEL.profile, [{type: "message", message: "Parent evidence",
    toolCalls: prepared.map(p => ({toolName: "delegateToBot", toolCallId: p.input.requestId,
      input: p.input, delegationId: p.id}))}], {...EMPTY, run: first.execution, delegations: prepared, ...extra});
}

async function configure(impl: Impl, bindings: Record<string, number> = {}) {
  return impl.setNamedDelegationConfig(OWNER, [{targetAgentId: "target", bindings}],
    impl.storage.namedDelegationConfig.get().revision);
}

class ChatSubscriber extends RpcTarget implements AiChatSubscriber {
  messages: AiChatMessage[] = [];
  metas: AiChatMetadata[] = [];
  streamGeneration() {}
  metadata(meta: AiChatMetadata) { this.metas.push(structuredClone(meta)); }
  deleted() {}
  message(msg: AiChatMessage) { this.messages.push(structuredClone(msg)); }
  changeApplied() {}
  stream() {}
}

describe("owner-local named delegation policy", () => {
  it("defaults to no targets and exposes only explicit external resources; observers and editors cannot configure", () =>
    inOverseer("policy", async (impl, instance) => {
      setup(impl);
      resource(impl);
      resource(impl, 8, {type: "ambient", vendorId: "context", accountId: 1});
      using owner = await open(instance);
      expect(await owner.getNamedDelegationConfig()).toEqual({revision: 0, targets: [], resources: [{id: 7, title: "External resource"}]});
      using editor = await open(instance, "editor");
      await expect(editor.getNamedDelegationConfig()).rejects.toThrow("owner");
      await expect(editor.setNamedDelegationConfig([], 0)).rejects.toThrow("owner");
      Object.assign(impl, {getSharingManager: async () => ({getEffectiveRole: () => "use"})});
      using observer = await open(instance, "observer");
      await expect(observer.getNamedDelegationConfig()).rejects.toThrow();
      await expect(observer.setNamedDelegationConfig([], 0)).rejects.toThrow();
      await expect(observer.getNamedDelegation("anything")).rejects.toThrow();
      expect(await configure(impl, {READ: 7})).toMatchObject({revision: 1, targets: [{targetAgentId: "target", bindings: {READ: 7}}]});
      expect([...impl.storage.chatMeta.list()]).toEqual([]);
      expect(runAgent).not.toHaveBeenCalled();
    }));

  it("validates current source binding, same-owner targets, no self, target and binding limits", () =>
    inOverseer("policy-validation", async impl => {
      const {user} = setup(impl);
      await expect(impl.setNamedDelegationConfig(OWNER, [{targetAgentId: "source", bindings: {}}], 0)).rejects.toThrow("other bots");
      await expect(impl.setNamedDelegationConfig(OWNER, [{targetAgentId: "foreign", bindings: {}}], 0)).rejects.toThrow("other bots");
      await expect(impl.setNamedDelegationConfig(OWNER, Array.from({length: 9}, (_, i) => ({targetAgentId: `bot-${i}`, bindings: {}})), 0)).rejects.toThrow("eight");
      resource(impl);
      await expect(configure(impl, Object.fromEntries(Array.from({length: 9}, (_, i) => [`B${i}`, 7])))).rejects.toThrow("bindings");
      user.getAgentByWorkspaceId.mockResolvedValueOnce(undefined);
      await expect(configure(impl)).rejects.toThrow("dedicated");
      user.getGroupByWorkspaceId.mockResolvedValueOnce({id: "group"});
      await expect(configure(impl)).rejects.toThrow("dedicated");
    }));

  it.each(["gadget", "spawner", "model", "ambient", "missing"] as const)("never grants a %s binding", kind =>
    inOverseer(`binding-${kind}`, async impl => {
      setup(impl);
      let id = 7;
      if (kind === "gadget") id = impl.createGadget("Private gadget", "PRIVATE", parent(impl).chatId).id;
      if (kind === "spawner") resource(impl, id, {type: "agentSpawner", config: {displayName: "Spawner", modelId: MODEL.profile.id, env: {}}});
      if (kind === "model") resource(impl, id, {type: "aiModel", modelId: MODEL.profile.id, provider: "anthropic", modelName: "claude-sonnet-4-5"});
      if (kind === "ambient") resource(impl, id, {type: "ambient", vendorId: "context", accountId: 1});
      await expect(configure(impl, {READ: id})).rejects.toThrow("external gatekeeper");
    }));

  it("rejects literal value bindings at the public RPC boundary", () =>
    inOverseer("value-binding", async (impl, instance) => {
      setup(impl);
      using client = await open(instance);
      await expect(client.setNamedDelegationConfig([{targetAgentId: "target", bindings: {
        // @ts-expect-error Untrusted callers cannot substitute a literal for a resource ID.
        SECRET: {value: "not-a-resource"},
      }}], 0)).rejects.toThrow();
      expect(impl.storage.namedDelegationConfig.get().revision).toBe(0);
    }));

  it("rechecks CAS and resource existence after target lookup", () =>
    inOverseer("cas", async impl => {
      const {user, target} = setup(impl);
      resource(impl);
      const lookup = Promise.withResolvers<AgentProfile | undefined>();
      const entered = Promise.withResolvers<void>();
      user.getAgent.mockImplementationOnce(() => {entered.resolve(); return lookup.promise;});
      const saving = configure(impl, {READ: 7});
      await entered.promise;
      await impl.setNamedDelegationConfig(OWNER, [], 0);
      lookup.resolve(target);
      await expect(saving).rejects.toThrow("changed");
      expect(impl.storage.namedDelegationConfig.get()).toMatchObject({revision: 1, targets: []});
      user.getAgent.mockImplementationOnce(async () => {impl.storage.gatekeepers.delete(7); return target;});
      await expect(configure(impl, {READ: 7})).rejects.toThrow("external gatekeeper");
    }));
});

describe("inert preparation and atomic admission", () => {
  it.each(["null", "nonprimitive", "oversized", "unmatched", "missing-id", "conflicting-mark", "conflicting-draft", "stale-duplicate"] as const)(
    "rejects %s evidence before allocating, preserving completed ordinary effects", kind =>
    inOverseer(`invalid-evidence-${kind}`, async impl => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      let drafts = [prepared];
      const calls: AiToolCall[] = [{toolName: "delegateToBot", toolCallId: "first", input: prepared.input, delegationId: prepared.id}];
      if (kind === "null") {
        // @ts-expect-error Simulate corrupted provider evidence, not validated model input.
        calls.push({toolName: "delegateToBot", toolCallId: "bad", input: null, delegationId: prepared.id});
      }
      if (kind === "nonprimitive") {
        // @ts-expect-error Do not hash arbitrary nested objects.
        calls.push({toolName: "delegateToBot", toolCallId: "bad", delegationId: prepared.id,
          input: {...INPUT, prompt: {unexpected: "object"}}});
      }
      if (kind === "oversized") calls.push({toolName: "delegateToBot", toolCallId: "bad", delegationId: prepared.id,
        input: {...INPUT, bindingNames: Array(16_385).fill("READ")}});
      if (kind === "unmatched") drafts = [];
      if (kind === "missing-id" && calls[0].toolName === "delegateToBot") delete calls[0].delegationId;
      if (kind === "conflicting-mark") calls.push({toolName: "delegateToBot", toolCallId: "bad", delegationId: prepared.id,
        input: {...INPUT, prompt: "Another task"}});
      if (kind === "conflicting-draft") drafts.push({...prepared, input: {...prepared.input, prompt: "Another task"}});
      if (kind === "stale-duplicate") drafts.push({...prepared, generation: prepared.generation + 1});
      const gadget = impl.createGadget("Draft", "DRAFT", p.chatId);
      await expect(impl.commitAgentStep(p.chatId, MODEL.profile, [{type: "message", message: "Completed work", toolCalls: calls}], {
        run: p.execution, delegations: drafts,
        changes: [{change: {[gadget.id]: [["draft.md", {set: "Keep this completed effect"}]]}}],
        createdGadgets: [{gadgetId: gadget.id, title: gadget.title, bindingName: gadget.bindingName}], addedBindings: [],
      })).resolves.toBe(true);
      expect(calls.every(call => !!call.error)).toBe(true);
      expect((await impl.buildChatContent(p.chatId)).get(gadget.id)?.get("draft.md")).toBe("Keep this completed effect");
      expect(messages(impl, p.chatId).map(msg => msg.type)).toEqual(["message", "message", "changes"]);
      expect([...impl.storage.namedDelegations.list()]).toEqual([]);
      expect([...impl.storage.chatMeta.list()]).toHaveLength(1);
      expect(runAgent).not.toHaveBeenCalled();
    }));

  it("snapshots target instructions/model, forwards only selected names, and commits attempt-one provenance without secrets", () =>
    inOverseer("admission", async (impl, instance) => {
      const {user, target} = setup(impl);
      resource(impl);
      await configure(impl, {Z: 7, A: 7});
      const p = parent(impl);
      expect(await impl.listNamedDelegates(p.chatId)).toEqual([{targetAgentId: target.id, name: target.name, bindingNames: ["A", "Z"]}]);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, {...INPUT, bindingNames: ["Z", "A", "A"]});
      expect(prepared.input.bindingNames).toEqual(["A", "Z"]);
      expect([...impl.storage.namedDelegations.list()]).toEqual([]);
      expect([...impl.storage.chatMeta.list()]).toHaveLength(1);
      expect(runAgent).not.toHaveBeenCalled();
      target.name = "Later name";
      target.description = "Later instructions";
      target.defaultModelId = "later-model";
      await commit(impl, [prepared]);
      await impl.waitForAllAgentsToComplete();
      const result = impl.getNamedDelegation(prepared.id);
      expect(result).toMatchObject({deleted: false, canceled: false, response: "Child response",
        receipt: {id: prepared.id, parentChatId: p.chatId, parentRunId: p.execution.id, parentAttempt: 1, parentSequence: 2, targetName: "Researcher"},
        run: {id: prepared.id, attempt: 1, status: "finished", source: {type: "delegation", parent: {
          chatId: p.chatId, runId: p.execution.id, attempt: 1, targetAgentId: "target", targetName: "Researcher"}}}});
      const child = result.receipt.childChatId;
      expect(impl.storage.chatContext.get(child)).toEqual({chatId: child, bindings: {A: 7, Z: 7},
        spawnerConfig: {displayName: "Researcher", modelId: MODEL.profile.id, env: {A: 7, Z: 7}},
        agentInstructions: "Target instructions", namedDelegation: result.receipt,
        alwaysAvailableCapsuleIds: [], alwaysAvailableCatalogs: []});
      expect(impl.getChatMetaOrThrow(child).namedDelegation).toEqual(result.receipt);
      expect(messages(impl, p.chatId)[1]).toMatchObject({toolCalls: [{delegationId: prepared.id}]});
      expect(messages(impl, p.chatId)[2]).toMatchObject({type: "namedDelegation", delegation: result.receipt, runId: p.execution.id});
      expect(messages(impl, child)[0]).toMatchObject({message: INPUT.prompt, runId: prepared.id});
      expect(runAgent).toHaveBeenCalledExactlyOnceWith(impl, expect.anything(), child,
        {...MODEL.profile, name: "Researcher"}, expect.any(Array), expect.any(AbortSignal), USER,
        false, expect.anything(), {id: prepared.id, attempt: 1});
      expect(user.getChatContext).toHaveBeenCalledExactlyOnceWith(MODEL.profile.id);
      const stored = JSON.stringify([...impl.ctx.storage.kv.list()]);
      expect(stored).not.toContain("SECRET-MODEL-CREDENTIAL");
      expect(stored).not.toContain("private-target-workspace");
      using editor = await open(instance, "editor");
      expect(await editor.getNamedDelegation(prepared.id)).toEqual(result);
      expect(await editor.getChatMessage(p.chatId, 2)).toMatchObject({type: "namedDelegation", result});
      await expect(impl.getNamedDelegationResult(parent(impl).chatId, prepared.id)).rejects.toThrow("conversation");
      impl.admitTaskRun(p.chatId, 1, {type: "prompt"});
      expect(await impl.getNamedDelegationResult(p.chatId, prepared.id)).toEqual(result);
    }));

  it("defaults to no forwarded resources and refuses unknown grants and deleted targets", () =>
    inOverseer("narrowing", async impl => {
      const {user} = setup(impl);
      resource(impl);
      await configure(impl, {READ: 7});
      const p = parent(impl);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      expect(prepared).toMatchObject({bindings: {}});
      await expect(impl.prepareNamedDelegation(p.chatId, p.execution, {...INPUT, bindingNames: ["PRIVATE"]})).rejects.toThrow("not granted");
      user.getAgent.mockResolvedValueOnce(undefined);
      await expect(impl.prepareNamedDelegation(p.chatId, p.execution, INPUT)).rejects.toThrow("no longer exists");
      expect([...impl.storage.namedDelegations.list()]).toEqual([]);
    }));

  it.each(["prompt", "instructions", "title", "key"] as const)("enforces %s limits including UTF-8 bytes", kind =>
    inOverseer(`limits-${kind}`, async impl => {
      const {target} = setup(impl);
      await configure(impl);
      const p = parent(impl);
      const input = {...INPUT};
      if (kind === "prompt") input.prompt = "\u00e9".repeat(8193);
      if (kind === "instructions") target.description = "\u00e9".repeat(16385);
      if (kind === "title") input.title = "x".repeat(121);
      if (kind === "key") input.requestId = "../unsafe";
      await expect(impl.prepareNamedDelegation(p.chatId, p.execution, input)).rejects.toThrow();
    }));

  it.each(["untracked", "foreign", "spawner", "child", "group", "rebound"] as const)("rejects an ineligible %s parent", kind =>
    inOverseer(`parent-${kind}`, async impl => {
      const {user, source} = setup(impl);
      await configure(impl);
      const p = parent(impl);
      if (kind === "untracked") impl.storage.activeAgents.delete(p.chatId);
      if (kind === "foreign") impl.storage.activeAgents.put({...impl.storage.activeAgents.get(p.chatId)!, initiatorUserId: "other"});
      if (kind === "spawner") impl.storage.chatContext.put({chatId: p.chatId, agentId: source.id,
        spawnerConfig: {displayName: "Spawner", modelId: MODEL.profile.id, env: {}}});
      if (kind === "child") impl.storage.chatContext.put({chatId: p.chatId, bindings: {}});
      if (kind === "group") user.getGroupByWorkspaceId.mockResolvedValue({id: "group"});
      if (kind === "rebound") user.getAgentByWorkspaceId.mockResolvedValue({...source, id: "replacement"});
      await expect(impl.prepareNamedDelegation(p.chatId, p.execution, INPUT)).rejects.toThrow();
    }));

  it.each(["pause", "stop", "delete", "revoke"] as const)("fences parent %s during model lookup", kind =>
    inOverseer(`lookup-${kind}`, async (impl, instance) => {
      const {user} = setup(impl);
      await configure(impl);
      const p = parent(impl);
      const lookup = Promise.withResolvers<UserChatContext>();
      const entered = Promise.withResolvers<void>();
      user.getChatContext.mockImplementationOnce(() => {entered.resolve(); return lookup.promise;});
      const preparing = impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      await entered.promise;
      if (kind === "pause") {await impl.setAutomationPaused(true); await impl.setAutomationPaused(false);}
      if (kind === "stop") impl.cancelAgent(p.chatId);
      if (kind === "delete") {using client = await open(instance); await client.deleteChat(p.chatId);}
      if (kind === "revoke") await impl.setNamedDelegationConfig(OWNER, [], 1);
      lookup.resolve({profile: USER, aiModel: MODEL});
      await expect(preparing).rejects.toThrow();
      expect([...impl.storage.namedDelegations.list()]).toEqual([]);
      expect(runAgent).not.toHaveBeenCalled();
    }));

  it.each(["pause", "stop", "revoke", "resource"] as const)("persists ordinary effects but refuses delegation after %s during barrier prefetch", kind =>
    inOverseer(`barrier-${kind}`, async impl => {
      setup(impl);
      resource(impl);
      await configure(impl, {READ: 7});
      const p = parent(impl);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, {...INPUT, bindingNames: ["READ"]});
      const gadget = impl.createGadget("Draft", "DRAFT", p.chatId);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const original = impl.getCurrentChatContent.bind(impl);
      vi.spyOn(impl, "getCurrentChatContent").mockImplementationOnce(async (...args) => {
        entered.resolve(); await release.promise; return original(...args);
      });
      const committing = commit(impl, [prepared], {
        changes: [{change: {[gadget.id]: [["draft.md", {set: "Already completed ordinary effect"}]]}}],
        createdGadgets: [{gadgetId: gadget.id, title: gadget.title, bindingName: gadget.bindingName}],
      });
      await entered.promise;
      if (kind === "pause") {await impl.setAutomationPaused(true); await impl.setAutomationPaused(false);}
      if (kind === "stop") impl.cancelAgent(p.chatId);
      if (kind === "revoke") await impl.setNamedDelegationConfig(OWNER, [], 1);
      if (kind === "resource") impl.storage.gatekeepers.delete(7);
      release.resolve();
      expect(await committing).toBe(true);
      expect((await impl.buildChatContent(p.chatId)).get(gadget.id)?.get("draft.md")).toBe("Already completed ordinary effect");
      expect(messages(impl, p.chatId)[1]).toMatchObject({toolCalls: [{error: expect.any(String)}]});
      expect(messages(impl, p.chatId).at(-1)?.type).toBe("changes");
      expect([...impl.storage.namedDelegations.list()]).toEqual([]);
      expect(runAgent).not.toHaveBeenCalled();
    }));

  it("rolls back children, contexts, receipts, parent evidence, counters and restart intents on a late barrier failure", () =>
    inOverseer("rollback", async impl => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      const before = [...impl.storage.chatMeta.list()];
      const fault: Subscriber<TaskRun> = {add() {}, remove() {}, update(_old, run) {
        if (run.id === p.execution.id && run.status === "finished") throw new Error("injected final barrier failure");
      }};
      impl.storage.taskRuns.subscribe(fault);
      try {
        await expect(commit(impl, [prepared], {run: {...p.execution, disposition: FINISHED}})).rejects.toThrow("injected");
      } finally {impl.storage.taskRuns.unsubscribe(fault);}
      expect([...impl.storage.chatMeta.list()]).toEqual(before);
      expect([...impl.storage.chatContext.list()]).toEqual([{chatId: p.chatId, agentId: "source"}]);
      expect([...impl.storage.namedDelegations.list()]).toEqual([]);
      expect([...impl.storage.taskRuns.list()]).toHaveLength(1);
      expect([...impl.storage.activeAgents.list()]).toHaveLength(1);
      expect(messages(impl, p.chatId)).toHaveLength(1);
      expect(runAgent).not.toHaveBeenCalled();
      await commit(impl, [prepared]);
      await impl.waitForAllAgentsToComplete();
      expect(impl.getNamedDelegation(prepared.id).receipt.childChatId).toBe(p.chatId + 1);
      expect(runAgent).toHaveBeenCalledOnce();
    }));
});

describe("durable dedupe, results and cancellation", () => {
  it.each(["delete", "pause"] as const)("stopping run B leaves run A's children; %s still cancels the whole conversation", wide =>
    inOverseer(`logical-stop-${wide}`, async (impl, instance) => {
      setup(impl);
      await configure(impl);
      const a = parent(impl);
      const childA = await impl.prepareNamedDelegation(a.chatId, a.execution, INPUT);
      vi.mocked(runAgent).mockResolvedValue({disposition: WAITING});
      await commit(impl, [childA], {run: {...a.execution, disposition: FINISHED}});
      await impl.waitForAllAgentsToComplete();
      const sequence = impl.nextChatSequencePeek(a.chatId);
      impl.addChatMessages(a.chatId, USER, [{type: "message", message: "New task B"}]);
      const b = impl.admitTaskRun(a.chatId, sequence, {type: "prompt"});
      const execution = {id: b.id, attempt: 1};
      impl.storage.taskRuns.put({...b, status: "running", reason: undefined, attempt: 1});
      impl.storage.activeAgents.put({...impl.storage.activeAgents.get(a.chatId)!, run: execution});
      const childB = await impl.prepareNamedDelegation(a.chatId, execution, INPUT);
      await commit(impl, [childB], {run: {...execution, disposition: FINISHED}});
      await impl.waitForAllAgentsToComplete();
      using client = await open(instance);
      const index = vi.spyOn(impl.storage.namedDelegations.byParentRun, "get");
      await client.stopAgent(a.chatId);
      expect(index).toHaveBeenCalledWith(b.id);
      expect(impl.getNamedDelegation(childA.id)).toMatchObject({canceled: false, run: {status: "waiting"}});
      expect(impl.getNamedDelegation(childB.id)).toMatchObject({canceled: true, run: {status: "canceled"}});
      expect(impl.storage.taskRuns.get(a.execution.id)?.status).toBe("finished");
      expect(impl.storage.taskRuns.get(b.id)?.status).toBe("finished");
      if (wide === "delete") await client.deleteChat(a.chatId);
      else await client.setAutomationPaused(true);
      expect(impl.getNamedDelegation(childA.id)).toMatchObject({canceled: true, run: {status: "canceled"}});
    }));

  it("preserves an existing duplicate receipt but rejects conflicting marks without a new child", () =>
    inOverseer("existing-evidence", async impl => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      await commit(impl, [prepared]);
      await impl.waitForAllAgentsToComplete();
      const before = impl.getNamedDelegation(prepared.id);
      const duplicate = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      await commit(impl, [duplicate]);
      const calls: AiToolCall[] = [
        {toolName: "delegateToBot", toolCallId: "good", delegationId: prepared.id, input: prepared.input},
        {toolName: "delegateToBot", toolCallId: "conflict", delegationId: prepared.id, input: {...INPUT, title: "Different"}},
      ];
      await impl.commitAgentStep(p.chatId, MODEL.profile, [{type: "message", message: "Evidence", toolCalls: calls}],
        {...EMPTY, run: p.execution, delegations: [duplicate]});
      expect(calls.every(call => !!call.error)).toBe(true);
      expect(impl.getNamedDelegation(prepared.id)).toEqual(before);
      expect([...impl.storage.namedDelegations.list()]).toHaveLength(1);
      expect(runAgent).toHaveBeenCalledOnce();
    }));

  it("dedupes across configuration changes, attempts and tombstones; conflicts reject and deleted children count forever", () =>
    inOverseer("dedupe", async (impl, instance) => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      await commit(impl, [prepared, prepared]);
      await impl.waitForAllAgentsToComplete();
      const receipt = impl.getNamedDelegation(prepared.id).receipt;
      using client = await open(instance);
      await client.deleteChat(receipt.childChatId);
      expect(impl.getNamedDelegation(prepared.id)).toEqual({receipt, run: undefined, response: undefined, deleted: true, canceled: false});
      expect(impl.storage.namedDelegations.get(prepared.id)?.input).toBeUndefined();
      await impl.setNamedDelegationConfig(OWNER, [], 1);
      const next = {...p.execution, attempt: 2};
      impl.storage.activeAgents.put({...impl.storage.activeAgents.get(p.chatId)!, run: next});
      impl.storage.taskRuns.put({...impl.storage.taskRuns.get(next.id)!, status: "running", reason: undefined, attempt: 2});
      const duplicate = await impl.prepareNamedDelegation(p.chatId, next, {...INPUT, bindingNames: []});
      expect(duplicate).toMatchObject({id: prepared.id, existing: receipt});
      const chatsBefore = [...impl.storage.chatMeta.list()];
      await commit(impl, [duplicate]);
      expect([...impl.storage.chatMeta.list()].map(m => m.id)).toEqual(chatsBefore.map(m => m.id));
      expect(runAgent).toHaveBeenCalledOnce();
      await expect(impl.prepareNamedDelegation(p.chatId, next, {...INPUT, prompt: "Different"})).rejects.toThrow("different input");
      await configure(impl);
      for (let i = 2; i <= 4; ++i) {
        const child = await impl.prepareNamedDelegation(p.chatId, next, {...INPUT, requestId: `request-${i}`});
        await commit(impl, [child]);
        await impl.waitForAllAgentsToComplete();
        await client.deleteChat(impl.getNamedDelegation(child.id).receipt.childChatId);
      }
      await expect(impl.prepareNamedDelegation(p.chatId, next, {...INPUT, requestId: "fifth"})).rejects.toThrow("lifetime");
      expect([...impl.storage.namedDelegations.byParentRun.get(p.execution.id)]).toHaveLength(4);
      expect(runAgent).toHaveBeenCalledTimes(4);
    }));

  it("enforces fanout at commit across concurrent preparations without losing valid admissions", () =>
    inOverseer("fanout", async impl => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await Promise.all(Array.from({length: 5}, (_, i) =>
        impl.prepareNamedDelegation(p.chatId, p.execution, {...INPUT, requestId: `request-${i}`})));
      await commit(impl, prepared);
      await impl.waitForAllAgentsToComplete();
      expect([...impl.storage.namedDelegations.list()]).toHaveLength(4);
      const msg = messages(impl, p.chatId)[1];
      expect(msg).toMatchObject({toolCalls: [{}, {}, {}, {}, {error: expect.stringContaining("lifetime")}]});
      expect(runAgent).toHaveBeenCalledTimes(4);
    }));

  it("rejects conflicting concurrent preparations at the barrier and fences preparations from an older attempt", () =>
    inOverseer("conflicting-batch", async impl => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await Promise.all([INPUT, {...INPUT, prompt: "Conflicting task"}].map(input =>
        impl.prepareNamedDelegation(p.chatId, p.execution, input)));
      await commit(impl, prepared);
      await impl.waitForAllAgentsToComplete();
      expect(messages(impl, p.chatId)[1]).toMatchObject({toolCalls: [
        {error: expect.stringContaining("different input")}, {error: expect.stringContaining("different input")},
      ]});
      expect([...impl.storage.namedDelegations.list()]).toHaveLength(0);
      const stale = await impl.prepareNamedDelegation(p.chatId, p.execution, {...INPUT, requestId: "later"});
      impl.storage.activeAgents.put({...impl.storage.activeAgents.get(p.chatId)!, run: {...p.execution, attempt: 2}});
      impl.storage.taskRuns.put({...impl.storage.taskRuns.get(p.execution.id)!, status: "running", reason: undefined, attempt: 2});
      await commit(impl, [stale]);
      expect(messages(impl, p.chatId).at(-1)).toMatchObject({toolCalls: [{error: expect.any(String)}]});
      expect([...impl.storage.namedDelegations.list()]).toHaveLength(0);
      expect(runAgent).not.toHaveBeenCalled();
    }));

  it("fences restart intent and aborts a live child before acknowledging parent stop", () =>
    inOverseer("live-cancel", async (impl, instance) => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      const entered = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<void>();
      vi.mocked(runAgent).mockImplementationOnce(async (_hooks, _model, _chatId, _author, _history, signal) => {
        entered.resolve(signal); await release.promise; return {disposition: FINISHED};
      });
      await commit(impl, [prepared]);
      const signal = await entered.promise;
      const child = impl.getNamedDelegation(prepared.id).receipt.childChatId;
      try {
        using client = await open(instance);
        await client.stopAgent(p.chatId);
        expect(signal.aborted).toBe(true);
        expect(impl.storage.activeAgents.get(child)).toBeUndefined();
        expect(impl.getNamedDelegation(prepared.id)).toMatchObject({canceled: true, run: {status: "canceled"}});
      } finally {release.resolve(); await impl.waitForAllAgentsToComplete();}
      expect(impl.getNamedDelegation(prepared.id).run?.status).toBe("canceled");
    }));

  it.each(["stop", "delete", "pause"] as const)("parent %s cancels waiting children durably and approvals cannot revive them", kind =>
    inOverseer(`cancel-${kind}`, async (impl, instance) => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      vi.mocked(runAgent).mockResolvedValueOnce({disposition: WAITING});
      await commit(impl, [prepared]);
      await impl.waitForAllAgentsToComplete();
      const receipt = impl.getNamedDelegation(prepared.id).receipt;
      expect(impl.getNamedDelegation(prepared.id).run?.status).toBe("waiting");
      expect(impl.canResumeTask(receipt.childChatId, prepared.id, 1)).toBe(true);
      using client = await open(instance);
      if (kind === "stop") await client.stopAgent(p.chatId);
      if (kind === "delete") await client.deleteChat(p.chatId);
      if (kind === "pause") {await client.setAutomationPaused(true); await client.setAutomationPaused(false);}
      expect(impl.getNamedDelegation(prepared.id)).toMatchObject({canceled: true, run: {status: "canceled",
        reason: kind === "pause" ? "workspace_paused" : "user_stop"}});
      expect(impl.canResumeTask(receipt.childChatId, prepared.id, 1)).toBe(false);
      expect(impl.storage.activeAgents.get(receipt.childChatId)).toBeUndefined();
      impl.finishTaskExecution({id: prepared.id, attempt: 1}, FINISHED);
      expect(impl.getNamedDelegation(prepared.id).run?.status).toBe("canceled");
      expect(runAgent).toHaveBeenCalledOnce();
    }));

  it("child stop leaves siblings alone; parent normal completion and policy removal leave admitted children alone", () =>
    inOverseer("relationships", async impl => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await Promise.all([INPUT, {...INPUT, requestId: "second"}].map(input =>
        impl.prepareNamedDelegation(p.chatId, p.execution, input)));
      vi.mocked(runAgent).mockResolvedValue({disposition: WAITING});
      await commit(impl, prepared, {run: {...p.execution, disposition: FINISHED}});
      await impl.waitForAllAgentsToComplete();
      await impl.setNamedDelegationConfig(OWNER, [], 1);
      expect(prepared.map(c => impl.getNamedDelegation(c.id).run?.status)).toEqual(["waiting", "waiting"]);
      impl.cancelAgent(impl.getNamedDelegation(prepared[0].id).receipt.childChatId);
      expect(prepared.map(c => impl.getNamedDelegation(c.id).canceled)).toEqual([true, false]);
      expect(impl.storage.taskRuns.get(p.execution.id)?.status).toBe("finished");
    }));

  it("rebroadcasts receipt timestamps for meaningful status changes and bounds untrusted result text by bytes", () =>
    inOverseer("results", async impl => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      vi.mocked(runAgent).mockResolvedValueOnce({disposition: WAITING});
      await commit(impl, [prepared]);
      await impl.waitForAllAgentsToComplete();
      const receipt = impl.getNamedDelegation(prepared.id).receipt;
      const key = `${keyString(p.chatId)}.${keyString(receipt.parentSequence)}`;
      const before = impl.storage.chats.get(key)!.timestamp;
      impl.addChatMessages(receipt.childChatId, MODEL.profile, [{type: "message", message: "\u00e9".repeat(5000)}],
        undefined, undefined, undefined, undefined, prepared.id);
      expect(impl.storage.chats.get(key)!.timestamp).toEqual(before);
      impl.cancelAgent(receipt.childChatId);
      await Promise.resolve();
      expect(impl.storage.chats.get(key)!.timestamp.valueOf()).toBeGreaterThan(before.valueOf());
      expect(impl.getNamedDelegation(prepared.id).response).toBe("\u00e9".repeat(4096));
      expect(JSON.stringify([...impl.storage.attentionSources.list()])).not.toContain("\u00e9");
    }));

  it("recovers persisted child restart intent with the same attempt and without re-reading the target profile", () =>
    inOverseer("restart", async impl => {
      const {user} = setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      await commit(impl, [prepared], {run: {...p.execution, disposition: FINISHED}});
      await impl.waitForAllAgentsToComplete();
      const receipt = impl.getNamedDelegation(prepared.id).receipt;
      // Snapshot the atomic pre-launch state, using the records produced by real admission.
      for (const msg of messages(impl, receipt.childChatId).slice(1)) {
        impl.storage.chats.delete(`${keyString(msg.chatId)}.${keyString(msg.sequence)}`);
      }
      impl.storage.taskRuns.put({...impl.storage.taskRuns.get(receipt.id)!, status: "running", reason: undefined, lastSequence: 0});
      impl.storage.chatMeta.put({...impl.getChatMetaOrThrow(receipt.childChatId), activeAgent: MODEL.profile});
      impl.storage.activeAgents.put({chatId: receipt.childChatId, run: {id: receipt.id, attempt: 1},
        initiatorUserId: OWNER, initiator: USER, modelId: MODEL.profile.id, callbackInitiated: false});
      impl.storage.activeAgents.delete(p.chatId);
      vi.mocked(runAgent).mockClear();
      user.getAgent.mockClear();
      user.getChatContext.mockClear();
      // Reconstruct the production kernel over real workerd SQLite. This pool cannot address
      // ctx.exports.UserDurableObject as a namespace; substitute only that remote lookup seam.
      const Constructor = Object.getPrototypeOf(impl).constructor as new (ctx: DurableObjectState, env: Cloudflare.Env) => Impl;
      const ctx = new Proxy(impl.ctx, {get(target, key) {
        if (key === "exports") return {...target.exports, UserDurableObject: impl.users};
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }});
      const restored = new Constructor(ctx, impl.env);
      await restored.waitForAllAgentsToComplete();
      expect(restored.getNamedDelegation(receipt.id)).toMatchObject({receipt, run: {attempt: 1, status: "finished"}, response: "Child response"});
      expect(runAgent).toHaveBeenCalledOnce();
      expect(user.getAgent).not.toHaveBeenCalled();
      expect(user.getChatContext).toHaveBeenCalledExactlyOnceWith(MODEL.profile.id);
      expect([...restored.storage.namedDelegations.list()]).toHaveLength(1);
    }));

  it.each([false, true])("retains tombstone fences across a real Durable Object abort (canceled: %s)", async canceled => {
    let receipt!: NamedDelegationReceipt;
    const name = `abort-fence-${canceled}`;
    await inOverseer(name, async (impl, instance) => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      vi.mocked(runAgent).mockResolvedValueOnce({disposition: canceled ? WAITING : FINISHED});
      await commit(impl, [prepared]);
      await impl.waitForAllAgentsToComplete();
      receipt = impl.getNamedDelegation(prepared.id).receipt;
      impl.cancelAgent(p.chatId);
      using client = await open(instance);
      await client.deleteChat(receipt.childChatId);
      // Even stale restart intent cannot override a durable cancellation/deletion fence.
      impl.storage.activeAgents.put({chatId: receipt.childChatId, run: {id: receipt.id, attempt: 1},
        initiatorUserId: OWNER, initiator: USER, modelId: MODEL.profile.id, callbackInitiated: false});
    }, true);
    vi.mocked(runAgent).mockClear();
    await abortAllDurableObjects();
    await inOverseer(name, async impl => {
      expect(impl.getNamedDelegation(receipt.id)).toMatchObject({receipt, canceled, deleted: true});
      expect(impl.storage.namedDelegations.get(receipt.id)?.input).toBeUndefined();
      expect(impl.storage.activeAgents.get(receipt.childChatId)).toBeUndefined();
      expect(impl.canResumeTask(receipt.childChatId, receipt.id, 1)).toBe(false);
      expect(runAgent).not.toHaveBeenCalled();
    });
  });
});

describe("named delegation presentation", () => {
  it("does not publish rolled-back creation/update of a tombstoned child's run", () =>
    inOverseer("rollback-tombstone-presentation", async (impl, instance) => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      await commit(impl, [prepared]);
      await impl.waitForAllAgentsToComplete();
      const {receipt, run} = impl.getNamedDelegation(prepared.id);
      using client = await open(instance);
      await client.deleteChat(receipt.childChatId);
      const key = `${keyString(p.chatId)}.${keyString(receipt.parentSequence)}`;
      const message = impl.storage.chats.get(key);
      const meta = impl.storage.chatMeta.get(p.chatId);
      expect(() => impl.storage.transaction(() => {
        impl.storage.taskRuns.put({...run!, status: "running", reason: undefined});
        impl.storage.taskRuns.put({...run!, status: "waiting", reason: "connection"});
        throw new Error("rollback recreation");
      })).toThrow("rollback recreation");
      await Promise.resolve();
      expect(impl.storage.taskRuns.get(prepared.id)).toBeUndefined();
      expect(impl.storage.chats.get(key)).toEqual(message);
      expect(impl.storage.chatMeta.get(p.chatId)).toEqual(meta);
      expect(runAgent).toHaveBeenCalledOnce();
    }));

  it("broadcasts committed waiting/finished payloads and parent metadata; coalesces changes and ignores rollback/deleted sources", () =>
    inOverseer("live-presentation", async (impl, instance) => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      using client = await open(instance);
      const receiver = new ChatSubscriber();
      using sink = new RpcStub(receiver);
      using _subscription = await client.subscribeToChat(sink);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      vi.mocked(runAgent).mockResolvedValueOnce({disposition: WAITING});
      await commit(impl, [prepared]);
      await impl.waitForAllAgentsToComplete();
      await vi.waitFor(() => expect(receiver.messages.filter(msg => msg.type === "namedDelegation").at(-1))
        .toMatchObject({result: {run: {status: "waiting"}}}));
      const receipt = impl.getNamedDelegation(prepared.id).receipt;
      const key = `${keyString(p.chatId)}.${keyString(receipt.parentSequence)}`;
      const before = impl.storage.chatMeta.get(p.chatId)!.lastActive;
      const count = receiver.messages.filter(msg => msg.type === "namedDelegation").length;
      impl.storage.transaction(() => {
        const run = impl.storage.taskRuns.get(prepared.id)!;
        impl.storage.taskRuns.put({...run, status: "running", reason: undefined, attempt: 2});
        impl.storage.taskRuns.put({...run, status: "finished", reason: "model_stop", attempt: 2});
      });
      await vi.waitFor(() => expect(receiver.messages.filter(msg => msg.type === "namedDelegation").at(-1))
        .toMatchObject({result: {run: {status: "finished", attempt: 2}}}));
      expect(receiver.messages.filter(msg => msg.type === "namedDelegation")).toHaveLength(count + 1);
      await vi.waitFor(() => expect(receiver.metas.filter(meta => meta.id === p.chatId).at(-1)?.lastActive.valueOf())
        .toBeGreaterThan(before.valueOf()));
      const finishedMessage = impl.storage.chats.get(key);
      const finishedMeta = impl.storage.chatMeta.get(p.chatId);
      expect(() => impl.storage.transaction(() => {
        impl.storage.taskRuns.put({...impl.storage.taskRuns.get(prepared.id)!, status: "waiting", reason: "connection"});
        throw new Error("rollback presentation");
      })).toThrow("rollback presentation");
      await Promise.resolve();
      expect(impl.storage.chats.get(key)).toEqual(finishedMessage);
      expect(impl.storage.chatMeta.get(p.chatId)).toEqual(finishedMeta);
      impl.storage.transaction(() => {
        impl.storage.taskRuns.put({...impl.storage.taskRuns.get(prepared.id)!, status: "waiting", reason: "connection"});
        impl.storage.chats.delete(key);
        impl.storage.chatMeta.delete(p.chatId);
      });
      await Promise.resolve();
      expect(impl.storage.chats.get(key)).toBeUndefined();
      expect(impl.storage.chatMeta.get(p.chatId)).toBeUndefined();
      expect(runAgent).toHaveBeenCalledOnce();
    }));

  it("replays multiple bounded pages with nested receipt hydration, then continues live delivery", () =>
    inOverseer("reconnect", async (impl, instance) => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      await commit(impl, [prepared]);
      await impl.waitForAllAgentsToComplete();
      const receipt = impl.getNamedDelegation(prepared.id).receipt;
      for (let i = 0; i < 205; ++i) {
        impl.addChatMessages(p.chatId, MODEL.profile, [{type: "namedDelegation", delegation: receipt}]);
      }
      const expected = [...impl.storage.chats.byTimestamp.list()];
      using client = await open(instance);
      const receiver = new ChatSubscriber();
      using sink = new RpcStub(receiver);
      using _subscription = await client.subscribeToChat(sink, new Date(0));
      await vi.waitFor(() => expect(receiver.messages).toHaveLength(expected.length));
      expect(receiver.messages.map(msg => [msg.chatId, msg.sequence])).toEqual(expected.map(msg => [msg.chatId, msg.sequence]));
      expect(receiver.messages.filter(msg => msg.type === "namedDelegation").every(msg => msg.result?.run?.status === "finished")).toBe(true);
      impl.addChatMessages(p.chatId, USER, [{type: "message", message: "Live after reconnect"}]);
      await vi.waitFor(() => expect(receiver.messages.at(-1)).toMatchObject({message: "Live after reconnect"}));
    }));

  it("missing or malformed receipt records remain inert and do not prevent later live messages", () =>
    inOverseer("unavailable-receipt", async (impl, instance) => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      await commit(impl, [prepared]);
      await impl.waitForAllAgentsToComplete();
      const record = impl.storage.namedDelegations.get(prepared.id)!;
      using client = await open(instance);
      const receiver = new ChatSubscriber();
      using sink = new RpcStub(receiver);
      using _subscription = await client.subscribeToChat(sink);
      impl.storage.namedDelegations.delete(prepared.id);
      impl.addChatMessages(p.chatId, MODEL.profile, [{type: "namedDelegation", delegation: record.receipt}]);
      const get = vi.spyOn(impl.storage.namedDelegations, "get").mockReturnValue({
        // @ts-expect-error Simulate a malformed stored record at the read boundary.
        ...record, canceled: "invalid",
      });
      impl.addChatMessages(p.chatId, MODEL.profile, [{type: "namedDelegation", delegation: record.receipt}]);
      get.mockRestore();
      impl.addChatMessages(p.chatId, USER, [{type: "message", message: "Still subscribed"}]);
      await vi.waitFor(() => expect(receiver.messages).toHaveLength(3));
      for (const msg of receiver.messages.slice(0, 2)) expect(msg).toMatchObject({type: "namedDelegation", result: undefined});
      expect(receiver.messages.at(-1)).toMatchObject({message: "Still subscribed"});
      await expect(client.getNamedDelegation(prepared.id)).rejects.toThrow("No such");
    }));

  it.each(["message", "metadata"] as const)("synchronous %s presentation failure disconnects once and cannot veto canonical writes", kind =>
    inOverseer(`subscriber-failure-${kind}`, async (impl, instance) => {
      setup(impl);
      const p = parent(impl);
      using client = await open(instance);
      const receiver = new ChatSubscriber();
      using sink = new RpcStub(receiver);
      using _subscription = await client.subscribeToChat(sink);
      const remove = vi.spyOn(impl, "removeChatSubscriber");
      const fault = kind === "message"
        ? vi.spyOn(impl, "hydrateChatMessageForClient").mockImplementationOnce(() => {throw new Error("presentation failed");})
        : vi.spyOn(impl, "chatMetadataForClient").mockImplementationOnce(() => {throw new Error("presentation failed");});
      if (kind === "message") {
        expect(() => impl.addChatMessages(p.chatId, USER, [{type: "message", message: "Must commit"}])).not.toThrow();
        expect(messages(impl, p.chatId).at(-1)).toMatchObject({message: "Must commit"});
      } else {
        expect(() => impl.storage.chatMeta.put({...impl.getChatMetaOrThrow(p.chatId), title: "Must commit"})).not.toThrow();
        expect(impl.getChatMetaOrThrow(p.chatId).title).toBe("Must commit");
      }
      expect(remove).toHaveBeenCalledOnce();
      fault.mockRestore();
      impl.addChatMessages(p.chatId, USER, [{type: "message", message: "No leaked subscriber"}]);
      await Promise.resolve();
      expect(receiver.messages).toEqual([]);
      expect(remove).toHaveBeenCalledOnce();
    }));

  it("caps latest-text evidence reads and retains status when the evidence source fails", () =>
    inOverseer("bounded-results", async impl => {
      setup(impl);
      await configure(impl);
      const p = parent(impl);
      const prepared = await impl.prepareNamedDelegation(p.chatId, p.execution, INPUT);
      await commit(impl, [prepared]);
      await impl.waitForAllAgentsToComplete();
      const receipt = impl.getNamedDelegation(prepared.id).receipt;
      impl.addChatMessages(receipt.childChatId, MODEL.profile, Array.from({length: 101}, () => ({type: "action", actionId: 1})),
        undefined, undefined, undefined, undefined, prepared.id);
      const list = vi.spyOn(impl.storage.chats.byRunSequence, "list");
      expect(impl.getNamedDelegation(prepared.id)).toMatchObject({response: undefined, run: {status: "finished"}});
      expect(list).toHaveBeenCalledWith({prefix: `${prepared.id}.`, reverse: true, limit: 100});
      list.mockImplementationOnce(() => {throw new Error("damaged evidence index");});
      expect(impl.getNamedDelegation(prepared.id)).toMatchObject({response: undefined, run: {status: "finished"}});
    }));
});
