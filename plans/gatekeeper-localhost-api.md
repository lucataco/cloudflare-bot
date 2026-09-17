# Local computer gatekeeper: API review

Proposed resource capabilities for `gatekeeper-localhost`. Pairing connects one desktop to one
Workshop account; the owner then introduces individual resources into a bot's workspace.
Pairing alone does not make local access ambient.

## Resources

- **Folder**: `localhost://<device-id>/folders/<grant-id>`. The desktop user selects the actual
  directory in the local grant configuration. Paths in the agent API are relative to that directory. File reads
  and listings are observations; writes and copies use queued actions and a pending-write overlay.
- **Execution**: `localhost://<device-id>/execution`. Separately enabled machine-level authority.
  A process working directory is not a sandbox: executable programs can reach other files and the
  network as the desktop user. Commands are bounded asynchronous jobs, started only on approval.
- **Network**: `localhost://<device-id>/network/<grant-id>`. Separately selected destination origins,
  using the desktop's network. Requests are bounded jobs; redirects must remain within the grant.

Private-only observer policy for all local resources. Closing/revoking the desktop connection
fences outstanding work. Reconnection must not replay an uncertain shell command.

## Proposed agent-facing types

```ts
/** A directory explicitly shared from a paired desktop. Paths are relative to its root. */
interface LocalFolderSession {
  /** List entries in a directory. Symlinks and paths outside this folder cannot be followed. */
  list(path: string): Promise<Array<{ name: string; kind: "file" | "directory" }>>;
  /** Read a bounded file as bytes. */
  readFile(path: string): Promise<Uint8Array>;
  /** Replace a file with the supplied bytes. Parent directories must already exist. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Copy a file within this folder without exposing its content to the caller. */
  copyFile(source: string, destination: string): Promise<void>;
}

/** Explicit machine-level process access on a paired desktop. */
interface LocalExecutionSession {
  /** Schedule a process; returns an identifier for checking its outcome. */
  execute(command: string, args: string[], options: { cwd?: string; timeoutMs?: number }): Promise<string>;
  /** Read a job's current state and bounded output. No output is available until execution. */
  getJob(id: string): Promise<LocalJob>;
}

/** An outbound request capability limited to desktop-owner-selected origins. */
interface LocalNetworkSession {
  /** Schedule a bounded HTTP request via the desktop network. */
  request(url: string, options: { method: "GET" | "POST"; body?: string }): Promise<string>;
  /** Read a request job's state and bounded response. */
  getJob(id: string): Promise<LocalJob>;
}

/** Asynchronous operation state. Failed jobs report a sanitized error, never private credentials. */
type LocalJob =
  | { state: "scheduled" | "running" }
  | { state: "finished"; output: string; exitCode?: number }
  | { state: "failed"; error: string };
```

Cloud-to-local transfer composes the existing workspace file APIs with `LocalFolderSession`.
Chrome import is a separate owner-driven desktop operation selecting a profile and target bot;
it never exposes browser credentials through the agent API. It requires OS-specific profile
handling and is not implied by granting file access or network routing.

## Desktop shell

Tauri hosts the existing deployed Workshop frontend, with an explicitly configured HTTPS origin.
Native notifications, a New bot menu/`CmdOrCtrl+N`, and a tray/menu-bar entry are shell features.
Remote web content receives no general filesystem or shell Tauri permission. Local resource
execution is owned by the paired daemon, not by renderer `invoke()` calls.

## Review checkpoint

The operator approved this capability API and subsequently approved the queued-action,
simulation and observer phase. The implementation is in `packages/gatekeeper-localhost`.
