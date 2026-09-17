import type { AttentionItem } from "@gadgets/workshop-shared/api";

/** Workspace-owned projection; it contains no prompts, titles, descriptions, or capability stubs. */
export type AttentionProjection = Pick<AttentionItem,
  "sourceId" | "kind" | "state" | "version" | "updatedAt" | "chatId" | "sequence" |
  "runId" | "actionId" | "reason"> & {
  /** False for bootstrap and resolution transitions, so catch-up does not send old alerts. */
  notify: boolean;
};

/** Versioned replacement of a workspace's bounded attention window, not a partial page. */
export type WorkspaceAttentionSnapshot = {
  /** Owner-only in-app roster data; never used in external notification payloads. */
  roster?: {
    /** At least one executing turn. */
    working: boolean;
    /** Most recent committed assistant reply. */
    lastReply?: { text: string; timestamp: number };
  };
  /** Workspace-monotonic snapshot revision, including removals and privacy changes. */
  revision: number;
  /** At most 100 retained source projections. */
  entries: AttentionProjection[];
  /** Whether bounded source bootstrap has finished. */
  complete: boolean;
  /** Sources have been omitted by retention; their canonical records are not deleted. */
  truncated: boolean;
  /** Sensitive workspaces cannot dispatch external notifications. */
  prohibitPush: boolean;
};

/** Maximum source projections retained per workspace; overflow is visible in the inbox. */
export const WORKSPACE_ATTENTION_LIMIT = 100;

/** Maximum owner-inbox records retained across all owned workspaces. */
export const OWNER_ATTENTION_LIMIT = 500;
