# Grok Agent Shell: Bot-First Workshop Architecture

*Companion roadmap for the agent shell evolution — persistent agent identities, multi-bot collaboration, computer access, and routines. This is a product plan, not an implementation guide.*

## Vision: Luis's Specification

Agent shell (workshop-frontend). Sidebar is Bots, not workspaces. Chat is a teammate thread. Header opens an agent pane. Restyle gatekeeper approval cards to Grok's Allow once / Always / Deny. Workspaces and gadgets remain, just not the home.

Persistent Agent identity (workshop-backend user DO, keep the kernel diff small). A Bot is a durable record: id, name, title, description, avatar, defaultModel, memory, notification prefs. Today "agent" is just AiChatAuthorInfo plus lastSelectedModel in localStorage (modelSelection.ts). That is not a teammate.

Models: per-agent default, composer override, Settings → Agent → Default Model. Advanced (AddModelModal.tsx pattern): provider, custom model id, API URL, reasoning/thinking, temperature, max tokens, AI Gateway vs BYOK. Providers already in tree: Anthropic, OpenAI, Google, Workers AI, Ollama.

Multi-bot. Agent-to-agent over Cap'n Web, group threads as a workspace with multiple agent authors. User stops being the router.

Computer. User-scoped Dynamic Worker desktop, per-bot screen (Facets already do this). Preview in the agent pane. Human takeover for password / 2FA / captcha. All network still through gatekeepers.

Routines. Lift gatekeeper-scheduler into a first-class Routines list on the agent pane. Learn-from-demo later.

Keep the CFOS superpower: a Bot can still build a gadget. Blueprints stay. Context Library becomes per-agent memory. HITL simulation stays, it is better than Grok's stop-and-wait.

## Status on main

HEAD `0cef8f462333f4f091364de5feddc93562f095ff`. PRs 1–19 landed on lucataco/cloudflare-bot.

### Shipped

- **Agent shell foundation**: Sidebar Bots list, AgentProfile with persistent defaultModelId, description field, avatar. AgentShell flag enabled for dogfood.
- **Messenger chrome**: Persistent bot rail on every screen (`MessengerShell`). Home is `/agents` → last bot or first-bot setup. Clicking a bot opens `/agents/$id` (group: `/groups/$id`) without dropping the list. GadgetEditor is a thread: bot header, chat-first, Gadget/Computer/Skills/Memory/Routines as panes. Workspace URLs for agent chats redirect into the thread.
- **Per-bot bindings**: Connector accounts remain user-scoped; bindings are per-agent.
- **Group chats (partial)**: Chat supports multiple members, but one active agent only. User still routes between agents.
- **Computer access**: Per-bot BROWSER session (not full Dynamic Worker desktop yet), computer tools integrated, ComputerView in UI, auto-screenshot on tool use.
- **Routines**: Scheduled callbacks lifted from gatekeeper-scheduler into first-class UI. Slack/GitHub event triggers with signature/webhook hardening.
- **Skills & memory**: Per-bot named skills (recipes) and durable per-bot memory storage.
- **Approval UX polish**: Bordered cards, filled Approve button. Always-approve available when eligible.
- **Workers AI limits**: `max_tokens` remaining-window cap, shared `computeTokenLimits`, catalog-miss 24k fallback, workersAiCompat `maxTokensField` routing to `max_tokens` (PRs 16–19).

- **FIFO chat queue**: Send while a turn is running enqueues on the workspace DO (`chatQueue`). Drain is one prompt per subsequent turn. Cancel, edit, reorder, pause, and steer. Stop aborts only the current turn (next queued item starts unless paused). Gatekeeper HITL is unchanged.
- **Unified inspector**: One docked right pane (Computer / Gadget / Files / Skills / Memory / Routines / Settings). Computer is embedded, not a modal. `/agent/$id/{skills,memory,routines}` redirect into the thread.

### Remaining Work

- **Composer model picker**: Empty bot threads use `AgentProfile.defaultModelId` (not “No agent”). Per-bot composer override in localStorage. Explicit No agent still works.

### Remaining Work

1. **Roster presence**: Last-message preview, unread, and working dots on bot rows (small `listAgents` projection).
2. **Approval labels**: May still say "Approve" not "Allow once / Always / Deny" in some flows.
3. **Multi-bot routing**: Groups still user-routed, not true agent-to-agent over Cap'n Web with multiple active authors.
4. **Computer full vision**: Current BROWSER session vs target Dynamic Worker desktop with human takeover for password/2FA/captcha.
5. **Notification preferences**: Not yet exposed on AgentProfile.
6. **Per-agent Context Library**: Context Library still global, not scoped per agent as memory.
7. **Learn-from-demo**: Future routines capability.
8. **Workers AI Llama 3.3**: Local dogfood still returns 400 post-PR 19 (wire debugging, not shell work).

## Architecture Notes

The agent shell preserves CFOS's core strengths while shifting the UI model toward persistent bot identities:

- **Kernel impact**: Changes to workshop-backend remain small and incremental. AgentProfile extends the existing user DO pattern. The Cap'n Web RPC layer already supports the multi-agent communication model.
- **Gadgets stay**: Bot-built gadgets remain first-class. Blueprints and the gadget workspace stay intact. The shell change moves the home view, not the capabilities.
- **HITL advantage**: Approval-queue simulation (queued actions, in-chat cards, explicit approval) beats stop-and-wait patterns. This stays.
- **Phased rollout**: The agentShell flag controls exposure. Incremental PRs keep review surface small.
