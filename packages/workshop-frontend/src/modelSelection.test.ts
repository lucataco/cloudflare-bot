import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile, AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import {
  NO_AGENT_OPTION_VALUE,
  persistBotComposerModel,
  persistSelectedModel,
  resolveComposerModel,
} from "./modelSelection";

const store = new Map<string, string>();

vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
  clear: () => { store.clear(); },
});

const models = [
  { id: "model-a", name: "A" },
  { id: "model-b", name: "B" },
] as AiChatAuthorInfo[];

function agent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "bot-1",
    name: "Alex",
    title: "Builder",
    description: "",
    defaultModelId: "model-b",
    workspaceId: "ws-1",
    created: new Date(0),
    updated: new Date(0),
    ...overrides,
  };
}

describe("resolveComposerModel", () => {
  afterEach(() => {
    store.clear();
  });

  it("uses the agent default on an empty thread instead of No agent", () => {
    expect(resolveComposerModel({
      models,
      agentProfile: agent(),
      inferredFromMessages: null,
    })).toBe("model-b");
  });

  it("falls back to the first catalog model when the agent default is missing", () => {
    expect(resolveComposerModel({
      models,
      agentProfile: agent({ defaultModelId: "gone" }),
      inferredFromMessages: null,
    })).toBe("model-a");
  });

  it("uses a per-bot override over the agent default", () => {
    persistBotComposerModel("bot-1", "model-a");
    expect(resolveComposerModel({
      models,
      agentProfile: agent(),
      inferredFromMessages: "model-b",
    })).toBe("model-a");
  });

  it("honors an explicit per-bot No agent override", () => {
    persistBotComposerModel("bot-1", null);
    expect(resolveComposerModel({
      models,
      agentProfile: agent(),
    })).toBeNull();
  });

  it("does not let a global No agent store override a bot default", () => {
    persistSelectedModel(null);
    expect(resolveComposerModel({
      models,
      agentProfile: agent(),
      inferredFromMessages: null,
    })).toBe("model-b");
  });

  it("does not leak a per-bot override to another bot", () => {
    persistBotComposerModel("bot-1", "model-a");
    expect(resolveComposerModel({
      models,
      agentProfile: agent({ id: "bot-2", defaultModelId: "model-b" }),
    })).toBe("model-b");
  });

  it("workshop empty thread with a catalog picks the first model, not No agent", () => {
    expect(resolveComposerModel({
      models,
      inferredFromMessages: null,
    })).toBe("model-a");
  });

  it("workshop honors a stored explicit No agent", () => {
    persistSelectedModel(null);
    expect(resolveComposerModel({
      models,
      inferredFromMessages: null,
    })).toBeNull();
  });

  it("workshop uses the inferred thread model when it is in the catalog", () => {
    expect(resolveComposerModel({
      models,
      inferredFromMessages: "model-b",
    })).toBe("model-b");
  });
});

describe("persistBotComposerModel", () => {
  afterEach(() => {
    store.clear();
  });

  it("round-trips No agent as the sentinel", () => {
    persistBotComposerModel("bot-1", null);
    expect(store.get("gadgets:composer-model:bot-1")).toBe(NO_AGENT_OPTION_VALUE);
  });
});
