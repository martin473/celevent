/**
 * Cheap, deterministic filter that runs before the LLM. Its job is cost
 * control, not accuracy: it should rarely drop a real show announcement, and
 * it's fine if it lets plenty of junk through for the model to reject.
 *
 * Score = event signals + location signals. Posts from accounts the bot
 * follows (venues, promoters, bands) are trusted and need a lower score.
 */

const EVENT_PATTERNS = [
  /\b(tonight|tomorrow|this (fri|sat|sun|mon|tue|wed|thu)\w*|this weekend|next week)\b/i,
  /\b(mon|tue|wed|thu|fri|sat|sun)(day|s|\.)?\b/i,
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(st|nd|rd|th)?\b/i,
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/,
  /\b\d{1,2}(:\d{2})? ?(am|pm)\b/i,
  /\b(doors|tix|tickets|presale|on sale|sold out|lineup|all ages|21\+|18\+|cover|free show)\b/i,
  /\b(show|gig|concert|live music|set|headlin\w+|opening|support from|w\/)\b/i,
  /#calevent\b/i,
]

export function compileRegion(region) {
  const terms = [...region.location_terms, ...(region.venues ?? [])]
  const escaped = terms.map((t) => t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped.join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu')
}

/**
 * @returns {{ status: 'pending' | 'skipped', score: number, skipReason?: string }}
 */
export function prefilter(candidate, { config, regionRe, trustedDids, now = new Date() }) {
  const { sources: src, prefilter: pf } = config
  const text = candidate.text
  const lower = text.toLowerCase()
  const trusted = trustedDids.has(candidate.authorDid)

  const skip = (skipReason, score = 0) => ({ status: 'skipped', score, skipReason })

  if (!text.trim()) return skip('empty')
  if (candidate.isReply && !src.include_replies) return skip('reply')

  const ageHours = (now - candidate.createdAt) / 36e5
  if (ageHours > src.lookback_hours) return skip('too_old')
  if (ageHours < -1) return skip('future_timestamp')

  const blockedLabel = candidate.labels?.find((l) => pf.blocked_labels.includes(l))
  if (blockedLabel) return skip(`label:${blockedLabel}`)

  const blockTerm = pf.block_terms.find((t) => lower.includes(t.toLowerCase()))
  if (blockTerm) return skip(`block_term:${blockTerm}`)

  const eventHits = EVENT_PATTERNS.filter((re) => re.test(text)).length
  const localHit = regionRe.test(text) ? 1 : 0
  // Location usually matters more than any single event word, so weight it.
  const score = Math.min(eventHits, 3) + localHit * 2

  if (eventHits === 0) return skip('no_event_signal', score)
  const min = trusted ? pf.trusted_min_score : pf.min_score
  if (!trusted && !localHit) return skip('no_location_signal', score)
  if (score < min) return skip('low_score', score)

  return { status: 'pending', score }
}
