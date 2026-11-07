// Shared helpers for the st-richtext verification scripts.
//
// The scripts must use the exact JavaScript stack of the Supertask frontend
// (yjs, y-prosemirror, TipTap), so every module is resolved from
// frontend/node_modules instead of a separate install: a second copy of yjs
// would break `instanceof` checks inside y-prosemirror.
'use strict'

const path = require('node:path')
const { createRequire } = require('node:module')
const { execFileSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '../../..')
const CRATE = path.resolve(__dirname, '..')
const frontendRequire = createRequire(path.join(REPO, 'frontend/package.json'))

const Y = frontendRequire('yjs')
const yProsemirror = frontendRequire('y-prosemirror')
const { Node: PMNode } = frontendRequire('prosemirror-model')
const tiptap = frontendRequire('@tiptap/core')

/** The XmlFragment name used by `Collaboration.configure({ field: 'default' })` in page.vue. */
const FRAGMENT = 'default'

/**
 * Builds the ProseMirror schema of the document page editor.
 *
 * Mirrors `getConfiguredExtensions()` of RichTextEditor.vue with
 * `enableRichTextFormatting` plus the `customExtensions` of
 * frontend/modules/documents/pages/page.vue. Extensions without a schema
 * (placeholder, markdown, drag handle, file handler, slash command,
 * collaboration) are left out because they do not change the document shape.
 */
function buildSchema() {
  const ext = (name) => frontendRequire(name)
  // The callout node imports a Vue component, so its schema is restated here.
  const Callout = tiptap.Node.create({
    name: 'callout',
    group: 'block',
    content: 'block+',
    addAttributes() {
      return { type: { default: 'info' }, icon: { default: '💡' } }
    },
  })
  const extensions = [
    ext('@tiptap/extension-document').Document,
    ext('@tiptap/extension-paragraph').Paragraph,
    ext('@tiptap/extension-text').Text,
    ext('@tiptap/extension-hard-break').HardBreak,
    ext('@tiptap/extension-heading').Heading.configure({ levels: [1, 2, 3] }),
    ext('@tiptap/extension-list-item').ListItem,
    ext('@tiptap/extension-ordered-list').OrderedList,
    ext('@tiptap/extension-bullet-list').BulletList,
    ext('@tiptap/extension-code-block').CodeBlock,
    ext('@tiptap/extension-blockquote').Blockquote,
    ext('@tiptap/extension-horizontal-rule').HorizontalRule,
    ext('@tiptap/extension-task-item').TaskItem,
    ext('@tiptap/extension-task-list').TaskList,
    ext('@tiptap/extension-bold').Bold,
    ext('@tiptap/extension-italic').Italic,
    ext('@tiptap/extension-strike').Strike,
    ext('@tiptap/extension-underline').Underline,
    ext('@tiptap/extension-subscript').Subscript,
    ext('@tiptap/extension-superscript').Superscript,
    ext('@tiptap/extension-link').Link.configure({
      protocols: [
        { scheme: 'ftp' },
        { scheme: 'mailto', optionalSlashes: true },
        { scheme: 'tel', optionalSlashes: true },
      ],
      autolink: false,
      openOnClick: false,
    }),
    ext('@tiptap/extension-table').Table.configure({ resizable: true }),
    ext('@tiptap/extension-table-row').TableRow,
    ext('@tiptap/extension-table-header').TableHeader,
    ext('@tiptap/extension-table-cell').TableCell,
    ext('@tiptap/extension-image').Image.configure({ inline: false, allowBase64: false }),
    ext('@tiptap/extension-youtube').Youtube.configure({ controls: true, nocookie: true }),
    Callout,
  ]
  return tiptap.getSchema(extensions)
}

/**
 * Converts the fragment the way the TipTap editor would load it, and fails
 * when y-prosemirror had to repair the Yjs document.
 *
 * `yXmlFragmentToProseMirrorRootNode` silently deletes Yjs nodes that do not
 * fit the schema, so an unchanged state vector proves the document is valid.
 */
function fragmentToProseMirror(ydoc, schema) {
  const before = Buffer.from(Y.encodeStateVector(ydoc)).toString('base64')
  const node = yProsemirror.yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(FRAGMENT), schema)
  const after = Buffer.from(Y.encodeStateVector(ydoc)).toString('base64')
  if (before !== after) throw new Error('y-prosemirror repaired the document: it does not fit the TipTap schema')
  node.check()
  return node.toJSON()
}

