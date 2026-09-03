import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Button, Input, Textarea, Select, useKumoToastManager } from '@cloudflare/kumo'
import type { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import { notifyAgentsChanged } from '../agentsChanged'
import { persistLastThread } from '../lastThread'
import { logRpcFailure } from '../rpcErrors'

export const FIRST_BOT_SUGGESTIONS = [
  {
    name: 'Alex',
    title: 'Builder',
    description: 'Turns prompts into working gadgets and iterates until they ship.',
  },
  {
    name: 'Riley',
    title: 'Researcher',
    description: 'Reads, summarizes, and keeps a trail of sources.',
  },
  {
    name: 'Sam',
    title: 'Operator',
    description: 'Runs routines, watches inboxes, and follows up without being asked.',
  },
] as const

export default function FirstBotSetup({
  onCreated,
}: {
  onCreated: (agentId: string) => void
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [custom, setCustom] = useState(false)
  const [name, setName] = useState<string>(FIRST_BOT_SUGGESTIONS[0].name)
  const [title, setTitle] = useState<string>(FIRST_BOT_SUGGESTIONS[0].title)
  const [description, setDescription] = useState<string>(FIRST_BOT_SUGGESTIONS[0].description)
  const [defaultModelId, setDefaultModelId] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.listModels()
      .then((list: AiChatAuthorInfo[]) => {
        if (cancelled) return
        setModels(list)
        setDefaultModelId((current) => current || list[0]?.id || '')
      })
      .catch((err: unknown) => {
        logRpcFailure('Failed to load models:', err)
      })
    return () => { cancelled = true }
  }, [authenticatedApi])

  const applySuggestion = (index: number) => {
    const suggestion = FIRST_BOT_SUGGESTIONS[index]
    setSelectedIndex(index)
    setCustom(false)
    setName(suggestion.name)
    setTitle(suggestion.title)
    setDescription(suggestion.description)
  }

  const startCustom = () => {
    setCustom(true)
    setSelectedIndex(-1)
    setName('')
    setTitle('')
    setDescription('')
  }

  const handleCreate = async () => {
    if (!name.trim() || !title.trim()) return
    setSubmitting(true)
    try {
      const agent = await authenticatedApi.createAgent(
        name.trim(),
        title.trim(),
        description.trim(),
        defaultModelId || null,
      )
      persistLastThread({ kind: 'agent', id: agent.id })
      notifyAgentsChanged()
      onCreated(agent.id)
    } catch (err) {
      logRpcFailure('Failed to create agent:', err)
      toasts.add({
        title: 'Could not create bot',
        description: err instanceof Error ? err.message : 'An error occurred',
        variant: 'error',
      })
    } finally {
      setSubmitting(false)
    }
  }

  const modelOptions = [
    { value: '', label: 'Human only (no AI)' },
    ...models.map((model) => ({ value: model.id, label: model.name })),
  ]

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-lg">
        <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.4px] text-kumo-default">
          Create your first bot
        </h1>
        <p className="mt-2 text-[13px] leading-[18px] text-kumo-subtle">
          A bot is a persistent teammate — not a chat session. Pick a role or name your own.
        </p>

        <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {FIRST_BOT_SUGGESTIONS.map((suggestion, index) => {
            const selected = !custom && selectedIndex === index
            return (
              <button
                key={suggestion.title}
                type="button"
                onClick={() => applySuggestion(index)}
                className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                  selected
                    ? 'border-kumo-brand bg-kumo-brand/10'
                    : 'border-kumo-line hover:bg-kumo-tint'
                }`}
              >
                <p className="text-[13px] font-medium text-kumo-default">{suggestion.name}</p>
                <p className="mt-0.5 text-[12px] text-kumo-subtle">{suggestion.title}</p>
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={startCustom}
          className={`mt-2 w-full rounded-xl border px-3 py-2.5 text-left text-[13px] transition-colors ${
            custom
              ? 'border-kumo-brand bg-kumo-brand/10 text-kumo-default'
              : 'border-kumo-line text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'
          }`}
        >
          Custom bot
        </button>

        <div className="mt-6 flex flex-col gap-3">
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Alex"
          />
          <Input
            label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Builder"
          />
          <Textarea
            aria-label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="What this bot is for"
          />
          {models.length === 0 ? (
            <div className="flex flex-col gap-2 rounded-xl border border-dashed border-kumo-line px-3 py-3">
              <p className="text-[12px] font-medium text-kumo-default">Default model</p>
              <p className="text-[12px] text-kumo-subtle">
                No models yet. You can create this bot without AI, then add a model later.
              </p>
              <Link
                to="/providers"
                className="text-[12px] font-medium text-kumo-brand hover:underline"
              >
                Add a model
              </Link>
            </div>
          ) : (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-kumo-default">Default model</span>
              <Select
                className="w-full text-sm"
                placeholder="Select a model"
                value={defaultModelId}
                onValueChange={(value) => setDefaultModelId(value ?? '')}
                renderValue={(id) => modelOptions.find((opt) => opt.value === id)?.label || 'Select a model'}
              >
                {modelOptions.map((option) => (
                  <Select.Option key={option.value || 'human'} value={option.value}>
                    {option.label}
                  </Select.Option>
                ))}
              </Select>
            </label>
          )}
        </div>

        <Button
          className="mt-6 w-full"
          disabled={submitting || !name.trim() || !title.trim()}
          onClick={() => { void handleCreate() }}
        >
          {submitting ? 'Creating…' : models.length === 0 ? 'Create bot without AI' : 'Create bot'}
        </Button>
      </div>
    </div>
  )
}
