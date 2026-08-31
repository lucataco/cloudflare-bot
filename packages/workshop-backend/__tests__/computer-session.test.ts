import { describe, expect, it, vi } from "vitest";
import { resolveComputerSession } from "../src/overseer.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

describe("resolveComputerSession", () => {
  it("throws binding message when ComputerSessionImpl is missing", () => {
    const ctx = { exports: {} };
    expect(() => resolveComputerSession(ctx as any, "owner-id", "agent-id")).toThrow(
      "Computer sessions require the BROWSER binding to be configured."
    );
  });

  it("returns ComputerSessionWrapper when export is present", () => {
    const mockStub = { navigate: vi.fn() };
    const ctx = {
      exports: {
        ComputerSessionImpl: {
          idFromName: () => "mock-id",
          get: () => mockStub,
        },
      },
    };

    const result = resolveComputerSession(ctx as any, "owner-id", "agent-id");
    expect(result).toBeDefined();
  });

  it("propagates idFromName errors without rewriting", () => {
    const ctx = {
      exports: {
        ComputerSessionImpl: {
          idFromName: () => {
            throw new Error("Proxy could not be serialized");
          },
        },
      },
    };

    expect(() => resolveComputerSession(ctx as any, "owner-id", "agent-id")).toThrow("Proxy could not be serialized");
    expect(() => resolveComputerSession(ctx as any, "owner-id", "agent-id")).not.toThrow(/BROWSER binding/);
  });
});
