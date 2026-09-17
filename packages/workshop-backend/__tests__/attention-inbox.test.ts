import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {RpcStub, RpcTarget} from "capnweb";
import type {AttentionSubscriber, PushSubscriptionData} from "@gadgets/workshop-shared/api";
import {UserDurableObject} from "../src/user.js";
import type {OverseerDurableObject} from "../src/overseer.js";
import type {AttentionProjection, WorkspaceAttentionSnapshot} from "../src/attention.js";
import {createPushRequest, readPushConfig, validatePushSubscription} from "../src/web-push.js";

vi.mock("../src/web-push.js", () => ({
  createPushRequest: vi.fn(), readPushConfig: vi.fn(), validatePushSubscription: vi.fn(),
}));

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const subscription: PushSubscriptionData = {
  endpoint: "https://fcm.googleapis.com/secret-endpoint",
  keys: {p256dh: "secret-receiver-key", auth: "secret-auth"},
};
const config = {publicKey: "public-application-key", privateKey: "secret-private-key", subject: "mailto:push@example.com"};

function entry(version = 1, sourceId = "action:1", updates: Partial<AttentionProjection> = {}): AttentionProjection {
  return {sourceId, version, kind: "action", state: "pending", updatedAt: new Date(Date.now()), notify: true, ...updates};
}

function snapshot(revision = 1, entries = [entry(revision)], updates: Partial<WorkspaceAttentionSnapshot> = {}): WorkspaceAttentionSnapshot {
  return {revision, entries, complete: true, prohibitPush: false, truncated: false, ...updates};
}

beforeEach(() => {
  vi.mocked(readPushConfig).mockReturnValue(config);
  vi.mocked(validatePushSubscription).mockImplementation(() => {});
  vi.mocked(createPushRequest).mockImplementation(async data => new Request(data.endpoint, {
    method: "POST", body: "encrypted generic payload",
  }));
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, {status: 201}));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

// Production UserDO and typed storage over real workerd SQLite. Only remote source RPC and push
// crypto/transport are substituted; no storage implementation or receiver method is mocked.
function withUser(test: (fixture: {
  user: UserDurableObject;
  state: DurableObjectState;
  restart: () => UserDurableObject;
  advance: (ms?: number) => void;
  initialize: ReturnType<typeof vi.fn<(workspaceId: string, ownerId: string) => Promise<void>>>;
  canNotify: ReturnType<typeof vi.fn<OverseerDurableObject["canNotifyAttention"]>>;
}) => Promise<void>) {
  return runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async (_instance, state) => {
    // Keep real alarms in the future; exercise the production handler explicitly and deterministically.
    let now = Date.now() + 3_600_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const initialize = vi.fn<(workspaceId: string, ownerId: string) => Promise<void>>().mockResolvedValue(undefined);
    const canNotify = vi.fn<OverseerDurableObject["canNotifyAttention"]>().mockResolvedValue(true);
    const exports = new Proxy(state.exports, {get(target, key) {
      if (key === "OverseerDurableObject") return {
        idFromString: (id: string) => id,
        get: (workspaceId: string) => ({
          initializeAttention: (ownerId: string) => initialize(workspaceId, ownerId),
          canNotifyAttention: canNotify,
        } satisfies Pick<OverseerDurableObject, "initializeAttention" | "canNotifyAttention">),
      };
      return Reflect.get(target, key);
    }});
    const context = new Proxy(state, {get(target, key) {
      return key === "exports" ? exports : Reflect.get(target, key);
    }});
    const restart = () => {
      const instance = new UserDurableObject(state, env);
      Object.defineProperty(instance, "ctx", {value: context});
      return instance;
    };
    const user = restart();
    try {
      await test({user, state, restart, initialize, canNotify, advance: (ms = 1_001) => { now += ms; }});
    } finally {
      await state.storage.deleteAlarm();
    }
  });
}

async function bot(user: UserDurableObject, workspaceId = "workspace", id = "bot") {
  await user.newGadget(workspaceId, "Owner workspace title");
  await user.createAgentRecord(id, workspaceId, "Bot", "Bot", "", null);
}

async function enroll(user: UserDurableObject) {
  await bot(user);
  return user.registerPushSubscription(subscription);
}

