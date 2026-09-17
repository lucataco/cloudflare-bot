import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub } from "capnweb";
import { keyString } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo, BlueprintOutput } from "@gadgets/workshop-shared/api";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { WORKFLOW_STARTERS, type WorkflowStarter }
  from "@gadgets/workshop-shared/workflow-starters";
import type { OverseerDurableObject } from "../src/overseer.js";
import { chatChangeStatuses } from "../src/agent-compaction.js";
import { openFakeOverseer } from "./fixtures.js";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    }
  }
}

// Kernel workflow-contract evals, not model-quality evals. Like chat-changes.test.ts, these
// reach the real implementation inside workerd; bracket access retains its actual inferred type.
type Impl = OverseerDurableObject["impl"];
type Fixture = {
  sources: { title: string; url: string; text: string }[];
  outline: string;
  evidence: string[];
  proposedWrite: string;
};

// Entirely synthetic. The script quotes source returns; it does not simulate an LLM's reasoning.
const FIXTURES = {
  "meeting-brief": {
    sources: [
      { title: "Design review", url: "https://sources.invalid/meeting/review",
        text: "The sample design review is on September 10. Its purpose is to choose a prototype." },
      { title: "Prototype notes", url: "https://sources.invalid/meeting/prototypes",
        text: "Prototype Cedar supports offline notes. Prototype Birch has not been tested offline." },
    ],
    outline: "## Suggested agenda\nCompare offline behavior, then discuss the prototype choice.\n\n" +
      "## Open questions and decisions\nWhich prototype should proceed? Attendees are unknown.",
    evidence: ["September 10", "Cedar supports offline notes", "Birch has not been tested offline"],
    proposedWrite: "Send the meeting brief to the sample review group",
  },
  "feedback-summary": {
    sources: [
      { title: "Feedback F-101", url: "https://sources.invalid/feedback/F-101",
        text: "F-101 (September 1): request for CSV export; the author likes the search feature." },
      { title: "Feedback F-102", url: "https://sources.invalid/feedback/F-102",
        text: "F-102 (September 3): bug report that CSV export drops non-ASCII column names." },
    ],
    outline: "## Summary table\n| Theme | Unique items | Types |\n| --- | --- | --- |\n" +
      "| CSV export | 2 | Request, bug |\n| Search | 1 | Positive |\n\n" +
      "## Suggested next steps\nInvestigate export. Count distinct feedback IDs, not mentions. " +
      "Coverage is limited to the two selected reports; other customer feedback is unknown.",
    evidence: ["F-101 (September 1)", "F-102 (September 3)", "drops non-ASCII column names"],
    proposedWrite: "Create a sample export investigation ticket",
  },
  "project-update": {
    sources: [
      { title: "Project Cedar status", url: "https://sources.invalid/project/status",
        text: "Completed: the sample import parser. Current work: validation. Blocker: no staging dataset." },
      { title: "Project Cedar plan", url: "https://sources.invalid/project/plan",
        text: "Planned, not completed: staging rollout on September 12, contingent on validation." },
    ],
    outline: "## Suggested next steps\nObtain a synthetic staging dataset and validate before rollout.\n\n" +
      "## Missing information\nThe validation owner and delivery confidence are unknown. " +
      "This is a draft for review, not a sent update or a recurring schedule.",
    evidence: ["Completed: the sample import parser", "Blocker: no staging dataset", "Planned, not completed"],
    proposedWrite: "Post the sample weekly update to the project channel",
  },
} satisfies Record<WorkflowStarter["id"], Fixture>;

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@eval.invalid", name: "Eval Owner" };
const COLLABORATOR: AiChatAuthorInfo = {
  type: "user", id: "reviewer@eval.invalid", name: "Eval Reviewer",
};
const DOCUMENT: BlueprintOutput = {
  id: "document", noun: "Document", plural: "Documents", icon: "fileText",
};
const SOURCE_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
];
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000003";
const SOURCE_GATEKEEPER = 71;
const WRITE_GATEKEEPER = 72;
const OTHER_CHAT = 2;
let nextWorkspace = 0;

beforeEach(() => {
  // Fail closed if a future edit accidentally introduces model/provider HTTP calls.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Workflow evals forbid network access"));
});
afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

async function withWorkspace(run: (impl: Impl) => Promise<void>) {
  const stub = env.TEST_OVERSEER.getByName(`workflow-evals-${++nextWorkspace}`);
  await runInDurableObject(stub, async instance => {
    await run(instance["impl"]);
  });
}

