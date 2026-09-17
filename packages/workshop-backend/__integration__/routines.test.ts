import { listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcPromise, type RpcStub } from "capnweb";
import type { AuthenticatedApi, PublicApi, AgentRoutineSchedule, GatekeeperClient } from "@gadgets/workshop-shared/api";
import type { ScheduledFiring, ScheduleSession } from "../../gatekeeper-scheduler/src/types.js";
import { ScheduleHookController, ScheduleSessionImpl } from "../../gatekeeper-scheduler/src/scheduler.js";
import { ScheduleDriver } from "../../gatekeeper-scheduler/src/schedule-driver.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";
import { afterEach, describe, expect, it, vi } from "vitest";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    SCHEDULE_DRIVER: DurableObjectNamespace<ScheduleDriver>;
  }
}

afterEach(async () => {
  // Let native RPC disposal notifications drain before the next test changes prototype spies.
  await new Promise(resolve => setTimeout(resolve, 0));
  vi.restoreAllMocks();
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

async function account(publicApi: RpcStub<PublicApi>, scheduler = true) {
  const name = "routine" + crypto.randomUUID().replaceAll("-", "");
  const token = await publicApi.createAccount(name, name, new Uint8Array([1, 2, 3]));
  if (!token) throw new Error("Account creation failed");
  const api = await publicApi.authenticate(token);
  if (scheduler) await api.provisionAmbientAccount("scheduler");
  return api;
}

function workspaceStub(id: string) {
  return exports.OverseerDurableObject.get(exports.OverseerDurableObject.idFromString(id));
}

async function createAgent(api: RpcStub<AuthenticatedApi>) {
  const agent = await api.createAgent("Repeat bot", "", "", null);
  await runInDurableObject(workspaceStub(agent.workspaceId), (_instance, state) => {
    state.restore = async (params: { routineId: string; registrationId: string }) => {
      const callback = exports.RoutineTestCallback({
        props: { workspaceId: agent.workspaceId, routineId: params.routineId, registrationId: params.registrationId },
      });
      // A service binding needs no disposal, unlike the restore stub it stands in for.
      Object.defineProperty(callback, Symbol.dispose, { value() {} });
      return callback;
    };
  });
  return agent;
}

async function schedules(id: string) {
  return runInDurableObject(workspaceStub(id), async (instance: OverseerDurableObject) => {
    const impl = instance["impl"];
    const gatekeeper = [...impl.storage.gatekeepers.list()].find(
      gk => gk.creationSpec?.type === "ambient" && gk.creationSpec.vendorId === "scheduler");
    if (!gatekeeper) return [];
    return [...impl.storage.boundHooks.list()].map(hook => ({
      id: hook.id, enabled: hook.enabled, gadgetId: hook.gadgetId,
      description: hook.description,
      routine: hook.routine,
      action: impl.storage.actions.get(hook.actionId),
    }));
  });
}

async function driverSchedules(api: RpcStub<AuthenticatedApi>, workspaceId: string) {
  using workspace = await api.openGadget(workspaceId);
  const id = await runInDurableObject(workspaceStub(workspaceId), (instance: OverseerDurableObject) =>
    [...instance["impl"].storage.gatekeepers.list()].find(
      gk => gk.creationSpec?.type === "ambient" && gk.creationSpec.vendorId === "scheduler")?.id);
  if (id === undefined) return [];
  using gatekeeper: RpcPromise<GatekeeperClient<ScheduleSession>> = workspace.getGatekeeperById(id);
  using session = gatekeeper.openSession();
  return await session.list();
}

function scheduledFiring(scheduleId: string, runId = crypto.randomUUID()): ScheduledFiring {
  return { scheduleId, runId, scheduledTime: Date.now(), actualTime: Date.now(), timeZone: "UTC" };
}

async function scheduleDriver(workspaceId: string) {
  for (const id of await listDurableObjectIds(env.SCHEDULE_DRIVER)) {
    const driver = env.SCHEDULE_DRIVER.get(id);
    if ((await driver.listWorkspace(workspaceId)).length) return driver;
  }
  throw new Error("Scheduler driver not found");
}

describe("routine firing receipts", () => {
  it("atomically admits concurrent deliveries once, without duplicate startup or title generation", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    const routine = await api.createRoutine(agent.id, "Routine", "Do work", {
      kind: "interval", everyMs: 3_600_000,
    }, false);
    await runInDurableObject(workspaceStub(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      const user = exports.UserDurableObject.get(exports.UserDurableObject.idFromString(impl.ownerId!));
      const stored = (await user.getRoutineById(routine.id))!;
      const hook = impl.storage.boundHooks.get(routine.hookId!)!;
      const firing = scheduledFiring(hook.routine!.scheduleId!);
      const admission = { id: routine.id, revision: stored.revision!, hookId: hook.id,
        registrationId: hook.routine!.registrationId, firing };
      const userMeta = await user.getChatContext(null, agent.workspaceId, agent.id);
      const config = { provider: "anthropic" as const, model: "unused", apiToken: "unused" };
      userMeta.aiModel = { profile: { type: "agent", id: "unused", name: "Unused" }, config };
      userMeta.quickModel = config;
      const start = vi.spyOn(impl, "startAgent").mockImplementation(() => {});
      const title = vi.spyOn(impl, "generateThreadTitle").mockImplementation(() => {});
      const allocate = vi.spyOn(impl, "nextChatId");
      const fire = () => impl.newChat(user, userMeta, routine.prompt,
        undefined, undefined, undefined, undefined, undefined, admission);
      const [first, duplicate] = await Promise.all([fire(), fire()]);
      expect(duplicate).toBe(first);
      expect(await fire()).toBe(first);
      expect(start).toHaveBeenCalledOnce();
      expect(title).toHaveBeenCalledOnce();
      expect(allocate).toHaveBeenCalledOnce();
      expect([...impl.storage.chats.list()]).toMatchObject([{ chatId: first, type: "message", message: "Do work" }]);
      expect([...impl.storage.routineOccurrences.list()]).toEqual([{
        routineId: routine.id, registrationId: admission.registrationId, firing, status: "admitted", chatId: first,
      }]);
      impl.storage.chatMeta.put({ ...impl.getChatMetaOrThrow(first), activeAgent: undefined });
    });
    await api.deleteRoutine(agent.id, routine.id);
  });

  it("rolls back chat allocation and prompt with a failed receipt write, then permits retry", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    const routine = await api.createRoutine(agent.id, "Routine", "Do work", {
      kind: "interval", everyMs: 3_600_000,
    }, false);
    await runInDurableObject(workspaceStub(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      const registration = impl.storage.boundHooks.get(routine.hookId!)!.routine!;
      const firing = scheduledFiring(registration.scheduleId!);
      const nextId = impl.storage.nextChatId.get();
      const put = impl.storage.routineOccurrences.put.bind(impl.storage.routineOccurrences);
      vi.spyOn(impl.storage.routineOccurrences, "put").mockImplementationOnce(record => {
        put(record);
        throw new Error("receipt rollback injected by test");
      });
      const fire = () => impl.handleRoutineFire(routine.id, registration.registrationId, undefined, firing);
      await expect(fire()).rejects.toThrow("receipt rollback injected by test");
      expect([...impl.storage.routineOccurrences.list()]).toEqual([]);
      expect([...impl.storage.chatMeta.list()]).toEqual([]);
      expect([...impl.storage.chats.list()]).toEqual([]);
      expect(impl.storage.nextChatId.get()).toBe(nextId);
      expect(await fire()).toBe(nextId);
      expect([...impl.storage.routineOccurrences.list()]).toHaveLength(1);
    });
    await api.deleteRoutine(agent.id, routine.id);
  });

  it("reuses a real scheduler delivery after a lost ack, restart, and chat deletion", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    const routine = await api.createRoutine(agent.id, "Routine", "Do work", {
      kind: "interval", everyMs: 3_600_000,
    }, false);
    let overseer = workspaceStub(agent.workspaceId);
    const registration = (await schedules(agent.workspaceId))[0].routine!;
    const driver = await scheduleDriver(agent.workspaceId);
    await runInDurableObject(overseer, (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      const newChat = impl.newChat.bind(impl);
      vi.spyOn(impl, "newChat").mockImplementationOnce(async (...args) => {
        await newChat(...args);
        throw new Error("callback ack lost after chat commit");
      });
    });
    const [schedule] = await driver.listWorkspace(agent.workspaceId);
    if (schedule.status !== "active") throw new Error("Expected active schedule");
    const now = vi.spyOn(Date, "now").mockReturnValue(schedule.nextFire!);
    await runDurableObjectAlarm(driver);
    const [chat] = await runInDurableObject(overseer, (instance: OverseerDurableObject) =>
      [...instance["impl"].storage.chatMeta.list()]);
    expect(chat).toBeDefined();
    const receipt = await runInDurableObject(overseer, (instance: OverseerDurableObject) =>
      [...instance["impl"].storage.routineOccurrences.list()][0]);
    expect(receipt).toMatchObject({ status: "admitted", chatId: chat.id,
      registrationId: registration.registrationId, firing: { scheduleId: registration.scheduleId } });
    const [retrying] = await driver.listWorkspace(agent.workspaceId);
    expect(retrying).toMatchObject({ status: "active", retrying: true });
    await runInDurableObject(overseer, async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      const user = exports.UserDurableObject.get(exports.UserDurableObject.idFromString(impl.ownerId!));
      using closed = new NativeRpcStub(() => {});
      using client = await instance.open(impl.ownerId!, (await user.whoami()).id, closed);
      await client.deleteChat(chat.id);
    });
    await expect(runInDurableObject(overseer, (_instance, state) => {
      state.abort("routine workspace reset injected by test");
    })).rejects.toThrow();
    overseer = workspaceStub(agent.workspaceId);
    if (retrying.status !== "active") throw new Error("Expected retry");
    now.mockReturnValue(retrying.nextFire!);
    await runDurableObjectAlarm(driver);
    now.mockRestore();
    expect(await overseer.routineCallback(routine.id, registration.registrationId, receipt.firing)).toBe(chat.id);
    await runInDurableObject(overseer, (instance: OverseerDurableObject) => {
      expect([...instance["impl"].storage.chatMeta.list()]).toEqual([]);
      expect([...instance["impl"].storage.routineOccurrences.list()]).toEqual([receipt]);
    });
    expect((await driver.listWorkspace(agent.workspaceId))[0]).not.toHaveProperty("retrying");
    await api.deleteRoutine(agent.id, routine.id);
  });

  it("binds callbacks to registration and actual schedule identity, and permits distinct occurrences", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    using workspace = await api.openGadget(agent.workspaceId);
    const routine = await api.createRoutine(agent.id, "Routine", "Do work", {
      kind: "interval", everyMs: 3_600_000,
    }, false);
    const overseer = workspaceStub(agent.workspaceId);
    const original = (await schedules(agent.workspaceId))[0].routine!;
    const firing = scheduledFiring(original.scheduleId!);
    await overseer.routineCallback(routine.id, "wrong-registration", firing);
    await overseer.routineCallback(routine.id, original.registrationId, { ...firing, scheduleId: "wrong-schedule" });
    expect(await workspace.listChats()).toEqual([]);
    await api.updateRoutine(agent.id, routine.id, { schedule: { kind: "interval", everyMs: 7_200_000 } });
    const replacement = (await schedules(agent.workspaceId))[0].routine!;
    expect(replacement.registrationId).not.toBe(original.registrationId);
    expect(replacement.scheduleId).not.toBe(original.scheduleId);
    await overseer.routineCallback(routine.id, original.registrationId, firing);
    await overseer.routineCallback(routine.id, original.registrationId, { ...firing, scheduleId: replacement.scheduleId! });
    await overseer.routineCallback(routine.id, replacement.registrationId, firing);
    expect(await workspace.listChats()).toEqual([]);
    const next = { ...firing, scheduleId: replacement.scheduleId! };
    const first = await overseer.routineCallback(routine.id, replacement.registrationId, next);
    expect(await overseer.routineCallback(routine.id, replacement.registrationId, { ...next, actualTime: next.actualTime + 1 }))
      .toBe(first);
    expect(await overseer.routineCallback(routine.id, replacement.registrationId, { ...next, runId: "another" }))
      .not.toBe(first);
    expect(await workspace.listChats()).toHaveLength(2);
    await api.deleteRoutine(agent.id, routine.id);
  });

  it("retains skipped scheduled receipts across restart and resume", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    const routine = await api.createRoutine(agent.id, "Routine", "Do work", {
      kind: "interval", everyMs: 3_600_000,
    }, false);
    let overseer = workspaceStub(agent.workspaceId);
    const registration = (await schedules(agent.workspaceId))[0].routine!;
    const firing = scheduledFiring(registration.scheduleId!);
    await runInDurableObject(overseer, (instance: OverseerDurableObject) => instance["impl"].setAutomationPaused(true));
    expect(await overseer.routineCallback(routine.id, registration.registrationId, firing)).toBeUndefined();
    await expect(runInDurableObject(overseer, (_instance, state) => {
      state.abort("routine workspace reset injected by test");
    })).rejects.toThrow();
    overseer = workspaceStub(agent.workspaceId);
    await runInDurableObject(overseer, (instance: OverseerDurableObject) => instance["impl"].setAutomationPaused(false));
    expect(await overseer.routineCallback(routine.id, registration.registrationId, firing)).toBeUndefined();
    await runInDurableObject(overseer, (instance: OverseerDurableObject) => {
      expect([...instance["impl"].storage.chatMeta.list()]).toEqual([]);
      expect([...instance["impl"].storage.routineOccurrences.list()]).toMatchObject([{ status: "skipped", firing }]);
    });
    expect(await overseer.routineCallback(routine.id, registration.registrationId, { ...firing, runId: "next" }))
      .toEqual(expect.any(Number));
    await api.deleteRoutine(agent.id, routine.id);
  });

  it("fails legacy self-tokens closed and requires ScheduledFiring on restored callbacks", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    const routine = await api.createRoutine(agent.id, "Routine", "Do work", {
      kind: "interval", everyMs: 3_600_000,
    }, false);
    await runInDurableObject(workspaceStub(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      const registration = impl.storage.boundHooks.get(routine.hookId!)!.routine!;
      expect(() => impl.restore({ type: "routine", routineId: routine.id })).toThrow("re-registration");
      using callback = impl.restore({ type: "routine", routineId: routine.id, registrationId: registration.registrationId });
      using missing = callback.onSchedule();
      expect(await missing.then(() => null, (error: Error) => error)).toMatchObject({ message: expect.stringContaining("ScheduledFiring") });
      using incomplete = callback.onSchedule({ scheduleId: registration.scheduleId });
      expect(await incomplete.then(() => null, (error: Error) => error)).toMatchObject({ message: expect.stringContaining("runId") });
      expect([...impl.storage.chatMeta.list()]).toEqual([]);
      await callback.onSchedule(scheduledFiring(registration.scheduleId!));
      expect([...impl.storage.chatMeta.list()]).toHaveLength(1);
    });
    await api.deleteRoutine(agent.id, routine.id);
  });

  it.each(["onMessage", "onEvent"])("seals event callback registration too, without claiming event dedupe: %s", async method => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    const routine = await api.createRoutine(agent.id, "Routine", "Do work", {
      kind: "interval", everyMs: 3_600_000,
    }, false);
    await runInDurableObject(workspaceStub(agent.workspaceId), async (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      const hook = impl.storage.boundHooks.get(routine.hookId!)!;
      // Stand in only for the external event provider's registration; exercise real restored targets.
      delete hook.routine!.scheduleId;
      impl.storage.boundHooks.put(hook);
      const params = { type: "routine" as const, routineId: routine.id, registrationId: hook.routine!.registrationId };
      using oldCallback = impl.restore(params);
      hook.routine!.registrationId = crypto.randomUUID();
      impl.storage.boundHooks.put(hook);
      const event = { channelId: "channel", message: { text: "hello" }, eventType: "pull_request",
        owner: "owner", repo: "repo", prNumber: 1, prTitle: "Change", prAuthor: "author" };
      await oldCallback[method](event);
      expect([...impl.storage.chatMeta.list()]).toEqual([]);
      using callback = impl.restore({ ...params, registrationId: hook.routine!.registrationId });
      await callback[method](event);
      await callback[method](event);
      expect([...impl.storage.chatMeta.list()]).toHaveLength(2);
      expect([...impl.storage.routineOccurrences.list()]).toEqual([]);
    });
    await api.deleteRoutine(agent.id, routine.id);
  });
});

