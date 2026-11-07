#!/usr/bin/env node
// Captures the Yjs state of a real local Supertask document page as a test
// fixture for st-richtext.
//
// Usage: node crates/st-richtext/tools/capture-fixture.cjs [pageId] [fixtureName]
//
// LOCAL ONLY: the API URL is hard-coded to http://127.0.0.1:8811.
//
// No Yjs state exists yet anywhere in the local environment: ContentRoomDO
// hands the WebSocket to Hocuspocus 4 with `handleConnection()` but never
// forwards the socket messages (`clientConnection.handleMessage()`), so the
// server never answers a sync and never writes the "ydoc" storage key.
// Versions in R2 hold the materialized JSON, not Yjs. The script therefore
// reproduces the room in-process, with the same libraries as the frontend
// and the server, starting from the page as the API serves it:
//  1. The room document is loaded like ContentRoomDO.onLoadDocument does
//     without stored state: the "supertask" map receives the materialized
//     content served by GET /api/collaboration/document-page/:id/materialized/.
//  2. Alice opens the page: the empty fragment is seeded from the page content
//     like page.vue does after the first sync (`setContent(content)` through
//     y-prosemirror) and mirrorMaterialized() runs.
//  3. Bruno opens the page in a second session and formats text and adds
//     blocks the way the TipTap toolbar would: the edited ProseMirror document
//     is synced into Yjs with y-prosemirror's `updateYFragment`, the function
//     the sync plugin runs on every editor transaction.
//  4. Every client update goes through the room (sync step 2 on join, then
//     incremental updates), and the fixture is `Y.encodeStateAsUpdate(room)`,
//     the bytes onStoreDocument writes under the "ydoc" key.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  CRATE, FRAGMENT, PMNode, Y, api, buildSchema, docFromUpdate, fragmentToProseMirror, login,
  normalize, yProsemirror,
} = require('./common.cjs')

const pageId = Number(process.argv[2] || 5)
const fixtureName = process.argv[3] || 'spec-export-pdf'
const schema = buildSchema()

const text = (value, marks) => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value })
const paragraph = (...content) => ({ type: 'paragraph', content: content.map((c) => (typeof c === 'string' ? text(c) : c)) })
const listItem = (...content) => ({ type: 'listItem', content })
const cell = (type, value) => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [paragraph(value)] })

/** The edit of the second session: formatting in an existing paragraph and new blocks. */
function richEdit(json) {
  const doc = structuredClone(json)
  const intro = doc.content.find((node) => node.type === 'paragraph' && node.content?.length === 1)
  if (intro) {
    const sentence = intro.content[0].text
    const [first, rest] = splitOnce(sentence, ' ')
    const [second, tail] = splitOnce(rest, ' ')
    intro.content = [text(`${first} `), text(second, [{ type: 'bold' }]), text(' '), text(tail.replace(/\.$/, ''), [{ type: 'italic' }]), text('.')]
  }
  doc.content.push(
    { type: 'heading', attrs: { level: 3 }, content: [text('Détails techniques')] },
    paragraph(
      'Voir la ',
      text('documentation', [{ type: 'link', attrs: { href: 'https://example.com/docs/export-pdf', target: '_blank', rel: 'noopener noreferrer nofollow', class: null } }]),
      ', le format ',
      text('A4', [{ type: 'bold' }, { type: 'italic' }]),
      ', les marges ',
      text('barrées', [{ type: 'strike' }]),
      ' ou ',
      text('soulignées', [{ type: 'underline' }]),
      '.',
    ),
    {
      type: 'orderedList',
      attrs: { start: 1 },
      content: [
        listItem(paragraph('Générer le PDF')),
        listItem(paragraph('Envoyer par e-mail'), {
          type: 'bulletList',
          content: [listItem(paragraph('au client')), listItem(paragraph('à l’équipe'))],
        }),
      ],
    },
    { type: 'blockquote', content: [paragraph('Un PDF doit rester lisible en noir et blanc.')] },
    { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('await exportPdf(page, { format: "A4" })')] },
    { type: 'horizontalRule' },
    paragraph('Ligne un', { type: 'hardBreak' }, 'ligne deux'),
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('tableHeader', 'Format'), cell('tableHeader', 'Taille')] },
        { type: 'tableRow', content: [cell('tableCell', 'A4'), cell('tableCell', '210 × 297 mm')] },
      ],
    },
    { type: 'callout', attrs: { type: 'warning', icon: '⚠️' }, content: [paragraph('Les images lourdes ralentissent l’export.')] },
    { type: 'image', attrs: { src: 'https://example.com/pdf-preview.png', alt: 'Aperçu' } },
    { type: 'paragraph' },
  )
  return doc
}

