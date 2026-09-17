/**
 * Editable starting points for complete knowledge-work tasks. Selecting a starter only seeds a
 * draft message; it does not connect accounts, grant capabilities, send messages, or enable a schedule.
 */
export const WORKFLOW_STARTERS = [
  {
    id: 'meeting-brief',
    title: 'Prepare a meeting brief',
    description: 'A source-linked brief with an agenda, open questions, and decisions to make.',
    prompt: 'Help me prepare for a meeting. First ask which meeting and which documents or connected resources I want you to use. Read only those selected sources. Create a brief with the purpose, relevant background, a proposed agenda, open questions, and decisions to make. Link each factual claim to its source, separate suggestions from facts, and flag missing information rather than guessing. Save the brief as a document and give me a short summary with a link to open it. Do not send invitations or messages.',
  },
  {
    id: 'feedback-summary',
    title: 'Summarize customer feedback',
    description: 'Recurring themes, evidence, and clearly counted feedback for a chosen period.',
    prompt: 'Help me summarize customer feedback. First ask which sources and date range I want you to use. Read only the selected resources. Group feedback into themes, count the items supporting each theme, and include source links and representative examples. Distinguish requests, bugs, and positive feedback; explain deduplication and any gaps in the data. Create a document with a summary table and suggested next steps. Suggestions are not actions: do not create tickets, contact customers, or change external records without a separate request and the required approval.',
  },
  {
    id: 'project-update',
    title: 'Draft a weekly project update',
    description: 'A concise update covering progress, blockers, next steps, and missing information.',
    prompt: 'Help me draft a weekly project update. First ask which project, reporting period, audience, and sources I want you to use. Read only those selected resources. Create a document covering completed work, current work, blockers, and next steps, with source links and clearly marked uncertainty. Do not describe planned work as completed. Give me a short summary and a link to review the draft. Do not send the update or enable a recurring schedule until I explicitly ask and confirm it.',
  },
] as const;

/** A starter's stable identity and user-visible task description. */
export type WorkflowStarter = typeof WORKFLOW_STARTERS[number];
