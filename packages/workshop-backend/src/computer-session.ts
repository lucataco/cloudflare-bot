import { DurableObject, type RpcStub } from "cloudflare:workers";
import { launch, type Page, type Browser, type KeyInput, type CookieParam as PuppeteerCookie } from "@cloudflare/puppeteer";
import { validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import type { ComputerSessionState } from "@gadgets/workshop-shared/api";
import { z } from 'zod';
import type { ComputerOperation, ComputerResult } from '@gadgets/workshop-shared/computer';

const logger = createLogger<{ event: string }>({ component: "workshop.computer-session" });
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const NAVIGATION_TIMEOUT_MS = 15_000;
const importedCookies = z.array(z.object({ name: z.string().max(4096), value: z.string().max(16_384),
  domain: z.string().min(1).max(255), path: z.string().max(4096), expires: z.number(),
  httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']).optional() })).max(1000);

/** Strip URL credentials, query and fragment before producing browser metadata or audit text. */
export function computerUrlLabel(value: string | null): string | null {
  if (value === "about:blank") return value;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

/**
 * Private browser resource behind Overseer's revocable wrapper, using the existing DO namespace.
 * The native check capability comes only from the workspace, never from browser/agent callers.
 * Native RPC disposes incoming check stubs when the method settles. All queued work is awaited;
 * no method retains or duplicates a check beyond that call. Direct invocations borrow the stub.
 */
@validateRpc()
export class ComputerSessionImpl extends DurableObject<Cloudflare.Env> {
  #browser: Browser | null = null;
  #page: Page | null = null;
  #lastActivityAt = new Date();
  #operations: Promise<unknown> = Promise.resolve();
  #importedProfile = false;

  #writeImportedState(cookies: PuppeteerCookie[], url: string): void {
    const state = JSON.stringify({ cookies, url });
    if (new TextEncoder().encode(state).byteLength > 1024 * 1024) throw new Error('Browser session too large');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS imported_browser_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO imported_browser_state VALUES (1, ?)', state);
    this.#importedProfile = true;
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation);
    this.#operations = result.catch(() => {});
    return result;
  }

  // Checking both sides of every browser await prevents launch/restore/queued operations from
  // acting on an earlier grant. A command already sent to the website cannot be undone.
  async #checked<T>(check: RpcStub<() => Promise<void>>, operation: () => Promise<T>): Promise<T> {
    await check();
    const result = await operation();
    await check();
    return result;
  }

  async #ensureBrowser(check: RpcStub<() => Promise<void>>): Promise<Page> {
    await check();
    if (!this.env.BROWSER) throw new Error("BROWSER binding not available");
    if (this.#page && this.#browser?.connected) return this.#page;
    this.#page = null;
    if (this.#browser?.connected) await this.#checked(check, () => this.#closeBrowser());
    else this.#browser = null;
    try {
      // Assign before the post-await check so a revoked launch can still be closed.
      await this.#checked(check, async () => {
        this.#browser = await launch({
          fetch: (input, init) => {
            const request = new Request(input, init);
            return this.env.BROWSER.fetch(new Request(request, {
              signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
            }));
          },
        });
      });
      const browser = this.#browser!;
      const page = await this.#checked(check, () => browser.newPage());
      page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
      await this.#checked(check, () => page.setViewport(DEFAULT_VIEWPORT));
      const stored = await this.#checked(check, () => this.ctx.storage.get<{
        cookies: PuppeteerCookie[]; url: string | null;
      }>("session-state"));
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS imported_browser_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      const imported = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM imported_browser_state WHERE id = 1').toArray()[0];
      this.#importedProfile = !!imported;
      const restored = imported ? JSON.parse(imported.value) as NonNullable<typeof stored> : stored;
      if (restored?.cookies.length) {
        await this.#checked(check, () => page.setCookie(...restored.cookies));
      }
      const url = restored?.url && computerUrlLabel(restored.url) ? restored.url : "about:blank";
      await this.#checked(check, () => page.goto(url, { timeout: NAVIGATION_TIMEOUT_MS }));
      this.#page = page;
      return page;
    } catch (cause) {
      await this.#closeBrowser().catch(() => {});
      // Provider messages can contain typed text or credential-bearing URLs. Preserve the cause
      // for local diagnosis, but never copy it into the message or structured logs.
      logger.warn("browser initialization failed", { event: "computer.session.launch.failed" });
      throw new Error("Failed to start Computer", { cause });
    }
  }

  async #run<T>(check: RpcStub<() => Promise<void>>, operation: (page: Page) => Promise<T>, persist = false): Promise<T> {
    return this.#serialize(async () => {
      const page = await this.#ensureBrowser(check);
      try {
        const result = await this.#checked(check, () => operation(page));
        if (persist) {
          if (this.#importedProfile) {
            const cdp = await this.#checked(check, () => page.createCDPSession());
            try {
              const { cookies } = await this.#checked(check, () => cdp.send('Storage.getCookies'));
              this.#writeImportedState(importedCookies.parse(cookies), page.url());
            } finally { await cdp.detach(); }
          } else {
            const cookies = await this.#checked(check, () => page.cookies());
            await this.#checked(check, () => this.ctx.storage.put("session-state", { cookies, url: page.url() }));
          }
        }
        this.#lastActivityAt = new Date();
        return result;
      } catch (cause) {
        throw new Error("Computer operation failed or access changed", { cause });
      }
    });
  }

  /** Navigate under a live workspace authorization check. */
  async workspace(check: RpcStub<() => Promise<void>>, operation: ComputerOperation): Promise<ComputerResult> {
    await check();
    if (!this.env.COMPUTER_RUNTIME) throw new Error('Computer runtime is not configured');
    return this.env.COMPUTER_RUNTIME.run(this.ctx.id.toString(), operation, check);
  }

  /** Stop shell execution without deleting the private durable workspace. */
  async stopWorkspace(): Promise<void> { await this.env.COMPUTER_RUNTIME?.stop(this.ctx.id.toString()); }

  /** Navigate under a live workspace authorization check. */
  async navigate(check: RpcStub<() => Promise<void>>, url: string): Promise<void> {
    if (!computerUrlLabel(url) || url.length > 8192) throw new Error("Unsupported browser URL");
    await this.#run(check, async page => {
      await page.goto(url, { timeout: NAVIGATION_TIMEOUT_MS });
    }, true);
  }

  /** Capture a viewport only while the caller still has read authority. */
  async screenshot(check: RpcStub<() => Promise<void>>): Promise<Uint8Array> {
    return this.#run(check, page => page.screenshot({ type: "png" }));
  }

  /** Click inside the fixed viewport under live authorization. */
  async click(check: RpcStub<() => Promise<void>>, x: number, y: number): Promise<void> {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 ||
        x >= DEFAULT_VIEWPORT.width || y >= DEFAULT_VIEWPORT.height) {
      throw new Error("Click must be inside the browser viewport");
    }
    await this.#run(check, page => page.mouse.click(x, y), true);
  }

  /** Type bounded text without placing it in diagnostics. */
  async type(check: RpcStub<() => Promise<void>>, text: string): Promise<void> {
    if (text.length > 4096) throw new Error("Browser text exceeds 4096 characters");
    await this.#run(check, async page => {
      const deadline = Date.now() + 30_000;
      // Puppeteer's type() issues one command per character; recheck between them as well.
      for (const character of text) {
        if (Date.now() >= deadline) throw new Error("Browser typing timed out");
        await this.#checked(check, () => page.keyboard.type(character));
      }
    }, true);
  }

  /** Deliver a transient value only to the focused input on the owner-confirmed origin. */
  async fillSecret(check: RpcStub<() => Promise<void>>, origin: string, value: string): Promise<void> {
    try {
      if (!value || value.length > 4096) throw new Error('Invalid secret length');
      await this.#run(check, async page => {
        if (new URL(page.url()).origin !== origin) throw new Error('Destination changed');
        const field = await this.#checked(check, () => page.$('input:focus'));
        if (!field) throw new Error('Focus a destination input first');
        try {
          await this.#checked(check, () => field.evaluate((input, expectedOrigin) => {
            if (input.ownerDocument.location.origin !== expectedOrigin) throw new Error('Destination changed');
            input.setAttribute('type', 'password');
            input.value = '';
          }, origin));
          const deadline = Date.now() + 30_000;
          for (const character of value) {
            if (Date.now() >= deadline) throw new Error('Secret entry timed out');
            await this.#checked(check, () => field.type(character));
          }
        } finally { await field.dispose(); }
      }); // No session persistence, audit payload or screenshot on the secret-delivery path.
    } catch {
      throw new Error('Secret entry failed; use Computer view');
    } finally { value = ''; }
  }

  /** Import an owner-selected cookie export without exposing values to an agent-facing API. */
  async importCookies(check: RpcStub<() => Promise<void>>, data: Uint8Array): Promise<void> {
    try {
      if (data.byteLength > 1024 * 1024) throw new Error('Cookie export too large');
      const cookies = importedCookies.parse(JSON.parse(new TextDecoder().decode(data)));
      await this.#run(check, async page => {
        for (const cookie of cookies) await this.#checked(check, () => page.setCookie(cookie));
        // Imported origins may differ from the current tab; persist the whole explicit import.
        this.#writeImportedState(cookies, page.url());
      });
    } catch { throw new Error('Could not import browser session'); }
  }

  /** Scroll by finite deltas clamped to ten viewports. */
  async scroll(check: RpcStub<() => Promise<void>>, deltaX: number, deltaY: number): Promise<void> {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new Error("Invalid scroll delta");
    await this.#run(check, page => page.mouse.wheel({
      deltaX: Math.max(-12800, Math.min(deltaX, 12800)),
      deltaY: Math.max(-7200, Math.min(deltaY, 7200)),
    }), true);
  }

  /** Press a bounded key name; Puppeteer validates its supported keyboard layout. */
  async key(check: RpcStub<() => Promise<void>>, key: string): Promise<void> {
    if (key.length > 32) throw new Error("Invalid browser key");
    await this.#run(check, page => page.keyboard.press(key as KeyInput), true);
  }

  /** Wait without launching, clamping finite durations to zero through ten seconds. */
  async wait(check: RpcStub<() => Promise<void>>, ms: number): Promise<void> {
    if (!Number.isFinite(ms)) throw new Error("Invalid browser wait duration");
    await this.#serialize(() => this.#checked(check, () =>
      new Promise<void>(resolve => setTimeout(resolve, Math.max(0, Math.min(ms, 10_000))))));
  }

  /** Read sanitized resource metadata without launching or returning the private stored URL. */
  async getState(check: RpcStub<() => Promise<void>>): Promise<Omit<ComputerSessionState, "agentId">> {
    return this.#serialize(() => this.#checked(check, async () => ({
      currentUrl: computerUrlLabel(this.#page?.url() ?? null),
      lastActivityAt: this.#lastActivityAt,
    })));
  }

  async #closeBrowser(): Promise<void> {
    const browser = this.#browser;
    this.#page = null;
    if (browser) {
      try {
        await browser.close();
        this.#browser = null;
      } catch (cause) {
        logger.warn("browser close failed", { event: "computer.session.close.failed" });
        throw new Error("Failed to close Computer resource", { cause });
      }
    }
  }

  /** Release resources under the caller's live authorization; does not revoke a grant. */
  async close(check: RpcStub<() => Promise<void>>): Promise<void> {
    await this.#serialize(() => this.#checked(check, () => this.#closeBrowser()));
  }

  /** Kernel-only cleanup after the owner has persisted disabled mode. Does not clear cookies. */
  async stop(): Promise<void> {
    await this.#serialize(() => this.#closeBrowser());
  }
}
