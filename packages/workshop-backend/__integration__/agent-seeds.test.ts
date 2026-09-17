import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";

async function connect() {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {headers: {Upgrade: "websocket"}}));
  response.webSocket!.accept();
  return newWebSocketRpcSession<PublicApi>(response.webSocket!);
}
const seed = {key: "research", name: "Riley", title: "Researcher", description: "Cite sources",
  skills: [{name: "Sources", description: "Check", body: "Check sources"}],
  routines: [{name: "Daily", prompt: "Research", schedule: {kind: "interval", everyMs: 86400000}}]};
const yaml = JSON.stringify({version: 1, agents: [seed]});

describe("create-once agent seeding", () => {
  it("serializes concurrent imports and preserves edits and deletions while isolating owners", async () => {
    using publicApi = await connect();
    const name = "seed" + crypto.randomUUID().replaceAll("-", "");
    const token = await publicApi.createAccount(name, name, new Uint8Array([1, 2, 3]));
    using owner = await publicApi.authenticate(token!);
    const results = await Promise.all([owner.seedAgents(yaml), owner.seedAgents(yaml)]);
    const [bot] = results.flatMap(result => result.created);
    expect(results.flatMap(result => result.created)).toHaveLength(1);
    expect(results.flatMap(result => result.skipped)).toEqual([seed.key]);
    expect(bot.defaultBindings).toEqual([]);
    expect((await owner.listRoutines(bot.id))[0].paused).toBe(true);
    await owner.updateAgent(bot.id, {description: "My edit"});
    await owner.seedAgents(yaml);
    expect((await owner.listAgents())[0].description).toBe("My edit");
    await owner.deleteAgent(bot.id);
    expect(await owner.seedAgents(yaml)).toEqual({created: [], skipped: [seed.key]});
    expect(await owner.listAgents()).toEqual([]);
    const otherName = "seed" + crypto.randomUUID().replaceAll("-", "");
    using other = await publicApi.authenticate((await publicApi.createAccount(otherName, otherName, new Uint8Array([4])))!);
    expect((await other.seedAgents(yaml)).created).toHaveLength(1);
  });
  it("rolls back the whole import when any model is unavailable", async () => {
    using publicApi = await connect();
    const name = "seed" + crypto.randomUUID().replaceAll("-", "");
    using owner = await publicApi.authenticate((await publicApi.createAccount(name, name, new Uint8Array([1])))!);
    await expect(owner.seedAgents(JSON.stringify({version: 1, agents: [seed,
      {...seed, key: "second", modelId: "missing"}]}))).rejects.toThrow("unavailable model");
    expect(await owner.listAgents()).toEqual([]);
    expect((await owner.seedAgents(yaml)).created).toHaveLength(1);
  });
});
