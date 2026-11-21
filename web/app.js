// memorydex web UI — vanilla JS, no build step. Views: Board / Graph / Sync.
const KINDS = ['working', 'episodic', 'semantic', 'procedural']
const KIND_LABEL = { working: 'Working', episodic: 'Episodic', semantic: 'Semantic', procedural: 'Procedural' }
const api = (path, opts) => fetch(`/api${path}`, opts).then(r => r.json())
const el = (sel) => document.querySelector(sel)
const board = el('#board')
const toastEl = el('#toast')
let editingId = null
let cached = []           // last fetched memories
let view = 'board'

function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); setTimeout(() => toastEl.classList.remove('show'), 1600) }

async function loadState() {
  const { stats } = await api('/state')
  el('#stats').innerHTML = KINDS.map(k => `<span><b>${stats.byKind[k] ?? 0}</b> ${KIND_LABEL[k]}</span>`).join('') + `<span><b>${stats.total}</b> total</span>`
}

function filterQs() {
  const q = el('#search').value.trim()
  const tag = el('#tagFilter').value
  const qs = new URLSearchParams()
  if (q) qs.set('q', q)
  if (tag) qs.set('tags', tag)
  return qs
}

async function loadBoard() {
  const { memories } = await api(`/memories?${filterQs().toString()}`)
  let list = memories || []
  if (el('#pinnedOnly').checked) list = list.filter(m => m.pinned)
  cached = list
  renderBoard(list)
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
  wireCards()
}

function cardHtml(m) {
  const imp = typeof m.importance === 'number' ? m.importance : 0.5
  return `<article class="card ${m.kind} ${m.pinned ? 'pinned' : ''}" data-id="${escapeAttr(m.id)}">
    <div class="t">
      <button class="link pin ${m.pinned ? '' : 'off'}" data-act="pin" title="Toggle pinned">${m.pinned ? '★' : '☆'}</button>
      <span>${escapeHtml(m.title)}</span>
    </div>
    <div class="c">${escapeHtml(m.content)}</div>
    <div class="meta">
      <span class="impbar" title="importance ${imp.toFixed(2)}"><i style="width:${Math.round(imp * 100)}%"></i></span>
      ${m.accessCount ? `<span class="src">· ${m.accessCount}×</span>` : ''}
      ${m.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
      ${(m.links || []).map(id => `<button class="link" data-act="goto" data-target="${escapeAttr(id)}" title="linked memory">↔ ${escapeHtml(String(id).slice(-6))}</button>`).join('')}
      ${m.source ? `<span class="src">· ${escapeHtml(m.source.split('#')[0].split('/').pop())}${m.source.includes('#') ? '#' + escapeHtml(m.source.split('#')[1]) : ''}</span>` : ''}
      <div class="acts">
        <button class="ghost sm" data-act="edit">Edit</button>
        <button class="ghost sm" data-act="del">Delete</button>
      </div>
    </div>
  </article>`
}

