// memorydex web UI — vanilla JS, no build step.
const KINDS = ['working', 'episodic', 'semantic', 'procedural']
const KIND_LABEL = { working: 'Working', episodic: 'Episodic', semantic: 'Semantic', procedural: 'Procedural' }
const api = (path, opts) => fetch(`/api${path}`, opts).then(r => r.json())

const el = (sel) => document.querySelector(sel)
const board = el('#board')
const toastEl = el('#toast')
let editingId = null

function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); setTimeout(() => toastEl.classList.remove('show'), 1600) }

async function loadState() {
  const { stats } = await api('/state')
  el('#stats').innerHTML = KINDS.map(k => `<span><b>${stats.byKind[k] ?? 0}</b> ${KIND_LABEL[k]}</span>`).join('') + `<span><b>${stats.total}</b> total</span>`
}

async function loadBoard() {
  const q = el('#search').value.trim()
  const tag = el('#tagFilter').value
  const qs = new URLSearchParams()
  if (q) qs.set('q', q)
  if (tag) qs.set('tags', tag)
  const { memories } = await api(`/memories?${qs.toString()}`)
  renderBoard(memories || [])
  // refresh tag options
  const tags = new Set()
  for (const m of memories || []) for (const t of m.tags) tags.add(t)
  const sel = el('#tagFilter'); const cur = sel.value
  sel.innerHTML = '<option value="">All tags</option>' + [...tags].sort().map(t => `<option${t === cur ? ' selected' : ''} value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join('')
}

function renderBoard(memories) {
  const byKind = Object.fromEntries(KINDS.map(k => [k, []]))
  for (const m of memories) (byKind[m.kind] ||= []).push(m)
  board.innerHTML = KINDS.map(k => `
    <section class="col" data-kind="${k}">
      <h2><span class="dot ${k}"></span>${KIND_LABEL[k]}<span class="count">${byKind[k].length}</span></h2>
      ${byKind[k].length === 0 ? '<div class="empty">No memories</div>' : byKind[k].map(cardHtml).join('')}
    </section>`).join('')
  board.querySelectorAll('.card').forEach(card => {
    const id = card.dataset.id
    card.querySelector('.c')?.addEventListener('click', e => e.currentTarget.classList.toggle('open'))
    card.querySelector('[data-act="edit"]')?.addEventListener('click', () => openEdit(id))
    card.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
      if (!confirm('Delete this memory?')) return
      await api(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' })
      toast('Deleted'); await refresh()
    })
  })
}

function cardHtml(m) {
  return `<article class="card ${m.kind}" data-id="${escapeAttr(m.id)}">
    <div class="t">${escapeHtml(m.title)}</div>
    <div class="c">${escapeHtml(m.content)}</div>
    <div class="meta">
      ${m.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
      ${m.source ? `<span class="src">· ${escapeHtml(m.source.split('#')[0].split('/').pop())}${m.source.includes('#') ? '#' + escapeHtml(m.source.split('#')[1]) : ''}</span>` : ''}
      <div class="acts">
        <button class="ghost" data-act="edit">Edit</button>
        <button class="ghost" data-act="del">Delete</button>
      </div>
    </div>
  </article>`
}

async function refresh() { await Promise.all([loadState(), loadBoard()]) }

// --- dialog ---
const dlg = el('#dlg'), form = el('#dlgForm')
function openNew() {
  editingId = null
  el('#dlgTitle').textContent = 'New memory'
  form.reset(); form.kind.value = 'semantic'; form.importance.value = '0.5'
  dlg.showModal()
}
async function openEdit(id) {
  const m = await api(`/memories/${encodeURIComponent(id)}`)
  if (m.error) { toast('Not found'); return }
  editingId = id
  el('#dlgTitle').textContent = 'Edit memory'
  form.kind.value = m.kind; form.title.value = m.title; form.content.value = m.content
  form.tags.value = m.tags.join(', '); form.importance.value = String(m.importance)
  dlg.showModal()
}
el('#dlgCancel').addEventListener('click', () => dlg.close())
form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const body = {
    kind: form.kind.value, title: form.title.value, content: form.content.value,
    tags: form.tags.value.split(',').map(t => t.trim()).filter(Boolean),
    importance: Number(form.importance.value),
  }
  if (editingId) await api(`/memories/${encodeURIComponent(editingId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  else await api('/memories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  dlg.close(); toast(editingId ? 'Saved' : 'Created'); await refresh()
})

// --- toolbar ---
el('#newBtn').addEventListener('click', openNew)
el('#refreshBtn').addEventListener('click', () => { refresh().then(() => toast('Refreshed')) })
let searchTimer
el('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadBoard, 200) })
el('#tagFilter').addEventListener('change', loadBoard)
el('#importBtn').addEventListener('click', async () => {
  const files = prompt('File paths to import (comma or newline separated):\nAGENTS.md / CLAUDE.md / any .md')
  if (!files) return
  const list = files.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
  const res = await api('/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: list }) })
  toast(`Imported ${(res || []).reduce((n, r) => n + r.imported, 0)} sections`); await refresh()
})
el('#syncBtn').addEventListener('click', async () => {
  const res = await api('/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'pull' }) })
  toast(`Synced ${(res || []).length} files`); await refresh()
})

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
function escapeAttr(s) { return escapeHtml(s) }

refresh()
