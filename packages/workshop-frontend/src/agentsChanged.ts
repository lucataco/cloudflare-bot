export const AGENTS_CHANGED_EVENT = 'gadgets:agents-changed'

export function notifyAgentsChanged() {
  window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT))
}