function splitOnce(value, separator) {
  const index = value.indexOf(separator)
  return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)]
}

/** What page.vue's mirrorMaterialized() writes next to the fragment. */
function materialized(page, content) {
  return { title: page.title, content, icon: page.icon, cover: page.cover, settings: {}, editor_schema_version: 1 }
}

/**
 * Joins a client document to the room: sync step 1/2 both ways, then relays
 * every later update, like the Hocuspocus provider and server do.
 */
function join(room, client) {
  Y.applyUpdate(client, Y.encodeStateAsUpdate(room, Y.encodeStateVector(client)), room)
  Y.applyUpdate(room, Y.encodeStateAsUpdate(client, Y.encodeStateVector(room)), client)
  const toRoom = (update, origin) => { if (origin !== room) Y.applyUpdate(room, update, client) }
  const toClient = (update, origin) => { if (origin !== client) Y.applyUpdate(client, update, room) }
  client.on('update', toRoom)
  room.on('update', toClient)
  return () => { client.off('update', toRoom); room.off('update', toClient) }
}

async function main() {
  const alice = await login('alice@example.com')
  const page = await api(alice, 'GET', `/document/pages/${pageId}/`)
  const served = await api(alice, 'GET', `/collaboration/document-page/${pageId}/materialized/`)

  // 1. ContentRoomDO.onLoadDocument without a stored "ydoc".
  const room = new Y.Doc()
  room.getMap('supertask').set('materialized', served.content)
  room.getMap('supertask').set('editor_schema_version', served.editor_schema_version)

  // 2. First opening: seed the empty fragment from the stored content.
  const first = new Y.Doc()
  const leaveFirst = join(room, first)
  const fragment = first.getXmlFragment(FRAGMENT)
  if (fragment.length !== 0) throw new Error('the room fragment should start empty')
  const stored = page.content && Object.keys(page.content).length ? page.content : { type: 'doc', content: [{ type: 'paragraph' }] }
  first.transact(() => {
    yProsemirror.updateYFragment(first, fragment, PMNode.fromJSON(schema, stored), { mapping: new Map(), isOMark: new Map() })
  }, yProsemirror.ySyncPluginKey)
  first.getMap('supertask').set('materialized', materialized(page, fragmentToProseMirror(first, schema)))
  leaveFirst()

  // 3. A second member formats text and adds blocks.
  const second = new Y.Doc()
  const leaveSecond = join(room, second)
  const { doc: current, meta } = yProsemirror.initProseMirrorDoc(second.getXmlFragment(FRAGMENT), schema)
  const edited = PMNode.fromJSON(schema, richEdit(current.toJSON()))
  second.transact(() => {
    yProsemirror.updateYFragment(second, second.getXmlFragment(FRAGMENT), edited, meta)
  }, yProsemirror.ySyncPluginKey)
  second.getMap('supertask').set('materialized', materialized(page, edited.toJSON()))
  leaveSecond()

  // 4. What onStoreDocument persists.
  const update = Y.encodeStateAsUpdate(room)
  const json = fragmentToProseMirror(docFromUpdate(update), schema)
  const dir = path.join(CRATE, 'tests/fixtures')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${fixtureName}.yjs`), update)
  fs.writeFileSync(path.join(dir, `${fixtureName}.prosemirror.json`), `${JSON.stringify(normalize(json), null, 2)}\n`)
  const clients = [...Y.decodeStateVector(Y.encodeStateVector(room)).keys()]
  console.log(`page ${pageId} "${page.title}": ${update.length} bytes, ${json.content.length} top-level nodes, ${clients.length} clients`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
