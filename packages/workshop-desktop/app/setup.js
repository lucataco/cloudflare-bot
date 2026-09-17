document.querySelector('#connect').addEventListener('submit', async event => {
  event.preventDefault()
  const button = document.querySelector('button')
  button.disabled = true
  try { await window.__TAURI__.core.invoke('open_workshop', { value: document.querySelector('#url').value }) }
  catch { document.querySelector('#error').textContent = 'Could not open Workshop. Use HTTPS, or localhost for development.' }
  finally { button.disabled = false }
})
