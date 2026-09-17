export const FIRST_BOT_SUGGESTIONS = [
  {
    name: 'Alex',
    title: 'App builder',
    description: 'Turns your ideas into working apps. Leads with the result and keeps progress updates brief.',
  },
  {
    name: 'Riley',
    title: 'Research assistant',
    description: 'Turns research into a short answer with sources. Keeps progress updates brief and calls out uncertainty.',
  },
  {
    name: 'Sam',
    title: 'Follow-up assistant',
    description: 'Runs recurring tasks and follows up on items that need attention. Reports what changed and what needs your approval.',
  },
] as const

/** A survey suggests roles only; selections never connect tools or grant account access. */
export const TOOL_SURVEY = [
  { id: 'github', label: 'GitHub', role: 0, reason: 'Build apps and investigate code.' },
  { id: 'linear', label: 'Linear', role: 2, reason: 'Follow up on issues and recurring work.' },
  { id: 'slack', label: 'Slack', role: 2, reason: 'Prepare updates and follow up on requests.' },
  { id: 'google', label: 'Google Workspace', role: 1, reason: 'Research and summarize documents.' },
  { id: 'notion', label: 'Notion', role: 1, reason: 'Turn your knowledge into sourced answers.' },
] as const

export function suggestedTeammates(toolIds: readonly string[]) {
  return FIRST_BOT_SUGGESTIONS.map((suggestion, index) => ({
    ...suggestion, index,
    matches: TOOL_SURVEY.filter(tool => tool.role === index && toolIds.includes(tool.id)),
  })).toSorted((a, b) => b.matches.length - a.matches.length || a.index - b.index)
}
