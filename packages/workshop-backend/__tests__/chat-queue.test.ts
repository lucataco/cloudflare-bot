import { describe, expect, it } from "vitest";
import { MAX_CHAT_QUEUE } from "@gadgets/workshop-shared/api";
import {
  cancelChatQueueItem,
  chatQueueKey,
  enqueueChatQueueItem,
  listChatQueue,
  moveChatQueueItemToHead,
  publicChatQueue,
  reorderChatQueue,
  restoreChatQueueHead,
  takeChatQueueHead,
  updateChatQueueItem,
  type ChatQueueRecord,
  type ChatQueueStore,
} from "../src/chat-queue.js";

function makeStore(): ChatQueueStore {
  let map = new Map<string, ChatQueueRecord>();
  return {
    get(key) {
      return map.get(key);
    },
    put(record) {
      map.set(chatQueueKey(record.chatId, record.id), record);
    },
    delete(key) {
      map.delete(key);
    },
    *list({ prefix }) {
      for (let [key, value] of map) {
        if (key.startsWith(prefix)) yield value;
      }
    },
  };
}

describe("chat queue", () => {
  it("enqueues in FIFO order and projects public items", () => {
    let store = makeStore();
    enqueueChatQueueItem(store, 1, {
      message: "first",
      modelId: "model-a",
      initiatorUserId: "user-1",
    });
    enqueueChatQueueItem(store, 1, {
      message: "second",
      modelId: null,
      initiatorUserId: "user-1",
    });
    let pub = publicChatQueue(store, 1);
    expect(pub.map((item) => item.message)).toEqual(["first", "second"]);
    expect(pub[0]?.position).toBe(0);
    expect(pub[1]?.position).toBe(1);
    expect(pub[0] && "initiatorUserId" in pub[0]).toBe(false);
  });

  it("caps the queue", () => {
    let store = makeStore();
    for (let i = 0; i < MAX_CHAT_QUEUE; i++) {
      enqueueChatQueueItem(store, 1, {
        message: `m${i}`,
        modelId: null,
        initiatorUserId: "user-1",
      });
    }
    expect(() => enqueueChatQueueItem(store, 1, {
      message: "overflow",
      modelId: null,
      initiatorUserId: "user-1",
    })).toThrow(/full/);
  });

  it("cancels and reindexes", () => {
    let store = makeStore();
    let a = enqueueChatQueueItem(store, 1, { message: "a", modelId: null, initiatorUserId: "u" });
    enqueueChatQueueItem(store, 1, { message: "b", modelId: null, initiatorUserId: "u" });
    expect(cancelChatQueueItem(store, 1, a.id)).toBe(true);
    expect(listChatQueue(store, 1).map((item) => item.message)).toEqual(["b"]);
    expect(listChatQueue(store, 1)[0]?.position).toBe(0);
  });

  it("updates text", () => {
    let store = makeStore();
    let a = enqueueChatQueueItem(store, 1, { message: "old", modelId: null, initiatorUserId: "u" });
    updateChatQueueItem(store, 1, a.id, "new");
    expect(listChatQueue(store, 1)[0]?.message).toBe("new");
  });

  it("reorders and steers to head", () => {
    let store = makeStore();
    let a = enqueueChatQueueItem(store, 1, { message: "a", modelId: null, initiatorUserId: "u" });
    let b = enqueueChatQueueItem(store, 1, { message: "b", modelId: null, initiatorUserId: "u" });
    let c = enqueueChatQueueItem(store, 1, { message: "c", modelId: null, initiatorUserId: "u" });
    reorderChatQueue(store, 1, [c.id, a.id, b.id]);
    expect(listChatQueue(store, 1).map((item) => item.message)).toEqual(["c", "a", "b"]);
    moveChatQueueItemToHead(store, 1, b.id);
    expect(listChatQueue(store, 1).map((item) => item.message)).toEqual(["b", "c", "a"]);
  });

  it("takes and restores the head", () => {
    let store = makeStore();
    enqueueChatQueueItem(store, 1, { message: "a", modelId: null, initiatorUserId: "u" });
    enqueueChatQueueItem(store, 1, { message: "b", modelId: null, initiatorUserId: "u" });
    let head = takeChatQueueHead(store, 1);
    expect(head?.message).toBe("a");
    expect(listChatQueue(store, 1).map((item) => item.message)).toEqual(["b"]);
    restoreChatQueueHead(store, head!);
    expect(listChatQueue(store, 1).map((item) => item.message)).toEqual(["a", "b"]);
  });

  it("isolates chats", () => {
    let store = makeStore();
    enqueueChatQueueItem(store, 1, { message: "one", modelId: null, initiatorUserId: "u" });
    enqueueChatQueueItem(store, 2, { message: "two", modelId: null, initiatorUserId: "u" });
    expect(publicChatQueue(store, 1).map((item) => item.message)).toEqual(["one"]);
    expect(publicChatQueue(store, 2).map((item) => item.message)).toEqual(["two"]);
  });
});
