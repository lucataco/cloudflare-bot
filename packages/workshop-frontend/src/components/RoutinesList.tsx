import { useState, useEffect } from 'react'
import { useAuthenticatedApi } from '../AuthContext'
import { AgentRoutine, AgentProfile } from '@gadgets/workshop-shared/api'
import { Plus, Pause, Play, Trash, Clock } from '@phosphor-icons/react'
import CreateRoutineModal from './CreateRoutineModal'

export default function RoutinesList({ agent }: { agent: AgentProfile }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [routines, setRoutines] = useState<AgentRoutine[]>([])
  const [loading, setLoading] = useState(true)
  const [createModalVisible, setCreateModalVisible] = useState(false)

  const loadRoutines = () => {
    authenticatedApi
      .listRoutines(agent.id)
      .then((routineList: AgentRoutine[]) => {
        setRoutines(routineList)
        setLoading(false)
      })
      .catch((err: unknown) => {
        console.error('Failed to load routines:', err)
        setLoading(false)
      })
  }

  useEffect(() => {
    loadRoutines()
  }, [agent.id])

  const handleTogglePause = async (routine: AgentRoutine) => {
    try {
      await authenticatedApi.updateRoutine(agent.id, routine.id, {
        paused: !routine.paused,
      })
      loadRoutines()
    } catch (err) {
      console.error('Failed to toggle routine:', err)
    }
  }

  const handleDelete = async (routine: AgentRoutine) => {
    if (!confirm(`Delete routine "${routine.name}"?`)) return
    try {
      await authenticatedApi.deleteRoutine(agent.id, routine.id)
      loadRoutines()
    } catch (err) {
      console.error('Failed to delete routine:', err)
    }
  }

  const handleRoutineCreated = () => {
    setCreateModalVisible(false)
    loadRoutines()
  }

  const formatSchedule = (routine: AgentRoutine): string => {
    const { schedule } = routine
    if (schedule.kind === 'interval') {
      const minutes = Math.floor(schedule.everyMs / 60000)
      const hours = Math.floor(minutes / 60)
      const days = Math.floor(hours / 24)
      if (days > 0) return `Every ${days} day${days > 1 ? 's' : ''}`
      if (hours > 0) return `Every ${hours} hour${hours > 1 ? 's' : ''}`
      return `Every ${minutes} minute${minutes > 1 ? 's' : ''}`
    }
    if (schedule.kind === 'calendar') {
      const { freq, hour, minute } = schedule
      const time = hour !== undefined ? `${hour}:${minute.toString().padStart(2, '0')}` : `:${minute.toString().padStart(2, '0')}`
      if (freq === 'hourly') return `Hourly at ${time}`
      if (freq === 'daily') return `Daily at ${time}`
      if (freq === 'weekly') return `Weekly at ${time}`
    }
    if (schedule.kind === 'once') {
      return `Once at ${new Date(schedule.fireAt).toLocaleString()}`
    }
    if (schedule.kind === 'slack') {
      let trigger = 'Slack: '
      if (schedule.matchKind === 'mention') trigger += 'mention'
      else if (schedule.matchKind === 'keyword') trigger += `keyword "${schedule.keyword}"`
      else trigger += 'any message'
      return `${trigger} in ${schedule.channelId}`
    }
    if (schedule.kind === 'github') {
      return `GitHub: ${schedule.owner}/${schedule.repo} - ${schedule.events.join(', ')}`
    }
    return 'Unknown schedule'
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="w-6 h-6 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-kumo-default">Routines</h2>
        <button
          onClick={() => setCreateModalVisible(true)}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-kumo-on-brand bg-kumo-brand rounded hover:opacity-90"
        >
          <Plus size={16} weight="bold" />
          Create Routine
        </button>
      </div>

      {routines.length === 0 ? (
        <div className="text-center py-8 text-kumo-subtle">
          <Clock size={48} className="mx-auto mb-2 opacity-50" />
          <p>No routines yet</p>
          <p className="text-sm mt-1">Create a routine to run tasks on a schedule</p>
        </div>
      ) : (
        <div className="space-y-2">
          {routines.map((routine) => (
            <div
              key={routine.id}
              className="flex items-center gap-3 p-3 border border-kumo-border rounded hover:bg-kumo-surface-hover"
            >
              <div className="flex-1">
                <div className="font-medium text-kumo-default">{routine.name}</div>
                <div className="text-sm text-kumo-subtle mt-0.5">{formatSchedule(routine)}</div>
                <div className="text-sm text-kumo-subtle mt-1 line-clamp-1">{routine.prompt}</div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleTogglePause(routine)}
                  className="p-2 text-kumo-subtle hover:text-kumo-default hover:bg-kumo-surface-hover rounded"
                  title={routine.paused ? 'Resume' : 'Pause'}
                >
                  {routine.paused ? <Play size={18} weight="fill" /> : <Pause size={18} weight="fill" />}
                </button>
                <button
                  onClick={() => handleDelete(routine)}
                  className="p-2 text-kumo-subtle hover:text-kumo-danger-default hover:bg-kumo-surface-hover rounded"
                  title="Delete"
                >
                  <Trash size={18} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {createModalVisible && (
        <CreateRoutineModal
          agent={agent}
          onClose={() => setCreateModalVisible(false)}
          onCreated={handleRoutineCreated}
        />
      )}
    </div>
  )
}