function wireCards() {
  board.querySelectorAll('.card').forEach(card => {
    const id = card.dataset.id
    card.querySelector('.c')?.addEventListener('click', e => e.currentTarget.classList.toggle('open'))
    card.querySelector('[data-act="pin"]')?.addEventListener('click', async () => {
      const m = cached.find(x => x.id === id); if (!m) return
      await api(`/memories/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned: !m.pinned }) })
      toast(m.pinned ? 'Unpinned' : 'Pinned'); await refresh()
    })
    card.querySelector('[data-act="edit"]')?.addEventListener('click', () => openEdit(id))
    card.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
      if (!confirm('Delete this memory?')) return
      await api(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('Deleted'); await refresh()
    })
    card.querySelectorAll('[data-act="goto"]').forEach(b => b.addEventListener('click', () => showOnBoard(b.dataset.target)))
  })
}

function showOnBoard(id) {
  // highlight a linked memory on the board
  setView('board')
  const card = board.querySelector(`.card[data-id="${cssEscape(id)}"]`)
  if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.style.outline = '2px solid var(--accent)'; setTimeout(() => { card.style.outline = '' }, 1500) }
  else toast('Linked memory not in current filter')
}

async function refresh() {
  await loadState()
  if (view === 'board') await loadBoard()
  else if (view === 'graph') await loadGraph()
  else await loadSync()
}

// ---- Graph ----
async function loadGraph() {
  const { memories } = await api('/memories')
  const nodes = memories || []
  const svg = el('#graph')
  const W = svg.clientWidth || 1000, H = svg.clientHeight || 600
  // layout: columns by kind, stacked vertically
  const byKind = Object.fromEntries(KINDS.map(k => [k, []]))
  for (const m of nodes) (byKind[m.kind] ||= []).push(m)
  const colW = W / KINDS.length
  const pos = new Map()
  KINDS.forEach((k, ci) => {
    const arr = byKind[k]
    arr.forEach((m, ri) => {
      const x = colW * ci + colW / 2
      const y = 60 + (ri * (H - 100)) / Math.max(1, arr.length - 1 || 1)
      pos.set(m.id, { x, y, m })
    })
  })
  const color = { working: '#8a7dff', episodic: '#e0a24a', semantic: '#4fc08d', procedural: '#d96d9c' }
  let edges = ''
  for (const m of nodes) for (const id of (m.links || [])) {
    const a = pos.get(m.id), b = pos.get(id); if (!a || !b) continue
    edges += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#3a4150" stroke-width="1.5" />`
  }
  let dots = ''
  for (const [id, p] of pos) {
    dots += `<g><circle cx="${p.x}" cy="${p.y}" r="7" fill="${color[p.m.kind]}"><title>${escapeHtml(p.m.title)}</title></circle>`
    dots += `<text x="${p.x + 11}" y="${p.y + 4}" fill="#cfd6e2" font-size="11">${escapeHtml(String(p.m.title).slice(0, 26))}</text></g>`
  }
  let heads = ''
  KINDS.forEach((k, ci) => { heads += `<text x="${colW * ci + colW / 2}" y="24" fill="#6b7486" font-size="12" text-anchor="middle">${KIND_LABEL[k]}</text>` })
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  svg.innerHTML = heads + edges + dots
}

// ---- Sync ----
async function loadSync() {
  const { files } = await api('/tracked')
  const list = el('#filelist')
  if (!files || files.length === 0) { list.innerHTML = '<span class="empty">No tracked files yet — import a file first.</span>'; return }
  list.innerHTML = files.map(f => `<div class="filerow"><span style="flex:1;overflow:hidden;text-overflow:ellipsis">${escapeHtml(f)}</span>
    <button class="ghost sm" data-pull="${escapeAttr(f)}">Pull</button>
    <button class="ghost sm" data-push="${escapeAttr(f)}">Push</button></div>`).join('')
  list.querySelectorAll('[data-pull]').forEach(b => b.addEventListener('click', () => doSync(b.dataset.pull, 'pull')))
  list.querySelectorAll('[data-push]').forEach(b => b.addEventListener('click', () => doSync(b.dataset.push, 'push')))
}
async function doSync(file, direction) {
  const r = await api('/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file, direction }) })
  toast(`${direction} ${file.split('/').pop()}: +${r.added ?? 0} ~${r.updated ?? 0} -${r.removed ?? 0}`); await loadSync()
}

// ---- dialog ----
const dlg = el('#dlg'), form = el('#dlgForm')
function openNew() {
  editingId = null
  el('#dlgTitle').textContent = 'New memory'
  form.reset(); form.kind.value = 'semantic'; form.importance.value = '0.5'; form.pinned.checked = false
  dlg.showModal()
}
async function openEdit(id) {
  const m = await api(`/memories/${encodeURIComponent(id)}`)
  if (m.error) { toast('Not found'); return }
  editingId = id
  el('#dlgTitle').textContent = 'Edit memory'
  form.kind.value = m.kind; form.title.value = m.title; form.content.value = m.content
  form.tags.value = m.tags.join(', '); form.importance.value = String(m.importance)
  form.links.value = (m.links || []).join(', '); form.pinned.checked = !!m.pinned
  dlg.showModal()
}
el('#dlgCancel').addEventListener('click', () => dlg.close())
form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const body = {
    kind: form.kind.value, title: form.title.value, content: form.content.value,
    tags: form.tags.value.split(',').map(t => t.trim()).filter(Boolean),
    importance: Number(form.importance.value),
    links: form.links.value.split(',').map(t => t.trim()).filter(Boolean),
    pinned: form.pinned.checked,
  }
  if (editingId) await api(`/memories/${encodeURIComponent(editingId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  else await api('/memories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  dlg.close(); toast(editingId ? 'Saved' : 'Created'); await refresh()
})

// ---- tabs / toolbar ----
function setView(v) {
  view = v
  for (const [id, name] of [['#tabBoard', 'board'], ['#tabGraph', 'graph'], ['#tabSync', 'sync']]) el(id).classList.toggle('active', name === v)
  el('#boardView').classList.toggle('hidden', v !== 'board')
  el('#graphView').classList.toggle('hidden', v !== 'graph')
  el('#syncView').classList.toggle('hidden', v !== 'sync')
  refresh()
}
el('#tabBoard').addEventListener('click', () => setView('board'))
el('#tabGraph').addEventListener('click', () => setView('graph'))
el('#tabSync').addEventListener('click', () => setView('sync'))
el('#newBtn').addEventListener('click', openNew)
el('#refreshBtn').addEventListener('click', () => { refresh().then(() => toast('Refreshed')) })
el('#pinnedOnly').addEventListener('change', loadBoard)
let searchTimer
el('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadBoard, 200) })
el('#tagFilter').addEventListener('change', loadBoard)
el('#importBtn').addEventListener('click', async () => {
  const raw = el('#importPath').value.trim(); if (!raw) return
  const files = raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
  const res = await api('/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files }) })
  toast(`Imported ${(res || []).reduce((n, r) => n + r.imported, 0)} sections`); el('#importPath').value = ''; await loadSync()
})
el('#pullAllBtn').addEventListener('click', async () => { const r = await api('/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'pull' }) }); toast(`Pulled ${(r || []).length} files`); await loadSync() })
el('#pushAllBtn').addEventListener('click', async () => { const r = await api('/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'push' }) }); toast(`Pushed ${(r || []).length} files`); await loadSync() })
window.addEventListener('resize', () => { if (view === 'graph') loadGraph() })

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
function escapeAttr(s) { return escapeHtml(s) }
function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&') }

refresh()
