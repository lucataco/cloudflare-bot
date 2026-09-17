import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub, RpcTarget as NativeRpcTarget } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { RpcStub } from "capnweb";
import { keyString, type Subscriber } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo, AiChatMessage, AiChatMessageBody, TaskRun } from "@gadgets/workshop-shared/api";
import { makeOverseerStorage, type OverseerDurableObject } from "../src/overseer.js";
import type { AttentionProjection, WorkspaceAttentionSnapshot } from "../src/attention.js";
import type { UserAiModelRecord } from "../src/user.js";
import { putAction } from "./fixtures.js";

// The source suite exercises the real Overseer/SQLite, not the receiver or its push transport.
// Its remote boundary is the controlled syncWorkspaceAttention stub installed by setup().
vi.mock("../src/user.js", async () => {
  const { DurableObject, WorkerEntrypoint } = await import("cloudflare:workers");
  return {
    UserDurableObject: class extends DurableObject {},
    GatekeeperConnectCallbackImpl: class extends WorkerEntrypoint {},
  };
});

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    }
  }
}

type Impl = OverseerDurableObject["impl"];
const OWNER = "attention-owner";
const AUTHOR: AiChatAuthorInfo = { type: "user", id: "owner", name: "Private owner name" };
const EPOCH = 1_700_000_000_000;

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Attention tests forbid provider calls"));
});
afterEach(() => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
  finally { vi.restoreAllMocks(); }
});

function inOverseer(name: string, fn: (impl: Impl, instance: OverseerDurableObject) => Promise<void>) {
  return runInDurableObject(env.TEST_OVERSEER.getByName(`attention-${name}`),
    (instance: OverseerDurableObject) => fn(instance["impl"], instance));
}

function setup(impl: Impl) {
  impl.ownerId = OWNER;
  const sync = vi.fn(async (_workspaceId: string, _snapshot: WorkspaceAttentionSnapshot) => {});
  Object.assign(impl, { users: { idFromString: (id: string) => id,
    get: () => ({ syncWorkspaceAttention: sync, whoami: async () => AUTHOR }) } });
  return sync;
}

function run(id: number, status: TaskRun["status"] = "finished"): TaskRun {
  const base = { id: `task-${id.toString().padStart(3, "0")}`, chatId: 1, sourceSequence: id,
    source: { type: "prompt" as const }, startedAt: new Date(EPOCH + id),
    updatedAt: new Date(EPOCH + id), attempt: 1, lastSequence: id };
  return status === "admitted" || status === "running" ? { ...base, status } :
    { ...base, status, reason: status === "waiting" ? "action_approval" : "model_stop" };
}

function message(sequence: number, body: AiChatMessageBody, chatId = 1): AiChatMessage {
  return { chatId, sequence, timestamp: new Date(EPOCH + chatId * 1_000 + sequence), author: AUTHOR, ...body };
}

function connection(sequence: number) {
  return message(sequence, { type: "connectionRequest", requestId: `1:request-${sequence}`,
    vendorId: "private-vendor", vendorName: "Private service", reason: "Private rationale",
    resourceUrl: "https://private.example/secret", state: "pending" });
}

function entries(impl: Impl) { return impl.attentionSnapshot()!.entries; }
function source(impl: Impl, sourceId: string) { return impl.storage.attentionSources.get(sourceId)!; }
function finishBootstrap(impl: Impl) {
  for (let i = 0; i < 20 && !impl.attentionSnapshot()?.complete; i++) {
    impl.bootstrapAttention(impl.storage.attentionProgress.get()!.bootstrapAt);
  }
  expect(impl.attentionSnapshot()?.complete).toBe(true);
}

