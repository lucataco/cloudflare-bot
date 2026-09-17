import type { BotBlueprintProfile } from '@gadgets/workshop-shared/api';
import { decodeHTML, decodeHTMLAttribute } from 'entities/decode';
import { parseBotBlueprint } from './bot-blueprint';

/** Public-page import only: never follows arbitrary URLs, redirects, scripts or app deep links. */
export async function previewGrokBot(input: string): Promise<BotBlueprintProfile> {
  const url = new URL(input);
  const match = /^\/bot\/([A-Za-z0-9_-]{1,100})(?:\/[^/]*)?\/?$/.exec(url.pathname);
  if (url.origin !== 'https://x.ai' || url.username || url.password || !match) {
    throw new Error('Use a public https://x.ai/bot/<shareId> link.');
  }
  const source = `https://x.ai/bot/${match[1]}`;
  const response = await fetch(source, {redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: {Accept: 'text/html'}});
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/html')) {
    throw new Error('The public Grok share page is unavailable.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('Grok share page is too large.');
      }
      html += decoder.decode(value, {stream: true});
    }
    html += decoder.decode();
  } finally { reader.releaseLock(); }
  let name = '';
  let description = '';
  let addLink = false;
  await new HTMLRewriter()
    .on('h1', {text(chunk) { name += chunk.text; }})
    .on('meta[name="description"]', {element(element) { description = element.getAttribute('content') ?? ''; }})
    .on('a', {element(element) {
      if (element.getAttribute('href') === `grokbot://app/v1/bot-template?id=${match[1]}`) addLink = true;
    }})
    .transform(new Response(html)).arrayBuffer();
  if (!addLink || !name.trim() || !description.trim()) throw new Error('No public bot profile found at this link.');
  // The public page currently exposes only these fields. Never invent hidden instructions.
  // HTMLRewriter exposes raw entity references. Decode after collecting text chunks, since
  // an entity can span chunks; keep the decoded content as plain text in the profile.
  return parseBotBlueprint({name: decodeHTML(name).trim(), title: 'Imported Grok bot',
    description: `${decodeHTMLAttribute(description).trim()}\n\nSource: ${source}`, skills: [], routines: [], pluginIds: []});
}