describe("owner attention receiver", () => {
  it("ignores reordered/identical snapshots, replaces missing sources and acknowledges exact versions", () =>
    withUser(async ({user, restart}) => {
      await bot(user);
      await user.syncWorkspaceAttention("workspace", snapshot(2, [entry(2, "proposal:1"), entry(1)]));
      const first = await user.listAttention();
      expect(first.entries.map(item => item.sourceId)).toEqual(["proposal:1", "action:1"]);
      expect(first.unseen).toBe(2);
      const item = first.entries[1];
      expect(item.id).toBe(JSON.stringify(["workspace", "action:1"]));
      expect(item.agentId).toBe("bot");
      await user.markAttentionSeen(item.id, 1);
      await user.syncWorkspaceAttention("workspace", snapshot(1, []));
      await user.syncWorkspaceAttention("workspace", snapshot(2, []));
      expect((await user.listAttention()).unseen).toBe(1);
      await user.syncWorkspaceAttention("workspace", snapshot(3, [entry(3, "action:1", {state: "resolved", notify: false})]));
      await user.markAttentionSeen(item.id, 1);
      const current = await restart().listAttention();
      expect(current.entries).toHaveLength(1);
      expect(current.entries[0]).toMatchObject({id: item.id, version: 3, seen: false, state: "resolved"});
      expect(current.entries[0].order).toBeGreaterThan(first.entries[0].order);
      await user.markAttentionSeen(item.id, 3);
      expect((await user.listAttention()).unseen).toBe(0);
    }));

  it("does not trust source identity/prose and never admits shared or deleted workspaces", () =>
    withUser(async ({user}) => {
      await bot(user);
      const untrusted = {...entry(), agentId: "someone-else", workspaceId: "other",
        title: "secret-source-title", prompt: "secret-prompt", description: "secret-description"};
      await user.syncWorkspaceAttention("workspace", snapshot(1, [untrusted]));
      const page = await user.listAttention();
      expect(page.entries[0]).toMatchObject({workspaceId: "workspace", agentId: "bot", workspaceTitle: "Owner workspace title"});
      expect(JSON.stringify(page)).not.toContain("secret-");
      expect(JSON.stringify([...user["storage"].attention.list()])).not.toContain("secret-");
      await user.recordSharedGadgetOpen("shared", "Shared", {type: "user", id: "other", name: "Other"});
      await user.syncWorkspaceAttention("shared", snapshot());
      await user.syncWorkspaceAttention("unknown", snapshot());
      expect((await user.listAttention()).entries).toHaveLength(1);
      await user.deleteAgentRecord("bot");
      await user.syncWorkspaceAttention("workspace", snapshot(2));
      expect((await user.listAttention()).entries).toEqual([]);
      await user.deleteGadget("workspace");
      await user.syncWorkspaceAttention("workspace", snapshot(3));
      expect([...user["storage"].attentionReceipts.list()]).toEqual([]);
      expect((await user.listAttention()).entries).toEqual([]);
    }));

  it("retains 500 with thirty-entry cursors and does not resurrect pruned unchanged versions", () =>
    withUser(async ({user, restart}) => {
      for (let i = 0; i < 6; ++i) {
        await user.newGadget(`workspace-${i}`, "Workspace");
        await user.syncWorkspaceAttention(`workspace-${i}`, snapshot(100,
          Array.from({length: 100}, (_, n) => entry(n + 1, `action:${n}`, {notify: false}))));
      }
      let page = await user.listAttention();
      expect(page).toMatchObject({unseen: 500, truncated: true});
      const ids: string[] = [];
      while (true) {
        expect(page.entries.length).toBeLessThanOrEqual(30);
        ids.push(...page.entries.map(item => item.id));
        if (page.nextBeforeOrder === undefined) break;
        const lastOrder = page.entries.at(-1)!.order;
        page = await user.listAttention(page.nextBeforeOrder);
        expect(page.entries.every(item => item.order < lastOrder)).toBe(true);
      }
      expect(new Set(ids).size).toBe(500);
      expect([...user["storage"].attention.byWorkspace.get("workspace-0")]).toEqual([]);
      await user.syncWorkspaceAttention("workspace-0", snapshot(101, [entry(1, "action:0", {notify: false})]));
      expect([...user["storage"].attention.byWorkspace.get("workspace-0")]).toEqual([]);
      await user.syncWorkspaceAttention("workspace-0", snapshot(102, [entry(102, "action:0", {notify: false})]));
      expect((await user.listAttention()).entries[0]).toMatchObject({workspaceId: "workspace-0", version: 102});
      await user.deleteGadget("workspace-0");
      expect((await restart().listAttention()).truncated).toBe(true);
      await expect(user.syncWorkspaceAttention("workspace-1", snapshot(103,
        Array.from({length: 101}, (_, n) => entry(103, `extra:${n}`))))).rejects.toThrow("workspace limit");
    }));

  it("keeps source truncation sticky and disposes initial/change invalidation subscriptions", () =>
    withUser(async ({user}) => {
      const changed = vi.fn();
      const disposed = vi.fn();
      class Subscriber extends RpcTarget implements AttentionSubscriber {
        changed(revision: number) { changed(revision); }
        [Symbol.dispose]() { disposed(); }
      }
      const stub = new RpcStub(new Subscriber());
      const feed = await user.subscribeAttention(stub);
      stub[Symbol.dispose]();
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
      await bot(user);
      await user.syncWorkspaceAttention("workspace", snapshot(1, [entry()], {truncated: true}));
      await vi.waitFor(() => expect(changed.mock.calls.at(-1)![0]).toBe(user["storage"].attentionRevision.get()));
      expect((await user.listAttention()).truncated).toBe(true);
      const callsBefore = changed.mock.calls.length;
      const revision = user["storage"].attentionRevision;
      const next = revision.get() + 1;
      user["storage"].transaction(() => {
        revision.put(next);
        revision.put(next + 1);
      });
      expect(changed).toHaveBeenCalledTimes(callsBefore);
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(callsBefore + 1));
      expect(changed).toHaveBeenLastCalledWith(next + 1);
      revision.put(next + 2); // Disposal must also suppress an already queued invalidation.
      feed[Symbol.dispose]();
      await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
      const count = changed.mock.calls.length;
      expect(count).toBe(callsBefore + 1);
      await user.syncWorkspaceAttention("workspace", snapshot(2, []));
      expect(changed).toHaveBeenCalledTimes(count);
      expect((await user.listAttention()).truncated).toBe(true);
    }));

  it("does not leak a rolled-back receiver revision or mask the next committed update", () =>
    withUser(async ({user}) => {
      await bot(user);
      let watermark = -1;
      const visible = vi.fn();
      const changed = vi.fn((value: number) => {
        // Mirror the browser's monotonic invalidation filter.
        if (value <= watermark) return;
        watermark = value;
        visible(value);
      });
      class Subscriber extends RpcTarget implements AttentionSubscriber {
        changed(value: number) { changed(value); }
      }
      using subscriber = new RpcStub(new Subscriber());
      using _feed = await user.subscribeAttention(subscriber);
      await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
      const revision = user["storage"].attentionRevision;
      const committed = revision.get();
      expect(watermark).toBe(committed);
      visible.mockClear();
      const put = revision.put.bind(revision);
      vi.spyOn(revision, "put").mockImplementationOnce(value => {
        put(value);
        throw new Error("Injected failure after receiver revision write");
      });
      await expect(user.syncWorkspaceAttention("workspace", snapshot())).rejects.toThrow("Injected failure");
      expect(revision.get()).toBe(committed);
      expect(user["storage"].attentionReceipts.get("workspace")).toBeUndefined();
      expect((await user.listAttention()).entries).toEqual([]);
      expect(changed.mock.calls.every(([value]) => value <= committed)).toBe(true);
      expect(watermark).toBe(committed);
      expect(visible).not.toHaveBeenCalled();
      await user.syncWorkspaceAttention("workspace", snapshot());
      await vi.waitFor(() => expect(visible).toHaveBeenCalledExactlyOnceWith(committed + 1));
      expect((await user.listAttention()).entries).toHaveLength(1);
      expect(watermark).toBe(revision.get());
    }));
});

