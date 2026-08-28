# Routines Implementation TODO

This is a first-cut implementation of agent routines. The following items remain to complete the feature:

## Completed
- ✅ Data model (AgentRoutine, AgentRoutineSchedule types)
- ✅ Storage layer (RoutineRecord in typed-storage)
- ✅ Backend CRUD API (listRoutines, createRoutine, updateRoutine, deleteRoutine)
- ✅ Type checking passes

## TODO

### Scheduler Integration
The routines need to be registered with the gatekeeper-scheduler to actually fire on schedule:

1. When a routine is created or updated to paused: false:
   - Access the SCHEDULER ambient gatekeeper from the workspace
   - Register the callback using `ctx.restore()` with appropriate schedule (every/calendarAt/runAt)
   - Store the returned scheduleId in the routine record
   - The registration creates a disabled hook

2. Hook enablement:
   - The user must enable the hook in the Connections UI (existing Workshop functionality)
   - OR implement an in-tree way to auto-enable hooks when paused: false
   - See packages/gatekeeper-scheduler/README.md for details

3. Callback implementation:
   - Implement a [restore] handler in OverseerDurableObject for routine callbacks
   - The callback should call newChat() or sendChatMessage() with the routine prompt
   - Use the agent's workspace ID and model from the AgentProfile
   - Record as an observation in the agent's chat

### Frontend UI
Add UI for managing routines in an agent's workspace:

1. Routines list view showing all routines for the current agent
2. Create routine form with:
   - Name input
   - Prompt textarea
   - Schedule selector (interval/calendar/once)
   - Timezone picker for calendar/once schedules
3. Edit routine dialog
4. Pause/resume toggle
5. Delete confirmation
6. Integrate with agentShell feature flag

### Integration Points
- Wire up scheduler registration in updateRoutine when paused changes
- Add Overseer method to handle routine firing
- Test end-to-end: create routine → enable → fire → message appears in agent workspace

### Testing
- Verify paused routines don't fire
- Verify timezone handling for calendar schedules
- Verify routine only fires for its own agent, not others
- Verify routines survive workspace restart (persistent callbacks)
