import type { BotBlueprintProfile, AgentRosterState } from "@gadgets/workshop-shared/api";
import { parseAgentSeeds } from "./agent-seeds";
import { remoteAgentUrl } from "./remote-agent";
import { RpcStub, RpcTarget } from "capnweb";
import { createHash } from "node:crypto";
import type { AgentProposal, AgentProposalReceipt } from "@gadgets/workshop-shared/api";
import type { AttentionItem, AttentionPage, AttentionSubscriber, PushSettings, PushSubscriptionData } from "@gadgets/workshop-shared/api";
import { OWNER_ATTENTION_LIMIT, WORKSPACE_ATTENTION_LIMIT, type AttentionProjection, type WorkspaceAttentionSnapshot } from "./attention.js";
import { readPushConfig, validatePushSubscription, createPushRequest } from "./web-push.js";
import { createExportDeadline } from "./export-limits.js";
import { GadgetMetadataWithTimestamps, AiChatAuthorInfo, AiModelConfig, SUGGESTED_MODELS, CollaboratorRole, ConnectedAccountsSubscriber, ConnectedAccountsFilter, GatekeeperVendorFilter, GadgetMetadata, BlueprintMetadata, BlueprintLibrarySummary, BlueprintSource, BlueprintUserSummary, BLUEPRINT_SCREENSHOT_R2_PREFIX, GatekeeperVendorInfo, BlueprintOutput, OutputSummary, WorkpieceId, ListOutputsResult, AUTH_ERROR_CODES, createAuthError, AgentProfile, Group, AgentRoutine, AgentRoutineSchedule, AgentSkill } from '@gadgets/workshop-shared/api';
import { Gatekeeper, GatekeeperUser, GatekeeperUserVerifier, GatekeeperVendor, AccountDescription, VendorDescription, GatekeeperConnectCallback, SupportedResource, ResourceConfiguratorFrame, AppUiContext, GatekeeperUiFrame, AvatarImage } from "@gadgets/workshop-shared/gatekeeper";
import { shouldAutoProvisionAccount, ambientGatekeeperMode } from "./provisioning-policy.js";
import { CloudflareGatekeeperUser } from "@gadgets/workshop-shared/cloudflare-gatekeeper";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { createWorkshopLogger } from "./observability";
import { getAiGatewayConfig } from "./ai-gateway.js";
import { utcDayKey, nextUtcMidnightIso, DailyQuotaResult } from "./ai-gateway-billing/limits/config.js";
import type { AdminSettings } from "./admin-settings.js";
import { isReservedBlueprintKey, readBlueprintKvRecord } from "./blueprint-archive.js";
import { filterEnabledResources, isResourceDisabled, readAdminConfig } from "./admin-config.js";
import { buildGatekeeperVendorMap } from "./auth/auth-vendors.js";

const logger = createWorkshopLogger("workshop.user");

// How many workspaces one Outputs catch-up pass examines, bounding the Durable Objects a single
// listOutputs() call wakes and how long it waits. The client calls again until catch-up is done.
const OUTPUTS_BACKFILL_PAGE = 16;

type ConnectedAccountRecord = {
  id: number;
  account: Fetcher<GatekeeperUser>;
  description: AccountDescription;
  vendorId: string;   // Derived from the GATEKEEPER_ binding name (e.g. "google", "email").
  credentialExpiresAt?: Date;    // When credentials are expected to expire, if known.
  credentialsExpired?: boolean;  // Set true by async notification from gatekeeper.
  // True if the Workshop created this account automatically via GatekeeperVendor.createAccount()
  // (no OAuth flow), rather than the user connecting it. Such accounts are protected from manual
  // disconnect, since deleting one permanently destroys the user's data in that gatekeeper.
  autoProvisioned?: boolean;
  // For per-agent singleton accounts (e.g. Context Library), the agent this account belongs to.
  // Absent means user-global (the old behavior for non-Context gatekeepers).
  agentId?: string;
};

/**
 * Metadata about an auto-provisioned account that provides an agent singleton and/or a management UI.
 * Returned to the overseer (ambient capsules / catalog) and the management-UI listing.
 */
export type ProvidedAccountInfo = {
  accountId: number;
  vendorId: string;
  description: AccountDescription;   // carries `singleton` / `providesUi` declarations
};

// The singleton/UI methods (createAccount on GatekeeperVendor; getSingletonGatekeeperClass /
// startAppUi on GatekeeperUser) are optional on their interfaces. We don't need to probe whether a
// method is present — we already know from the declaration flags (autoProvisionsAccount /
// description.singleton / .providesUi) that we gated on — but TypeScript still can't call an optional
// method on the mapped stub type directly, so we view the stub through a plain shape that marks the
// needed method required. These are derived from the source interfaces (Pick + Required) rather than
// re-declared, so they can't drift. They are intentionally NOT wrapped in Service/Fetcher: a plain
// shape keeps the methods' declared return types (e.g. createAccount's Fetcher<GatekeeperUser>)
// usable directly, the way the runtime stub actually behaves.
type AccountCreatorStub = Required<Pick<GatekeeperVendor, "createAccount">>;
type AccountCreatorWithIdStub = Required<Pick<GatekeeperVendor, "createAccountWithId">>;
type SingletonAccountStub = Required<Pick<GatekeeperUser, "getSingletonGatekeeperClass" | "startAppUi">>;

function areCredentialsValid(record: ConnectedAccountRecord): boolean {
  if (record.credentialsExpired) return false;
  if (record.credentialExpiresAt && record.credentialExpiresAt.valueOf() < Date.now()) return false;
  return true;
}

/**
 * Vendor id of the Cloudflare gatekeeper (the suffix of GATEKEEPER_CLOUDFLARE, lowercased). The AI
 * Gateway billing flow is Cloudflare-specific, so several places key off this literal.
 */
export const CLOUDFLARE_VENDOR_ID = "cloudflare";

export type UserAiModelRecord = {
  profile: AiChatAuthorInfo;
  config: AiModelConfig;
}

export type UserChatContext = {
  profile: AiChatAuthorInfo;
  aiModel?: UserAiModelRecord;
  quickModel?: AiModelConfig;
  agentProfile?: AgentProfile;
  group?: Group;
}

type LoginSessionRecord = {
  tokenId: string,  // sha256 hash of token, hex-formatted
  created: Date,
}

// Blueprint record stored in the user's `blueprints` collection.
type BlueprintUserRecord = {
  id: string;
  metadata: BlueprintMetadata;
  gadgetId?: string;
  // Source of truth for whether the blueprint is featured deployment-wide.
  featured?: boolean;
};

type LibraryBlueprintRecord = {
  id: string;
  metadata: BlueprintMetadata;
  addedAt: Date;
  uploaded: boolean;
};

type AgentRecord = Omit<AgentProfile, "roster"> & { lastReadReplyAt?: number };

type GroupRecord = {
  multiAuthor?: boolean;
  id: string;
  name: string;
  memberAgentIds: string[];
  workspaceId: string;
  created: Date;
  updated: Date;
};

type RoutineRecord = {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  schedule: AgentRoutineSchedule;
  paused: boolean;
  hookId?: number;
  // Desired-state revision, not a timestamp. Absent on records written before registration CAS.
  revision?: number;
  created: Date;
  updated: Date;
};

function routineForClient(record: RoutineRecord): AgentRoutine {
  let {agentId: _agentId, revision: _revision, ...routine} = record;
  return routine;
}

type SkillRecord = {
  id: string;
  agentId: string;
  name: string;
  slug: string;
  description: string;
  body: string;
  created: Date;
  updated: Date;
};

// Retained after artifact deletion: recovering a lost create response must never resurrect it.
type ProposalCreationRecord = Pick<AgentProposal, "agentId" | "artifactId"> & {
  source: { workspaceId: string; proposalId: AgentProposal["proposalId"] };
  draftHash: string;
  createdAt: AgentProposalReceipt["createdAt"];
};

type MemoryNoteRecord = {
  id: string;
  agentId: string;
  fact: string;
  created: Date;
};

type GadgetRecord = GadgetMetadata & {
  created: Date;
  lastActive?: Date;  // if missing, gadget is provisional
  // If we're not the gadget owner (it was shared with us), `owner` is set (inherited from
  // GadgetMetadata).
};

function isFullyCreated(g: GadgetRecord): g is GadgetMetadataWithTimestamps {
  return g.lastActive !== undefined;
}

/**
 * One output of a workspace, as pushed into a user's output index by the Overseer that owns it
 * (see `syncWorkspaceOutputs()`). Carries only what the workspace itself knows: its title,
 * activity time and ownership are joined in from the `gadgets` collection on read, so they can't
 * go stale here.
 */
export type WorkspaceOutputEntry = {
  workpieceId: WorkpieceId;
  title: string;
  created: Date;

  /** The format the gadget was built as, if it was instantiated from a blueprint declaring one. */
  output?: BlueprintOutput;
};

type OutputRecord = WorkspaceOutputEntry & {
  // The workspace containing this output (an Overseer DO id).
  workspaceId: string;
};

type AttentionRecord = AttentionProjection & {
  id: string;
  workspaceId: string;
  agentId?: string;
  order: number;
  seenVersion?: number;
};

type AttentionReceipt = {
  roster?: WorkspaceAttentionSnapshot["roster"];
  workspaceId: string;
  revision: number;
  complete: boolean;
  prohibitPush: boolean;
  // Fences the gap between deleting a dedicated bot and the caller deleting its workspace.
  deletedAgent?: true;
};

type AttentionBootstrapJob = { workspaceId: string; attempt: number; due: number };
type PushDevice = PushSettings["devices"][number] & {
  subscription: PushSubscriptionData;
  generation: number;
};
type PushCandidate = { itemId: string; version: number };
type PushJob = {
  id: string;
  generation: number;
  revision: number;
  candidates: PushCandidate[];
  attempt: number;
  due: number;
};

function attentionRetryDelay(attempt: number): number {
  return Math.min(300_000, 5_000 * 2 ** Math.min(attempt - 1, 6));
}

async function attentionRpc<T>(work: Promise<T>): Promise<T> {
  const deadline = createExportDeadline("Attention RPC timed out.", 10_000);
  try {
    // Only the winning race may continue; late RPC completion cannot claim the job.
    return await deadline.race(work);
  } finally {
    deadline.clear();
  }
}

// AI Gateway billing state for the optional top-up flow: which Cloudflare account to bill and a
// cached credit balance. The OAuth tokens themselves live in the connected Cloudflare *gatekeeper*
// account (vendorId "cloudflare"); billing reads a usable token from there via getUsableAccessToken.
type CloudflareBilling = {
  // Selected account, once chosen (auto-selected when the grant sees exactly one).
  accountId?: string;
  accountName?: string;
  // Cached credit balance (USD) and when it was last fetched (unix ms).
  creditsRemaining?: number | null;
  creditsUpdatedAt?: number;
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length != b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}

function makeUserStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      aiModels: collection<UserAiModelRecord>()({
        primaryKey: record => record.profile.id,
      }),
      agents: collection<AgentRecord>()({
        primaryKey: "id"
      }),
      agentSeedReceipts: collection<{key: string; agentId: string}>()({primaryKey: "key"}),
      groups: collection<GroupRecord>()({
        primaryKey: "id"
      }),
      routines: collection<RoutineRecord>()({
        primaryKey: "id"
      }),
      skills: collection<SkillRecord>()({
        primaryKey: "id"
      }),
      proposalReceipts: collection<ProposalCreationRecord>()({
        primaryKey: record => `${record.source.workspaceId}:${record.source.proposalId}`,
      }),
      memory: collection<MemoryNoteRecord>()({
        primaryKey: "id"
      }),
      gadgets: collection<GadgetRecord>()({
        primaryKey: "id"
      }),
      connectedAccounts: collection<ConnectedAccountRecord>()({
        primaryKey: "id"
      }),
      sessions: collection<LoginSessionRecord>()({
        primaryKey: "tokenId",
      }),
      blueprints: collection<BlueprintUserRecord>()({
        primaryKey: "id",
      }),
      libraryBlueprints: collection<LibraryBlueprintRecord>()({
        primaryKey: "id",
      }),
      // Outputs of every workspace in `gadgets`, mirrored here by each workspace's Overseer so the
      // Outputs page is one cheap read of the user's own DO. Entries are meaningful only while the
      // corresponding `gadgets` record exists; `syncWorkspaceOutputs()` and the `gadgets` deletion
      // paths keep the two in step.
      outputs: collection<OutputRecord>()({
        primaryKey: record => `${record.workspaceId}:${record.workpieceId}`,
        nonUniqueIndexes: {
          byWorkspace(record: OutputRecord) { return record.workspaceId; },
        },
      }),
      attention: collection<AttentionRecord>()({
        primaryKey: "id",
        uniqueIndexes: { byOrder: (record: AttentionRecord) => record.order },
        nonUniqueIndexes: { byWorkspace: (record: AttentionRecord) => record.workspaceId },
      }),
      attentionReceipts: collection<AttentionReceipt>()({ primaryKey: "workspaceId" }),
      attentionBootstrapJobs: collection<AttentionBootstrapJob>()({
        primaryKey: "workspaceId",
        nonUniqueIndexes: { byDue: (record: AttentionBootstrapJob) => record.due },
      }),
      pushDevices: collection<PushDevice>()({ primaryKey: "id" }),
      // Private consent boundary, never included in the public agent profile.
      pushBotConsent: collection<{agentId: string; enableSince: number}>()({ primaryKey: "agentId" }),
      pushJobs: collection<PushJob>()({ primaryKey: "id" }),
    },
    singletons: {
      // AI Gateway billing state (selected account + cached balance) for the optional top-up flow;
      // null until a Cloudflare account is connected and resolved.
      cloudflareBilling: <CloudflareBilling | null>null,

      created: false,
      profile: <AiChatAuthorInfo>{
        type: "user",
        name: "User",
        id: "user@example.com",
      },
      quickModel: <string | null>null,
      preferredModel: <string | null>null,
      onboardingCompleted: false,

      // Set once the user's pre-existing workspaces have been asked to populate the outputs index
      // (see #backfillOutputs()). Workspaces created since push on their own.
      outputsBackfilled: false,

      // How far that catch-up has got: the last workspace id examined. The sweep runs a page at a
      // time and resumes here on the next visit.
      outputsBackfillCursor: "",

      attentionActivated: false,
      attentionScanComplete: false,
      attentionScanCursor: "",
      attentionTruncated: false,
      attentionOrder: 0,
      attentionRevision: 0,
      pushRevision: 0,

      nextAccountId: 0,
      pinnedBlueprints: <string[]>[],

      // Per-user free-tier daily LLM-call counter (only used when ENABLE_CLOUDFLARE_LIMITS is on).
      // Stores the current UTC day and the calls made that day; a stale `day` implicitly resets the
      // count. Folds the former standalone RateLimitDO into the user object.
      dailyLlmCount: <{ day: string; count: number } | null>null,

      // `passwordHash` value as passed to `login()`, but with an extra round of SHA-256 applied.
      //
      // null = password disabled (e.g. because some other auth mechanism is used)
      passwordHashHash: <Uint8Array | null>null,
    }
  });
}

