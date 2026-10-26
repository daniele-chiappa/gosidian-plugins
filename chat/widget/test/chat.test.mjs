// The widget's rendering, in a context of its own: an answer is escaped
// before its marks become HTML, and only http(s) links are links.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const code = readFileSync(new URL('../dist/chat.js', import.meta.url), 'utf8')
const window = {}
vm.runInNewContext(code, { window, document: undefined, console })
const { render, escapeHtml, groupSources, scopeLevels, figures, byNumber, parseEvents, draft } = window.GosidianChat._internal

test('escapes the markup of an answer', () => {
  assert.equal(escapeHtml(`<b a="1">'x'&</b>`), '&lt;b a=&quot;1&quot;&gt;&#39;x&#39;&amp;&lt;/b&gt;')
  assert.equal(render('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>')
})

test('bold, code, citations and http links', () => {
  assert.equal(render('Apri **Impostazioni** e premi `Salva` [2].'),
    '<p>Apri <strong>Impostazioni</strong> e premi <code>Salva</code> <sup class="cite">[2]</sup>.</p>')
  assert.equal(render('[guida](https://docs.example.com/a?b=1&c=2)'),
    '<p><a href="https://docs.example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">guida</a></p>')
})

test('no link but http and https, and no way out of an attribute', () => {
  assert.equal(render('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>')
  const html = render('[x](https://a.example/"onmouseover="alert(1))')
  assert.ok(!html.includes('"onmouseover'), html)
})

test('citations of several sources', () => {
  assert.equal(render('Vedi [1, 5].'), '<p>Vedi <sup class="cite">[1, 5]</sup>.</p>')
})

test('the sources by document', () => {
  const g = groupSources([{ n: 1, doc: 'p/a/Doc A.md', url: 'https://x/a' }, { n: 2, doc: 'p/b/Doc B.md' }, { n: 3, doc: 'p/a/Doc A.md' }, { n: 4 }])
  assert.deepEqual(JSON.parse(JSON.stringify(g)), [{ name: 'Doc A', url: 'https://x/a', numbers: [1, 3] }, { name: 'Doc B', numbers: [2] }])
})

test('lists and paragraphs', () => {
  assert.equal(render('Passi:\n- uno\n- due\n\n1. a\n2. b\nfine'),
    '<p>Passi:</p><ul><li>uno</li><li>due</li></ul><ol><li>a</li><li>b</li></ol><p>fine</p>')
})

test('a select per level of nested scopes, down the chosen ones', () => {
  const tree = [
    { name: 'cucina', label: 'Cucina', children: [{ name: 'primi', children: [{ name: 'pasta-fresca' }] }, { name: 'dolci' }] },
    { name: 'attrezzi', label: 'Attrezzi' },
  ]
  const names = (lv) => JSON.parse(JSON.stringify(lv.map((l) => [l.options.map((o) => o.name), l.value])))
  assert.deepEqual(names(scopeLevels(tree, [])), [[['cucina', 'attrezzi'], '']])
  assert.deepEqual(names(scopeLevels(tree, ['cucina'])), [[['cucina', 'attrezzi'], 'cucina'], [['primi', 'dolci'], '']])
  assert.deepEqual(names(scopeLevels(tree, ['cucina', 'primi', 'pasta-fresca'])).length, 3)
  assert.deepEqual(names(scopeLevels(tree, ['attrezzi'])), [[['cucina', 'attrezzi'], 'attrezzi']])
  // A name that is not among the options stops there.
  assert.deepEqual(names(scopeLevels(tree, ['cucina', 'altro'])), [[['cucina', 'attrezzi'], 'cucina'], [['primi', 'dolci'], '']])
})

test('the images of an answer: http(s) only, at most eight', () => {
  const f = figures([{ url: 'https://chat.example.com/api/bots/b/images/1', title: 'Menu' }, { url: 'javascript:alert(1)' }, { title: 'none' },
    ...Array.from({ length: 10 }, (_, i) => ({ url: `http://x/${i}` }))])
  assert.equal(f.length, 8)
  assert.deepEqual(JSON.parse(JSON.stringify(f[0])), { url: 'https://chat.example.com/api/bots/b/images/1', title: 'Menu' })
  assert.ok(f.every((x) => x.url.startsWith('http')))
})

test('an image the plugin serves comes from where the widget came from', () => {
  const f = figures([{ url: 'http://127.0.0.1:8095/api/bots/b/images/0a1f', title: 'x' }, { url: 'https://docs.example.com/a.png' }], 'http://192.0.2.5:8095')
  assert.equal(f[0].url, 'http://192.0.2.5:8095/api/bots/b/images/0a1f')
  assert.equal(f[1].url, 'https://docs.example.com/a.png')
})

test('an image where the text marks it, the list going on with its numbers', () => {
  const figs = byNumber(figures([{ n: 2, url: 'https://c.example/api/bots/b/images/0a', title: 'Finestra "Ordini" <b>' }, { url: 'https://c.example/x.png' }], '', 40))
  assert.equal(figs.size, 1)
  const html = render('Passi:\n1. apri\n[img:2]\n2. salva\n[img:9]\nfine', figs)
  assert.equal(html, '<p>Passi:</p><ol><li>apri</li></ol>' +
    '<figure class="fig"><img class="zoom" src="https://c.example/api/bots/b/images/0a" alt="Finestra &quot;Ordini&quot; &lt;b&gt;" loading="lazy" referrerpolicy="no-referrer">' +
    '<figcaption>Finestra &quot;Ordini&quot; &lt;b&gt;</figcaption></figure><ol start="2"><li>salva</li></ol><p>fine</p>')
  // Inside a line, a mark is text; a heading is a line of its own.
  assert.equal(render('vedi [img:2] qui\n## Avvio', figs), '<p>vedi [img:2] qui</p><p class="h">Avvio</p>')
})

test('an image without a number keeps none, and the widget takes forty at most where asked', () => {
  const f = figures(Array.from({ length: 50 }, (_, i) => ({ n: i, url: `https://x/${i}` })), '', 40)
  assert.equal(f.length, 40)
  assert.equal(JSON.parse(JSON.stringify(figures([{ url: 'https://x/a' }])))[0].n, undefined)
})

test('the events of a stream, an event cut in two waits for its end', () => {
  const plain = (v) => JSON.parse(JSON.stringify(v))
  const a = parseEvents(': open\n\nevent: delta\ndata: {"text":"Ciao"}\n\nevent: delta\ndata: {"te')
  assert.deepEqual(plain(a.events), [{ event: 'delta', data: '{"text":"Ciao"}' }])
  const b = parseEvents(a.rest + 'xt":" mondo"}\r\n\nevent: answer\ndata: {"a":1}\ndata: {"b":2}\n\n')
  assert.deepEqual(plain(b.events), [{ event: 'delta', data: '{"text":" mondo"}' }, { event: 'answer', data: '{"a":1}\n{"b":2}' }])
  assert.equal(b.rest, '')
})

test('an answer as it comes: no lines of marks, no mark still open', () => {
  assert.equal(draft('Apri il menu.\n\n[img:3]\n\nPoi salva [1'), 'Apri il menu.\n\n\nPoi salva ')
  assert.equal(draft('Vedi [1] e [immagine 2]\n[immagine 4]'), 'Vedi [1] e [immagine 2]')
  assert.equal(draft('Un [link](https://x'), 'Un [link](https://x')
  assert.equal(draft('Testo intero.'), 'Testo intero.')
})
