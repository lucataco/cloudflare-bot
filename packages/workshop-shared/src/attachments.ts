/** Per-message attachment count, shared by server and composer. */
export const MAX_CHAT_ATTACHMENTS = 6;
/** Maximum uploaded file size. Images are resized separately by the composer. */
export const MAX_CHAT_ATTACHMENT_BYTES = 4 * 1024 * 1024;
/** Maximum aggregate bytes referenced by one message. */
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 12 * 1024 * 1024;
/** Office Open XML formats parsed as text; macros and embedded programs are never executed. */
export const OFFICE_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;
/** Native Gemini media inputs supported by the current pi adapter. */
export const MEDIA_MIME_TYPES = ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg', 'audio/webm', 'video/mp4', 'video/webm'] as const;
/** Whether a file uses a supported Office Open XML container. */
export function isOfficeAttachment(mimeType: string): boolean { return (OFFICE_MIME_TYPES as readonly string[]).includes(mimeType); }
/** Whether a file is a supported audio/video input. */
export function isMediaAttachment(mimeType: string): boolean { return (MEDIA_MIME_TYPES as readonly string[]).includes(mimeType); }
/** Fill missing browser MIME metadata from a known, bounded file extension. */
export function attachmentMimeType(name: string, mimeType: string): string {
  const aliases: Record<string, string> = { 'audio/x-wav': 'audio/wav', 'audio/x-m4a': 'audio/mp4' };
  if (aliases[mimeType]) return aliases[mimeType];
  if (mimeType && mimeType !== 'application/octet-stream') return mimeType;
  const types: Record<string, string> = { docx: OFFICE_MIME_TYPES[0], xlsx: OFFICE_MIME_TYPES[1], pptx: OFFICE_MIME_TYPES[2],
    pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', yaml: 'text/yaml', yml: 'text/yaml' };
  return types[name.split('.').at(-1)?.toLowerCase() ?? ''] ?? mimeType;
}