type UserStorage = ReturnType<typeof makeUserStorage>;

function unavailableGatekeeperVendorInfo(id: string): GatekeeperVendorInfo {
  return {
    id,
    unavailable: true,
    description: {
      displayName: id,
      url: "",
      tagline: "Temporarily unavailable",
      description: "This connection could not be loaded.",
    },
    supportedResources: [],
  };
}

async function checkGatekeeperVendorFilter(
    vendor: Service<GatekeeperVendor> | Service<GatekeeperUser>,
    vendorId: string,
    filter: GatekeeperVendorFilter): Promise<boolean> {
  try {
    if (filter.resourceUrl) {
      let resources = await vendor.getSupportedResources();
      let matched = false;
      for (let resource of resources) {
        if (typeof resource.urlPattern !== "string") {
          // Guard against gatekeepers returning a non-string urlPattern for now.
          //
          // TODO: Consider whether this is the API we want for getSupportedResources(). Is URLPattern
          //   even the right thing?
          throw new Error("Gatekeeper returned non-string urlPattern from getSupportedResources()");
        }

        if (new URLPattern(resource.urlPattern).test(filter.resourceUrl)) {
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }

    return true;
  } catch (err) {
    // This function is called when iterating over several gatekeepers to filter them. If one of
    // them throws we don't want to block the whole list, so instead log the error and assume this
    // gatekeeper should be filtered.
    logger.warn("gatekeeper filter check failed", {
      event: "gatekeeper.filter.check.failed", vendorId, error: err,
    });
    return false;
  }
}

/** Durable Object that stores information about a user. */
export class UserDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: UserStorage;
  private vendors: Map<string, Service<GatekeeperVendor>>;
  private adminSettings: DurableObjectNamespace<AdminSettings>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);

    // Migrate data created prior to the minions -> gadgets rename.
    // TODO(cleanup): Eventually remove this, very few people ever used it as "minions".
    for (let [key, value] of Array.from(ctx.storage.kv.list({prefix: "minions:"}))) {
      let newKey = "gadgets:" + key.slice("minions:".length);
      ctx.storage.kv.put(newKey, value);
      ctx.storage.kv.delete(key);
    }

    this.storage = makeUserStorage(ctx.storage);
    this.adminSettings = this.ctx.exports.AdminSettings;

    this.vendors = buildGatekeeperVendorMap(env);
  }

  async authenticate(token: string): Promise<void> {
    let tokenBytes: Uint8Array;
    try {
      tokenBytes = Uint8Array.fromBase64(token);
    } catch {
      // A corrupt (non-Base64) token must classify as an auth failure like any other bad token,
      // not surface as the decoder's SyntaxError.
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
    let hash = await crypto.subtle.digest('SHA-256', tokenBytes);
    let tokenId = new Uint8Array(hash).toHex();
    let session = this.storage.sessions.get(tokenId);
    if (!session) {
      throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
    }
  }

  /**
   * Returns true when this login created the account on first use. When the account doesn't yet
   * exist and `allowCreate` is false (deployment signups are closed), refuses rather than creating —
   * existing users can still sign in.
   */
  async authenticateFromCfAccess(email: string, allowCreate: boolean): Promise<boolean> {
    if (!this.storage.created.get()) {
      if (!allowCreate) {
        throw new Error("New sign-ups are currently disabled on this deployment.");
      }
      // Create on first use.
      this.storage.created.put(true);
      this.storage.profile.put({
        type: "user",
        name: email.split("@")[0],
        id: email,
      });
      return true;
    }

    return false;
  }

  async #newSessionToken(): Promise<string> {
    let sessionToken = new Uint8Array(32);
    crypto.getRandomValues(sessionToken);

    let tokenId = new Uint8Array(await crypto.subtle.digest('SHA-256', sessionToken)).toHex();
    this.storage.sessions.put({ tokenId, created: new Date() });

    return sessionToken.toBase64();
  }

  async login(passwordHash: Uint8Array): Promise<string | null> {
    let passwordHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', passwordHash));

    let actualHashHash = this.storage.passwordHashHash.get();
    if (!actualHashHash) {
      return null;
    }

    if (!bytesEqual(passwordHashHash, actualHashHash)) {
      return null;
    }

    return this.#newSessionToken();
  }

  async createAccount(username: string, displayName: string, passwordHash: Uint8Array)
      : Promise<string | null> {
    if (this.storage.created.get()) {
      return null;
    }

    // Do a little migration here for old data.
    // TODO(soon): Delete this.
    for (let gadget of Array.from(this.storage.gadgets.list())) {
      if (!gadget.created || !gadget.lastActive) {
        if (!gadget.created) {
          gadget.created = new Date("2026-01-01");
        }
        if (!gadget.lastActive) {
          gadget.lastActive = new Date("2026-01-01");;
        }
        this.storage.gadgets.put(gadget);
      }
    }

    this.storage.created.put(true);
    this.storage.profile.put({
      type: "user",
      name: displayName,
      id: username,
    });

    let passwordHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', passwordHash));
    this.storage.passwordHashHash.put(passwordHashHash);

    return this.#newSessionToken();
  }

  /**
   * Log in via an authentication gatekeeper, creating the account on first use. The user DO is keyed
   * by the verified email (this DO's id derives from idFromName(email)), so `email` is also used as
   * the profile id and the initial display name is the email's local-part — consistent with the
   * Cloudflare Access flow. Password login is left disabled for these accounts. Returns the session
   * secret to store client-side.
   *
   * The profile is written only on first sign-in. We intentionally do NOT refresh the display name
   * on later logins: once set, the name is the user's to change (via setOwnDisplayName), so we don't
   * clobber a customized name with the email local-part.
   *
   * When the account doesn't yet exist and `allowCreate` is false (deployment signups are closed),
   * returns null instead of creating one — existing users can still sign in.
   */
  async loginOrCreateViaGatekeeper(email: string, allowCreate: boolean): Promise<string | null> {
    if (!this.storage.created.get()) {
      if (!allowCreate) return null;
      this.storage.created.put(true);
      this.storage.profile.put({
        type: "user",
        name: email.split("@")[0],
        id: email,
      });
    }
    return this.#newSessionToken();
  }

  /** Whether this account has a password set (false for gatekeeper sign-in accounts). */
  async hasPasswordLogin(): Promise<boolean> {
    return this.storage.passwordHashHash.get() !== null;
  }

  async changePassword(oldHash: Uint8Array, newHash: Uint8Array): Promise<void> {
    let actualHashHash = this.storage.passwordHashHash.get();
    if (!actualHashHash) {
      throw new Error("This account does not use password login.");
    }

    let oldHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', oldHash));
    if (!bytesEqual(oldHashHash, actualHashHash)) {
      throw new Error("Incorrect password.");
    }

    let newHashHash = new Uint8Array(await crypto.subtle.digest('SHA-256', newHash));
    this.storage.passwordHashHash.put(newHashHash);
  }

  async whoami(): Promise<AiChatAuthorInfo> {
    return this.storage.profile.get();
  }

  /** Like whoami(), but returns null if the account was never initialized. */
  async whoamiIfExists(): Promise<AiChatAuthorInfo | null> {
    if (!this.storage.created.get()) {
      return null;
    }
    return this.storage.profile.get();
  }

  /**
   * Called by the overseer every time a collaborator opens a shared gadget.
   * Creates the record on first open; updates lastActive on subsequent opens.
   *
   * `role` is cached so listings built from this DO can offer the actions it permits without
   * reopening the workspace to ask. Presentation only: every operation is still authorized by the
   * Overseer when attempted.
   */
  async recordSharedGadgetOpen(
      gadgetId: string, title: string, ownerProfile: AiChatAuthorInfo, role?: CollaboratorRole
  ): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (record && !record.owner) {
      throw new Error("User owns this workspace; it's not shared with them.");
    }
    let now = new Date();
    if (record) {
      // Already tracked -- update lastActive and cached fields.
      record.lastActive = now;
      record.title = title;
      record.owner = ownerProfile;
      record.role = role;
      this.storage.gadgets.put(record);
    } else {
      // First time opening this shared gadget.
      this.storage.gadgets.put({
        id: gadgetId,
        title,
        owner: ownerProfile,
        role,
        created: now,
        lastActive: now,
      });
    }
  }

  /**
   * Updates the presentation-only role cached for a shared workspace listing. Authorization still
   * comes from the Overseer's live sharing graph; this only keeps the listing's available actions
   * accurate after a collaborator is downgraded.
   */
  async updateSharedGadgetRole(gadgetId: string, role: CollaboratorRole): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record?.owner) return;
    record.role = role;
    this.storage.gadgets.put(record);
  }

  /**
   * Forgets a gadget shared with this user: drops it from their workspace listing and its outputs
   * from their Outputs index. Called both when the user dismisses it and when their access is
   * revoked (Overseer.refreshAffectedCollaboratorListings()); it grants and revokes nothing.
   */
  async forgetSharedGadget(gadgetId: string): Promise<void> {
    let record = this.storage.gadgets.get(gadgetId);
    if (record && record.owner) {
      this.storage.gadgets.delete(gadgetId);
      this.storage.outputs.byWorkspace.delete(gadgetId);
    }
  }

  async setOwnDisplayName(name: string): Promise<void> {
    let profile = this.storage.profile.get();
    profile.name = name;
    this.storage.profile.put(profile);
  }

  async listModels(): Promise<AiChatAuthorInfo[]> {
    let result: AiChatAuthorInfo[] = [];

    // When AI Gateway mode is active, include all suggested models for enabled providers.
    let gwConfig = getAiGatewayConfig(this.env);
    let gwModelIds = new Set<string>();
    if (gwConfig) {
      for (let entry of gwConfig.getModelList()) {
        result.push(entry);
        gwModelIds.add(entry.id);
      }
    }

    // Also include user-configured models, skipping any that duplicate a gateway model.
    for (let model of this.storage.aiModels.list()) {
      if (!gwModelIds.has(model.profile.id)) {
        result.push(model.profile);
      }
    }
    return result;
  }

  async addModel(profile: AiChatAuthorInfo, config: AiModelConfig): Promise<void> {
    let gwConfig = getAiGatewayConfig(this.env);
    if (config.provider === "capnweb") {
      remoteAgentUrl(config.apiUrl);
      if (!config.model.trim() || config.model.length > 200 || config.apiToken.length > 8192) {
        throw new Error("Remote-agent IDs must be 1–200 characters and tokens at most 8192 characters.");
      }
      if (gwConfig?.resolveModel(profile.id)) throw new Error("Choose a remote-agent ID distinct from built-in models.");
    } else if (gwConfig && !gwConfig.providers.has(config.provider)) {
      throw new Error(`Provider "${config.provider}" is not available in AI Gateway mode.`);
    }

    profile.type = "agent";
    this.storage.aiModels.put({profile, config});
  }

  async deleteModel(id: string): Promise<void> {
    // In AI Gateway mode, don't allow deleting built-in suggested models.
    let gwConfig = getAiGatewayConfig(this.env);
    if (gwConfig) {
      for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
        if (gwConfig.providers.has(provider) && id in models) {
          throw new Error(`Cannot delete built-in model "${models[id].name}".`);
        }
      }
    }

    this.storage.aiModels.delete(id);
  }

  async setQuickModel(id: string | null): Promise<void> {
    this.storage.quickModel.put(id);
  }

  async getQuickModel(): Promise<null | string> {
    let result = this.storage.quickModel.get();
    if (result && this.storage.aiModels.get(result)) {
      return result;
    } else {
      return null;
    }
  }

  async getPreferredModel(): Promise<string | null> {
    return this.storage.preferredModel.get();
  }

  async setPreferredModel(id: string | null): Promise<void> {
    if (id !== null) {
      // Validate that the model exists in the user's configured models or as a gateway model.
      let gwConfig = getAiGatewayConfig(this.env);
      let exists = !!this.storage.aiModels.get(id) || !!gwConfig?.resolveModel(id);
      if (!exists) {
        throw new Error(`No such model: ${id}`);
      }
    }
    this.storage.preferredModel.put(id);
  }

  async isOnboardingCompleted(): Promise<boolean> {
    return this.storage.onboardingCompleted.get();
  }

  async completeOnboarding(): Promise<void> {
    this.storage.onboardingCompleted.put(true);
  }

  // ---------------------------------------------------------------------------------------------
  // Cloudflare account connection (optional top-up flow).
  // ---------------------------------------------------------------------------------------------

  /**
   * Return the connected Cloudflare *gatekeeper* account stub, if any. The AI Gateway billing flow
   * narrows it to CloudflareGatekeeperUser to obtain a usable access token. Null if the user hasn't
   * connected (or signed in with) Cloudflare.
   */
  async getCloudflareGatekeeperAccount(): Promise<Fetcher<CloudflareGatekeeperUser> | null> {
    let nextAccountId = this.storage.nextAccountId.get();
    for (let id = 0; id < nextAccountId; id++) {
      let rec: ConnectedAccountRecord | undefined;
      try { rec = this.storage.connectedAccounts.get(id); } catch { continue; }
      if (rec && rec.vendorId === CLOUDFLARE_VENDOR_ID) {
        return rec.account as unknown as Fetcher<CloudflareGatekeeperUser>;
      }
    }
    return null;
  }

  /** The AI Gateway billing state (selected account + cached balance), or null if unset. */
  async getCloudflareBilling(): Promise<CloudflareBilling | null> {
    return this.storage.cloudflareBilling.get();
  }

  /** Update the cached credit balance for the billed account. */
  async updateCloudflareCredits(creditsRemaining: number | null): Promise<void> {
    let record = this.storage.cloudflareBilling.get() ?? {};
    record.creditsRemaining = creditsRemaining;
    record.creditsUpdatedAt = Date.now();
    this.storage.cloudflareBilling.put(record);
  }

  /**
   * Persist which Cloudflare account to bill. Clears the cached credit balance (it belonged to the
   * old account).
   */
  async setCloudflareAccountSelection(accountId: string, accountName?: string): Promise<void> {
    let record = this.storage.cloudflareBilling.get() ?? {};
    record.accountId = accountId;
    record.accountName = accountName;
    record.creditsRemaining = undefined;
    record.creditsUpdatedAt = undefined;
    this.storage.cloudflareBilling.put(record);
  }

  // ---------------------------------------------------------------------------------------------
  // Free-tier daily LLM-call counter (folded in from the former standalone RateLimitDO). Only used
  // when ENABLE_CLOUDFLARE_LIMITS is on. Single-threaded DO execution makes the read-modify-write
  // race-free; the window resets at UTC midnight when the stored day no longer matches.
  // ---------------------------------------------------------------------------------------------

  #dailyUsed(day: string): number {
    let record = this.storage.dailyLlmCount.get();
    return record && record.day === day ? record.count : 0;
  }

  /** Read the current daily quota state without counting a call. */
  async checkDailyLlmCount(limit: number): Promise<DailyQuotaResult> {
    let day = utcDayKey();
    let used = this.#dailyUsed(day);
    return { withinLimits: used < limit, remaining: Math.max(0, limit - used), limit, used,
             resetAt: nextUtcMidnightIso() };
  }

  /**
   * Atomically check the daily limit and, if within it, count one call. `withinLimits` is the
   * pre-count decision; `used`/`remaining` reflect the state AFTER counting. No-ops once exhausted,
   * so a blocked request never counts.
   */
  async consumeDailyLlmCall(limit: number): Promise<DailyQuotaResult> {
    let day = utcDayKey();
    let used = this.#dailyUsed(day);
    if (used >= limit) {
      return { withinLimits: false, remaining: 0, limit, used, resetAt: nextUtcMidnightIso() };
    }
    let newUsed = used + 1;
    this.storage.dailyLlmCount.put({ day, count: newUsed });
    return { withinLimits: true, remaining: Math.max(0, limit - newUsed), limit, used: newUsed,
             resetAt: nextUtcMidnightIso() };
  }

  /** DO NOT MAKE PUBLIC -- returns API keys. Pure read: call sites replay it across DO resets
   * via retryOnDoReset, so it must stay free of writes and side effects. */
  async getChatContext(modelId: string | null, workspaceId?: string, agentId?: string): Promise<UserChatContext> {
    let gwConfig = getAiGatewayConfig(this.env);

    let result: UserChatContext = {
      profile: this.storage.profile.get()
    };

    if (agentId) {
      let agentProfile = await this.getAgent(agentId);
      if (agentProfile) {
        result.agentProfile = agentProfile;
      }
    } else if (workspaceId) {
      let agentProfile = await this.getAgentByWorkspaceId(workspaceId);
      if (agentProfile) {
        result.agentProfile = agentProfile;
      }
    }

    if (workspaceId) {
      let group = await this.getGroupByWorkspaceId(workspaceId);
      if (group) {
        result.group = group;
        if (group.multiAuthor) delete result.agentProfile;
      }
    }

    if (modelId) {
      // In AI Gateway mode, resolve gateway models first.
      if (gwConfig) {
        result.aiModel = gwConfig.resolveModel(modelId);
      }
      if (!result.aiModel) {
        result.aiModel = this.storage.aiModels.get(modelId);
      }
      if (!result.aiModel) throw new Error(`No such model: ${modelId}`);
    }

    // Resolve the quick model (used for lightweight tasks like title generation).
    if (gwConfig) {
      // In AI Gateway mode, always use the hardcoded quick model.
      result.quickModel = gwConfig.getQuickModelConfig();
    } else {
      let quickModelId = this.storage.quickModel.get();
      if (quickModelId) {
        let quickModel = this.storage.aiModels.get(quickModelId);
        if (quickModel) {
          result.quickModel = quickModel.config;
        }
      }
    }

    return result;
  }

  async getExternalMessageChatContext(existingChatModelId: string | null): Promise<UserChatContext> {
    let models = await this.listModels();
    // Prefer the existing chat's model, then the user's preferred model, then the first available model.
    let selectedModel = models.find(model => model.id === existingChatModelId)
      ?? models.find(model => model.id === this.storage.preferredModel.get())
      ?? models[0];

    return this.getChatContext(selectedModel?.id ?? null);
  }

  async listGadgets(): Promise<GadgetMetadataWithTimestamps[]> {
    let threadWorkspaces = new Set<string>();
    for (let agent of this.storage.agents.list()) threadWorkspaces.add(agent.workspaceId);
    for (let group of this.storage.groups.list()) threadWorkspaces.add(group.workspaceId);

    let result: GadgetMetadataWithTimestamps[] = [];
    for (let gadget of this.storage.gadgets.list()) {
      if (isFullyCreated(gadget)) {
        result.push(gadget);
      } else if (gadget.created && threadWorkspaces.has(gadget.id)) {
        result.push({ ...gadget, lastActive: gadget.created });
      }
    }
    return result;
  }

  // --- Agent Shell methods ---

  /** List all agent profiles, sorted by creation time (newest first). */
  async listAgents(): Promise<AgentProfile[]> {
    let agents = Array.from(this.storage.agents.list());
    // Sort by created date, newest first
    agents.sort((a, b) => b.created.getTime() - a.created.getTime());
    return agents.map(({lastReadReplyAt, ...agent}) => {
      const receipt = this.storage.attentionReceipts.get(agent.workspaceId);
      const entries = [...this.storage.attention.byWorkspace.get(agent.workspaceId)];
      const latest = entries.toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
      const lastReply = receipt?.roster?.lastReply;
      const presence: AgentRosterState["presence"] = entries.some(e => e.state === "pending" || e.state === "accepting")
        ? "waiting" : receipt?.roster?.working ? "working"
        : latest?.state === "failed" || latest?.state === "incomplete" ? "blocked"
        : latest?.state === "finished" || lastReply ? "done" : "idle";
      return {...agent, roster: {presence, lastReply,
        unreadCount: entries.filter(e => e.seenVersion !== e.version).length +
          (lastReply && lastReply.timestamp > (lastReadReplyAt ?? 0) ? 1 : 0)}};
    });
  }

  /** Acknowledge only a displayed reply; attention cards have their own versioned acknowledgment. */
  async markAgentRead(id: string, replyTimestamp: number): Promise<void> {
    const agent = this.storage.agents.get(id);
    if (!agent) throw new Error("Agent not found");
    const latest = this.storage.attentionReceipts.get(agent.workspaceId)?.roster?.lastReply?.timestamp ?? 0;
    const lastReadReplyAt = Math.max(agent.lastReadReplyAt ?? 0, Math.min(replyTimestamp, latest));
    if (lastReadReplyAt === agent.lastReadReplyAt) return;
    this.storage.agents.put({...agent, lastReadReplyAt});
    this.#attentionChanged();
  }

  /** Explicit portable allowlist: no history, memory, credentials, hooks or resource grants. */
  async getBotBlueprint(id: string): Promise<BotBlueprintProfile> {
    const agent = this.storage.agents.get(id);
    if (!agent) throw new Error("Agent not found");
    const pluginIds = new Set(agent.pluginIds ?? []);
    for (const accountId of agent.defaultBindings ?? []) {
      const account = this.storage.connectedAccounts.get(accountId);
      if (account) pluginIds.add(account.vendorId);
    }
    return {name: agent.name, title: agent.title, description: agent.description, avatar: agent.avatar,
      pluginIds: [...pluginIds],
      skills: [...this.storage.skills.list()].filter(s => s.agentId === id)
        .map(({name, description, body}) => ({name, description, body})),
      routines: [...this.storage.routines.list()].filter(r => r.agentId === id)
        .map(({name, prompt, schedule}) => ({name, prompt, schedule}))};
  }

  /** Install the whole definition atomically in the owner registry, with no authority inherited. */
  async installBotBlueprint(workspaceId: string, bot: BotBlueprintProfile,
      defaultModelId: string | null, notifyOnUpdates = true): Promise<AgentProfile> {
    return this.storage.transaction(() => this.#installBotBlueprint(workspaceId, bot, defaultModelId, notifyOnUpdates));
  }

  /** Create each stable seed key once; receipts survive edits and deletion. All seeds commit together. */
  async seedAgents(yaml: string): Promise<{created: AgentProfile[]; skipped: string[]}> {
    const seeds = parseAgentSeeds(yaml);
    const gateway = getAiGatewayConfig(this.env);
    return this.storage.transaction(() => {
      const created: AgentProfile[] = [];
      const skipped: string[] = [];
      for (const {key, modelId, bot} of seeds) {
        if (this.storage.agentSeedReceipts.get(key)) { skipped.push(key); continue; }
        if (modelId && !this.storage.aiModels.get(modelId) && !gateway?.resolveModel(modelId)) {
          throw new Error("A seed references an unavailable model. Add it in Providers first.");
        }
        const agent = this.#installBotBlueprint(this.ctx.exports.OverseerDurableObject.newUniqueId().toString(), bot, modelId);
        this.storage.agentSeedReceipts.put({key, agentId: agent.id});
        created.push(agent);
      }
      return {created, skipped};
    });
  }

  #installBotBlueprint(workspaceId: string, bot: BotBlueprintProfile,
      defaultModelId: string | null, notifyOnUpdates = true): AgentProfile {
    const now = new Date();
    const agent: AgentRecord = {id: crypto.randomUUID(), workspaceId, name: bot.name,
      title: bot.title, description: bot.description, avatar: bot.avatar, pluginIds: bot.pluginIds,
      defaultModelId, defaultBindings: [], notifyOnUpdates, created: now, updated: now};
    this.storage.gadgets.put({id: workspaceId, title: bot.name, created: now, lastActive: now});
    this.storage.agents.put(agent);
    for (const skill of bot.skills) this.#createSkillWithId(crypto.randomUUID(), agent.id,
      skill.name, skill.description, skill.body);
    for (const routine of bot.routines) this.#createRoutineWithId(crypto.randomUUID(), agent.id,
      routine.name, routine.prompt, routine.schedule, true);
    this.#attentionChanged();
    return agent;
  }

  /** Create a new agent profile and register its workspace. Called from server.ts after creating the workspace. */
  async createAgentRecord(
    agentId: string,
    workspaceId: string,
    name: string,
    title: string,
    description: string,
    defaultModelId: string | null,
    avatar?: AvatarImage,
    defaultBindings?: number[],
    notifyOnUpdates?: boolean
  ): Promise<AgentProfile> {
    let now = new Date();
    let agent: AgentRecord = {
      id: agentId,
      name,
      title,
      description,
      avatar,
      defaultModelId,
      workspaceId,
      defaultBindings,
      notifyOnUpdates,
      created: now,
      updated: now,
    };
    
    this.storage.agents.put(agent);
    this.#attentionChanged();
    return agent;
  }

  /** Update an existing agent profile. */
  async updateAgentRecord(
    id: string,
    updates: {
      name?: string;
      title?: string;
      description?: string;
      defaultModelId?: string | null;
      avatar?: AvatarImage | null;
      defaultBindings?: number[];
      notifyOnUpdates?: boolean;
      hidden?: boolean;
    }
  ): Promise<AgentProfile> {
    let agent = this.storage.agents.get(id);
    if (!agent) {
      throw new Error(`Agent not found: ${id}`);
    }

    let updatedAgent: AgentRecord = {
      ...agent,
      id: agent.id,
      hidden: updates.hidden ?? agent.hidden,
      name: updates.name !== undefined ? updates.name : agent.name,
      title: updates.title !== undefined ? updates.title : agent.title,
      description: updates.description !== undefined ? updates.description : agent.description,
      defaultModelId: updates.defaultModelId !== undefined ? updates.defaultModelId : agent.defaultModelId,
      workspaceId: agent.workspaceId,
      defaultBindings: updates.defaultBindings !== undefined ? updates.defaultBindings : agent.defaultBindings,
      notifyOnUpdates: updates.notifyOnUpdates !== undefined ? updates.notifyOnUpdates : agent.notifyOnUpdates,
      created: agent.created,
      updated: new Date(),
    };

    if (updates.avatar !== undefined) {
      if (updates.avatar !== null) {
        updatedAgent.avatar = updates.avatar;
      } else {
        delete updatedAgent.avatar;
      }
    } else if (agent.avatar !== undefined) {
      updatedAgent.avatar = agent.avatar;
    }

    this.storage.agents.put(updatedAgent);
    if (agent.notifyOnUpdates === false && updatedAgent.notifyOnUpdates !== false) {
      this.storage.pushBotConsent.put({agentId: id, enableSince: Date.now()});
    }
    // Muting drops queued work; unmuting never replays historical versions.
    this.#prunePushCandidates();
    this.#attentionChanged();
    await this.#scheduleAttentionAlarm();

    return updatedAgent;
  }

  /** Get an agent by ID. */
  async getAgent(id: string): Promise<AgentRecord | null> {
    return this.storage.agents.get(id) || null;
  }

  /** Get an agent by workspace ID. Returns null if the workspace is not bound to an agent. */
  async getAgentByWorkspaceId(workspaceId: string): Promise<AgentProfile | null> {
    for (let agent of this.storage.agents.list()) {
      if (agent.workspaceId === workspaceId) {
        return agent;
      }
    }
    return null;
  }

  /** Delete an agent profile record. The workspace deletion is handled by the caller. */
  async deleteAgentRecord(id: string): Promise<string | null> {
    let agent = this.storage.agents.get(id);
    if (!agent) {
      throw new Error(`Agent not found: ${id}`);
    }

    let workspaceId = agent.workspaceId;
    const attentionRevision = this.storage.attentionReceipts.get(workspaceId)?.revision ?? 0;
    
    this.storage.agents.delete(id);
    this.storage.pushBotConsent.delete(id);
    this.#purgeWorkspaceAttention(workspaceId);
    if (this.storage.gadgets.get(workspaceId)) {
      this.storage.attentionReceipts.put({workspaceId, revision: attentionRevision, complete: true,
        prohibitPush: true, deletedAgent: true});
    }
    await this.#scheduleAttentionAlarm();
    
    return workspaceId;
  }

  async listRoutines(agentId: string): Promise<AgentRoutine[]> {
    let agent = this.storage.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    let routines = Array.from(this.storage.routines.list()).filter(r => r.agentId === agentId);
    routines.sort((a, b) => b.created.getTime() - a.created.getTime());
    return routines.map(routineForClient);
  }

  async createRoutine(agentId: string, name: string, prompt: string, schedule: AgentRoutineSchedule, paused: boolean = true): Promise<AgentRoutine> {
    return this.#createRoutineWithId(crypto.randomUUID(), agentId, name, prompt, schedule, paused);
  }

  #createRoutineWithId(id: string, agentId: string, name: string, prompt: string,
      schedule: AgentRoutineSchedule, paused: boolean): AgentRoutine {
    let agent = this.storage.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    if (schedule.kind === "interval" && schedule.everyMs < 60000) {
      throw new Error("Interval must be at least 60 seconds");
    }
    let now = new Date();
    let routine: RoutineRecord = {
      id,
      agentId,
      name,
      prompt,
      schedule,
      paused,
      revision: 0,
      created: now,
      updated: now,
    };
    this.storage.routines.put(routine);
    return routineForClient(routine);
  }

  /** Apply a desired-state update only to the revision the server inspected; invalidate older registrations. */
  async updateRoutine(agentId: string, routineId: string,
      updates: { name?: string; prompt?: string; schedule?: AgentRoutineSchedule; paused?: boolean },
      expectedRevision: number): Promise<{routine: AgentRoutine, revision: number}> {
    let routine = this.storage.routines.get(routineId);
    if (!routine || routine.agentId !== agentId) {
      throw new Error(`Routine not found: ${routineId}`);
    }
    if ((routine.revision ?? 0) !== expectedRevision) {
      throw new Error("Routine changed during update. Reload and retry.");
    }
    let revision = expectedRevision + 1;
    let updated: RoutineRecord = {
      ...routine,
      name: updates.name ?? routine.name,
      prompt: updates.prompt ?? routine.prompt,
      schedule: updates.schedule ?? routine.schedule,
      paused: updates.paused ?? routine.paused,
      revision,
      updated: new Date(),
    };
    this.storage.routines.put(updated);
    return {routine: routineForClient(updated), revision};
  }

  /** Delete desired state before hook teardown; optional CAS is used only to clean up a failed create. */
  async deleteRoutine(agentId: string, routineId: string, expectedRevision?: number): Promise<RoutineRecord | undefined> {
    let routine = this.storage.routines.get(routineId);
    if (!routine) return;
    if (routine.agentId !== agentId) {
      throw new Error(`Routine not found: ${routineId}`);
    }
    if (expectedRevision !== undefined && (routine.revision ?? 0) !== expectedRevision) return;
    this.storage.routines.delete(routineId);
    return routine;
  }

  /** Publish or roll back a registration only if no newer desired-state update has superseded it. */
  async finishRoutineRegistration(routineId: string, revision: number,
      hookId: number | undefined): Promise<AgentRoutine | undefined> {
    let routine = this.storage.routines.get(routineId);
    if (!routine || (routine.revision ?? 0) !== revision) return;
    let updated: RoutineRecord = {
      ...routine,
      hookId,
      paused: hookId === undefined,
      updated: new Date(),
    };
    this.storage.routines.put(updated);
    return routineForClient(updated);
  }

  /** Read the private routine record, including its desired-state revision for registration/admission checks. */
  async getRoutineById(routineId: string): Promise<RoutineRecord | undefined> {
    return this.storage.routines.get(routineId);
  }

  #generateSkillSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
  }

  async listSkills(agentId: string): Promise<AgentSkill[]> {
    let agent = this.storage.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    let skills = Array.from(this.storage.skills.list()).filter(s => s.agentId === agentId);
    skills.sort((a, b) => b.created.getTime() - a.created.getTime());
    return skills;
  }

  async createSkill(agentId: string, name: string, description: string, body: string): Promise<AgentSkill> {
    return this.#createSkillWithId(crypto.randomUUID(), agentId, name, description, body);
  }

  #createSkillWithId(id: string, agentId: string, name: string, description: string,
      body: string): AgentSkill {
    let agent = this.storage.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    let now = new Date();
    let skill: SkillRecord = {
      id,
      agentId,
      name,
      slug: this.#generateSkillSlug(name),
      description,
      body,
      created: now,
      updated: now,
    };
    this.storage.skills.put(skill);
    return skill;
  }

  /**
   * Backend-only creation after a durable owner acceptance. Insert the ordinary record and its
   * tombstone atomically; retries verify the original request, not the possibly edited artifact.
   */
  async ensureProposalArtifact(source: { workspaceId: string; proposalId: AgentProposal["proposalId"] },
      agentId: AgentProposal["agentId"], artifactId: AgentProposal["artifactId"],
      draft: AgentProposal["draft"]): Promise<AgentProposalReceipt> {
    // Canonical key order makes equivalent RPC objects hash identically without retaining prose
    // in the tombstone. Arrays retain their order, and omitted optional fields stay omitted.
    const draftHash = createHash("sha256").update(JSON.stringify(draft, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
        : value)).digest("hex");
    return this.storage.transaction(() => {
      const receipt = this.storage.proposalReceipts.get(`${source.workspaceId}:${source.proposalId}`);
      if (receipt) {
        if (receipt.source.workspaceId !== source.workspaceId || receipt.source.proposalId !== source.proposalId ||
            receipt.agentId !== agentId || receipt.artifactId !== artifactId || receipt.draftHash !== draftHash) {
          throw new Error("Proposal creation request does not match its receipt.");
        }
        const artifact = draft.kind === "routine"
          ? this.storage.routines.get(artifactId) : this.storage.skills.get(artifactId);
        return {createdAt: receipt.createdAt, missing: artifact === undefined};
      }
      const agent = this.storage.agents.get(agentId);
      const workspace = this.storage.gadgets.get(source.workspaceId);
      if (!agent || agent.workspaceId !== source.workspaceId || !workspace || workspace.owner ||
          [...this.storage.groups.list()].some(group => group.workspaceId === source.workspaceId)) {
        throw new Error("Proposal requires the bot's owned dedicated workspace.");
      }
      if (this.storage.routines.get(artifactId) || this.storage.skills.get(artifactId)) {
        throw new Error("Proposal artifact ID is already in use.");
      }
      const artifact = draft.kind === "routine"
        ? this.#createRoutineWithId(artifactId, agentId, draft.value.name,
            draft.value.prompt, draft.value.schedule, true)
        : this.#createSkillWithId(artifactId, agentId, draft.value.name,
            draft.value.description, draft.value.body);
      this.storage.proposalReceipts.put({source, agentId, artifactId, draftHash, createdAt: artifact.created});
      return {createdAt: artifact.created, missing: false};
    });
  }

  async updateSkill(agentId: string, skillId: string, updates: { name?: string; description?: string; body?: string }): Promise<AgentSkill> {
    let skill = this.storage.skills.get(skillId);
    if (!skill || skill.agentId !== agentId) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    let updated: SkillRecord = {
      ...skill,
      ...updates,
      ...(updates.name ? { slug: this.#generateSkillSlug(updates.name) } : {}),
      updated: new Date(),
    };
    this.storage.skills.put(updated);
    return updated;
  }

  async deleteSkill(agentId: string, skillId: string): Promise<void> {
    let skill = this.storage.skills.get(skillId);
    if (!skill || skill.agentId !== agentId) {
      throw new Error(`Skill not found: ${skillId}`);
    }
    this.storage.skills.delete(skillId);
  }

  async listMemory(agentId: string): Promise<MemoryNoteRecord[]> {
    let agent = this.storage.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    let notes = Array.from(this.storage.memory.list()).filter(n => n.agentId === agentId);
    notes.sort((a, b) => b.created.getTime() - a.created.getTime());
    return notes;
  }

  async addMemory(agentId: string, fact: string): Promise<MemoryNoteRecord> {
    let agent = this.storage.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    let note: MemoryNoteRecord = {
      id: crypto.randomUUID(),
      agentId,
      fact: fact.trim(),
      created: new Date(),
    };
    this.storage.memory.put(note);
    return note;
  }

  async updateMemory(agentId: string, noteId: string, fact: string): Promise<MemoryNoteRecord> {
    let note = this.storage.memory.get(noteId);
    if (!note || note.agentId !== agentId) {
      throw new Error(`Memory note not found: ${noteId}`);
    }
    let updated: MemoryNoteRecord = {
      ...note,
      fact: fact.trim(),
    };
    this.storage.memory.put(updated);
    return updated;
  }

  async deleteMemory(agentId: string, noteId: string): Promise<void> {
    let note = this.storage.memory.get(noteId);
    if (!note || note.agentId !== agentId) {
      throw new Error(`Memory note not found: ${noteId}`);
    }
    this.storage.memory.delete(noteId);
  }

  async listGroups(): Promise<Group[]> {
    let groups = Array.from(this.storage.groups.list());
    groups.sort((a, b) => b.created.getTime() - a.created.getTime());
    return groups;
  }

  async createGroupRecord(
    groupId: string,
    workspaceId: string,
    name: string,
    memberAgentIds: string[]
  ): Promise<Group> {
    this.validateGroupMembers(memberAgentIds);
    let now = new Date();
    let group: GroupRecord = {
      id: groupId,
      name,
      memberAgentIds,
      multiAuthor: true,
      workspaceId,
      created: now,
      updated: now,
    };
    
    this.storage.groups.put(group);
    return group;
  }

  async updateGroupRecord(
    id: string,
    updates: {
      name?: string;
      memberAgentIds?: string[];
      multiAuthor?: boolean;
    }
  ): Promise<Group> {
    let group = this.storage.groups.get(id);
    if (!group) {
      throw new Error(`Group not found: ${id}`);
    }

    let updated: GroupRecord = {
      ...group,
      ...updates,
      updated: new Date(),
    };

    this.validateGroupMembers(updated.memberAgentIds);
    this.storage.groups.put(updated);
    return updated;
  }

  async getGroupByWorkspaceId(workspaceId: string): Promise<Group | null> {
    for (let group of this.storage.groups.list()) {
      if (group.workspaceId === workspaceId) {
        return group;
      }
    }
    return null;
  }

  /** A group contains one through six distinct bots owned by this account. */
  validateGroupMembers(ids: string[]): void {
    if (ids.length < 1 || ids.length > 6 || new Set(ids).size !== ids.length || ids.some(id => !this.storage.agents.get(id))) {
      throw new Error('Choose one through six distinct bots that you own.');
    }
  }

  async deleteGroupRecord(id: string): Promise<string | null> {
    let group = this.storage.groups.get(id);
    if (!group) {
      throw new Error(`Group not found: ${id}`);
    }

    let workspaceId = group.workspaceId;
    
    this.storage.groups.delete(id);
    
    return workspaceId;
  }

  async updateTitle(gadgetId: string, title: string) {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record) {
      throw new Error("No such workspace belonging to user.");
    }
    record.title = title;
    this.storage.gadgets.put(record);
    this.#attentionChanged();
  }

  async updatePinned(gadgetId: string, pinned: boolean) {
    let record = this.storage.gadgets.get(gadgetId);
    if (!record) {
      throw new Error("No such workspace belonging to user.");
    }
    record.pinned = pinned;
    this.storage.gadgets.put(record);
  }

  async getGadget(id: string): Promise<GadgetMetadata | null> {
    return this.storage.gadgets.get(id) || null;
  }

  async newGadget(id: string, title: string): Promise<void> {
    let created = new Date();
    this.storage.gadgets.put({id, title, created});
    if (this.storage.attentionActivated.get()) {
      this.#queueAttentionBootstrap(id);
      this.#attentionChanged();
      await this.#scheduleAttentionAlarm();
    }
  }

  async ensureGadgetRegistered(id: string, title: string): Promise<void> {
    if (this.storage.gadgets.get(id)) return;
    await this.newGadget(id, title);
  }

  async setGadgetLastActive(id: string, time: Date, totalCost: number | undefined): Promise<void> {
    let gadget = this.storage.gadgets.get(id);
    if (gadget) {
      gadget.lastActive = time;
      if (totalCost) {
        gadget.totalCost = totalCost;
      }
      this.storage.gadgets.put(gadget);
    }
  }

  async deleteGadget(id: string): Promise<void> {
    this.storage.gadgets.delete(id);
    this.storage.outputs.byWorkspace.delete(id);
    this.#purgeWorkspaceAttention(id);
    await this.#scheduleAttentionAlarm();
  }

  #attentionChanged(): void {
    this.storage.attentionRevision.put(this.storage.attentionRevision.get() + 1);
  }

  #attentionAgent(workspaceId: string): AgentRecord | undefined {
    for (const agent of this.storage.agents.list()) {
      if (agent.workspaceId === workspaceId) return agent;
    }
  }

  #purgeWorkspaceAttention(workspaceId: string): void {
    this.storage.attention.byWorkspace.delete(workspaceId);
    this.storage.attentionReceipts.delete(workspaceId);
    this.storage.attentionBootstrapJobs.delete(workspaceId);
    this.#prunePushCandidates();
    this.#attentionChanged();
  }

  /** Backend-only full replacement from an owned workspace, never from browser-supplied ownership. */
  async syncWorkspaceAttention(workspaceId: string, snapshot: WorkspaceAttentionSnapshot): Promise<void> {
    const workspace = this.storage.gadgets.get(workspaceId);
    const previous = this.storage.attentionReceipts.get(workspaceId);
    if (!workspace || workspace.owner || previous?.deletedAgent ||
        snapshot.revision <= (previous?.revision ?? -1)) return;
    if (snapshot.entries.length > WORKSPACE_ATTENTION_LIMIT) {
      throw new Error("Attention snapshot exceeds the workspace limit.");
    }
    this.storage.transaction(() => {
      const agentId = this.#attentionAgent(workspaceId)?.id;
      const present = new Set(snapshot.entries.map(entry => JSON.stringify([workspaceId, entry.sourceId])));
      // Materialize before mutating indexes; deletes invalidate typed-storage's KV cursors.
      for (const record of Array.from(this.storage.attention.byWorkspace.get(workspaceId))) {
        if (!present.has(record.id)) this.storage.attention.delete(record.id);
      }
      this.storage.attentionReceipts.put({workspaceId, revision: snapshot.revision,
        complete: snapshot.complete, prohibitPush: snapshot.prohibitPush, roster: snapshot.roster});
      if (snapshot.complete) this.storage.attentionBootstrapJobs.delete(workspaceId);
      else if (this.storage.attentionActivated.get()) this.#queueAttentionBootstrap(workspaceId);
      if (snapshot.truncated) this.storage.attentionTruncated.put(true);
      const fresh: PushCandidate[] = [];
      for (const entry of snapshot.entries.toSorted((a, b) => a.version - b.version)) {
        const id = JSON.stringify([workspaceId, entry.sourceId]);
        const old = this.storage.attention.get(id);
        // The workspace watermark also fences globally pruned records, without unbounded tombstones.
        if (entry.version <= (old?.version ?? previous?.revision ?? -1)) continue;
        const order = this.storage.attentionOrder.get() + 1;
        this.storage.attentionOrder.put(order);
        // Explicit projection: never persist source prose or source-asserted owner/bot identities.
        const {sourceId, kind, state, version, updatedAt, chatId, sequence, runId, actionId, reason, notify} = entry;
        this.storage.attention.put({id, workspaceId, agentId, order, seenVersion: old?.seenVersion,
          sourceId, kind, state, version, updatedAt, chatId, sequence, runId, actionId, reason, notify});
        if (notify) fresh.push({itemId: id, version});
      }
      let retained = 0;
      for (const record of Array.from(this.storage.attention.byOrder.list({reverse: true}))) {
        if (++retained > OWNER_ATTENTION_LIMIT) {
          this.storage.attention.delete(record.id);
          this.storage.attentionTruncated.put(true);
        }
      }
      if (fresh.length) {
        for (const device of Array.from(this.storage.pushDevices.list())) {
          const candidates = fresh.filter(candidate => this.#eligibleAttention(candidate, device));
          if (!candidates.length) continue;
          const old = this.storage.pushJobs.get(device.id);
          const merged = new Map(old?.candidates.filter(candidate => this.#eligibleAttention(candidate, device))
            .map(candidate => [candidate.itemId, candidate]));
          for (const candidate of candidates) {
            merged.delete(candidate.itemId);
            merged.set(candidate.itemId, candidate);
          }
          this.storage.pushJobs.put({id: device.id, generation: device.generation,
            revision: this.#nextPushRevision(), candidates: [...merged.values()].slice(-20),
            attempt: old?.attempt ?? 0, due: old?.due ?? Date.now() + 1_000});
          this.storage.pushDevices.put({...device, delivery: "pending"});
        }
      }
      // Merge before pruning: replacing the last old version must not reset its retry budget.
      this.#prunePushCandidates();
      this.#attentionChanged();
    });
    await this.#scheduleAttentionAlarm();
  }

  /** Return at most thirty retained versions; reading and delivery never acknowledge them. */
  async listAttention(beforeOrder?: number): Promise<AttentionPage> {
    if (!this.storage.attentionActivated.get()) {
      this.storage.attentionActivated.put(true);
      this.#attentionChanged();
      await this.#scheduleAttentionAlarm();
    }
    const agents = new Map([...this.storage.agents.list()].map(agent => [agent.workspaceId, agent.id]));
    const entries: AttentionItem[] = [];
    for (const record of this.storage.attention.byOrder.list({end: beforeOrder, reverse: true, limit: 31})) {
      const workspace = this.storage.gadgets.get(record.workspaceId);
      if (!workspace || workspace.owner) continue;
      const {notify: _notify, seenVersion, agentId: _agentId, ...item} = record;
      entries.push({...item, agentId: agents.get(record.workspaceId), workspaceTitle: workspace.title,
        seen: seenVersion === record.version});
    }
    const hasMore = entries.length > 30;
    if (hasMore) entries.pop();
    let unseen = 0;
    for (const record of this.storage.attention.list()) {
      if (record.seenVersion !== record.version) ++unseen;
    }
    return {entries, nextBeforeOrder: hasMore ? entries.at(-1)!.order : undefined, unseen,
      catchingUp: !this.storage.attentionScanComplete.get() ||
        [...this.storage.attentionBootstrapJobs.list({limit: 1})].length > 0,
      truncated: this.storage.attentionTruncated.get()};
  }

  /** Acknowledge only the version actually displayed, not a newer concurrent transition. */
  async markAttentionSeen(id: string, version: number): Promise<void> {
    const record = this.storage.attention.get(id);
    if (!record || record.version !== version || record.seenVersion === version) return;
    this.storage.attention.put({...record, seenVersion: version});
    this.#prunePushCandidates();
    this.#attentionChanged();
    await this.#scheduleAttentionAlarm();
  }

  /** Disposable invalidation subscription, including an initial revision on every connection. */
  async subscribeAttention(subscriber: RpcStub<AttentionSubscriber>): Promise<RpcStub<{}>> {
    await this.listAttention();
    subscriber = subscriber.dup();
    const revision = this.storage.attentionRevision;
    let disposed = false;
    let pending = false;
    const unsubscribe = () => {
      if (disposed) return;
      disposed = true;
      revision.unsubscribe(listener);
      subscriber[Symbol.dispose]();
    };
    const listener = {update: () => {
      if (disposed || pending) return;
      pending = true;
      // Storage notifies before writing, including in transactions that may roll back.
      // Coalesce the synchronous stack and read only its committed revision afterward.
      Promise.resolve().then(() => {
        pending = false;
        if (!disposed) return subscriber.changed(revision.get());
      }).catch(unsubscribe);
    }};
    revision.subscribe(listener);
    listener.update();
    return new RpcStub<{}>(new class extends RpcTarget {
      [Symbol.dispose]() { unsubscribe(); }
    }());
  }

  /** Public VAPID configuration and transport receipts, never subscription endpoints or secrets. */
  async getPushSettings(): Promise<PushSettings> {
    const config = readPushConfig(this.env);
    return {available: !!config, applicationServerKey: config?.publicKey,
      devices: [...this.storage.pushDevices.list()].map(({id, createdAt, delivery}) => ({id, createdAt, delivery}))};
  }

  /** Enroll or rotate one browser device without scheduling historical notifications. */
  async registerPushSubscription(subscription: PushSubscriptionData): Promise<{id: string}> {
    validatePushSubscription(subscription);
    if (!readPushConfig(this.env)) throw new Error("Push notifications are unavailable.");
    const devices = [...this.storage.pushDevices.list()];
    const old = devices.find(device => device.subscription.endpoint === subscription.endpoint);
    if (old && old.subscription.keys.auth === subscription.keys.auth &&
        old.subscription.keys.p256dh === subscription.keys.p256dh) return {id: old.id};
    if (!old && devices.length >= 5) throw new Error("At most five push devices may be registered.");
    const id = old?.id ?? crypto.randomUUID();
    const {endpoint, keys: {p256dh, auth}} = subscription;
    this.storage.pushDevices.put({id, generation: (old?.generation ?? 0) + 1,
      subscription: {endpoint, keys: {p256dh, auth}}, createdAt: new Date(Date.now()), delivery: "idle"});
    this.storage.pushJobs.delete(id);
    this.storage.attentionActivated.put(true);
    this.#attentionChanged();
    await this.#scheduleAttentionAlarm();
    return {id};
  }

  /** Revoke this owner's opaque device ID, fencing both pending encryption and late responses. */
  async removePushSubscription(id: string): Promise<void> {
    if (!this.storage.pushDevices.delete(id)) return;
    this.storage.pushJobs.delete(id);
    this.#attentionChanged();
    await this.#scheduleAttentionAlarm();
  }

  #nextPushRevision(): number {
    const revision = this.storage.pushRevision.get() + 1;
    this.storage.pushRevision.put(revision);
    return revision;
  }

  #eligibleAttention(candidate: PushCandidate, device: PushDevice): AttentionRecord | undefined {
    const item = this.storage.attention.get(candidate.itemId);
    if (!item || item.version !== candidate.version || item.seenVersion === item.version ||
        !item.notify || item.state === "resolved" || item.state === "accepting") return;
    const workspace = this.storage.gadgets.get(item.workspaceId);
    const receipt = this.storage.attentionReceipts.get(item.workspaceId);
    if (!workspace || workspace.owner || !receipt || receipt.prohibitPush || receipt.deletedAgent) return;
    const agent = this.#attentionAgent(item.workspaceId);
    if ((item.agentId && agent?.id !== item.agentId) || agent?.notifyOnUpdates === false) return;
    const enableSince = agent ? this.storage.pushBotConsent.get(agent.id)?.enableSince ?? 0 : 0;
    // Compare canonical event time, not snapshot arrival: retries can cross consent boundaries.
    if (!(item.updatedAt.getTime() >= Math.max(device.createdAt.getTime(), enableSince))) return;
    return item;
  }

  #prunePushCandidates(): void {
    for (const job of Array.from(this.storage.pushJobs.list())) {
      const device = this.storage.pushDevices.get(job.id);
      const candidates = device ? job.candidates.filter(candidate => this.#eligibleAttention(candidate, device)) : [];
      if (candidates.length === job.candidates.length) continue;
      if (candidates.length) {
        this.storage.pushJobs.put({...job, candidates, revision: this.#nextPushRevision()});
      } else {
        this.storage.pushJobs.delete(job.id);
        if (device) this.storage.pushDevices.put({...device, delivery: "idle"});
      }
    }
  }

  #queueAttentionBootstrap(workspaceId: string): void {
    const receipt = this.storage.attentionReceipts.get(workspaceId);
    if (receipt?.complete || receipt?.deletedAgent || this.storage.attentionBootstrapJobs.get(workspaceId)) return;
    this.storage.attentionBootstrapJobs.put({workspaceId, attempt: 0, due: Date.now() + 1_000});
  }

  // One alarm owns both queues. Compute synchronously, so another RPC cannot insert an earlier job
  // between reading the queues and writing the alarm.
  #scheduleAttentionAlarm(): Promise<void> {
    let due = this.storage.attentionActivated.get() && !this.storage.attentionScanComplete.get()
      ? Date.now() + 1_000 : Infinity;
    for (const job of this.storage.attentionBootstrapJobs.byDue.list({limit: 1})) {
      due = Math.min(due, job.due);
      break;
    }
    for (const job of this.storage.pushJobs.list()) due = Math.min(due, job.due);
    return Number.isFinite(due)
      ? this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, due))
      : this.ctx.storage.deleteAlarm();
  }

  /** Drain bounded owner bootstrap work and at most one generic push job per enrolled device. */
  async alarm(): Promise<void> {
    if (this.storage.attentionActivated.get() && !this.storage.attentionScanComplete.get()) {
      const page = [...this.storage.gadgets.list({startAfter: this.storage.attentionScanCursor.get() || undefined, limit: 16})];
      for (const workspace of page) {
        if (!workspace.owner) this.#queueAttentionBootstrap(workspace.id);
      }
      if (page.length) this.storage.attentionScanCursor.put(page.at(-1)!.id);
      this.storage.attentionScanComplete.put(page.length < 16);
      this.#attentionChanged();
    }
    // Persist a future wake-up before external I/O; retries do not depend on an open browser.
    await this.#scheduleAttentionAlarm();
    try {
      const now = Date.now();
      const bootstrap: AttentionBootstrapJob[] = [];
      for (const job of this.storage.attentionBootstrapJobs.byDue.list({end: now + 1, limit: 16})) {
        bootstrap.push(job);
        if (bootstrap.length === 16) break;
      }
      await Promise.all(bootstrap.map(async job => {
        const workspace = this.storage.gadgets.get(job.workspaceId);
        if (!workspace || workspace.owner) {
          this.#purgeWorkspaceAttention(job.workspaceId);
          return;
        }
        this.storage.attentionBootstrapJobs.put({...job, attempt: job.attempt + 1,
          due: Date.now() + attentionRetryDelay(job.attempt + 1)});
        try {
          const overseers = this.ctx.exports.OverseerDurableObject;
          await attentionRpc(overseers.get(overseers.idFromString(job.workspaceId))
            .initializeAttention(this.ctx.id.toString()));
          // Only a complete snapshot is a receipt; a successful start is not completed backfill.
        } catch {
          logger.warn("attention bootstrap will retry", {event: "attention.bootstrap.failed"});
        }
      }));
      await Promise.all([...this.storage.pushJobs.list()].filter(job => job.due <= Date.now())
        .map(job => this.#drainPush(job)));
    } finally {
      await this.#scheduleAttentionAlarm();
    }
  }

  async #drainPush(job: PushJob): Promise<void> {
    const device = this.storage.pushDevices.get(job.id);
    if (!device || device.generation !== job.generation) return;
    const current = () => this.storage.pushDevices.get(job.id)?.generation === job.generation &&
      this.storage.pushJobs.get(job.id)?.revision === job.revision;
    const finish = (delivery: PushDevice["delivery"]) => {
      if (!current()) return;
      this.storage.pushJobs.delete(job.id);
      this.storage.pushDevices.put({...device, delivery});
      this.#attentionChanged();
    };
    const config = readPushConfig(this.env);
    if (!config || job.attempt >= 6) { finish("failed"); return; }
    job = {...job, attempt: job.attempt + 1, due: Date.now() + attentionRetryDelay(job.attempt + 1)};
    this.storage.pushJobs.put(job);
    let status: number | undefined;
    try {
      const request = await createPushRequest(device.subscription, config);
      let sourceFailed = false;
      // Crypto and source RPC yield: recheck device generation, job revision, local ownership,
      // exact source version, seen state and bot preference immediately before the fetch.
      for (const candidate of job.candidates) {
        if (!current()) return;
        const item = this.#eligibleAttention(candidate, device);
        if (!item) continue;
        try {
          const overseers = this.ctx.exports.OverseerDurableObject;
          if (!await attentionRpc(overseers.get(overseers.idFromString(item.workspaceId))
              .canNotifyAttention(this.ctx.id.toString(), item.sourceId, item.version))) continue;
        } catch {
          sourceFailed = true;
          continue;
        }
        if (!current()) return;
        if (!this.#eligibleAttention(candidate, device)) continue;
        const response = await fetch(request, {redirect: "manual", signal: AbortSignal.timeout(10_000)});
        status = response.status;
        // Body disposal must not change a transport receipt, and its errors may contain secrets.
        if (response.body) await response.body.cancel().catch(() => {});
        if (status === 404 || status === 410) {
          if (this.storage.pushDevices.get(job.id)?.generation === job.generation) {
            await this.removePushSubscription(job.id);
          }
          return;
        }
        if (response.ok) { finish("accepted"); return; }
        if ((status >= 300 && status < 400) || status === 401 || status === 403) { finish("failed"); return; }
        throw new Error("Push service rejected delivery.");
      }
      if (sourceFailed) throw new Error("Attention source check failed.");
      finish("idle");
      return;
    } catch {
      // Never log caught errors: fetch/crypto errors can contain the secret endpoint or keys.
      logger.warn("attention push attempt failed", {event: "attention.push.failed", status});
      if (job.attempt >= 6) finish("failed");
    }
    // A lost network response may retry an accepted push. The encrypted generic payload's stable
    // tag coalesces duplicates; acceptance is neither exactly-once delivery nor a seen receipt.
  }

  /**
   * Replace the set of outputs recorded for one workspace. Called by that workspace's Overseer
   * whenever its gadget registry changes and whenever it is opened.
   *
   * A workspace the user no longer tracks (deleted, or a shared one they dismissed) has its
   * entries dropped.
   */
  syncWorkspaceOutputs(workspaceId: string, entries: WorkspaceOutputEntry[]): void {
    this.storage.outputs.byWorkspace.delete(workspaceId);
    if (!this.storage.gadgets.get(workspaceId)) return;
    for (let entry of entries) {
      this.storage.outputs.put({...entry, workspaceId});
    }
  }

  async listOutputs(): Promise<ListOutputsResult> {
    let catchingUp = await this.#backfillOutputs();
    return {outputs: this.#readOutputs(), catchingUp};
  }

  // Ask the user's pre-existing workspaces to populate the outputs index, once. Workspaces push as
  // they change and when opened, so only those predating the index need this.
  //
  // Sweeps one bounded page and reports whether more remains, rather than sweeping everything: a
  // first Outputs load must not wait on every workspace the user has ever created. The caller
  // drains the rest, so the list fills in while the page is open.
  async #backfillOutputs(): Promise<boolean> {
    if (this.storage.outputsBackfilled.get()) return false;

    let startAfter = this.storage.outputsBackfillCursor.get() || undefined;
    let cursor = startAfter ?? "";
    let targets: string[] = [];
    let examined = 0;
    for (let gadget of this.storage.gadgets.list({startAfter, limit: OUTPUTS_BACKFILL_PAGE})) {
      ++examined;
      cursor = gadget.id;
      // A shared workspace is mirrored on open, not swept; a half-created one has nothing yet.
      if (!gadget.owner && isFullyCreated(gadget)) targets.push(gadget.id);
    }
    let done = examined < OUTPUTS_BACKFILL_PAGE;

    let ownerId = this.ctx.id.toString();
    let overseers = this.ctx.exports.OverseerDurableObject;
    let results = await Promise.allSettled(targets.map(id =>
        overseers.get(overseers.idFromString(id)).getOutputsForOwnerBackfill(ownerId)));

    let failureCount = 0;
    let firstError: unknown;
    for (let [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        if (result.value) this.syncWorkspaceOutputs(targets[index], result.value);
      } else {
        if (failureCount === 0) firstError = result.reason;
        ++failureCount;
      }
    }

    if (failureCount > 0) {
      logger.warn("failed to backfill outputs for some workspaces", {
        event: "outputs.backfill.partial",
        failureCount,
        error: firstError,
      });
    }

    // Advance past workspaces that failed, rather than retrying them. The index is self-healing,
    // so one missed here reappears the moment it is touched, whereas holding the cursor lets a
    // single unwakeable workspace stall the sweep forever.
    if (done) {
      this.storage.outputsBackfilled.put(true);
    } else {
      this.storage.outputsBackfillCursor.put(cursor);
    }

    // A page where everything failed looks systemic, so stop draining and let the next visit pick
    // up from the next page: draining on would be a burst of doomed calls during an outage.
    if (failureCount > 0 && failureCount === targets.length) return false;
    return !done;
  }

  #readOutputs(): OutputSummary[] {
    let result: OutputSummary[] = [];
    for (let output of this.storage.outputs.list()) {
      let workspace = this.storage.gadgets.get(output.workspaceId);
      if (!workspace || !isFullyCreated(workspace)) continue;
      result.push({
        workspaceId: output.workspaceId,
        workpieceId: output.workpieceId,
        ...(output.output ? {output: output.output} : {}),
        title: output.title,
        workspaceTitle: workspace.title,
        created: output.created,
        lastActive: workspace.lastActive,
        ...(workspace.owner ? {owner: workspace.owner} : {}),
        ...(workspace.role ? {role: workspace.role} : {}),
      });
    }
    result.sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime());
    return result;
  }

  // --- Blueprint methods (called by Overseer during propagation) ---

  async updateBlueprint(id: string, metadata: BlueprintMetadata, gadgetId: string): Promise<boolean> {
    let existing = this.storage.blueprints.get(id);
    // Preserve the featured bit across metadata-only/code updates.
    let featured = existing?.featured === true;
    this.storage.blueprints.put({id, metadata, gadgetId, featured});
    return featured;
  }

  async importBlueprint(id: string, metadata: BlueprintMetadata): Promise<void> {
    this.storage.libraryBlueprints.put({
      id,
      metadata,
      addedAt: new Date(),
      uploaded: true,
    });
  }

  async deleteBlueprint(id: string): Promise<void> {
    this.storage.blueprints.delete(id);
    this.storage.pinnedBlueprints.put(
      this.storage.pinnedBlueprints.get().filter(existing => existing !== id));
  }

  isBlueprintPinned(id: string): boolean {
    return this.storage.pinnedBlueprints.get().includes(id);
  }

  async setBlueprintPinned(id: string, pinned: boolean): Promise<void> {
    let pinnedBlueprints = this.storage.pinnedBlueprints.get().filter(existing => existing !== id);

    if (pinned) {
      if (!this.storage.blueprints.get(id) && !this.storage.libraryBlueprints.get(id)) {
        await this.addBlueprintToLibrary(id);
      }
      pinnedBlueprints.unshift(id);
    }

    this.storage.pinnedBlueprints.put(pinnedBlueprints);
  }

  async addBlueprintToLibrary(id: string): Promise<void> {
    let kvRecord = await readBlueprintKvRecord(this.env, id);
    if (!kvRecord) {
      throw new Error("Blueprint not found.");
    }

    let existing = this.storage.libraryBlueprints.get(id);
    if (existing) {
      existing.metadata = kvRecord.metadata;
      this.storage.libraryBlueprints.put(existing);
      return;
    }

    this.storage.libraryBlueprints.put({
      id,
      metadata: kvRecord.metadata,
      addedAt: new Date(),
      uploaded: false,
    });
  }

  async removeBlueprintFromLibrary(id: string): Promise<void> {
    let record = this.storage.libraryBlueprints.get(id);
    if (!record) {
      return;
    }

    if (record.uploaded) {
      await this.deleteOwnedBlueprint(id);
    } else {
      this.storage.libraryBlueprints.delete(id);
      await this.setBlueprintPinned(id, false);
    }
  }

  async isBlueprintInLibrary(id: string): Promise<{ uploaded: boolean } | null> {
    const record = this.storage.libraryBlueprints.get(id);
    if (!record) return null;
    return { uploaded: record.uploaded };
  }

  async deleteOwnedBlueprint(id: string): Promise<void> {
    if (isReservedBlueprintKey(id)) {
      throw new Error("Blueprint not found.");
    }

    let publishedRecord = this.storage.blueprints.get(id);
    let libraryRecord = this.storage.libraryBlueprints.get(id);
    let uploadedRecord = libraryRecord?.uploaded ? libraryRecord : undefined;
    let kvRecord = await readBlueprintKvRecord(this.env, id);

    if (!publishedRecord && !uploadedRecord && !kvRecord) {
      throw new Error("Blueprint not found.");
    }

    if (kvRecord) {
      if (kvRecord.ownerId !== this.ctx.id.toString()) {
        throw new Error("You don't own this blueprint.");
      }

      // Delete all R2 objects with the blueprint ID prefix.
      for (let v = 1; v <= kvRecord.metadata.version; v++) {
        await this.env.BLUEPRINT_CONTENT.delete(`${id}/${v}`);
      }
      await this.env.BLUEPRINT_CONTENT.delete(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${id}`);

      // Delete from KV.
      await this.env.BLUEPRINTS.delete(id);
    }

    if (publishedRecord?.featured === true) {
      await this.adminSettings.getByName("").deleteFeaturedBlueprint(id);
    }

    if (publishedRecord) {
      this.storage.blueprints.delete(id);
    }
    if (uploadedRecord) {
      this.storage.libraryBlueprints.delete(id);
    }
    await this.setBlueprintPinned(id, false);
  }

  async isBlueprintFeatured(id: string): Promise<boolean | null> {
    let record = this.storage.blueprints.get(id);
    if (!record) {
      return null;
    }

    return record.featured === true;
  }

  async setBlueprintFeatured(id: string, featured: boolean): Promise<void> {
    let record = this.storage.blueprints.get(id);
    if (!record) {
      throw new Error("No such blueprint.");
    }

    record.featured = featured;
    this.storage.blueprints.put(record);
  }

  getBlueprint(id: string): BlueprintUserSummary | null {
    let record = this.storage.blueprints.get(id);
    return record ? this.blueprintSummary(record, new Set(this.storage.pinnedBlueprints.get())) : null;
  }

  async listBlueprints(): Promise<BlueprintUserSummary[]> {
    let result: BlueprintUserSummary[] = [];
    let pinnedBlueprintIds = new Set(this.storage.pinnedBlueprints.get());
    for (let record of this.storage.blueprints.list()) {
      result.push(this.blueprintSummary(record, pinnedBlueprintIds));
    }
    result.sort((a, b) => b.lastUpdated.valueOf() - a.lastUpdated.valueOf());
    return result;
  }

  private blueprintSummary(record: BlueprintUserRecord, pinnedBlueprintIds: Set<string>): BlueprintUserSummary {
    return {
      id: record.id,
      title: record.metadata.title,
      description: record.metadata.description,
      source: this.blueprintSource(record),
      version: record.metadata.version,
      lastUpdated: record.metadata.lastUpdated,
      pinned: pinnedBlueprintIds.has(record.id) || undefined,
    };
  }

  // A blueprint with no `gadgetId` was added to the library rather than published from one of this
  // user's workspaces; one whose workspace is no longer registered here was published from a
  // workspace that has since been deleted.
  private blueprintSource(record: BlueprintUserRecord): BlueprintSource {
    if (!record.gadgetId) return { type: "imported" };
    let workspace = this.storage.gadgets.get(record.gadgetId);
    if (!workspace) return { type: "deletedWorkspace" };
    return { type: "workspace", workspaceId: record.gadgetId, workspaceTitle: workspace.title };
  }

  async listLibraryBlueprints(): Promise<BlueprintLibrarySummary[]> {
    let result: BlueprintLibrarySummary[] = [];
    let pinnedBlueprintIds = new Set(this.storage.pinnedBlueprints.get());
    for (let record of this.storage.libraryBlueprints.list()) {
      result.push({
        id: record.id,
        metadata: record.metadata,
        addedAt: record.addedAt,
        uploaded: record.uploaded,
        pinned: pinnedBlueprintIds.has(record.id) || undefined,
      });
    }
    result.sort((a, b) => b.addedAt.valueOf() - a.addedAt.valueOf());
    return result;
  }

  async listGatekeeperVendors(filter: GatekeeperVendorFilter = {})
      : Promise<GatekeeperVendorInfo[]> {
    let options = {
      userId: this.storage.profile.get().id
    };

    // Admin-disabled resources/gatekeepers are filtered out here, which also covers the agent (the
    // Overseer's connectable-vendor/resource list is sourced from this method).
    let config = await readAdminConfig(this.env);
    let disabledGatekeeperSet = new Set(config.disabledGatekeepers);

    let promises: Promise<GatekeeperVendorInfo | null>[] = [];

    for (let [id, vendor] of this.vendors) {
      if (disabledGatekeeperSet.has(id)) {
        continue;  // Whole gatekeeper disabled by admin.
      }
      promises.push((async () => {
        if (filter && !(await checkGatekeeperVendorFilter(vendor, id, filter))) {
          return null;
        }

        try {
          let [description, supportedResources] = await Promise.all([
            vendor.describe(),
            vendor.getSupportedResources(options),
          ]);
          let enabledResources =
              filterEnabledResources(config, id, supportedResources);
          if (enabledResources.length == 0) {
            // Every resource for this vendor is disabled (or it advertised none) — hide the vendor.
            return null;
          }

          return {id, description, supportedResources: enabledResources};
        } catch (err) {
          logger.warn("failed to load gatekeeper vendor", {
            event: "gatekeeper.vendor.load.failed", vendorId: id, error: err,
          });
          return unavailableGatekeeperVendorInfo(id);
        }
      })());
    }

    return (await Promise.all(promises)).filter(value => value !== null);
  }

  async connectAccount(vendorId: string, resourceUrlPatterns?: string[]): Promise<{url: string}> {
    let vendor = this.vendors.get(vendorId);
    if (!vendor) {
      throw new Error("No such service: " + vendorId);
    }
    if ((await readAdminConfig(this.env)).disabledGatekeepers.includes(vendorId.toLowerCase())) {
      throw new Error(`The "${vendorId}" gatekeeper is disabled on this deployment.`);
    }

    let accountId = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(accountId + 1);

    let props = {
      userId: this.ctx.id.toString(),
      accountId,
      vendorId,
    };

    let callback = this.ctx.exports.GatekeeperConnectCallbackImpl({props});

    let {url} = await vendor.connectAccount(callback, {resourceUrlPatterns});
    logger.info("account connect started", {
      event: "account.connect.started", vendorId, accountId,
    });
    return {url};
  }

  // Iterate every connected-account record, skipping any that fails to load. A record can fail to
  // deserialize when its account stub points at a gatekeeper Worker that's no longer bound in this
  // deployment (workerd throws "Stub refers to a service that doesn't exist"). Skipping it keeps one
  // stale account from breaking listing, provisioning, and opt-in for all the others — the same
  // resilience subscribeConnectedAccounts relies on (it iterates through this).
  *#connectedAccountRecords(): Generator<ConnectedAccountRecord> {
    let nextAccountId = this.storage.nextAccountId.get();
    for (let id = 0; id < nextAccountId; id++) {
      let rec: ConnectedAccountRecord | undefined;
      try {
        rec = this.storage.connectedAccounts.get(id);
      } catch (err) {
        logger.warn("skipping connected account: failed to load", {
          event: "connected.account.load.skipped", accountId: id, error: err,
        });
        continue;
      }
      if (rec) yield rec;
    }
  }

  // Whether this user already has a connected account for the given vendor.
  #hasAccountForVendor(vendorId: string): boolean {
    for (let rec of this.#connectedAccountRecords()) {
      if (rec.vendorId === vendorId) return true;
    }
    return false;
  }

  // Resolve every bound vendor that auto-provisions an account (VendorDescription.autoProvisionsAccount),
  // describing them in parallel and dropping any whose describe() fails. Shared discovery step for both
  // listing and auto-provisioning ambient gatekeepers; callers apply their own admin-mode filter.
  async #ambientVendors():
      Promise<Array<{vendorId: string, vendor: Service<GatekeeperVendor>, description: VendorDescription}>> {
    let described = await Promise.all([...this.vendors].map(async ([vendorId, vendor]) => {
      try {
        let description = await vendor.describe();
        return description.autoProvisionsAccount ? {vendorId, vendor, description} : null;
      } catch (err) {
        logger.warn("failed to describe vendor", {
          event: "vendor.describe.failed", vendorId, error: err,
        });
        return null;
      }
    }));
    return described.filter(v => v !== null);
  }

  /**
   * The ambient gatekeepers the user can opt into now: mode "optional" and not yet added. Backs the
   * Connectors "Available" section. ("enabled" ones are already provisioned; "disabled" ones aren't
   * offered.)
   */
  async listAddableGatekeepers(): Promise<GatekeeperVendorInfo[]> {
    let config = await readAdminConfig(this.env);
    return (await this.#ambientVendors())
        .filter(({vendorId}) =>
            ambientGatekeeperMode(config, vendorId) === "optional" && !this.#hasAccountForVendor(vendorId))
        // Same shape as listGatekeeperVendors; ambient gatekeepers expose no resources.
        .map(({vendorId, description}) => ({id: vendorId, description, supportedResources: []}));
  }

  // Per-vendor dedup of concurrent provisionAmbientAccount() calls — same DO-input-gate race as
  // #ensureAccountsPromise (see its comment below), e.g. a double-click on "Add". Cleared on completion.
  #provisionPromises = new Map<string, Promise<void>>();

  /**
   * Opt into an ambient gatekeeper on demand: mint its connected account for this user (no OAuth).
   * Only when the vendor's mode isn't "disabled" and the user has no account yet. Idempotent.
   */
  provisionAmbientAccount(vendorId: string): Promise<void> {
    vendorId = vendorId.toLowerCase();
    let inFlight = this.#provisionPromises.get(vendorId);
    if (inFlight) return inFlight;
    let promise = this.#provisionAmbientAccount(vendorId)
        .finally(() => { this.#provisionPromises.delete(vendorId); });
    this.#provisionPromises.set(vendorId, promise);
    return promise;
  }

  async #provisionAmbientAccount(vendorId: string): Promise<void> {
    let vendor = this.vendors.get(vendorId);
    if (!vendor) throw new Error("No such service: " + vendorId);

    if (ambientGatekeeperMode(await readAdminConfig(this.env), vendorId) === "disabled") {
      throw new Error(`The "${vendorId}" gatekeeper is disabled on this deployment.`);
    }

    let description = await vendor.describe();
    if (!description.autoProvisionsAccount) {
      throw new Error(`The "${vendorId}" gatekeeper can't be added this way.`);
    }

    if (this.#hasAccountForVendor(vendorId)) return;  // already added

    await this.#createAutoProvisionedAccount(vendorId, vendor);
  }

  async #createAutoProvisionedAccount(vendorId: string, vendor: Service<GatekeeperVendor>, agentId?: string): Promise<void> {
    let account: Fetcher<GatekeeperUser>;
    
    if (vendorId === "context" && agentId) {
      account = await (vendor as unknown as AccountCreatorWithIdStub).createAccountWithId(agentId);
    } else {
      account = await (vendor as unknown as AccountCreatorStub).createAccount();
    }
    
    let description = await account.describe();
    let accountId = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(accountId + 1);
    this.storage.connectedAccounts.put({
      id: accountId,
      account,
      description,
      vendorId,
      autoProvisioned: true,
      agentId,
    });
  }

  // Dedup concurrent #ensureAutoProvisionedAccounts() calls. The provisioning loop awaits cross-worker
  // RPCs (describe/createAccount), which releases the DO input gate; without this, two overlapping
  // calls (e.g. the nav listing apps while a gadget opens) could both see "not provisioned" and
  // create duplicate accounts. Cleared on completion so a later call re-checks (e.g. for a gatekeeper
  // bound after this DO started). Keyed by agentId (empty string for user-global).
  #ensureAccountsPromises = new Map<string, Promise<void>>();

  // Ensure an auto-provisioned connected account exists for every bound vendor that requests it
  // (VendorDescription.autoProvisionsAccount) and is permitted by the provisioning policy. Idempotent
  // and best-effort: a single failing vendor never blocks the others. Creates at most one account per
  // vendor (or per vendor+agent for per-agent accounts). Deduped via #ensureAccountsPromises (above);
  // callers reach it through listProvidedAccounts.
  #ensureAutoProvisionedAccounts(agentId?: string): Promise<void> {
    let key = agentId ?? "";
    let existing = this.#ensureAccountsPromises.get(key);
    if (existing) return existing;
    let promise = this.#provisionMissingAccounts(agentId).finally(() => {
      this.#ensureAccountsPromises.delete(key);
    });
    this.#ensureAccountsPromises.set(key, promise);
    return promise;
  }

  async #provisionMissingAccounts(agentId?: string): Promise<void> {
    // Which vendors already have an auto-provisioned account for this agent (or user-global if no agentId)?
    let provisioned = new Set<string>();
    for (let rec of this.#connectedAccountRecords()) {
      if (rec.autoProvisioned) {
        // Match: both have agentId and they're equal, or neither has agentId (user-global)
        if ((agentId && rec.agentId === agentId) || (!agentId && !rec.agentId)) {
          provisioned.add(rec.vendorId);
        }
      }
    }

    let config = await readAdminConfig(this.env);
    for (let {vendorId, vendor} of await this.#ambientVendors()) {
      if (provisioned.has(vendorId)) continue;
      // Only "enabled" (forced) vendors are auto-provisioned for everyone. "optional" vendors are
      // added on demand by the user (provisionAmbientAccount); "disabled" ones never.
      if (!shouldAutoProvisionAccount(config, vendorId)) continue;

      try {
        await this.#createAutoProvisionedAccount(vendorId, vendor, agentId);
      } catch (err) {
        logger.error("failed to auto-provision account", {
          event: "account.auto.provision.failed", vendorId, error: err,
        });
      }
    }
  }

  async listProvidedAccounts(agentId?: string): Promise<ProvidedAccountInfo[]> {
    await this.#ensureAutoProvisionedAccounts(agentId);
    let config = await readAdminConfig(this.env);
    let result: ProvidedAccountInfo[] = [];
    for (let rec of this.#connectedAccountRecords()) {
      if (!rec.description.singleton && !rec.description.providesUi) continue;
      if (rec.autoProvisioned && ambientGatekeeperMode(config, rec.vendorId) === "disabled") continue;
      
      if (agentId && rec.vendorId === "context") {
        if (rec.agentId !== agentId) continue;
      } else if (agentId && rec.agentId && rec.agentId !== agentId) {
        continue;
      }
      
      result.push({ accountId: rec.id, vendorId: rec.vendorId, description: rec.description });
    }
    return result;
  }

  /**
   * Get the gatekeeper class implementing a singleton account's agent session. The overseer installs
   * this gatekeeper into the owner's gadgets (as a Facet) like any other gatekeeper, so the session
   * and catalog run gadget-side in the gatekeeper's own worker — no further round-trips through this
   * DO. The account capability stays encapsulated here; only the class reference crosses out.
   */
  async getSingletonGatekeeperClass(accountId: number)
      : Promise<DurableObjectClass<Gatekeeper<any>> | null> {
    let record = this.storage.connectedAccounts.get(accountId);
    // Present only when description.singleton is set; gate on that, then call through the derived
    // SingletonAccountStub view (see its definition for why the cast is needed).
    if (!record?.description.singleton) return null;
    return (record.account as unknown as SingletonAccountStub).getSingletonGatekeeperClass();
  }

  /**
   * Open the full-page management UI for an account that declares one. `context.isAdmin` is supplied
   * fresh by the caller so admin-gated features reflect the user's current status.
   */
  async startAccountAppUi(accountId: number, context: AppUiContext): Promise<GatekeeperUiFrame> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record?.description.providesUi) throw new Error("No such app.");
    return (record.account as unknown as SingletonAccountStub).startAppUi(context);
  }

  async ensureAccountResources(accountId: number, resourceUrlPatterns: string[]): Promise<{url?: string}> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    return record.account.ensureResources(resourceUrlPatterns);
  }

  async subscribeConnectedAccounts(
      subscriber: RpcStub<ConnectedAccountsSubscriber>, filter?: ConnectedAccountsFilter)
      : Promise<RpcStub<{}>> {
    if (filter?.includeForcedAutoProvisionedAccounts) await this.#ensureAutoProvisionedAccounts();

    let connectedAccounts = this.storage.connectedAccounts;
    let vendors = this.vendors;

    subscriber = subscriber.dup();  // keep stub after return

    let seenIds = new Set<number>();
    let vendorDescriptions = new Map<string, Promise<VendorDescription>>();

    // Snapshot the admin config once for this subscription. Changes take effect when the client
    // re-subscribes (e.g. on reconnect), matching other deployment config.
    let config = await readAdminConfig(this.env);
    let disabledGatekeeperSet = new Set(config.disabledGatekeepers);
    
    let allowedAccountIds: Set<number> | undefined;
    if (filter?.workspaceId) {
      let agentProfile = filter.agentId
        ? await this.getAgent(filter.agentId)
        : await this.getAgentByWorkspaceId(filter.workspaceId);
      if (agentProfile?.defaultBindings !== undefined) {
        allowedAccountIds = new Set(agentProfile.defaultBindings);
      }
    }

    async function notifyAdd(record: ConnectedAccountRecord) {
      if (allowedAccountIds && !allowedAccountIds.has(record.id)) {
        return;
      }
      // Ambient (auto-provisioned) accounts only appear in the Connectors list when their vendor is
      // "optional" — i.e. the user opted in and can manage/remove it. "enabled" (forced) accounts have
      // nothing to manage, and "disabled" ones are dormant, so both are hidden.
      // Forced accounts are included when observer verification explicitly requests them.
      if (record.autoProvisioned) {
        let mode = ambientGatekeeperMode(config, record.vendorId);
        if (mode === "disabled" ||
            (mode === "enabled" && !filter?.includeForcedAutoProvisionedAccounts)) {
          return;
        }
      }
      if (disabledGatekeeperSet.has(record.vendorId)) {
        return;  // Whole gatekeeper disabled by admin.
      }
      if (filter && !(await checkGatekeeperVendorFilter(
          record.account, record.vendorId, filter))) {
        return;
      }

      let vendor = vendors.get(record.vendorId);
      if (!vendor) {
        logger.error("no such service for connected account", {
          event: "connected.account.service.missing",
          accountId: record.id, vendorId: record.vendorId,
        });
        return;
      }

      let vendorDescription: VendorDescription;
      try {
        let vendorDescriptionPromise = vendorDescriptions.get(record.vendorId);
        if (!vendorDescriptionPromise) {
          vendorDescriptionPromise = vendor.describe().catch(err => {
            vendorDescriptions.delete(record.vendorId);
            throw err;
          });
          vendorDescriptions.set(record.vendorId, vendorDescriptionPromise);
        }
        vendorDescription = await vendorDescriptionPromise;
      } catch (err) {
        logger.warn("failed to describe connected account", {
          event: "connected.account.describe.failed",
          accountId: record.id, vendorId: record.vendorId, error: err,
        });
        return;
      }

      let supportedResources: SupportedResource[] = [];
      try {
        supportedResources = await record.account.getSupportedResources();
        supportedResources =
            filterEnabledResources(config, record.vendorId, supportedResources);
      } catch (err) {
        logger.warn("failed to get supported resources for connected account", {
          event: "connected.account.supported.resources.failed",
          accountId: record.id, vendorId: record.vendorId, error: err,
        });
      }

      let credentialsValid = areCredentialsValid(record);

      seenIds.add(record.id);
      subscriber.add(record.id, record.description, vendorDescription,
          supportedResources, credentialsValid, record.vendorId).catch(unsubscribe)
    }

    let dbSubscriber = {
      async add(record: ConnectedAccountRecord) {
        await notifyAdd(record);
      },
      async update(oldRecord: ConnectedAccountRecord, newRecord: ConnectedAccountRecord) {
        await notifyAdd(newRecord);
      },
      remove(record: ConnectedAccountRecord): void {
        if (seenIds.has(record.id)) {
          subscriber.remove(record.id);
          seenIds.delete(record.id);
        }
      }
    }

    let unsubscribe = () => {
      connectedAccounts.unsubscribe(dbSubscriber);
      subscriber[Symbol.dispose]();
    };

    // #connectedAccountRecords() skips any record that fails to load, so a single stale account
    // (e.g. one whose gatekeeper Worker is no longer bound) doesn't prevent surfacing the others.
    let promises = [...this.#connectedAccountRecords()].map(record => notifyAdd(record));

    connectedAccounts.subscribe(dbSubscriber);

    await Promise.all(promises);

    subscriber.ready().catch(unsubscribe);

    return new RpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
        subscriber[Symbol.dispose]();
      }
    });
  }

  async disconnectAccount(accountId: number): Promise<void> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (account) {
      if (account.autoProvisioned) {
        // A forced ("enabled") ambient account can't be removed by the user — the admin controls it.
        if (shouldAutoProvisionAccount(await readAdminConfig(this.env), account.vendorId)) {
          throw new Error("This account is provided automatically and can't be disconnected.");
        }
        // An opt-in ("optional") ambient account: the user added it, so let them remove it. revoke()
        // gives the gatekeeper a chance to delete its own per-user storage (e.g. the account's
        // private collections DO) — it's its cleanup hook, not just OAuth revocation. Best-effort:
        // a gatekeeper that throws (or has nothing to revoke) must not block the user's disconnect.
        try {
          await account.account.revoke();
        } catch (err) {
          logger.error("revoke() failed during disconnect", {
            event: "account.revoke.failed",
            vendorId: account.vendorId, accountId, error: err,
          });
        }
        this.storage.connectedAccounts.delete(accountId);
        logger.info("account disconnected", {
          event: "account.disconnected",
          vendorId: account.vendorId, accountId, autoProvisioned: true,
        });
        return;
      }
      await account.account.revoke();
      this.storage.connectedAccounts.delete(accountId);
      // Disconnecting the Cloudflare account also clears the AI Gateway billing state (selected
      // account + cached balance), which is meaningless without the underlying grant.
      if (account.vendorId === CLOUDFLARE_VENDOR_ID) {
        this.storage.cloudflareBilling.put(null);
      }
      logger.info("account disconnected", {
        event: "account.disconnected",
        vendorId: account.vendorId, accountId, autoProvisioned: false,
      });
    }
  }

  async reconnectAccount(accountId: number): Promise<{url: string}> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    return record.account.reconnect();
  }

  async startResourceConfigurator(
      accountId: number,
      resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");
    return record.account.startResourceConfigurator(resourceUrlPattern);
  }

  /**
   * Persist a connected gatekeeper account that was established during sign-in (rather than via the
   * usual logged-in connectAccount flow). Used for providers like Cloudflare where signing in also
   * links the account for AI Gateway billing: the login callback resolves this user by verified
   * email, then calls here to store the resulting grant. That grant covers billing only: sign-in
   * requests no gadget-facing resources, so any later resource access is authorized separately.
   */
  async linkConnectedAccountFromLogin(
      account: Fetcher<GatekeeperUser>, vendorId: string, expiresAt?: Date): Promise<void> {
    let description = await account.describe();
    let uniqueName = description.uniqueName;

    // A repeated sign-in is a re-authorization, so the *fresh* grant is the one we want. If this
    // identity is already connected for this vendor, refresh that record in place rather than letting
    // putConnectedAccount's dedup discard the new grant: keeping the stale record would leave billing
    // broken whenever the old token had expired or was rotated out by this very re-auth — the
    // opposite of what signing in again should accomplish.
    if (uniqueName) {
      let existing = this.#findConnectedAccountByIdentity(vendorId, uniqueName);
      if (existing) {
        // Drop the now-stale grant (a separate gatekeeper-side object from the fresh one), then point
        // the existing record — keeping its id, so UI references stay stable — at the fresh grant.
        try {
          await existing.account.revoke();
        } catch (err) {
          logger.error("failed to revoke stale grant; replacing anyway", {
            event: "account.stale.grant.revoke.failed",
            accountId: existing.id, vendorId, error: err,
          });
        }
        existing.account = account;
        existing.description = description;
        existing.credentialExpiresAt = expiresAt;
        existing.credentialsExpired = false;
        this.storage.connectedAccounts.put(existing);
        return;
      }
    }

    let id = this.storage.nextAccountId.get();
    this.storage.nextAccountId.put(id + 1);
    this.storage.connectedAccounts.put({
      id,
      account,
      description,
      vendorId,
      credentialExpiresAt: expiresAt,
    });
  }

  // Find an existing connected account for the given vendor + identity (uniqueName), excluding
  // `excludeId`. Skips records that fail to load, for the same reasons as subscribeConnectedAccounts():
  // a single corrupt record (e.g. one referencing a Worker binding that no longer exists) must not
  // poison the scan and prevent the user from connecting any new account.
  #findConnectedAccountByIdentity(vendorId: string, uniqueName: string, excludeId?: number)
      : ConnectedAccountRecord | undefined {
    let nextAccountId = this.storage.nextAccountId.get();
    for (let id = 0; id < nextAccountId; id++) {
      if (id === excludeId) continue;
      let existing: ConnectedAccountRecord | undefined;
      try {
        existing = this.storage.connectedAccounts.get(id);
      } catch (err) {
        logger.warn("skipping connected account during identity lookup: failed to load", {
          event: "connected.account.identity.lookup.skipped", accountId: id, error: err,
        });
        continue;
      }
      if (!existing) continue;
      if (existing.vendorId === vendorId && existing.description.uniqueName === uniqueName) {
        return existing;
      }
    }
    return undefined;
  }

  async putConnectedAccount(record: ConnectedAccountRecord) {
    let uniqueName = record.description.uniqueName;
    if (uniqueName &&
        this.#findConnectedAccountByIdentity(record.vendorId, uniqueName, record.id)) {
      // OAuth providers often return the currently logged-in identity when the user tries to add
      // another account. Avoid showing duplicate account rows: keep the existing record stable for
      // any UI references, and revoke the newly-created duplicate grant.
      await record.account.revoke();
      return;
    }

    this.storage.connectedAccounts.put(record);
  }

  async markCredentialsExpired(accountId: number) {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");

    if (!record.credentialsExpired) {
      record.credentialsExpired = true;
      this.storage.connectedAccounts.put(record);
    }
  }

  async markCredentialsRestored(accountId: number, expiresAt?: Date) {
    let record = this.storage.connectedAccounts.get(accountId);
    if (!record) throw new Error("No such account.");

    // Re-fetch description since the user may have re-authed with different info.
    record.description = await record.account.describe();
    record.credentialsExpired = false;
    record.credentialExpiresAt = expiresAt;
    this.storage.connectedAccounts.put(record);
  }

  async getAccountVendorId(accountId: number): Promise<string | null> {
    let account = this.storage.connectedAccounts.get(accountId);
    return account?.vendorId ?? null;
  }

  async getConnectedAccount(accountId: number): Promise<Fetcher<GatekeeperUser> | null> {
    let account = this.storage.connectedAccounts.get(accountId);
    return account?.account ?? null;
  }

  async getGatekeeperClassFor(accountId: number, url: string)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, vendorId: string,
                  typeUrlPattern: string}> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (!account) throw new Error("No such account.");
    let {class: cls, resource} = await account.account.getGatekeeperClassFor(url);

    // Block whole gatekeepers + disabled resources at this single core-side chokepoint where a
    // resourceUrl becomes a capability (reached only via the user/UI-facing Overseer.newGatekeeper
    // and blueprint instantiation — never from gadget or agent code).
    let config = await readAdminConfig(this.env);
    let vendorId = account.vendorId.toLowerCase();
    if (config.disabledGatekeepers.includes(vendorId)) {
      throw new Error(
          `The "${account.vendorId}" gatekeeper is disabled on this deployment by an administrator.`);
    }

    // Blocking here prevents minting a new capability to a disabled resource even if the request
    // bypasses the (separately filtered) picker/agent listings.
    if (isResourceDisabled(config, vendorId, resource.urlPattern)) {
      throw new Error(
          `The "${resource.title}" resource is disabled on this deployment by an administrator.`);
    }

    return {class: cls, vendorId: account.vendorId, typeUrlPattern: resource.urlPattern};
  }

  /**
   * Mint a verifier from one of THIS user's connected accounts, identified by accountId. The
   * overseer passes the returned verifier to a gatekeeper's `addObserver()` so the gatekeeper can
   * check whether this user is allowed to observe the data read through it. Returns null if the
   * account no longer exists (or never existed). Throws if the account belongs to a different
   * vendor (not a legitimate UI state — only reachable by bypassing client-side filtering).
   *
   * Account *selection* (which of the user's accounts to use for a given binding) is done by the
   * frontend; this method validates and resolves a chosen account to its verifier.
   */
  async getVerifier(accountId: number, expectedVendorId: string)
      : Promise<Fetcher<GatekeeperUserVerifier> | null> {
    let account = this.storage.connectedAccounts.get(accountId);
    if (!account) return null;
    if (account.vendorId !== expectedVendorId) {
      // Details stay server-side: this error reaches the browser via ensureObserver → open.
      console.error(
          `getVerifier: account ${accountId} vendor "${account.vendorId}" ` +
          `!= expected "${expectedVendorId}"`);
      throw new Error("Invalid account selection for this service.");
    }
    return await account.account.getVerifier();
  }

  /**
   * Describe one of the user's connected accounts so a caller can name it in a message. Returns null
   * if it no longer exists.
   */
  async describeConnectedAccount(accountId: number): Promise<AccountDescription | null> {
    let account = this.storage.connectedAccounts.get(accountId);
    return account ? account.description : null;
  }

}

