import { createHash } from 'node:crypto'

/**
 * Turn whatever a source hands us into one candidate shape.
 *
 * Sources give us two different things:
 *   - AppView post views (getAuthorFeed, searchPosts): { uri, cid, author, record, embed, labels }
 *   - Raw records from Jetstream commits:               { uri, cid, did, record }
 *
 * Show announcements often put the useful details somewhere other than the
 * post text: a link card (ticket page title), image alt text (the flyer), or
 * a quoted post. All of that is folded into `text` so the prefilter and the
 * LLM see it.
 */
export function fromPostView(post, source) {
  const record = post.record ?? {}
  return build({
    uri: post.uri,
    cid: post.cid,
    authorDid: post.author?.did,
    authorHandle: post.author?.handle,
    record,
    embedView: post.embed,
    labels: (post.labels ?? []).map((l) => l.val),
    source,
  })
}

export function fromJetstreamCommit(evt) {
  const { did, commit } = evt
  return build({
    uri: `at://${did}/${commit.collection}/${commit.rkey}`,
    cid: commit.cid,
    authorDid: did,
    authorHandle: null,
    record: commit.record ?? {},
    embedView: null,
    labels: (commit.record?.labels?.values ?? []).map((l) => l.val),
    source: 'jetstream',
  })
}

function build({ uri, cid, authorDid, authorHandle, record, embedView, labels, source }) {
  const parts = [record.text ?? '']
  parts.push(...embedText(embedView ?? record.embed))
  const text = parts.map((s) => s.trim()).filter(Boolean).join('\n\n')
  return {
    uri,
    cid,
    authorDid,
    authorHandle,
    text,
    createdAt: safeDate(record.createdAt),
    isReply: Boolean(record.reply),
    labels,
    source,
    textHash: textHash(text),
  }
}

/** Pull human-readable text out of an embed (view or record form). */
export function embedText(embed) {
  if (!embed) return []
  const out = []
  const t = embed.$type ?? ''

  if (embed.external) {
    const { title, description, uri } = embed.external
    out.push(['[link]', title, description, uri].filter(Boolean).join(' '))
  }
  if (Array.isArray(embed.images)) {
    for (const img of embed.images) if (img.alt) out.push(`[image] ${img.alt}`)
  }
  // Quoted post: view form has embed.record.value / .text; record form only has a strong ref.
  if (t.startsWith('app.bsky.embed.record') && embed.record) {
    const quoted = embed.record.record ?? embed.record
    const value = quoted.value ?? quoted
    if (typeof value.text === 'string') out.push(`[quote] ${value.text}`)
  }
  // recordWithMedia nests media separately
  if (embed.media) out.push(...embedText(embed.media))
  return out
}

/** Hash of the text with links, mentions, case, and punctuation stripped. */
export function textHash(text) {
  const norm = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@[\w.-]+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return createHash('sha256').update(norm).digest('hex').slice(0, 32)
}

function safeDate(v) {
  const d = v ? new Date(v) : null
  return d && !Number.isNaN(d.getTime()) ? d : new Date(0)
}
