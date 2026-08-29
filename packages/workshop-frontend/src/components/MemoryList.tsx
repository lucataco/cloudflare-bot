import { useState, useEffect } from 'react'
import { useAuthenticatedApi } from '../AuthContext'
import { AgentMemoryNote, AgentProfile } from '@gadgets/workshop-shared/api'
import { Plus, Trash } from '@phosphor-icons/react'

export default function MemoryList({ agent }: { agent: AgentProfile }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [notes, setNotes] = useState<AgentMemoryNote[]>([])
  const [loading, setLoading] = useState(true)
  const [newFact, setNewFact] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const loadNotes = () => {
    authenticatedApi
      .listMemory(agent.id)
      .then((noteList: AgentMemoryNote[]) => {
        setNotes(noteList)
        setLoading(false)
      })
      .catch((err: unknown) => {
        console.error('Failed to load memory:', err)
        setLoading(false)
      })
  }

  useEffect(() => {
    loadNotes()
  }, [agent.id])

  const handleAddFact = async () => {
    if (!newFact.trim()) return
    try {
      await authenticatedApi.addMemory(agent.id, newFact.trim())
      setNewFact('')
      loadNotes()
    } catch (err) {
      console.error('Failed to add memory:', err)
    }
  }

  const handleDelete = async (note: AgentMemoryNote) => {
    if (!confirm(`Delete this memory?`)) return
    try {
      await authenticatedApi.deleteMemory(agent.id, note.id)
      loadNotes()
    } catch (err) {
      console.error('Failed to delete memory:', err)
    }
  }

  const handleStartEdit = (note: AgentMemoryNote) => {
    setEditingId(note.id)
    setEditText(note.fact)
  }

  const handleSaveEdit = async (noteId: string) => {
    if (!editText.trim()) return
    try {
      await authenticatedApi.updateMemory(agent.id, noteId, editText.trim())
      setEditingId(null)
      setEditText('')
      loadNotes()
    } catch (err) {
      console.error('Failed to update memory:', err)
    }
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditText('')
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
        <h2 className="text-lg font-semibold text-kumo-default">Memory Notes</h2>
      </div>

      <div className="mb-4 flex gap-2">
        <input
          type="text"
          value={newFact}
          onChange={(e) => setNewFact(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAddFact()
          }}
          placeholder="Add a new fact..."
          className="flex-1 px-3 py-2 border border-kumo-border rounded bg-kumo-surface text-kumo-default placeholder:text-kumo-subtle"
        />
        <button
          onClick={handleAddFact}
          disabled={!newFact.trim()}
          className="px-4 py-2 bg-kumo-brand text-white rounded hover:bg-kumo-brand-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          <Plus size={16} weight="bold" />
          Add
        </button>
      </div>

      {notes.length === 0 ? (
        <div className="text-center py-8 text-kumo-subtle">
          No memory notes yet. Add one to get started.
        </div>
      ) : (
        <div className="space-y-2">
          {notes.map((note) => (
            <div
              key={note.id}
              className="flex items-start justify-between gap-3 p-3 border border-kumo-border rounded bg-kumo-surface"
            >
              {editingId === note.id ? (
                <div className="flex-1">
                  <input
                    type="text"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveEdit(note.id)
                      if (e.key === 'Escape') handleCancelEdit()
                    }}
                    className="w-full px-2 py-1 border border-kumo-border rounded bg-kumo-surface text-kumo-default"
                    autoFocus
                  />
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => handleSaveEdit(note.id)}
                      className="px-3 py-1 text-sm bg-kumo-brand text-white rounded hover:bg-kumo-brand-hover"
                    >
                      Save
                    </button>
                    <button
                      onClick={handleCancelEdit}
                      className="px-3 py-1 text-sm border border-kumo-border rounded hover:bg-kumo-hover text-kumo-default"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex-1">
                    <p className="text-kumo-default">{note.fact}</p>
                    <p className="text-xs text-kumo-subtle mt-1">
                      {new Date(note.created).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleStartEdit(note)}
                      className="p-1 text-kumo-subtle hover:text-kumo-default"
                      title="Edit"
                    >
                      <span className="text-sm">Edit</span>
                    </button>
                    <button
                      onClick={() => handleDelete(note)}
                      className="p-1 text-kumo-subtle hover:text-red-500"
                      title="Delete"
                    >
                      <Trash size={16} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
