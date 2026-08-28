import { DurableObject } from "cloudflare:workers";
import { launch, type Page, type Browser } from "@cloudflare/puppeteer";
import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";

type ComputerSessionLogFields = {
  event?: string;
  error?: unknown;
  agentId?: string;
};

const logger = createLogger<ComputerSessionLogFields>({ component: "workshop.computer-session" });

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export interface ComputerSessionState {
  agentId: string;
  currentUrl: string | null;
  lastActivityAt: Date;
}

@validateRpc()
export class ComputerSession extends RpcTarget {
  navigate(url: string): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  getState(): Promise<ComputerSessionState>;
  close(): Promise<void>;
}

export class ComputerSessionImpl extends DurableObject implements ComputerSession {
  #agentId: string;
  #browser: Browser | null = null;
  #page: Page | null = null;
  #lastActivityAt: Date = new Date();
  #currentUrl: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#agentId = ctx.id.toString();
  }

  async #ensureBrowser(): Promise<Page> {
    if (!this.env.BROWSER) {
      throw new Error("BROWSER binding not available");
    }

    if (!this.#browser || !this.#page) {
      this.#browser = await launch(this.env.BROWSER);
      this.#page = await this.#browser.newPage();
      await this.#page.setViewport(DEFAULT_VIEWPORT);
      
      const storedState = await this.ctx.storage.get<{ cookies: any[], url: string | null }>("session-state");
      if (storedState) {
        if (storedState.cookies && storedState.cookies.length > 0) {
          await this.#page.setCookie(...storedState.cookies);
        }
        if (storedState.url) {
          this.#currentUrl = storedState.url;
          await this.#page.goto(storedState.url);
        }
      } else {
        await this.#page.goto("about:blank");
        this.#currentUrl = "about:blank";
      }
    }

    this.#lastActivityAt = new Date();
    return this.#page;
  }

  async #persistState(): Promise<void> {
    if (!this.#page) return;

    try {
      const cookies = await this.#page.cookies();
      await this.ctx.storage.put("session-state", {
        cookies,
        url: this.#currentUrl,
      });
    } catch (error) {
      logger.warn("failed to persist session state", {
        event: "computer.session.persist.failed",
        agentId: this.#agentId,
        error,
      });
    }
  }

  async navigate(url: string): Promise<void> {
    const page = await this.#ensureBrowser();
    await page.goto(url);
    this.#currentUrl = url;
    await this.#persistState();
  }

  async screenshot(): Promise<Uint8Array> {
    const page = await this.#ensureBrowser();
    const screenshot = await page.screenshot({ type: "png" });
    return screenshot;
  }

  async click(x: number, y: number): Promise<void> {
    const page = await this.#ensureBrowser();
    await page.mouse.click(x, y);
    await this.#persistState();
  }

  async type(text: string): Promise<void> {
    const page = await this.#ensureBrowser();
    await page.keyboard.type(text);
    await this.#persistState();
  }

  async getState(): Promise<ComputerSessionState> {
    return {
      agentId: this.#agentId,
      currentUrl: this.#currentUrl,
      lastActivityAt: this.#lastActivityAt,
    };
  }

  async close(): Promise<void> {
    if (this.#browser) {
      await this.#browser.close();
      this.#browser = null;
      this.#page = null;
    }
  }
}
