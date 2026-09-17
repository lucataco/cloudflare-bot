import { parseDocument } from "yaml";
import { z } from "zod";
import { botBlueprintSchema, parseBotBlueprint } from "./bot-blueprint";

const seed = botBlueprintSchema.extend({
  key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  modelId: z.string().min(1).max(200).nullable().optional(),
  skills: botBlueprintSchema.shape.skills.default([]),
  routines: botBlueprintSchema.shape.routines.default([]),
  pluginIds: botBlueprintSchema.shape.pluginIds.default([]),
}).strict();
const manifest = z.object({version: z.literal(1), agents: z.array(seed).min(1).max(32)}).strict();

/** Parse a bounded YAML document without aliases, credentials, resource grants or executable tags. */
export function parseAgentSeeds(yaml: string) {
  if (new TextEncoder().encode(yaml).byteLength > 64 * 1024) {
    throw new Error("agents.yaml exceeds 64 KiB.");
  }
  const document = parseDocument(yaml, {schema: "core", uniqueKeys: true});
  if (document.errors.length || document.warnings.length) throw new Error("Invalid agents.yaml document.");
  const {agents} = manifest.parse(document.toJS({maxAliasCount: 0}));
  if (new Set(agents.map(agent => agent.key)).size !== agents.length) {
    throw new Error("Each agent seed must have a unique key.");
  }
  return agents.map(({key, modelId, ...bot}) => ({key, modelId: modelId ?? null, bot: parseBotBlueprint(bot)}));
}
