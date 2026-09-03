import { useState, useEffect, useRef, useCallback } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { useAuthenticatedApi } from './AuthContext'
import {
  AiChatAuthorInfo,
  AiGatewayInfo,
} from '@gadgets/workshop-shared/api'
import {
  Camera,
  ArrowRight,
  Check,
  Plus,
  Hexagon,
} from '@phosphor-icons/react'
import AddModelModal from './AddModelModal'
import { persistSelectedModel } from './modelSelection'
import { compressAvatar, avatarBlobUrl } from './avatarUtils'
import { invalidateAvatarCache } from './useAvatar'
import { useSiteName } from './ServerConfigContext'
import SiteLogo from './components/SiteLogo'
import { useDocumentTitle } from './useDocumentTitle'

const TOTAL_STEPS = 2

// ─── component ──────────────────────────────────────────────────────────────────

export default function OnboardingWizard({
  onComplete,
}: {
  onComplete: () => void
}) {
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const siteName = useSiteName()
  useDocumentTitle('Setup')

  // Wizard state
  const [step, setStep] = useState(0)
  const [mounted, setMounted] = useState(false)
  const [finishing, setFinishing] = useState(false)

  // Profile state
  const [displayName, setDisplayName] = useState('')
  const [originalDisplayName, setOriginalDisplayName] = useState('')
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [avatarData, setAvatarData] = useState<Uint8Array | null>(null)
  const [avatarProcessing, setAvatarProcessing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Model state
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [aiConfig, setAiConfig] = useState<AiGatewayInfo | null>(null)
  const [addModelOpen, setAddModelOpen] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(true)

  // Entrance animation
  useEffect(() => {
    requestAnimationFrame(() => setMounted(true))
  }, [])

  // Revoke avatar blob URL on unmount to prevent memory leak
  useEffect(() => {
    return () => {
      if (avatarPreview) URL.revokeObjectURL(avatarPreview)
    }
  }, [avatarPreview])

  // Populate display name from currentUser (fetched once in AuthContext)
  useEffect(() => {
    if (currentUser) {
      setDisplayName(currentUser.name)
      setOriginalDisplayName(currentUser.name)
    }
  }, [currentUser])

  // Load models + AI config
  const fetchModels = useCallback(async () => {
    try {
      const [modelList, cfg] = await Promise.all([
        authenticatedApi.listModels(),
        authenticatedApi.getAiConfig(),
      ])
      setModels(modelList)
      setAiConfig(cfg)
      // Default to the first model in the list
      if (modelList.length > 0) {
        setSelectedModelId((prev) => prev ?? modelList[0].id)
      }
    } catch (err) {
      console.error('Failed to load models:', err)
    } finally {
      setModelsLoading(false)
    }
  }, [authenticatedApi])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  // ── avatar handlers ───────────────────────────────────────────────────────────

  const handleFileSelect = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toasts.add({ title: 'Please select an image file', variant: 'error' })
      return
    }
    setAvatarProcessing(true)
    try {
      const compressed = await compressAvatar(file)
      setAvatarData(compressed)
      // The cleanup effect on avatarPreview handles revoking the previous URL.
      setAvatarPreview(avatarBlobUrl(compressed))
    } catch (err) {
      console.error('Failed to process avatar:', err)
      toasts.add({ title: 'Failed to process image', variant: 'error' })
    } finally {
      setAvatarProcessing(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFileSelect(file)
  }

  const goNext = () => setStep((s) => Math.min(s + 1, TOTAL_STEPS - 1))
  const goBack = () => setStep((s) => Math.max(s - 1, 0))

  const handleFinish = async () => {
    setFinishing(true)
    try {
      // Save display name if changed
      const trimmedName = displayName.trim()
      if (trimmedName && trimmedName !== originalDisplayName) {
        await authenticatedApi.setOwnDisplayName(trimmedName)
      }
      if (avatarData) {
        await authenticatedApi.setAvatar(avatarData)
        if (currentUser?.id) invalidateAvatarCache(currentUser.id)
      }
      // selectedModelId is null when the user chose "No agent" or didn't pick one
      await authenticatedApi.setPreferredModel(selectedModelId)
      persistSelectedModel(selectedModelId)
      await authenticatedApi.completeOnboarding()
      onComplete()
    } catch (err) {
      console.error('Failed to complete onboarding:', err)
      toasts.add({ title: 'Something went wrong. Please try again.', variant: 'error' })
      setFinishing(false)
    }
  }

  // ── render ────────────────────────────────────────────────────────────────────

  return (
    <>
    {/* visual-viewport-fixed already insets by the safe areas, so plain padding suffices. */}
    <div className="visual-viewport-fixed dotted-bg flex items-start justify-center overflow-y-auto bg-kumo-base p-4 sm:py-8">
      {/* Soft radial glow at the top for depth */}
      <div
        className="absolute inset-x-0 top-0 h-[50vh] pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 60% 60% at 50% 0%, color-mix(in srgb, var(--color-kumo-brand) 8%, transparent) 0%, transparent 70%)',
        }}
      />

      <div
        className={`relative my-auto w-full max-w-lg transition-all duration-500 ease-out ${
          mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
        }`}
      >
        {/* Gadgets brand */}
        <div
          className={`mb-6 flex items-center justify-center gap-2 transition-all duration-500 sm:mb-10 ${
            mounted ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1'
          }`}
        >
          <SiteLogo size={22}>
            <Hexagon size={22} className="text-kumo-brand" weight="bold" />
          </SiteLogo>
          <span className="text-base font-semibold tracking-tight text-kumo-default">
            {siteName}
          </span>
        </div>

        {/* Header */}
        <div className="mb-6 text-center sm:mb-8">
          <h1
            className={`text-3xl font-semibold text-kumo-default tracking-tight transition-all duration-500 delay-100 ${
              mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
            }`}
          >
            Let&apos;s set you up
          </h1>
          <p
            className={`mt-2 text-sm text-kumo-subtle transition-all duration-500 delay-200 ${
              mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
            }`}
          >
            Just a few things before you start building
          </p>
        </div>

        {/* Step indicator */}
        <div className="mb-6 flex items-center justify-center gap-2 sm:mb-8">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all duration-400 ${
                i === step
                  ? 'w-8 bg-kumo-brand'
                  : i < step
                    ? 'w-4 bg-kumo-brand/40'
                    : 'w-4 bg-kumo-line'
              }`}
            />
          ))}
        </div>

        {/* Step content — sliding panel */}
        <div className="overflow-hidden rounded-2xl border border-kumo-line bg-kumo-elevated shadow-xl shadow-black/[0.04]">
          <div
            className="flex transition-transform duration-400 ease-[cubic-bezier(0.25,0.1,0.25,1)]"
            style={{ transform: `translateX(-${step * 100}%)` }}
          >
            {/* ── Step 0: Profile ───────────────────────────────────────────── */}
            <div className="min-h-[320px] w-full flex-shrink-0 p-5 sm:min-h-[420px] sm:p-8">
              <h2 className="text-lg font-medium text-kumo-default mb-1">
                Create your profile
              </h2>
              <p className="text-sm text-kumo-subtle mb-12">
                This is how you&apos;ll appear in conversations
              </p>

              {/* Avatar + Display name side by side */}
              <div className="flex flex-col items-start gap-5 min-[380px]:flex-row">
                {/* Avatar */}
                <div className="flex flex-col items-center flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    onDrop={handleDrop}
                    onDragOver={(e) => e.preventDefault()}
                    className={`
                      relative w-20 h-20 rounded-full border-2 border-dashed
                      transition-all duration-200 group cursor-pointer
                      ${avatarPreview
                        ? 'border-kumo-brand/50 hover:border-kumo-brand'
                        : 'border-kumo-line hover:border-kumo-subtle hover:bg-kumo-tint'
                      }
                      ${avatarProcessing ? 'opacity-50 pointer-events-none' : ''}
                    `}
                  >
                    {avatarPreview ? (
                      <>
                        <img
                          src={avatarPreview}
                          alt="Avatar preview"
                          className="w-full h-full rounded-full object-cover"
                        />
                        <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <Camera size={18} className="text-white" />
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full">
                        <Camera size={22} className="text-kumo-inactive group-hover:text-kumo-subtle transition-colors" />
                      </div>
                    )}
                    {avatarProcessing && (
                      <div className="absolute inset-0 rounded-full bg-kumo-elevated/80 flex items-center justify-center">
                        <div className="w-5 h-5 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                  </button>

                  {/* Hidden file inputs */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) handleFileSelect(file)
                      e.target.value = ''
                    }}
                  />
                  <p className="text-xs text-kumo-inactive mt-1.5">
                    {avatarPreview ? 'Change' : 'Add photo'}
                  </p>
                </div>

                {/* Name + camera shortcut */}
                <div className="flex-1 min-w-0 pt-1">
                  <label
                    htmlFor="onboarding-display-name"
                    className="block text-xs font-medium text-kumo-subtle mb-1.5"
                  >
                    Display name
                  </label>
                  <input
                    id="onboarding-display-name"
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="How should we call you?"
                    className="w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-2.5 text-[16px] text-kumo-default transition-colors placeholder:text-kumo-inactive focus:border-kumo-brand focus:outline-none sm:text-sm"
                  />
                </div>
              </div>
            </div>

            {/* ── Step 1: Model selection ───────────────────────────────────── */}
            <div className="min-h-[320px] w-full flex-shrink-0 p-5 sm:min-h-[420px] sm:p-8">
              <div>
                <h2 className="text-lg font-medium text-kumo-default mb-1">
                  Choose your model
                </h2>
                <p className="text-sm text-kumo-subtle mb-6">
                  Pick the AI model you&apos;d like to use by default
                </p>

                {modelsLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="w-6 h-6 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : (
                  <>
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                      {models.map((model) => (
                        <button
                          key={model.id}
                          onClick={() => setSelectedModelId(model.id)}
                          className={`
                            w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left
                            transition-all duration-150
                            ${selectedModelId === model.id
                              ? 'border-kumo-brand bg-kumo-brand/5 ring-1 ring-kumo-brand/20'
                              : 'border-kumo-line hover:border-kumo-fill hover:bg-kumo-tint'
                            }
                          `}
                        >
                          <div
                            className={`
                              w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold
                              transition-colors duration-150
                              ${selectedModelId === model.id
                                ? 'bg-kumo-brand text-kumo-inverse'
                                : 'bg-kumo-tint text-kumo-subtle'
                              }
                            `}
                          >
                            {model.name[0]?.toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-kumo-default truncate">
                              {model.name}
                            </p>
                            <p className="text-xs text-kumo-subtle truncate">
                              {model.id}
                            </p>
                          </div>
                          {selectedModelId === model.id && (
                            <Check
                              size={18}
                              weight="bold"
                              className="text-kumo-brand flex-shrink-0"
                            />
                          )}
                        </button>
                      ))}

                      {models.length === 0 && (
                        <div className="text-center py-8">
                          <p className="text-sm text-kumo-subtle mb-1">
                            No models yet — you can skip this
                          </p>
                          <p className="text-xs text-kumo-inactive">
                            Add a model later from Providers, or continue without AI.
                          </p>
                        </div>
                      )}
                    </div>

                    <button
                      onClick={() => setAddModelOpen(true)}
                      className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-kumo-subtle border border-dashed border-kumo-line rounded-xl hover:border-kumo-fill hover:text-kumo-default hover:bg-kumo-tint transition-colors"
                    >
                      <Plus size={14} weight="bold" />
                      Add new model...
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Fixed footer — stays put across all steps */}
          <div className="flex items-center justify-between gap-3 border-t border-kumo-line bg-kumo-elevated px-5 py-4 sm:px-8 sm:py-5">
            {step > 0 ? (
              <button
                onClick={goBack}
                className="text-sm text-kumo-subtle hover:text-kumo-default transition-colors"
              >
                Back
              </button>
            ) : (
              <button
                onClick={() => { void handleFinish() }}
                disabled={finishing}
                className="text-sm text-kumo-subtle hover:text-kumo-default transition-colors disabled:opacity-50"
              >
                Skip
              </button>
            )}

            <div className="flex items-center gap-3">
              {/* Primary action */}
              {step < TOTAL_STEPS - 1 ? (
                <button
                  onClick={goNext}
                  className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg transition-all duration-150 text-kumo-inverse bg-kumo-brand hover:bg-kumo-brand-hover"
                >
                  Next
                  <ArrowRight size={14} weight="bold" />
                </button>
              ) : (
                <button
                  onClick={handleFinish}
                  disabled={finishing}
                  className={`
                    flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg
                    transition-all duration-150
                    ${!finishing
                      ? 'text-kumo-inverse bg-kumo-brand hover:bg-kumo-brand-hover'
                      : 'text-kumo-inactive bg-kumo-tint cursor-not-allowed'
                    }
                  `}
                >
                  {finishing ? (
                    <>
                      <div className="w-4 h-4 border-2 border-kumo-inverse/30 border-t-kumo-inverse rounded-full animate-spin" />
                      Setting up...
                    </>
                  ) : (
                    <>
                      Let&apos;s build
                      <ArrowRight size={14} weight="bold" />
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

    </div>

    {/* Add Model Modal — outside the wizard's inner content so it's not
        clipped by overflow-hidden on the sliding panel */}
    <AddModelModal
      visible={addModelOpen}
      onCancel={() => setAddModelOpen(false)}
      onSuccess={() => {
        setAddModelOpen(false)
        fetchModels()
      }}
      authenticatedApi={authenticatedApi}
      aiConfig={aiConfig}
    />
    </>
  )
}
