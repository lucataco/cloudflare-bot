import type { WorkerEntrypoint, RpcStub } from 'cloudflare:workers';

/** A bounded operation on one bot's isolated, checkpointed /workspace. */
export type ComputerOperation = {
  /** Execute a shell command with /workspace as its working directory. */
  kind: 'exec';
  /** Shell program, run with container authority, not host authority. */
  command: string;
} | {
  /** List, read or remove an entry beneath /workspace. */
  kind: 'list' | 'read' | 'delete';
  /** Relative path, or an absolute /workspace path. */
  path: string;
} | {
  /** Replace a bounded file, creating parent directories. */
  kind: 'write';
  /** Relative path, or an absolute /workspace path. */
  path: string;
  /** Base64-encoded file bytes. */
  data: string;
};

/** An acknowledged operation result. Mutations return only after their checkpoint is durable. */
export type ComputerResult = {
  /** Process exit code (including nonzero shell exits). */
  exitCode: number;
  /** Bounded process output; never emitted to server logs. */
  stdout: string;
  /** Bounded diagnostics returned only to the caller. */
  stderr: string;
  /** File content, for read operations. */
  data?: string;
  /** Relative directory entries, for list operations. */
  entries?: { /** Entry name. */ name: string; /** Entry kind. */ kind: 'file' | 'directory' }[];
};

/** Private Worker-to-Worker computer service. Only the kernel chooses the bot key and check capability. */
export interface ComputerRuntimeApi extends WorkerEntrypoint {
  /** Run under live kernel authorization; infrastructure failures are never automatically replayed. */
  run(key: string, operation: ComputerOperation, check: RpcStub<() => Promise<void>>): Promise<ComputerResult>;
  /** Interrupt a bot's running container while retaining its last acknowledged checkpoint. */
  stop(key: string): Promise<void>;
}
