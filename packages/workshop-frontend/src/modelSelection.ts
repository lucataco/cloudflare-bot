import type { AiChatAuthorInfo, AgentProfile } from "@gadgets/workshop-shared/api";

const LAST_SELECTED_MODEL_KEY = "lastSelectedModel";

/** Sentinel used for UI values and localStorage so an explicit null choice can persist. */
export const NO_AGENT_OPTION_VALUE = "__gadgets_no_agent__";

function botComposerModelKey(agentId: string): string {
  return `gadgets:composer-model:${agentId}`;
}

function inCatalog(models: AiChatAuthorInfo[], modelId: string | null | undefined): modelId is string {
  return typeof modelId === "string" && models.some((model) => model.id === modelId);
}

export function readBotComposerModel(agentId: string): string | null | undefined {
  try {
    const stored = localStorage.getItem(botComposerModelKey(agentId));
    if (stored === null) return undefined;
    if (stored === NO_AGENT_OPTION_VALUE) return null;
    return stored;
  } catch {
    return undefined;
  }
}

export function persistBotComposerModel(agentId: string, modelId: string | null): void {
  try {
    localStorage.setItem(botComposerModelKey(agentId), modelId ?? NO_AGENT_OPTION_VALUE);
  } catch {
    // private mode
  }
}

/**
 * Resolve the composer model for a thread.
 *
 * Agent-bound: per-bot override, then `defaultModelId`, then last agent message, then first catalog
 * model. A global "No agent" store does not override a bot default.
 *
 * Workshop (no profile): inferred message model, then global store (including explicit No agent),
 * then first catalog model.
 */
export function resolveComposerModel({
  models,
  agentProfile,
  inferredFromMessages = null,
}: {
  models: AiChatAuthorInfo[];
  agentProfile?: AgentProfile | null;
  inferredFromMessages?: string | null;
}): string | null {
  if (agentProfile) {
    const botOverride = readBotComposerModel(agentProfile.id);
    if (botOverride === null) return null;
    if (inCatalog(models, botOverride)) return botOverride;
    if (inCatalog(models, agentProfile.defaultModelId)) return agentProfile.defaultModelId;
    if (inCatalog(models, inferredFromMessages)) return inferredFromMessages;
    return models[0]?.id ?? null;
  }

  if (inCatalog(models, inferredFromMessages)) return inferredFromMessages;
  return getStoredSelectedModel(models);
}

/**
 * Get the initial model selection for a chat, considering agent defaults.
 */
export function getInitialSelectedModel(
  models: AiChatAuthorInfo[],
  agentProfile?: AgentProfile | null,
): string | null {
  return resolveComposerModel({ models, agentProfile });
}

export function getStoredSelectedModel(
  models: AiChatAuthorInfo[],
): string | null {
  let storedModel: string | null;
  try {
    storedModel = localStorage.getItem(LAST_SELECTED_MODEL_KEY);
  } catch {
    storedModel = null;
  }

  if (storedModel === NO_AGENT_OPTION_VALUE) {
    return null;
  }

  if (storedModel && models.some((model) => model.id === storedModel)) {
    return storedModel;
  }

  return models[0]?.id ?? null;
}

export function persistSelectedModel(modelId: string | null): void {
  try {
    localStorage.setItem(
      LAST_SELECTED_MODEL_KEY,
      modelId ?? NO_AGENT_OPTION_VALUE,
    );
  } catch {
    // private mode
  }
}

export function toModelSelectValue(modelId: string | null): string {
  return modelId ?? NO_AGENT_OPTION_VALUE;
}

export function fromModelSelectValue(value: string): string | null {
  return value === NO_AGENT_OPTION_VALUE ? null : value;
}
