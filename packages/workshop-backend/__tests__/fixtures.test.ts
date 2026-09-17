import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { openFakeOverseer } from "./fixtures";

it("openFakeOverseer disposes the original callback while the client owns its duplicate", async () => {
  using probe = new NativeRpcStub(() => {});
  const prototype = Object.getPrototypeOf(probe);
  let original: NativeRpcStub<() => void> | undefined;
  const duplicate = vi.spyOn(prototype, "dup");
  const dispose = vi.spyOn(prototype, Symbol.dispose);
  try {
    using _client = await openFakeOverseer({}, { role: "use" });
    original = duplicate.mock.contexts[0];
    expect(duplicate).toHaveBeenCalledOnce();
    duplicate.mockRestore();
    expect(original).toBeDefined();
    expect(dispose.mock.contexts).toContain(original);
    // Client disposal still invokes its independent callback duplicate.
  } finally {
    duplicate.mockRestore();
    original?.[Symbol.dispose]();
    dispose.mockRestore();
  }
});
