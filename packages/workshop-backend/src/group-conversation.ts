import type { AgentProfile, AiChatMessage } from '@gadgets/workshop-shared/api';

/** Maximum group membership. */
export const MAX_GROUP_MEMBERS = 6;
/** Lifetime executions per prompt, including initial authors and asynchronous handoffs. */
export const MAX_GROUP_EXECUTIONS = 12;

/** Explicit mentions select recipients; an unaddressed message or @everyone addresses the group. */
export function groupRecipients(text: string, members: AgentProfile[]): AgentProfile[] {
  if (/(^|\s)@everyone(?=$|\s|[,.!?])/i.test(text)) return members;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const selected = members.filter(member => new RegExp(`(^|\\s)@(?:${escape(member.name)}|${escape(member.id)})(?=$|\\s|[,.!?])`, 'i').test(text));
  return selected.length ? selected : members;
}

/** Bounded shared text without private bot history, reasoning or tool results. */
export function groupPrompt(messages: AiChatMessage[]): string {
  const text = messages.filter(message => message.type === 'message').slice(-30).map(message => {
    if (message.type !== 'message') return '';
    return `${message.author.name}: ${message.message.slice(0, 4000)}`;
  }).join('\n\n').slice(-24_000);
  return new TextDecoder().decode(new TextEncoder().encode(text).slice(-12 * 1024));
}
