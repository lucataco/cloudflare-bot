import { exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { newWebSocketRpcSession } from 'capnweb';
import { zipSync, strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import type { PublicApi } from '@gadgets/workshop-shared/api';
import { OFFICE_MIME_TYPES } from '@gadgets/workshop-shared/attachments';
import type { OverseerDurableObject } from '../src/overseer';

it('commits six Office attachments, preserves original downloads, and supplies extracted text only to models', async () => {
  const response = await exports.default.fetch(new Request('https://workshop.invalid/api', { headers: { Upgrade: 'websocket' } }));
  response.webSocket!.accept();
  using root = newWebSocketRpcSession<PublicApi>(response.webSocket!);
  const name = 'files' + crypto.randomUUID().replaceAll('-', '');
  const token = await root.createAccount(name, name, new Uint8Array([1]));
  if (!token) throw new Error('Account creation failed');
  using api = await root.authenticate(token);
  using workspace = await api.newGadget();
  const metadata = await workspace.getMetadata();
  const file = zipSync({ 'word/document.xml': strToU8('<doc><p><t>Shared document text</t></p></doc>') });
  const handles = await Promise.all(Array.from({ length: 6 }, (_, index) => workspace.uploadChatAttachment({ name: `${index}.docx`, mimeType: OFFICE_MIME_TYPES[0], content: file }, null)));
  const chatId = await workspace.newChat('Documents', null, undefined, handles);
  const history = await workspace.getChatHistory(chatId);
  const message = history.messages.find(item => item.type === 'message');
  expect(message?.type === 'message' && message.attachments?.length).toBe(6);
  expect(new Uint8Array(await workspace.getChatAttachmentContent(chatId, handles[0].id))).toEqual(file);
  await runInDurableObject(exports.OverseerDurableObject.get(exports.OverseerDurableObject.idFromString(metadata.id)), async (instance: OverseerDurableObject) => {
    const impl = instance['impl'];
    expect(new TextDecoder().decode(await impl.getChatAttachmentData(chatId, handles[0].id))).toBe('Shared document text');
    expect(() => impl.canonicalizeChatAttachmentRefs([...handles, { id: crypto.randomUUID() }])).toThrow('up to 6');
    const stored = impl.storage.chatAttachmentContent.get(handles[0].id)!;
    expect(stored.blob).toBeDefined();
    expect(stored.data.byteLength).toBe(0);
  });
  await workspace.deleteChat(chatId);
});
