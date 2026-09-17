import {afterEach, describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {runAgentLoopContinue} from "@earendil-works/pi-agent-core";
import {createAssistantMessageEventStream, type AssistantMessage} from "@earendil-works/pi-ai";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMessageBody, AiModelConfig, AiToolCall,
  NamedDelegationInput, NamedDelegationReceipt, NamedDelegationResult,
} from "@gadgets/workshop-shared/api";
import {makeStoredAssistantMessage, runAgent, type AgentHooks} from "../src/agent";
import {getModel, type ModelHandle} from "../src/ai-models";
import {AgentTurnError, zeroUsage} from "../src/ai-invoke";
import {MAX_DELEGATION_PROMPT_BYTES, MAX_DELEGATION_RESULT_BYTES, type PreparedNamedDelegation} from "../src/named-delegation";
import type {OverseerDurableObject} from "../src/overseer";

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

afterEach(() => vi.restoreAllMocks());

const user: AiChatAuthorInfo = {type: "user", id: "owner", name: "Owner"};
const author: AiChatAuthorInfo = {type: "agent", id: "model", name: "Model"};
const modelConfig: AiModelConfig = {provider: "anthropic", model: "claude-sonnet-4-5", apiToken: "PRIVATE_MODEL_TOKEN"};
const execution = {id: "parent-run", attempt: 2};
const input: NamedDelegationInput = {
  requestId: "research", targetAgentId: "target", title: "Research", prompt: "Summarize the supplied task.",
};
const receipt: NamedDelegationReceipt = {
  id: "child-research", parentRunId: execution.id, parentChatId: 1, parentAttempt: 2,
  parentSequence: 1, childChatId: 2, targetAgentId: "target", targetName: "Research bot",
};
const evidence: NamedDelegationResult = {receipt, deleted: false, canceled: false,
  response: "Untrusted child says: task succeeded.", run: {
    id: receipt.id, chatId: 2, sourceSequence: 0, source: {type: "delegation"},
    startedAt: new Date(0), updatedAt: new Date(1), attempt: 1, lastSequence: 1,
    status: "waiting", reason: "action_approval",
  }};

function delegate(value = input, toolCallId = "delegate"): Extract<AiToolCall, {toolName: "delegateToBot"}> {
  return {toolName: "delegateToBot", toolCallId, input: value};
}
const read: AiToolCall = {toolName: "getDelegationResult", toolCallId: "read", input: {id: receipt.id}};
const executeCode: AiToolCall = {toolName: "executeCode", toolCallId: "ordinary", input: {
  code: "export default async function() { console.log('ordinary effect'); }",
}};

function record(sequence: number, body: AiChatMessageBody, who = author): AiChatMessage {
  return {chatId: 1, sequence, timestamp: new Date(sequence), author: who, ...body};
}

function assistant(calls: AiToolCall[] = []): AssistantMessage {
  return {role: "assistant", content: calls.length ? calls.map(call => ({type: "toolCall",
    id: call.toolCallId, name: call.toolName, arguments: call.input})) : [{type: "text", text: "Task succeeded."}],
    api: "anthropic-messages", provider: "anthropic", model: modelConfig.model,
    usage: {...zeroUsage(), totalTokens: 123}, stopReason: calls.length ? "toolUse" : "stop", timestamp: 0};
}