describe("durable attention bootstrap", () => {
  it("scans sixteen at a time and retries each workspace until a complete receipt, without another list", () =>
    withUser(async ({user, state, initialize, advance, restart}) => {
      for (let i = 0; i < 35; ++i) await user.newGadget(`workspace-${i.toString().padStart(2, "0")}`, "Workspace");
      await user.recordSharedGadgetOpen("shared", "Shared", {type: "user", id: "other", name: "Other"});
      initialize.mockImplementation(async (workspaceId, ownerId) => {
        expect(ownerId).toBe(state.id.toString());
        if (workspaceId === "workspace-00") throw new Error("temporarily unavailable");
        await user.syncWorkspaceAttention(workspaceId, snapshot(1, [entry(1, "old", {notify: false, updatedAt: new Date(0)})]));
      });
      expect((await user.listAttention()).catchingUp).toBe(true);
      expect(await state.storage.getAlarm()).not.toBeNull();
      await user.alarm();
      expect(user["storage"].attentionScanCursor.get()).toBe("workspace-14");
      advance();
      await user.alarm();
      expect(initialize).toHaveBeenCalledTimes(15);
      advance();
      await user.alarm();
      expect(initialize).toHaveBeenCalledTimes(31);
      advance();
      await user.alarm();
      expect(initialize).toHaveBeenCalledTimes(35);
      expect((await user.listAttention()).catchingUp).toBe(true);
      expect([...user["storage"].attentionBootstrapJobs.list()]).toHaveLength(1);
      initialize.mockImplementation(async workspaceId => {
        await user.syncWorkspaceAttention(workspaceId, snapshot(2, [], {complete: false}));
      });
      advance(300_000);
      await restart().alarm();
      expect((await user.listAttention()).catchingUp).toBe(true);
      // A successful quick start is not a completion receipt.
      await user.syncWorkspaceAttention("workspace-00", snapshot(3, []));
      expect((await user.listAttention()).catchingUp).toBe(false);
      expect(await state.storage.getAlarm()).toBeNull();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      await user.newGadget("new-after-scan", "New");
      expect((await user.listAttention()).catchingUp).toBe(true);
      await user.deleteGadget("new-after-scan");
      advance();
      await user.alarm();
      expect(initialize.mock.calls.some(([id]) => id === "new-after-scan")).toBe(false);
      expect((await user.listAttention()).catchingUp).toBe(false);
    }));

  it.each(["resolve", "reject"] as const)("times out a hung bootstrap and ignores its late %s", outcome =>
    withUser(async ({user, initialize, advance, state}) => {
      await enroll(user);
      await user.syncWorkspaceAttention("workspace", snapshot());
      await user.newGadget("hung", "Hung workspace");
      await user.newGadget("healthy", "Healthy workspace");
      const pending = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      initialize.mockImplementation(async workspaceId => {
        if (workspaceId === "hung") { started.resolve(); return pending.promise; }
        await user.syncWorkspaceAttention(workspaceId, snapshot(1, [], {complete: true}));
      });
      vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
      advance();
      let settled = false;
      const drain = user.alarm().then(() => { settled = true; });
      await started.promise;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      expect(user["storage"].attentionReceipts.get("healthy")?.complete).toBe(true);
      expect(user["storage"].attentionBootstrapJobs.get("healthy")).toBeUndefined();
      advance(10_000);
      await vi.advanceTimersByTimeAsync(1);
      await drain;
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect((await user.listAttention()).catchingUp).toBe(true);
      expect(await state.storage.getAlarm()).not.toBeNull();
      // A newer start owns the retry; the old timed-out call cannot complete or erase it.
      initialize.mockResolvedValue(undefined);
      await user.alarm();
      const retry = user["storage"].attentionBootstrapJobs.get("hung");
      expect(retry?.attempt).toBe(2);
      if (outcome === "resolve") pending.resolve();
      else pending.reject(new Error("Late bootstrap rejection"));
      await vi.advanceTimersByTimeAsync(0);
      expect(user["storage"].attentionBootstrapJobs.get("hung")).toEqual(retry);
      expect((await user.listAttention()).catchingUp).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    }));
});

