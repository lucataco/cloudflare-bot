import type {AiChatMetadata, NamedDelegationInput, NamedDelegationReceipt, WorkpieceId} from "@gadgets/workshop-shared/api";
import type {UserAiModelRecord} from "./user.js";

/** An inert, turn-local preparation. Model credentials here must never be persisted or returned. */
export type PreparedNamedDelegation = {
  /** A group handoff reuses this step's admission barrier and the root round's bounded authority. */
  group?: NonNullable<AiChatMetadata['groupParent']>;
  id: string;
  input: NamedDelegationInput;
  parentChatId: number;
  execution: {id: string; attempt: number};
  generation: number;
  configRevision: number;
} & ({
  existing: NamedDelegationReceipt;
} | {
  model: UserAiModelRecord;
  targetName: string;
  targetInstructions: string;
  bindings: Record<string, WorkpieceId>;
});

/** Lifetime admissions per logical parent, including deleted children and retries. */
export const MAX_NAMED_CHILDREN = 4;
/** Maximum explicit targets in one workspace's delegation policy. */
export const MAX_NAMED_TARGETS = 8;
/** Maximum explicitly forwarded external resources per child. */
export const MAX_NAMED_BINDINGS = 8;
/** Maximum UTF-8 bytes of model-authored task/context text. */
export const MAX_DELEGATION_PROMPT_BYTES = 16 * 1024;
/** Maximum UTF-8 bytes of snapshotted target standing instructions. */
export const MAX_DELEGATION_INSTRUCTIONS_BYTES = 32 * 1024;
/** Maximum UTF-8 bytes returned from a child's assistant text. */
export const MAX_DELEGATION_RESULT_BYTES = 8 * 1024;
