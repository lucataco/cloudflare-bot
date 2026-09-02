import { afterEach, describe, expect, it, vi } from 'vitest'
import { persistLastThread, readLastThread } from './lastThread'

const store = new Map<string, string>()

vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value) },
  clear: () => { store.clear() },
})

describe('lastThread', () => {
  afterEach(() => {
    store.clear()
  })

  it('round-trips an agent thread', () => {
    persistLastThread({ kind: 'agent', id: 'bot-1' })
    expect(readLastThread()).toEqual({ kind: 'agent', id: 'bot-1' })
  })

  it('returns null for missing or invalid storage', () => {
    expect(readLastThread()).toBeNull()
    store.set('gadgets:last-thread', '{')
    expect(readLastThread()).toBeNull()
  })
})
