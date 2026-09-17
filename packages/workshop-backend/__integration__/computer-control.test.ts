import { runInDurableObject } from "cloudflare:test";
import { exports, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi, AuthenticatedApi, AiToolCall } from "@gadgets/workshop-shared/api";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { makeStoredAssistantMessage, rehydrateStoredAssistantMessage } from "../src/agent";
import { zeroUsage } from "../src/ai-invoke";
import { validateChatHistory } from "./worker";
import type { OverseerDurableObject } from "../src/overseer";
import { ComputerSessionImpl } from "../src/computer-session";
import { UserDurableObject } from "../src/user";
import { launch, type Browser, type Page } from "@cloudflare/puppeteer";
import { afterEach, describe, expect, it, vi } from "vitest";

// Only Chromium is replaced; Cap'n Web, native RPC, storage and policy checks remain real.
vi.mock("@cloudflare/puppeteer", () => ({ launch: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(launch).mockReset();
});

async function connect() {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }));
  const socket = response.webSocket;
  if (!socket) throw new Error("Expected WebSocket response");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function account(api: RpcStub<PublicApi>) {
  const name = "browser" + crypto.randomUUID().replaceAll("-", "");
  const token = await api.createAccount(name, name, new Uint8Array([1, 2, 3]));
  if (!token) throw new Error("Account creation failed");
  return api.authenticate(token);
}

async function bot(api: RpcStub<AuthenticatedApi>) {
  return api.createAgent("Browser bot", "", "", null);
}

function workspace(id: string) {
  return exports.OverseerDurableObject.get(exports.OverseerDurableObject.idFromString(id));
}

function gateAgentLookup(impl: OverseerDurableObject["impl"]) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const get = impl.users.get.bind(impl.users);
  // Gate the outbound lookup in the calling DO's context; deferred promises cannot cross DOs.
  const lookup = vi.fn(async (user: DurableObjectStub<UserDurableObject>, id: string) => {
    entered.resolve();
    await release.promise;
    return user.getAgent(id);
  });
  vi.spyOn(impl.users, "get").mockImplementation((...args) => {
    const user = get(...args);
    return new Proxy(user, {
      get(target, key) {
        if (key === "getAgent") return (id: string) => lookup(user, id);
        return Reflect.get(target, key, target);
      },
    });
  });
  return { entered: entered.promise, release: () => release.resolve(), lookup };
}

