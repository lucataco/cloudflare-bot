import { describe, it, expect } from "vitest";
import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {headers: {Upgrade: "websocket"}}));
  response.webSocket!.accept();
  return newWebSocketRpcSession<PublicApi>(response.webSocket!);
}
async function account(api: RpcStub<PublicApi>) {
  const name = "bot" + crypto.randomUUID().replaceAll("-", "");
  const token = await api.createAccount(name, name, new Uint8Array([1, 2, 3]));
  if (!token) throw new Error("Account creation failed");
  return api.authenticate(token);
}

describe("portable bot lifecycle", () => {
  it("copies skills, paused routines and avatar, excluding memory, grants and hidden state", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const source = await api.createAgent("Research", "Analyst", "Use sources", null,
      {url: "https://example.com/avatar.png"}, [123], false);
    await api.updateAgent(source.id, {hidden: true});
    await api.addMemory(source.id, "Private memory");
    const skill = await api.createSkill(source.id, "Citations", "Cite sources", "Include links");
    const routine = await api.createRoutine(source.id, "Morning", "Summarize", {kind: "interval", everyMs: 60000});
    const copy = await api.duplicateAgent(source.id);
    expect(copy.workspaceId).not.toBe(source.workspaceId);
    expect(copy).toMatchObject({name: "Research (copy)", description: "Use sources", defaultBindings: [], notifyOnUpdates: false, avatar: source.avatar});
    expect(copy.hidden).not.toBe(true);
    expect(await api.listMemory(copy.id)).toEqual([]);
    const skills = await api.listSkills(copy.id);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({name: skill.name, body: skill.body});
    expect(skills[0].id).not.toBe(skill.id);
    const routines = await api.listRoutines(copy.id);
    expect(routines).toHaveLength(1);
    expect(routines[0]).toMatchObject({name: routine.name, paused: true, schedule: routine.schedule});
    expect(routines[0].id).not.toBe(routine.id);
    expect(routines[0].hookId).toBeUndefined();
    expect((await api.listAgents()).find(a => a.id === source.id)?.hidden).toBe(true);
    await api.updateAgent(source.id, {hidden: false, avatar: null});
    expect((await api.listAgents()).find(a => a.id === source.id)?.avatar).toBeUndefined();
  });

  it("publishes through Blueprints, downloads/reimports and installs into a separate owner", async () => {
    using publicApi = await connect();
    using owner = await account(publicApi);
    using recipient = await account(publicApi);
    const bot = await owner.createAgent("Writer", "Editor", "Use plain words", null);
    await owner.createSkill(bot.id, "Edit", "Make it concise", "Remove jargon");
    await owner.createRoutine(bot.id, "Weekly", "Draft a report", {kind: "interval", everyMs: 604800000});
    await owner.addMemory(bot.id, "NEVER PUBLISH THIS");
    const id = await owner.publishAgentBlueprint(bot.id);
    const shared = await publicApi.getBlueprint(id);
    expect(shared?.metadata.bot).toMatchObject({name: "Writer", skills: [{body: "Remove jargon"}], pluginIds: []});
    expect(JSON.stringify(shared)).not.toContain("NEVER PUBLISH THIS");
    expect(shared?.metadata.bot).not.toHaveProperty("workspaceId");
    const copy = await recipient.newAgentFromBlueprint(id, null);
    expect(copy.workspaceId).not.toBe(bot.workspaceId);
    expect(copy.defaultBindings).toEqual([]);
    expect(await recipient.listMemory(copy.id)).toEqual([]);
    expect((await recipient.listRoutines(copy.id))[0].paused).toBe(true);
    const archive = await publicApi.downloadBlueprint(id);
    const importedId = await recipient.importBlueprint(archive);
    expect((await publicApi.getBlueprint(importedId))?.metadata.bot).toEqual(shared?.metadata.bot);
    await owner.removeBlueprintFromLibrary(id);
    expect(await publicApi.getBlueprint(id)).toBeNull();
    expect((await recipient.listAgents()).some(a => a.id === copy.id)).toBe(true);
  });
});
