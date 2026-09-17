import { runInDurableObject } from "cloudflare:test";
import { env, RpcStub } from "cloudflare:workers";
import { launch, type Browser, type Page } from "@cloudflare/puppeteer";
import type { OverseerDurableObject } from "../src/overseer";
import { ComputerSessionImpl } from "../src/computer-session";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/puppeteer", () => ({ launch: vi.fn() }));

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

afterEach(() => vi.resetAllMocks());

function browser() {
  const page = {
    setViewport: vi.fn(async () => {}),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    goto: vi.fn(async () => null),
    url: vi.fn(() => "https://user:secret@example.com/account?token=secret#capability"),
    cookies: vi.fn(async () => []),
    setCookie: vi.fn(async () => {}),
    $: vi.fn<(selector: string) => Promise<unknown>>(),
    screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
    mouse: { click: vi.fn(async () => {}), wheel: vi.fn(async () => {}) },
    keyboard: { type: vi.fn(async () => {}), press: vi.fn(async () => {}) },
  };
  const resource = {
    connected: true,
    newPage: vi.fn(async () => page as Page),
    close: vi.fn(async () => {}),
  };
  vi.mocked(launch).mockResolvedValue(resource as Browser);
  return { page, resource };
}

async function withSession(run: (session: ComputerSessionImpl) => Promise<void>) {
  await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async (_instance, state) => {
    const session = new ComputerSessionImpl(state, { ...env, BROWSER: { fetch: vi.fn() } as BrowserRun });
    try {
      await run(session);
    } finally {
      await session.stop();
    }
  });
}

describe("serialized native browser operations", () => {
  it('delivers secrets only into the focused field at the requested origin and sanitizes provider failures', async () => {
    const { page } = browser();
    const field = { evaluate: vi.fn(async () => {}), type: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    page.$.mockResolvedValue(field);
    await withSession(async session => {
      using allowed = new RpcStub(async () => {});
      await expect(session.fillSecret(allowed, 'https://other.example', 'SYNTHETIC-SECRET')).rejects.toThrow('Secret entry failed');
      expect(field.type).not.toHaveBeenCalled();
      await session.fillSecret(allowed, 'https://example.com', 'SYNTHETIC-SECRET');
      expect(field.type.mock.calls.flat().join('')).toBe('SYNTHETIC-SECRET');
      expect(page.screenshot).not.toHaveBeenCalled();
      expect(page.cookies).not.toHaveBeenCalled();
      field.type.mockRejectedValueOnce(new Error('SYNTHETIC-SECRET'));
      const failure = await session.fillSecret(allowed, 'https://example.com', 'SYNTHETIC-SECRET').catch(error => error);
      expect(String(failure)).not.toContain('SYNTHETIC-SECRET');
      expect(failure.cause).toBeUndefined();
    });
  });

  it('imports cookie values only into the private browser and persists the bounded export', async () => {
    const { page } = browser();
    await withSession(async session => {
      using allowed = new RpcStub(async () => {});
      const cookies = [{ name: 'session', value: 'SYNTHETIC-COOKIE', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true }];
      await session.importCookies(allowed, new TextEncoder().encode(JSON.stringify(cookies)));
      expect(page.setCookie).toHaveBeenCalledWith(cookies[0]);
      expect(page.screenshot).not.toHaveBeenCalled();
      await expect(session.importCookies(allowed, new Uint8Array(1024 * 1024 + 1))).rejects.toThrow('Could not import');
    });
  });

  it("does not launch for denied reads and preserves metadata privacy after manual operations", async () => {
    const { page } = browser();
    await withSession(async session => {
      using denied = new RpcStub(async () => { throw new Error("denied"); });
      await expect(session.screenshot(denied)).rejects.toThrow("denied");
      expect(launch).not.toHaveBeenCalled();
      using allowed = new RpcStub(async () => {});
      await session.navigate(allowed, "about:blank");
      await session.click(allowed, 20, 30);
      expect(page.mouse.click).toHaveBeenCalledWith(20, 30);
      expect(await session.screenshot(allowed)).toEqual(new Uint8Array([1, 2, 3]));
      expect(await session.getState(allowed)).toMatchObject({ currentUrl: "https://example.com/account" });
    });
  });

  it("serializes launch and checks queued operations after revocation", async () => {
    const { page, resource } = browser();
    const launched = Promise.withResolvers<Browser>();
    vi.mocked(launch).mockReturnValueOnce(launched.promise);
    await withSession(async session => {
      let allowed = true;
      using check = new RpcStub(async () => { if (!allowed) throw new Error("revoked"); });
      const first = session.navigate(check, "about:blank");
      const firstResult = expect(first).rejects.toMatchObject({ message: "Failed to start Computer", cause: { message: "revoked" } });
      await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
      const queued = session.click(check, 1, 1);
      const queuedResult = expect(queued).rejects.toThrow("revoked");
      allowed = false;
      launched.resolve(resource as Browser);
      await Promise.all([firstResult, queuedResult]);
      expect(resource.close).toHaveBeenCalledOnce();
      expect(resource.newPage).not.toHaveBeenCalled();
      expect(page.mouse.click).not.toHaveBeenCalled();
      expect(launch).toHaveBeenCalledOnce();
    });
  });

  it("does not return screenshot bytes if authority is revoked during capture", async () => {
    const { page } = browser();
    await withSession(async session => {
      let allowed = true;
      using check = new RpcStub(async () => { if (!allowed) throw new Error("revoked"); });
      page.screenshot.mockImplementationOnce(async () => {
        allowed = false;
        return new Uint8Array([4, 5, 6]);
      });
      await expect(session.screenshot(check)).rejects.toMatchObject({
        message: "Computer operation failed or access changed", cause: { message: "revoked" },
      });
    });
  });

  it("retains the original launch cause even if cleanup also fails", async () => {
    const { resource } = browser();
    const cause = new Error("provider details must not appear in the public message");
    resource.newPage.mockRejectedValueOnce(cause);
    resource.close.mockRejectedValueOnce(new Error("cleanup failed"));
    await withSession(async session => {
      using check = new RpcStub(async () => {});
      await expect(session.navigate(check, "about:blank")).rejects.toMatchObject({
        message: "Failed to start Computer", cause,
      });
    });
  });

  it("bounds waits, coordinates and text without launching invalid operations", async () => {
    browser();
    await withSession(async session => {
      using check = new RpcStub(async () => {});
      await session.wait(check, -1);
      await expect(session.wait(check, Infinity)).rejects.toThrow("Invalid browser wait");
      await expect(session.click(check, -1, 1)).rejects.toThrow("viewport");
      await expect(session.click(check, NaN, 1)).rejects.toThrow("viewport");
      await expect(session.type(check, "x".repeat(4097))).rejects.toThrow("4096");
      expect(launch).not.toHaveBeenCalled();
    });
  });
});
