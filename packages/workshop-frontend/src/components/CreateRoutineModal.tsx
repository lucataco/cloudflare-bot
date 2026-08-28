import { useState } from 'react'
import { useAuthenticatedApi } from '../AuthContext'
import { AgentProfile, AgentRoutineSchedule } from '@gadgets/workshop-shared/api'
import { X } from '@phosphor-icons/react'

export default function CreateRoutineModal({
  agent,
  onClose,
  onCreated,
}: {
  agent: AgentProfile
  onClose: () => void
  onCreated: () => void
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [scheduleKind, setScheduleKind] = useState<'interval' | 'calendar' | 'once'>('interval')
  const [intervalMinutes, setIntervalMinutes] = useState(60)
  const [calendarFreq, setCalendarFreq] = useState<'hourly' | 'daily' | 'weekly'>('daily')
  const [hour, setHour] = useState(9)
  const [minute, setMinute] = useState(0)
  const [timeZone, setTimeZone] = useState('America/New_York')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!name.trim()) {
      setError('Name is required')
      return
    }
    if (!prompt.trim()) {
      setError('Prompt is required')
      return
    }

    let schedule: AgentRoutineSchedule
    if (scheduleKind === 'interval') {
      schedule = {
        kind: 'interval',
        everyMs: intervalMinutes * 60 * 1000,
      }
    } else if (scheduleKind === 'calendar') {
      schedule = {
        kind: 'calendar',
        timeZone,
        freq: calendarFreq,
        minute,
        ...(calendarFreq !== 'hourly' ? { hour } : {}),
      }
    } else {
      const fireAt = Date.now() + 60 * 60 * 1000
      schedule = {
        kind: 'once',
        fireAt,
        timeZone,
      }
    }

    setCreating(true)
    try {
      await authenticatedApi.createRoutine(agent.id, name, prompt, schedule)
      onCreated()
    } catch (err) {
      console.error('Failed to create routine:', err)
      setError(err instanceof Error ? err.message : 'Failed to create routine')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-kumo-surface border border-kumo-border rounded-lg shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-kumo-border">
          <h2 className="text-lg font-semibold text-kumo-default">Create Routine</h2>
          <button
            onClick={onClose}
            className="p-1 text-kumo-subtle hover:text-kumo-default rounded"
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-kumo-default mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-kumo-surface border border-kumo-border rounded text-kumo-default"
              placeholder="Daily summary"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-kumo-default mb-1">
              Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full px-3 py-2 bg-kumo-surface border border-kumo-border rounded text-kumo-default min-h-[100px]"
              placeholder="Generate a summary of today's activities"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-kumo-default mb-1">
              Schedule Type
            </label>
            <select
              value={scheduleKind}
              onChange={(e) => setScheduleKind(e.target.value as 'interval' | 'calendar' | 'once')}
              className="w-full px-3 py-2 bg-kumo-surface border border-kumo-border rounded text-kumo-default"
            >
              <option value="interval">Interval (every N minutes)</option>
              <option value="calendar">Calendar (specific time)</option>
              <option value="once">Once (one-time)</option>
            </select>
          </div>

          {scheduleKind === 'interval' && (
            <div>
              <label className="block text-sm font-medium text-kumo-default mb-1">
                Interval (minutes)
              </label>
              <input
                type="number"
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-full px-3 py-2 bg-kumo-surface border border-kumo-border rounded text-kumo-default"
                min="1"
              />
            </div>
          )}

          {scheduleKind === 'calendar' && (
            <>
              <div>
                <label className="block text-sm font-medium text-kumo-default mb-1">
                  Frequency
                </label>
                <select
                  value={calendarFreq}
                  onChange={(e) => setCalendarFreq(e.target.value as 'hourly' | 'daily' | 'weekly')}
                  className="w-full px-3 py-2 bg-kumo-surface border border-kumo-border rounded text-kumo-default"
                >
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>

              {calendarFreq !== 'hourly' && (
                <div>
                  <label className="block text-sm font-medium text-kumo-default mb-1">
                    Hour (0-23)
                  </label>
                  <input
                    type="number"
                    value={hour}
                    onChange={(e) => setHour(Math.max(0, Math.min(23, parseInt(e.target.value) || 0)))}
                    className="w-full px-3 py-2 bg-kumo-surface border border-kumo-border rounded text-kumo-default"
                    min="0"
                    max="23"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-kumo-default mb-1">
                  Minute (0-59)
                </label>
                <input
                  type="number"
                  value={minute}
                  onChange={(e) => setMinute(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                  className="w-full px-3 py-2 bg-kumo-surface border border-kumo-border rounded text-kumo-default"
                  min="0"
                  max="59"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-kumo-default mb-1">
                  Timezone
                </label>
                <input
                  type="text"
                  value={timeZone}
                  onChange={(e) => setTimeZone(e.target.value)}
                  className="w-full px-3 py-2 bg-kumo-surface border border-kumo-border rounded text-kumo-default"
                  placeholder="America/New_York"
                />
              </div>
            </>
          )}

          {error && (
            <div className="text-sm text-kumo-danger-default bg-kumo-danger-surface p-2 rounded">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-kumo-default bg-kumo-surface-hover border border-kumo-border rounded hover:bg-kumo-border"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 text-sm font-medium text-kumo-on-brand bg-kumo-brand rounded hover:opacity-90 disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create Routine'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
