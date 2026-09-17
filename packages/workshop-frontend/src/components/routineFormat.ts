import type { AgentRoutineSchedule } from '@gadgets/workshop-shared/api'

export const ROUTINE_WEEKDAYS = [
  ['MO', 'Monday'], ['TU', 'Tuesday'], ['WE', 'Wednesday'], ['TH', 'Thursday'],
  ['FR', 'Friday'], ['SA', 'Saturday'], ['SU', 'Sunday'],
] as const

export function formatRoutineSchedule(schedule: AgentRoutineSchedule): string {
  switch (schedule.kind) {
    case 'interval': {
      let remaining = schedule.everyMs
      const parts: string[] = []
      for (const [unit, ms] of [['day', 86400000], ['hour', 3600000], ['minute', 60000], ['second', 1000], ['millisecond', 1]] as const) {
        const count = Math.floor(remaining / ms)
        if (count) parts.push(`${count} ${unit}${count === 1 ? '' : 's'}`)
        remaining %= ms
      }
      return `Every ${parts.join(' ') || '0 milliseconds'}`
    }
    case 'calendar': {
      const interval = schedule.interval ?? 1
      const unit = schedule.freq === 'hourly' ? 'hour' : schedule.freq === 'daily' ? 'day' : 'week'
      const frequency = interval === 1
        ? { hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly' }[schedule.freq]
        : `Every ${interval} ${unit}s`
      const days = schedule.freq === 'weekly'
        ? ` on ${ROUTINE_WEEKDAYS.filter(([day]) => schedule.byDay?.includes(day)).map(([, label]) => label).join(', ') || 'no weekdays selected'}`
        : ''
      const minute = String(schedule.minute).padStart(2, '0')
      const time = schedule.freq === 'hourly' ? `minute ${minute}` : `${String(schedule.hour ?? 0).padStart(2, '0')}:${minute}`
      return `${frequency}${days} at ${time} (${schedule.timeZone})`
    }
    case 'once': {
      if (!Number.isFinite(schedule.fireAt)) return 'Choose a date and time'
      try {
        return `Once on ${new Date(schedule.fireAt).toLocaleString(undefined, { timeZone: schedule.timeZone })} (${schedule.timeZone})`
      } catch {
        return `Once at ${schedule.fireAt} (${schedule.timeZone})`
      }
    }
    case 'slack':
      return `Slack: ${schedule.matchKind === 'keyword' ? `keyword "${schedule.keyword ?? ''}"` : schedule.matchKind === 'mention' ? 'bot mention' : 'any message'} in ${schedule.channelId}`
    case 'github':
      return `GitHub: ${schedule.owner}/${schedule.repo} - ${schedule.events.join(', ')}`
  }
}