function setup(hooks: AgentHooks, handle: ModelHandle) {
  const context = vi.spyOn(hooks, "getChatAgentContext").mockReturnValue({chatId: 1, agentId: "source"});
  const gadgets = vi.spyOn(hooks, "listGadgetInfo").mockReturnValue([]);
  vi.spyOn(hooks, "prepareChatBindings").mockResolvedValue([]);
  vi.spyOn(hooks, "getInstanceInstructions").mockResolvedValue("");
  const skills = vi.spyOn(hooks, "getAgentSkills").mockResolvedValue([]);
  const memory = vi.spyOn(hooks, "listAgentMemory").mockResolvedValue([]);
  const oldMemory = vi.spyOn(hooks, "getAgentMemory").mockResolvedValue([]);
  vi.spyOn(hooks, "describeStandardFormats").mockResolvedValue("");
  const vendors = vi.spyOn(hooks, "listConnectableVendors").mockResolvedValue([]);
  vi.spyOn(hooks, "getChatModelData").mockReturnValue(undefined);
  const list = vi.spyOn(hooks, "listNamedDelegates").mockResolvedValue([
    {targetAgentId: "target", name: "Research bot", bindingNames: ["DOCS", "ISSUES"]},
  ]);
  const prepare = vi.spyOn(hooks, "prepareNamedDelegation").mockImplementation(async (chatId, run, value) => ({
    id: `child-${value.requestId}`, parentChatId: chatId, execution: run, generation: 1, configRevision: 2,
    // The kernel normalizes bindings; local exact retry detection must not compare against that.
    input: {...value, bindingNames: (value.bindingNames ?? []).toSorted()},
    model: {profile: author, config: modelConfig}, targetName: "Research bot",
    targetInstructions: "SNAPSHOTTED_STANDING_INSTRUCTIONS", bindings: {},
  }));
  const result = vi.spyOn(hooks, "getNamedDelegationResult").mockResolvedValue(evidence);
  const observe = vi.spyOn(hooks, "recordAgentObservation").mockResolvedValue(undefined);
  const commit = vi.spyOn(hooks, "commitAgentStep").mockResolvedValue(false);
  const audit = vi.spyOn(hooks, "auditToolCalls");
  const mutations = (["executeCodeMode", "getComputerSession", "createGadget", "requestConnection",
    "addAgentMemory", "deleteAgentMemory", "prepareAgentProposal"] as const).map(name => vi.spyOn(hooks, name));
  const stream = vi.spyOn(handle, "stream").mockImplementation(() => { throw new Error("Unexpected provider call"); });
  const run = (options: {messages?: AiChatMessage[]; signal?: AbortSignal; tracked?: boolean; callback?: boolean} = {}) =>
    runAgent(hooks, handle, 1, author,
      options.messages ?? [record(0, {type: "message", message: "Delegate research"}, user)],
      options.signal ?? new AbortController().signal, user, options.callback ?? false,
      {modelConfig, measuredTokens: 0}, options.tracked === false ? undefined : execution);
  return {hooks, context, gadgets, skills, memory, oldMemory, vendors, list, prepare, result, observe, commit, audit, mutations, stream, run};
}

type Fixture = ReturnType<typeof setup>;
async function withAgent(test: (fixture: Fixture) => Promise<void>, checkMutations = true) {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-agent-core")>("@earendil-works/pi-agent-core");
  vi.mocked(runAgentLoopContinue).mockReset().mockImplementation(actual.runAgentLoopContinue);
  await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    const impl = instance["impl"];
    const fixture = setup(impl, getModel(impl.env, modelConfig, user));
    await test(fixture);
    if (checkMutations) {
      for (const mutation of fixture.mutations) expect(mutation).not.toHaveBeenCalled();
    }
  });
}

// Only the provider stream is synthetic: pi validates and executes the real agent tools and
// awaits the production event sink/barrier before requesting the next model response.
function script(fixture: Fixture, messages: AssistantMessage[],
    inspect?: (context: Parameters<ModelHandle["stream"]>[1], index: number) => void) {
  let index = 0;
  fixture.stream.mockImplementation((_model, context) => {
    const message = messages[index];
    if (!message) throw new Error("Unexpected polling or follow-up request");
    if (message.stopReason === "pending") throw new Error("Expected a completed synthetic response");
    inspect?.(context, index);
    ++index;
    const stream = createAssistantMessageEventStream();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({type: "error", reason: message.stopReason, error: message});
    } else {
      stream.push({type: "done", reason: message.stopReason, message});
    }
    return stream;
  });
}

