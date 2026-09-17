import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcStub, RpcTarget } from "capnweb";
import type {
  AttentionSubscriber, AuthenticatedApi, Overseer, PublicApi,
} from "@gadgets/workshop-shared/api";
import type { WorkspaceAttentionSnapshot } from "../src/attention";
import type { OverseerDurableObject } from "../src/overseer";
import type { UserDurableObject } from "../src/user";
import { putAction } from "../__tests__/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Impl = OverseerDurableObject["impl"];
type Source = DurableObjectStub<OverseerDurableObject>;
const touched: DurableObjectStub[] = [];
let now: number;

beforeEach(() => {
  // Deadlines stay ahead of workerd's real clock. Drain explicitly, without fake timers or push.
  now = Date.now() + 3_600_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Attention integration forbids network push/provider calls"));
});

afterEach(async () => {
  try {
    for (const stub of touched.splice(0)) {
      await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
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

async function account(publicApi: RpcStub<PublicApi>) {
  const name = "attention" + crypto.randomUUID().replaceAll("-", "");
  const token = await publicApi.createAccount(name, name, new Uint8Array([1, 2, 3]));
  if (!token) throw new Error("Account creation failed");
  return publicApi.authenticate(token);
}

async function expectWireRejection(token: string | undefined, method: string, args: (string | number)[], message: string) {
  // Read the raw Cap'n Web batch rejection: the installed client reports a rejected future twice
  // under vitest even when awaited. This still exercises the real public root and validators.
  const calls: unknown[] = [];
  if (token !== undefined) calls.push(["push", ["pipeline", 0, ["authenticate"], [token]]]);
  const target = calls.length;
  calls.push(["push", ["pipeline", target, [method], args]], ["pull", target + 1]);
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    method: "POST", body: calls.map(call => JSON.stringify(call)).join("\n"),
  }));
  expect(response.status).toBe(200);
  const messages = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  expect(messages).toContainEqual(["reject", target + 1,
    ["error", expect.any(String), expect.stringContaining(message)]]);
}

async function userFor(api: RpcStub<AuthenticatedApi>) {
  const profile = await api.whoami();
  const user = exports.UserDurableObject.get(exports.UserDurableObject.idFromName(profile.id));
  touched.push(user);
  return user;
}

async function sourceFor(client: RpcStub<Overseer>) {
  const { id } = await client.getMetadata();
  const source = exports.OverseerDurableObject.get(exports.OverseerDurableObject.idFromString(id));
  touched.push(source);
  return source;
}

function seedChat(impl: Impl, chatId = 1) {
  const timestamp = new Date(1_700_000_000_000 + chatId);
  impl.storage.chatMeta.put({ id: chatId, title: "Private chat", started: timestamp, lastActive: timestamp });
  impl.storage.taskRuns.put({ id: `task-${chatId}`, chatId, sourceSequence: 0,
    source: { type: "prompt" }, startedAt: timestamp, updatedAt: timestamp,
    attempt: 1, lastSequence: 1, status: "finished", reason: "model_stop" });
  impl.storage.chats.put({ chatId, sequence: 1, timestamp,
    author: { type: "agent", id: "model", name: "Private model name" },
    type: "connectionRequest", requestId: `${chatId}:private-request`, vendorId: "private-vendor",
    vendorName: "Private service", reason: "Private rationale", resourceUrl: "https://private.invalid/secret",
    state: "pending" });
}

function bootstrap(impl: Impl) {
  for (let i = 0; i < 20 && !impl.attentionSnapshot()?.complete; ++i) {
    now = Math.max(now + 1_001, impl.storage.attentionProgress.get()!.bootstrapAt!);
    impl.bootstrapAttention(now);
  }
  expect(impl.attentionSnapshot()?.complete).toBe(true);
}

async function deliver(impl: Impl) {
  now = Math.max(now + 1_001, impl.storage.attentionProgress.get()!.deliveryAt ?? now);
  await impl.deliverAttention(now);
}

async function drain(source: Source) {
  return runInDurableObject(source, async (instance: OverseerDurableObject) => {
    const impl = instance["impl"];
    await instance.initializeAttention(impl.ownerId!);
    bootstrap(impl);
    await deliver(impl);
    expect(impl.storage.attentionProgress.get()?.dirtyRevision).toBeUndefined();
    return impl.attentionSnapshot()!;
  });
}

describe("attention across real Overseer and User Durable Objects", () => {
  it("backfills canonical run/card/action storage through the owner bootstrap RPC, without notifying history", async () => {
    const user = exports.UserDurableObject.getByName(crypto.randomUUID());
    const source = exports.OverseerDurableObject.getByName(crypto.randomUUID());
    touched.push(user, source);
    const workspaceId = source.id.toString();
    await user.newGadget(workspaceId, "Owner workspace");
    await runInDurableObject(source, (instance: OverseerDurableObject, state) => {
      const impl = instance["impl"];
      expect(state.id.toString()).not.toBe(user.id.toString());
      seedChat(impl);
      putAction(impl.storage, 1);
      expect(impl.attentionSnapshot()).toBeUndefined();
      // Legacy owned workspace fixture; both the registry and persisted owner are real.
      impl.storage.version.put(3);
      impl.storage.ownerId.put(user.id.toString());
      impl.ownerId = user.id.toString();
    });
    expect(await user.listAttention()).toMatchObject({ entries: [], catchingUp: true, unseen: 0 });
    await runInDurableObject(user, (instance: UserDurableObject) => instance.alarm());
    now += 1_001;
    // User DO -> Overseer.initializeAttention(ownerId), without an alarm RPC shortcut.
    await runInDurableObject(user, (instance: UserDurableObject) => instance.alarm());
    await runInDurableObject(source, (instance: OverseerDurableObject) => {
      expect(instance["impl"].attentionSnapshot()).toMatchObject({ complete: false, entries: [] });
    });
    const snapshot = await drain(source);
    expect(snapshot.entries).toHaveLength(3);
    expect(snapshot.entries.every(entry => !entry.notify)).toBe(true);
    const page = await user.listAttention();
    expect(page).toMatchObject({ catchingUp: false, unseen: 3, truncated: false });
    expect(page.entries.map(entry => entry.kind).toSorted()).toEqual(["action", "connection", "run"]);
    for (const entry of snapshot.entries) {
      expect(page.entries.find(item => item.sourceId === entry.sourceId)).toMatchObject({
        id: JSON.stringify([workspaceId, entry.sourceId]), workspaceId,
        version: entry.version, kind: entry.kind, state: entry.state, seen: false,
        workspaceTitle: "Owner workspace", updatedAt: entry.updatedAt,
      });
    }
    expect(JSON.stringify(page)).not.toMatch(/Private|private.invalid|private-request/);
    expect(await user.getPushSettings()).toEqual({ available: false, devices: [] });
    await runInDurableObject(user, (instance: UserDurableObject, state) => {
      expect([...instance["storage"].attentionBootstrapJobs.list()]).toEqual([]);
      expect([...instance["storage"].pushJobs.list()]).toEqual([]);
      return expect(state.storage.getAlarm()).resolves.toBeNull();
    });
  });

  it("reads and acknowledges only the authenticated owner's exact source versions over browser Cap'n Web", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    using foreignApi = await account(publicApi);
    using client = await api.newGadget();
    const source = await sourceFor(client);
    const owner = await userFor(api);
    await userFor(foreignApi);
    await runInDurableObject(source, (instance: OverseerDurableObject) => {
      expect(instance["impl"].ownerId).toBe(owner.id.toString());
      seedChat(instance["impl"]);
      putAction(instance["impl"].storage, 1);
    });
    const snapshot = await drain(source);
    const page = await api.listAttention();
    expect(page.entries).toHaveLength(3);
    expect(page.unseen).toBe(3);
    const item = page.entries.find(entry => entry.kind === "action")!;
    expect(item).toMatchObject({ id: JSON.stringify([source.id.toString(), "action:1"]), seen: false });
    expect(item.updatedAt).toBeInstanceOf(Date);
    expect(snapshot.entries.every(entry => entry.notify)).toBe(true);
    expect((await api.listAttention()).unseen).toBe(3); // A read is not an acknowledgement.
    await foreignApi.markAttentionSeen(item.id, item.version);
    expect((await foreignApi.listAttention()).entries).toEqual([]);
    expect((await api.listAttention()).unseen).toBe(3);
    await api.markAttentionSeen(item.id, item.version - 1);
    expect((await api.listAttention()).unseen).toBe(3);
    await api.markAttentionSeen(item.id, item.version);
    expect((await api.listAttention()).entries.find(entry => entry.id === item.id)?.seen).toBe(true);

    // These methods take cursors/source IDs, never a caller-selected owner. Exercise the wire,
    // not just TS signatures; neither the public root nor the browser can call the receiver.
    const token = await publicApi.login((await foreignApi.whoami()).id, new Uint8Array([1, 2, 3]));
    if (!token) throw new Error("Expected foreign account token");
    await expectWireRejection(undefined, "listAttention", [], "'listAttention' is not a function");
    await expectWireRejection(undefined, "markAttentionSeen", [item.id, item.version], "'markAttentionSeen' is not a function");
    await expectWireRejection(undefined, "subscribeAttention", [], "'subscribeAttention' is not a function");
    expect(await Reflect.get(api, "syncWorkspaceAttention")).toBeUndefined();
    await expectWireRejection(token, "listAttention", [owner.id.toString()], "expected union, got string");
    await expectWireRejection(token, "markAttentionSeen", [owner.id.toString(), item.id, item.version], "expected number, got string");
    expect((await foreignApi.listAttention()).entries).toEqual([]);
    expect((await api.listAttention()).unseen).toBe(2);
    expect((await api.listAttention(item.order)).entries.every(entry => entry.order < item.order)).toBe(true);
  });

  it("retries a lost ACK after the real receiver committed, preserving identity, version, order and seen state", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    using client = await api.newGadget();
    const source = await sourceFor(client);
    await userFor(api);
    const seen = await runInDurableObject(source, async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      putAction(impl.storage, 1);
      bootstrap(impl);
      const get = impl.users.get.bind(impl.users);
      const owner = get(impl.users.idFromString(impl.ownerId!));
      const batches: WorkspaceAttentionSnapshot[] = [];
      const transport = vi.spyOn(impl.users, "get").mockImplementation((...args) => {
        const receiver = get(...args);
        return new Proxy(receiver, { get(target, key) {
          if (key === "syncWorkspaceAttention") return async (...params: Parameters<UserDurableObject["syncWorkspaceAttention"]>) => {
            batches.push(params[1]);
            await receiver.syncWorkspaceAttention(...params);
            if (batches.length === 1) throw new Error("attention test: receiver committed but ACK was lost");
          };
          return Reflect.get(target, key, target);
        } });
      });
      try {
        await deliver(impl);
        expect(impl.storage.attentionProgress.get()).toMatchObject({ failures: 1,
          dirtyRevision: batches[0].revision, deliveryAt: now + 60_000 });
        const item = (await owner.listAttention()).entries[0];
        await owner.markAttentionSeen(item.id, item.version);
        const acknowledged = (await owner.listAttention()).entries[0];
        expect(acknowledged.seen).toBe(true);
        await impl.deliverAttention(impl.storage.attentionProgress.get()!.deliveryAt! - 1);
        expect(batches).toHaveLength(1);
        await deliver(impl);
        expect(batches).toHaveLength(2);
        expect(batches[1]).toEqual(batches[0]);
        expect(impl.storage.attentionProgress.get()).toMatchObject({ failures: 0, dirtyRevision: undefined });
        await owner.syncWorkspaceAttention(source.id.toString(), batches[0]);
        expect((await owner.listAttention()).entries).toEqual([acknowledged]);
        return acknowledged;
      } finally { transport.mockRestore(); }
    });
    expect(await api.listAttention()).toMatchObject({ entries: [seen], unseen: 0 });
  });

  it("rejects unowned receiver delivery and keeps shared builders out of the owner's inbox and source authority", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    using builderApi = await account(publicApi);
    using client = await api.newGadget();
    const source = await sourceFor(client);
    const owner = await userFor(api);
    const builder = await userFor(builderApi);
    await runInDurableObject(source, (instance: OverseerDurableObject) => putAction(instance["impl"].storage, 1));
    const snapshot = await drain(source);
    const item = (await api.listAttention()).entries[0];
    await builder.syncWorkspaceAttention(source.id.toString(), snapshot);
    expect((await builder.listAttention()).entries).toEqual([]);
    const profile = await builderApi.whoami();
    await client.addCollaborator(profile.id, "build");
    using shared = await builderApi.openGadget(source.id.toString());
    expect((await shared.getMetadata()).id).toBe(source.id.toString());
    expect(await builder.getGadget(source.id.toString())).toMatchObject({ owner: await api.whoami(), role: "build" });
    await builder.syncWorkspaceAttention(source.id.toString(), snapshot);
    await runInDurableObject(builder, (instance: UserDurableObject) => instance.alarm());
    now += 1_001;
    await runInDurableObject(builder, (instance: UserDurableObject) => instance.alarm());
    expect((await builderApi.listAttention()).entries).toEqual([]);
    await runInDurableObject(builder, (instance: UserDurableObject) => {
      expect([...instance["storage"].attentionReceipts.list()]).toEqual([]);
      expect([...instance["storage"].attentionBootstrapJobs.list()]).toEqual([]);
    });
    await runInDurableObject(source, async (instance: OverseerDurableObject) => {
      await expect(instance.initializeAttention(builder.id.toString())).rejects.toThrow("workspace owner");
    });
    expect(await source.canNotifyAttention(owner.id.toString(), item.sourceId, item.version)).toBe(true);
    expect(await source.canNotifyAttention(builder.id.toString(), item.sourceId, item.version)).toBe(false);
    expect(await source.canNotifyAttention(owner.id.toString(), item.sourceId, item.version - 1)).toBe(false);
    await builderApi.markAttentionSeen(item.id, item.version);
    expect((await api.listAttention()).entries[0].seen).toBe(false);
  });

  it.each(["before commit", "after commit"])("newer resolution wins while the old batch is in flight %s", async when => {
    using publicApi = await connect();
    using api = await account(publicApi);
    using client = await api.newGadget();
    const source = await sourceFor(client);
    await userFor(api);
    await runInDurableObject(source, async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      putAction(impl.storage, 1);
      bootstrap(impl);
      const old = impl.attentionSnapshot()!;
      const get = impl.users.get.bind(impl.users);
      const owner = get(impl.users.idFromString(impl.ownerId!));
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const transport = vi.spyOn(impl.users, "get").mockImplementation((...args) => {
        const receiver = get(...args);
        return new Proxy(receiver, { get(target, key) {
          if (key === "syncWorkspaceAttention") return async (...params: Parameters<UserDurableObject["syncWorkspaceAttention"]>) => {
            if (when === "after commit") await receiver.syncWorkspaceAttention(...params);
            entered.resolve();
            await release.promise;
            if (when === "before commit") await receiver.syncWorkspaceAttention(...params);
          };
          return Reflect.get(target, key, target);
        } });
      });
      const delivery = deliver(impl);
      try {
        await entered.promise;
        putAction(impl.storage, 1, { state: "approved", appliedAt: new Date() });
        const latest = impl.attentionSnapshot()!;
        expect(latest.revision).toBeGreaterThan(old.revision);
        expect(latest.entries[0]).toMatchObject({ sourceId: "action:1", state: "resolved", notify: false });
        expect(await instance.canNotifyAttention(impl.ownerId!, "action:1", old.entries[0].version)).toBe(false);
        // Deliver the source's actual newer snapshot ahead of the held batch/ACK to force reordering.
        await owner.syncWorkspaceAttention(source.id.toString(), latest);
        const resolved = (await owner.listAttention()).entries[0];
        await owner.markAttentionSeen(resolved.id, resolved.version);
        await owner.markAttentionSeen(resolved.id, old.entries[0].version);
        release.resolve();
        await delivery;
        expect(impl.storage.attentionProgress.get()?.dirtyRevision).toBe(latest.revision);
        transport.mockRestore();
        await deliver(impl);
        await owner.syncWorkspaceAttention(source.id.toString(), old);
        expect((await owner.listAttention()).entries).toEqual([{ ...resolved, seen: true }]);
        expect(impl.storage.attentionProgress.get()?.dirtyRevision).toBeUndefined();
      } finally {
        release.resolve();
        await delivery;
        transport.mockRestore();
      }
    });
    expect(await api.listAttention()).toMatchObject({ unseen: 0, entries: [{ state: "resolved", seen: true }] });
  });

  it("chat deletion replaces the snapshot and late pre-deletion deliveries cannot resurrect its run or card", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    using client = await api.newGadget();
    const source = await sourceFor(client);
    const owner = await userFor(api);
    await runInDurableObject(source, (instance: OverseerDurableObject) => {
      seedChat(instance["impl"], 1);
      seedChat(instance["impl"], 2);
    });
    const old = await drain(source);
    expect((await api.listAttention()).entries).toHaveLength(4);
    await client.deleteChat(1);
    const latest = await drain(source);
    expect(latest.revision).toBeGreaterThan(old.revision);
    expect(latest.entries).toHaveLength(2);
    expect(latest.entries.every(entry => entry.chatId === 2)).toBe(true);
    await owner.syncWorkspaceAttention(source.id.toString(), old);
    expect((await api.listAttention()).entries.map(entry => entry.chatId)).toEqual([2, 2]);
    for (const entry of old.entries.filter(item => item.chatId === 1)) {
      expect(await source.canNotifyAttention(owner.id.toString(), entry.sourceId, entry.version)).toBe(false);
    }
    await client.deleteChat(2);
    expect((await drain(source)).entries).toEqual([]);
    await owner.syncWorkspaceAttention(source.id.toString(), latest);
    expect(await api.listAttention()).toMatchObject({ entries: [], unseen: 0 });
    await runInDurableObject(source, (instance: OverseerDurableObject) => {
      expect([...instance["impl"].storage.taskRuns.list()]).toEqual([]);
      expect([...instance["impl"].storage.chats.list()]).toEqual([]);
    });
  });

  it("workspace removal purges its receipt and ignores both delayed and fresh source deliveries", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    using client = await api.newGadget();
    const source = await sourceFor(client);
    const owner = await userFor(api);
    await runInDurableObject(source, (instance: OverseerDurableObject) => putAction(instance["impl"].storage, 1));
    const old = await drain(source);
    expect((await api.listAttention()).entries).toHaveLength(1);
    // The first step of deleteSelf is the authoritative UserDO registry removal. Leave the source
    // alive deliberately: even a later, higher-version native delivery must not restore membership.
    await owner.deleteGadget(source.id.toString());
    await owner.syncWorkspaceAttention(source.id.toString(), old);
    await runInDurableObject(source, (instance: OverseerDurableObject) => {
      putAction(instance["impl"].storage, 1, { state: "approved", appliedAt: new Date() });
    });
    expect((await drain(source)).revision).toBeGreaterThan(old.revision);
    expect(await api.listAttention()).toMatchObject({ entries: [], unseen: 0 });
    await runInDurableObject(owner, (instance: UserDurableObject) => {
      expect([...instance["storage"].attentionReceipts.list()]).toEqual([]);
      expect([...instance["storage"].attentionBootstrapJobs.list()]).toEqual([]);
      expect([...instance["storage"].attention.list()]).toEqual([]);
    });
  });

  it("subscribes through the browser/server/native bridge and releases invalidation callbacks on disposal", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    using client = await api.newGadget();
    const source = await sourceFor(client);
    await userFor(api);
    const changed = vi.fn<(revision: number) => void>();
    const disposed = vi.fn();
    class Subscriber extends RpcTarget implements AttentionSubscriber {
      changed(revision: number) { changed(revision); }
      [Symbol.dispose]() { disposed(); }
    }
    using subscriber = new RpcStub(new Subscriber());
    const feed = await api.subscribeAttention(subscriber);
    try {
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
      const initial = changed.mock.calls[0][0];
      await runInDurableObject(source, (instance: OverseerDurableObject) => putAction(instance["impl"].storage, 1));
      await drain(source);
      await vi.waitFor(() => expect(changed.mock.calls.at(-1)![0]).toBeGreaterThan(initial));
      const item = (await api.listAttention()).entries[0];
      expect(item.seen).toBe(false);
      const delivered = changed.mock.calls.at(-1)![0];
      await api.markAttentionSeen(item.id, item.version);
      await vi.waitFor(() => expect(changed.mock.calls.at(-1)![0]).toBeGreaterThan(delivered));
    } finally { feed[Symbol.dispose](); }
    subscriber[Symbol.dispose]();
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
    const count = changed.mock.calls.length;
    await runInDurableObject(source, (instance: OverseerDurableObject) => putAction(instance["impl"].storage, 2));
    await drain(source);
    expect(changed).toHaveBeenCalledTimes(count);
    expect((await api.listAttention()).entries).toHaveLength(2);
  });
});
