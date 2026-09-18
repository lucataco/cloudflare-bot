import { afterEach, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer";

declare global {
  namespace Cloudflare {
    interface Env { TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>; }
  }
}
afterEach(() => vi.restoreAllMocks());
const author = {type: "agent" as const, id: "model", name: "Bot", agentProfileId: "bot"};
const calls = [{toolCallId: "call", toolName: "executeCode", input: {secret: "DO_NOT_RECORD"}}];

it("writes only audit metadata, awaits disk confirmation and retains independent attempts", async () => {
  await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    const impl = instance["impl"];
    const durable = Promise.withResolvers<void>();
    const sync = vi.spyOn(impl.ctx.storage, "sync").mockReturnValueOnce(durable.promise);
    let finished = false;
    const admission = impl.auditToolCalls(1, author, calls, {id: "run", attempt: 1}).then(() => { finished = true; });
    const [record] = [...impl.storage.toolCallAudits.list()];
    expect(record).toMatchObject({chatId: 1, modelId: "model", agentProfileId: "bot", execution: {id: "run", attempt: 1},
      calls: [{toolCallId: "call", toolName: "executeCode"}]});
    expect(JSON.stringify(record)).not.toContain("DO_NOT_RECORD");
    expect(sync).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(finished).toBe(false);
    durable.resolve();
    await admission;
    // A subsequent failed step cannot roll back the already durable admission.
    expect(() => impl.storage.transaction(() => { throw new Error("Step failed"); })).toThrow("Step failed");
    await impl.auditToolCalls(1, author, calls, {id: "run", attempt: 2});
    const records = [...impl.storage.toolCallAudits.list()];
    expect(records).toHaveLength(2);
    expect(new Set(records.map(row => row.id)).size).toBe(2);
    expect(records.map(row => row.execution?.attempt).toSorted()).toEqual([1, 2]);
  });
});

it("rejects oversized batches before recording and propagates flush failures", async () => {
  await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    const impl = instance["impl"];
    await expect(impl.auditToolCalls(1, author, Array.from({length: 129}, () => calls[0]))).rejects.toThrow("audit limits");
    expect([...impl.storage.toolCallAudits.list()]).toEqual([]);
    vi.spyOn(impl.ctx.storage, "sync").mockRejectedValueOnce(new Error("Disk failure"));
    await expect(impl.auditToolCalls(1, author, calls)).rejects.toThrow("Disk failure");
  });
});

it("lists a chat's records newest first and pages by per-conversation sequence", async () => {
  await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    const impl = instance["impl"];
    for (let i = 0; i < 101; i++) await impl.auditToolCalls(1, author, calls);
    for (let i = 0; i < 3; i++) await impl.auditToolCalls(2, author, calls);

    const first = await impl.listToolCallAudits(1);
    expect(first.entries).toHaveLength(100);
    expect(first.nextBeforeSequence).toBe(1);
    expect(first.entries[0].seq).toBe(100);
    expect(first.entries.every((entry: {chatId: number}) => entry.chatId === 1)).toBe(true);

    const second = await impl.listToolCallAudits(1, first.nextBeforeSequence);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].seq).toBe(0);
    expect(second.nextBeforeSequence).toBeUndefined();

    const other = await impl.listToolCallAudits(2);
    expect(other.entries).toHaveLength(3);
    expect(other.nextBeforeSequence).toBeUndefined();
    expect(other.entries.every((entry: {chatId: number}) => entry.chatId === 2)).toBe(true);
  });
});
