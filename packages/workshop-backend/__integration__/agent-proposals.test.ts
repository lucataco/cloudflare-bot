import { runInDurableObject } from "cloudflare:test";
import { exports, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcStub } from "capnweb";
import type {
  AgentProfile, AgentProposalDraft, AgentRoutineSchedule, AiChatMessage,
  AuthenticatedApi, PublicApi,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer";
import type { UserDurableObject } from "../src/user";
import { afterEach, describe, expect, it, vi } from "vitest";

const skill: AgentProposalDraft = {kind: "skill", value: {
  name: "Status report", description: "Use for weekly reports", body: "Read sources and cite evidence.",
}};
const routine: AgentProposalDraft = {kind: "routine", value: {
  name: "Weekly report", prompt: "Read sources and prepare a report.",
  schedule: {kind: "calendar", timeZone: "UTC", freq: "weekly", byDay: ["MO"], hour: 9, minute: 0},
}};
const author = {type: "agent" as const, id: "test-model", name: "Test model"};
const step = {changes: [], createdGadgets: [], addedBindings: []};

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 0));
  vi.restoreAllMocks();
});

async function connect() {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: {Upgrade: "websocket"},
  }));
  const socket = response.webSocket;
  if (!socket) throw new Error("Expected WebSocket response");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function account(publicApi: RpcStub<PublicApi>) {
  const name = "proposal" + crypto.randomUUID().replaceAll("-", "");
  const token = await publicApi.createAccount(name, name, new Uint8Array([1, 2, 3]));
  if (!token) throw new Error("Account creation failed");
  return publicApi.authenticate(token);
}

async function bot(api: RpcStub<AuthenticatedApi>) {
  const agent = await api.createAgent("Proposal bot", "", "", null);
  using owner = await api.openGadget(agent.workspaceId);
  await owner.getMetadata();
  return agent;
}

function workspace(id: string) {
  return exports.OverseerDurableObject.get(exports.OverseerDurableObject.idFromString(id));
}

async function ownerUser(agent: AgentProfile) {
  const id = await runInDurableObject(workspace(agent.workspaceId),
    (instance: OverseerDurableObject) => instance["impl"].ownerId!);
  return exports.UserDurableObject.get(exports.UserDurableObject.idFromString(id));
}

async function prepare(agent: AgentProfile, draft: AgentProposalDraft = skill, commit = true) {
  return runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
    const impl = instance["impl"];
    if (!impl.storage.chatMeta.get(1)) {
      impl.storage.chatMeta.put({id: 1, title: "Proposals", started: new Date(), lastActive: new Date()});
      impl.storage.chatContext.put({chatId: 1, agentId: agent.id});
    }
    const proposal = await impl.prepareAgentProposal(1, {reason: "This task repeats", draft});
    if (commit) await impl.commitAgentStep(1, author, [proposal], step);
    return proposal;
  });
}

async function snapshot(agent: AgentProfile) {
  return runInDurableObject(workspace(agent.workspaceId), (instance: OverseerDurableObject) => {
    const impl = instance["impl"];
    return {messages: [...impl.storage.chats.list()], chats: [...impl.storage.chatMeta.list()],
      hooks: [...impl.storage.boundHooks.list()], policies: [...impl.storage.autoApproveTags.list()],
      browser: impl.storage.computerControl.get(), paused: impl.storage.automationPaused.get()};
  });
}

