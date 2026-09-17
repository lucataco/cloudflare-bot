/** A folder explicitly shared from a paired desktop. Paths are relative to its root. */
export interface LocalFolderSession {
  /** List bounded directory entries without following symlinks. */
  list(path: string): Promise<Array<{ name: string; kind: "file" | "directory" }>>;
  /** Read a file of at most one MiB. */
  readFile(path: string): Promise<Uint8Array>;
  /** Replace a file of at most one MiB. Parent directories must already exist. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Copy a file within this folder. */
  copyFile(source: string, destination: string): Promise<void>;
}
/** Machine-level process access explicitly enabled on a paired desktop. A cwd is not a sandbox. */
export interface LocalExecutionSession {
  /** Schedule a process and return the ID used to inspect its result. */
  execute(command: string, args: string[], options: { cwd?: string; timeoutMs?: number }): Promise<string>;
  /** Read an asynchronous job's state and bounded output. */
  getJob(id: string): Promise<LocalJob>;
}
/** Requests routed through the desktop, limited to origins selected by its owner. */
export interface LocalNetworkSession {
  /** Schedule a bounded HTTP request and return its job ID. */
  request(url: string, options: { method: "GET" | "POST"; body?: string }): Promise<string>;
  /** Read a request's state and bounded response. */
  getJob(id: string): Promise<LocalJob>;
}
/** Asynchronous operation outcome. Output is available only after execution completes. */
export type LocalJob = { state: "scheduled" | "running" } |
  { state: "finished"; output: string; exitCode?: number } | { state: "failed"; error: string };
