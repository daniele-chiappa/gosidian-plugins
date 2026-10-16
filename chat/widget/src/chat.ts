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
}

interface Figure {
  url?: string
  title?: string
}

interface Answer {
  text?: string
  sources?: Source[]
  turn?: string
  images?: Figure[]
  non_so?: boolean
}

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

/** An answer as HTML: escaped first, then paragraphs and lists. */
function render(text: string): string {
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
    const ul = /^\s*[-*]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      flush()
      const kind = ul ? 'ul' : 'ol'
      if (list !== kind) {
        close()
        out.push(`<${kind}>`)
        list = kind
      }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`)
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

/** The images of an answer the widget shows: http(s) addresses only, at
 *  most eight. One the plugin serves (/api/bots/<bot>/images/…) is taken
 *  from base, where the widget came from: the plugin may be reached at
 *  another address than its CHAT_PUBLIC_URL (a tunnel, a LAN). */
function figures(list: Figure[], base = ''): { url: string; title: string }[] {
  return list
    .filter((f) => typeof f.url === 'string' && /^https?:\/\//.test(f.url))
    .slice(0, 8)
    .map((f) => {
      let url = f.url as string
      const own = /^https?:\/\/[^/]+(\/api\/bots\/[^/?#]+\/images\/[0-9a-f]+)$/.exec(url)
      if (base && own) url = base + own[1]
      return { url, title: f.title || '' }
    })
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
.figs figcaption { font-size: 11px; color: var(--muted); margin-top: 2px; }
.person { display: flex; justify-content: flex-end; padding: 0 14px 8px; }
.person button, .ask button { font: inherit; font-size: 12px; border: 1px solid var(--line); background: var(--bg); color: var(--accent); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
.ask { display: flex; flex-direction: column; gap: 6px; }
.ask textarea, .ask input { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 6px; }
.ask .row { display: flex; gap: 6px; justify-content: flex-end; }
.compose { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); }
textarea { flex: 1; resize: none; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
.compose button { font: inherit; border: 0; border-radius: 6px; padding: 0 14px; background: var(--accent); color: #fff; cursor: pointer; }
.compose button:disabled { opacity: .6; cursor: default; }
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
  wrap.append(chat)
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

  const answer = (a: Answer) => {
    const box = el('div', 'msg bot')
    box.innerHTML = render(a.text ?? '')
    const figs = figures(a.images ?? [], opts.base)
    if (figs.length) {
      const wrap = el('div', 'figs')
      for (const f of figs) {
        const fig = el('figure')
        const link = el('a')
        link.href = f.url
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        const img = el('img')
        img.src = f.url
        img.alt = f.title
        img.loading = 'lazy'
        img.referrerPolicy = 'no-referrer'
        link.append(img)
        fig.append(link)
        if (f.title) fig.append(el('figcaption', '', f.title))
        wrap.append(fig)
      }
      box.append(wrap)
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

  const submit = () => {
    const message = input.value.trim()
    if (!message || send.disabled) return
    log.append(el('div', 'msg me', message))
    input.value = ''
    send.disabled = true
    const waiting = el('div', 'msg note', '…')
    log.append(waiting)
    log.scrollTop = log.scrollHeight
    call('/messages', { method: 'POST', body: JSON.stringify({ message, session, scopes: [...chosen], ...(asOf ? { as_of: asOf } : {}) }) })
      .then((r: { session: string; answer: Answer }) => {
        session = r.session
        storage()?.setItem(key, session)
        waiting.remove()
        answer(r.answer)
      })
      .catch((e: Error) => {
        waiting.remove()
        note(e.message)
      })
      .finally(() => {
        send.disabled = false
        input.focus()
      })
  }
  send.addEventListener('click', submit)
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
  w.GosidianChat = { mount, _internal: { render, escapeHtml, groupSources, scopeLevels, figures } }
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
