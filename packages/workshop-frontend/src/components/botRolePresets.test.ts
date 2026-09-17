import { describe, expect, it } from 'vitest'
import { suggestedTeammates } from './botRolePresets'

describe('tool survey', () => {
  it('suggests roles matching selected tools and preserves all starter options', () => {
    expect(suggestedTeammates(['slack', 'linear'])[0].title).toBe('Follow-up assistant')
    expect(suggestedTeammates(['google', 'notion'])[0].title).toBe('Research assistant')
    expect(suggestedTeammates(['github'])[0].title).toBe('App builder')
    expect(suggestedTeammates([])).toHaveLength(3)
    expect(suggestedTeammates(['unknown'])).toEqual(suggestedTeammates([]))
  })
})
