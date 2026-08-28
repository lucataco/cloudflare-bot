import { useState, useEffect } from 'react'
import { useAuthenticatedApi } from '../AuthContext'
import { AgentSkill, AgentProfile } from '@gadgets/workshop-shared/api'
import { Plus, Trash, Book } from '@phosphor-icons/react'
import CreateSkillModal from './CreateSkillModal'

export default function SkillsList({ agent }: { agent: AgentProfile }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [createModalVisible, setCreateModalVisible] = useState(false)
  const [editingSkill, setEditingSkill] = useState<AgentSkill | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editBody, setEditBody] = useState('')

  const loadSkills = () => {
    authenticatedApi
      .listSkills(agent.id)
      .then((skillList: AgentSkill[]) => {
        setSkills(skillList)
        setLoading(false)
      })
      .catch((err: unknown) => {
        console.error('Failed to load skills:', err)
        setLoading(false)
      })
  }

  useEffect(() => {
    loadSkills()
  }, [agent.id])

  const handleDelete = async (skill: AgentSkill) => {
    if (!confirm(`Delete skill "${skill.name}"?`)) return
    try {
      await authenticatedApi.deleteSkill(agent.id, skill.id)
      loadSkills()
    } catch (err) {
      console.error('Failed to delete skill:', err)
    }
  }

  const handleEdit = (skill: AgentSkill) => {
    setEditingSkill(skill)
    setEditName(skill.name)
    setEditDescription(skill.description)
    setEditBody(skill.body)
  }

  const handleSaveEdit = async () => {
    if (!editingSkill) return
    try {
      await authenticatedApi.updateSkill(agent.id, editingSkill.id, {
        name: editName,
        description: editDescription,
        body: editBody,
      })
      setEditingSkill(null)
      loadSkills()
    } catch (err) {
      console.error('Failed to update skill:', err)
    }
  }

  const handleSkillCreated = () => {
    setCreateModalVisible(false)
    loadSkills()
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
        <h2 className="text-lg font-semibold text-kumo-default">Skills</h2>
        <button
          onClick={() => setCreateModalVisible(true)}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-kumo-on-brand bg-kumo-brand rounded hover:opacity-90"
        >
          <Plus size={16} weight="bold" />
          Create Skill
        </button>
      </div>

      {skills.length === 0 ? (
        <div className="text-center py-8 text-kumo-subtle">
          <Book size={48} className="mx-auto mb-2 opacity-50" />
          <p>No skills yet</p>
          <p className="text-sm mt-1">Create a skill to add reusable recipes</p>
        </div>
      ) : (
        <div className="space-y-2">
          {skills.map((skill) => (
            <div
              key={skill.id}
              className="p-3 border border-kumo-border rounded hover:bg-kumo-surface-hover"
            >
              {editingSkill?.id === skill.id ? (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-kumo-subtle mb-1">Name</label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full px-2 py-1 text-sm bg-kumo-surface border border-kumo-border rounded text-kumo-default"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-kumo-subtle mb-1">Description</label>
                    <textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      className="w-full px-2 py-1 text-sm bg-kumo-surface border border-kumo-border rounded text-kumo-default min-h-[50px]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-kumo-subtle mb-1">Body</label>
                    <textarea
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      className="w-full px-2 py-1 text-sm bg-kumo-surface border border-kumo-border rounded text-kumo-default min-h-[150px] font-mono"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setEditingSkill(null)}
                      className="px-3 py-1 text-sm text-kumo-default bg-kumo-surface-hover border border-kumo-border rounded hover:bg-kumo-border"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveEdit}
                      className="px-3 py-1 text-sm text-kumo-on-brand bg-kumo-brand rounded hover:opacity-90"
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="font-medium text-kumo-default">{skill.name}</div>
                      <div className="text-sm text-kumo-subtle mt-0.5">{skill.description}</div>
                      <div className="text-sm text-kumo-subtle mt-2 font-mono whitespace-pre-wrap line-clamp-3">
                        {skill.body}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 ml-3">
                      <button
                        onClick={() => handleEdit(skill)}
                        className="px-2 py-1 text-xs text-kumo-default bg-kumo-surface-hover border border-kumo-border rounded hover:bg-kumo-border"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(skill)}
                        className="p-2 text-kumo-subtle hover:text-kumo-danger-default hover:bg-kumo-surface-hover rounded"
                        title="Delete"
                      >
                        <Trash size={18} />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {createModalVisible && (
        <CreateSkillModal
          agent={agent}
          onClose={() => setCreateModalVisible(false)}
          onCreated={handleSkillCreated}
        />
      )}
    </div>
  )
}
