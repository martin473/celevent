/**
 * Ticketmaster Discovery API: every music event Ticketmaster/Live Nation
 * sells within `ticketmaster.radius_miles` of the region center. This covers
 * the big rooms whose own sites load listings with JavaScript (Stage AE,
 * the Roxian, PPG Paints Arena, Petersen, ...), as clean structured data.
 *
 * Free key at developer.ticketmaster.com (TICKETMASTER_API_KEY).
 * Quota: 5000 calls/day, 5/second; one refresh uses at most ~5 calls.
 */

const BASE = 'https://app.ticketmaster.com/discovery/v2/events.json'

// Ticketmaster lists add-ons as separate "events".
const NOT_A_SHOW = /\b(parking|vip|package|upgrade|add[- ]?on|meet ?& ?greet|lounge access|suite|souvenir|merch|shuttle|camping|locker)\b/i

export async function fetchTicketmasterEvents({ apiKey, config, today, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const tm = config.ticketmaster ?? {}
  const { lat, lon } = config.region.center
  const end = new Date(Date.parse(today) + (tm.days_ahead ?? 30) * 864e5)
  const params = new URLSearchParams({
    apikey: apiKey,
    classificationName: 'music',
    geoPoint: geohash(lat, lon, 7),
    radius: String(tm.radius_miles ?? 20),
    unit: 'miles',
    startDateTime: `${today}T00:00:00Z`,
    endDateTime: `${end.toISOString().slice(0, 10)}T23:59:59Z`,
    sort: 'date,asc',
    size: '200',
  })

  const events = []
  // Discovery only pages to the 1000th item (size * page < 1000).
  for (let page = 0; page < 5; page++) {
    params.set('page', String(page))
    const res = await fetchImpl(`${BASE}?${params}`, { signal: AbortSignal.timeout(20_000) })
    if (res.status === 429) { await sleep(1500); page--; continue }
    if (!res.ok) throw new Error(`ticketmaster ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    const data = await res.json()
    for (const e of data._embedded?.events ?? []) {
      const ev = normalize(e)
      if (ev) events.push(ev)
    }
    const totalPages = data.page?.totalPages ?? 0
    if (page + 1 >= totalPages) break
    await sleep(250) // stay well under 5 requests/second
  }

  // Same show listed several times (presales, ticket tiers): keep one.
  const seen = new Set()
  return events.filter((e) => {
    const k = `${e.date}|${e.venue}|${e.title}`.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function normalize(e) {
  const date = e.dates?.start?.localDate
  if (!date || e.dates?.status?.code === 'cancelled' || e.dates?.status?.code === 'postponed') return null
  if (NOT_A_SHOW.test(e.name ?? '')) return null
  const venue = e._embedded?.venues?.[0]
  if (!venue?.name) return null
  const segment = e.classifications?.[0]?.segment?.name
  return {
    title: e.name.trim(),
    headliner: e._embedded?.attractions?.[0]?.name ?? null,
    date,
    time: e.dates?.start?.timeTBA ? '' : formatTime(e.dates?.start?.localTime),
    venue: venue.name,
    url: e.url ?? '',
    is_music: !segment || segment === 'Music',
    is_local: true,
  }
}

function formatTime(t) {
  if (typeof t !== 'string') return ''
  const m = t.match(/^(\d{2}):(\d{2})/)
  if (!m) return ''
  const h = Number(m[1])
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`
}

/** Standard geohash, which Discovery's geoPoint parameter takes. */
export function geohash(lat, lon, precision = 7) {
  const chars = '0123456789bcdefghjkmnpqrstuvwxyz'
  let [latLo, latHi, lonLo, lonHi] = [-90, 90, -180, 180]
  let hash = ''
  let bit = 0
  let ch = 0
  let even = true
  while (hash.length < precision) {
    if (even) {
      const mid = (lonLo + lonHi) / 2
      if (lon >= mid) { ch = (ch << 1) | 1; lonLo = mid } else { ch <<= 1; lonHi = mid }
    } else {
      const mid = (latLo + latHi) / 2
      if (lat >= mid) { ch = (ch << 1) | 1; latLo = mid } else { ch <<= 1; latHi = mid }
    }
    even = !even
    if (++bit === 5) { hash += chars[ch]; bit = 0; ch = 0 }
  }
  return hash
}