describe("owner push devices and jobs", () => {
  it("validates before idempotent registration, caps five devices and exposes only safe settings", () =>
    withUser(async ({user}) => {
      const {id} = await enroll(user);
      await user.syncWorkspaceAttention("workspace", snapshot(1, [entry(1, "old", {notify: false, updatedAt: new Date(0)})]));
      expect(await user.registerPushSubscription(subscription)).toEqual({id});
      expect(validatePushSubscription).toHaveBeenCalledTimes(2);
      expect((await user.getPushSettings()).devices).toEqual([{id, createdAt: expect.any(Date), delivery: "idle"}]);
      expect([...user["storage"].pushJobs.list()]).toEqual([]);
      const settings = JSON.stringify(await user.getPushSettings());
      expect(settings).toContain(config.publicKey);
      expect(settings).not.toContain("secret-");
      for (let n = 0; n < 4; ++n) await user.registerPushSubscription({...subscription, endpoint: `${subscription.endpoint}/${n}`});
      await expect(user.registerPushSubscription({...subscription, endpoint: `${subscription.endpoint}/extra`})).rejects.toThrow("five");
      vi.mocked(validatePushSubscription).mockImplementationOnce(() => { throw new Error("Invalid subscription"); });
      await expect(user.registerPushSubscription(subscription)).rejects.toThrow("Invalid subscription");
      await user.removePushSubscription(id);
      expect((await user.getPushSettings()).devices).toHaveLength(4);
      vi.mocked(readPushConfig).mockReturnValue(undefined);
      expect(await user.getPushSettings()).toMatchObject({available: false, applicationServerKey: undefined});
      await expect(user.registerPushSubscription(subscription)).rejects.toThrow("unavailable");
    }));

  it("keeps delayed pre-enrollment events in the inbox, but queues only events after each device's consent", () =>
    withUser(async ({user, advance, restart}) => {
      await bot(user);
      const beforeConsent = entry(1, "before-enrollment");
      advance();
      const first = await user.registerPushSubscription(subscription);
      const firstConsent = Date.now();
      expect((await user.getPushSettings()).devices[0].createdAt.getTime()).toBe(firstConsent);
      advance();
      // notify:true is a delayed live source transition, not a bootstrap projection.
      await restart().syncWorkspaceAttention("workspace", snapshot(1, [beforeConsent]));
      expect((await user.listAttention()).unseen).toBe(1);
      expect([...user["storage"].pushJobs.list()]).toEqual([]);
      const afterFirstConsent = entry(2, "between-enrollments");
      advance();
      const second = await user.registerPushSubscription({...subscription, endpoint: `${subscription.endpoint}/second`});
      await user.registerPushSubscription(subscription); // Idempotency preserves the first consent boundary.
      await restart().syncWorkspaceAttention("workspace", snapshot(2, [beforeConsent, afterFirstConsent]));
      const jobs = [...user["storage"].pushJobs.list()];
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({id: first.id, candidates: [{itemId: JSON.stringify(["workspace", "between-enrollments"]), version: 2}]});
      expect((await user.getPushSettings()).devices.find(device => device.id === second.id)?.delivery).toBe("idle");
      advance();
      await user.alarm();
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect((await user.listAttention()).unseen).toBe(2);
    }));

  it("persists the private unmute boundary and suppresses delayed muted-interval events without hiding them", () =>
    withUser(async ({user, advance, restart}) => {
      await enroll(user);
      await user.updateAgentRecord("bot", {notifyOnUpdates: false});
      advance();
      const whileMuted = entry(1, "muted-interval");
      advance();
      const unmuted = await user.updateAgentRecord("bot", {notifyOnUpdates: true});
      const enableSince = Date.now();
      expect(user["storage"].pushBotConsent.get("bot")).toEqual({agentId: "bot", enableSince});
      const recovered = restart();
      advance();
      await recovered.updateAgentRecord("bot", {name: "Renamed", notifyOnUpdates: true});
      expect(user["storage"].pushBotConsent.get("bot")?.enableSince).toBe(enableSince);
      expect(JSON.stringify([unmuted, await recovered.getAgent("bot"), await recovered.listAgents(),
        await recovered.getAgentByWorkspaceId("workspace")])).not.toContain("enableSince");
      await recovered.syncWorkspaceAttention("workspace", snapshot(1, [whileMuted]));
      expect((await user.listAttention()).entries).toHaveLength(1);
      expect([...user["storage"].pushJobs.list()]).toEqual([]);
      advance();
      await recovered.alarm();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      await recovered.syncWorkspaceAttention("workspace", snapshot(2, [whileMuted, entry(2, "after-unmute")]));
      advance();
      await recovered.alarm();
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect((await user.listAttention()).unseen).toBe(2);
      await recovered.deleteAgentRecord("bot");
      expect(user["storage"].pushBotConsent.get("bot")).toBeUndefined();
    }));

  it.each(["device", "bot"] as const)("rechecks the %s consent boundary on previously persisted jobs", boundary =>
    withUser(async ({user, advance, restart}) => {
      const {id} = await enroll(user);
      await user.syncWorkspaceAttention("workspace", snapshot());
      // Model a persisted job queued by an older receiver that did not check event time.
      advance();
      if (boundary === "device") {
        user["storage"].pushDevices.put({...user["storage"].pushDevices.get(id)!, createdAt: new Date(Date.now())});
      } else {
        user["storage"].pushBotConsent.put({agentId: "bot", enableSince: Date.now()});
      }
      await restart().alarm();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect([...user["storage"].pushJobs.list()]).toEqual([]);
      expect((await user.getPushSettings()).devices[0].delivery).toBe("idle");
      expect((await user.listAttention()).unseen).toBe(1);
    }));

  it("coalesces at most twenty fresh candidates per device and accepts without marking seen", () =>
    withUser(async ({user, state, canNotify, advance}) => {
      const {id} = await enroll(user);
      for (let n = 0; n < 4; ++n) await user.registerPushSubscription({...subscription, endpoint: `${subscription.endpoint}/${n}`});
      await user.syncWorkspaceAttention("workspace", snapshot(30, Array.from({length: 30}, (_, n) => entry(n + 1, `action:${n}`))));
      const jobs = [...user["storage"].pushJobs.list()];
      expect(jobs).toHaveLength(5);
      expect(jobs.every(job => job.candidates.length === 20)).toBe(true);
      expect(jobs[0].candidates[0]).toEqual({itemId: JSON.stringify(["workspace", "action:10"]), version: 11});
      expect((await user.getPushSettings()).devices.every(device => device.delivery === "pending")).toBe(true);
      advance();
      await user.alarm();
      expect(globalThis.fetch).toHaveBeenCalledTimes(5);
      expect(canNotify).toHaveBeenCalledWith(state.id.toString(), "action:10", 11);
      expect(vi.mocked(globalThis.fetch).mock.calls[0][1]).toMatchObject({redirect: "manual", signal: expect.any(AbortSignal)});
      expect((await user.getPushSettings()).devices.find(device => device.id === id)?.delivery).toBe("accepted");
      expect([...user["storage"].pushJobs.list()]).toEqual([]);
      expect((await user.listAttention()).unseen).toBe(30);
      await user.syncWorkspaceAttention("workspace", snapshot(31, [entry(11, "action:10")]));
      expect([...user["storage"].pushJobs.list()]).toEqual([]);
    }));

  it("keeps muted items visible, suppresses bootstrap/resolved/seen versions and never replays on unmute", () =>
    withUser(async ({user, advance}) => {
      await enroll(user);
      await user.updateAgentRecord("bot", {notifyOnUpdates: false});
      await user.syncWorkspaceAttention("workspace", snapshot());
      expect((await user.listAttention()).entries).toHaveLength(1);
      expect([...user["storage"].pushJobs.list()]).toEqual([]);
      await user.updateAgentRecord("bot", {notifyOnUpdates: true});
      await user.syncWorkspaceAttention("workspace", snapshot(2, [entry(1)]));
      expect([...user["storage"].pushJobs.list()]).toEqual([]);
      await user.syncWorkspaceAttention("workspace", snapshot(3, [entry(3, "action:1", {state: "resolved"})]));
      await user.syncWorkspaceAttention("workspace", snapshot(4, [entry(4, "action:1", {notify: false})]));
      expect([...user["storage"].pushJobs.list()]).toEqual([]);
      await user.syncWorkspaceAttention("workspace", snapshot(5));
      await user.markAttentionSeen(JSON.stringify(["workspace", "action:1"]), 5);
      advance();
      await user.alarm();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      await user.syncWorkspaceAttention("workspace", snapshot(6));
      await user.updateAgentRecord("bot", {notifyOnUpdates: false});
      await user.updateAgentRecord("bot", {notifyOnUpdates: true});
      advance();
      await user.alarm();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    }));

  it.each(["revoke", "rotate", "mute", "delete", "delete-agent", "seen", "resolve", "sensitive"] as const)(
    "rechecks %s after outstanding encryption", action => withUser(async ({user, advance}) => {
      const {id} = await enroll(user);
      await user.syncWorkspaceAttention("workspace", snapshot());
      const encrypting = Promise.withResolvers<Request>();
      const started = Promise.withResolvers<void>();
      vi.mocked(createPushRequest).mockImplementationOnce(() => { started.resolve(); return encrypting.promise; });
      advance();
      const drain = user.alarm();
      await started.promise;
      if (action === "revoke") await user.removePushSubscription(id);
      if (action === "rotate") await user.registerPushSubscription({...subscription, keys: {...subscription.keys, auth: "rotated-secret"}});
      if (action === "mute") await user.updateAgentRecord("bot", {notifyOnUpdates: false});
      if (action === "delete") await user.deleteGadget("workspace");
      if (action === "delete-agent") await user.deleteAgentRecord("bot");
      if (action === "seen") await user.markAttentionSeen(JSON.stringify(["workspace", "action:1"]), 1);
      if (action === "resolve") await user.syncWorkspaceAttention("workspace", snapshot(2, [entry(2, "action:1", {state: "resolved", notify: false})]));
      if (action === "sensitive") await user.syncWorkspaceAttention("workspace", snapshot(2, [entry(1)], {prohibitPush: true}));
      encrypting.resolve(new Request(subscription.endpoint, {method: "POST"}));
      await drain;
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect([...user["storage"].pushJobs.list()]).toEqual([]);
    }));

  it("rechecks local state after the live source check and fails closed on source privacy", () =>
    withUser(async ({user, canNotify, advance}) => {
      await enroll(user);
      await user.syncWorkspaceAttention("workspace", snapshot());
      const checking = Promise.withResolvers<boolean>();
      const started = Promise.withResolvers<void>();
      canNotify.mockImplementationOnce(() => { started.resolve(); return checking.promise; });
      advance();
      const drain = user.alarm();
      await started.promise;
      await user.updateAgentRecord("bot", {notifyOnUpdates: false});
      checking.resolve(true);
      await drain;
      expect(globalThis.fetch).not.toHaveBeenCalled();
      await user.updateAgentRecord("bot", {notifyOnUpdates: true});
      await user.syncWorkspaceAttention("workspace", snapshot(2));
      canNotify.mockResolvedValue(false);
      advance();
      await user.alarm();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect([...user["storage"].pushJobs.list()]).toEqual([]);
    }));

  it("does not resurrect a revoked device or acknowledge fresh work after an outstanding fetch", () =>
    withUser(async ({user, advance}) => {
      const {id} = await enroll(user);
      await user.syncWorkspaceAttention("workspace", snapshot());
      const fetching = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      vi.mocked(globalThis.fetch).mockImplementationOnce(() => { started.resolve(); return fetching.promise; });
      advance();
      const drain = user.alarm();
      await started.promise;
      await user.removePushSubscription(id);
      const replacement = await user.registerPushSubscription(subscription);
      await user.syncWorkspaceAttention("workspace", snapshot(2));
      fetching.resolve(new Response(null, {status: 201}));
      await drain;
      expect(replacement.id).not.toBe(id);
      expect((await user.getPushSettings()).devices).toEqual([{id: replacement.id, createdAt: expect.any(Date), delivery: "pending"}]);
      expect([...user["storage"].pushJobs.list()]).toHaveLength(1);
      advance();
      await user.alarm();
      expect((await user.getPushSettings()).devices[0].delivery).toBe("accepted");
      expect((await user.listAttention()).unseen).toBe(1);
    }));

  it("fails closed and durably retries when the live source check is unavailable", () =>
    withUser(async ({user, canNotify, advance, restart}) => {
      await enroll(user);
      await user.syncWorkspaceAttention("workspace", snapshot());
      canNotify.mockRejectedValueOnce(new Error("Source unavailable"));
      advance();
      await user.alarm();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect([...user["storage"].pushJobs.list()][0].attempt).toBe(1);
      expect((await user.getPushSettings()).devices[0].delivery).toBe("pending");
      advance(5_001);
      await restart().alarm();
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect((await user.getPushSettings()).devices[0].delivery).toBe("accepted");
    }));

  it.each(["reject", "timeout"] as const)("does not let one source's %s suppress another workspace's eligible candidate", failure =>
    withUser(async ({user, canNotify, advance}) => {
      await enroll(user);
      await bot(user, "other-workspace", "other-bot");
      await user.syncWorkspaceAttention("workspace", snapshot(1, [entry(1, "unavailable")]));
      await user.syncWorkspaceAttention("other-workspace", snapshot(1, [entry(1, "healthy")]));
      const pending = Promise.withResolvers<boolean>();
      const started = Promise.withResolvers<void>();
      canNotify.mockImplementation(async (_ownerId, sourceId) => {
        if (sourceId === "healthy") return true;
        started.resolve();
        if (failure === "reject") throw new Error("Unavailable source");
        return pending.promise;
      });
      vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
      advance();
      const drain = user.alarm();
      await started.promise;
      if (failure === "timeout") {
        await vi.advanceTimersByTimeAsync(9_999);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        advance(10_000);
        await vi.advanceTimersByTimeAsync(1);
      }
      await drain;
      expect(canNotify).toHaveBeenCalledTimes(2);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect((await user.getPushSettings()).devices[0].delivery).toBe("accepted");
      await user.syncWorkspaceAttention("other-workspace", snapshot(2, [entry(2, "healthy")]));
      const newer = [...user["storage"].pushJobs.list()][0];
      pending.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect([...user["storage"].pushJobs.list()]).toEqual([newer]);
      expect((await user.getPushSettings()).devices[0].delivery).toBe("pending");
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    }));

  it("retries instead of going idle when no candidate is eligible and some source checks fail", () =>
    withUser(async ({user, canNotify, advance}) => {
      await enroll(user);
      await user.syncWorkspaceAttention("workspace", snapshot(2, [entry(1, "unavailable"), entry(2, "ineligible")]));
      canNotify.mockImplementation(async (_owner, sourceId) => {
        if (sourceId === "unavailable") throw new Error("Source unavailable");
        return false;
      });
      advance();
      await user.alarm();
      expect(canNotify).toHaveBeenCalledTimes(2);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect([...user["storage"].pushJobs.list()][0].attempt).toBe(1);
      expect((await user.getPushSettings()).devices[0].delivery).toBe("pending");
    }));

  it("preserves a newer coalesced revision while a previous fetch completes", () =>
    withUser(async ({user, advance}) => {
      await enroll(user);
      await user.syncWorkspaceAttention("workspace", snapshot());
      const fetching = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      vi.mocked(globalThis.fetch).mockImplementationOnce(() => { started.resolve(); return fetching.promise; });
      advance();
      const drain = user.alarm();
      await started.promise;
      const original = [...user["storage"].pushJobs.list()][0];
      await user.syncWorkspaceAttention("workspace", snapshot(2));
      fetching.resolve(new Response(null, {status: 201}));
      await drain;
      expect((await user.getPushSettings()).devices[0].delivery).toBe("pending");
      expect([...user["storage"].pushJobs.list()][0].candidates).toEqual([{itemId: JSON.stringify(["workspace", "action:1"]), version: 2}]);
      expect([...user["storage"].pushJobs.list()][0]).toMatchObject({attempt: original.attempt, due: original.due});
      advance(5_001);
      await user.alarm();
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    }));

  it("preserves backoff and the six-attempt budget while new versions and other workspaces coalesce during an outage", () =>
    withUser(async ({user, advance, restart}) => {
      await enroll(user);
      await bot(user, "other-workspace", "other-bot");
      await user.syncWorkspaceAttention("workspace", snapshot());
      const [initial] = [...user["storage"].pushJobs.list()];
      advance(100);
      await user.syncWorkspaceAttention("workspace", snapshot(2));
      expect([...user["storage"].pushJobs.list()][0]).toMatchObject({attempt: 0, due: initial.due});
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error("Push service unavailable"));
      for (let attempt = 1; attempt <= 6; ++attempt) {
        const [due] = [...user["storage"].pushJobs.list()];
        advance(due.due - Date.now());
        await restart().alarm();
        expect(globalThis.fetch).toHaveBeenCalledTimes(attempt);
        if (attempt === 6) break;
        const [old] = [...user["storage"].pushJobs.list()];
        expect(old.attempt).toBe(attempt);
        advance(100);
        await user.syncWorkspaceAttention("workspace", snapshot(attempt + 2));
        await user.syncWorkspaceAttention("other-workspace", snapshot(attempt));
        const [merged] = [...user["storage"].pushJobs.list()];
        expect(merged).toMatchObject({attempt, due: old.due});
        expect(merged.revision).toBeGreaterThan(old.revision);
        expect(merged.candidates).toHaveLength(2);
        await user.alarm();
        expect(globalThis.fetch).toHaveBeenCalledTimes(attempt);
      }
      expect((await user.getPushSettings()).devices[0].delivery).toBe("failed");
      expect([...user["storage"].pushJobs.list()]).toEqual([]);
      advance(300_000);
      await user.alarm();
      expect(globalThis.fetch).toHaveBeenCalledTimes(6);
    }));

  it("persists capped retries across restart, logs no endpoint errors, and fails after six attempts", () =>
    withUser(async ({user, state, advance, restart}) => {
      await enroll(user);
      await user.syncWorkspaceAttention("workspace", snapshot());
      const log = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error(subscription.endpoint));
      for (let attempt = 1; attempt <= 6; ++attempt) {
        advance(300_000);
        await restart().alarm();
        expect(globalThis.fetch).toHaveBeenCalledTimes(attempt);
        if (attempt < 6) {
          const job = [...user["storage"].pushJobs.list()][0];
          expect(job.attempt).toBe(attempt);
          expect(job.due - Date.now()).toBe(Math.min(300_000, 5_000 * 2 ** (attempt - 1)));
          expect(await state.storage.getAlarm()).not.toBeNull();
        }
      }
      expect((await user.getPushSettings()).devices[0].delivery).toBe("failed");
      expect([...user["storage"].pushJobs.list()]).toEqual([]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret-");
      expect((await user.listAttention()).unseen).toBe(1);
      // A fresh source version can start a new delivery, but replaying the old one cannot.
      await user.syncWorkspaceAttention("workspace", snapshot(2, [entry(1)]));
      expect([...user["storage"].pushJobs.list()]).toEqual([]);
      await user.syncWorkspaceAttention("workspace", snapshot(3));
      expect([...user["storage"].pushJobs.list()][0].attempt).toBe(0);
    }));

  it("fails a 301 redirect without following its Location or retrying the push", () =>
    withUser(async ({user, advance}) => {
      await enroll(user);
      await user.syncWorkspaceAttention("workspace", snapshot());
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response("secret-redirect-body", {
        status: 301, headers: {Location: "https://evil.no/secret-location"},
      }));
      advance();
      await user.alarm();
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const [request, options] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(request).toBeInstanceOf(Request);
      expect((request as Request).url).toBe(subscription.endpoint);
      expect(options).toMatchObject({redirect: "manual", signal: expect.any(AbortSignal)});
      const settings = await user.getPushSettings();
      expect(settings.devices).toEqual([{id: expect.any(String), createdAt: expect.any(Date), delivery: "failed"}]);
      expect(JSON.stringify(settings)).not.toMatch(/evil\.no|secret-/);
      expect([...user["storage"].pushJobs.list()]).toEqual([]);
      expect((await user.listAttention()).unseen).toBe(1);
      advance(300_000);
      await user.alarm();
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    }));

  it.each([401, 403, 404, 410, 429, 503])("handles HTTP %i without leaking endpoint data", status =>
    withUser(async ({user, advance}) => {
      await enroll(user);
      await user.syncWorkspaceAttention("workspace", snapshot());
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response("secret-service-body", {status}));
      advance();
      await user.alarm();
      const settings = await user.getPushSettings();
      if (status === 404 || status === 410) {
        expect(settings.devices).toEqual([]);
        expect([...user["storage"].pushJobs.list()]).toEqual([]);
      } else if (status === 401 || status === 403) {
        expect(settings.devices[0].delivery).toBe("failed");
        expect([...user["storage"].pushJobs.list()]).toEqual([]);
      } else {
        expect(settings.devices[0].delivery).toBe("pending");
        expect([...user["storage"].pushJobs.list()][0].attempt).toBe(1);
      }
      expect(JSON.stringify(settings)).not.toContain("secret-");
    }));
});


