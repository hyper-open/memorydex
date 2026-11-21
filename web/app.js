// memorydex web UI — vanilla JS, no build step. Views: Board / Graph / Sync.
const KINDS = ['working', 'episodic', 'semantic', 'procedural']
const KIND_LABEL = { working: 'Working', episodic: 'Episodic', semantic: 'Semantic', procedural: 'Procedural' }
const api = (path, opts) => fetch(`/api${path}`, opts).then(r => r.json())
const el = (sel) => document.querySelector(sel)
const board = el('#board')
const toastEl = el('#toast')
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
  const platform = el('#platformFilter').value
  if (el('#pinnedOnly').checked) list = list.filter(m => m.pinned)
  if (platform) list = list.filter(m => (m.metadata && m.metadata.platform) === platform)
  cached = list
  renderBoard(list)
  const tags = new Set(); const plats = new Set()
  for (const m of memories || []) { for (const t of m.tags) tags.add(t); if (m.metadata && m.metadata.platform) plats.add(m.metadata.platform) }
  const psel = el('#platformFilter'); const pcur = psel.value
  psel.innerHTML = '<option value="">All platforms</option>' + [...plats].sort().map(p => `<option${p === pcur ? ' selected' : ''} value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join('')
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
      ${m.pinned ? '<span class="pin" title="pinned">★</span>' : ''}
      <span>${escapeHtml(m.title)}</span>
    </div>
    <div class="c">${escapeHtml(m.content)}</div>
    <div class="meta">
      <span class="impbar" title="importance ${imp.toFixed(2)}"><i style="width:${Math.round(imp * 100)}%"></i></span>
      ${m.accessCount ? `<span class="src">· ${m.accessCount}×</span>` : ''}
      ${m.metadata && m.metadata.platform ? `<span class="tag" style="background:#26405a;color:#9fd0ff">${escapeHtml(m.metadata.platform)}</span>` : ''}
      ${m.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
      ${(m.links || []).map(id => `<button class="link" data-act="goto" data-target="${escapeAttr(id)}" title="linked memory">↔ ${escapeHtml(String(id).slice(-6))}</button>`).join('')}
      ${m.source ? `<span class="src">· ${escapeHtml(m.source.split('#')[0].split('/').pop())}${m.source.includes('#') ? '#' + escapeHtml(m.source.split('#')[1]) : ''}</span>` : ''}
      <div class="acts">
        <button class="ghost sm" data-act="del">Delete</button>
      </div>
    </div>
  </article>`
}

function wireCards() {
  board.querySelectorAll('.card').forEach(card => {
    const id = card.dataset.id
    card.querySelector('.c')?.addEventListener('click', e => e.currentTarget.classList.toggle('open'))
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

// ---- Platforms (import is the only write path in the UI) ----
async function loadPlatforms() {
  let data = {}
  try { data = await api('/platforms') } catch { data = {} }
  const list = el('#platformlist')
  const rows = Object.entries(data).map(([p, info]) =>
    `<div class="filerow"><span style="flex:1">${escapeHtml(p)} <span class="src">· ${info.files.length} file(s)${info.writable ? '' : ' · read-only'}</span></span>
     <button class="ghost sm" data-plat="${escapeAttr(p)}" ${info.files.length === 0 ? 'disabled' : ''}>Import</button></div>`).join('')
  list.innerHTML = rows || '<span class="empty">No platforms detected.</span>'
  list.querySelectorAll('[data-plat]').forEach(b => b.addEventListener('click', async () => {
    const r = await api('/import-platform', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: b.dataset.plat }) })
    const n = (r || []).reduce((a, x) => a + x.imported, 0)
    toast(`Imported ${n} from ${b.dataset.plat}`)
  }))
}
async function loadSync() { await loadPlatforms() }

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
el('#refreshBtn').addEventListener('click', () => { refresh().then(() => toast('Refreshed')) })
el('#pinnedOnly').addEventListener('change', loadBoard)
let searchTimer
el('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadBoard, 200) })
el('#tagFilter').addEventListener('change', loadBoard)
el('#platformFilter').addEventListener('change', loadBoard)
el('#importBtn').addEventListener('click', async () => {
  const raw = el('#importPath').value.trim(); if (!raw) return
  const files = raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
  const res = await api('/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files }) })
  toast(`Imported ${(res || []).reduce((n, r) => n + r.imported, 0)} sections`); el('#importPath').value = ''
})
window.addEventListener('resize', () => { if (view === 'graph') loadGraph() })

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
function escapeAttr(s) { return escapeHtml(s) }
function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&') }

refresh()