function seed(impl: Impl, starter: WorkflowStarter) {
  const fixture = FIXTURES[starter.id];
  impl.ownerProfileId = OWNER.id; // Avoid a User DO lookup, not a sharing-policy mock.
  for (const chatId of [1, OTHER_CHAT]) {
    impl.storage.chatMeta.put({
      id: chatId, title: starter.title, started: new Date(0), lastActive: new Date(chatId),
    });
    impl.storage.chatContext.put({
      chatId, agentId: `${starter.id}-${chatId}`, bindings: {},
      agentInstructions: chatId === 1 ? "Quote only selected evidence." : "Other profile instructions.",
    });
  }
  impl.addChatMessages(1, OWNER, [{ type: "message", message: starter.prompt }]);
  fixture.sources.forEach((source, i) => {
    impl.storage.chatAttachmentContent.put({
      fileId: SOURCE_IDS[i], data: new TextEncoder().encode(source.text),
      state: { type: "committed", chatId: 1 },
    });
  });
  impl.storage.chatAttachmentContent.put({
    fileId: OTHER_SOURCE_ID, data: new TextEncoder().encode("OTHER_PROFILE_PRIVATE_SENTINEL"),
    state: { type: "committed", chatId: OTHER_CHAT },
  });
}

function messages(impl: Impl, chatId = 1) {
  return [...impl.storage.chats.list({ prefix: `${keyString(chatId)}.` })];
}

// A synthetic source provider: real chat-scoped content retrieval, then the same authorization
// method ApprovalQueueImpl delegates to, before releasing bytes to the scripted consumer. This is
// deliberately NOT a claim that ordinary attachment reads automatically produce observations.
async function readSource(impl: Impl, chatId: number, id: string,
                          description: ObservationDescription) {
  const bytes = await impl.getChatAttachmentData(chatId, id);
  await impl.authorizeObservation(SOURCE_GATEKEEPER, description, { from: "agent", chatId });
  return new TextDecoder().decode(bytes);
}

async function draft(impl: Impl, starter: WorkflowStarter,
                     policy: Partial<ObservationDescription> = {}) {
  const fixture = FIXTURES[starter.id];
  const evidence: string[] = [];
  for (const [i, source] of fixture.sources.entries()) {
    const text = await readSource(impl, 1, SOURCE_IDS[i], {
      title: source.title, description: `Read selected source: ${source.url}`, ...policy,
    });
    evidence.push(`- ${text} ([${source.title}](${source.url}))`);
  }

  const author: AiChatAuthorInfo = {
    type: "agent", id: "scripted-contract", name: "Scripted workflow",
    agentProfileId: impl.getChatAgentContext(1).agentId,
  };
  const gadget = impl.createGadget(starter.title, "WORKFLOW_DOCUMENT", 1, DOCUMENT);
  // Direct implementation calls have no live execution/capture token. Their audit cards must
  // already be durable and untracked, not buffered for this synthetic step or a future turn.
  const observations = [...impl.storage.actions.list()];
  expect(observations).toHaveLength(fixture.sources.length);
  expect(messages(impl).filter(m => m.type === "action").map(m => ({
    actionId: m.actionId, author: m.author, runId: m.runId,
  }))).toEqual(observations.map(o => ({ actionId: o.id, author: OWNER, runId: undefined })));
  expect(impl.consumeCapturedActions(1)).toBeUndefined();
  const content = `# ${starter.title}\n\n## Selected evidence\n${evidence.join("\n")}\n\n${fixture.outline}\n`;
  expect(await impl.commitAgentStep(1, author, [
    { type: "message", message: "Draft ready for review. Open the document result below." },
  ], {
    changes: [{ change: { [gadget.id]: [["document.md", { set: content }]] } }],
    createdGadgets: [{ gadgetId: gadget.id, title: gadget.title, bindingName: gadget.bindingName }],
    addedBindings: [],
  })).toBe(true);
  return gadget.id;
}

