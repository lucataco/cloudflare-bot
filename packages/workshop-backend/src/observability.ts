import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";
import { createTracer } from "@gadgets/backend-utils/tracing";

/** Observability fields emitted by the Workshop backend. */
export type WorkshopObservabilityFields = {
  accountId: number;
  actionId: number | string;
  autoProvisioned: boolean;
  blueprintId: string;
  callbackInitiated: boolean;
  chatId: number;
  commitCount: number;
  contextWindow: number;
  durableObjectId: string;
  durationMs: number;
  eventName: string;
  executionId: string;
  failureCount: number;
  finalContextTokens: number;
  gadgetId: string;
  gatekeeperId: number | string;
  hasToolResultImages: boolean;
  logBytes: number;
  maxOutputTokens: number;
  maxTokens: number;
  modelId: string;
  observerId: string;
  operation: string;
  outcome: "ok" | "error" | "usage_limit" | "callbacks_stalled" | "no_email" | "signups_disabled";
  path: string;
  requestMaxCompletionTokens: number;
  requestMaxTokens: number;
  requestMessageCount: number;
  requestMessages: Array<{ role: string; contentTypes: string[] }>;
  requestPromptChars: number;
  requestUrl: string;
  resourceTitle: string;
  sequence: number;
  size: number;
  status: number;
  statusCode: number;
  statusText: string;
  supportsImages: boolean;
  toolCallId: string;
  toolName: string;
  vendorId: string;
};

/** Ambient observability fields for one Workshop operation. */
export const obsContext = createObservabilityContext<WorkshopObservabilityFields>();

/** Creates a logger restricted to the Workshop backend's field vocabulary. */
export function createWorkshopLogger(component: string) {
  return obsContext.createLogger({ component });
}

/** Runs `callback` in a trace span carrying the ambient observability fields as attributes. */
export const traced = createTracer(obsContext.get);
