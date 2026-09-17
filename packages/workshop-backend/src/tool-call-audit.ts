/** Append-only pre-dispatch evidence. Admission is not evidence that a tool ran or succeeded. */
export type ToolCallAuditRecord = {
  id: string;
  chatId: number;
  modelId: string;
  agentProfileId?: string;
  execution?: {id: string; attempt: number};
  recordedAt: Date;
  /** Deliberately excludes arguments, outputs, prompts, credentials and error bodies. */
  calls: {toolCallId: string; toolName: string}[];
};