function committedCalls(fixture: Fixture, step = 0) {
  return fixture.commit.mock.calls[step][2].flatMap(msg => msg.type === "message" ? msg.toolCalls ?? [] : []);
}

describe("named delegation agent tools", () => {
  it("awaits durable audit admission before dispatching any tool", () => withAgent(async f => {
    const entered = Promise.withResolvers<void>();
    const durable = Promise.withResolvers<void>();
    f.audit.mockImplementationOnce(async () => { entered.resolve(); await durable.promise; });
    script(f, [assistant([delegate()]), assistant()]);
    const running = f.run();
    await entered.promise;
    expect(f.audit).toHaveBeenCalledWith(1, author, [{toolCallId: "delegate", toolName: "delegateToBot"}], execution);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    durable.resolve();
    await running;
    expect(f.prepare).toHaveBeenCalledOnce();
  }));

  it("stops the entire batch when audit durability fails", () => withAgent(async f => {
    f.audit.mockRejectedValueOnce(new Error("Audit storage failed"));
    script(f, [assistant([delegate(), read])]);
    await expect(f.run()).rejects.toThrow("Audit storage failed");
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.result).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  }));

  it("stages exact retries once, commits only IDs with run identity, and never waits for a child", () => withAgent(async f => {
    const prepared = Promise.withResolvers<PreparedNamedDelegation>();
    const prepareImpl = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementationOnce(async (...args) => {
      expect(f.commit).not.toHaveBeenCalled();
      prepared.resolve(await prepareImpl(...args));
      return prepared.promise;
    });
    const calls = [delegate(), delegate(input, "retry")];
    script(f, [assistant(calls), assistant()], (context, index) => {
      expect(context.systemPrompt).toContain("Admission happens only after this step commits");
      expect(context.systemPrompt).toContain("Check on a later turn, without busy polling");
      expect(context.systemPrompt).toContain('"bindingNames":["DOCS","ISSUES"]');
      if (index === 1) {
        expect(f.commit).toHaveBeenCalledOnce();
        expect(context.messages.filter(msg => msg.role === "toolResult")).toMatchObject([
          {content: [{text: expect.stringContaining("Staged only")}]},
          {content: [{text: expect.stringContaining("Staged only")}]},
        ]);
      }
    });
    await expect(f.run()).resolves.toEqual({disposition: {status: "finished", reason: "model_stop"}});
    expect(f.list).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith(1, execution, input);
    expect(f.commit.mock.calls[0][3]).toEqual({changes: [], createdGadgets: [], addedBindings: [],
      run: execution, delegations: [await prepared.promise]});
    expect(f.commit.mock.calls[1][3]).not.toHaveProperty("delegations");
    expect(committedCalls(f)).toEqual(calls.map(call => ({...call, delegationId: receipt.id})));
    const transcript = f.commit.mock.calls.flatMap(call => call[2]);
    expect(transcript.map(msg => msg.type)).toEqual(["message", "message"]);
    expect(JSON.stringify(transcript)).not.toContain("PRIVATE_MODEL_TOKEN");
    expect(JSON.stringify(transcript)).not.toContain("SNAPSHOTTED_STANDING_INSTRUCTIONS");
    expect(f.result).not.toHaveBeenCalled();
  }));

  it.each([
    {name: "no source", context: {chatId: 1}},
    {name: "spawner", context: {chatId: 1, agentId: "source", spawnerConfig: {displayName: "Spawn", modelId: null, env: {}}}},
    {name: "untracked", tracked: false},
    {name: "no configuration", empty: true},
  ])("withholds admission for $name and reads only for ineligible parents", test => withAgent(async f => {
    if (test.context) f.context.mockReturnValue(test.context);
    if (test.empty) f.list.mockResolvedValue([]);
    script(f, [assistant()], context => {
      expect(context.tools?.map(tool => tool.name)).not.toContain("delegateToBot");
      expect(context.tools?.some(tool => tool.name === "getDelegationResult")).toBe(!!test.empty);
      expect(context.systemPrompt).not.toContain("# Named delegation");
    });
    await f.run({tracked: test.tracked});
    expect(f.list).toHaveBeenCalledTimes(test.empty ? 1 : 0);
    expect(f.prepare).not.toHaveBeenCalled();
  }));

  it("keeps the parent's receipt reader after all target grants are revoked", () => withAgent(async f => {
    script(f, [assistant([delegate()]), assistant()]);
    await f.run();
    const admittedCall = committedCalls(f)[0];
    expect(admittedCall).toMatchObject({delegationId: receipt.id});
    const history = [record(0, {type: "message", message: "Delegate research"}, user),
      record(1, {type: "message", message: "", toolCalls: [admittedCall]}),
      // The owner core supplies this canonical receipt after the barrier, not the agent.
      record(2, {type: "namedDelegation", delegation: receipt}),
      record(3, {type: "message", message: "Check the admitted child"}, user)];
    f.list.mockResolvedValue([]);
    f.prepare.mockClear();
    f.commit.mockClear();
    script(f, [assistant([read]), assistant()], context => {
      expect(context.tools?.map(tool => tool.name)).not.toContain("delegateToBot");
      expect(context.tools?.map(tool => tool.name)).toContain("getDelegationResult");
    });
    await f.run({messages: history});
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.result).toHaveBeenCalledExactlyOnceWith(1, receipt.id);
    expect(committedCalls(f)).toEqual([{...read, result: evidence}]);
    expect(f.commit.mock.calls.every(call => !call[3].delegations?.length)).toBe(true);
  }));

  it.each([
    {targetAgentId: "foreign"}, {bindingNames: ["PRIVATE"]}, {bindingNames: Array(9).fill("DOCS")},
    {prompt: "x".repeat(MAX_DELEGATION_PROMPT_BYTES + 1)},
    {prompt: "\u00e9".repeat(MAX_DELEGATION_PROMPT_BYTES / 2 + 1)},
    {requestId: ""}, {title: "x".repeat(121)}, {model: "injected"},
  ])("rejects invalid or unconfigured input without preparing: %j", patch => withAgent(async f => {
    script(f, [assistant([delegate({...input, ...patch})]), assistant()]);
    await f.run();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(committedCalls(f)[0]).toHaveProperty("error");
    expect(f.commit.mock.calls[0][3]).not.toHaveProperty("delegations");
  }));

  it("rejects conflicting request IDs and caps staging at four even in one tool batch", () => withAgent(async f => {
    const calls = Array.from({length: 5}, (_, i) => delegate({...input, requestId: `request-${i}`}, `call-${i}`));
    calls.push(delegate({...input, requestId: "request-0", prompt: "Conflicting task"}, "conflict"));
    script(f, [assistant(calls), assistant()], (context, index) => {
      if (index === 1) {
        const results = context.messages.filter(msg => msg.role === "toolResult");
        expect(results.every(result => result.isError)).toBe(true);
        expect(results[0].content).toEqual([{type: "text", text: "Staged delegation discarded; this step did not admit it."}]);
      }
    });
    await f.run();
    expect(f.prepare).toHaveBeenCalledTimes(4);
    expect(committedCalls(f)[4].error).toContain("At most four");
    expect(committedCalls(f)[5].error).toContain("different input");
    expect(f.commit.mock.calls[0][3]).not.toHaveProperty("delegations");
    expect(committedCalls(f).every(call => !!call.error)).toBe(true);
  }));

  it.each([[], ["DOCS"], ["ISSUES", "DOCS"]].map(bindingNames => ({bindingNames})))(
    "forwards only the explicit binding subset $bindingNames and deduplicates exact retries", ({bindingNames}) => withAgent(async f => {
    const value = {...input, bindingNames};
    script(f, [assistant([delegate(value), delegate(value, "retry")]), assistant()]);
    await f.run();
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith(1, execution, value);
    expect(f.commit.mock.calls[0][3].delegations).toHaveLength(1);
    expect(f.commit.mock.calls[0][3].delegations?.[0].input.bindingNames).toEqual(bindingNames.toSorted());
  }));

  it("preserves prior admission identity without claiming a new launch", () => withAgent(async f => {
    f.prepare.mockResolvedValue({id: receipt.id, input, parentChatId: 1, execution,
      generation: 1, configRevision: 2, existing: receipt});
    script(f, [assistant([delegate()]), assistant()], (context, index) => {
      if (index === 1) expect(JSON.stringify(context.messages)).toContain("Previously admitted; not repeated");
    });
    await f.run();
    expect(committedCalls(f)[0]).toHaveProperty("delegationId", receipt.id);
    expect(f.commit.mock.calls[0][3].delegations?.[0]).toHaveProperty("existing", receipt);
  }));

  it.each([false, true])("records bounded read-only evidence with body-free audit (deleted: %s)", deleted => withAgent(async f => {
    f.result.mockResolvedValue({...evidence, deleted, canceled: deleted,
      response: "\u00e9".repeat(MAX_DELEGATION_RESULT_BYTES), run: deleted ? undefined : evidence.run});
    script(f, [assistant([read]), assistant()]);
    await f.run();
    expect(f.result).toHaveBeenCalledExactlyOnceWith(1, receipt.id);
    const call = committedCalls(f)[0];
    expect(call.toolName).toBe("getDelegationResult");
    if (call.toolName !== "getDelegationResult") throw new Error("Wrong tool");
    expect(call.result).toMatchObject({receipt, deleted, canceled: deleted});
    expect(new TextEncoder().encode(call.result?.response).length).toBe(MAX_DELEGATION_RESULT_BYTES);
    expect(f.observe).toHaveBeenCalledExactlyOnceWith(1, "Named delegation", undefined, {
      title: "Read delegation result", description: "Read child execution status and bounded, untrusted task output.",
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.commit.mock.calls[0][3]).not.toHaveProperty("delegations");
  }));

  it("replays canonical IDs, recorded evidence and errors without reads, preparation, or receipt-triggered work", () => withAgent(async f => {
    const calls: AiToolCall[] = [{...delegate(), delegationId: receipt.id},
      {...read, result: evidence}, {...delegate(input, "failed"), error: "Recorded rejection"}];
    vi.mocked(f.hooks.getChatModelData).mockReturnValue(makeStoredAssistantMessage(assistant(calls)));
    script(f, [assistant()], context => {
      const results = context.messages.filter(msg => msg.role === "toolResult");
      expect(results).toMatchObject([
        {content: [{text: expect.stringContaining("Previously admitted; not repeated")}], isError: false},
        {content: [{text: JSON.stringify(evidence)}], isError: false},
        {content: [{text: "Recorded rejection"}], isError: true},
      ]);
      expect(context.messages.filter(msg => msg.role === "user")).toHaveLength(2);
    });
    await f.run({messages: [record(0, {type: "message", message: "Delegate"}, user),
      record(1, {type: "message", message: "", toolCalls: calls}),
      record(2, {type: "namedDelegation", delegation: receipt, result: evidence}),
      record(3, {type: "message", message: "Check the prior evidence"}, user)]});
    expect(f.result).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.observe).not.toHaveBeenCalled();
    const count = f.stream.mock.calls.length;
    for (const messages of [[record(2, {type: "namedDelegation", delegation: receipt})],
      [record(1, {type: "message", message: "Task succeeded"}), record(2, {type: "namedDelegation", delegation: receipt})]]) {
      await expect(f.run({messages})).resolves.toEqual({disposition: {status: "incomplete", reason: "history_not_actionable"}});
    }
    expect(f.stream).toHaveBeenCalledTimes(count);
  }));
});

