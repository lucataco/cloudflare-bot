import { afterEach, describe, expect, it, vi } from 'vitest';
import { previewGrokBot } from '../src/grok-import';

afterEach(() => vi.restoreAllMocks());
describe('public Grok profile importer', () => {
  it('reads visible fields, retains attribution and never invents hidden configuration', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '<h1 title="Reader">Reader</h1><meta name="description" content="Read &amp; summarize"><a href="grokbot://app/v1/bot-template?id=abc">Add</a><script>throw 1</script>',
      {headers: {'content-type': 'text/html'}}));
    const profile = await previewGrokBot('https://x.ai/bot/abc/name?tracking=1');
    expect(fetcher.mock.calls[0][0]).toBe('https://x.ai/bot/abc');
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
    expect(profile.name).toBe('Reader');
    expect(profile.description).toContain('Read & summarize');
    expect(profile.description).toContain('Source: https://x.ai/bot/abc');
    expect(profile.skills).toEqual([]);
    expect(profile.routines).toEqual([]);
    expect(profile.pluginIds).toEqual([]);
  });
  it.each(['http://x.ai/bot/a', 'https://x.ai.evil.test/bot/a', 'https://x.ai@evil.test/bot/a',
    'https://x.ai:8443/bot/a', 'https://x.ai/news/a', 'https://127.0.0.1/bot/a'])('rejects non-share URLs: %s', async url => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(previewGrokBot(url)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('decodes named and numeric entities as text without interpreting embedded markup', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '<h1>R&amp;D &#x1F916;</h1><meta name="description" content="&quot;Research&quot; &lt;script&gt; &amp;amp;"><a href="grokbot://app/v1/bot-template?id=abc">Add</a>',
      {headers: {'content-type': 'text/html'}}));
    const profile = await previewGrokBot('https://x.ai/bot/abc');
    expect(profile.name).toBe('R&D 🤖');
    expect(profile.description).toContain('"Research" <script> &amp;');
  });
  it('rejects missing profiles and bounds streamed bodies even without Content-Length', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<h1>Not found</h1>', {headers: {'content-type': 'text/html'}}));
    await expect(previewGrokBot('https://x.ai/bot/abc')).rejects.toThrow('No public bot profile');
    fetcher.mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1), {headers: {'content-type': 'text/html'}}));
    await expect(previewGrokBot('https://x.ai/bot/abc')).rejects.toThrow('too large');
  });
});
