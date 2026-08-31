import { describe, expect, it, vi } from "vitest";
import type { OverseerImpl } from "../src/overseer.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

function makeOverseerImpl(exports: any): OverseerImpl {
  const impl = Object.create(Object.getPrototypeOf({})) as OverseerImpl;
  Object.assign(impl, {
    ownerId: "test-owner",
    ctx: { exports },
  });
  return impl;
}

describe("Computer session error handling", () => {
  it("returns clean error when BROWSER binding is missing", async () => {
    const impl = makeOverseerImpl({});
    const { OverseerImpl } = await import("../src/overseer.js");
    const getComputerSession = OverseerImpl.prototype.getComputerSession;

    await expect(getComputerSession.call(impl, "test-agent")).rejects.toThrow(
      "Computer sessions require the BROWSER binding to be configured."
    );
  });

  it("returns ComputerSessionWrapper when export is present", async () => {
    const mockStub = { navigate: vi.fn() };
    const impl = makeOverseerImpl({
      ComputerSessionImpl: {
        idFromName: () => "mock-id",
        get: () => mockStub,
      },
    });
    const { OverseerImpl } = await import("../src/overseer.js");
    const getComputerSession = OverseerImpl.prototype.getComputerSession;

    const result = await getComputerSession.call(impl, "test-agent");
    expect(result).toBeDefined();
  });

  it("propagates errors other than missing export", async () => {
    const impl = makeOverseerImpl({
      ComputerSessionImpl: {
        idFromName: () => {
          throw new Error("Proxy could not be serialized");
        },
      },
    });
    const { OverseerImpl } = await import("../src/overseer.js");
    const getComputerSession = OverseerImpl.prototype.getComputerSession;

    await expect(getComputerSession.call(impl, "test-agent")).rejects.toThrow("Proxy could not be serialized");
    await expect(getComputerSession.call(impl, "test-agent")).rejects.not.toThrow(/BROWSER binding/);
  });
});
