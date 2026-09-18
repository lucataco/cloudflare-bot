import { describe, expect, it } from 'vitest';
import { parseBotBlueprint } from '../src/bot-blueprint';

const bot = {name: 'Bot', title: 'Researcher', description: 'Research', skills: [], routines: [], pluginIds: []};
describe('untrusted bot archive data', () => {
  it('strips account authority, hook ids, history and unknown fields', () => {
    const parsed = parseBotBlueprint({...bot, defaultBindings: [123], workspaceId: 'private',
      skills: [{name: 'Skill', description: '', body: 'Useful', id: 'old'}],
      routines: [{name: 'Daily', prompt: 'Work', schedule: {kind: 'interval', everyMs: 60000}, hookId: 4, paused: false}]});
    expect(parsed).not.toHaveProperty('defaultBindings');
    expect(parsed).not.toHaveProperty('workspaceId');
    expect(parsed.routines[0]).not.toHaveProperty('hookId');
    expect(parsed.routines[0]).not.toHaveProperty('paused');
    expect(parsed.skills[0]).not.toHaveProperty('id');
  });
  it('rejects malformed schedules, unsafe avatars and oversized payloads', () => {
    expect(() => parseBotBlueprint({...bot, routines: [{name: 'A', prompt: 'B', schedule: {kind: 'interval', everyMs: 1}}]})).toThrow();
    expect(() => parseBotBlueprint({...bot, avatar: {url: 'javascript:alert(1)'}})).toThrow();
    expect(() => parseBotBlueprint({...bot, skills: Array.from({length: 3}, () => ({name: 'A', description: '', body: 'x'.repeat(30000)}))})).toThrow();
  });
  it('accepts trimmed starting prompts and bounds them', () => {
    expect(parseBotBlueprint({...bot, starters: ['  Plan my day  ']}).starters).toEqual(['Plan my day']);
    expect(parseBotBlueprint(bot).starters).toBeUndefined();
    expect(() => parseBotBlueprint({...bot, starters: Array.from({length: 21}, () => 'x')})).toThrow();
    expect(() => parseBotBlueprint({...bot, starters: ['x'.repeat(2001)]})).toThrow();
  });
});
