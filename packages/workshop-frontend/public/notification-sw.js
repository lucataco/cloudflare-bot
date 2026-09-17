// Notification-only worker: deliberately no fetch handler, offline cache, or payload navigation.
function displayState() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('gadgets-notifications', 1)
    request.addEventListener('upgradeneeded', () => request.result.createObjectStore('settings'))
    request.addEventListener('error', () => reject(request.error))
    request.addEventListener('blocked', () => reject(new Error('Notification storage blocked')))
    request.addEventListener('success', () => {
      const db = request.result
      const transaction = db.transaction('settings', 'readonly')
      const read = transaction.objectStore('settings').get('display')
      read.addEventListener('success', () => resolve(read.result))
      transaction.addEventListener('complete', () => db.close())
      const fail = () => { db.close(); reject(transaction.error) }
      transaction.addEventListener('error', fail)
      transaction.addEventListener('abort', fail)
    })
  })
}

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    try {
      // The browser decrypts Web Push. Parse JSON, but use none of its presentation fields.
      const payload = event.data?.json()
      if (!payload || typeof payload !== 'object') return
      const before = await displayState()
      if (!before?.enabled) return
      await self.registration.showNotification('Attention', {
        body: 'You have a workspace update. Open Attention to review it.',
        tag: 'attention',
      })
      // Logout can race showNotification; close the just-created notification in that case too.
      const after = await displayState()
      if (!after?.enabled || after.generation !== before.generation) {
        const notifications = await self.registration.getNotifications({ tag: 'attention' })
        notifications.forEach(notification => notification.close())
      }
    } catch {
      // Storage and malformed payload failures are fail-closed, never notification content.
    }
  })())
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil((async () => {
    try {
      if (!(await displayState())?.enabled) return
      const destination = new URL('/attention', self.location.origin).href
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue
        const navigated = await client.navigate(destination)
        if (navigated) { await navigated.focus(); return }
      }
      await self.clients.openWindow(destination)
    } catch { /* Closed tabs or unavailable storage must not redirect elsewhere. */ }
  })())
})
