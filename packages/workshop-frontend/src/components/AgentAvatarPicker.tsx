import { useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { User } from '@phosphor-icons/react'
import type { AvatarImage } from '@gadgets/workshop-shared/gatekeeper'

/** Keeps an inline data-URL avatar small enough to stay a portable bot definition. */
const MAX_AVATAR_BYTES = 64 * 1024
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(reader.result as string), { once: true })
    reader.addEventListener('error', () => reject(new Error('Failed to read the selected image.')), { once: true })
    reader.readAsDataURL(file)
  })
}

/**
 * Sets or clears a bot's avatar. Uploads are read as inline data URLs limited to the image types
 * and size a shared bot blueprint accepts, so an avatar always survives publishing.
 */
export default function AgentAvatarPicker({
  avatar,
  disabled,
  onChange,
}: {
  avatar?: AvatarImage
  disabled?: boolean
  onChange: (avatar: AvatarImage | null) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (!ALLOWED_TYPES.has(file.type)) {
      setError('Choose a PNG, JPEG, or WebP image.')
      return
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setError('Images must be 64 KB or smaller.')
      return
    }
    try {
      onChange({ url: await readAsDataUrl(file) })
    } catch {
      setError('Could not read that image.')
    }
  }

  return (
    <div className="flex items-center gap-3">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-kumo-brand text-white">
        {avatar?.url
          ? <img src={avatar.url} alt="" className="h-full w-full object-cover" />
          : <User size={20} weight="bold" />}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            {avatar?.url ? 'Change photo' : 'Add photo'}
          </Button>
          {avatar?.url && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setError(null)
                onChange(null)
              }}
            >
              Remove
            </Button>
          )}
        </div>
        <p className="mt-1 text-xs text-kumo-subtle">
          {error ?? 'Optional. PNG, JPEG, or WebP up to 64 KB.'}
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          void handleFile(event.target.files?.[0])
          event.target.value = ''
        }}
      />
    </div>
  )
}