describe("bot roster projection", () => {
  it("projects presence and unread versions across unopened workspaces without acknowledging approvals", () =>
    withUser(async ({user, restart}) => {
      await bot(user);
      await user.syncWorkspaceAttention("workspace", snapshot(1, [], {roster: {working: true}}));
      expect((await user.listAgents())[0].roster).toMatchObject({presence: "working", unreadCount: 0});
      await user.syncWorkspaceAttention("workspace", snapshot(2, [entry(2)], {roster: {working: true}}));
      expect((await user.listAgents())[0].roster).toMatchObject({presence: "waiting", unreadCount: 1});
      await user.syncWorkspaceAttention("workspace", snapshot(3, [entry(3, "run:1", {kind: "run", state: "failed"})],
        {roster: {working: false, lastReply: {text: "Try again", timestamp: 100}}}));
      expect((await user.listAgents())[0].roster).toMatchObject({presence: "blocked", unreadCount: 2});
      await user.markAgentRead("bot", 100);
      expect((await user.listAgents())[0].roster?.unreadCount).toBe(1);
      await user.syncWorkspaceAttention("workspace", snapshot(4, [entry(4, "run:1", {kind: "run", state: "finished"})],
        {roster: {working: false, lastReply: {text: "Finished", timestamp: 200}}}));
      await user.markAgentRead("bot", 100); // A stale tab cannot read the newer reply.
      expect((await restart().listAgents())[0].roster).toMatchObject({presence: "done", unreadCount: 2, lastReply: {text: "Finished"}});
      await user.updateAgentRecord("bot", {hidden: true, notifyOnUpdates: false});
      expect((await user.listAgents())[0]).toMatchObject({hidden: true, notifyOnUpdates: false});
    }));
});
