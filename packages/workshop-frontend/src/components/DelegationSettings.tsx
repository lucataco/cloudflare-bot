import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { AgentProfile, AuthenticatedApi, NamedDelegationConfig, NamedDelegationTargetConfig, Overseer } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './WorkshopControls'

export default function DelegationSettings({ authenticatedApi, overseer, workspaceId, sourceAgentId, isOwner }: {
  authenticatedApi: Pick<AuthenticatedApi, 'listAgents'>
  overseer: Pick<Overseer, 'getNamedDelegationConfig' | 'setNamedDelegationConfig'>
  workspaceId: string
  sourceAgentId: string
  isOwner: boolean
}) {
  const id = useId()
  const fresh = {
    source: { authenticatedApi, overseer, workspaceId, sourceAgentId, isOwner },
    open: false, config: null as NamedDelegationConfig | null,
    targets: [] as NamedDelegationTargetConfig[], agents: [] as AgentProfile[],
    busy: false, error: null as string | null, saved: false,
  }
  let [form, setForm] = useState(fresh)
  if (form.source.authenticatedApi !== authenticatedApi || form.source.overseer !== overseer ||
      form.source.workspaceId !== workspaceId || form.source.sourceAgentId !== sourceAgentId || form.source.isOwner !== isOwner) {
    form = fresh
    setForm(fresh)
  }
  const request = useRef<object | null>(null)
  useLayoutEffect(() => () => { request.current = null }, [form.source])

  async function readOrSave(save: boolean) {
    if (!isOwner || request.current || (save && !form.config)) return
    const token = {}
    request.current = token
    setForm(previous => ({ ...previous, busy: true, error: null, saved: false }))
    try {
      const [config, agents] = save
        ? [await overseer.setNamedDelegationConfig(form.targets, form.config!.revision), form.agents]
        : await Promise.all([overseer.getNamedDelegationConfig(), authenticatedApi.listAgents()])
      if (request.current !== token) return
      setForm(previous => ({ ...previous, config, targets: config.targets, agents, saved: save }))
    } catch {
      if (request.current !== token) return
      setForm(previous => ({ ...previous, error: save
        ? 'Save was not confirmed. Your draft is preserved. The revision may have changed; Reload to review current settings before saving again.'
        : 'Could not load delegation settings. This does not mean no targets are configured. Any displayed draft is unchanged.' }))
    } finally {
      if (request.current === token) {
        request.current = null
        setForm(previous => ({ ...previous, busy: false }))
      }
    }
  }

  if (!isOwner) return null
  const changeTargets = (targets: NamedDelegationTargetConfig[]) => setForm(previous => ({ ...previous, targets, saved: false }))
  const options = form.agents.filter(agent => agent.id !== sourceAgentId)
  return <section aria-label="Named delegation" className="min-w-0 border-t border-kumo-line pt-3 text-sm">
    <button type="button" className="cursor-pointer font-medium" aria-expanded={form.open} aria-controls={id}
      onClick={() => setForm(previous => ({ ...previous, open: !previous.open }))}>Advanced: Named delegation</button>
    {form.open && <div id={id} className="mt-3 min-w-0 space-y-3">
      <p className="text-xs leading-5 text-kumo-subtle">Only the owner can configure delegation from this bot's workspace. Choosing a target grants only its instructions and model. The child receives only task text and selected source-workspace resources, not the target's private browser, memory, skills, accounts, or history. Resources default to none.</p>
      <p className="text-xs leading-5 text-kumo-subtle">One level of delegation, up to four children per logical task. At most eight targets and eight resource bindings per target. Saving does not start a task. Stopping the parent cancels its children; already dispatched effects are not rolled back.</p>
      <WorkshopButton type="button" disabled={form.busy} onClick={() => { void readOrSave(false) }}>
        {form.config ? 'Reload delegation settings' : 'Load delegation settings'}
      </WorkshopButton>
      {form.config && <p className="text-xs text-kumo-subtle">Revision {form.config.revision}. Reload replaces the draft with saved settings.</p>}
      {form.busy && <p role="status">Loading or saving delegation settings...</p>}
      {form.error && <p role="alert" className="text-kumo-danger">{form.error}</p>}
      {form.saved && <p role="status">Delegation settings saved.</p>}
      {form.config && <fieldset disabled={form.busy} className="min-w-0 space-y-3">
        <legend className="mb-2 font-medium">Configured targets ({form.targets.length}/8)</legend>
        {form.targets.length === 0 && <p>No targets configured.</p>}
        {form.targets.map(target => {
          const bindings = Object.entries(target.bindings)
          const resources = [...form.config!.resources]
          for (const [, resourceId] of bindings) {
            if (!resources.some(resource => resource.id === resourceId)) resources.push({ id: resourceId, title: `Unavailable resource #${resourceId}` })
          }
          return <fieldset key={target.targetAgentId} className="min-w-0 space-y-2 rounded-lg border border-kumo-line p-3">
            <legend className="break-words px-1">{options.find(agent => agent.id === target.targetAgentId)?.name ?? `Unavailable bot (${target.targetAgentId})`}</legend>
            <WorkshopButton type="button" onClick={() => changeTargets(form.targets.filter(item => item !== target))}>Remove target</WorkshopButton>
            <p className="text-xs text-kumo-subtle">{bindings.length === 0 ? 'No resources selected.' : `${bindings.length}/8 resource bindings selected.`}</p>
            {resources.map(resource => {
              const names = bindings.filter(([, resourceId]) => resourceId === resource.id).map(([name]) => name)
              return <label key={resource.id} className="flex min-w-0 items-start gap-2 text-xs leading-5">
                <input type="checkbox" className="mt-1 shrink-0" checked={names.length > 0}
                  disabled={names.length === 0 && bindings.length >= 8}
                  onChange={event => {
                    const next = { ...target.bindings }
                    if (event.target.checked) {
                      let name = `RESOURCE_${resource.id}`
                      for (let suffix = 2; name in next; suffix++) name = `RESOURCE_${resource.id}_${suffix}`
                      next[name] = resource.id
                    } else {
                      for (const name of names) delete next[name]
                    }
                    changeTargets(form.targets.map(item => item === target ? { ...item, bindings: next } : item))
                  }} />
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">{resource.title}{names.length > 0 && <span className="block font-mono text-kumo-subtle">{names.join(', ')}</span>}</span>
              </label>
            })}
          </fieldset>
        })}
        <label className="flex flex-col gap-1 text-xs">Add target (no resources granted)
          <select className="w-full min-w-0 rounded-md border border-kumo-line bg-kumo-base p-2 text-sm" value=""
            disabled={form.targets.length >= 8} onChange={event => {
              if (event.target.value && form.targets.length < 8) changeTargets([...form.targets, { targetAgentId: event.target.value, bindings: {} }])
            }}>
            <option value="">Choose a bot</option>
            {options.filter(agent => !form.targets.some(target => target.targetAgentId === agent.id)).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <WorkshopButton type="button" onClick={() => { void readOrSave(true) }}>Save delegation settings</WorkshopButton>
      </fieldset>}
    </div>}
  </section>
}
