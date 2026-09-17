import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { extractOfficeText } from '../src/chat-attachment-office';
import { OFFICE_MIME_TYPES, MAX_CHAT_ATTACHMENTS } from '@gadgets/workshop-shared/attachments';
import { validateChatAttachmentUpload } from '../src/chat-attachment-validation';

describe('rich attachments', () => {
  it('extracts DOCX paragraphs and entities as text', () => {
    const data = zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="urn:word"><w:p><w:t>Research &amp; results</w:t></w:p></w:document>') });
    expect(extractOfficeText(data, OFFICE_MIME_TYPES[0])).toBe('Research & results');
  });
  it('extracts cached spreadsheet values and shared strings without evaluating formulas', () => {
    const data = zipSync({
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Revenue</t></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><row><c t="s"><v>0</v></c><c><f>1+2</f><v>3</v></c></row></worksheet>'),
    });
    expect(extractOfficeText(data, OFFICE_MIME_TYPES[1])).toBe('Revenue\t3');
  });
  it('extracts slide text in numeric order', () => {
    const data = zipSync({ 'ppt/slides/slide10.xml': strToU8('<slide><p><t>Ten</t></p></slide>'),
      'ppt/slides/slide2.xml': strToU8('<slide><p><t>Two</t></p></slide>') });
    expect(extractOfficeText(data, OFFICE_MIME_TYPES[2])).toMatch(/^Two\s+Ten$/);
  });
  it('rejects expansion bombs, DTDs and missing document parts', () => {
    for (const xml of ['x'.repeat(1024 * 1024 + 1), '<!DOCTYPE d [<!ENTITY secret SYSTEM "file:///secret">]><d>&secret;</d>']) {
      expect(() => extractOfficeText(zipSync({ 'word/document.xml': strToU8(xml) }), OFFICE_MIME_TYPES[0])).toThrow('Could not extract');
    }
    expect(() => extractOfficeText(zipSync({ 'other': strToU8('x') }), OFFICE_MIME_TYPES[0])).toThrow();
  });
  it('accepts native Gemini media, rejects incorrect signatures and unsupported model routes', () => {
    const mp4 = new Uint8Array([0, 0, 0, 12, ...strToU8('ftypisom')]);
    expect(validateChatAttachmentUpload({ name: 'clip.mp4', mimeType: '', content: mp4 }, 'google').mimeType).toBe('video/mp4');
    expect(() => validateChatAttachmentUpload({ mimeType: 'video/mp4', content: mp4 }, 'anthropic')).toThrow('Unsupported');
    expect(() => validateChatAttachmentUpload({ mimeType: 'audio/wav', content: mp4 }, 'google')).toThrow('does not match');
    expect(MAX_CHAT_ATTACHMENTS).toBe(6);
  });
});