type GatekeeperConnectCallbackProps = {
  userId: string;
  accountId: number;
  vendorId: string;
}

export class GatekeeperConnectCallbackImpl
    extends WorkerEntrypoint<Cloudflare.Env, GatekeeperConnectCallbackProps>
    implements GatekeeperConnectCallback {
  #getUserStub() {
    let userId = this.ctx.exports.UserDurableObject.idFromString(this.ctx.props.userId);
    return this.ctx.exports.UserDurableObject.get(userId);
  }

  async complete(account: Fetcher<GatekeeperUser>, expiresAt?: Date): Promise<void> {
    let userStub = this.#getUserStub();

    await userStub.putConnectedAccount({
      id: this.ctx.props.accountId,
      account,
      description: await account.describe(),
      vendorId: this.ctx.props.vendorId,
      credentialExpiresAt: expiresAt,
    });
  }

  async credentialsExpired(): Promise<void> {
    let userStub = this.#getUserStub();
    await userStub.markCredentialsExpired(this.ctx.props.accountId);
  }

  async credentialsRestored(expiresAt?: Date): Promise<void> {
    let userStub = this.#getUserStub();
    await userStub.markCredentialsRestored(this.ctx.props.accountId, expiresAt);
  }
}

export function normalizeUsername(username: string) {
  username = username.toLowerCase();

  if (!username.match(/^[a-z][a-z0-9_]*$/)) {
    throw new Error("Invalid username. Must be alphanumeric starting with a letter.")
  }

  return username;
}