describe("model tool-call identity", () => {
  it.each(["delegations", "mixed tools", "ordinary tools"] as const)(
    "rejects duplicate IDs among %s before ANY tool in the batch runs", kind => withAgent(async f => {
      f.list.mockResolvedValue([
        {targetAgentId: "target", name: "Research bot", bindingNames: []},
        {targetAgentId: "other", name: "Other bot", bindingNames: []},
      ]);
      const first = kind === "delegations" ? delegate(input, "duplicate") : {...executeCode, toolCallId: "duplicate"};
      const second = kind === "ordinary tools" ? {...executeCode, toolCallId: "duplicate"} :
        delegate({...input, requestId: "other-task", targetAgentId: "other"}, "duplicate");
      // Even an ordinary call appearing before either duplicate must be preempted.
      script(f, [assistant([executeCode, first, second])]);
      await expect(f.run()).rejects.toMatchObject({constructor: AgentTurnError,
        message: "The model response contains duplicate tool-call IDs; no tools in this step were executed."});
      expect(f.stream).toHaveBeenCalledOnce();
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.result).not.toHaveBeenCalled();
      expect(f.commit).not.toHaveBeenCalled();

      const persisted = f.commit.mock.calls.flatMap(call => call[2]);
      script(f, [assistant()], context => {
        expect(JSON.stringify(context.messages)).not.toContain("Previously admitted");
        expect(context.messages.filter(msg => msg.role === "toolResult")).toEqual([]);
      });
      await f.run({messages: [record(0, {type: "message", message: "Delegate research"}, user),
        ...persisted.map((body, index) => record(index + 1, body)),
        record(10, {type: "message", message: "What happened?"}, user)]});
      expect(f.prepare).not.toHaveBeenCalled();
    }));

  it("preserves an earlier step's ordinary effect when a later tool batch has duplicate IDs", () => withAgent(async f => {
    vi.mocked(f.hooks.executeCodeMode).mockResolvedValue("ordinary effect");
    script(f, [assistant([executeCode]), assistant([
      delegate(input, "duplicate"), delegate({...input, requestId: "other-task"}, "duplicate"),
    ])], (_context, index) => {
      if (index === 1) expect(f.commit).toHaveBeenCalledOnce();
    });
    await expect(f.run()).rejects.toBeInstanceOf(AgentTurnError);
    expect(f.hooks.executeCodeMode).toHaveBeenCalledOnce();
    expect(f.commit).toHaveBeenCalledOnce();
    expect(committedCalls(f)).toEqual([{...executeCode, output: "ordinary effect"}]);
    expect(f.commit.mock.calls[0][3]).toEqual({changes: [], createdGadgets: [], addedBindings: [], run: execution});
    const completed = f.commit.mock.calls[0][2][0];
    vi.mocked(f.hooks.getChatModelData).mockReturnValue(completed.modelData);
    script(f, [assistant()], context => {
      expect(context.messages.filter(msg => msg.role === "toolResult")).toMatchObject([
        {toolName: "executeCode", content: [{text: "ordinary effect"}], isError: false},
      ]);
      expect(JSON.stringify(context.messages)).not.toContain("Previously admitted");
    });
    await f.run({messages: [record(0, {type: "message", message: "Do the task"}, user),
      record(1, completed), record(2, {type: "message", message: "What happened?"}, user)]});
    expect(f.hooks.executeCodeMode).toHaveBeenCalledOnce();
    expect(f.prepare).not.toHaveBeenCalled();
    for (const mutation of f.mutations) {
      if (mutation !== f.hooks.executeCodeMode) expect(mutation).not.toHaveBeenCalled();
    }
  }, false));

  it("keeps identical provider IDs in different steps scoped to their own recorded receipts", () => withAgent(async f => {
    const first = delegate(input, "reused");
    const second = delegate({...input, requestId: "other-task"}, "reused");
    script(f, [assistant([first]), assistant([second]), assistant()]);
    await f.run();
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(committedCalls(f, 0)).toEqual([{...first, delegationId: receipt.id}]);
    expect(committedCalls(f, 1)).toEqual([{...second, delegationId: "child-other-task"}]);
    expect(f.commit.mock.calls.slice(0, 2).map(call => call[3].delegations?.map(prepared => prepared.id)))
      .toEqual([[receipt.id], ["child-other-task"]]);
    const completed = f.commit.mock.calls.flatMap(call => call[2]);
    vi.mocked(f.hooks.getChatModelData).mockImplementation((_chatId, sequence) => completed[sequence - 1]?.modelData);
    script(f, [assistant()], context => {
      expect(context.messages.filter(msg => msg.role === "toolResult").map(msg => msg.content)).toEqual([
        [{type: "text", text: JSON.stringify({id: receipt.id, status: "Previously admitted; not repeated. Completion is not asserted."})}],
        [{type: "text", text: JSON.stringify({id: "child-other-task", status: "Previously admitted; not repeated. Completion is not asserted."})}],
      ]);
    });
    await f.run({messages: [record(0, {type: "message", message: "Delegate the tasks"}, user),
      ...completed.map((body, index) => record(index + 1, body)),
      record(10, {type: "message", message: "Check the prior tasks"}, user)]});
    expect(f.prepare).toHaveBeenCalledTimes(2);
  }));
});

