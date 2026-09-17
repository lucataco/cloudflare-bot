import { Unzip, UnzipInflate } from 'fflate';
import { SaxesParser } from 'saxes';
import { OFFICE_MIME_TYPES } from '@gadgets/workshop-shared/attachments';

const MAX_XML = 1024 * 1024;
const MAX_TOTAL_XML = 4 * MAX_XML;
const MAX_TEXT = 64 * 1024;

/** Extract bounded text/cached cell values without executing macros, formulas, entities or external links. */
export function extractOfficeText(data: Uint8Array, mimeType: string): string {
  try {
    const files = new Map<string, string>();
    let total = 0;
    let entries = 0;
    const unzip = new Unzip(file => {
      if (++entries > 2000) throw new Error('Archive has too many entries');
      const needed = mimeType === OFFICE_MIME_TYPES[0] ? file.name === 'word/document.xml'
        : mimeType === OFFICE_MIME_TYPES[1] ? /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(file.name)
        : /^ppt\/slides\/slide\d+\.xml$/.test(file.name);
      if (!needed) return;
      if (files.has(file.name) || (file.originalSize ?? 0) > MAX_XML) throw new Error('Invalid Office archive');
      const decoder = new TextDecoder();
      let text = '';
      let size = 0;
      file.ondata = (error, chunk, final) => {
        if (error) throw error;
        size += chunk.byteLength; total += chunk.byteLength;
        if (size > MAX_XML || total > MAX_TOTAL_XML) throw new Error('Office archive exceeds expansion limit');
        text += decoder.decode(chunk, { stream: !final });
        if (final) files.set(file.name, text);
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    // Bound each inflation step even when a hostile archive lies about its uncompressed size.
    for (let offset = 0; offset < data.length; offset += 1024) unzip.push(data.subarray(offset, offset + 1024), offset + 1024 >= data.length);
    if (!files.size) throw new Error('Missing Office document');
    const strings: string[] = [];
    let output = '';
    const append = (text: string) => { if (output.length < MAX_TEXT) output += text.slice(0, MAX_TEXT - output.length); };
    const names = [...files.keys()].toSorted((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (files.has('xl/sharedStrings.xml')) {
      names.splice(names.indexOf('xl/sharedStrings.xml'), 1);
      names.unshift('xl/sharedStrings.xml');
    }
    for (const name of names) {
      const sharedStrings = name === 'xl/sharedStrings.xml';
      const sheet = name.startsWith('xl/worksheets/');
      const parser = new SaxesParser({ xmlns: true });
      let depth = 0;
      let nodes = 0;
      let capture = false;
      let value = '';
      let cellType = '';
      parser.on('doctype', () => { throw new Error('Document types are not supported'); });
      parser.on('opentag', tag => {
        if (++depth > 64 || ++nodes > 100_000) throw new Error('XML exceeds structural limits');
        if (tag.local === 'si' || tag.local === 'c') value = '';
        if (tag.local === 'c') cellType = tag.attributes.t?.value ?? '';
        if (tag.local === 't' || tag.local === 'v') capture = true;
      });
      parser.on('text', text => {
        if (!capture) return;
        if (sheet || sharedStrings) value += text;
        else append(text);
      });
      parser.on('closetag', tag => {
        --depth;
        if (tag.local === 't' || tag.local === 'v') capture = false;
        if (sharedStrings && tag.local === 'si') {
          if (strings.length >= 20_000) throw new Error('Too many shared strings');
          strings.push(value);
        } else if (sheet && tag.local === 'c') append((cellType === 's' ? strings[Number(value)] ?? '' : value) + '\t');
        else if (!sharedStrings && ['p', 'row'].includes(tag.local)) append('\n');
      });
      parser.write(files.get(name)!).close();
      if (!sharedStrings) append('\n');
    }
    return output.trim() + (output.length >= MAX_TEXT ? '\n[Office text extraction truncated]' : '');
  } catch { throw new Error('Could not extract this Office document within the supported limits.'); }
}
