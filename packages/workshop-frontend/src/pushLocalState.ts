/** Shared with public/notification-sw.js. No endpoints, keys, or auth tokens are persisted here. */
export type LocalPushState = {
  enabled: boolean
  generation: string
  ownerId?: string
  deviceId?: string
}

let database: Promise<IDBDatabase> | undefined

export async function localPushState(update?: (current: LocalPushState | undefined) => LocalPushState): Promise<LocalPushState | undefined> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gadgets-notifications', 1)
      request.addEventListener('upgradeneeded', () => request.result.createObjectStore('settings'))
      request.addEventListener('success', () => resolve(request.result))
      request.addEventListener('error', () => reject(new Error('Browser notification storage is unavailable.')))
      request.addEventListener('blocked', () => reject(new Error('Close other tabs to update notification storage.')))
    }).catch(error => { database = undefined; throw error })
  }
  const db = await database
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('settings', update ? 'readwrite' : 'readonly')
    const store = transaction.objectStore('settings')
    const request = store.get('display')
    let result: LocalPushState | undefined
    request.addEventListener('success', () => {
      result = request.result as LocalPushState | undefined
      if (update) {
        result = update(result)
        store.put(result, 'display')
      }
    })
    transaction.addEventListener('complete', () => resolve(result))
    const fail = () => reject(new Error('Could not save browser notification preferences.'))
    transaction.addEventListener('error', fail)
    transaction.addEventListener('abort', fail)
  })
}
