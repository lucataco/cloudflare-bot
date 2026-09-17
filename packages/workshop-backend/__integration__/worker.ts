// The integration worker adds only the real, local Scheduler. No external providers are bound.
import { WorkerEntrypoint, type RpcStub as NativeRpcStub } from "cloudflare:workers";
import type { ComputerOperation, ComputerResult, ComputerRuntimeApi } from '@gadgets/workshop-shared/computer';
import { validateRpc, validateStub } from "capnweb-validate";
import type { RpcStub } from "capnweb";
import type { Overseer } from "@gadgets/workshop-shared/api";
import type { ScheduledFiring } from "../../gatekeeper-scheduler/src/types.js";
export { default } from "../src/server.js";
export {
  UserDurableObject, OverseerDurableObject, AdminSettings, PendingLogin,
  LoginConnectCallbackImpl, GatekeeperConnectCallbackImpl, LanguageModelGatekeeper,
  GatekeeperLoopback, GatekeeperHookLoopback, CodeModeTailLoopback, AgentSpawnerGatekeeper,
  GadgetTailLoopback, AgentSelfLoopback, TransientStubLoopback, ExternalMessageGateway,
  ComputerSessionImpl,
} from "../src/server.js";
export { ScheduleDriver } from "../../gatekeeper-scheduler/src/schedule-driver.js";
export {
  GatekeeperVendor as SchedulerVendor, SchedulerGatekeeper, ScheduleAccount,
  ScheduleHookController, ScheduleVerifier,
} from "../../gatekeeper-scheduler/src/scheduler.js";

/** Deterministic service substitute; kernel ownership/grant checks and native RPC stay real. */
@validateRpc()
export class TestComputerRuntime extends WorkerEntrypoint<Cloudflare.Env> implements ComputerRuntimeApi {
  async run(key: string, _operation: ComputerOperation, check: NativeRpcStub<() => Promise<void>>): Promise<ComputerResult> {
    await check();
    return { exitCode: 0, stdout: key, stderr: '' };
  }
  async stop(_key: string): Promise<void> {}
}

// vitest-pool-workers' DO proxy ignores symbol methods, including [restore]. This persistent
// entrypoint bridges that test-only gap; registration and all scheduler operations remain real.
@validateRpc()
export class RoutineTestCallback extends WorkerEntrypoint<Cloudflare.Env, {
  workspaceId: string; routineId: string; registrationId: string;
}> {
  async onSchedule(firing: ScheduledFiring): Promise<void> {
    const { workspaceId, routineId, registrationId } = this.ctx.props;
    await this.ctx.exports.OverseerDurableObject
      .get(this.ctx.exports.OverseerDurableObject.idFromString(workspaceId))
      .routineCallback(routineId, registrationId, firing);
  }
}

/** Test client validation, compiled here because this file is in the validator's TS project. */
export function validateChatHistory(stub: RpcStub<Overseer>) {
  return validateStub<Pick<Overseer, "getChatHistory">>(stub);
}

/** Compile client-side delegation result validation in the integration worker's TS project. */
export function validateNamedDelegation(stub: RpcStub<Overseer>) {
  return validateStub<Pick<Overseer,
    "getNamedDelegationConfig" | "setNamedDelegationConfig" | "getNamedDelegation" | "getChatHistory">>(stub);
}
