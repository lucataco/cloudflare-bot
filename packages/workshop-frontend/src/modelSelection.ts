import type { AiChatAuthorInfo, AgentProfile } from "@gadgets/workshop-shared/api";

const LAST_SELECTED_MODEL_KEY = "lastSelectedModel";

/** Sentinel used for UI values and localStorage so an explicit null choice can persist. */
export const NO_AGENT_OPTION_VALUE = "__gadgets_no_agent__";

/**
 * Get the initial model selection for a chat, considering agent defaults.
 * 
 * Priority:
 * 1. Agent's defaultModelId (if this workspace is bound to an agent)
 * 2. Last selected model from localStorage (if valid)
 * 3. First available model
 * 4. null (human-only)
 */
export function getInitialSelectedModel(
  models: AiChatAuthorInfo[],
  agentProfile?: AgentProfile | null,
): string | null {
  // If this workspace is bound to an agent with a default model, use it
  if (agentProfile?.defaultModelId) {
    return agentProfile.defaultModelId;
  }

  // Fall back to stored selection
  return getStoredSelectedModel(models);
}

export function getStoredSelectedModel(
  models: AiChatAuthorInfo[],
): string | null {
  const storedModel = localStorage.getItem(LAST_SELECTED_MODEL_KEY);

  if (storedModel === NO_AGENT_OPTION_VALUE) {
    return null;
  }

  if (storedModel && models.some((model) => model.id === storedModel)) {
    return storedModel;
  }

  // Default: Return the first configured model, or null if none are configured.
  return models[0]?.id ?? null;
}

export function persistSelectedModel(modelId: string | null): void {
  localStorage.setItem(
    LAST_SELECTED_MODEL_KEY,
    modelId ?? NO_AGENT_OPTION_VALUE,
  );
}

export function toModelSelectValue(modelId: string | null): string {
  return modelId ?? NO_AGENT_OPTION_VALUE;
}

export function fromModelSelectValue(value: string): string | null {
  return value === NO_AGENT_OPTION_VALUE ? null : value;
}
