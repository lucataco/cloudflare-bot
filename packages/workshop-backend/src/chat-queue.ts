import { keyString } from "@gadgets/typed-storage";
import {
  MAX_CHAT_QUEUE,
  type CapsuleSpecifier,
  type ChatAttachmentHandle,
  type ChatQueueItem,
  type MessageFormatRef,
  type SlashCommandRequest,
} from "@gadgets/workshop-shared/api";

export type ChatQueueRecord = ChatQueueItem & {
  chatId: number;
  initiatorUserId: string;
};

export type ChatQueueStore = {
  get(key: string): ChatQueueRecord | undefined;
  put(record: ChatQueueRecord): void;
  delete(key: string): void;
  list(opts: { prefix: string }): Iterable<ChatQueueRecord>;
};

export function chatQueueKey(chatId: number, id: string): string {
  return `${keyString(chatId)}.${id}`;
}

export function listChatQueue(store: ChatQueueStore, chatId: number): ChatQueueRecord[] {
  return [...store.list({ prefix: `${keyString(chatId)}.` })]
    .toSorted((a, b) => a.position - b.position);
}

export function publicChatQueue(store: ChatQueueStore, chatId: number): ChatQueueItem[] {
  return listChatQueue(store, chatId).map(toPublicQueueItem);
}

export function toPublicQueueItem(record: ChatQueueRecord): ChatQueueItem {
  return {
    id: record.id,
    position: record.position,
    message: record.message,
    modelId: record.modelId,
    capsules: record.capsules,
    attachments: record.attachments,
    formats: record.formats,
    agentId: record.agentId,
    created: record.created,
  };
}

export function enqueueChatQueueItem(
  store: ChatQueueStore,
  chatId: number,
  item: Omit<ChatQueueRecord, "id" | "position" | "chatId" | "created"> & { created?: Date },
): ChatQueueRecord {
  let current = listChatQueue(store, chatId);
  if (current.length >= MAX_CHAT_QUEUE) {
    throw new Error(`Chat queue is full (${MAX_CHAT_QUEUE} messages).`);
  }
  let record: ChatQueueRecord = {
    id: crypto.randomUUID(),
    chatId,
    position: current.length,
    message: item.message,
    modelId: item.modelId,
    capsules: item.capsules,
    attachments: item.attachments,
    formats: item.formats,
    agentId: item.agentId,
    created: item.created ?? new Date(),
    initiatorUserId: item.initiatorUserId,
  };
  store.put(record);
  return record;
}

export function cancelChatQueueItem(store: ChatQueueStore, chatId: number, id: string): boolean {
  let key = chatQueueKey(chatId, id);
  if (!store.get(key)) return false;
  store.delete(key);
  reindexChatQueue(store, chatId);
  return true;
}

export function updateChatQueueItem(
  store: ChatQueueStore,
  chatId: number,
  id: string,
  message: string | SlashCommandRequest,
  attachments?: ChatAttachmentHandle[],
  capsules?: CapsuleSpecifier[],
  formats?: MessageFormatRef[],
): ChatQueueRecord {
  let key = chatQueueKey(chatId, id);
  let record = store.get(key);
  if (!record || record.chatId !== chatId) {
    throw new Error("No such queued message.");
  }
  let next: ChatQueueRecord = { ...record, message };
  if (attachments !== undefined) next.attachments = attachments;
  if (capsules !== undefined) next.capsules = capsules;
  if (formats !== undefined) next.formats = formats;
  store.put(next);
  return next;
}

export function reorderChatQueue(store: ChatQueueStore, chatId: number, ids: string[]): void {
  let current = listChatQueue(store, chatId);
  if (ids.length !== current.length) {
    throw new Error("Queue reorder must list every queued message exactly once.");
  }
  let byId = new Map(current.map((item) => [item.id, item]));
  let seen = new Set<string>();
  for (let id of ids) {
    if (seen.has(id) || !byId.has(id)) {
      throw new Error("Queue reorder must list every queued message exactly once.");
    }
    seen.add(id);
  }
  for (let [position, id] of ids.entries()) {
    let record = byId.get(id)!;
    if (record.position !== position) {
      store.put({ ...record, position });
    }
  }
}

export function moveChatQueueItemToHead(store: ChatQueueStore, chatId: number, id: string): void {
  let current = listChatQueue(store, chatId);
  if (!current.some((item) => item.id === id)) {
    throw new Error("No such queued message.");
  }
  reorderChatQueue(store, chatId, [id, ...current.map((item) => item.id).filter((itemId) => itemId !== id)]);
}

export function takeChatQueueHead(store: ChatQueueStore, chatId: number): ChatQueueRecord | undefined {
  let current = listChatQueue(store, chatId);
  let head = current[0];
  if (!head) return undefined;
  store.delete(chatQueueKey(chatId, head.id));
  reindexChatQueue(store, chatId);
  return head;
}

export function restoreChatQueueHead(store: ChatQueueStore, record: ChatQueueRecord): void {
  for (let item of listChatQueue(store, record.chatId)) {
    store.put({ ...item, position: item.position + 1 });
  }
  store.put({ ...record, position: 0 });
}

export function deleteChatQueue(store: ChatQueueStore, chatId: number): void {
  for (let item of listChatQueue(store, chatId)) {
    store.delete(chatQueueKey(chatId, item.id));
  }
}

function reindexChatQueue(store: ChatQueueStore, chatId: number): void {
  for (let [position, record] of listChatQueue(store, chatId).entries()) {
    if (record.position !== position) {
      store.put({ ...record, position });
    }
  }
}
