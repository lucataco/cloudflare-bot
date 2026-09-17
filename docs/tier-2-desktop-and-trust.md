# Desktop, local capabilities and review controls

## Reference study

This implementation was written against the Workshop's existing capability and approval APIs.
The following public repositories were read as behavioral references; their implementation code
and prompt text were not incorporated into this repository.

| Reference | Revision examined | Findings used |
| --- | --- | --- |
| [Grok Bot 0.18 runtime archive](https://github.com/ChHsiching/grok-bot-0.18-original/tree/bd06ef2cab1becec4b78d5237790a6783737460b) | `bd06ef2` | The shipped runtime is unminified. Its README explicitly says the minified renderer is **not included**, so this archive does not establish the exact avatar state machine or complete UI strings. |
| [Grok CLI](https://github.com/ScriptedAlchemy/grok-bot-cli/tree/17fbbad21c340c915f9073319acafbad6d6910b4) | `17fbbad` | `src/core/grok-approvals.js` distinguishes pending auto-review and local-tool permission requests, retaining request/entry identity and displaying command, working directory, machine and surface. A chat reply is not an approval. |
| [OpenBot boundaries](https://github.com/CopilotKit/OpenBot/blob/2e43afd61afd5a5f1a93b2b03148a57481208afb/app/src/routes/_authed/admin/boundaries.tsx) | `2e43afd` | The UI makes scope, precedence and the effect of a rule visible. Workshop uses exact connector/action-kind scopes rather than adopting its CEL policy engine. |

The runtime's `packages/agent/dist/prompts/system.js` derives prompt-visible tool information from
the actual tool set, including edit capabilities and delegation descriptions. Its
`prompts/skill-catalog-budget.js` progressively reduces skill descriptions/catalog entries under a
budget. These are useful structural references, not templates to copy. Workshop continues to use
its own model prompts, capability catalog and compaction mechanisms.

The five roster states remain Workshop's own execution/attention projection. Exact Grok renderer
transitions are unverified. No installer was decompiled, no private gateway was contacted, and no
noVNC or Cursor-hosted-computer dependency was introduced.

## Tauri desktop shell

Prerequisites: the repository's pnpm toolchain, Rust, and Tauri's platform build prerequisites.

```sh
pnpm install
pnpm --filter @gadgets/workshop-desktop dev
```

Enter the deployment URL in the local setup window. HTTPS is required except for loopback development.
The existing deployed frontend is loaded in the native webview. The main window stays on that
origin. The app menu and tray/menu-bar entry provide Open Workshop, New bot (`Cmd/Ctrl+N`), Inbox
and Quit. Closing the Workshop window hides it; Quit ends the shell.

**Enable desktop notifications** in the sidebar opts the current session in to fixed-text native
attention notices. New attention versions are checked against each bot's notification preference;
startup does not replay historical items. The native notification command verifies the configured
origin/window and rate-limits delivery. Notification text contains no messages, prompts or secrets.

```sh
pnpm --filter @gadgets/workshop-desktop check
pnpm --filter @gadgets/workshop-desktop test:run
pnpm --filter @gadgets/workshop-desktop bundle
```

The shell's remote-webview capability contains only the fixed notification command. Filesystem,
shell and profile access are handled by the separately paired local daemon. Native signing,
notarization and release publishing remain deployment/release operations.

## Pair a local computer

`gatekeeper-localhost` is a normal optional connector. Dev/deploy configuration discovers its
Worker package like the other gatekeepers. It has no third-party OAuth credentials and declares
no ambient provisioning. For a manual deployment, bind its `GatekeeperVendor` to the backend as
`GATEKEEPER_LOCALHOST`, bind its default entrypoint to the router under the same name, and set
`BASE_URL` to the origin's `/gatekeeper/localhost` URL.

1. Create a local grant file. Paths remain on the desktop; only grant names and network origins
   are sent during pairing. For example, `grants.json`:

   ```json
   {
     "folders": { "documents": "/Users/you/Documents/Workshop" },
     "execution": false,
     "network": { "intranet": ["https://intranet.example.com"] }
   }
   ```

2. In Workshop, connect **Local computer**. Its browser popup contains a ten-minute pairing URL.
3. Run the daemon's pairing command and paste that URL at the prompt:

   ```sh
   pnpm --filter @gadgets/gatekeeper-localhost daemon pair /absolute/path/grants.json
   pnpm --filter @gadgets/gatekeeper-localhost daemon run /absolute/path/grants.json.session.json
   ```

4. Introduce one of the resource URLs printed by the daemon to a bot using Connections. Pairing
   itself grants the bot nothing. Folder, execution and network introductions are separate.

The daemon uses outbound authenticated polling, so it needs no inbound port or public tunnel.
Its saved session file is created with owner-only permissions and contains its revocable device
credential. Remove the connected account to revoke pairing. A new pairing creates a new device;
existing resource URLs cannot silently acquire a replacement machine.

### Resource semantics

| Resource | Behavior |
| --- | --- |
| Folder | Relative-path listings/reads are observations. Writes and copies are queued actions; reads/listings overlay confirmed pending writes. Absolute paths, `..` traversal and symlink traversal are rejected. Files are capped at 1 MiB. |
| Execution | Separately enabled machine-level process authority. Commands run as the desktop user, with a bounded output and timeout. A working directory is not an OS sandbox. Execution jobs always require an explicit approval. |
| Desktop network | Separately granted exact HTTP(S) origins. Requests use the desktop network, reject redirects and URL credentials, and have bounded responses. This is a scoped request route, not a system-wide VPN. Network jobs always require explicit approval. |

Execution/network methods return a job ID. `getJob()` reports scheduled/running/finished/failed and
only returns real output after execution. The bridge durably records dispatch before handing a
job to the daemon. Lost responses never cause a shell command to run again. An uncertain action
may need manual inspection; an already-dispatched side effect cannot be undone by revocation.
File write auto-approval is available only through an explicit workspace connection/tag rule.
All local resources reject collaborator observation.

Cloud-to-local copies compose existing workspace reads with `LocalFolderSession.writeFile()`;
local-to-cloud copies use `readFile()` and the existing workspace file APIs. There is no ambient
cloud-folder synchronization.

### Chrome session import

The explicit exporter copies selected profile database/preferences files into a temporary profile
and asks the installed Chrome to read its cookies using the OS's normal keychain integration.
It does not extract keychain keys, read passwords, or upload anything. Close Chrome first so its
cookie database is consistent. On macOS:

```sh
pnpm --filter @gadgets/gatekeeper-localhost export:chrome "/Users/you/Library/Application Support/Google/Chrome/Default" "/private/path/chrome-session.json"
```

An optional third argument selects a different Chrome executable. In the destination bot's
**Computer** view, take human control and choose **Import Chrome session**. This imports cookies,
not extensions, saved passwords, bookmarks or the whole browsing history. Values travel through
an owner-only RPC and stay in the bot's private browser state, never chat attachments/transcripts.
Delete the local export afterward. OS-specific keychain prompts and Chrome profile-version
compatibility require live verification on the target desktop; automated tests use synthetic data.

## Secure secret requests

The existing `computerRequestHuman` tool accepts an optional `secretKind`: `password`, `otp`, or
`payment-confirmation`. It first changes browser control to human-only. The transcript stores
only the request kind, ordinary reason, destination label and whether delivery was attempted.

The owner sees a masked field in the request card and Computer view. Submitting clears the input
before awaiting the RPC. The server requires the owner, a pending one-shot request, current human
control and the same HTTPS origin. The destination must be a focused input, which is masked before
entry. Provider failures are replaced with fixed errors; entry itself records no screenshot,
approval body or transcript value. Failed/uncertain delivery is not automatically repeated.

The owner completes the website interaction, checks the browser and explicitly resumes bot control.
The website receives the value, as it would during manual takeover; granting the bot control later
also grants its usual access to the resulting signed-in website. The secret transport does not
grant or resume browser authority.

## Central auto-review rules

- **Auto-review rules** (`/auto-review`) lists each workspace's connection/action-kind rules and
  shows their exact scope. Orphaned standing rules remain revocable.
- **Review boundaries** (`/admin/boundaries`) is accessible through the admin capability. An
  administrator can lock a connector, action tag, or both to **Ask first**; null/empty selector fields
  mean all. Tags are exact matches, not regexes or globs.
  Legacy connections without vendor metadata conservatively match vendor-scoped locks.
- Admin locks only restrict automatic application. They never grant access or auto-approve an
  otherwise ineligible action. Explicit human approval remains possible.
- Enforcement reads the authoritative AdminSettings DO before automatic application, not its
  eventual soft-config KV mirror. It then rechecks pending state, the action's tag/eligibility,
  workspace pause and the user's standing rule. A locked action stops the drain; later actions
  cannot jump over it.
- Browser control remains a separate coarse capability. These rules govern queued gatekeeper
  actions, not arbitrary clicks in a browser that the owner has explicitly given to an agent.

## Checks

The new local connector includes Node filesystem/process tests and workerd facet/approval tests.
Browser secret entry has synthetic runtime tests and a real WebSocket/native-RPC integration test
covering owner-only delivery, one-shot behavior, continued human control and transcript exclusion.
Admin-boundary tests exercise existing rules, policy changes and revocation during an awaited read.
The Tauri crate has an origin-boundary unit test and is checked with Cargo.