describe.each(WORKFLOW_STARTERS)("kernel workflow-contract eval: $id", starter => {
  it("audits selected evidence, keeps the document provisional, and accepts without applying writes", async () => {
    await withWorkspace(async impl => {
      seed(impl, starter);
      const fixture = FIXTURES[starter.id];
      const apply = vi.spyOn(impl, "applyPendingAction");
      const gadgetId = await draft(impl, starter);
      const observations = [...impl.storage.actions.list()];
      expect(observations).toHaveLength(2);
      observations.forEach((observation, i) => {
        expect(observation).toMatchObject({
          type: "observation", state: "approved", gatekeeperId: SOURCE_GATEKEEPER,
          caller: { from: "agent", chatId: 1 },
          description: {
            title: fixture.sources[i].title,
            description: `Read selected source: ${fixture.sources[i].url}`,
          },
        });
      });
      expect(messages(impl).filter(m => m.type === "action").map(m => m.actionId))
        .toEqual(observations.map(o => o.id));
      const changes = messages(impl).filter(m => m.type === "changes");
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        author: { agentProfileId: `${starter.id}-1` },
        createdGadgets: [{ gadgetId, title: starter.title, bindingName: "WORKFLOW_DOCUMENT" }],
        watermark: { changesGeneration: 0, throughRevision: 1 },
      });
      expect(impl.storage.gadgets.get(gadgetId)?.pending)
        .toEqual({ chatId: 1, sequence: changes[0].sequence });
      expect(impl.getGadgetHead(gadgetId)).toBeUndefined();
      expect(impl.outputsSnapshot()).toEqual([]);
      expect(impl.getProposedChanges(1)).toHaveLength(1);

      const files = (await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(gadgetId)!;
      const document = files.get("document.md")!;
      expect([...files.keys()]).toEqual(["document.md"]);
      for (const claim of fixture.evidence) expect(document).toContain(claim);
      for (const source of fixture.sources) expect(document).toContain(`](${source.url})`);
      expect(document).toContain("unknown");
      expect(document).not.toContain("OTHER_PROFILE_PRIVATE_SENTINEL");

      // Other profile/chat cannot resolve or edit this proposal. Accepted work is intentionally
      // workspace-wide; an agent profile is not an independent authorization principal.
      expect(impl.listGadgetInfo(1).map(g => g.id)).toEqual([gadgetId]);
      expect(impl.listGadgetInfo(OTHER_CHAT)).toEqual([]);
      expect(() => impl.resolveWorkpieceRoot(gadgetId, true, OTHER_CHAT)).toThrow("No such gadget");
      await expect(impl.submitCodeChange(OTHER_CHAT, {
        generation: 0, revision: 0, clientId: "other-profile", seq: 1,
        change: { [gadgetId]: [["document.md", { set: "OTHER_PROFILE_PRIVATE_SENTINEL" }]] },
      }, OWNER, "other-user-do")).rejects.toThrow("pending in another chat");
      expect(await impl.getCurrentChatContent(OTHER_CHAT, impl.storage.chatMeta.get(OTHER_CHAT)!))
        .toEqual(new Map());

      // A SEPARATE explicit follow-up requests a write; the starter alone does not request one.
      impl.addChatMessages(1, OWNER, [{ type: "message", message: fixture.proposedWrite }]);
      const actionId = impl.storage.nextActionId.get();
      await impl.submitAction(WRITE_GATEKEEPER, 900, {
        title: fixture.proposedWrite, description: "Synthetic external write; manual review required.",
        implementsRevert: false, autoApprovable: false, awaitDecision: true,
        actionKind: { tag: "publish", label: "Publish" },
      }, { from: "agent", chatId: 1 });
      expect(impl.consumeCapturedActions(1)).toBeUndefined();
      expect([...impl.storage.actions.list()]).toHaveLength(observations.length + 1);
      expect(messages(impl).filter(m => m.type === "action").map(m => m.actionId))
        .toEqual([...observations.map(o => o.id), actionId]);
      expect(messages(impl).at(-1)).toMatchObject({ type: "action", actionId });
      expect(messages(impl).at(-1)?.runId).toBeUndefined();
      await impl.drainAutoApprovals(WRITE_GATEKEEPER);
      expect([...impl.storage.autoApproveTags.list()]).toEqual([]);

      expect(await impl.mergeChanges(1, { profile: OWNER }, "eval-owner-do"))
        .toEqual({ outcome: "merged" });
      const head = impl.getGadgetHead(gadgetId)!;
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      expect((await impl.gitStore.readCommitFiles(head)).get("document.md")).toBe(document);
      expect(impl.storage.gadgets.get(gadgetId)?.pending).toBeUndefined();
      expect(impl.outputsSnapshot()).toMatchObject([{ workpieceId: gadgetId, output: DOCUMENT }]);
      expect(impl.getProposedChanges(1)).toEqual([]);
      expect(chatChangeStatuses(messages(impl)).get(changes[0].sequence)).toBe("merged");
      expect(impl.listGadgetInfo(OTHER_CHAT).map(g => g.id)).toEqual([gadgetId]);
      await impl.drainAutoApprovals(WRITE_GATEKEEPER);
      expect(impl.storage.actions.get(actionId)).toMatchObject({
        type: "action", state: "pending", action: 900,
        caller: { from: "agent", chatId: 1 }, description: { autoApprovable: false },
      });
      expect(impl.storage.actions.get(actionId)?.appliedAt).toBeUndefined();
      expect(apply).not.toHaveBeenCalled();
      expect([...impl.storage.boundHooks.list()]).toEqual([]);
    });
  });

  it("does not turn a partially unavailable source set into a successful output", async () => {
    await withWorkspace(async impl => {
      seed(impl, starter);
      impl.storage.chatAttachmentContent.delete(SOURCE_IDS[1]);
      await expect(draft(impl, starter)).rejects.toThrow("Chat attachment not found");
      // The first read really happened and stays audited. Missing data is not an empty success.
      expect([...impl.storage.actions.list()]).toMatchObject([
        { id: 0, type: "observation", state: "approved", gatekeeperId: SOURCE_GATEKEEPER,
          caller: { from: "agent", chatId: 1 }, description: {
            title: FIXTURES[starter.id].sources[0].title,
            description: `Read selected source: ${FIXTURES[starter.id].sources[0].url}`,
          } },
      ]);
      expect(impl.storage.nextActionId.get()).toBe(1);
      expect(impl.getProposedChanges(1)).toEqual([]);
      expect([...impl.storage.gadgets.list()]).toEqual([]);
      expect(impl.outputsSnapshot()).toEqual([]);
      expect(messages(impl).map(m => m.type)).toEqual(["message", "action"]);
      expect(messages(impl).at(-1)).toMatchObject({ type: "action", actionId: 0, author: OWNER });
      expect(messages(impl).at(-1)?.runId).toBeUndefined();
      expect(impl.consumeCapturedActions(1)).toBeUndefined();
      // mergeChanges intentionally returns merged for an empty proposal; that alone is NOT success.
      await impl.mergeChanges(1, { profile: OWNER }, "eval-owner-do");
      expect(impl.outputsSnapshot()).toEqual([]);
    });
  });

  it("denies foreign-chat reads and observations excluded for an authorized collaborator profile", async () => {
    await withWorkspace(async impl => {
      seed(impl, starter);
      await expect(readSource(impl, 1, OTHER_SOURCE_ID, {
        title: "Foreign source", description: "Must not be observed",
      })).rejects.toThrow("Chat attachment not found");
      const sharing = await impl.getSharingManager();
      sharing.addCollaborator({
        caller: { profileId: OWNER.id, isOwner: true }, profile: COLLABORATOR, role: "build",
      });
      impl.storage.observers.put({
        profileId: COLLABORATOR.id, observerId: "excluded-eval-observer", accountChoices: {},
      });
      await expect(draft(impl, starter, { excludeObservers: ["excluded-eval-observer"] }))
        .rejects.toThrow("current collaborator is not permitted to see");
      await expect(draft(impl, starter, { prohibitAllSharing: true }))
        .rejects.toThrow("workspace is shared");
      expect([...impl.storage.actions.list()]).toEqual([]);
      expect(impl.consumeCapturedActions(1)).toBeUndefined();
      expect(impl.storage.nextActionId.get()).toBe(0);
      expect(impl.outputsSnapshot()).toEqual([]);
      expect(impl.getProposedChanges(1)).toEqual([]);
      expect(messages(impl).map(m => m.type)).toEqual(["message"]);
    });
  });
});

