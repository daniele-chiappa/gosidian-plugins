// The chat widget of gosidian-chat: a script any page loads, which draws
// a bot's chat in a container of the page, in a shadow root of its own.
//
//   <div id="chat-docs"></div>
//   <script src="https://chat.example.com/chat.js" data-bot="docs"
//           data-container="chat-docs" data-key="pk-…" async></script>
//
// data-key is a site's public key (good from its origins only), data-token
// a token the site signed for its user; the bot's own page (data-page)
// takes gosidian's token from its fragment, #token=…. The answers are text:
// written into the page escaped, with a few marks of markdown.

interface ChatOptions {
  bot: string
  base: string
  container: HTMLElement
  key?: string
  token?: string
  page?: boolean
}

interface Source {
  n?: number
  doc?: string
  sezione?: string
  section?: string
  title?: string
  url?: string
  /** The passage as the documentation has it, its images as [img:n] lines. */
  text?: string
  images?: Figure[]
}

interface Figure {
  url?: string
  title?: string
  /** The image's number: a line [img:n] of the text shows it there. */
  n?: number
}

interface Answer {
  text?: string
  sources?: Source[]
  turn?: string
  images?: Figure[]
  more_images?: Figure[]
  non_so?: boolean
}

type Shown = { url: string; title: string; n?: number }

interface ScopeInfo {
  name: string
  label?: string
  children?: ScopeInfo[]
}

interface BotInfo {
  title?: string
  welcome?: string
  scopes?: ScopeInfo[]
  scope_labels?: string[]
  max_message?: number
  handoff?: { label?: string; contact?: boolean } | null
  dates?: boolean
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c])
}

/** The inline marks of a line already escaped: code, bold, links (http and
 *  https only), and citations [n] to the sources. */
function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t: string, u: string) =>
      `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g, '<sup class="cite">[$1]</sup>')
}

/** An image as HTML, its address and title escaped: as wide as the text
 *  around it, opened large with a click. */
function figureHtml(f: Shown): string {
  const cap = f.title ? `<figcaption>${escapeHtml(f.title)}</figcaption>` : ''
  return `<figure class="fig"><img class="zoom" src="${escapeHtml(f.url)}" alt="${escapeHtml(f.title)}" loading="lazy" referrerpolicy="no-referrer">${cap}</figure>`
}

/** An answer as HTML: escaped first, then paragraphs, lists, headings
 *  and, on a line of its own, [img:n], the image n of figs (a number not
 *  among them is left out). */
function render(text: string, figs: Map<number, Shown> = new Map()): string {
  const lines = escapeHtml(text).split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | '' = ''
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`)
    para = []
  }
  const close = () => {
    if (list) out.push(`</${list}>`)
    list = ''
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    const img = /^\s*\[img:(\d{1,4})\]$/.exec(line)
    if (img) {
      flush()
      close()
      const f = figs.get(Number(img[1]))
      if (f) out.push(figureHtml(f))
      continue
    }
    const head = /^#{1,6}\s+(.*)$/.exec(line)
    if (head) {
      flush()
      close()
      out.push(`<p class="h">${inline(head[1])}</p>`)
      continue
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line)
    const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      flush()
      const kind = ul ? 'ul' : 'ol'
      if (list !== kind) {
        close()
        // A list an image broke goes on with its numbers.
        out.push(ol && ol[1] !== '1' ? `<ol start="${Number(ol[1])}">` : `<${kind}>`)
        list = kind
      }
      out.push(`<li>${inline(ul ? ul[1] : ol![2])}</li>`)
    } else if (line.trim() === '') {
      flush()
      close()
    } else {
      close()
      para.push(line)
    }
  }
  flush()
  close()
  return out.join('')
}

/** The sources of an answer by document: its numbers together, once
 *  each document (a pipeline that hands several passages of one). */
