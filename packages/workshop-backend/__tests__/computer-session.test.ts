import { describe, expect, it, vi } from "vitest";
import { OverseerDurableObject } from "../src/overseer.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

describe("Computer session error handling", () => {
  it("returns clean error when BROWSER binding is missing", async () => {
    const overseer = Object.create(OverseerDurableObject.prototype) as OverseerDurableObject;
    Object.assign(overseer, {
      ownerId: "test-owner",
      ctx: {
        exports: {},
      },
    });

    await expect(overseer.getComputerSession("test-agent")).rejects.toThrow(
      "Computer sessions require the BROWSER binding to be configured."
    );
  });

  it("does not leak RPC serialization errors", async () => {
    const overseer = Object.create(OverseerDurableObject.prototype) as OverseerDurableObject;
    Object.assign(overseer, {
      ownerId: "test-owner",
      ctx: {
        exports: {
          ComputerSessionImpl: {
            idFromName: () => {
              throw new Error("Proxy could not be serialized");
            },
          },
        },
      },
    });

    await expect(overseer.getComputerSession("test-agent")).rejects.toThrow(
      "Computer sessions require the BROWSER binding to be configured."
    );
    await expect(overseer.getComputerSession("test-agent")).rejects.not.toThrow(/Proxy could not be serialized/);
  });
});
