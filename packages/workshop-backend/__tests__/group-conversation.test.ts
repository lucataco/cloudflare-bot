import { expect, it } from 'vitest';
import type { AgentProfile } from '@gadgets/workshop-shared/api';
import { groupRecipients, groupPrompt } from '../src/group-conversation';

const members: AgentProfile[] = ['Alice', 'Bob'].map((name, index) => ({ id: `bot-${index}`, name, title: name, description: '',
  workspaceId: 'private', defaultModelId: null, created: new Date(0), updated: new Date(0) }));
it('resolves named members and @everyone without interpreting regex characters in names', () => {
  expect(groupRecipients('@everyone review this', members)).toEqual(members);
  expect(groupRecipients('@Alice review this', members)).toEqual([members[0]]);
  expect(groupRecipients('@bot-1 review this', members)).toEqual([members[1]]);
  expect(groupRecipients('Review this', members)).toEqual(members);
  expect(groupRecipients('@A.* review', [{ ...members[0], name: 'A.*' }, members[1]])).toHaveLength(1);
});
it('bounds shared text and excludes reasoning from a group snapshot', () => {
  const text = groupPrompt([{ type: 'message', message: 'shared '.repeat(10_000), reasoning: 'PRIVATE_REASONING',
    author: { type: 'agent', id: 'model', name: 'Alice' }, chatId: 1, sequence: 0, timestamp: new Date() }]);
  expect(text).not.toContain('PRIVATE_REASONING');
  expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(12 * 1024 + 3);
});