describe("workspace attention projection", () => {
  it("does no bootstrap work without an owner/request, then examines only 50 records per alarm", () =>
    inOverseer("bootstrap-bounds", async (impl, instance) => {
      expect(impl.attentionSnapshot()).toBeUndefined();
      expect(await impl.ctx.storage.getAlarm()).toBeNull();
      impl.storage.chatMeta.put({ id: 1, title: "Unused chat", started: new Date(1), lastActive: new Date(1) });
      impl.storage.chatMeta.delete(1);
      for (let i = 0; i < 60; i++) {
        impl.storage.taskRuns.put(run(i));
        putAction(impl.storage, i);
        impl.storage.chats.put(message(i, { type: "message", message: "Private old prose" }));
      }
      expect(impl.attentionSnapshot()).toBeUndefined();
      await expect(instance.initializeAttention(OWNER)).rejects.toThrow("owner");
      const sync = setup(impl);
      await expect(instance.initializeAttention("collaborator")).rejects.toThrow("owner");
      await instance.initializeAttention(OWNER);
      expect(entries(impl)).toEqual([]);
      expect(sync).not.toHaveBeenCalled();
      expect(await impl.ctx.storage.getAlarm()).not.toBeNull();
      impl.bootstrapAttention(impl.storage.attentionProgress.get()!.bootstrapAt);
      expect(entries(impl)).toHaveLength(50);
      expect(impl.storage.attentionProgress.get()?.bootstrap).toEqual({ phase: "tasks", cursor: "task-049" });
      impl.bootstrapAttention(impl.storage.attentionProgress.get()!.bootstrapAt);
      expect(entries(impl)).toHaveLength(100);
      expect(impl.storage.attentionProgress.get()?.bootstrap).toEqual({ phase: "actions", cursor: 39 });
      impl.bootstrapAttention(impl.storage.attentionProgress.get()!.bootstrapAt);
      expect(impl.storage.attentionProgress.get()?.bootstrap).toMatchObject({
        phase: "chats", cursor: `${keyString(1)}.${keyString(30)}`,
      });
      expect(impl.attentionSnapshot()?.complete).toBe(false);
      finishBootstrap(impl);
      expect(entries(impl).every(entry => !entry.notify)).toBe(true);
      expect(impl.attentionSnapshot()?.truncated).toBe(true);
      const revision = impl.attentionSnapshot()!.revision;
      await instance.initializeAttention(OWNER);
      expect(impl.attentionSnapshot()!.revision).toBe(revision);
    }));

  it("versions meaningful run outcomes, not evidence, reads, delivery or owner seen state", () =>
    inOverseer("run-versions", async (impl, instance) => {
      const sync = setup(impl);
      const task = run(1);
      impl.storage.taskRuns.put(task);
      finishBootstrap(impl);
      const first = source(impl, `run:${task.id}`);
      const snapshot = impl.attentionSnapshot();
      impl.storage.taskRuns.put({ ...task, lastSequence: 900, updatedAt: new Date(EPOCH + 9_000) });
      expect(impl.attentionSnapshot()).toEqual(snapshot);
      expect(await instance.canNotifyAttention(OWNER, first.sourceId, first.version)).toBe(true);
      expect(await instance.canNotifyAttention("collaborator", first.sourceId, first.version)).toBe(false);
      await impl.deliverAttention(impl.storage.attentionProgress.get()!.deliveryAt);
      expect(sync).toHaveBeenCalledOnce();
      expect(source(impl, first.sourceId)).toEqual(first);
      expect(impl.storage.attentionProgress.get()?.dirtyRevision).toBeUndefined();
      expect(await instance.canNotifyAttention(OWNER, first.sourceId, first.version)).toBe(true);
      impl.storage.taskRuns.put({ ...task, status: "incomplete", reason: "step_limit", updatedAt: new Date(EPOCH + 10_000) });
      expect(source(impl, first.sourceId)).toMatchObject({ state: "incomplete", reason: "step_limit", notify: true });
      expect(source(impl, first.sourceId).version).toBeGreaterThan(first.version);
      expect(await instance.canNotifyAttention(OWNER, first.sourceId, first.version)).toBe(false);
      impl.storage.taskRuns.put(run(1, "running"));
      expect(entries(impl)).toEqual([]);
      const removedRevision = impl.attentionSnapshot()!.revision;
      impl.storage.taskRuns.put(run(1, "waiting"));
      expect(impl.attentionSnapshot()!.revision).toBe(removedRevision);
      putAction(impl.storage, 1);
      putAction(impl.storage, 1, { state: "approved", appliedAt: new Date() });
      expect(entries(impl).map(entry => [entry.kind, entry.state])).toEqual([["action", "resolved"]]);
    }));

  it.each(["finished", "failed", "incomplete", "canceled"] as const)("projects terminal %s without claiming success", status =>
    inOverseer(`terminal-${status}`, async impl => {
      setup(impl);
      impl.storage.taskRuns.put(run(1, status));
      expect(entries(impl)).toMatchObject([{ kind: "run", state: status, notify: true }]);
    }));

  it("uses canonical action callbacks before the row write and never duplicates transcript action cards", () =>
    inOverseer("canonical-actions", async impl => {
      setup(impl);
      putAction(impl.storage, 1);
      putAction(impl.storage, 2, { type: "observation" });
      putAction(impl.storage, 3, { type: "bindHook" });
      impl.storage.chats.put(message(0, { type: "action", actionId: 1 }));
      expect(entries(impl)).toHaveLength(1);
      const beforeWrite = vi.fn(() => {
        expect(impl.storage.actions.get(1)?.state).toBe("pending");
        expect(source(impl, "action:1")).toMatchObject({ state: "resolved", notify: false });
      });
      const subscriber = { add() {}, update: beforeWrite, remove() {} };
      impl.storage.actions.subscribe(subscriber);
      putAction(impl.storage, 1, { state: "approved", appliedAt: new Date(EPOCH + 10) });
      impl.storage.actions.unsubscribe(subscriber);
      expect(beforeWrite).toHaveBeenCalledOnce();
      expect(source(impl, "action:1").updatedAt).toEqual(new Date(EPOCH + 10));
      const revision = impl.attentionSnapshot()!.revision;
      impl.storage.actions.delete(1);
      expect(entries(impl)).toEqual([]);
      expect(impl.attentionSnapshot()!.revision).toBeGreaterThan(revision);
      finishBootstrap(impl);
      expect(entries(impl)).toEqual([]);
    }));

  it("projects proposal, connection and human lifecycles with no private text or capabilities", () =>
    inOverseer("cards-redaction", async (impl, instance) => {
      setup(impl);
      const proposal = message(0, { type: "agentProposal", proposalId: "proposal-id", agentId: "bot",
        agentName: "Private bot", artifactId: "artifact", reason: "Private rationale", state: "pending",
        draft: { kind: "skill", value: { name: "Private name", description: "Private description", body: "SECRET" } } });
      const request = connection(1);
      const human = message(2, { type: "computerHumanTakeover", requestId: "human-id", reason: "SECRET",
        currentUrl: "https://private.example/secret", state: "pending" });
      for (const msg of [proposal, request, human]) impl.storage.chats.put(msg);
      expect(entries(impl).map(entry => entry.kind)).toEqual(["human", "connection", "proposal"]);
      const json = JSON.stringify(impl.attentionSnapshot());
      for (const privateText of ["Private", "SECRET", "private.example", "proposal-id", "artifact", "human-id"]) {
        expect(json).not.toContain(privateText);
      }
      for (const msg of [proposal, request, human]) {
        const id = `message:1:${msg.sequence}`;
        const pending = source(impl, id);
        expect(await instance.canNotifyAttention(OWNER, id, pending.version)).toBe(true);
        if (msg.type === "agentProposal") {
          const decidedAt = new Date(EPOCH + 20_000);
          impl.storage.chats.put({ ...msg, state: "accepting", decidedAt });
          expect(source(impl, id)).toMatchObject({ state: "accepting", notify: false, updatedAt: decidedAt });
          const accepting = source(impl, id).version;
          impl.storage.chats.put({ ...msg, state: "accepted", decidedAt, receipt: { createdAt: decidedAt, missing: false } });
          expect(source(impl, id).version).toBeGreaterThan(accepting);
        } else if (msg.type === "connectionRequest") {
          impl.storage.chats.put({ ...msg, state: "denied" });
        } else if (msg.type === "computerHumanTakeover") {
          impl.storage.chats.put({ ...msg, state: "approved" });
        }
        expect(source(impl, id)).toMatchObject({ state: "resolved", notify: false });
        expect(await instance.canNotifyAttention(OWNER, id, pending.version)).toBe(false);
      }
    }));

  it("rechecks canonical source state rather than treating a retained projection as authority", () =>
    inOverseer("canonical-recheck", async (impl, instance) => {
      setup(impl);
      putAction(impl.storage, 1);
      const entry = source(impl, "action:1");
      // A separate schema view bypasses only the projection subscriber, simulating stale derived data.
      const canonical = makeOverseerStorage(impl.ctx.storage);
      putAction(canonical, 1, { state: "approved", appliedAt: new Date() });
      expect(source(impl, entry.sourceId)).toEqual(entry);
      expect(await instance.canNotifyAttention(OWNER, entry.sourceId, entry.version)).toBe(false);
    }));

  it("resolves retained output changes on canonical merge/revert and does not reopen resolved batches", () =>
    inOverseer("changes", async (impl, instance) => {
      setup(impl);
      const change = (seq: number) => message(seq, { type: "changes",
        createdGadgets: [{ gadgetId: seq + 1, title: "Secret output", bindingName: "SECRET" }] });
      impl.storage.chats.put(change(1));
      impl.storage.chats.put(change(2));
      impl.storage.chats.put(message(3, { type: "revert", revertFrom: 2 }));
      expect(source(impl, "message:1:1").state).toBe("pending");
      const reverted = source(impl, "message:1:2");
      expect(reverted).toMatchObject({ state: "resolved", notify: false, updatedAt: message(3, { type: "message", message: "" }).timestamp });
      impl.storage.chats.put(message(4, { type: "merge", mergeThrough: 3, commits: [] }));
      expect(source(impl, "message:1:1")).toMatchObject({ state: "resolved", notify: false });
      expect(source(impl, "message:1:2")).toEqual(reverted);
      expect(await instance.canNotifyAttention(OWNER, reverted.sourceId, reverted.version)).toBe(false);
      finishBootstrap(impl);
      expect(entries(impl).every(entry => entry.state === "resolved")).toBe(true);
    }));

  it("rechecks live changes in constant work even with a long decision history", () =>
    inOverseer("changes-notify-bound", async (impl, instance) => {
      setup(impl);
      impl.storage.chats.put(message(0, { type: "changes", change: { 1: [["file", { set: "private" }]] } }));
      for (let seq = 1; seq <= 100; seq++) {
        impl.storage.chats.put(message(seq, { type: "revert", revertFrom: 1 }));
      }
      const entry = source(impl, "message:1:0");
      const decisions = vi.spyOn(impl.storage.taskChangeDecisions, "list");
      const transcript = vi.spyOn(impl.storage.chats, "list");
      expect(await instance.canNotifyAttention(OWNER, entry.sourceId, entry.version)).toBe(true);
      expect(() => impl.storage.transaction(() => {
        impl.storage.chats.put(message(101, { type: "merge", mergeThrough: 100, commits: [] }));
        throw new Error("rollback decision");
      })).toThrow("rollback decision");
      expect(await instance.canNotifyAttention(OWNER, entry.sourceId, entry.version)).toBe(true);
      impl.storage.chats.put(message(101, { type: "merge", mergeThrough: 100, commits: [] }));
      expect(source(impl, entry.sourceId)).toMatchObject({ state: "resolved", notify: false });
      expect(await instance.canNotifyAttention(OWNER, entry.sourceId, entry.version)).toBe(false);
      expect(decisions).not.toHaveBeenCalled();
      expect(transcript).not.toHaveBeenCalled();
    }));

  it("deletes every chat message and run projection without invalidating the outer iterator or skipping sources", () =>
    inOverseer("delete-chat", async (impl, instance) => {
      const sync = setup(impl);
      vi.spyOn(impl, "ensureAmbientCapsules").mockResolvedValue(undefined);
      vi.spyOn(impl, "markOutputsDirty").mockImplementation(() => {});
      for (const id of [1, 2]) {
        impl.storage.chatMeta.put({ id, title: "Private chat", started: new Date(id), lastActive: new Date(id) });
      }
      for (const id of [1, 2, 3]) impl.storage.taskRuns.put(run(id));
      const otherRun = { ...run(4), chatId: 2 };
      impl.storage.taskRuns.put(otherRun);
      impl.storage.chats.put(message(0, { type: "changes", change: { 1: [["keep", { set: "private" }]] } }, 2));
      for (let seq = 0; seq < 150; seq++) {
        const body: AiChatMessageBody = seq % 50 === 0 ?
          { type: "changes", change: { 1: [["file", { set: "private" }]] } } :
          { type: "message", message: "Private evidence" };
        impl.storage.chats.put({ ...message(seq, body), runId: run(Math.floor(seq / 50) + 1).id });
      }
      impl.storage.chats.put(message(150, { type: "merge", mergeThrough: 149, commits: [] }));
      putAction(impl.storage, 1); // Canonical workspace requests survive removal of their transcript.
      const canonicalAction = { ...impl.storage.actions.get(1)!,
        caller: { from: "agent" as const, chatId: 1, runId: run(1).id } };
      impl.storage.actions.put(canonicalAction);
      finishBootstrap(impl);
      await impl.deliverAttention(impl.storage.attentionProgress.get()!.deliveryAt);
      const before = impl.attentionSnapshot()!;
      const removed = before.entries.filter(entry => entry.chatId === 1 && entry.kind !== "action");
      expect(removed.filter(entry => entry.kind === "run")).toHaveLength(3);
      expect(removed.filter(entry => entry.kind === "changes")).toHaveLength(3);
      const pendingAction = source(impl, "action:1");
      expect(pendingAction).toMatchObject({ state: "pending", chatId: 1, notify: true });
      const transitions: { operation: string; entry: AttentionProjection }[] = [];
      const record = (operation: string, entry: AttentionProjection) => {
        if (entry.sourceId === pendingAction.sourceId) transitions.push({ operation, entry });
      };
      const subscriber: Subscriber<AttentionProjection> = {
        add: entry => record("add", entry), update: (_old, entry) => record("update", entry),
        remove: entry => record("remove", entry),
      };
      using closed = new NativeRpcStub<() => void>(() => {});
      using client = new RpcStub(await instance.open(OWNER, AUTHOR.id, closed));
      impl.storage.attentionSources.subscribe(subscriber);
      try { await client.deleteChat(1); }
      finally { impl.storage.attentionSources.unsubscribe(subscriber); }
      expect([...impl.storage.chats.list({ prefix: `${keyString(1)}.` })]).toEqual([]);
      expect([...impl.storage.taskRuns.byChatSource.list({ prefix: `${keyString(1)}.` })]).toEqual([]);
      expect([...impl.storage.taskChangeDecisions.list({ prefix: `${keyString(1)}.` })]).toEqual([]);
      for (const entry of removed) {
        expect(impl.storage.attentionSources.get(entry.sourceId)).toBeUndefined();
        expect(await instance.canNotifyAttention(OWNER, entry.sourceId, entry.version)).toBe(false);
      }
      expect(impl.storage.actions.get(1)).toEqual(canonicalAction);
      const workspaceAction = source(impl, "action:1");
      expect(workspaceAction).toEqual({ ...pendingAction, chatId: undefined, notify: false,
        version: expect.any(Number) });
      expect(workspaceAction.version).toBeGreaterThan(pendingAction.version);
      expect(transitions).toEqual([{ operation: "update", entry: workspaceAction }]);
      expect(await instance.canNotifyAttention(OWNER, workspaceAction.sourceId, pendingAction.version)).toBe(false);
      expect(await instance.canNotifyAttention(OWNER, workspaceAction.sourceId, workspaceAction.version)).toBe(false);
      expect(entries(impl).map(entry => entry.sourceId).toSorted()).toEqual([
        "action:1", "message:2:0", `run:${otherRun.id}`,
      ].toSorted());
      expect(impl.attentionSnapshot()!.revision).toBeGreaterThan(before.revision);
      await impl.deliverAttention(impl.storage.attentionProgress.get()!.deliveryAt);
      expect(sync.mock.calls.at(-1)![1]).toEqual(impl.attentionSnapshot());
      expect(sync.mock.calls.at(-1)![1].entries.find(entry => entry.sourceId === "action:1"))
        .toEqual(workspaceAction);
      const after = impl.attentionSnapshot();
      await client.deleteChat(1);
      impl.storage.actions.put(canonicalAction);
      expect(impl.attentionSnapshot()).toEqual(after);
    }));

  it("normalizes missing action chats in bootstrap, live writes and canonical notification rechecks", () =>
    inOverseer("action-chat-navigation", async (impl, instance) => {
      impl.storage.chatMeta.put({ id: 1, title: "Old chat", started: new Date(1), lastActive: new Date(1) });
      putAction(impl.storage, 1);
      impl.storage.chatMeta.delete(1);
      expect(impl.attentionSnapshot()).toBeUndefined();
      setup(impl);
      impl.initializeAttention();
      finishBootstrap(impl);
      expect(source(impl, "action:1")).toMatchObject({ state: "pending", chatId: undefined, notify: false });
      putAction(impl.storage, 2);
      const live = source(impl, "action:2");
      expect(live).toMatchObject({ state: "pending", chatId: undefined, notify: true });
      expect(await instance.canNotifyAttention(OWNER, live.sourceId, live.version)).toBe(true);
      putAction(impl.storage, 2, { state: "approved", appliedAt: new Date() });
      expect(source(impl, live.sourceId)).toMatchObject({ state: "resolved", chatId: undefined, notify: false });
      impl.storage.chatMeta.put({ id: 1, title: "Live chat", started: new Date(1), lastActive: new Date(1) });
      putAction(impl.storage, 3);
      const stale = source(impl, "action:3");
      expect(stale).toMatchObject({ state: "pending", chatId: 1, notify: true });
      // Bypass only the subscriber to prove the canonical point read rejects a stale chat link.
      makeOverseerStorage(impl.ctx.storage).chatMeta.delete(1);
      expect(source(impl, stale.sourceId)).toEqual(stale);
      expect(await instance.canNotifyAttention(OWNER, stale.sourceId, stale.version)).toBe(false);
    }));

  it("clears action navigation before chat row deletion in one bounded, rollback-safe scan", () =>
    inOverseer("action-chat-removal-barrier", async impl => {
      setup(impl);
      for (const id of [1, 2]) {
        impl.storage.chatMeta.put({ id, title: "Chat", started: new Date(id), lastActive: new Date(id) });
      }
      for (let id = 0; id < 105; id++) putAction(impl.storage, id);
      const before = impl.attentionSnapshot();
      const actionsScan = vi.spyOn(impl.storage.actions, "list");
      const projectionsScan = vi.spyOn(impl.storage.attentionSources, "list");
      const beforeDelete = vi.fn(() => {
        expect(impl.storage.chatMeta.get(1)).toBeDefined();
        expect(source(impl, "action:104")).toMatchObject({ state: "pending", chatId: undefined, notify: false });
      });
      const subscriber = { add() {}, update() {}, remove: beforeDelete };
      impl.storage.chatMeta.subscribe(subscriber);
      try {
        expect(() => impl.storage.transaction(() => {
          impl.storage.chatMeta.delete(1);
          throw new Error("rollback chat deletion");
        })).toThrow("rollback chat deletion");
        expect(impl.attentionSnapshot()).toEqual(before);
        projectionsScan.mockClear();
        impl.storage.chatMeta.delete(1);
        expect(projectionsScan).toHaveBeenCalledExactlyOnceWith({ limit: 100 });
        expect(actionsScan).not.toHaveBeenCalled();
        expect(beforeDelete).toHaveBeenCalledTimes(2);
      } finally { impl.storage.chatMeta.unsubscribe(subscriber); }
      const after = impl.attentionSnapshot();
      expect(after?.entries).toHaveLength(100);
      expect(after?.entries.every(entry => entry.state === "pending" && entry.chatId === undefined && !entry.notify)).toBe(true);
      expect(impl.storage.actions.get(0)?.state).toBe("pending");
      expect(impl.storage.actions.get(104)?.state).toBe("pending");
      impl.storage.chatMeta.delete(1);
      impl.storage.chatMeta.delete(2); // No retained source links this chat.
      expect(impl.attentionSnapshot()).toEqual(after);
    }));

  it("backfills old current sources without fake outcomes or pending already-decided output", () =>
    inOverseer("legacy", async impl => {
      impl.storage.chats.put(message(0, { type: "error", message: "It looks like failure" }));
      impl.storage.chats.put(message(1, { type: "message", message: "It looks like success" }));
      impl.storage.chats.put(message(2, { type: "changes", conversionBoundary: true }));
      impl.storage.chats.put(message(3, { type: "changes", change: { 1: [["secret.txt", { set: "SECRET" }]] } }));
      for (let seq = 4; seq < 70; seq++) impl.storage.chats.put(message(seq, { type: "message", message: "Old evidence" }));
      impl.storage.chats.put(message(70, { type: "merge", mergeThrough: 69, commits: [] }));
      // Also exercise old decisions that predate the sparse decision index.
      impl.storage.taskChangeDecisions.delete(`${keyString(1)}.${keyString(70)}`);
      impl.storage.chats.put(connection(71));
      setup(impl);
      impl.initializeAttention();
      impl.bootstrapAttention(impl.storage.attentionProgress.get()!.bootstrapAt);
      expect(entries(impl)).toMatchObject([{ kind: "connection", state: "pending", notify: false }]);
      finishBootstrap(impl);
      expect(entries(impl).map(entry => [entry.kind, entry.state, entry.notify]))
        .toEqual([["connection", "pending", false], ["changes", "resolved", false]]);
      expect(source(impl, "message:1:3").updatedAt).toEqual(new Date(EPOCH + 1_070));
    }));

  it("rolls back projections, bootstrap intent, revisions and alarms with the real agent step barrier", () =>
    inOverseer("barrier-rollback", async impl => {
      const sync = setup(impl);
      impl.storage.chatMeta.put({ id: 1, title: "Private chat", started: new Date(), lastActive: new Date() });
      impl.addChatMessages(1, AUTHOR, [{ type: "message", message: "Private prompt" }]);
      const task = impl.admitTaskRun(1, 0, { type: "prompt" });
      const failure: Subscriber<TaskRun> = { add() {}, remove() {}, update: (_old, next) => {
        if (next.status === "finished") {
          expect(entries(impl).some(entry => entry.kind === "connection")).toBe(true);
          expect(entries(impl).some(entry => entry.kind === "run")).toBe(true);
          throw new Error("Reject barrier after source projection");
        }
      } };
      impl.storage.taskRuns.subscribe(failure);
      try {
        await expect(impl.commitAgentStep(1, AUTHOR, [connection(1)], {
          changes: [], createdGadgets: [], addedBindings: [],
          run: { id: task.id, attempt: task.attempt, disposition: { status: "finished", reason: "model_stop" } },
        })).rejects.toThrow("Reject barrier");
      } finally { impl.storage.taskRuns.unsubscribe(failure); }
      expect(impl.attentionSnapshot()).toBeUndefined();
      expect([...impl.storage.attentionSources.list()]).toEqual([]);
      expect(impl.storage.taskRuns.get(task.id)).toEqual(task);
      expect([...impl.storage.chats.list()]).toHaveLength(1);
      expect(await impl.ctx.storage.getAlarm()).toBeNull();
      await impl.deliverAttention(Number.MAX_SAFE_INTEGER);
      expect(sync).not.toHaveBeenCalled();
    }));

  it("uses the earliest covering output decision during bootstrap, not a later overlapping merge", () =>
    inOverseer("bootstrap-decision-order", async impl => {
      for (const seq of [1, 2, 5]) {
        impl.storage.chats.put(message(seq, { type: "changes", change: { 1: [["file", { set: "private" }]] } }));
      }
      impl.storage.chats.put(message(3, { type: "revert", revertFrom: 2 }));
      impl.storage.chats.put(message(4, { type: "merge", mergeThrough: 3, commits: [] }));
      impl.storage.chats.put(message(6, { type: "merge", mergeThrough: 5, commits: [] }));
      setup(impl);
      impl.initializeAttention();
      finishBootstrap(impl);
      expect(entries(impl).map(entry => [entry.sequence, entry.updatedAt.valueOf() - EPOCH - 1_000]))
        .toEqual([[5, 6], [1, 4], [2, 3]]);
      expect(entries(impl).every(entry => entry.state === "resolved" && !entry.notify)).toBe(true);
    }));

  it.each(["resolve", "delete"])("bounds decision scans and can %s a source across its saved cursor", mode =>
    inOverseer(`bootstrap-decision-cursor-${mode}`, async impl => {
      impl.storage.chats.put(message(0, { type: "changes", change: { 1: [["file", { set: "private" }]] } }));
      for (let seq = 1; seq <= 60; seq++) {
        impl.storage.chats.put(message(seq, { type: "revert", revertFrom: 1 }));
      }
      impl.storage.chats.put(message(61, { type: "merge", mergeThrough: 60, commits: [] }));
      setup(impl);
      impl.initializeAttention();
      impl.bootstrapAttention(impl.storage.attentionProgress.get()!.bootstrapAt);
      impl.bootstrapAttention(impl.storage.attentionProgress.get()!.bootstrapAt);
      expect(entries(impl)).toEqual([]);
      expect(impl.storage.attentionProgress.get()?.bootstrap).toMatchObject({ phase: "chats",
        cursor: `${keyString(1)}.${keyString(0)}`,
        change: { decisionCursor: `${keyString(1)}.${keyString(37)}` },
      });
      if (mode === "delete") impl.storage.chats.delete(`${keyString(1)}.${keyString(0)}`);
      finishBootstrap(impl);
      expect(entries(impl)).toHaveLength(mode === "delete" ? 0 : 1);
      if (mode === "resolve") {
        expect(entries(impl)[0]).toMatchObject({ state: "resolved", notify: false, updatedAt: new Date(EPOCH + 1_061) });
      }
    }));

  it("caps retention by actual transition time with sticky overflow, without deleting pending requests", () =>
    inOverseer("retention", async impl => {
      setup(impl);
      for (let id = 0; id < 105; id++) putAction(impl.storage, id, { createdAt: new Date(EPOCH + 105 - id) });
      expect(entries(impl)).toHaveLength(100);
      expect(entries(impl)[0].sourceId).toBe("action:0");
      expect(entries(impl).at(-1)?.sourceId).toBe("action:99");
      expect([...impl.storage.actions.list()]).toHaveLength(105);
      const snapshot = impl.attentionSnapshot();
      putAction(impl.storage, 104, { createdAt: new Date(EPOCH + 999_999) });
      expect(impl.attentionSnapshot()).toEqual(snapshot); // timestamp-only updates cannot revive eviction
      impl.storage.actions.delete(0);
      expect(entries(impl)).toHaveLength(99);
      expect(impl.attentionSnapshot()?.truncated).toBe(true);
      finishBootstrap(impl);
      expect(entries(impl)).toHaveLength(100);
      expect(impl.storage.actions.get(100)?.state).toBe("pending");
      expect(impl.storage.actions.get(104)?.state).toBe("pending");
      expect(entries(impl).some(entry => entry.sourceId === "action:0")).toBe(false);
    }));

  it("increments snapshot privacy revisions, rejects push from sensitive sources and rolls privacy back atomically", () =>
    inOverseer("privacy", async (impl, instance) => {
      setup(impl);
      putAction(impl.storage, 1);
      const pending = source(impl, "action:1");
      const before = impl.attentionSnapshot();
      expect(() => impl.storage.transaction(() => {
        impl.storage.prohibitAllSharing.put(true);
        throw new Error("rollback privacy");
      })).toThrow("rollback privacy");
      expect(impl.attentionSnapshot()).toEqual(before);
      expect(await instance.canNotifyAttention(OWNER, pending.sourceId, pending.version)).toBe(true);
      impl.storage.prohibitAllSharing.put(true);
      expect(impl.attentionSnapshot()?.prohibitPush).toBe(true);
      expect(impl.attentionSnapshot()!.revision).toBeGreaterThan(before!.revision);
      expect(source(impl, pending.sourceId)).toEqual(pending);
      expect(await instance.canNotifyAttention(OWNER, pending.sourceId, pending.version)).toBe(false);
      const sensitive = impl.attentionSnapshot();
      impl.storage.prohibitAllSharing.put(true);
      expect(impl.attentionSnapshot()).toEqual(sensitive);
      impl.storage.prohibitAllSharing.put(false);
      expect(impl.attentionSnapshot()!.revision).toBeGreaterThan(sensitive!.revision);
    }));

  it("coalesces full snapshots, retries beyond six failures, and only clears the acknowledged revision", () =>
    inOverseer("delivery-race", async impl => {
      const sync = setup(impl);
      putAction(impl.storage, 1);
      putAction(impl.storage, 2);
      finishBootstrap(impl);
      sync.mockRejectedValue(new Error("receiver unavailable"));
      for (let attempt = 0; attempt < 9; attempt++) {
        const due = impl.storage.attentionProgress.get()!.deliveryAt!;
        await impl.deliverAttention(due - 1);
        expect(sync).toHaveBeenCalledTimes(attempt);
        await impl.deliverAttention(due);
        expect(sync).toHaveBeenCalledTimes(attempt + 1);
        expect(impl.storage.attentionProgress.get()?.deliveryAt)
          .toBe(due + Math.min(60_000 * 2 ** attempt, 3_600_000));
        expect(impl.storage.attentionProgress.get()?.dirtyRevision).toBe(impl.attentionSnapshot()!.revision);
      }
      const ack = Promise.withResolvers<void>();
      const sent = Promise.withResolvers<void>();
      sync.mockImplementationOnce(async () => { sent.resolve(); await ack.promise; });
      const delivery = impl.deliverAttention(impl.storage.attentionProgress.get()!.deliveryAt);
      await sent.promise;
      const inFlight = sync.mock.calls.at(-1)![1];
      expect(inFlight.entries).toHaveLength(2);
      impl.storage.actions.delete(1);
      impl.storage.prohibitAllSharing.put(true);
      const latestRevision = impl.attentionSnapshot()!.revision;
      ack.resolve();
      await delivery;
      expect(impl.storage.attentionProgress.get()?.dirtyRevision).toBe(latestRevision);
      sync.mockResolvedValue(undefined);
      await impl.deliverAttention(impl.storage.attentionProgress.get()!.deliveryAt);
      const latest = sync.mock.calls.at(-1)![1];
      expect(latest).toMatchObject({ revision: latestRevision, prohibitPush: true, complete: true });
      expect(latest.entries.map(entry => entry.sourceId)).toEqual(["action:2"]);
      expect(impl.storage.attentionProgress.get()?.dirtyRevision).toBeUndefined();
      expect(await impl.ctx.storage.getAlarm()).toBeNull();
    }));

  it("persists cursor and retry intent across eviction without restarting bootstrap", async () => {
    let before: ReturnType<Impl["attentionSnapshot"]>;
    let progress: ReturnType<Impl["storage"]["attentionProgress"]["get"]>;
    await inOverseer("restart", async impl => {
      for (let i = 0; i < 75; i++) putAction(impl.storage, i);
      const sync = setup(impl);
      impl.storage.version.put(3);
      impl.storage.ownerId.put(OWNER);
      impl.initializeAttention();
      impl.bootstrapAttention(impl.storage.attentionProgress.get()!.bootstrapAt);
      sync.mockRejectedValue(new Error("offline"));
      await impl.deliverAttention(impl.storage.attentionProgress.get()!.deliveryAt);
      before = impl.attentionSnapshot();
      progress = impl.storage.attentionProgress.get();
    });
    await abortAllDurableObjects();
    await inOverseer("restart", async impl => {
      setup(impl);
      expect(impl.attentionSnapshot()).toEqual(before);
      expect(impl.storage.attentionProgress.get()).toEqual(progress);
      finishBootstrap(impl);
      expect(entries(impl)).toHaveLength(75);
      expect(entries(impl).every(entry => !entry.notify)).toBe(true);
    });
  });

  it.each(["acknowledges", "rejects"])("times out a hung receiver and ignores an old RPC that later %s", outcome =>
    inOverseer(`delivery-timeout-${outcome}`, async (impl, instance) => {
      const sync = setup(impl);
      putAction(impl.storage, 1);
      finishBootstrap(impl);
      const progress = impl.storage.attentionProgress.get()!;
      impl.storage.attentionProgress.put({ ...progress, deliveryAt: Date.now() - 1 });
      const oldAck = Promise.withResolvers<void>();
      const oldSent = Promise.withResolvers<void>();
      const retryAck = Promise.withResolvers<void>();
      const retrySent = Promise.withResolvers<void>();
      sync.mockImplementationOnce(async () => { oldSent.resolve(); await oldAck.promise; })
        .mockImplementationOnce(async () => { retrySent.resolve(); await retryAck.promise; });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const returned = vi.fn();
        const alarm = instance.alarm().then(returned);
        await oldSent.promise;
        await vi.advanceTimersByTimeAsync(9_999);
        expect(returned).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await alarm;
        expect(returned).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        const failed = impl.storage.attentionProgress.get()!;
        expect(failed.failures).toBe(1);
        expect(failed.dirtyRevision).toBe(progress.revision);
        expect(failed.deliveryAt).toBeGreaterThanOrEqual(Date.now() + 59_000);
        expect(await impl.ctx.storage.getAlarm()).toBe(failed.deliveryAt);
        impl.storage.actions.delete(1);
        putAction(impl.storage, 2);
        const retry = impl.deliverAttention(failed.deliveryAt);
        await retrySent.promise;
        const inFlight = impl.storage.attentionProgress.get();
        expect(sync.mock.calls[1][1].entries.map(entry => entry.sourceId)).toEqual(["action:2"]);
        if (outcome === "acknowledges") oldAck.resolve();
        else oldAck.reject(new Error("late receiver rejection"));
        await vi.advanceTimersByTimeAsync(0);
        expect(impl.storage.attentionProgress.get()).toEqual(inFlight);
        await impl.deliverAttention(Number.MAX_SAFE_INTEGER);
        expect(sync).toHaveBeenCalledTimes(2); // The late call did not clear the new single-flight guard.
        retryAck.resolve();
        await retry;
        expect(impl.storage.attentionProgress.get()?.dirtyRevision).toBeUndefined();
        expect(impl.storage.attentionProgress.get()?.failures).toBe(0);
        expect(await impl.ctx.storage.getAlarm()).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        oldAck.resolve();
        retryAck.resolve();
        vi.useRealTimers();
      }
    }));

  it("services attention during a stalled agent and preserves retries through pause and external-response planning", () =>
    inOverseer("alarm-coexistence", async (impl, instance) => {
      const sync = setup(impl);
      const model: UserAiModelRecord = { profile: { type: "agent", id: "model", name: "Model" },
        config: { provider: "anthropic", model: "test", apiToken: "unused" } };
      impl.storage.gadgetResponseDeliveries.put({ idempotencyKey: "receipt", chatId: 1,
        promptSequence: 0, status: "delivered", createdAt: Date.now(), deliveredAt: Date.now() });
      impl.storage.chatMeta.put({ id: 1, title: "Chat", started: new Date(), lastActive: new Date(), activeAgent: model.profile });
      const release = Promise.withResolvers<void>();
      vi.spyOn(impl, "reconcilePendingGadgets").mockResolvedValue(undefined).mockReturnValueOnce(release.promise);
      vi.spyOn(impl, "markOutputsDirty").mockImplementation(() => {});
      impl.startAgent(1, model, AUTHOR, OWNER);
      const retriedWhileBusy = vi.fn();
      using target = new NativeRpcStub(new class extends NativeRpcTarget {
        async onGadgetResponse() { retriedWhileBusy(); }
      }());
      // This pool cannot persist transient native targets. Only the ready-index lookup is mocked;
      // the live agent registry, attention storage and shared alarm planner remain real.
      const readyScan = vi.spyOn(impl.storage.gadgetResponseDeliveries.readyByIdempotencyKey, "list")
        .mockReturnValue([{ idempotencyKey: "busy-response", chatId: 1, promptSequence: 0,
          status: "ready", createdAt: Date.now(), responseText: "Private response", chatGatewayRpcTarget: target }]);
      impl.updateAlarm();
      const keepalive = await impl.ctx.storage.getAlarm();
      // Starting a turn now publishes Working in the roster before the next keepalive.
      expect(keepalive).toBeLessThanOrEqual(Date.now() + 2_000);
      expect(impl.attentionSnapshot()?.roster?.working).toBe(true);
      putAction(impl.storage, 1);
      expect(await impl.ctx.storage.getAlarm()).toBeLessThanOrEqual(keepalive!);
      // Advance just the persisted deadlines; no global fake timers or agent execution shortcut.
      const progress = impl.storage.attentionProgress.get()!;
      impl.storage.attentionProgress.put({ ...progress, bootstrapAt: Date.now() - 1, deliveryAt: Date.now() - 1 });
      sync.mockRejectedValue(new Error("offline"));
      try {
        await instance.alarm(); // Must return while reconcilePendingGadgets is still blocked.
        expect(sync).toHaveBeenCalledOnce();
        expect(retriedWhileBusy).not.toHaveBeenCalled();
        expect(impl.getChatMetaOrThrow(1).activeAgent).toEqual(model.profile);
        const retry = impl.storage.attentionProgress.get()!.deliveryAt!;
        expect(retry).toBeGreaterThanOrEqual(Date.now() + 59_000);
        readyScan.mockRestore();
        await impl.setAutomationPaused(true);
        release.resolve();
        await impl.waitForAllAgentsToComplete();
        await impl.deliverReadyExternalMessageResponses();
        expect(await impl.ctx.storage.getAlarm()).toBe(retry);
        sync.mockResolvedValue(undefined);
        await impl.deliverAttention(retry);
        expect(await impl.ctx.storage.getAlarm()).toBeGreaterThan(retry);
        impl.storage.gadgetResponseDeliveries.delete("receipt");
        impl.updateAlarm();
        expect(await impl.ctx.storage.getAlarm()).toBeNull();
      } finally {
        readyScan.mockRestore();
        await impl.setAutomationPaused(true);
        release.resolve();
        await impl.waitForAllAgentsToComplete();
      }
    }));
});
