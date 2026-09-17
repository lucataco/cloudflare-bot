import { z } from "zod";
import type { BotBlueprintProfile } from "@gadgets/workshop-shared/api";

const text = z.string().max(32_000);
const name = z.string().trim().min(1).max(200);
const timeZone = z.string().max(100).refine(value => {
  try { return !!new Intl.DateTimeFormat("en", {timeZone: value}).resolvedOptions().timeZone; } catch { return false; }
});
const schedule = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("interval"), everyMs: z.number().int().min(60_000).max(Number.MAX_SAFE_INTEGER)}),
  z.object({kind: z.literal("calendar"), timeZone, freq: z.enum(["hourly", "daily", "weekly"]),
    interval: z.number().int().positive().optional(), byDay: z.array(z.enum(["SU", "MO", "TU", "WE", "TH", "FR", "SA"])).max(7).optional(),
    hour: z.number().int().min(0).max(23).optional(), minute: z.number().int().min(0).max(59)}),
  z.object({kind: z.literal("once"), fireAt: z.number().int().nonnegative(), timeZone}),
  z.object({kind: z.literal("slack"), channelId: name, matchKind: z.enum(["mention", "keyword", "message"]), keyword: text.optional()}),
  z.object({kind: z.literal("github"), owner: name, repo: name,
    events: z.array(z.enum(["pr-opened", "pr-merged", "pr-comment", "review-requested"])).max(4)}),
]);
/** Portable fields shared by Blueprint archives and declarative bot seeds. */
export const botBlueprintSchema = z.object({
  name, title: name, description: text,
  avatar: z.object({url: z.string().max(16_000).refine(value => {
    // Portable avatars cannot point at instance-local authenticated routes.
    try { return new URL(value).protocol === "https:"; } catch { return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value); }
  })}).optional(),
  skills: z.array(z.object({name, description: text, body: text})).max(100),
  routines: z.array(z.object({name, prompt: text, schedule})).max(100),
  pluginIds: z.array(z.string().min(1).max(200)).max(100),
});

/** Validate untrusted archive/KV data and strip all non-portable fields before installation. */
export function parseBotBlueprint(value: unknown): BotBlueprintProfile {
  const bot = botBlueprintSchema.parse(value);
  if (new TextEncoder().encode(JSON.stringify(bot)).byteLength > 56 * 1024) {
    throw new Error("Bot template exceeds the 56 KiB portable definition limit.");
  }
  return bot;
}