/**
 * Normalizes ProseMirror JSON so that a schema-aware export (TipTap) and a
 * schema-less one (the Rust model) compare equal.
 *
 * y-prosemirror never stores null attributes, so the Rust side cannot know
 * them; marks are sorted because their order follows the schema rank, which
 * the Rust model does not know either. Adjacent text nodes with the same marks
 * are merged, as ProseMirror itself does.
 */
function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize)
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const key of Object.keys(node).sort()) {
    const value = node[key]
    if (key === 'attrs') {
      const attrs = {}
      for (const name of Object.keys(value || {}).sort()) {
        if (value[name] !== null && value[name] !== undefined) attrs[name] = value[name]
      }
      if (Object.keys(attrs).length) out.attrs = attrs
    } else if (key === 'marks') {
      const marks = normalize(value).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      if (marks.length) out.marks = marks
    } else if (key === 'content') {
      const content = []
      for (const child of normalize(value)) {
        const last = content[content.length - 1]
        if (last && last.type === 'text' && child.type === 'text'
          && JSON.stringify(last.marks || []) === JSON.stringify(child.marks || [])) {
          last.text += child.text
        } else {
          content.push(child)
        }
      }
      if (content.length) out.content = content
    } else {
      out[key] = value
    }
  }
  return out
}

/** Loads a binary Yjs update into a fresh document. */
function docFromUpdate(bytes) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(bytes))
  return doc
}

/**
 * Runs an example of the st-richtext crate and returns its stdout.
 *
 * `ST_RICHTEXT_WORKSPACE` can point at another workspace containing the
 * crate, for when the repository workspace does not build.
 */
function runExample(name, args) {
  const env = { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || path.join(REPO, 'target/richtext') }
  const cargo = process.env.CARGO || path.join(process.env.HOME, '.cargo/bin/cargo')
  return execFileSync(cargo, ['run', '--quiet', '-p', 'st-richtext', '--example', name, '--', ...args], {
    cwd: process.env.ST_RICHTEXT_WORKSPACE || REPO,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** Signs in to the local API (never production: the URL is fixed to 127.0.0.1). */
async function login(email, password = 'Supertask-test-2026') {
  const response = await fetch(`${API}/api/user/token-auth/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) throw new Error(`login ${email}: HTTP ${response.status}`)
  return (await response.json()).access_token
}

async function api(token, method, route, body) {
  const response = await fetch(`${API}/api${route}`, {
    method,
    headers: { Authorization: `JWT ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${await response.text()}`)
  return response.status === 204 ? null : response.json()
}

const API = 'http://127.0.0.1:8811'

/**
 * Opens the collaboration room of a document page exactly like page.vue does
 * (same URL, same room name, same Hocuspocus provider) and resolves once the
 * initial sync with the Durable Object is done.
 *
 * Not used by the scripts yet: ContentRoomDO does not forward the socket
 * messages to Hocuspocus 4, so the sync never completes (see PROTOTYPE.md).
 * Kept for an end-to-end check once the room answers.
 */
function connectPage(pageId, token, doc) {
  const { HocuspocusProvider } = frontendRequire('@hocuspocus/provider')
  const url = `${API.replace(/^http/, 'ws')}/ws/collaboration/document-page/${pageId}/?editor_schema_version=1&jwt_token=${encodeURIComponent(token)}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('collaboration sync timed out')), 15_000)
    const provider = new HocuspocusProvider({
      url,
      name: `document-page:${pageId}`,
      document: doc,
      token,
      onSynced: () => { clearTimeout(timer); resolve(provider) },
      onAuthenticationFailed: ({ reason }) => { clearTimeout(timer); reject(new Error(`authentication failed: ${reason}`)) },
    })
  })
}

/** Waits until the provider has no unsynced local changes, then closes it. */
async function closeWhenSynced(provider) {
  const deadline = Date.now() + 15_000
  while (provider.unsyncedChanges > 0) {
    if (Date.now() > deadline) throw new Error('local changes were not acknowledged by the server')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  provider.destroy()
}

module.exports = {
  API,
  CRATE,
  FRAGMENT,
  PMNode,
  REPO,
  Y,
  api,
  buildSchema,
  closeWhenSynced,
  connectPage,
  docFromUpdate,
  fragmentToProseMirror,
  frontendRequire,
  login,
  normalize,
  runExample,
  yProsemirror,
}