describe("explicit browser authority", () => {
  it('keeps shell/files disabled until explicitly granted and scopes runtime keys to each bot', async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const first = await bot(api);
    const second = await bot(api);
    using firstWorkspace = await api.openGadget(first.workspaceId);
    using secondWorkspace = await api.openGadget(second.workspaceId);
    await firstWorkspace.setComputerControl(first.id, 'human');
    await secondWorkspace.setComputerControl(second.id, 'human');
    using firstSession = await firstWorkspace.getComputerSession(first.id);
    using secondSession = await secondWorkspace.getComputerSession(second.id);
    expect(await firstWorkspace.getComputerWorkspaceAccess(first.id)).toEqual({ available: true, enabled: false });
    await expect(firstSession.workspace({ kind: 'exec', command: 'pwd' })).rejects.toThrow('disabled');
    await firstWorkspace.setComputerWorkspaceAccess(first.id, true);
    await secondWorkspace.setComputerWorkspaceAccess(second.id, true);
    const a = await firstSession.workspace({ kind: 'exec', command: 'pwd' });
    const b = await secondSession.workspace({ kind: 'exec', command: 'pwd' });
    expect(a.stdout).not.toBe(b.stdout);
    await firstWorkspace.setComputerWorkspaceAccess(first.id, false);
    await expect(firstSession.workspace({ kind: 'read', path: 'file.txt' })).rejects.toThrow('disabled');
    expect(launch).not.toHaveBeenCalled();
  });
  it("round-trips existing browser and memory calls through durable history and generated validators", async () => {
    const calls: AiToolCall[] = [
      { toolCallId: "navigate", toolName: "computerNavigate", input: { url: "https://example.com/page" } },
      { toolCallId: "screenshot", toolName: "computerScreenshot", input: {} },
      { toolCallId: "click", toolName: "computerClick", input: { x: 20, y: 30 } },
      { toolCallId: "type", toolName: "computerType", input: { text: "synthetic input" } },
      { toolCallId: "scroll", toolName: "computerScroll", input: { deltaX: 0, deltaY: 100 } },
      { toolCallId: "key", toolName: "computerKey", input: { key: "Enter" } },
      { toolCallId: "wait", toolName: "computerWait", input: { ms: 250 } },
      { toolCallId: "human", toolName: "computerRequestHuman", input: { reason: "Sign in" } },
      { toolCallId: "state", toolName: "computerGetState", input: {} },
      { toolCallId: "remember", toolName: "memoryWrite", input: { fact: "Synthetic fact" } },
      { toolCallId: "forget-id", toolName: "memoryForget", input: { id: "note-1" } },
      { toolCallId: "forget-fact", toolName: "memoryForget", input: { fact: "Synthetic fact" } },
      { toolCallId: "forget-missing", toolName: "memoryForget", input: {}, isError: true },
      { toolCallId: "denied", toolName: "computerScreenshot", input: {}, error: "Browser is under human control" },
    ];
    const assistant: AssistantMessage = {
      role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "test-model",
      content: calls.map(call => ({ type: "toolCall", id: call.toolCallId, name: call.toolName, arguments: call.input })),
      usage: zeroUsage(), stopReason: "toolUse", timestamp: 1,
    };
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    using owner = await api.openGadget(agent.workspaceId);
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      impl.storage.chatMeta.put({ id: 1, title: "Browser history", started: new Date(), lastActive: new Date() });
      impl.addChatMessages(1, { type: "agent", id: "test-model", name: "Test model" }, [{
        type: "message", message: "Historical browser and memory calls", toolCalls: calls,
        modelData: makeStoredAssistantMessage(assistant),
      }]);
    });
    const validated = validateChatHistory(owner);
    const page = await validated.getChatHistory(1);
    const message = page.messages[0];
    if (message.type !== "message") throw new Error("Expected a chat message");
    expect(message.toolCalls).toEqual(calls);
    expect(message).not.toHaveProperty("modelData");
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const stored = instance["impl"].getChatModelData(1, message.sequence);
      expect(stored).toBeDefined();
      expect(stored!.content.every(block => !("arguments" in block))).toBe(true);
      expect(rehydrateStoredAssistantMessage(stored!, message.toolCalls, 1, message.sequence)).toEqual(assistant);
    });
    expect(await owner.getComputerControl(agent.id)).toBe("disabled");
    expect(launch).not.toHaveBeenCalled();

    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      const stored = [...impl.storage.chats.list()][0];
      if (stored.type !== "message" || !stored.toolCalls) throw new Error("Expected stored tool calls");
      // Simulate a malformed durable record without pretending its input is well-typed.
      Reflect.set(stored.toolCalls[2].input, "x", "not a number");
      impl.storage.chats.put(stored);
    });
    const error = await validated.getChatHistory(1).then(() => null, cause => cause);
    expect(error).toBeInstanceOf(TypeError);
  });

  it.each(["success", "denied", "invalid input", "launch failure"])(
    "native RPC releases incoming browser guards after %s", async outcome => {
      // Dispatch from the real workspace DO, not the test runner's forwarding RPC proxy.
      await runInDurableObject(exports.OverseerDurableObject.getByName(crypto.randomUUID()), async (instance: OverseerDurableObject) => {
        const disposed = vi.fn();
        const check = Object.assign(async () => {
          if (outcome === "denied") throw new Error("guard denied");
        }, { [Symbol.dispose]: disposed });
        const session = instance["impl"].ctx.exports.ComputerSessionImpl.getByName(crypto.randomUUID());
        {
          using guard = new NativeRpcStub(check);
          if (outcome === "success") {
            await session.wait(guard, 0);
          } else if (outcome === "invalid input") {
            const error = await session.navigate(guard, "file:///unsupported").then(() => null, cause => cause);
            expect(error).toMatchObject({ message: "Unsupported browser URL" });
          } else {
            vi.mocked(launch).mockRejectedValueOnce(new Error("test launch failure"));
            using pending = session.screenshot(guard);
            const error = await pending.then(() => null, cause => cause);
            expect(error).toMatchObject({ message: outcome === "denied" ? "guard denied" : "Failed to start Computer" });
          }
        }
        // The originating event is still live. The target can be disposed only after both
        // the sender's using scope and the receiver's automatic parameter ownership end.
        await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
        if (outcome !== "launch failure") expect(launch).not.toHaveBeenCalled();
      });
    });

  it("defaults existing and new workspaces to disabled and rejects agent self-grants", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    using owner = await api.openGadget(agent.workspaceId);
    expect(await owner.getComputerControl(agent.id)).toBe("disabled");
    await expect(owner.computerScreenshot(agent.id)).rejects.toThrow("disabled");
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      await expect(instance["impl"].getComputerSession(agent.id)).rejects.toThrow("disabled");
    });
    await owner.setComputerControl(agent.id, "agent");
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      using session = await instance["impl"].getComputerSession(agent.id);
      expect(await session.getState()).toMatchObject({ agentId: agent.id, currentUrl: null });
      // The real wrapper exposes browser operations only, never grant/control setters.
      await expect(Reflect.get(session, "setComputerControl")("agent")).rejects.toThrow();
    });
  });

  it("rejects another agent workspace and a foreign owner, even with an enabled browser", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    using foreignApi = await account(publicApi);
    const agent = await bot(api);
    const other = await bot(api);
    const foreign = await bot(foreignApi);
    const group = await api.createGroup("Group", [agent.id, other.id]);
    using owner = await api.openGadget(agent.workspaceId);
    using otherWorkspace = await api.openGadget(other.workspaceId);
    using foreignWorkspace = await foreignApi.openGadget(foreign.workspaceId);
    using groupWorkspace = await api.openGadget(group.workspaceId);
    await owner.setComputerControl(agent.id, "agent");
    for (const wrong of [otherWorkspace, foreignWorkspace, groupWorkspace]) {
      await expect(wrong.getComputerControl(agent.id)).rejects.toThrow("dedicated workspace");
      await expect(wrong.setComputerControl(agent.id, "human")).rejects.toThrow("dedicated workspace");
      await expect(wrong.computerScreenshot(agent.id)).rejects.toThrow("dedicated workspace");
    }
    const profile = await foreignApi.whoami();
    await owner.addCollaborator(profile.id, "build");
    using collaborator = await foreignApi.openGadget(agent.workspaceId);
    await expect(collaborator.getComputerControl(agent.id)).rejects.toThrow("owner-only");
    await expect(collaborator.setComputerControl(agent.id, "agent")).rejects.toThrow("owner-only");
    await expect(collaborator.computerScreenshot(agent.id)).rejects.toThrow("owner-only");
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      await expect(instance["impl"].assertComputerWorkspace("foreign-owner", agent.id))
        .rejects.toThrow("owner-only");
    });
  });

  it("denies sensitive agent reads before reaching the native browser, but permits human control", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    using owner = await api.openGadget(agent.workspaceId);
    await owner.setComputerControl(agent.id, "agent");
    const screenshots = vi.spyOn(ComputerSessionImpl.prototype, "screenshot");
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      using stale = await impl.getComputerSession(agent.id);
      impl.storage.prohibitAllSharing.put(true);
      await expect(impl.getComputerSession(agent.id)).rejects.toThrow("sensitive data");
      await expect(stale.screenshot()).rejects.toThrow("sensitive data");
      await expect(stale.getState()).rejects.toThrow("sensitive data");
    });
    expect(screenshots).not.toHaveBeenCalled();
    await expect(owner.setComputerControl(agent.id, "agent")).rejects.toThrow("sensitive data");
    await owner.setComputerControl(agent.id, "human");
    using manual = await owner.getComputerSession(agent.id);
    await manual.wait(-10);
    expect((await manual.getState()).agentId).toBe(agent.id);
  });

  it("human takeover excludes all stale agent operations until an explicit owner resume", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    using owner = await api.openGadget(agent.workspaceId);
    await owner.setComputerControl(agent.id, "agent");
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      using stale = await impl.getComputerSession(agent.id);
      impl.requestComputerHumanTakeover(0, "Sign in", "https://user:secret@example.com/login?token=secret");
      expect(impl.storage.computerControl.get()?.mode).toBe("human");
      const operations = [() => stale.navigate("about:blank"), () => stale.screenshot(),
        () => stale.click(1, 1), () => stale.type("secret"), () => stale.scroll(1, 1),
        () => stale.key("Enter"), () => stale.wait(0), () => stale.getState(), () => stale.close()];
      for (const operation of operations) await expect(operation()).rejects.toThrow("human control");
      expect(impl.consumeCapturedComputerHumanTakeovers(0)).toMatchObject([
        { currentUrl: "https://example.com/login", state: "pending" },
      ]);
    });
    expect(await owner.getComputerControl(agent.id)).toBe("human");
    await owner.setComputerControl(agent.id, "agent");
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      using session = await instance["impl"].getComputerSession(agent.id);
      await session.wait(0);
    });
  });

  it("old owner stubs obey latest mode and close is not revocation", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    using owner = await api.openGadget(agent.workspaceId);
    await owner.setComputerControl(agent.id, "human");
    using session = await owner.getComputerSession(agent.id);
    await session.close();
    expect(await owner.getComputerControl(agent.id)).toBe("human");
    await owner.setComputerControl(agent.id, "agent");
    await expect(session.click(1, 1)).rejects.toThrow("human before manual");
    await owner.setComputerControl(agent.id, "disabled");
    await expect(session.getState()).rejects.toThrow("disabled");
  });

  it("permits manual owner navigation through the real wrapper and native RPC guard", async () => {
    const click = vi.fn(async () => {});
    const page = {
      goto: vi.fn(async () => null), url: () => "about:blank",
      setViewport: vi.fn(async () => {}), setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn(),
      cookies: vi.fn(async () => []), mouse: { click },
      screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
    } as Page;
    const close = vi.fn(async () => {});
    vi.mocked(launch).mockResolvedValue({ connected: true, newPage: async () => page, close } as Browser);
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    using owner = await api.openGadget(agent.workspaceId);
    await owner.setComputerControl(agent.id, "human");
    using session = await owner.getComputerSession(agent.id);
    await session.navigate("about:blank");
    await session.click(20, 30);
    expect(click).toHaveBeenCalledWith(20, 30);
    expect((await session.getState()).currentUrl).toBe("about:blank");
    expect((await owner.computerScreenshot(agent.id)).length).toBeGreaterThan(0);
    await owner.setComputerControl(agent.id, "disabled");
    expect(close).toHaveBeenCalledOnce();
  });

  it("rechecks after a native await", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    using owner = await api.openGadget(agent.workspaceId);
    await owner.setComputerControl(agent.id, "agent");
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      using stale = await impl.getComputerSession(agent.id);
      let checks = 0;
      const assert = impl.assertComputerAccess.bind(impl);
      vi.spyOn(impl, "assertComputerAccess").mockImplementation((...args) => {
        assert(...args);
        if (++checks === 6) {
          const control = impl.storage.computerControl.get()!;
          impl.storage.computerControl.put({ ...control, mode: "disabled", revision: control.revision + 1 });
        }
      });
      await expect(stale.wait(10)).rejects.toThrow("control changed");
      await expect(stale.getState()).rejects.toThrow("disabled");
    });
  });

  it("rejects session acquisition parked on the User DO across pause/resume before a click", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    using owner = await api.openGadget(agent.workspaceId);
    await owner.setComputerControl(agent.id, "agent");
    const click = vi.spyOn(ComputerSessionImpl.prototype, "click").mockResolvedValue(undefined);
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      const revision = impl.storage.computerControl.get()?.revision;
      const gate = gateAgentLookup(impl);
      const action = (async () => {
        using session = await impl.getComputerSession(agent.id);
        await session.click(20, 30);
      })();
      const rejected = expect(action).rejects.toThrow("Workspace automation is paused");
      await gate.entered;
      await impl.setAutomationPaused(true);
      await impl.setAutomationPaused(false);
      gate.release();
      await rejected;
      expect(impl.storage.computerControl.get()?.revision).toBe(revision);
      expect(impl.storage.automationPaused.get()).toBe(false);
      expect(click).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    });
  });

  it.each(["during lookup", "at entry"])("leaves browser continuation pending when paused %s", async when => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await bot(api);
    const profile = await api.whoami();
    using owner = await api.openGadget(agent.workspaceId);
    await owner.setComputerControl(agent.id, "agent");
    await runInDurableObject(workspace(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      using closed = new NativeRpcStub(() => {});
      using client = await instance.open(impl.ownerId!, profile.id, closed);
      const model = { type: "agent" as const, id: "test-model", name: "Test model" };
      impl.storage.chatMeta.put({ id: 1, title: "Browser", started: new Date(), lastActive: new Date() });
      impl.addChatMessages(1, model, [{ type: "computerHumanTakeover", requestId: "1:takeover",
        reason: "Sign in", currentUrl: "about:blank", state: "pending" }]);
      const start = vi.spyOn(impl, "startAgent").mockImplementation(() => {});
      const context = vi.spyOn(UserDurableObject.prototype, "getChatContext").mockResolvedValue({
        profile, aiModel: { profile: model, config: { provider: "anthropic", model: "test-model", apiToken: "unused" } },
      });
      const gate = gateAgentLookup(impl);
      if (when === "at entry") await client.setAutomationPaused(true);
      const approval = client.approveComputerHumanTakeover("1:takeover");
      const rejected = expect(approval).rejects.toThrow("Workspace automation is paused");
      if (when === "during lookup") {
        await gate.entered;
        await client.setAutomationPaused(true);
        await client.setAutomationPaused(false);
      }
      gate.release();
      await rejected;
      expect(gate.lookup).toHaveBeenCalledTimes(when === "at entry" ? 0 : 1);
      expect(context).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect([...impl.storage.chats.list()]).toMatchObject([{ state: "pending" }]);
      expect(impl.getChatMetaOrThrow(1).activeAgent).toBeUndefined();

      // Only a new, explicit continuation after resume may start automation.
      if (when === "at entry") await client.setAutomationPaused(false);
      await client.approveComputerHumanTakeover("1:takeover");
      expect(start).toHaveBeenCalledOnce();
      expect([...impl.storage.chats.list()]).toMatchObject([{ state: "approved" }]);
    });
  });
});