describe("agent proposal kernel", () => {
  it("preparation is inert and step rollback cannot leave an actionable proposal", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    const proposal = await prepare(agent, skill, false);
    expect(proposal).toMatchObject({type: "agentProposal", state: "pending", agentId: agent.id,
      agentName: agent.name, draft: skill});
    expect(proposal.proposalId).toMatch(/^1:/);
    expect(proposal.artifactId).not.toBe(proposal.proposalId);
    expect((await snapshot(agent)).messages).toEqual([]);
    expect(await api.listSkills(agent.id)).toEqual([]);
    expect(await api.listRoutines(agent.id)).toEqual([]);
    const profile = await api.whoami();
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      using closed = new NativeRpcStub(() => {});
      using owner = new RpcStub(await instance.open(impl.ownerId!, profile.id, closed));
      await expect(owner.acceptAgentProposal(proposal.proposalId)).rejects.toThrow("No such agent proposal");
      const materialize = vi.spyOn(impl, "materializeChatChanges").mockImplementationOnce(() => {
        throw new Error("injected step rollback");
      });
      await expect(impl.commitAgentStep(1, author, [proposal], step)).rejects.toThrow("injected step rollback");
      expect([...impl.storage.chats.list()]).toEqual([]);
      await expect(owner.acceptAgentProposal(proposal.proposalId)).rejects.toThrow("No such agent proposal");
      materialize.mockRestore();
      await impl.commitAgentStep(1, author, [proposal], step);
      expect([...impl.storage.chats.list()]).toMatchObject([{proposalId: proposal.proposalId}]);
    });
    expect(await api.listSkills(agent.id)).toEqual([]);
  });

  it.each([skill, routine])("owner acceptance saves one ordinary $kind while automation is paused", async draft => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    using owner = await api.openGadget(agent.workspaceId);
    const proposal = await prepare(agent, draft);
    await owner.setAutomationPaused(true);
    const before = await snapshot(agent);
    const messages: AiChatMessage[] = [];
    const subscriber = {add() {}, remove() {}, update(_old: AiChatMessage, message: AiChatMessage) {
      messages.push(message);
    }};
    await runInDurableObject(workspace(agent.workspaceId), (instance: OverseerDurableObject) => {
      instance["impl"].storage.chats.subscribe(subscriber);
    });
    const [first, second] = await Promise.all([
      owner.acceptAgentProposal(proposal.proposalId), owner.acceptAgentProposal(proposal.proposalId),
    ]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({state: "accepted", receipt: {missing: false}});
    const after = await snapshot(agent);
    expect(after.hooks).toEqual([]);
    expect(after.policies).toEqual(before.policies);
    expect(after.browser).toEqual(before.browser);
    expect(after.paused).toBe(true);
    expect(after.chats[0].activeAgent).toBeUndefined();
    const artifacts = draft.kind === "skill" ? await api.listSkills(agent.id) : await api.listRoutines(agent.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({id: proposal.artifactId, ...draft.value});
    if (draft.kind === "routine") {
      expect(artifacts[0]).toMatchObject({paused: true});
      expect(artifacts[0]).not.toHaveProperty("hookId");
    }
    expect(messages).toHaveLength(2);
    expect(messages).toMatchObject([{state: "accepting"}, {state: "accepted"}]);
    expect(messages[0].timestamp.valueOf()).toBeGreaterThan(before.messages[0].timestamp.valueOf());
    expect(messages[1].timestamp.valueOf()).toBeGreaterThan(messages[0].timestamp.valueOf());
    expect(await owner.acceptAgentProposal(proposal.proposalId)).toEqual(first);
    expect((await snapshot(agent)).messages).toEqual(after.messages);
    expect(messages).toHaveLength(2);
    await runInDurableObject(workspace(agent.workspaceId), (instance: OverseerDurableObject) => {
      const chats = instance["impl"].storage.chats;
      chats.unsubscribe(subscriber);
      // The public subscription's offline catch-up reads this timestamp index.
      expect([...chats.byTimestamp.list({startAfter: before.messages[0].timestamp.valueOf()})])
        .toMatchObject([{state: "accepted"}]);
    });
  });

  it("owner denial is terminal, timestamp-stable, and never creates an artifact", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    const proposal = await prepare(agent);
    const profile = await api.whoami();
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      using closed = new NativeRpcStub(() => {});
      using owner = new RpcStub(await instance.open(impl.ownerId!, profile.id, closed));
      const denied = await owner.denyAgentProposal(proposal.proposalId);
      expect(denied).toMatchObject({state: "denied"});
      const messages = [...impl.storage.chats.list()];
      expect(await owner.denyAgentProposal(proposal.proposalId)).toEqual(denied);
      await expect(owner.acceptAgentProposal(proposal.proposalId)).rejects.toThrow("was denied");
      await expect(owner.acceptAgentProposal("2:" + proposal.proposalId.split(":")[1])).rejects.toThrow("No such");
      await expect(owner.acceptAgentProposal("01:" + proposal.proposalId.split(":")[1])).rejects.toThrow("No such");
      await expect(Reflect.apply(owner.acceptAgentProposal, owner, [{...proposal, state: "accepted"}]))
        .rejects.toThrow("expected string");
      expect([...impl.storage.chats.list()]).toEqual(messages);
    });
    expect(await api.listSkills(agent.id)).toEqual([]);
  });

  it.each(["build", "use"] as const)("%s collaborators cannot accept or deny canonical proposals", async role => {
    using publicApi = await connect();
    using api = await account(publicApi);
    using other = await account(publicApi);
    const agent = await bot(api);
    const foreign = await bot(other);
    const foreignUser = await ownerUser(foreign);
    using owner = await api.openGadget(agent.workspaceId);
    const profile = await other.whoami();
    await owner.addCollaborator(profile.id, role);
    const proposal = await prepare(agent);
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      using closed = new NativeRpcStub(() => {});
      using collaborator = new RpcStub(await instance.open(foreignUser.id.toString(), profile.id, closed));
      await expect(collaborator.acceptAgentProposal(proposal.proposalId)).rejects.toThrow();
      await expect(collaborator.denyAgentProposal(proposal.proposalId)).rejects.toThrow();
      expect([...instance["impl"].storage.chats.list()]).toMatchObject([{state: "pending"}]);
    });
    expect(await api.listSkills(agent.id)).toEqual([]);
  });

  it.each(["accept", "delete chat"])("durable acceptance fences denial while creation awaits: %s", async next => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    const proposal = await prepare(agent);
    const profile = await api.whoami();
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      using closed = new NativeRpcStub(() => {});
      using owner = new RpcStub(await instance.open(impl.ownerId!, profile.id, closed));
      const get = impl.users.get.bind(impl.users);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const sync = vi.spyOn(impl.ctx.storage, "sync");
      vi.spyOn(impl.users, "get").mockImplementation((...args) => {
        const user = get(...args);
        return new Proxy(user, {get(target, key) {
          if (key === "ensureProposalArtifact") return async (...params: Parameters<UserDurableObject["ensureProposalArtifact"]>) => {
            expect(sync).toHaveBeenCalled();
            expect([...impl.storage.chats.list()]).toMatchObject([{state: "accepting"}]);
            entered.resolve();
            await release.promise;
            return user.ensureProposalArtifact(...params);
          };
          return Reflect.get(target, key, target);
        }});
      });
      const accepting = owner.acceptAgentProposal(proposal.proposalId);
      const result = accepting.then(value => ({value}), error => ({error}));
      await entered.promise;
      await expect(owner.denyAgentProposal(proposal.proposalId)).rejects.toThrow("already been decided");
      if (next === "delete chat") await owner.deleteChat(1);
      release.resolve();
      if (next === "delete chat") {
        expect(await result).toMatchObject({error: {message: "No such agent proposal."}});
        expect([...impl.storage.chats.list()]).toEqual([]);
        expect([...impl.storage.chatContext.list()]).toEqual([]);
        expect([...impl.storage.chatMeta.list()]).toEqual([]);
      } else {
        expect(await result).toMatchObject({value: {state: "accepted"}});
        await expect(owner.denyAgentProposal(proposal.proposalId)).rejects.toThrow("already been decided");
      }
    });
    expect(await api.listSkills(agent.id)).toHaveLength(1);
  });

  it.each([skill, routine].flatMap(draft => ["edit", "delete"].map(action => ({draft, action}))))(
    "lost create response and User/Overseer restart preserve $draft.kind $action", async ({draft, action}) => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    const proposal = await prepare(agent, draft);
    const user = await ownerUser(agent);
    const profile = await api.whoami();
    let createdAt: Date | undefined;
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      using closed = new NativeRpcStub(() => {});
      using owner = new RpcStub(await instance.open(impl.ownerId!, profile.id, closed));
      const get = impl.users.get.bind(impl.users);
      const spy = vi.spyOn(impl.users, "get").mockImplementation((...args) => {
        const stub = get(...args);
        return new Proxy(stub, {get(target, key) {
          if (key === "ensureProposalArtifact") return async (...params: Parameters<UserDurableObject["ensureProposalArtifact"]>) => {
            const receipt = await stub.ensureProposalArtifact(...params);
            createdAt = receipt.createdAt;
            throw new Error("injected lost creation response");
          };
          return Reflect.get(target, key, target);
        }});
      });
      await expect(owner.acceptAgentProposal(proposal.proposalId)).rejects.toThrow("injected lost creation response");
      spy.mockRestore();
    });
    const accepting = (await snapshot(agent)).messages[0];
    expect(accepting).toMatchObject({state: "accepting"});
    if (draft.kind === "skill") {
      if (action === "edit") await api.updateSkill(agent.id, proposal.artifactId, {body: "Owner edited this"});
      else await api.deleteSkill(agent.id, proposal.artifactId);
    } else {
      if (action === "edit") await api.updateRoutine(agent.id, proposal.artifactId, {prompt: "Owner edited this"});
      else await api.deleteRoutine(agent.id, proposal.artifactId);
    }
    const before = draft.kind === "skill" ? await api.listSkills(agent.id) : await api.listRoutines(agent.id);
    await expect(runInDurableObject(user, (_instance, state) => {
      state.abort("user-DO reset injected by test");
    })).rejects.toThrow();
    await expect(runInDurableObject(workspace(agent.workspaceId), (_instance, state) => {
      state.abort("user-DO reset injected by test");
    })).rejects.toThrow();
    using owner = await api.openGadget(agent.workspaceId);
    const accepted = await owner.acceptAgentProposal(proposal.proposalId);
    expect(accepted).toMatchObject({state: "accepted", receipt: {createdAt, missing: action === "delete"}});
    if (accepting.type !== "agentProposal" || accepting.state !== "accepting") throw new Error("Expected acceptance");
    expect(accepted).toMatchObject({decidedAt: accepting.decidedAt});
    expect(draft.kind === "skill" ? await api.listSkills(agent.id) : await api.listRoutines(agent.id)).toEqual(before);
    expect((await snapshot(agent)).hooks).toEqual([]);
    expect(await owner.acceptAgentProposal(proposal.proposalId)).toEqual(accepted);
  });

  it("creation receipts reject mismatched inputs, roll back atomically, and revalidate the owner record", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    const user = await ownerUser(agent);
    const source = {workspaceId: agent.workspaceId, proposalId: "1:" + crypto.randomUUID()};
    const id = crypto.randomUUID();
    await runInDurableObject(user, async (instance: UserDurableObject) => {
      const put = vi.spyOn(instance["storage"].proposalReceipts, "put").mockImplementationOnce(() => {
        throw new Error("injected receipt failure");
      });
      await expect(instance.ensureProposalArtifact(source, agent.id, id, skill)).rejects.toThrow("receipt failure");
      expect(await instance.listSkills(agent.id)).toEqual([]);
      put.mockRestore();
    });
    const receipt = await user.ensureProposalArtifact(source, agent.id, id, skill);
    expect(await user.ensureProposalArtifact(source, agent.id, id, {
      value: {body: skill.value.body, description: skill.value.description, name: skill.value.name}, kind: "skill",
    })).toEqual(receipt);
    const other = await api.createAgent("Other bot", "", "", null);
    // Catch expected failures in the DO: the pool's runner-side RPC proxy double-reports rejection.
    await runInDurableObject(user, async (instance: UserDurableObject) => {
      await expect(instance.ensureProposalArtifact(source, "other-agent", id, skill)).rejects.toThrow("does not match");
      await expect(instance.ensureProposalArtifact(source, agent.id, "other-id", skill)).rejects.toThrow("does not match");
      await expect(instance.ensureProposalArtifact(source, agent.id, id, routine)).rejects.toThrow("does not match");
      await expect(instance.ensureProposalArtifact(source, agent.id, id, {kind: "skill", value: {
        ...skill.value, body: "Changed draft",
      }})).rejects.toThrow("does not match");
      await expect(instance.ensureProposalArtifact({...source, proposalId: "other"}, agent.id, id, skill))
        .rejects.toThrow("already in use");
      await expect(instance.ensureProposalArtifact({...source, workspaceId: other.workspaceId}, agent.id,
        crypto.randomUUID(), skill)).rejects.toThrow("dedicated workspace");
      await instance.deleteAgentRecord(agent.id);
      await expect(instance.ensureProposalArtifact({...source, proposalId: "new"}, agent.id,
        crypto.randomUUID(), skill)).rejects.toThrow("dedicated workspace");
    });
    // A prior receipt remains recoverable even after its agent is deleted.
    expect(await user.ensureProposalArtifact(source, agent.id, id, skill)).toEqual(receipt);
  });

  it.each(["pause", "pause/resume", "context", "delete"])("preparation rejects stale lookup after %s", async change => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    await prepare(agent, skill, false);
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      const get = impl.users.get.bind(impl.users);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      vi.spyOn(impl.users, "get").mockImplementation((...args) => {
        const user = get(...args);
        return new Proxy(user, {get(target, key) {
          if (key === "getAgent") return async (id: string) => {
            const record = await user.getAgent(id);
            entered.resolve();
            await release.promise;
            return record;
          };
          return Reflect.get(target, key, target);
        }});
      });
      const preparation = impl.prepareAgentProposal(1, {reason: "Repeat", draft: skill});
      const rejected = expect(preparation).rejects.toThrow();
      await entered.promise;
      if (change === "pause" || change === "pause/resume") await impl.setAutomationPaused(true);
      if (change === "pause/resume") await impl.setAutomationPaused(false);
      if (change === "context") impl.storage.chatContext.put({chatId: 1, agentId: "other"});
      if (change === "delete") impl.storage.chatMeta.delete(1);
      release.resolve();
      await rejected;
      expect([...impl.storage.chats.list()]).toEqual([]);
    });
    expect(await api.listSkills(agent.id)).toEqual([]);
  });

  it("rejects non-bot, spawner, group, deleted, and foreign agent targets", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    const other = await api.createAgent("Other bot", "", "", null);
    const group = await api.createGroup("Group", [agent.id, other.id]);
    using groupWorkspace = await api.openGadget(group.workspaceId);
    await groupWorkspace.getMetadata();
    await prepare(agent, skill, false);
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      for (const context of [{chatId: 1}, {chatId: 1, agentId: "deleted"}, {chatId: 1, agentId: other.id}]) {
        impl.storage.chatContext.put(context);
        await expect(impl.prepareAgentProposal(1, {reason: "Repeat", draft: skill})).rejects.toThrow();
      }
      impl.storage.chatContext.put({chatId: 1, agentId: agent.id, spawnerConfig: {
        displayName: "Spawned", modelId: null, env: {},
      }});
      await expect(impl.prepareAgentProposal(1, {reason: "Repeat", draft: skill})).rejects.toThrow("live bot chat");
    });
    await runInDurableObject(workspace(group.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      impl.storage.chatMeta.put({id: 1, title: "Group", started: new Date(), lastActive: new Date()});
      impl.storage.chatContext.put({chatId: 1, agentId: agent.id});
      await expect(impl.prepareAgentProposal(1, {reason: "Repeat", draft: skill})).rejects.toThrow("dedicated workspace");
    });
  });

  it("rejects semantically invalid drafts without persisting anything", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    await prepare(agent, skill, false);
    const drafts: AgentProposalDraft[] = [
      {kind: "skill", value: {...skill.value, name: " "}},
      {kind: "skill", value: {...skill.value, description: ""}},
      {kind: "skill", value: {...skill.value, body: "x".repeat(32_001)}},
      ...([
        {kind: "interval", everyMs: 59_999}, {kind: "interval", everyMs: Infinity},
        {kind: "once", timeZone: "UTC", fireAt: 0},
        {kind: "calendar", timeZone: "Invalid/Zone", freq: "daily", hour: 9, minute: 0},
        {kind: "calendar", timeZone: "UTC", freq: "daily", hour: 24, minute: 0},
        {kind: "calendar", timeZone: "UTC", freq: "weekly", hour: 9, minute: 0, byDay: []},
        {kind: "calendar", timeZone: "UTC", freq: "hourly", hour: 9, minute: 0},
        {kind: "calendar", timeZone: "UTC", freq: "daily", hour: 9, minute: 60},
        {kind: "slack", channelId: "", matchKind: "mention"},
        {kind: "slack", channelId: "channel", matchKind: "keyword", keyword: ""},
        {kind: "github", owner: "owner", repo: "repo", events: []},
      ] satisfies AgentRoutineSchedule[]).map(schedule => ({kind: "routine" as const, value: {...routine.value, schedule}})),
    ];
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      for (const draft of drafts) await expect(impl.prepareAgentProposal(1, {reason: "Repeat", draft})).rejects.toThrow();
      await expect(impl.prepareAgentProposal(1, {reason: " ", draft: skill})).rejects.toThrow();
      expect([...impl.storage.chats.list()]).toEqual([]);
    });
  });
});