describe("routine registration", () => {
  it.each([false, true])("tears down the atomically returned hook when publication races pause (newer replacement: %s)", async replaceAgain => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    using workspace = await api.openGadget(agent.workspaceId);
    const routine = await api.createRoutine(agent.id, "Routine", "/skill", {
      kind: "interval", everyMs: 3_600_000,
    });
    await api.createSkill(agent.id, "Skill", "", "Prepared task");
    const overseer = workspaceStub(agent.workspaceId);
    const ownerId = await runInDurableObject(overseer,
      (instance: OverseerDurableObject) => instance["impl"].ownerId!);
    const user = exports.UserDurableObject.get(exports.UserDurableObject.idFromString(ownerId));
    const before = (await user.getRoutineById(routine.id))!;
    // A real registration has made H, but its conditional publication has not happened yet.
    const hookId = await overseer.registerRoutine(routine.id, routine.name, routine.prompt, routine.schedule);
    let updateWaiting = false;
    let updatedHookId: number | undefined;
    let releaseUpdate: () => void;
    await runInDurableObject(user, (instance: UserDurableObject) => {
      const update = instance.updateRoutine.bind(instance);
      const prototype: UserDurableObject = Object.getPrototypeOf(instance);
      vi.spyOn(prototype, "updateRoutine").mockImplementationOnce(async (...args) => {
        // The server has already read {paused:true, hookId:undefined, revision:n}.
        expect(args[2]).toEqual({ paused: true });
        expect(args[3]).toBe(before.revision);
        const gate = Promise.withResolvers<void>();
        releaseUpdate = gate.resolve;
        updateWaiting = true;
        await gate.promise;
        const result = await update(...args);
        updatedHookId = result.routine.hookId;
        return result;
      });
    });
    let pause = api.updateRoutine(agent.id, routine.id, { paused: true });
    const pauseResult = pause.then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(updateWaiting).toBe(true));
    expect(before.paused).toBe(true);
    expect(before.hookId).toBeUndefined();
    // Publish H at the same revision n, between the server's read and its conditional update.
    expect(await user.finishRoutineRegistration(routine.id, before.revision!, hookId))
      .toMatchObject({ paused: false, hookId });

    let firingPrepared = false;
    let releaseFiring: () => void;
    await runInDurableObject(user, (instance: UserDurableObject) => {
      const read = instance.getRoutineById.bind(instance);
      const prototype: UserDurableObject = Object.getPrototypeOf(instance);
      let reads = 0;
      vi.spyOn(prototype, "getRoutineById").mockImplementation(async id => {
        const snapshot = await read(id);
        // Hold the final read after /skill preparation, not either earlier admission read.
        if (++reads === 3) {
          expect(snapshot).toMatchObject({ paused: false, hookId, revision: before.revision });
          const gate = Promise.withResolvers<void>();
          releaseFiring = gate.resolve;
          firingPrepared = true;
          await gate.promise;
        }
        return snapshot;
      });
    });
    const registration = (await schedules(agent.workspaceId)).find(h => h.id === hookId)!.routine!;
    const firing = overseer.routineCallback(routine.id, registration.registrationId, scheduledFiring(registration.scheduleId!));
    await vi.waitFor(() => expect(firingPrepared).toBe(true));

    let teardownWaiting = false;
    let releaseTeardown: () => void;
    if (replaceAgain) {
      await runInDurableObject(overseer, (instance: OverseerDurableObject) => {
        const impl = instance["impl"];
        const unregister = impl.unregisterRoutine.bind(impl);
        vi.spyOn(impl, "unregisterRoutine").mockImplementationOnce(async id => {
          expect(id).toBe(hookId);
          const gate = Promise.withResolvers<void>();
          releaseTeardown = gate.resolve;
          teardownWaiting = true;
          await gate.promise;
          await unregister(id);
        });
      });
    }
    await runInDurableObject(user, () => releaseUpdate());
    let replacement: Awaited<ReturnType<AuthenticatedApi["updateRoutine"]>> | undefined;
    if (replaceAgain) {
      await vi.waitFor(() => expect(teardownWaiting).toBe(true));
      replacement = await api.updateRoutine(agent.id, routine.id, {
        paused: false, schedule: { kind: "interval", everyMs: 7_200_000 },
      });
      await runInDurableObject(overseer, () => releaseTeardown());
    }
    const result = await pauseResult;
    // Return the old enabled snapshot only after pause acknowledges (or loses to replacement).
    // Its captured revision still matches; only the local H fence can reject this prepared firing.
    await runInDurableObject(user, () => releaseFiring());
    await firing;
    expect(updatedHookId).toBe(hookId);
    expect(await workspace.listChats()).toEqual([]);
    if (replaceAgain) {
      expect(result).toMatchObject({ error: { message: "Routine changed during update. Reload and retry." } });
    } else {
      expect(result).toMatchObject({ value: { paused: true, hookId: undefined } });
    }
    expect(await schedules(agent.workspaceId)).toEqual(replacement ? [expect.objectContaining({
      id: replacement.hookId, enabled: true,
    })] : []);
    if (replacement) expect((await api.listRoutines(agent.id))[0]).toEqual(replacement);
    await api.deleteRoutine(agent.id, routine.id);
  });

  it.each(["enable", "replacement", "create"])("a newer pause wins over a late %s registration, including after User DO restart", async operation => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    const schedule = { kind: "interval", everyMs: 3_600_000 } as const;
    const original = operation === "create" ? undefined :
      await api.createRoutine(agent.id, "Routine", "Check", schedule, operation === "enable");
    let registered = false;
    let release: () => void;
    await runInDurableObject(workspaceStub(agent.workspaceId), (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      let register = impl.registerRoutine.bind(impl);
      vi.spyOn(impl, "registerRoutine").mockImplementationOnce(async (...args) => {
        let hookId = await register(...args);
        let gate = Promise.withResolvers<void>();
        release = gate.resolve;
        registered = true;
        await gate.promise;
        return hookId;
      });
    });
    let registering = original ? api.updateRoutine(agent.id, original.id, {
      paused: false, schedule: { kind: "interval", everyMs: 7_200_000 },
    }) : api.createRoutine(agent.id, "Routine", "Check", schedule, false);
    let rejected = expect(registering).rejects.toThrow("Routine changed during update");
    await vi.waitFor(() => expect(registered).toBe(true));
    let pending = (await api.listRoutines(agent.id))[0];
    let paused = await api.updateRoutine(agent.id, pending.id, { paused: true });
    expect(paused.paused).toBe(true);
    const ownerId = await runInDurableObject(workspaceStub(agent.workspaceId),
      (instance: OverseerDurableObject) => instance["impl"].ownerId!);
    const userId = exports.UserDurableObject.idFromString(ownerId);
    const beforeRestart = await exports.UserDurableObject.get(userId).getRoutineById(pending.id);
    await expect(runInDurableObject(exports.UserDurableObject.get(userId), (_instance, state) => {
      state.abort("user-DO reset injected by test");
    })).rejects.toThrow();
    expect((await exports.UserDurableObject.get(userId).getRoutineById(pending.id))?.revision)
      .toBe(beforeRestart?.revision);
    await runInDurableObject(workspaceStub(agent.workspaceId), () => release());
    await rejected;
    expect(await api.listRoutines(agent.id)).toEqual([paused]);
    expect(await schedules(agent.workspaceId)).toEqual([]);
    expect(await driverSchedules(api, agent.workspaceId)).toEqual([]);
    expect(paused).not.toHaveProperty("revision");
    await api.deleteRoutine(agent.id, pending.id);
  });

  it.each(["delete", "replace"])("cleans up only the losing hook after a newer %s", async operation => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    const schedule = { kind: "interval", everyMs: 3_600_000 } as const;
    const routine = await api.createRoutine(agent.id, "Routine", "Check", schedule);
    let registered = false;
    let release: () => void;
    await runInDurableObject(workspaceStub(agent.workspaceId), (instance: OverseerDurableObject) => {
      let impl = instance["impl"];
      let register = impl.registerRoutine.bind(impl);
      vi.spyOn(impl, "registerRoutine").mockImplementationOnce(async (...args) => {
        let hookId = await register(...args);
        let gate = Promise.withResolvers<void>();
        release = gate.resolve;
        registered = true;
        await gate.promise;
        return hookId;
      });
    });
    let registering = api.updateRoutine(agent.id, routine.id, { paused: false });
    let rejected = expect(registering).rejects.toThrow("Routine changed during update");
    await vi.waitFor(() => expect(registered).toBe(true));
    let newest = operation === "replace" ? await api.updateRoutine(agent.id, routine.id, {
      paused: false, schedule: { kind: "interval", everyMs: 7_200_000 },
    }) : undefined;
    if (operation === "delete") await api.deleteRoutine(agent.id, routine.id);
    await runInDurableObject(workspaceStub(agent.workspaceId), () => release());
    await rejected;
    expect(await api.listRoutines(agent.id)).toEqual(newest ? [newest] : []);
    expect(await schedules(agent.workspaceId)).toHaveLength(newest ? 1 : 0);
    if (newest) {
      expect(await schedules(agent.workspaceId)).toMatchObject([{ id: newest.hookId, enabled: true }]);
      await api.deleteRoutine(agent.id, routine.id);
    }
  });

  it("opens the real Scheduler session in a never-opened bot workspace and supports pause/resume", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    const other = await api.createAgent("Other bot", "", "", null);
    const disposed = vi.spyOn(ScheduleSessionImpl.prototype, Symbol.dispose);
    const enable = ScheduleDriver.prototype.enable;
    const enabling = vi.spyOn(ScheduleDriver.prototype, "enable").mockImplementationOnce(async function (...args) {
      const [activation] = args;
      await runInDurableObject(workspaceStub(agent.workspaceId), (instance: OverseerDurableObject) => {
        const [hook] = [...instance["impl"].storage.boundHooks.list()];
        expect(hook).toMatchObject({ enabled: false, routine: {
          id: expect.any(String), registrationId: expect.any(String), scheduleId: activation.scheduleId,
        } });
      });
      return enable.apply(this, args);
    });
    const routine = await api.createRoutine(agent.id, "Check", "Check the status", {
      kind: "interval", everyMs: 3_600_000,
    }, false);
    expect(routine.paused).toBe(false);
    expect(disposed).toHaveBeenCalledOnce();
    expect(enabling).toHaveBeenCalledOnce();
    const [hook] = await schedules(agent.workspaceId);
    expect(hook).toMatchObject({ id: routine.hookId, enabled: true, gadgetId: undefined,
      routine: { id: routine.id, registrationId: expect.any(String) },
      action: { type: "bindHook", enabled: true, caller: { from: "user" } } });
    expect(await driverSchedules(api, agent.workspaceId)).toMatchObject([
      { title: "Check", cadence: { kind: "interval", everyMs: 3_600_000 } },
    ]);
    expect(await schedules(other.workspaceId)).toEqual([]);
    expect(await driverSchedules(api, other.workspaceId)).toEqual([]);

    const paused = await api.updateRoutine(agent.id, routine.id, { paused: true });
    expect(paused).toMatchObject({ paused: true, hookId: undefined });
    expect(await schedules(agent.workspaceId)).toEqual([]);
    expect(await driverSchedules(api, agent.workspaceId)).toEqual([]);
    const resumed = await api.updateRoutine(agent.id, routine.id, { paused: false });
    expect(resumed.paused).toBe(false);
    expect(resumed.hookId).not.toBe(routine.hookId);
    expect(await api.listRoutines(agent.id)).toHaveLength(1);
    expect(await driverSchedules(api, agent.workspaceId)).toHaveLength(1);
    await api.deleteRoutine(agent.id, routine.id);
    expect(await schedules(agent.workspaceId)).toEqual([]);
  });

  it("replaces enabled schedules when their cadence changes", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    let routine = await api.createRoutine(agent.id, "Original", "Original prompt", {
      kind: "interval", everyMs: 3_600_000,
    }, false);
    const replacements: AgentRoutineSchedule[] = [
      { kind: "interval", everyMs: 7_200_000 },
      { kind: "calendar", timeZone: "America/New_York", freq: "weekly", interval: 2,
        byDay: ["MO", "TH"], hour: 9, minute: 15 },
      { kind: "once", fireAt: Date.now() + 86_400_000, timeZone: "UTC" },
    ];
    for (const schedule of replacements) {
      const oldHook = routine.hookId;
      routine = await api.updateRoutine(agent.id, routine.id, { schedule });
      expect(routine).toMatchObject({ paused: false, schedule });
      expect(routine.hookId).not.toBe(oldHook);
      expect(await schedules(agent.workspaceId)).toHaveLength(1);
      const [active] = await driverSchedules(api, agent.workspaceId);
      expect(active.cadence.kind).toBe(schedule.kind);
      if (schedule.kind === "interval") expect(active.cadence).toMatchObject({ everyMs: schedule.everyMs });
      if (schedule.kind === "calendar") {
        expect(active.cadence).toMatchObject({ timeZone: schedule.timeZone,
          rule: { freq: "weekly", interval: 2, byDay: ["MO", "TH"], hour: 9, minute: 15 } });
      }
      if (schedule.kind === "once") expect(active.cadence).toMatchObject({ fireAt: schedule.fireAt });
    }
    await api.deleteRoutine(agent.id, routine.id);
  });

  it("preserves nextFire and hook identity on metadata edits and unchanged full saves", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    const routine = await api.createRoutine(agent.id, "Original", "Original prompt", {
      kind: "interval", everyMs: 3_600_000,
    }, false);
    const [before] = await driverSchedules(api, agent.workspaceId);
    const updates: Parameters<AuthenticatedApi["updateRoutine"]>[2][] = [
      { name: "Renamed" },
      { prompt: "New prompt" },
      {},
      { name: "Renamed", prompt: "New prompt", paused: false,
        schedule: { everyMs: 3_600_000, kind: "interval" } },
    ];
    for (const update of updates) {
      const saved = await api.updateRoutine(agent.id, routine.id, update);
      expect(saved.hookId).toBe(routine.hookId);
      const [active] = await driverSchedules(api, agent.workspaceId);
      expect(active.nextFire).toBe(before.nextFire);
      expect(active).toEqual(before);
    }
    expect(await api.listRoutines(agent.id)).toMatchObject([
      { id: routine.id, name: "Renamed", prompt: "New prompt", paused: false },
    ]);
    await api.deleteRoutine(agent.id, routine.id);
  });

  it.each<AgentRoutineSchedule>([
    { kind: "interval", everyMs: 3_600_000 },
    { kind: "calendar", timeZone: "UTC", freq: "daily", hour: 9, minute: 0 },
    { kind: "once", fireAt: Date.now() + 86_400_000, timeZone: "UTC" },
  ])("cleans up a $kind registration rejected after bindHook commits", async schedule => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    await runInDurableObject(workspaceStub(agent.workspaceId), (instance: OverseerDurableObject) => {
      const impl = instance["impl"];
      const bindHook = impl.bindHook.bind(impl);
      vi.spyOn(impl, "bindHook").mockImplementationOnce(async (...args) => {
        await bindHook(...args);
        expect([...impl.storage.boundHooks.list()]).toHaveLength(1);
        throw new Error("routine test: registration response lost");
      });
    });
    const disable = vi.spyOn(ScheduleHookController.prototype, "disable");
    const disposed = vi.spyOn(ScheduleSessionImpl.prototype, Symbol.dispose);
    await expect(api.createRoutine(agent.id, "Check", "Check", schedule, false))
      .rejects.toThrow("routine test: registration response lost");
    expect(disable).toHaveBeenCalledOnce();
    expect(disposed).toHaveBeenCalledOnce();
    expect(await schedules(agent.workspaceId)).toEqual([]);
    expect(await api.listRoutines(agent.id)).toEqual([]);
    expect(await driverSchedules(api, agent.workspaceId)).toEqual([]);

    const retried = await api.createRoutine(agent.id, "Check", "Check", schedule, false);
    expect(retried.paused).toBe(false);
    expect(await api.listRoutines(agent.id)).toHaveLength(1);
    expect(await schedules(agent.workspaceId)).toHaveLength(1);
    expect(await driverSchedules(api, agent.workspaceId)).toHaveLength(1);
    await api.deleteRoutine(agent.id, retried.id);
  });

  it("cleans up failed creates and leaves failed updates paused for retry by ID", async () => {
    using publicApi = await connect();
    using api = await account(publicApi, false);
    const agent = await createAgent(api);
    const schedule = { kind: "interval", everyMs: 3_600_000 } as const;
    await expect(api.createRoutine(agent.id, "Missing scheduler", "Check", schedule, false))
      .rejects.toThrow("Scheduler gatekeeper not available");
    expect(await api.listRoutines(agent.id)).toEqual([]);
    await api.provisionAmbientAccount("scheduler");
    const routine = await api.createRoutine(agent.id, "Check", "Check", schedule, false);
    await expect(api.updateRoutine(agent.id, routine.id, {
      schedule: { kind: "calendar", timeZone: "Invalid/Zone", freq: "daily", hour: 9, minute: 0 },
    })).rejects.toThrow("Invalid IANA timezone: Invalid/Zone");
    expect(await api.listRoutines(agent.id)).toMatchObject([{ id: routine.id, paused: true, hookId: undefined }]);
    expect(await schedules(agent.workspaceId)).toEqual([]);
    expect(await driverSchedules(api, agent.workspaceId)).toEqual([]);
    const repaired = await api.updateRoutine(agent.id, routine.id, { schedule, paused: false });
    expect(repaired.paused).toBe(false);
    expect(await api.listRoutines(agent.id)).toHaveLength(1);
    await api.deleteRoutine(agent.id, routine.id);
  });

  it("keeps paused edits inert and attributes concurrent registrations to their own hooks", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    const schedule = { kind: "interval", everyMs: 3_600_000 } as const;
    const draft = await api.createRoutine(agent.id, "Draft", "Check", schedule);
    const edited = await api.updateRoutine(agent.id, draft.id, { name: "Edited", schedule: {
      kind: "calendar", timeZone: "UTC", freq: "hourly", minute: 15,
    } });
    expect(edited.paused).toBe(true);
    expect(edited.hookId).toBeUndefined();
    expect(await schedules(agent.workspaceId)).toEqual([]);
    await api.deleteRoutine(agent.id, draft.id);

    const routines = await Promise.all(["First", "Second"].map(name =>
      api.createRoutine(agent.id, name, "Check", schedule, false)));
    expect(new Set(routines.map(r => r.hookId)).size).toBe(2);
    const hooks = await schedules(agent.workspaceId);
    expect(hooks).toHaveLength(2);
    for (const routine of routines) {
      expect(hooks.find(h => h.id === routine.hookId)).toMatchObject({
        enabled: true, description: { title: routine.name },
      });
      await api.deleteRoutine(agent.id, routine.id);
    }
    expect(await driverSchedules(api, agent.workspaceId)).toEqual([]);
  });

  it("cleans up even when activation commits and then loses its response", async () => {
    using publicApi = await connect();
    using api = await account(publicApi);
    const agent = await createAgent(api);
    const schedule = { kind: "interval", everyMs: 3_600_000 } as const;
    const routine = await api.createRoutine(agent.id, "Original", "Check", schedule, false);
    let driver: DurableObjectStub<ScheduleDriver> | undefined;
    for (const id of await listDurableObjectIds(env.SCHEDULE_DRIVER)) {
      const candidate = env.SCHEDULE_DRIVER.get(id);
      if ((await candidate.listWorkspace(agent.workspaceId)).length) {
        driver = candidate;
        break;
      }
    }
    if (!driver) throw new Error("Scheduler driver not found");
    async function failNextEnable() {
      await runInDurableObject(driver!, (instance: ScheduleDriver) => {
        const enable = instance.enable.bind(instance);
        vi.spyOn(ScheduleDriver.prototype, "enable").mockImplementationOnce(async (...args) => {
          await enable(...args);
          throw new Error("routine test: activation response lost");
        });
      });
    }
    await failNextEnable();
    await expect(api.createRoutine(agent.id, "Failed create", "Check", schedule, false))
      .rejects.toThrow("routine test: activation response lost");
    expect(await api.listRoutines(agent.id)).toMatchObject([{ id: routine.id, paused: false }]);
    expect(await schedules(agent.workspaceId)).toHaveLength(1);
    expect(await driver.listWorkspace(agent.workspaceId)).toHaveLength(1);

    await failNextEnable();
    await expect(api.updateRoutine(agent.id, routine.id, {
      name: "Changed", schedule: { kind: "interval", everyMs: 7_200_000 },
    }))
      .rejects.toThrow("routine test: activation response lost");
    expect(await api.listRoutines(agent.id)).toMatchObject([
      { id: routine.id, name: "Changed", paused: true, hookId: undefined },
    ]);
    expect(await schedules(agent.workspaceId)).toEqual([]);
    expect(await driver.listWorkspace(agent.workspaceId)).toEqual([]);
    expect((await api.updateRoutine(agent.id, routine.id, { paused: false })).paused).toBe(false);
    await api.deleteRoutine(agent.id, routine.id);
  });
});
