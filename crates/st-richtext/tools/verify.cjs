#!/usr/bin/env node
// Checks, with the real yjs + y-prosemirror + TipTap schema of the frontend,
// that st-richtext reads and writes Supertask documents compatibly.
//
// Usage: node crates/st-richtext/tools/verify.cjs [fixture.yjs]
//
//  (a) read: the Rust model of the fixture equals what y-prosemirror builds
//      from the same Yjs state (yXmlFragmentToProseMirrorRootNode);
//  (b) write: the Yjs updates produced by edits made through the egui widget
//      (examples/edit.rs) apply in Node, need no repair by y-prosemirror,
//      contain exactly the edits, and keep `supertask.materialized` in sync;
//  (c) merge: the Rust updates and a concurrent TipTap edit converge to the
//      same document in any order, and Rust reads the merged state the same.
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  CRATE, FRAGMENT, PMNode, Y, buildSchema, docFromUpdate, fragmentToProseMirror, normalize,
  runExample, yProsemirror,
} = require('./common.cjs')

const fixturePath = path.resolve(process.argv[2] || path.join(CRATE, 'tests/fixtures/spec-export-pdf.yjs'))
const fixture = fs.readFileSync(fixturePath)
const schema = buildSchema()
const fromHex = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'))
const textOf = (node) => (node.text || '') + (node.content || []).map(textOf).join('')
let checks = 0

function check(name, actual, expected) {
  assert.deepStrictEqual(normalize(actual), normalize(expected), name)
  checks += 1
  console.log(`ok - ${name}`)
}

/** The fixture as y-prosemirror sees it, with the edits of examples/edit.rs applied by hand. */
function expectedAfterRustEdits(json) {
  const doc = structuredClone(json)
  const blocks = doc.content
  const introIndex = blocks.findIndex((b) => b.type === 'paragraph' && textOf(b) === 'Comportement attendu et cas limites.')
  assert.ok(introIndex >= 0, 'intro paragraph present')
  blocks[introIndex].content.push(
    { type: 'text', text: ' Voir aussi la ' },
    { type: 'text', text: 'FAQ', marks: [{ type: 'bold' }] },
  )
  blocks.splice(introIndex + 1, 0, {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Nouveau paragraphe écrit depuis ' },
      { type: 'text', text: 'Rust', marks: [{ type: 'italic' }] },
      { type: 'text', text: '.' },
    ],
  })
  const list = blocks.find((b) => b.type === 'bulletList')
  const item = list.content.findIndex((i) => textOf(i) === 'Valider')
  list.content.splice(item + 1, 0, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tester' }] }] })
  const broken = blocks.find((b) => b.type === 'paragraph' && (b.content || []).some((c) => c.type === 'hardBreak'))
  broken.content = [{ type: 'text', text: 'Ligne unligne deux' }]
  return doc
}

/** A concurrent edit made by a TipTap user, synced through y-prosemirror like the sync plugin does. */
function concurrentTipTapEdit() {
  const doc = docFromUpdate(fixture)
  const fragment = doc.getXmlFragment(FRAGMENT)
  const { doc: current, meta } = yProsemirror.initProseMirrorDoc(fragment, schema)
  const json = current.toJSON()
  json.content[0].content = [{ type: 'text', text: 'Spéc : export PDF et impression' }]
  json.content.push({ type: 'paragraph', content: [{ type: 'text', text: 'Ajout concurrent depuis TipTap.' }] })
  const before = Y.encodeStateVector(doc)
  doc.transact(() => yProsemirror.updateYFragment(doc, fragment, PMNode.fromJSON(schema, json), meta), yProsemirror.ySyncPluginKey)
  return { update: Y.encodeStateAsUpdate(doc, before), json }
}

function rustRead(update) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-richtext-')), 'state.yjs')
  fs.writeFileSync(file, update)
  return JSON.parse(runExample('dump', [file]))
}

// (a) Reading.
const original = fragmentToProseMirror(docFromUpdate(fixture), schema)
check('(a) Rust reads the fixture like y-prosemirror', JSON.parse(runExample('dump', [fixturePath])), original)
const golden = path.join(path.dirname(fixturePath), `${path.basename(fixturePath, '.yjs')}.prosemirror.json`)
if (fs.existsSync(golden)) check('(a) golden ProseMirror JSON is up to date', JSON.parse(fs.readFileSync(golden, 'utf8')), original)

// (b) Writing.
const rust = JSON.parse(runExample('edit', [fixturePath]))
const expected = expectedAfterRustEdits(original)
const incremental = docFromUpdate(fixture)
for (const update of rust.updates) Y.applyUpdate(incremental, fromHex(update))
const afterIncremental = fragmentToProseMirror(incremental, schema)
check(`(b) the ${rust.updates.length} incremental Rust updates give exactly the edits`, afterIncremental, expected)
const fromDiff = docFromUpdate(fixture)
Y.applyUpdate(fromDiff, fromHex(rust.diff))
check('(b) the Rust diff update gives the same document', fragmentToProseMirror(fromDiff, schema), expected)
const materialized = incremental.getMap('supertask').get('materialized')
check('(b) supertask.materialized.content follows the fragment', materialized.content, afterIncremental)
assert.equal(materialized.title, 'Spéc : export PDF', 'materialized title kept')
assert.ok(Y.decodeStateVector(Y.encodeStateVector(incremental)).has(rust.client_id), 'Rust client id in the state vector')
checks += 2
console.log('ok - (b) materialized title kept, Rust client id present')

// (c) Concurrency.
const tiptap = concurrentTipTapEdit()
const rustFirst = docFromUpdate(fixture)
for (const update of rust.updates) Y.applyUpdate(rustFirst, fromHex(update))
Y.applyUpdate(rustFirst, tiptap.update)
const tiptapFirst = docFromUpdate(fixture)
Y.applyUpdate(tiptapFirst, tiptap.update)
Y.applyUpdate(tiptapFirst, fromHex(rust.diff))
const merged = fragmentToProseMirror(rustFirst, schema)
check('(c) Rust and TipTap edits converge in any order', fragmentToProseMirror(tiptapFirst, schema), merged)
const both = expectedAfterRustEdits(tiptap.json)
check('(c) the merged document has both edits', merged, both)
check('(c) Rust reads the merged state like y-prosemirror', rustRead(Y.encodeStateAsUpdate(rustFirst)), merged)

console.log(`\n${checks} checks passed`)