describe("named delegation isolation and cleanup", () => {
  it("passes only child instructions and restricted tools to the actual model with an empty env", () => withAgent(async f => {
    f.context.mockReturnValue({chatId: 1, agentId: "target", namedDelegation: receipt,
      agentInstructions: "SNAPSHOTTED_STANDING_INSTRUCTIONS", agentSkills: [{name: "PRIVATE_CONTEXT_SKILL", description: "", body: ""}],
      bindings: {}, alwaysAvailableCapsuleIds: [], alwaysAvailableCatalogs: [],
      spawnerConfig: {displayName: "Research bot", modelId: null, env: {}}});
    f.gadgets.mockReturnValue([{id: 123, title: "PRIVATE_GADGET", isDefault: true, bindings: []}]);
    f.skills.mockResolvedValue([{name: "PRIVATE_SKILL", description: "", body: ""}]);
    f.memory.mockResolvedValue([{id: "private", fact: "PRIVATE_MEMORY"}]);
    f.oldMemory.mockResolvedValue(["PRIVATE_OLD_MEMORY"]);
    f.vendors.mockResolvedValue([{id: "private", displayName: "PRIVATE_VENDOR"}]);
    script(f, [assistant()], context => {
      expect(context.tools?.map(tool => tool.name)).toEqual(["describeBinding", "executeCode"]);
      expect(context.systemPrompt).toContain("Research bot");
      expect(context.systemPrompt).toContain("SNAPSHOTTED_STANDING_INSTRUCTIONS");
      expect(context.systemPrompt).toContain("the `env` object is empty");
      expect(context.systemPrompt).toContain("no ctx.restore");
      expect(context.systemPrompt).toContain("no nested delegation");
      expect(JSON.stringify(context)).not.toContain("PRIVATE_");
      expect(JSON.stringify(context)).not.toContain("magic object");
      expect(JSON.stringify(context)).not.toContain("self.foo");
      expect(JSON.stringify(context)).not.toContain("# Routine and skill proposals");
    });
    await f.run({callback: true});
    for (const hook of [f.gadgets, f.skills, f.memory, f.oldMemory, f.vendors, f.list]) expect(hook).not.toHaveBeenCalled();
  }));

  it.each(["prepare", "abort", "bad-tool", "unknown-tool", "barrier", "throw", "error", "aborted"] as const)(
    "discards staging on %s and cannot deliver it on a later run", failure => withAgent(async f => {
      const controller = new AbortController();
      if (failure === "prepare") f.prepare.mockRejectedValueOnce(new Error("Preparation failed"));
      if (failure === "abort") {
        const original = f.prepare.getMockImplementation()!;
        f.prepare.mockImplementationOnce(async (...args) => {
          const prepared = await original(...args);
          controller.abort(new Error("Aborted during preparation"));
          return prepared;
        });
      }
      if (failure === "barrier") f.commit.mockRejectedValueOnce(new Error("Barrier failed"));
      const calls = [delegate()];
      if (failure === "bad-tool") calls.push(delegate({...input, requestId: "bad", targetAgentId: "foreign"}, "bad"));
      const message = assistant(calls);
      if (failure === "unknown-tool") message.content.push({type: "toolCall", id: "unknown", name: "launchBot", arguments: {}});
      script(f, [message, assistant()]);
      if (["throw", "error", "aborted"].includes(failure)) {
        vi.mocked(runAgentLoopContinue).mockImplementationOnce(async (context, _config, emit) => {
          await emit({type: "turn_start"});
          const result = await context.tools!.find(tool => tool.name === "delegateToBot")!.execute("delegate", input);
          if (failure === "throw") throw new Error("Loop failed");
          await emit({type: "turn_end", message: {...message, stopReason: failure as "error" | "aborted", errorMessage: "Provider failed"},
            toolResults: [{role: "toolResult", toolCallId: "delegate", toolName: "delegateToBot", timestamp: 0, isError: false, ...result}]});
          await emit({type: "agent_end", messages: []});
          return [];
        });
      }
      if (["abort", "barrier", "throw", "error", "aborted"].includes(failure)) {
        await expect(f.run({signal: controller.signal})).rejects.toThrow();
      } else await f.run();
      if (failure !== "barrier") {
        expect(f.commit.mock.calls.every(call => !call[3].delegations?.length)).toBe(true);
      }
      script(f, [assistant()]);
      await f.run();
      expect(f.commit.mock.lastCall?.[3]).not.toHaveProperty("delegations");
    }));

  it.each(["turn_start", "agent_end"] as const)("clears abandoned staging at %s", event => withAgent(async f => {
    vi.mocked(runAgentLoopContinue).mockImplementationOnce(async (context, _config, emit) => {
      await emit({type: "turn_start"});
      await context.tools!.find(tool => tool.name === "delegateToBot")!.execute("delegate", input);
      await emit(event === "turn_start" ? {type: event} : {type: event, messages: []});
      await emit({type: "turn_end", message: assistant(), toolResults: []});
      return [];
    });
    await f.run();
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.commit.mock.lastCall?.[3]).not.toHaveProperty("delegations");
  }));

  it("discards a successfully prepared child if cancellation arrives before the barrier", () => withAgent(async f => {
    const controller = new AbortController();
    vi.mocked(runAgentLoopContinue).mockImplementationOnce(async (context, _config, emit) => {
      await emit({type: "turn_start"});
      const result = await context.tools!.find(tool => tool.name === "delegateToBot")!.execute("delegate", input);
      controller.abort(new Error("Canceled before admission"));
      await emit({type: "turn_end", message: assistant([delegate()]), toolResults: [
        {role: "toolResult", toolCallId: "delegate", toolName: "delegateToBot", timestamp: 0, isError: false, ...result},
      ]});
      return [];
    });
    await expect(f.run({signal: controller.signal})).rejects.toThrow("Canceled before admission");
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.commit.mock.lastCall?.[3]).not.toHaveProperty("delegations");
    expect(committedCalls(f)[0]).toMatchObject({error: "Staged delegation discarded; this step did not admit it."});
    expect(committedCalls(f)[0]).not.toHaveProperty("delegationId");
  }));
});
