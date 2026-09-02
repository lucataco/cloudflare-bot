export const INSPECTOR_TABS = [
  'computer',
  'gadget',
  'files',
  'skills',
  'memory',
  'routines',
  'settings',
] as const

export type InspectorTab = (typeof INSPECTOR_TABS)[number]
export type MessengerInspector = 'none' | InspectorTab

export function isInspectorTab(value: unknown): value is InspectorTab {
  return typeof value === 'string' && (INSPECTOR_TABS as readonly string[]).includes(value)
}

export function inspectorStorageKey(botId: string): string {
  return `gadgets:inspector:${botId}`
}

export function readStoredInspector(botId: string): MessengerInspector {
  try {
    const stored = localStorage.getItem(inspectorStorageKey(botId))
    if (stored === 'none' || isInspectorTab(stored)) return stored
  } catch {
    // private mode
  }
  return 'none'
}

export function persistInspector(botId: string, inspector: MessengerInspector): void {
  try {
    localStorage.setItem(inspectorStorageKey(botId), inspector)
  } catch {
    // private mode
  }
}
