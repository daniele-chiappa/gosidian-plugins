// The widget's rendering, in a context of its own: an answer is escaped
// before its marks become HTML, and only http(s) links are links.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const code = readFileSync(new URL('../dist/chat.js', import.meta.url), 'utf8')
const window = {}
vm.runInNewContext(code, { window, document: undefined, console })
const { render, escapeHtml, groupSources, scopeLevels } = window.GosidianChat._internal

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
