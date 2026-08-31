import { describe, it, expect, beforeAll } from "vitest";
import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);

function username(prefix: string): string {
  return "a" + prefix.replace(/[^a-zA-Z0-9]/g, "") + crypto.randomUUID().replaceAll("-", "");
}

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }));

  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");

  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

describe("Agent profile persistence", () => {
  it("persists description and notifyOnUpdates through update+list cycle", async () => {
    using publicApi = await connect();
    const name = username("agenttest");
    const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
    if (token === null) throw new Error(`Failed to create ${name}.`);

    using api = await publicApi.authenticate(token);

    const created = await api.createAgent(
      "Test Agent",
      "Test Title",
      "Original description",
      null,
      undefined,
      undefined,
      true
    );

    expect(created.description).toBe("Original description");
    expect(created.notifyOnUpdates).toBe(true);

    const updated = await api.updateAgent(created.id, {
      description: "QA-EDIT-MARKER",
      notifyOnUpdates: false,
    });

    expect(updated.description).toBe("QA-EDIT-MARKER");
    expect(updated.notifyOnUpdates).toBe(false);

    const agents = await api.listAgents();
    const found = agents.find((a) => a.id === created.id);

    expect(found).toBeDefined();
    expect(found?.description).toBe("QA-EDIT-MARKER");
    expect(found?.notifyOnUpdates).toBe(false);

    await api.deleteAgent(created.id);
  });

  it("persists empty description and false notifyOnUpdates", async () => {
    using publicApi = await connect();
    const name = username("agenttest2");
    const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
    if (token === null) throw new Error(`Failed to create ${name}.`);

    using api = await publicApi.authenticate(token);

    const created = await api.createAgent(
      "Test Agent 2",
      "Test Title 2",
      "Original description",
      null,
      undefined,
      undefined,
      true
    );

    const updated = await api.updateAgent(created.id, {
      description: "",
      notifyOnUpdates: false,
    });

    expect(updated.description).toBe("");
    expect(updated.notifyOnUpdates).toBe(false);

    const agents = await api.listAgents();
    const found = agents.find((a) => a.id === created.id);

    expect(found).toBeDefined();
    expect(found?.description).toBe("");
    expect(found?.notifyOnUpdates).toBe(false);

    await api.deleteAgent(created.id);
  });
});