it("isolates evidence, profiles, drafts and audit records across workspace DOs with overlapping IDs", async () => {
  let firstGadgetId: number;
  await withWorkspace(async impl => {
    seed(impl, WORKFLOW_STARTERS[0]);
    firstGadgetId = await draft(impl, WORKFLOW_STARTERS[0]);
  });
  await withWorkspace(async impl => {
    expect(impl.getChatAgentContext(1)).toEqual({ chatId: 1 });
    await expect(impl.getChatAttachmentData(1, SOURCE_IDS[0])).rejects.toThrow("not found");
    expect(() => impl.resolveWorkpieceRoot(firstGadgetId, true, 1)).toThrow("No such gadget");
    expect(messages(impl)).toEqual([]);
    expect([...impl.storage.actions.list()]).toEqual([]);
    seed(impl, WORKFLOW_STARTERS[2]);
    const secondGadgetId = await draft(impl, WORKFLOW_STARTERS[2]);
    expect(secondGadgetId).toBe(firstGadgetId); // IDs overlap, but storage must not.
    expect(impl.getChatAgentContext(1).agentId).toBe("project-update-1");
    const files = (await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(secondGadgetId)!;
    expect(files.get("document.md")).toContain("sample import parser");
    expect(files.get("document.md")).not.toContain("Prototype Birch");
    expect([...impl.storage.actions.list()].every(a => a.description.title.startsWith("Project Cedar")))
      .toBe(true);
  });
});

it("denies a use-only collaborator attempts to accept drafts or approve external writes", async () => {
  using client = new RpcStub(await openFakeOverseer({}, { role: "use" }));
  await expect(client.mergeChanges(1)).rejects.toThrow("Unauthorized");
  await expect(client.approveAction(0)).rejects.toThrow("Unauthorized");
});