function groupSources(list: Source[]): { name: string; url?: string; numbers: number[] }[] {
  const out: { name: string; url?: string; numbers: number[]; key: string }[] = []
  list.forEach((s, i) => {
    if (!s.doc && !s.title) return
    const key = s.doc || s.title || ''
    const n = s.n ?? i + 1
    const g = out.find((x) => x.key === key)
    if (g) {
      if (!g.numbers.includes(n)) g.numbers.push(n)
      return
    }
    const name = s.title || (s.doc ?? '').split('/').pop()?.replace(/\.md$/, '') || ''
    out.push({ key, name, url: s.url, numbers: [n] })
  })
  return out.map(({ name, url, numbers }) => ({ name, url, numbers }))
}

/** The images the widget shows: http(s) addresses only, at most max
 *  (eight by default). One the plugin serves (/api/bots/<bot>/images/…) is
 *  taken from base, where the widget came from: the plugin may be reached
 *  at another address than its CHAT_PUBLIC_URL (a tunnel, a LAN). */
function figures(list: Figure[], base = '', max = 8): Shown[] {
  return list
    .filter((f) => typeof f.url === 'string' && /^https?:\/\//.test(f.url))
    .slice(0, max)
    .map((f) => {
      let url = f.url as string
      const own = /^https?:\/\/[^/]+(\/api\/bots\/[^/?#]+\/images\/[0-9a-f]+)$/.exec(url)
      if (base && own) url = base + own[1]
      const out: Shown = { url, title: f.title || '' }
      if (typeof f.n === 'number') out.n = f.n
      return out
    })
}

/** The images by their number, those that have one. */
function byNumber(list: Shown[]): Map<number, Shown> {
  return new Map(list.filter((f) => f.n !== undefined).map((f) => [f.n as number, f]))
}

/** The events of a text/event-stream read so far, and the start of the
 *  next one, not yet whole. */
function parseEvents(buf: string): { events: { event: string; data: string }[]; rest: string } {
  const blocks = buf.split('\n\n')
  const rest = blocks.pop() ?? ''
  const events: { event: string; data: string }[] = []
  for (const block of blocks) {
    let event = 'message'
    const data: string[] = []
    for (const raw of block.split('\n')) {
      const line = raw.replace(/\r$/, '')
      if (line.startsWith(':')) continue
      const i = line.indexOf(':')
      const field = i < 0 ? line : line.slice(0, i)
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    }
    if (data.length) events.push({ event, data: data.join('\n') })
  }
  return { events, rest }
}

/** An answer as it comes: without the lines that are only a mark in
 *  brackets ([img:3], the pipeline's own), which the answer puts in their
 *  places, nor a mark still open at its end. */
function draft(text: string): string {
  let t = text
    .split('\n')
    .filter((l) => !/^\s*\[[^\]\n]{1,60}\]?\s*$/.test(l))
    .join('\n')
  const open = t.lastIndexOf('[')
  if (open >= 0 && t.indexOf(']', open) < 0 && t.length - open < 60) t = t.slice(0, open)
  return t
}

/** The selects of nested scopes, given the names chosen so far: one per
 *  level, down the chosen ones while they have children. */
function scopeLevels(scopes: ScopeInfo[], chosen: string[]): { options: ScopeInfo[]; value: string }[] {
  const out: { options: ScopeInfo[]; value: string }[] = []
  let options = scopes
  for (let i = 0; options.length; i++) {
    const pick = options.find((s) => s.name === chosen[i])
    out.push({ options, value: pick ? pick.name : '' })
    if (!pick?.children?.length) break
    options = pick.children
  }
  return out
}

const STYLE = `
:host { all: initial; display: block; height: 100%; font: 14px/1.45 system-ui, sans-serif;
  --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de; --me: #ddf4ff; --bot: #f6f8fa; --accent: #0969da; }
@media (prefers-color-scheme: dark) {
  :host { --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --line: #30363d; --me: #0c2d6b; --bot: #161b22; --accent: #4493f8; }
}
.chat { display: flex; flex-direction: column; height: 100%; min-height: 320px; background: var(--bg); color: var(--fg);
  border: 1px solid var(--line); border-radius: 8px; overflow: hidden; box-sizing: border-box; }
.page .chat { border: 0; border-radius: 0; }
header { padding: 10px 14px; border-bottom: 1px solid var(--line); font-weight: 600; }
.log { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.msg { max-width: 85%; padding: 8px 12px; border-radius: 10px; overflow-wrap: anywhere; }
.msg p { margin: 0 0 6px; } .msg p:last-child { margin-bottom: 0; }
.msg ul, .msg ol { margin: 4px 0 6px; padding-left: 20px; }
.me { align-self: flex-end; background: var(--me); white-space: pre-wrap; }
.bot { align-self: flex-start; background: var(--bot); border: 1px solid var(--line); }
.note { align-self: center; color: var(--muted); font-size: 12px; }
.cite { color: var(--accent); }
.sources { margin-top: 6px; font-size: 12px; color: var(--muted); }
.sources a { color: var(--accent); }
.rate { margin-top: 6px; display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
.rate button { font: inherit; border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
.rate input[type=range] { width: 120px; }
.rate input[type=text] { font: inherit; border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 6px; padding: 2px 6px; }
.scopes { display: flex; flex-wrap: wrap; gap: 8px; padding: 6px 14px 0; font-size: 12px; color: var(--muted); }
.filters { border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
.filters summary { padding: 6px 14px; cursor: pointer; list-style-position: inside; }
.filters[open] summary { padding-bottom: 0; }
.filters .scopes { padding-bottom: 6px; }
.scopes label { display: inline-flex; gap: 4px; align-items: center; }
.scopes select, .scopes input[type=date] { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 2px 4px; max-width: 220px; }
.figs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.figs figure { margin: 0; max-width: 220px; }
.figs img { display: block; max-width: 100%; max-height: 160px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
.figs figcaption, .fig figcaption { font-size: 11px; color: var(--muted); margin-top: 2px; }
.fig { margin: 6px 0 8px; }
.fig img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
img.zoom { cursor: zoom-in; }
.msg .h { font-weight: 600; }
.more, .src { margin-top: 6px; font-size: 12px; color: var(--muted); }
.more summary, .src summary { cursor: pointer; }
.srctext { margin-top: 4px; padding: 4px 0 2px 10px; border-left: 2px solid var(--line); color: var(--fg); font-size: 13px; }
.view { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .82); cursor: zoom-out; }
.view[hidden] { display: none; }
.view img { max-width: 96vw; max-height: 94vh; background: #fff; border-radius: 4px; }
.person { display: flex; justify-content: flex-end; padding: 0 14px 8px; }
.person button, .ask button { font: inherit; font-size: 12px; border: 1px solid var(--line); background: var(--bg); color: var(--accent); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
.ask { display: flex; flex-direction: column; gap: 6px; }
.ask textarea, .ask input { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 6px; }
.ask .row { display: flex; gap: 6px; justify-content: flex-end; }
.compose { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); }
textarea { flex: 1; resize: none; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
.compose button { font: inherit; border: 0; border-radius: 6px; padding: 0 14px; background: var(--accent); color: #fff; cursor: pointer; }
.compose button:disabled { opacity: .6; cursor: default; }
.bot.cut { color: var(--muted); }
.retry { align-self: flex-start; display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--muted); }
.retry button { font: inherit; border: 1px solid var(--line); background: var(--bg); color: var(--accent); border-radius: 6px; padding: 2px 10px; cursor: pointer; }
`

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function storage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function mount(opts: ChatOptions): void {
  const api = `${opts.base}/api/bots/${encodeURIComponent(opts.bot)}`
  const key = `gosidian-chat:${opts.bot}`
  let session = storage()?.getItem(key) ?? ''
  const root = opts.container.attachShadow ? opts.container.attachShadow({ mode: 'open' }) : opts.container
  const style = el('style')
  style.textContent = STYLE
  const wrap = el('div', opts.page ? 'page' : '')
  wrap.style.height = '100%'
  const chat = el('div', 'chat')
  const header = el('header', '', opts.bot)
  const log = el('div', 'log')
  log.setAttribute('role', 'log')
  log.setAttribute('aria-live', 'polite')
  const scopes = el('div', 'scopes')
  // A div, not a form: a page that frames the chat sandboxed without
  // allow-forms (gosidian's note) blocks a form's submit, and its event.
  const form = el('div', 'compose')
  const input = el('textarea')
  input.rows = 2
  input.setAttribute('aria-label', 'Messaggio')
  input.placeholder = 'Scrivi una domanda…'
  const send = el('button', '', 'Invia')
  send.type = 'button'
  form.append(input, send)
  const person = el('div', 'person')
  // The scopes and the day, folded under a line that says what is chosen.
  const filters = el('details', 'filters')
  const summary = el('summary', '', 'Filtri: tutto')
  filters.append(summary, scopes)
  chat.append(header, log, form, person)
  // An image opened large, over the page: a click or Esc closes it.
  const view = el('div', 'view')
  view.hidden = true
  view.setAttribute('role', 'dialog')
  const big = el('img')
  big.referrerPolicy = 'no-referrer'
  view.append(big)
  view.onclick = () => (view.hidden = true)
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') view.hidden = true
  })
  log.addEventListener('click', (ev) => {
    const t = ev.target
    if (t instanceof HTMLImageElement && t.classList.contains('zoom')) {
      big.src = t.src
      big.alt = t.alt
      view.hidden = false
    }
  })
  wrap.append(chat, view)
  root.append(style, wrap)

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (opts.token) h.Authorization = `Bearer ${opts.token}`
    if (opts.key) h['X-Chat-Key'] = opts.key
    return h
  }
  const note = (text: string) => {
    log.append(el('div', 'msg note', text))
    log.scrollTop = log.scrollHeight
  }
  const call = async (path: string, init?: RequestInit): Promise<any> => {
    const r = await fetch(api + path, { ...init, headers: headers() })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
    return body
  }
  // A POST that asks for the answer as it comes: onText gets each piece
  // (delta) and a start over (reset); the answer comes back as call gives
  // it, from a plugin that answers JSON too.
  const stream = async (path: string, body: string, onText: (kind: 'delta' | 'reset', text: string) => void): Promise<any> => {
    const r = await fetch(api + path, { method: 'POST', body, headers: { ...headers(), Accept: 'text/event-stream' } })
    if (!(r.headers.get('Content-Type') || '').startsWith('text/event-stream') || !r.body) {
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
      return b
    }
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch {
        break
      }
      if (chunk.done) break
      const { events, rest } = parseEvents(buf + dec.decode(chunk.value, { stream: true }))
      buf = rest
      for (const ev of events) {
        let data: any
        try {
          data = JSON.parse(ev.data)
        } catch {
          continue
        }
        if (ev.event === 'delta') onText('delta', String(data.text ?? ''))
        else if (ev.event === 'reset') onText('reset', '')
        else if (ev.event === 'answer' || ev.event === 'error') {
          reader.cancel().catch(() => {})
          if (ev.event === 'error') throw new Error(data.error || `HTTP ${data.status}`)
          return data
        }
      }
    }
    throw new Error('Risposta interrotta: la connessione si è chiusa.')
  }

  // A flat list of scopes: boxes, several may be chosen. Nested ones
  // (gosidian's folders): a select per level, one scope chosen, the
  // deepest; none, all of them.
  const chosen = new Set<string>()
  let path: string[] = []
  let asOf = ''
  let handoff: { label?: string; contact?: boolean } | null = null
  const labelOf = new Map<string, string>()
  const sum = () => {
    const what = path.length ? path.map((n) => labelOf.get(n) || n).join(' › ') : [...chosen].map((n) => labelOf.get(n) || n).join(', ')
    summary.textContent = `Filtri: ${what || 'tutto'}${asOf ? ` · al ${asOf}` : ''}`
  }
  // The form that hands the conversation to a person.
  const askPerson = () => {
    if (!handoff || log.querySelector('.ask')) return
    const box = el('div', 'msg bot ask')
    box.append(el('div', '', 'Scrivi cosa ti serve: la conversazione passa a una persona.'))
    const what = el('textarea')
    what.rows = 2
    what.placeholder = 'Cosa ti serve (facoltativo)'
    box.append(what)
    let contact: HTMLInputElement | null = null
    if (handoff.contact) {
      contact = el('input')
      contact.type = 'text'
      contact.maxLength = 200
      contact.placeholder = 'Come risponderti: email o telefono (facoltativo)'
      box.append(contact)
    }
    const row = el('div', 'row')
    const cancel = el('button', '', 'Annulla')
    cancel.type = 'button'
    cancel.onclick = () => box.remove()
    const go = el('button', '', 'Invia')
    go.type = 'button'
    go.onclick = () => {
      go.disabled = true
      call('/handoff', { method: 'POST', body: JSON.stringify({ session, message: what.value, contact: contact?.value ?? '' }) })
        .then((r: { session: string; answer: Answer }) => {
          session = r.session
          storage()?.setItem(key, session)
          box.replaceChildren(document.createTextNode(r.answer?.text || 'Richiesta inviata.'))
          box.classList.remove('ask')
        })
        .catch((e: Error) => {
          go.disabled = false
          note(e.message)
        })
    }
    row.append(cancel, go)
    box.append(row)
    log.append(box)
    log.scrollTop = log.scrollHeight
    what.focus()
  }
  const selects = (tree: ScopeInfo[], labels: string[]) => {
    const keep = [...scopes.querySelectorAll('label')].filter((l) => l.querySelector('input[type=date]'))
    scopes.replaceChildren()
    scopeLevels(tree, path).forEach((lv, i) => {
      const sel = el('select')
      const all = el('option', '', 'Tutto')
      all.value = ''
      sel.append(all)
      for (const sc of lv.options) {
        const o = el('option', '', sc.label || sc.name)
        o.value = sc.name
        sel.append(o)
      }
      sel.value = lv.value
      sel.setAttribute('aria-label', labels[i] || `Ambito ${i + 1}`)
      sel.addEventListener('change', () => {
        path = sel.value ? [...path.slice(0, i), sel.value] : path.slice(0, i)
        chosen.clear()
        if (path.length) chosen.add(path[path.length - 1])
        selects(tree, labels)
        sum()
      })
      if (labels[i]) {
        const label = el('label', '', labels[i])
        label.append(sel)
        scopes.append(label)
      } else {
        scopes.append(sel)
      }
    })
    scopes.append(...keep)
  }
  call('')
    .then((info: BotInfo) => {
      header.textContent = info.title || opts.bot
      if (info.welcome) note(info.welcome)
      if (info.max_message) input.maxLength = info.max_message
      handoff = info.handoff ?? null
      if (handoff) {
        const b = el('button', '', handoff.label || 'Parla con una persona')
        b.type = 'button'
        b.onclick = askPerson
        person.append(b)
      }
      const tree = info.scopes ?? []
      const walk = (l: ScopeInfo[]) =>
        l.forEach((sc) => {
          labelOf.set(sc.name, sc.label || sc.name)
          walk(sc.children ?? [])
        })
      walk(tree)
      if (tree.length || info.dates) chat.insertBefore(filters, form)
      const day = () => {
        if (!info.dates) return
        const label = el('label', '', 'Documentazione al')
        const d = el('input')
        d.type = 'date'
        d.addEventListener('change', () => {
          asOf = d.value
          sum()
        })
        label.append(d)
        scopes.append(label)
      }
      if (tree.some((sc) => sc.children?.length)) {
        selects(tree, info.scope_labels ?? [])
        day()
        return
      }
      for (const sc of tree) {
        const label = el('label')
        const box = el('input')
        box.type = 'checkbox'
        box.addEventListener('change', () => {
          if (box.checked) chosen.add(sc.name)
          else chosen.delete(sc.name)
          sum()
        })
        label.append(box, document.createTextNode(` ${sc.label || sc.name}`))
        scopes.append(label)
      }
      day()
    })
    .catch((e: Error) => note(e.message))

  const rateRow = (turn: string): HTMLElement => {
    const row = el('div', 'rate')
    const done = (text: string) => {
      row.replaceChildren(document.createTextNode(text))
    }
    const rate = (value: number, comment = '') =>
      call('/ratings', { method: 'POST', body: JSON.stringify({ session, turn, rating: value, comment }) })
        .then(() => done(`Grazie: ${value > 0 ? '+' : ''}${value}`))
        .catch((e: Error) => done(e.message))
    const up = el('button', '', '👍')
    up.title = 'Utile (+10)'
    up.onclick = () => rate(10)
    const down = el('button', '', '👎')
    down.title = 'Non utile (−10)'
    down.onclick = () => rate(-10)
    const more = el('button', '', 'Valuta…')
    more.onclick = () => {
      const range = el('input')
      range.type = 'range'
      range.min = '-10'
      range.max = '10'
      range.value = '0'
      const shown = el('span', '', '0')
      range.oninput = () => (shown.textContent = range.value)
      const comment = el('input')
      comment.type = 'text'
      comment.placeholder = 'Commento (facoltativo)'
      const ok = el('button', '', 'Invia il voto')
      ok.onclick = () => rate(Number(range.value), comment.value)
      row.replaceChildren(range, shown, comment, ok)
    }
    row.append(up, down, more)
    return row
  }

  // A row of small images, each opened large with a click.
  const gallery = (figs: Shown[]): HTMLElement => {
    const wrap = el('div', 'figs')
    for (const f of figs) {
      const fig = el('figure')
      const img = el('img', 'zoom')
      img.src = f.url
      img.alt = f.title
      img.loading = 'lazy'
      img.referrerPolicy = 'no-referrer'
      fig.append(img)
      if (f.title) fig.append(el('figcaption', '', f.title))
      wrap.append(fig)
    }
    return wrap
  }

  const answer = (a: Answer) => {
    const box = el('div', 'msg bot')
    // The images with a number go where the text marks them; the others under it.
    const figs = figures(a.images ?? [], opts.base, 40)
    box.innerHTML = render(a.text ?? '', byNumber(figs))
    const loose = figs.filter((f) => f.n === undefined).slice(0, 8)
    if (loose.length) box.append(gallery(loose))
    const more = figures(a.more_images ?? [], opts.base, 12)
    if (more.length) {
      const d = el('details', 'more')
      d.append(el('summary', '', `Altre immagini (${more.length})`), gallery(more))
      box.append(d)
    }
    const groups = groupSources(a.sources ?? [])
    if (groups.length) {
      const src = el('div', 'sources')
      src.append(document.createTextNode('Fonti: '))
      groups.forEach((g, i) => {
        if (i) src.append(document.createTextNode(' · '))
        const name = `[${g.numbers.join(', ')}] ${g.name}`
        if (g.url && /^https?:\/\//.test(g.url)) {
          const link = el('a', '', name)
          link.href = g.url
          link.target = '_blank'
          link.rel = 'noopener noreferrer'
          src.append(link)
        } else {
          src.append(document.createTextNode(name))
        }
      })
      box.append(src)
    }
    // The sources the pipeline hands as the documentation has them, each opened with a click.
    for (const s of a.sources ?? []) {
      if (!s.text) continue
      const d = el('details', 'src')
      const name = s.title || (s.doc ?? '').split('/').pop()?.replace(/\.md$/, '') || ''
      const where = s.section || s.sezione || ''
      d.append(el('summary', '', `[${s.n ?? ''}] ${name}${where ? ' › ' + where : ''}`))
      const body = el('div', 'srctext')
      body.innerHTML = render(s.text, byNumber(figures(s.images ?? [], opts.base, 40)))
      d.append(body)
      box.append(d)
    }
    if (a.turn) box.append(rateRow(a.turn))
    if (a.non_so && handoff) {
      const b = el('button', '', 'Vuoi parlare con una persona?')
      b.type = 'button'
      b.onclick = askPerson
      const row = el('div', 'rate')
      row.append(b)
      box.append(row)
    }
    log.append(box)
    log.scrollTop = log.scrollHeight
  }

  // again: the message sent once more, after an answer cut short.
  const submit = (again?: string) => {
    const message = again ?? input.value.trim()
    if (!message || send.disabled) return
    if (again === undefined) {
      log.append(el('div', 'msg me', message))
      input.value = ''
    }
    send.disabled = true
    const waiting = el('div', 'msg note', '…')
    log.append(waiting)
    log.scrollTop = log.scrollHeight
    // The text as it comes, drawn at most once a frame in a bubble of its
    // own, which the answer takes the place of.
    let box: HTMLDivElement | null = null
    let text = ''
    let frame = 0
    const draw = () => {
      frame = 0
      const shown = draft(text)
      if (!box) {
        if (!shown.trim()) return
        box = el('div', 'msg bot')
        box.setAttribute('aria-busy', 'true')
        waiting.replaceWith(box)
      }
      box.innerHTML = render(shown)
      log.scrollTop = log.scrollHeight
    }
    const onText = (kind: 'delta' | 'reset', piece: string) => {
      text = kind === 'reset' ? '' : text + piece
      if (!frame) frame = requestAnimationFrame(draw)
    }
    const body = JSON.stringify({ message, session, scopes: [...chosen], ...(asOf ? { as_of: asOf } : {}) })
    stream('/messages', body, onText)
      .then((r: { session: string; answer: Answer }) => {
        session = r.session
        storage()?.setItem(key, session)
        cancelAnimationFrame(frame)
        waiting.remove()
        box?.remove()
        answer(r.answer)
      })
      .catch((e: Error) => {
        cancelAnimationFrame(frame)
        if (frame || !box) draw()
        waiting.remove()
        const cut = box
        if (!cut) {
          note(e.message)
          return
        }
        // What arrived stays, grey, with the reason and the way to ask again.
        cut.classList.add('cut')
        cut.removeAttribute('aria-busy')
        const row = el('div', 'retry')
        const retry = el('button', '', 'Riprova')
        retry.type = 'button'
        retry.onclick = () => {
          if (send.disabled) return
          cut.remove()
          row.remove()
          submit(message)
        }
        row.append(el('span', '', e.message), retry)
        log.append(row)
        log.scrollTop = log.scrollHeight
      })
      .finally(() => {
        send.disabled = false
        input.focus()
      })
  }
  send.addEventListener('click', () => submit())
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      submit()
    }
  })
}

// The script mounts the chat its tag describes.
;(function auto() {
  const w = window as unknown as { GosidianChat?: unknown }
  w.GosidianChat = { mount, _internal: { render, escapeHtml, groupSources, scopeLevels, figures, byNumber, parseEvents, draft } }
  const script = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null
  if (!script?.dataset.bot) return
  const container = document.getElementById(script.dataset.container || '')
  if (!container) return
  const opts: ChatOptions = { bot: script.dataset.bot, base: new URL(script.src).origin, container }
  if (script.dataset.key) opts.key = script.dataset.key
  if (script.dataset.token) opts.token = script.dataset.token
  if (script.dataset.page) {
    opts.page = true
    const m = /(?:^#|&)token=([^&]+)/.exec(location.hash)
    if (m) {
      opts.token = decodeURIComponent(m[1])
      // The token leaves the address bar: it reaches no history or log.
      history.replaceState(null, '', location.pathname + location.search)
    }
  }
  mount(opts)
})()
