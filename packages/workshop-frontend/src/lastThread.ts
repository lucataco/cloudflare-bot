const STORAGE_KEY = 'gadgets:last-thread'

export type LastThread =
  | { kind: 'agent'; id: string }
  | { kind: 'group'; id: string }

export function readLastThread(): LastThread | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'kind' in parsed &&
      'id' in parsed &&
      typeof (parsed as LastThread).id === 'string' &&
      ((parsed as LastThread).kind === 'agent' || (parsed as LastThread).kind === 'group')
    ) {
      return parsed as LastThread
    }
    return null
  } catch {
    return null
  }
}

export function persistLastThread(thread: LastThread): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(thread))
  } catch {
    // private mode / sandboxed iframes
  }
}
