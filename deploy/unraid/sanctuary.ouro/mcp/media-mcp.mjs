#!/usr/bin/env node
// Sanctuary media MCP server — the Mendelow Cloud Butler's media surface.
//
// Design authority: the Butler's own tool-surface spec (Telegram msgs 1700-1713, 2026-09-19).
// Two hard constraints it set, enforced here:
//   1. Anything deterministic lives in the tool, not in the agent's reasoning.
//   2. No "call A, parse it, build B" — every return payload carries the cross-reference
//      fields needed to answer the obvious follow-up without a second call.
//
// Protocol: JSON-RPC 2.0 over stdio, newline framed, MCP 2024-11-05.

import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const CRED_PATH = process.env.SANCTUARY_MEDIA_CREDENTIALS ?? "/home/ouro/AgentBundles/sanctuary.ouro/mcp/media-credentials.json"

// Credentials are host-specific and deliberately NOT packaged. A fresh install
// has none, and the server must still start and list its tools — otherwise the
// whole MCP server fails to connect and the agent silently loses the surface.
// Missing credentials become a named, reportable per-call failure instead.
let cred = null
let credError = null
try {
  cred = JSON.parse(readFileSync(CRED_PATH, "utf8"))
} catch (e) {
  credError = `Media credentials are unavailable at ${CRED_PATH} (${e.code ?? e.message}). The media tools cannot reach Jellyseerr/Sonarr/Radarr/Prowlarr until that file is created.`
}

const SEERR = cred?.jellyseerr ?? { url: "", apiKey: "" }
const SONARR = cred?.sonarr ?? { url: "", apiKey: "" }
const RADARR = cred?.radarr ?? { url: "", apiKey: "" }
const PROWLARR = cred?.prowlarr ?? { url: "", apiKey: "" }
const JELLYFIN_WEB = cred?.jellyfinWebUrl ?? "https://media.mendelow.cloud"
// Optional: when the credential file carries { jellyfin: { url, apiKey } } the library
// is searched in Jellyfin too. Absent, title resolution uses Sonarr and Radarr only.
const JELLYFIN = cred?.jellyfin ?? { url: "", apiKey: "" }

const TIMEOUT_MS = 45_000
// Interactive release search queries every indexer live and can take minutes.
const SEARCH_TIMEOUT_MS = 180_000

// ---------------------------------------------------------------- http helpers

async function req(base, path, { key, header = "X-Api-Key", method = "GET", body, query, timeoutMs = TIMEOUT_MS } = {}) {
  let url = `${base}${path}`
  if (query) {
    const parts = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      // encodeURIComponent, not URLSearchParams: Jellyseerr rejects '+' for spaces.
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    if (parts.length) url += `?${parts.join("&")}`
  }
  const headers = { [header]: key, Accept: "application/json" }
  if (body !== undefined) headers["Content-Type"] = "application/json"
  let res
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new ServiceError(`${serviceOf(base)}_unreachable`, `${serviceOf(base)} did not respond: ${e.name === "TimeoutError" ? "timeout" : e.message}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new ServiceError(`${serviceOf(base)}_http_${res.status}`, `${serviceOf(base)} returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`)
  }
  if (res.status === 204) return null
  // Sonarr/Radarr answer some DELETEs with 200 and an empty body; that is success, not a parse failure.
  const raw = await res.text()
  return raw.trim() ? JSON.parse(raw) : null
}

function serviceOf(base) {
  if (base === SEERR.url) return "jellyseerr"
  if (base === SONARR.url) return "sonarr"
  if (base === RADARR.url) return "radarr"
  if (base === PROWLARR.url) return "prowlarr"
  if (JELLYFIN.url && base === JELLYFIN.url) return "jellyfin"
  return "service"
}

class ServiceError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

const seerr = (path, opts = {}) => req(SEERR.url, `/api/v1${path}`, { key: SEERR.apiKey, ...opts })
// Long enough that an ordinary slow start is not called dead, short enough that
// nobody waits a day for a release that was never going to arrive.
const STALL_AFTER_HOURS = 6

const sonarr = (path, opts = {}) => req(SONARR.url, `/api/v3${path}`, { key: SONARR.apiKey, ...opts })
const radarr = (path, opts = {}) => req(RADARR.url, `/api/v3${path}`, { key: RADARR.apiKey, ...opts })
const prowlarr = (path, opts = {}) => req(PROWLARR.url, `/api/v1${path}`, { key: PROWLARR.apiKey, ...opts })

// ------------------------------------------------------------------ mapping

// Jellyseerr media status codes.
const MEDIA_STATUS = { 1: "unknown", 2: "pending", 3: "processing", 4: "partially_available", 5: "available" }
const REQUEST_STATUS = { 1: "pending_approval", 2: "approved", 3: "declined", 4: "failed" }

const TMDB_GENRES = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary",
  18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
  9648: "Mystery", 10749: "Romance", 878: "Science Fiction", 10770: "TV Movie", 53: "Thriller",
  10752: "War", 37: "Western", 10759: "Action & Adventure", 10762: "Kids", 10763: "News",
  10764: "Reality", 10765: "Sci-Fi & Fantasy", 10766: "Soap", 10767: "Talk", 10768: "War & Politics",
}

function genreNames(item) {
  const ids = item.genreIds ?? (item.genres ?? []).map((g) => g.id)
  return ids.map((id) => TMDB_GENRES[id]).filter(Boolean)
}

function shelfItem(item) {
  const kind = item.mediaType === "tv" ? "series" : item.mediaType === "movie" ? "movie" : (item.firstAirDate ? "series" : "movie")
  const date = item.releaseDate ?? item.firstAirDate ?? ""
  const info = item.mediaInfo ?? {}
  const status = MEDIA_STATUS[info.status] ?? "not_on_shelf"
  return {
    title: item.title ?? item.name ?? null,
    year: date ? Number(date.slice(0, 4)) : null,
    kind,
    tmdb_id: item.id ?? null,
    tvdb_id: info.tvdbId ?? null,
    genres: genreNames(item),
    overview: typeof item.overview === "string" ? item.overview.slice(0, 400) : null,
    // The two fields that stop a second call:
    on_shelf: status === "available" || status === "partially_available",
    shelf_state: status,
    request_state: info.status ? (status === "available" ? "available" : status) : "never_requested",
    sonarr_id: info.externalServiceId ?? null,
    radarr_id: kind === "movie" ? (info.externalServiceId ?? null) : null,
    poster_path: item.posterPath ? `https://image.tmdb.org/t/p/w500${item.posterPath}` : null,
    vote_average: item.voteAverage ?? null,
  }
}

// ------------------------------------------------------- title resolution
//
// One resolver for every tool that takes a title. A title typed from memory is
// rarely the catalogue's title: "chef" is "The Chef Show", "chef shwo" is a typo.
// The 2026-09-29 failure was a library search that required the whole title and
// so reported a tracked series as nonexistent. Matching is therefore partial and
// typo-tolerant, in-library candidates always come first, and the TVDB/TMDB
// lookup only runs when the library has nothing.

export function normalizeTitle(s) {
  return String(s ?? "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/&/g, " and ").replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/^the /, "")
}

// Optimal-string-alignment distance: an adjacent swap ("shwo") costs one edit.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

const MATCH_RANK = { exact: 0, prefix: 1, token: 2, fuzzy: 3 }

// Returns "exact" | "prefix" | "token" | "fuzzy" | null.
export function matchKind(query, title) {
  const nq = normalizeTitle(query)
  const nt = normalizeTitle(title)
  if (!nq || !nt) return null
  if (nq === nt) return "exact"
  if (nt.startsWith(nq)) return "prefix"
  const qt = nq.split(" ")
  const tt = nt.split(" ")
  if (qt.every((q) => tt.some((t) => t === q || (q.length >= 3 && t.includes(q))))) return "token"
  if (nq.length >= 3 && nt.includes(nq)) return "token"
  // Typos. Short tokens must be exact; a 4-letter token may only be fuzzy when
  // another query token already matched exactly, so "chef" never drifts to "chess".
  const exactHit = (q) => tt.includes(q)
  const fuzzyHit = (q) => tt.some((t) => {
    if (q.length < 4 || t.length < 4) return false
    const tol = q.length >= 8 ? 2 : 1
    return editDistance(q, t) <= tol
  })
  const anyExact = qt.some(exactHit)
  const ok = qt.every((q) => exactHit(q) || (fuzzyHit(q) && (q.length >= 5 || (qt.length > 1 && anyExact))))
  return ok ? "fuzzy" : null
}

function rankCandidates(term, items) {
  return items
    .map((c) => ({ ...c, match: matchKind(term, c.title) }))
    .filter((c) => c.match)
    .sort((x, y) => MATCH_RANK[x.match] - MATCH_RANK[y.match]
      || Math.abs(normalizeTitle(x.title).length - normalizeTitle(term).length) - Math.abs(normalizeTitle(y.title).length - normalizeTitle(term).length))
}

const libraryCandidate = (kind, i) => ({ kind, source: kind === "series" ? "sonarr" : "radarr", service_id: i.id, title: i.title,
  year: i.year ?? null, tmdb_id: i.tmdbId ?? null, tvdb_id: i.tvdbId ?? null, in_library: true })

// Every library item whose title matches, best first. Sonarr and Radarr are the
// source of truth for what is tracked; Jellyfin (when configured) adds what is
// on the shelf and marks items it shares with them.
export async function findLibraryCandidates(term, kind = "any") {
  const jobs = []
  if (kind !== "movie") jobs.push(sonarr("/series").then((l) => (Array.isArray(l) ? l : []).map((i) => libraryCandidate("series", i))))
  if (kind !== "series") jobs.push(radarr("/movie").then((l) => (Array.isArray(l) ? l : []).map((i) => libraryCandidate("movie", i))))
  // One service being down must not hide the other's matches; say which failed.
  const settled = await Promise.allSettled(jobs)
  const notes = []
  for (const r of settled) if (r.status === "rejected") notes.push(`library_unavailable: ${r.reason?.message ?? r.reason}`)
  if (settled.every((r) => r.status === "rejected")) throw settled[0].reason
  let items = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []))
  if (JELLYFIN.url && JELLYFIN.apiKey) {
    try {
      const body = await req(JELLYFIN.url, "/Items", { key: JELLYFIN.apiKey, header: "X-Emby-Token",
        query: { searchTerm: term, IncludeItemTypes: kind === "series" ? "Series" : kind === "movie" ? "Movie" : "Series,Movie", Recursive: true, Limit: 25 } })
      for (const j of body?.Items ?? []) {
        const k = j.Type === "Series" ? "series" : "movie"
        const tmdb = Number(j.ProviderIds?.Tmdb ?? j.ProviderIds?.tmdb) || null
        const twin = items.find((i) => i.kind === k && ((tmdb && i.tmdb_id === tmdb) || normalizeTitle(i.title) === normalizeTitle(j.Name)))
        if (twin) twin.in_jellyfin = true
        else items.push({ kind: k, source: "jellyfin", service_id: null, jellyfin_id: j.Id ?? null, title: j.Name, year: j.ProductionYear ?? null,
          tmdb_id: tmdb, tvdb_id: null, in_library: true, in_jellyfin: true })
      }
    } catch (e) {
      notes.push(`jellyfin_unavailable: ${e.message}`)
    }
  }
  const ranked = rankCandidates(term, items)
  if (notes.length) Object.defineProperty(ranked, "notes", { value: notes, enumerable: false })
  return ranked
}

// The catalogue fallback, used only when the library has no candidate. These are
// titles Sonarr/Radarr could add, so they are labelled not_in_library.
export async function lookupCandidates(term, kind = "any") {
  const out = []
  const jobs = []
  if (kind !== "movie") jobs.push(sonarr("/series/lookup", { query: { term } }).then((l) => (Array.isArray(l) ? l : []).forEach((i) => out.push({ kind: "series", source: "sonarr_lookup", service_id: i.id ?? null, title: i.title, year: i.year ?? null, tmdb_id: i.tmdbId ?? null, tvdb_id: i.tvdbId ?? null, in_library: Boolean(i.id), match: matchKind(term, i.title) ?? "lookup" }))).catch(() => {}))
  if (kind !== "series") jobs.push(radarr("/movie/lookup", { query: { term } }).then((l) => (Array.isArray(l) ? l : []).forEach((i) => out.push({ kind: "movie", source: "radarr_lookup", service_id: i.id ?? null, title: i.title, year: i.year ?? null, tmdb_id: i.tmdbId ?? null, tvdb_id: null, in_library: Boolean(i.id), match: matchKind(term, i.title) ?? "lookup" }))).catch(() => {}))
  await Promise.all(jobs)
  return out.sort((x, y) => (MATCH_RANK[x.match] ?? 4) - (MATCH_RANK[y.match] ?? 4)).slice(0, 10)
}

// In-library candidates first; the lookup fallback only when there are none.
export async function resolveTitle(term, kind = "any") {
  const library = await findLibraryCandidates(term, kind)
  if (library.length) return { library_matches: library, lookup_candidates: [], not_in_library: false, notes: library.notes ?? [] }
  const lookup = (await lookupCandidates(term, kind)).filter((c) => !c.in_library).map((c) => ({ ...c, not_in_library: true }))
  return { library_matches: [], lookup_candidates: lookup, not_in_library: true, notes: [] }
}

// ------------------------------------------------------------- tool: search

export async function mediaSearch(a) {
  const kind = a.kind ?? "any"
  const limit = Math.min(Math.max(a.limit ?? 12, 1), 20)
  const onShelf = a.on_shelf // true | false | undefined(any)
  let raw = []
  let source

  if (a.query) {
    source = "title_search"
    const body = await seerr("/search", { query: { query: a.query, page: 1 } })
    raw = body.results ?? []
  } else {
    source = "discover"
    const keywordIds = []
    for (const kw of a.keywords ?? []) {
      const hit = await seerr("/search/keyword", { query: { query: kw, page: 1 } })
      const exact = (hit.results ?? []).find((k) => k.name.toLowerCase() === kw.toLowerCase()) ?? (hit.results ?? [])[0]
      if (exact) keywordIds.push(exact.id)
    }
    const genreIds = (a.genres ?? [])
      .map((name) => Number(Object.entries(TMDB_GENRES).find(([, v]) => v.toLowerCase() === String(name).toLowerCase())?.[0]))
      .filter((n) => Number.isFinite(n))
    const [yMin, yMax] = a.year_range ?? []
    const paths = kind === "series" ? ["/discover/tv"] : kind === "movie" ? ["/discover/movies"] : ["/discover/movies", "/discover/tv"]
    // One page of discover is ~20 popular titles, of which only a couple are
    // usually on this shelf — answering "what cozy autumn films do we own?" from
    // that reads as though the shelf is nearly empty. When the caller filters by
    // shelf state, walk further pages until enough matches accumulate.
    const maxPages = onShelf === undefined ? 1 : 5
    for (const p of paths) {
      const isTv = p.endsWith("/tv")
      for (let page = 1; page <= maxPages; page += 1) {
        const q = { page, sortBy: a.sort === "release_year" ? "primary_release_date.desc" : "popularity.desc" }
        if (genreIds.length) q.genre = genreIds.join(",")
        if (keywordIds.length) q.keywords = keywordIds.join(",")
        if (yMin) q[isTv ? "firstAirDateGte" : "primaryReleaseDateGte"] = `${yMin}-01-01`
        if (yMax) q[isTv ? "firstAirDateLte" : "primaryReleaseDateLte"] = `${yMax}-12-31`
        const body = await seerr(p, { query: q })
        const results = body.results ?? []
        raw.push(...results.map((r) => ({ ...r, mediaType: isTv ? "tv" : "movie" })))
        const matchesSoFar = raw
          .map((r) => (r.mediaInfo?.status === 5 || r.mediaInfo?.status === 4))
          .filter((hit) => hit === (onShelf === true)).length
        if (results.length === 0 || page >= (body.totalPages ?? 1) || matchesSoFar >= limit) break
      }
    }
  }

  // Partial and typo-tolerant library match, so a half-remembered title still
  // finds what is tracked. Lookup candidates appear only when the library has none.
  const resolution = a.query ? await resolveTitle(a.query, kind).catch((e) => ({ library_matches: [], lookup_candidates: [], not_in_library: null, notes: [`title_resolution_failed: ${e.message}`] })) : null

  let items = raw.filter((r) => r.mediaType !== "person").map(shelfItem)
  if (kind !== "any") items = items.filter((i) => i.kind === kind)
  if (a.year_range) {
    const [lo, hi] = a.year_range
    items = items.filter((i) => i.year && (!lo || i.year >= lo) && (!hi || i.year <= hi))
  }
  if (onShelf === true) items = items.filter((i) => i.on_shelf)
  if (onShelf === false) items = items.filter((i) => !i.on_shelf)
  if (a.sort === "release_year") items.sort((x, y) => (y.year ?? 0) - (x.year ?? 0))

  return {
    source,
    matched: items.length,
    items: items.slice(0, limit),
    ...(resolution ? { library_matches: resolution.library_matches.slice(0, 10), lookup_candidates: resolution.lookup_candidates, notes: resolution.notes } : {}),
    applied_filters: { kind, year_range: a.year_range ?? null, genres: a.genres ?? [], keywords: a.keywords ?? [], on_shelf: onShelf ?? "any" },
    // So the agent never claims something is missing when the filter caused it:
    note: resolution?.library_matches.length ? "library_matches lists items already tracked in Sonarr/Radarr (or on the Jellyfin shelf) whose titles match, best first. Offer these before anything else."
      : items.length === 0 && resolution?.lookup_candidates.length ? "Nothing in the library matches; lookup_candidates are TVDB/TMDB titles that are not in the library."
      : items.length === 0 ? "No matches for these filters. Loosen year_range/genres/keywords before concluding the shelf lacks it." : null,
  }
}

// ------------------------------------------------------------ tool: request

// Resolve by TMDB id against the title itself rather than scanning the request
// list: this household has over a thousand requests, so a page-limited scan
// silently misses older ones and would file a duplicate.
async function findExistingRequest(tmdbId, kind) {
  const kinds = kind ? [kind] : ["movie", "series"]
  for (const k of kinds) {
    let detail
    try {
      detail = await seerr(`/${k === "series" ? "tv" : "movie"}/${tmdbId}`)
    } catch {
      continue
    }
    const info = detail?.mediaInfo
    if (!info) continue
    const requests = info.requests ?? []
    const latest = requests.length ? requests[requests.length - 1] : null
    return {
      id: latest?.id ?? null,
      status: latest?.status ?? null,
      createdAt: latest?.createdAt ?? null,
      type: k === "series" ? "tv" : "movie",
      media: { ...info, tmdbId, title: detail.title ?? detail.name ?? null },
      hasRequest: requests.length > 0,
    }
  }
  return null
}

async function mediaRequest(a) {
  let tmdbId = a.tmdb_id
  let kind = a.kind ?? "movie"
  let resolvedTitle = a.title ?? null
  let resolvedYear = a.year ?? null

  if (!tmdbId) {
    if (!a.title) throw new ServiceError("bad_arguments", "media_request needs tmdb_id, or title (year optional).")
    const body = await seerr("/search", { query: { query: a.title, page: 1 } })
    let cands = (body.results ?? []).filter((r) => r.mediaType === "movie" || r.mediaType === "tv")
    if (a.kind) cands = cands.filter((r) => (a.kind === "series" ? r.mediaType === "tv" : r.mediaType === "movie"))
    if (a.year) cands = cands.filter((r) => ((r.releaseDate ?? r.firstAirDate ?? "").slice(0, 4)) === String(a.year))
    const pick = cands[0]
    if (!pick) {
      return { resolved: false, reason: "no_tmdb_match", searched: { title: a.title, year: a.year ?? null, kind: a.kind ?? "any" },
               human_action_required: true, human_action_reason: `No TMDB match for "${a.title}"${a.year ? ` (${a.year})` : ""}. Check the title or give a year.` }
    }
    tmdbId = pick.id
    kind = pick.mediaType === "tv" ? "series" : "movie"
    resolvedTitle = pick.title ?? pick.name
    resolvedYear = Number((pick.releaseDate ?? pick.firstAirDate ?? "").slice(0, 4)) || null
  }

  const existing = await findExistingRequest(tmdbId, kind)
  if (existing?.hasRequest) {
    const shelf = MEDIA_STATUS[existing.media?.status] ?? "unknown"
    return {
      resolved: true, title: resolvedTitle ?? existing.media?.title ?? null, year: resolvedYear, kind, tmdb_id: tmdbId,
      request_id: `jellyseerr:${existing.id}`,
      approval_state: "already_requested",
      duplicate_of: `jellyseerr:${existing.id}`,
      jellyseerr_status: REQUEST_STATUS[existing.status] ?? "unknown",
      shelf_state: shelf,
      submitted_at: existing.createdAt,
      tvdb_id: existing.media?.tvdbId ?? null,
      sonarr_id: kind === "series" ? (existing.media?.externalServiceId ?? null) : null,
      radarr_id: kind === "movie" ? (existing.media?.externalServiceId ?? null) : null,
      note: shelf === "available" ? "Already on the shelf." : "Already requested; use media_request_status to see why it has not landed.",
    }
  }

  const payload = { mediaType: kind === "series" ? "tv" : "movie", mediaId: tmdbId }
  if (kind === "series") {
    payload.seasons = a.season_number ? [a.season_number] : "all"
  }
  const created = await seerr("/request", { method: "POST", body: payload })
  return {
    resolved: true, title: resolvedTitle, year: resolvedYear, kind, tmdb_id: tmdbId,
    request_id: `jellyseerr:${created.id}`,
    approval_state: REQUEST_STATUS[created.status] ?? "submitted",
    duplicate_of: null,
    jellyseerr_status: REQUEST_STATUS[created.status] ?? "submitted",
    shelf_state: MEDIA_STATUS[created.media?.status] ?? "processing",
    submitted_at: created.createdAt,
    tvdb_id: created.media?.tvdbId ?? null,
    sonarr_id: kind === "series" ? (created.media?.externalServiceId ?? null) : null,
    radarr_id: kind === "movie" ? (created.media?.externalServiceId ?? null) : null,
    seasons_requested: kind === "series" ? (a.season_number ? [a.season_number] : "all") : null,
    note: "Submitted. The indexer hunt runs next; media_request_status will show whether a release was grabbed.",
  }
}

// -------------------------------------------------- acquisition chain health

// The failure that stalled this house for three weeks: Prowlarr had zero indexers,
// so Sonarr reported "0 active indexers" and every request sat at "requested"
// forever. That must be a first-class, named answer — never something the agent
// has to infer from an empty release list.
async function chainHealth() {
  const out = { indexers: { total: 0, enabled: 0, failing: [], ok: [] }, apps: [], problems: [], healthy: true }
  try {
    const list = await prowlarr("/indexer")
    out.indexers.total = list.length
    out.indexers.enabled = list.filter((i) => i.enable).length
    const status = await prowlarr("/indexerstatus").catch(() => [])
    const disabled = new Set((status ?? []).map((s) => s.indexerId))
    for (const i of list) {
      if (!i.enable) continue
      ;(disabled.has(i.id) ? out.indexers.failing : out.indexers.ok).push(i.name)
    }
    const health = await prowlarr("/health").catch(() => [])
    for (const h of health ?? []) {
      if (h.type === "error" && /indexer/i.test(h.source ?? "")) out.problems.push({ service: "prowlarr", message: h.message })
    }
    out.apps = (await prowlarr("/applications").catch(() => [])).map((x) => ({ name: x.name, sync: x.syncLevel }))
  } catch (e) {
    out.problems.push({ service: "prowlarr", message: e.message })
  }

  if (out.indexers.total === 0) {
    out.healthy = false
    out.problems.push({ service: "prowlarr", message: "Prowlarr has zero indexers configured. Nothing can ever be found or downloaded until indexers are added." })
  } else if (out.indexers.ok.length === 0) {
    out.healthy = false
    out.problems.push({ service: "prowlarr", message: "Every enabled indexer is currently failing. Searches will return nothing." })
  }
  if (out.apps.length === 0) {
    out.healthy = false
    out.problems.push({ service: "prowlarr", message: "Prowlarr is not syncing to Sonarr/Radarr, so they have no working indexers." })
  }

  for (const [name, call] of [["sonarr", sonarr], ["radarr", radarr]]) {
    try {
      const h = await call("/health")
      for (const item of h ?? []) {
        if (/indexer/i.test(item.source ?? "") && (item.type === "error" || /unavailable/i.test(item.message ?? ""))) {
          out.problems.push({ service: name, message: item.message })
          if (/all/i.test(item.message ?? "")) out.healthy = false
        }
      }
    } catch (e) { out.problems.push({ service: name, message: e.message }) }
  }
  return out
}

// --------------------------------------------------- tool: request status

async function resolveTarget(a) {
  if (a.tmdb_id) {
    const r = await findExistingRequest(a.tmdb_id, a.kind)
    if (r?.hasRequest) return r
  }
  if (a.request_id) {
    const id = Number(String(a.request_id).replace(/^jellyseerr:/, ""))
    if (Number.isFinite(id)) {
      try { return await seerr(`/request/${id}`) } catch { /* fall through to title */ }
    }
  }
  if (a.title) {
    const body = await seerr("/search", { query: { query: a.title, page: 1 } })
    // Only titles Jellyseerr already knows about can have a request behind them.
    for (const pick of (body.results ?? []).filter((r) => r.mediaInfo)) {
      const found = await findExistingRequest(pick.id, pick.mediaType === "tv" ? "series" : "movie")
      if (found?.hasRequest) return found
    }
    // Jellyseerr's own search missed it: try the partial/typo-tolerant library
    // match, and follow its best candidate back to a request by TMDB id.
    const best = (await findLibraryCandidates(a.title).catch(() => [])).find((c) => c.tmdb_id)
    if (best) {
      const found = await findExistingRequest(best.tmdb_id, best.kind)
      if (found?.hasRequest) return found
    }
  }
  return null
}

export async function mediaRequestStatus(a) {
  const request = await resolveTarget(a)
  if (!request) {
    const resolution = a.title ? await resolveTitle(a.title).catch(() => null) : null
    return { found: false, reason: "no_matching_request",
             searched: { request_id: a.request_id ?? null, tmdb_id: a.tmdb_id ?? null, title: a.title ?? null },
             ...(resolution ? { library_matches: resolution.library_matches.slice(0, 10), lookup_candidates: resolution.lookup_candidates,
                                note: resolution.library_matches.length ? "Not requested through Jellyseerr, but these titles are already in the library. Use media_search_now with the service_id to act on one." : undefined } : {}),
             diagnosis: { stuck_stage: "request", stuck_reason: "never_requested",
                          likely_fix: "Submit it with media_request.", human_action_required: false } }
  }

  const kind = request.type === "tv" ? "series" : "movie"
  const media = request.media ?? {}
  const shelf = MEDIA_STATUS[media.status] ?? "unknown"
  const svcId = media.externalServiceId ?? null

  const result = {
    found: true,
    request: {
      id: `jellyseerr:${request.id}`,
      kind,
      tmdb_id: media.tmdbId ?? null,
      tvdb_id: media.tvdbId ?? null,
      jellyseerr_status: REQUEST_STATUS[request.status] ?? "unknown",
      shelf_state: shelf,
      submitted_at: request.createdAt,
      sonarr_id: kind === "series" ? svcId : null,
      radarr_id: kind === "movie" ? svcId : null,
    },
    search: null, download: null, file: null, chain: null, diagnosis: null,
  }

  let entity = null, queueRecs = [], history = []
  try {
    if (kind === "series" && svcId) {
      entity = await sonarr(`/series/${svcId}`)
      const q = await sonarr("/queue", { query: { pageSize: 200, includeSeries: true } })
      queueRecs = (q.records ?? []).filter((r) => r.seriesId === svcId)
      history = await sonarr("/history/series", { query: { seriesId: svcId } }).catch(() => [])
      result.request.title = entity.title
      result.file = { on_shelf: (entity.statistics?.episodeFileCount ?? 0) > 0,
                      episodes_on_disk: entity.statistics?.episodeFileCount ?? 0,
                      episodes_total: entity.statistics?.episodeCount ?? 0,
                      size_bytes: entity.statistics?.sizeOnDisk ?? 0,
                      path: entity.path ?? null }
    } else if (kind === "movie" && svcId) {
      entity = await radarr(`/movie/${svcId}`)
      const q = await radarr("/queue", { query: { pageSize: 200 } })
      queueRecs = (q.records ?? []).filter((r) => r.movieId === svcId)
      history = await radarr("/history/movie", { query: { movieId: svcId } }).catch(() => [])
      result.request.title = entity.title
      result.file = { on_shelf: Boolean(entity.hasFile), size_bytes: entity.sizeOnDisk ?? 0, path: entity.path ?? null }
    }
  } catch (e) {
    result.chain_error = e.message
  }

  const grabs = (history ?? []).filter((h) => h.eventType === "grabbed")
  result.search = {
    grab_attempts: grabs.length,
    last_grab_at: grabs[0]?.date ?? null,
    last_grab_title: grabs[0]?.sourceTitle ?? null,
    monitored: entity ? Boolean(entity.monitored) : null,
  }
  result.download = computeDownloadState(queueRecs, Date.now())

  const chain = await chainHealth()
  result.chain = chain
  result.diagnosis = diagnose({ shelf, result, chain, entity, kind })
  return result
}

// The deterministic core, split out so it can be tested without a live
// Sonarr/Radarr. `computeDownloadState` and `diagnose` are the whole reason the
// media surface can answer "why hasn't this downloaded" without the agent
// guessing, and D-013 (a stalled download read as progress) shipped verified
// only in production because there was no seam to test them through.
//
// A season pack shows up as one queue row per episode, all sharing one
// downloadId. Summing rows would report a 45 GB pack as 450 GB, so size and
// "how many downloads" are counted per distinct download, not per row. A
// torrent that has not moved a byte since it was grabbed is dead, not slow:
// Radarr reports trackedDownloadStatus "ok" for these indefinitely, so
// progress is measured against age rather than trusted from the row.
// The one stall rule: nothing downloaded yet, and older than the stall window.
// A download that never started, or one still unfinished days later (e.g. stuck at
// 99.85% with no seeders for the last piece), will not finish on its own.
const STUCK_INCOMPLETE_AFTER_HOURS = 72

export function isStalledRow(r, nowMs) {
  if (!((r.size ?? 0) > 0) || !r.added) return false
  const ageHours = (nowMs - Date.parse(r.added)) / 3_600_000
  const left = r.sizeleft ?? 0
  if (left >= r.size) return ageHours >= STALL_AFTER_HOURS
  return left > 0 && ageHours >= STUCK_INCOMPLETE_AFTER_HOURS
}

export function computeDownloadState(queueRecs, nowMs) {
  const byDownload = new Map()
  for (const r of queueRecs) byDownload.set(r.downloadId ?? `row:${r.id}`, r)
  const downloads = [...byDownload.values()]
  const sizeLeft = downloads.reduce((s, r) => s + (r.sizeleft ?? 0), 0)
  const sizeTotal = downloads.reduce((s, r) => s + (r.size ?? 0), 0)
  const stalledItems = downloads
    .filter((r) => isStalledRow(r, nowMs))
    .map((r) => ({
      title: r.title ?? null,
      added_at: r.added ?? null,
      age_hours: Math.round((nowMs - Date.parse(r.added)) / 3_600_000),
      size_gb: Number(((r.size ?? 0) / 1073741824).toFixed(2)),
      queue_id: r.id ?? null,
    }))
  return {
    active_downloads: downloads.length,
    active_items: queueRecs.length,
    states: [...new Set(downloads.map((r) => r.status))],
    tracked_states: [...new Set(downloads.map((r) => r.trackedDownloadState).filter(Boolean))],
    errors: [...new Set(downloads.map((r) => r.errorMessage).filter(Boolean))],
    size_left_bytes: sizeLeft,
    size_total_bytes: sizeTotal,
    percent_complete: sizeTotal > 0 ? Math.round(((sizeTotal - sizeLeft) / sizeTotal) * 100) : null,
    stalled: stalledItems.length > 0,
    stalled_items: stalledItems,
  }
}

// The deterministic core. The agent must never have to work this out itself.
export function diagnose({ shelf, result, chain, entity, kind }) {
  const file = result.file ?? {}
  const onShelf = kind === "series" ? (file.episodes_on_disk ?? 0) > 0 : Boolean(file.on_shelf)
  const complete = kind === "series" ? (file.episodes_on_disk ?? 0) >= (file.episodes_total ?? Infinity) : onShelf

  if (complete) {
    return { stuck_stage: null, stuck_reason: null, likely_fix: null, human_action_required: false,
             summary: "On the shelf and complete. Nothing is stuck." }
  }
  if (result.download.stalled) {
    const items = result.download.stalled_items
    const oldest = Math.max(...items.map((i) => i.age_hours))
    return { stuck_stage: "download", stuck_reason: "stalled_no_progress",
             likely_fix: "blocklist_and_research", human_action_required: false,
             percent_complete: result.download.percent_complete,
             detail: items,
             summary: `Stalled, not slow. ${items.length === 1 ? "The release" : `${items.length} releases`} ${items.length === 1 ? "has" : "have"} not downloaded a single byte in ${oldest} hours, which means no seeders rather than a quiet queue. Waiting will not fix it; blocklist the release and search again for a different one.` }
  }
  if (result.download.active_downloads > 0) {
    const left = result.download.size_left_bytes
    const total = result.download.size_total_bytes
    const gb = (left / 1073741824).toFixed(1)
    const pct = total > 0 ? Math.round(((total - left) / total) * 100) : null
    const what = result.download.active_downloads === 1 && result.download.active_items > 1
      ? `a ${result.download.active_items}-episode pack`
      : `${result.download.active_downloads} download(s)`
    return { stuck_stage: null, stuck_reason: null, likely_fix: null, human_action_required: false,
             percent_complete: pct,
             summary: `Downloading now — ${what}${pct === null ? "" : `, ${pct}% done`}, about ${gb} GB to go.` }
  }
  if (result.download.errors.length) {
    return { stuck_stage: "download", stuck_reason: "download_client_error", likely_fix: "retry_or_replace_release",
             human_action_required: false, detail: result.download.errors,
             summary: `The download client reported: ${result.download.errors.join("; ")}` }
  }
  if (!chain.healthy) {
    return { stuck_stage: "indexers", stuck_reason: "acquisition_chain_down",
             likely_fix: "restore_indexers", human_action_required: true,
             detail: chain.problems,
             summary: `Nothing can download: ${chain.problems.map((p) => p.message).join(" ")} This blocks every request, not just this one.` }
  }
  if (entity && entity.monitored === false) {
    return { stuck_stage: "request", stuck_reason: "not_monitored", likely_fix: "enable_monitoring",
             human_action_required: false, summary: "It is not monitored, so no search will ever run for it." }
  }
  if (result.search.grab_attempts === 0) {
    return { stuck_stage: "search", stuck_reason: "no_search_run_or_no_acceptable_release",
             likely_fix: "rescan", human_action_required: false,
             summary: "Indexers are healthy but nothing has ever been grabbed. A fresh search (media_diagnose_and_fix action=rescan) is the next step." }
  }
  if (onShelf && !complete) {
    return { stuck_stage: "import", stuck_reason: "partially_imported", likely_fix: "rescan",
             human_action_required: false,
             summary: `Partly here: ${file.episodes_on_disk} of ${file.episodes_total} episodes. The rest still need grabbing.` }
  }
  return { stuck_stage: "import", stuck_reason: "grabbed_but_not_imported", likely_fix: "force_import_scan",
           human_action_required: false,
           summary: `It was grabbed (${result.search.last_grab_title ?? "unknown release"}) but never landed on the shelf.` }
}

// -------------------------------------------------- tool: diagnose_and_fix

async function mediaDiagnoseAndFix(a) {
  const before = await mediaRequestStatus({ request_id: a.request_id, tmdb_id: a.tmdb_id, title: a.title })
  if (!before.found) return { result: "no_such_request", before, after: null, human_action_required: true,
                              human_action_reason: "Nothing to fix — it was never requested." }
  const action = a.action ?? (before.diagnosis?.likely_fix ?? "rescan")

  if (before.diagnosis?.stuck_reason === "acquisition_chain_down" && action !== "report_only") {
    return { action, dry_run: Boolean(a.dry_run), result: "rejected_fix_unsafe", before, after: null,
             human_action_required: true,
             human_action_reason: "The acquisition chain itself is down (see before.chain.problems). Re-searching cannot help until indexers are restored." }
  }
  if (a.dry_run) {
    return { action, dry_run: true, result: "would_apply", before,
             would_do: describeAction(action), human_action_required: false }
  }

  const kind = before.request.kind
  const svcId = kind === "series" ? before.request.sonarr_id : before.request.radarr_id
  if (!svcId) return { action, result: "manual_required", before, after: null, human_action_required: true,
                       human_action_reason: "This request is not yet mapped into Sonarr/Radarr, so no search can be triggered." }

  let commanded = null
  if (action === "rescan" || action === "enable_monitoring" || action === "force_import_scan") {
    if (action === "enable_monitoring") {
      if (kind === "series") await sonarr(`/series/${svcId}`, { method: "PUT", body: { ...(await sonarr(`/series/${svcId}`)), monitored: true } })
      else await radarr(`/movie/${svcId}`, { method: "PUT", body: { ...(await radarr(`/movie/${svcId}`)), monitored: true } })
    }
    const cmd = kind === "series"
      ? (action === "force_import_scan" ? { name: "RescanSeries", seriesId: svcId } : { name: "SeriesSearch", seriesId: svcId })
      : (action === "force_import_scan" ? { name: "RescanMovie", movieIds: [svcId] } : { name: "MoviesSearch", movieIds: [svcId] })
    commanded = kind === "series" ? await sonarr("/command", { method: "POST", body: cmd }) : await radarr("/command", { method: "POST", body: cmd })
  } else if (action === "blocklist_and_research") {
    // Removing with blocklist=true is what stops the same dead release being
    // grabbed straight back. The search that follows is then free to pick a
    // different one.
    const stalled = before.download.stalled_items ?? []
    if (!stalled.length) return { action, result: "nothing_to_blocklist", before, after: null, human_action_required: false,
                                  human_action_reason: "No download has been sitting at zero long enough to call it stalled." }
    for (const item of stalled) {
      if (item.queue_id === null) continue
      const client = kind === "series" ? sonarr : radarr
      await client(`/queue/${item.queue_id}`, { method: "DELETE", query: { removeFromClient: true, blocklist: true, skipRedownload: true } })
    }
    const cmd = kind === "series" ? { name: "SeriesSearch", seriesId: svcId } : { name: "MoviesSearch", movieIds: [svcId] }
    commanded = kind === "series" ? await sonarr("/command", { method: "POST", body: cmd }) : await radarr("/command", { method: "POST", body: cmd })
  } else {
    return { action, result: "unsupported_action", before, after: null, human_action_required: true,
             human_action_reason: `Action "${action}" is not implemented. Supported: rescan, enable_monitoring, force_import_scan, blocklist_and_research, report_only.` }
  }

  await new Promise((r) => setTimeout(r, 12_000))
  const after = await mediaRequestStatus({ request_id: a.request_id, tmdb_id: a.tmdb_id, title: a.title })
  return {
    action, dry_run: false, applied_at: new Date().toISOString(),
    command: { id: commanded?.id ?? null, name: commanded?.name ?? null },
    before: { diagnosis: before.diagnosis, grab_attempts: before.search.grab_attempts, active_downloads: before.download.active_downloads },
    after: { diagnosis: after.diagnosis, grab_attempts: after.search.grab_attempts, active_downloads: after.download.active_downloads },
    result: after.download.active_downloads > before.download.active_downloads ? "grabbed_and_downloading"
          : after.search.grab_attempts > before.search.grab_attempts ? "grabbed"
          : "queued_for_search",
    human_action_required: Boolean(after.diagnosis?.human_action_required),
    human_action_reason: after.diagnosis?.human_action_required ? after.diagnosis.summary : null,
  }
}

function describeAction(action) {
  return {
    rescan: "Trigger a fresh indexer search and grab the best acceptable release.",
    enable_monitoring: "Mark it monitored, then search.",
    force_import_scan: "Re-scan the disk so an already-downloaded file gets imported.",
    blocklist_and_research: "Blocklist the stalled release so it cannot be grabbed again, then search for a different one.",
    report_only: "Report only; change nothing.",
  }[action] ?? "Unknown action."
}

// ------------------------------------------------------- tool: play/resolve

async function mediaPlayOrResolve(a) {
  const status = await mediaRequestStatus({ request_id: a.request_id, tmdb_id: a.tmdb_id, title: a.title })
  if (!status.found || !status.file) {
    return { playable: false, reason: "not_on_shelf", diagnosis: status.diagnosis ?? null,
             human_action_required: true, human_action_reason: "It is not on the shelf yet." }
  }
  const onShelf = status.request.kind === "series" ? (status.file.episodes_on_disk ?? 0) > 0 : status.file.on_shelf
  return {
    playable: Boolean(onShelf),
    title: status.request.title ?? null,
    kind: status.request.kind,
    tmdb_id: status.request.tmdb_id,
    episodes_on_disk: status.file.episodes_on_disk ?? null,
    episodes_total: status.file.episodes_total ?? null,
    path: status.file.path,
    size_bytes: status.file.size_bytes,
    play_url: onShelf ? `${JELLYFIN_WEB}/web/index.html#!/search.html?query=${encodeURIComponent(status.request.title ?? "")}` : null,
    diagnosis: status.diagnosis,
  }
}

// --------------------------------------------------------- tool: chain health

async function mediaChainHealth() {
  const chain = await chainHealth()
  return {
    healthy: chain.healthy,
    indexers: chain.indexers,
    app_sync: chain.apps,
    problems: chain.problems,
    summary: chain.healthy
      ? `Acquisition chain healthy: ${chain.indexers.ok.length} of ${chain.indexers.enabled} enabled indexers responding${chain.indexers.failing.length ? `, failing: ${chain.indexers.failing.join(", ")}` : ""}.`
      : `Acquisition chain DOWN. ${chain.problems.map((p) => p.message).join(" ")}`,
  }
}

// ------------------------------------- tools: search_now / blocklist_stalled

// Act on an item already in Sonarr/Radarr directly; no Jellyseerr request needed.
// Never adds a library item: an unknown title is reported, not created.
const arrFor = (kind) => (kind === "series" ? sonarr : radarr)

async function resolveLibraryItem(a) {
  let candidates
  if ((a.service_id !== undefined && a.service_id !== null) || a.tmdb_id) {
    const list = await arrFor(a.kind)(a.kind === "series" ? "/series" : "/movie")
    const items = (Array.isArray(list) ? list : []).map((i) => libraryCandidate(a.kind, i))
    const hit = items.filter((i) => (a.service_id !== undefined && a.service_id !== null ? i.service_id === Number(a.service_id) : i.tmdb_id === Number(a.tmdb_id)))
    if (hit.length === 1) return { item: { id: hit[0].service_id, title: hit[0].title } }
    candidates = hit
  } else if (a.title) {
    const ranked = (await findLibraryCandidates(a.title, a.kind)).filter((c) => c.service_id !== null)
    // Act only when the best tier holds exactly one item and it is not merely a
    // typo-distance match; otherwise name the candidates and let the caller pick.
    const bestTier = ranked.filter((c) => c.match === ranked[0]?.match)
    if (bestTier.length === 1 && bestTier[0].match !== "fuzzy") return { item: { id: bestTier[0].service_id, title: bestTier[0].title } }
    if (!ranked.length) {
      const lookup = (await lookupCandidates(a.title, a.kind)).filter((c) => !c.in_library).map((c) => ({ ...c, not_in_library: true }))
      return { result: "not_found", candidates: lookup }
    }
    candidates = ranked
  } else candidates = []
  return { result: candidates.length ? "ambiguous" : "not_found", candidates: candidates.slice(0, 10) }
}

const QUEUE_PAGE_SIZE = 200
const QUEUE_MAX_PAGES = 20

// The item's queue rows. Filtered server-side (seriesIds/movieIds) and paged, so a
// long queue cannot hide a row; the client-side filter stays as the backstop.
async function itemQueue(kind, serviceId) {
  const client = arrFor(kind)
  const idKey = kind === "series" ? "seriesId" : "movieId"
  const filter = kind === "series" ? { seriesIds: serviceId, includeSeries: true } : { movieIds: serviceId }
  const rows = []
  for (let page = 1; page <= QUEUE_MAX_PAGES; page++) {
    const q = await client("/queue", { query: { ...filter, page, pageSize: QUEUE_PAGE_SIZE } })
    const records = q?.records ?? []
    rows.push(...records)
    if (!records.length || !(Number(q?.totalRecords) > page * QUEUE_PAGE_SIZE)) break
  }
  return rows.filter((r) => r[idKey] === serviceId)
}

function queueReport(rows) {
  const now = Date.now()
  return rows.map((r) => ({ queue_id: r.id ?? null, title: r.title ?? null, status: r.status ?? null,
                            size_left_bytes: r.sizeleft ?? 0, stalled: isStalledRow(r, now) }))
}

async function runSearch(kind, serviceId) {
  const body = kind === "series" ? { name: "SeriesSearch", seriesId: serviceId } : { name: "MoviesSearch", movieIds: [serviceId] }
  const c = await arrFor(kind)("/command", { method: "POST", body })
  return { id: c?.id ?? null, name: c?.name ?? body.name, status: c?.status ?? null }
}

export async function mediaSearchNow(a) {
  if (a.kind !== "series" && a.kind !== "movie") return { result: "invalid_kind", message: "kind must be 'series' or 'movie'." }
  const found = await resolveLibraryItem(a)
  if (!found.item) return { result: found.result, kind: a.kind, candidates: found.candidates }
  const { item } = found
  const command = await runSearch(a.kind, item.id)
  return { kind: a.kind, service_id: item.id, title: item.title, command, queue: queueReport(await itemQueue(a.kind, item.id)) }
}

export async function mediaBlocklistStalled(a) {
  if (a.kind !== "series" && a.kind !== "movie") return { result: "invalid_kind", message: "kind must be 'series' or 'movie'." }
  if (a.service_id === undefined || a.service_id === null) return { result: "service_id_required" }
  const serviceId = Number(a.service_id)
  const rows = await itemQueue(a.kind, serviceId)
  const now = Date.now()
  let targets
  if (Array.isArray(a.queue_ids) && a.queue_ids.length) {
    const own = new Set(rows.map((r) => r.id))
    const foreign = a.queue_ids.filter((id) => !own.has(id))
    if (foreign.length) return { result: "queue_id_not_for_item", foreign_queue_ids: foreign, queue: queueReport(rows) }
    targets = rows.filter((r) => a.queue_ids.includes(r.id))
  } else {
    targets = rows.filter((r) => isStalledRow(r, now))
  }
  // A season pack is many queue rows sharing one downloadId; deleting one removes
  // the download for all, so delete once per download.
  const seen = new Set()
  targets = targets.filter((r) => {
    const key = r.downloadId ? `d:${r.downloadId}` : `q:${r.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (!targets.length) return { result: "nothing_to_blocklist", queue: queueReport(rows) }
  const removed = []
  const failed = []
  for (const row of targets) {
    try {
      await arrFor(a.kind)(`/queue/${row.id}`, { method: "DELETE", query: { removeFromClient: true, blocklist: true, skipRedownload: true } })
      removed.push(row.id)
    } catch (e) {
      // 404: the row went away (finished or removed with its pack); not a failure to retry.
      if (/_http_404$/.test(e.code ?? "")) removed.push(row.id)
      else failed.push({ queue_id: row.id, error: e.message })
    }
  }
  const command = a.research === false ? null : await runSearch(a.kind, serviceId)
  return { removed, ...(failed.length ? { failed } : {}), command, queue: queueReport(await itemQueue(a.kind, serviceId)) }
}

// ------------------------------- tools: episodes / releases / blocklist / import

// When an automatic search finds nothing, the Butler works the release by hand:
// list the episodes, read what the indexers offer and how Sonarr parsed it, grab
// the right one with an explicit episode mapping, and map downloaded files by title.
// All scoped to series/movies already in the library; nothing here adds one.

const kindOk = (a) => a.kind === "series" || a.kind === "movie"
const invalidKind = () => ({ result: "invalid_kind", message: "kind must be 'series' or 'movie'." })
const idKeyOf = (kind) => (kind === "series" ? "seriesId" : "movieId")
const code2 = (n) => String(n).padStart(2, "0")
const sxe = (e) => `S${code2(e.seasonNumber)}E${code2(e.episodeNumber)}`

async function seriesEpisodes(seriesId, seasonNumber) {
  const list = await sonarr("/episode", { query: { seriesId, seasonNumber } })
  return Array.isArray(list) ? list : []
}

export async function mediaEpisodes(a) {
  if (a.service_id === undefined || a.service_id === null) return { result: "service_id_required" }
  const seriesId = Number(a.service_id)
  const eps = await seriesEpisodes(seriesId, a.season_number)
  return {
    series_id: seriesId,
    season_number: a.season_number ?? null,
    count: eps.length,
    episodes: eps.map((e) => ({ episode_id: e.id, code: sxe(e), season: e.seasonNumber, episode: e.episodeNumber, title: e.title ?? null,
                                air_date: e.airDate ?? null, has_file: Boolean(e.hasFile), monitored: Boolean(e.monitored),
                                // Release names follow scene (often streaming) numbering; Sonarr's own mapping, when it has one.
                                scene_code: Number.isInteger(e.sceneSeasonNumber) && Number.isInteger(e.sceneEpisodeNumber)
                                  ? `S${String(e.sceneSeasonNumber).padStart(2, "0")}E${String(e.sceneEpisodeNumber).padStart(2, "0")}` : null })),
  }
}

// Free-text search across every Prowlarr indexer: discovery only, it grabs nothing.
// Sonarr's own search only asks for the season/episode codes it expects; this finds
// what exists under any name (another numbering, a "Season 2 (2020)" pack, an episode title).
export async function mediaIndexerSearch(a) {
  const query = typeof a.query === "string" ? a.query.trim() : ""
  if (!query) return { result: "query_required" }
  const raw = await prowlarr("/search", { query: { query, type: "search", limit: 100 }, timeoutMs: SEARCH_TIMEOUT_MS })
  const limit = Math.min(Math.max(Number(a.limit) || 25, 1), 50)
  const rows = (Array.isArray(raw) ? raw : [])
    .map((r) => ({ indexer: r.indexer ?? null, title: r.title ?? null, size_bytes: r.size ?? null, seeders: r.seeders ?? null,
                   age_days: r.age ?? null, protocol: r.protocol ?? null }))
    .sort((x, y) => (y.seeders ?? -1) - (x.seeders ?? -1))
  return { query, count: rows.length, releases: rows.slice(0, limit),
           note: "Discovery only. To grab, run media_release_search for the item so Sonarr/Radarr caches the release, then media_release_grab with an explicit episode mapping." }
}

// The last search's compact rows, keyed by kind + guid, so a grab can check what Sonarr parsed.
// Sonarr/Radarr forget a search's releases after about 30 minutes; expire ours a little sooner.
const releaseCache = new Map()
const RELEASE_CACHE_TTL_MS = 25 * 60_000
const RELEASE_CACHE_MAX = 500
const MAX_EPISODE_SEARCHES = 6

function cacheRelease(key, row, nowMs = Date.now()) {
  for (const [k, v] of releaseCache) if (nowMs - v.at > RELEASE_CACHE_TTL_MS) releaseCache.delete(k)
  releaseCache.delete(key)
  releaseCache.set(key, { ...row, at: nowMs })
  while (releaseCache.size > RELEASE_CACHE_MAX) releaseCache.delete(releaseCache.keys().next().value)
}

function releaseRow(kind, r) {
  const rejections = Array.isArray(r.rejections) ? r.rejections.map((x) => (typeof x === "string" ? x : x?.reason ?? String(x))) : []
  const row = {
    guid: r.guid, indexer_id: r.indexerId ?? null, indexer: r.indexer ?? null, title: r.title ?? null, size_bytes: r.size ?? null,
    seeders: r.seeders ?? null, age_days: r.age ?? null, quality: r.quality?.quality?.name ?? null, protocol: r.protocol ?? null,
    rejected: Boolean(r.rejected), rejections, blocklisted: rejections.some((x) => /blocklist/i.test(x)),
  }
  if (kind === "series") {
    return { ...row, full_season: Boolean(r.fullSeason), parsed_season: r.seasonNumber ?? null, parsed_episodes: r.episodeNumbers ?? [],
             mapped_episodes: (r.mappedEpisodeInfo ?? []).map((e) => ({ episode_id: e.id ?? null, code: sxe(e), title: e.title ?? null })),
             mapped_series_id: r.mappedSeriesId ?? null }
  }
  return { ...row, mapped_movie_id: r.mappedMovieId ?? null }
}

export async function mediaReleaseSearch(a) {
  if (!kindOk(a)) return invalidKind()
  if (a.service_id === undefined || a.service_id === null) return { result: "service_id_required" }
  const serviceId = Number(a.service_id)
  let raw = []
  if (a.kind === "movie") {
    raw = await radarr("/release", { query: { movieId: serviceId }, timeoutMs: SEARCH_TIMEOUT_MS })
  } else if (Array.isArray(a.episode_ids) && a.episode_ids.length) {
    // Sonarr searches one episode per call.
    if (a.episode_ids.length > MAX_EPISODE_SEARCHES) return { result: "too_many_episode_ids", max: MAX_EPISODE_SEARCHES, message: "Search the season instead, or fewer episodes at a time." }
    for (const id of a.episode_ids) raw.push(...await sonarr("/release", { query: { episodeId: id }, timeoutMs: SEARCH_TIMEOUT_MS }))
  } else if (a.season_number !== undefined && a.season_number !== null) {
    raw = await sonarr("/release", { query: { seriesId: serviceId, seasonNumber: a.season_number }, timeoutMs: SEARCH_TIMEOUT_MS })
  } else return { result: "season_number_or_episode_ids_required" }
  const seen = new Set()
  const unique = (Array.isArray(raw) ? raw : []).filter((r) => (seen.has(r.guid) ? false : seen.add(r.guid)))
  // Sonarr's override grab needs the release's own quality and languages objects back.
  const rawByGuid = new Map(unique.map((r) => [r.guid, r]))
  let rows = unique.map((r) => releaseRow(a.kind, r))
  const total = rows.length
  if (a.query) {
    const q = String(a.query).toLowerCase()
    rows = rows.filter((r) => (r.title ?? "").toLowerCase().includes(q))
  }
  rows.sort((x, y) => Number(y.seeders ?? 0) - Number(x.seeders ?? 0))
  const limit = Math.min(Math.max(Number(a.limit) || 40, 1), 100)
  for (const r of rows) {
    const source = rawByGuid.get(r.guid)
    cacheRelease(`${a.kind}:${r.guid}`, { ...r, service_id: serviceId, season_number: a.season_number ?? null,
      quality_raw: source?.quality ?? null, languages_raw: source?.languages ?? null })
  }
  return { kind: a.kind, service_id: serviceId, total_found: total, matched: rows.length, releases: rows.slice(0, limit) }
}

export async function mediaReleaseGrab(a) {
  if (!kindOk(a)) return invalidKind()
  if (!a.guid || a.indexer_id === undefined || a.indexer_id === null) return { result: "guid_and_indexer_id_required" }
  const cached = releaseCache.get(`${a.kind}:${a.guid}`)
  if (!cached || Date.now() - cached.at > RELEASE_CACHE_TTL_MS) {
    return { result: "search_first", message: "Run media_release_search first; a release can only be grabbed from a recent search (within 25 minutes)." }
  }
  if (cached.indexer_id !== null && Number(a.indexer_id) !== Number(cached.indexer_id)) return { result: "indexer_mismatch", expected_indexer_id: cached.indexer_id }
  const body = { guid: a.guid, indexerId: Number(a.indexer_id) }
  const hasEpisodes = Array.isArray(a.episode_ids) && a.episode_ids.length > 0
  if (a.kind === "series") {
    if (!hasEpisodes) {
      // A pack Sonarr parsed as another season would be mapped to the wrong episodes.
      const target = a.season_number ?? cached.season_number
      if (cached.full_season && (target === undefined || target === null || Number(target) !== Number(cached.parsed_season))) {
        return { result: "season_pack_mismatch", parsed_season: cached.parsed_season, target_season: target ?? null, title: cached.title,
                 message: "Sonarr parsed this season pack as a different season than the target. Pass series_id and episode_ids to say which episodes it holds." }
      }
    } else {
      if (a.series_id === undefined || a.series_id === null) return { result: "series_id_required_with_episode_ids" }
      const seriesId = Number(a.series_id)
      if (seriesId !== Number(cached.service_id)) return { result: "series_mismatch", searched_series_id: cached.service_id, message: "This release came from a search for another series." }
      const own = new Set((await seriesEpisodes(seriesId)).map((e) => e.id))
      const foreign = a.episode_ids.filter((id) => !own.has(id))
      if (foreign.length) return { result: "episode_id_not_for_series", foreign_episode_ids: foreign }
      // Sonarr v4 refuses an override without quality and languages (ArgumentNullException, HTTP 500).
      if (!cached.quality_raw) return { result: "release_quality_unknown", message: "Sonarr's search did not report this release's quality; search again." }
      Object.assign(body, { seriesId, episodeIds: a.episode_ids.map(Number), shouldOverride: true,
        quality: cached.quality_raw, languages: Array.isArray(cached.languages_raw) ? cached.languages_raw : [] })
      if (a.download_client_id !== undefined && a.download_client_id !== null) body.downloadClientId = Number(a.download_client_id)
    }
  }
  const res = await arrFor(a.kind)("/release", { method: "POST", body })
  return { result: "grabbed", kind: a.kind, title: cached.title, request: body,
           response: { approved: res?.approved ?? null, rejected: res?.rejected ?? null, rejections: res?.rejections ?? [], download_id: res?.downloadId ?? null } }
}

const BLOCKLIST_PAGE_SIZE = 100
const BLOCKLIST_MAX_PAGES = 20

async function itemBlocklist(kind, serviceId) {
  const idKey = idKeyOf(kind)
  const filter = kind === "series" ? { seriesIds: serviceId } : { movieIds: serviceId }
  const rows = []
  for (let page = 1; page <= BLOCKLIST_MAX_PAGES; page++) {
    const q = await arrFor(kind)("/blocklist", { query: { ...filter, page, pageSize: BLOCKLIST_PAGE_SIZE } })
    const records = q?.records ?? []
    rows.push(...records)
    if (!records.length || !(Number(q?.totalRecords) > page * BLOCKLIST_PAGE_SIZE)) return rows.filter((r) => r[idKey] === serviceId)
  }
  const own = rows.filter((r) => r[idKey] === serviceId)
  own.truncated = true
  return own
}

const blocklistReport = (rows) => rows.map((r) => ({ blocklist_id: r.id, title: r.sourceTitle ?? null, date: r.date ?? null, indexer: r.indexer ?? null,
  quality: r.quality?.quality?.name ?? null, episode_ids: r.episodeIds ?? [], message: r.message ?? null }))

export async function mediaBlocklist(a) {
  if (!kindOk(a)) return invalidKind()
  if (a.service_id === undefined || a.service_id === null) return { result: "service_id_required" }
  const serviceId = Number(a.service_id)
  const rows = await itemBlocklist(a.kind, serviceId)
  if (!Array.isArray(a.remove_ids) || !a.remove_ids.length) {
    return { kind: a.kind, service_id: serviceId, count: rows.length, ...(rows.truncated ? { truncated: true } : {}), entries: blocklistReport(rows) }
  }
  const own = new Set(rows.map((r) => r.id))
  const foreign = a.remove_ids.filter((id) => !own.has(id))
  if (foreign.length) return { result: "blocklist_id_not_for_item", foreign_blocklist_ids: foreign, entries: blocklistReport(rows) }
  await arrFor(a.kind)("/blocklist/bulk", { method: "DELETE", body: { ids: a.remove_ids.map(Number) } })
  const left = await itemBlocklist(a.kind, serviceId)
  return { result: "removed", removed: a.remove_ids, count: left.length, entries: blocklistReport(left) }
}

async function previewRows(seriesId, downloadId) {
  const rows = await sonarr("/manualimport", { query: { downloadId, seriesId, filterExistingFiles: false } })
  return Array.isArray(rows) ? rows : []
}

const previewReport = (rows) => rows.map((r) => ({ path: r.path, name: r.name ?? null, parsed_season: r.seasonNumber ?? null,
  mapped_episodes: (r.episodes ?? []).map((e) => ({ episode_id: e.id ?? null, code: sxe(e), title: e.title ?? null })),
  quality: r.quality?.quality?.name ?? null, rejections: (r.rejections ?? []).map((x) => (typeof x === "string" ? x : x?.reason ?? String(x))) }))

export async function mediaManualImport(a) {
  if (a.service_id === undefined || a.service_id === null) return { result: "service_id_required" }
  if (!a.download_id) return { result: "download_id_required" }
  const seriesId = Number(a.service_id)
  const rows = await previewRows(seriesId, a.download_id)
  if (a.mode !== "import") return { mode: "preview", series_id: seriesId, download_id: a.download_id, files: previewReport(rows) }
  if (!Array.isArray(a.files) || !a.files.length || a.files.some((f) => !f || typeof f.path !== "string")) return { result: "files_required" }
  const paths = a.files.map((f) => f.path)
  if (new Set(paths).size !== paths.length) return { result: "duplicate_path" }
  const byPath = new Map(rows.map((r) => [r.path, r]))
  const unknown = a.files.filter((f) => !byPath.has(f.path)).map((f) => f.path)
  if (unknown.length) return { result: "path_not_in_preview", paths: unknown, files: previewReport(rows) }
  const seriesEps = await seriesEpisodes(seriesId)
  const own = new Set(seriesEps.map((e) => e.id))
  const foreign = a.files.flatMap((f) => (f.episode_ids ?? []).filter((id) => !own.has(id)))
  if (foreign.length) return { result: "episode_id_not_for_series", foreign_episode_ids: foreign }
  const empty = a.files.filter((f) => !Array.isArray(f.episode_ids) || !f.episode_ids.length).map((f) => f.path)
  if (empty.length) return { result: "episode_ids_required", paths: empty }
  const targets = a.files.flatMap((f) => f.episode_ids.map(Number))
  if (new Set(targets).size !== targets.length) return { result: "episode_id_on_two_files" }
  const files = a.files.map((f) => {
    const r = byPath.get(f.path)
    return { path: f.path, seriesId, episodeIds: f.episode_ids.map(Number), quality: r.quality, languages: r.languages, releaseGroup: r.releaseGroup ?? "",
             indexerFlags: r.indexerFlags ?? 0, releaseType: r.releaseType ?? "unknown", downloadId: a.download_id }
  })
  const c = await sonarr("/command", { method: "POST", body: { name: "ManualImport", files, importMode: "auto" } })
  // Episodes that already had a file: Sonarr treats these imports as replacements.
  const replacing = seriesEps.filter((e) => e.hasFile && targets.includes(e.id)).map((e) => ({ episode_id: e.id, code: sxe(e) }))
  return { mode: "import", imported: a.files.map((f) => ({ path: f.path, episode_ids: f.episode_ids })), ...(replacing.length ? { replacing } : {}), command: { id: c?.id ?? null, name: c?.name ?? "ManualImport", status: c?.status ?? null } }
}

// ------------------------------------------------------- tool: fill missing
//
// The whole "get the missing episodes" job as one deterministic pass, so a long
// request no longer depends on the model chaining a dozen calls correctly
// (2026-10-03: The Chef Show took an owner hint, a wrong pack, an invented
// parameter and the step cap). Each call re-reads Sonarr, so it is safe to call
// again: in-flight grabs are never repeated, and once nothing is missing it says
// stop. Release names follow streaming numbering, so releases are matched to
// episodes by episode title and air year as well as by Sonarr's own parse.

const FILL_MAX_GRABS = 3
const FILL_DEADLINE_MS = 150_000
const FILL_RECENT_GRAB_MS = 15 * 60_000
const FILL_EVIDENCE_ROWS = 5

const yearsIn = (title) => new Set((String(title ?? "").match(/(?<![0-9])(?:19|20)[0-9]{2}(?![0-9])/g) ?? []).map(Number))
const airYear = (e) => (e.airDate ? Number(String(e.airDate).slice(0, 4)) : null)
const hasWord = (haystack, needle) => needle.length > 0 && ` ${haystack} `.includes(` ${needle} `)
const rejectionTexts = (r) => (Array.isArray(r.rejections) ? r.rejections.map((x) => (typeof x === "string" ? x : x?.reason ?? String(x))) : [])

// An episode title is evidence only when it is distinctive enough not to appear by chance:
// several words, or one long word that is not a generic release term.
const GENERIC_TITLE_WORDS = new Set(["special", "specials", "episode", "finale", "premiere", "extended", "complete", "unknown", "untitled", "trailer", "preview", "bonus"])
function episodeTitleIn(releaseNorm, episode) {
  const t = normalizeTitle(episode.title)
  const distinctive = t.includes(" ") ? t.length >= 6 : t.length >= 7 && !GENERIC_TITLE_WORDS.has(t) && !/^[0-9]+$/.test(t)
  return distinctive && hasWord(releaseNorm, t)
}

// Season named in a release title: "Season 2", "Temporada 2", "S02" (not "S02E01").
export function seasonInTitle(title) {
  const s = String(title ?? "")
  const word = s.match(/\b(?:season|temporada|saison|staffel)\s*0*([0-9]{1,2})\b/i)
  if (word) return Number(word[1])
  const code = s.match(/\bS0*([0-9]{1,2})(?![0-9]|\s*E[0-9])\b/i)
  return code ? Number(code[1]) : null
}

// Which wanted episodes one release really holds, and on what evidence; or why it is unusable.
export function matchReleaseToEpisodes(release, { seriesTitle, wanted, have }) {
  const title = release.title ?? ""
  const norm = normalizeTitle(title)
  const rejections = rejectionTexts(release)
  if (!hasWord(norm, normalizeTitle(seriesTitle))) return { reject: "other_series" }
  if (rejections.some((x) => /blocklist/i.test(x))) return { reject: "blocklisted" }
  if (rejections.some((x) => /not wanted in profile|below .*minimum|custom format/i.test(x))) return { reject: "quality_not_wanted" }
  const wantedYears = new Set(wanted.map(airYear).filter(Boolean))
  const years = yearsIn(title)
  if (years.size && ![...years].some((y) => wantedYears.has(y))) return { reject: "year_mismatch", years: [...years] }
  const byTitle = wanted.filter((e) => episodeTitleIn(norm, e))
  if (byTitle.length) return { episode_ids: byTitle.map((e) => e.id), basis: "episode_title" }
  if (have.some((e) => episodeTitleIn(norm, e))) return { reject: "holds_episodes_we_have" }
  const wantedIds = new Set(wanted.map((e) => e.id))
  const mapped = (release.mappedEpisodeInfo ?? []).map((e) => e.id).filter((id) => id !== undefined && id !== null)
  const mappedWanted = mapped.filter((id) => wantedIds.has(id))
  if (mappedWanted.length) return { episode_ids: mappedWanted, basis: "sonarr_parse" }
  // A season pack named with the season and the air year of the missing episodes
  // ("The Chef Show [Season 2] (2020)"), whatever Sonarr's scene mapping says it holds.
  const season = seasonInTitle(title) ?? (release.fullSeason ? release.seasonNumber ?? null : null)
  if (season !== null && years.size && !/\bE[0-9]{1,3}\b/i.test(title)) {
    const covered = wanted.filter((e) => e.seasonNumber === season && years.has(airYear(e)))
    if (covered.length) return { episode_ids: covered.map((e) => e.id), basis: "season_and_air_year" }
  }
  return { reject: mapped.length ? "holds_episodes_we_have" : "no_episode_match" }
}

// Why a download is not going to finish on its own, or null while it is moving.
export function stallReason(row, nowMs) {
  if (isStalledRow(row, nowMs)) return (row.sizeleft ?? 0) >= (row.size ?? 0) ? "never_started" : "unfinished_for_days"
  const left = row.sizeleft ?? 0
  const ageHours = row.added ? (nowMs - Date.parse(row.added)) / 3_600_000 : 0
  const moving = row.status === "downloading" || row.status === "warning"
  // Sonarr reports no time left for a torrent with no peers; only trust that once it is old.
  if (moving && left > 0 && (row.timeleft === undefined || row.timeleft === null || row.timeleft === "00:00:00") && ageHours >= STALL_AFTER_HOURS) return "no_peers"
  return null
}

const importDone = (row) => (row.sizeleft ?? 0) === 0 || row.status === "completed"
const importNeeded = (row) => importDone(row) && ["importPending", "importBlocked", "importFailed"].includes(row.trackedDownloadState)

async function seriesGrabHistory(seriesId) {
  const list = await sonarr("/history/series", { query: { seriesId, eventType: "grabbed" } })
  return Array.isArray(list) ? list : []
}

async function runningImportFor(downloadId) {
  const list = await sonarr("/command")
  return (Array.isArray(list) ? list : []).some((c) => c.name === "ManualImport" && ["queued", "started"].includes(c.status)
    && (c.body?.files ?? []).some((f) => f.downloadId === downloadId))
}

// Map a finished download's files to the wanted episodes by title; only unique matches are imported.
async function importByTitle(seriesId, downloadId, wantedEps) {
  if (await runningImportFor(downloadId)) return { action: "import_already_running", download_id: downloadId }
  const rows = await previewRows(seriesId, downloadId)
  const wantedIds = new Set(wantedEps.map((e) => e.id))
  const picks = []
  const unmatched = []
  for (const r of rows) {
    const norm = normalizeTitle(`${r.name ?? ""} ${r.relativePath ?? ""}`)
    const byTitle = wantedEps.filter((e) => episodeTitleIn(norm, e)).map((e) => e.id)
    const byParse = (r.episodes ?? []).map((e) => e.id).filter((id) => wantedIds.has(id))
    const ids = byTitle.length === 1 ? byTitle : byTitle.length === 0 && byParse.length ? byParse : []
    if (ids.length) picks.push({ row: r, ids })
    else unmatched.push(r.name ?? r.path)
  }
  const counts = new Map()
  for (const p of picks) for (const id of p.ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  const unique = picks.filter((p) => p.ids.every((id) => counts.get(id) === 1))
  for (const p of picks) if (!unique.includes(p)) unmatched.push(p.row.name ?? p.row.path)
  if (!unique.length) return { action: "import_needs_mapping", download_id: downloadId, unmatched_files: unmatched }
  const files = unique.map(({ row: r, ids }) => ({ path: r.path, seriesId, episodeIds: ids, quality: r.quality, languages: r.languages, releaseGroup: r.releaseGroup ?? "",
    indexerFlags: r.indexerFlags ?? 0, releaseType: r.releaseType ?? "unknown", downloadId }))
  const c = await sonarr("/command", { method: "POST", body: { name: "ManualImport", files, importMode: "auto" } })
  return { action: "imported_by_title", download_id: downloadId, command_id: c?.id ?? null,
           files: unique.map(({ row: r, ids }) => ({ file: r.name ?? r.path, episode_ids: ids })), ...(unmatched.length ? { unmatched_files: unmatched } : {}) }
}

const pct = (row) => ((row.size ?? 0) > 0 ? Math.round((((row.size ?? 0) - (row.sizeleft ?? 0)) / row.size) * 1000) / 10 : null)

export async function mediaFillMissing(a, { nowMs = Date.now(), deadlineMs = FILL_DEADLINE_MS } = {}) {
  const startedAt = Date.now()
  const timeLeft = () => Date.now() - startedAt < deadlineMs
  const found = await resolveLibraryItem({ kind: "series", service_id: a.service_id, title: a.series })
  if (!found.item) return { result: found.result, candidates: found.candidates, message: "Name the series by its Sonarr service_id or exact title." }
  const seriesId = found.item.id
  const seriesTitle = found.item.title
  const season = a.season_number === undefined || a.season_number === null ? null : Number(a.season_number)
  const scope = (await seriesEpisodes(seriesId, season ?? undefined)).filter((e) => (season === null ? e.seasonNumber > 0 : true))
  const aired = (e) => Boolean(e.airDateUtc ?? e.airDate) && Date.parse(e.airDateUtc ?? e.airDate) <= nowMs
  const missing = scope.filter((e) => !e.hasFile && aired(e))
  const wanted = missing.filter((e) => e.monitored)
  const have = scope.filter((e) => e.hasFile)
  const code = (e) => ({ episode_id: e.id, code: sxe(e), title: e.title ?? null, air_date: e.airDate ?? null })
  const base = { series_id: seriesId, series: seriesTitle, season_number: season, checked_at: new Date(nowMs).toISOString(),
                 on_shelf: { count: have.length, of: scope.filter(aired).length },
                 ...(missing.length > wanted.length ? { not_monitored_missing: missing.filter((e) => !e.monitored).map(code) } : {}) }
  if (!wanted.length) {
    return { ...base, goal_met: true, in_flight: [], not_found: [], actions: [],
             summary: `Nothing monitored is missing: ${have.length} of ${base.on_shelf.of} aired episodes are on the shelf.`,
             next_step: "Goal met. Stop here and tell the owner; do not search or grab anything else." }
  }

  const actions = []
  const byId = new Map(wanted.map((e) => [e.id, e]))
  const queue = await itemQueue("series", seriesId)
  const history = await seriesGrabHistory(seriesId)
  const grabbedFor = new Map()
  for (const h of history) {
    if (!h.downloadId) continue
    const key = String(h.downloadId).toUpperCase()
    if (!grabbedFor.has(key)) grabbedFor.set(key, { ids: new Set(), date: h.date, title: h.sourceTitle })
    grabbedFor.get(key).ids.add(h.episodeId)
  }
  // Sonarr re-parses a tracked download's name, so its queue rows can point at the
  // wrong episodes; the grab history keeps the mapping the grab was made with.
  const downloads = new Map()
  for (const r of queue) {
    const key = String(r.downloadId ?? `row:${r.id}`).toUpperCase()
    if (!downloads.has(key)) downloads.set(key, { key, row: r, ids: new Set(grabbedFor.get(key)?.ids ?? []) })
    if (!grabbedFor.has(key)) downloads.get(key).ids.add(r.episodeId)
  }
  for (const [key, g] of grabbedFor) {
    if (!downloads.has(key) && nowMs - Date.parse(g.date) < FILL_RECENT_GRAB_MS) downloads.set(key, { key, row: null, ids: g.ids, title: g.title, recent: true })
  }

  const covered = new Set()
  const stalled = []
  const inFlight = []
  for (const d of downloads.values()) {
    const ids = wanted.map((e) => e.id).filter((id) => d.ids.has(id))
    if (!ids.length) continue
    const entry = { title: d.row?.title ?? d.title ?? null, download_id: d.row?.downloadId ?? d.key, episodes: ids.map((id) => sxe(byId.get(id))) }
    if (!d.row) { inFlight.push({ ...entry, state: "just_grabbed" }); ids.forEach((id) => covered.add(id)); continue }
    if (importNeeded(d.row)) {
      const done = await importByTitle(seriesId, d.row.downloadId, ids.map((id) => byId.get(id)))
      actions.push(done)
      inFlight.push({ ...entry, state: done.action === "import_needs_mapping" ? "downloaded_needs_mapping" : "importing" })
      ids.forEach((id) => covered.add(id))
      continue
    }
    const why = stallReason(d.row, nowMs)
    const info = { ...entry, percent: pct(d.row), queue_id: d.row.id, added: d.row.added ?? null }
    if (why) stalled.push({ ...info, ids, stall: why })
    else { inFlight.push({ ...info, state: importDone(d.row) ? "importing" : "downloading" }); ids.forEach((id) => covered.add(id)) }
  }

  // Search for everything not covered by a moving download, stalled ones included.
  const need = wanted.filter((e) => !covered.has(e.id))
  const searched = []
  const candidates = new Map()
  const rejected = new Map()
  const inFlightTitles = new Set([...downloads.values()].map((d) => normalizeTitle(d.row?.title ?? d.title)))
  const consider = (raw) => {
    for (const r of Array.isArray(raw) ? raw : []) {
      if (!r?.guid || candidates.has(r.guid) || rejected.has(r.guid)) continue
      const m = matchReleaseToEpisodes(r, { seriesTitle, wanted: need, have })
      const sameAsInFlight = inFlightTitles.has(normalizeTitle(r.title))
      if (m.reject || sameAsInFlight) { rejected.set(r.guid, { title: r.title ?? null, seeders: r.seeders ?? null, reason: sameAsInFlight ? "same_release_as_stalled_download" : m.reject }); continue }
      cacheRelease(`series:${r.guid}`, { ...releaseRow("series", r), service_id: seriesId, season_number: null, quality_raw: r.quality ?? null, languages_raw: r.languages ?? null })
      candidates.set(r.guid, { raw: r, ids: m.episode_ids, basis: m.basis })
    }
  }
  const hasSeededCandidate = (e) => [...candidates.values()].some((c) => (c.raw.seeders ?? 0) > 0 && c.ids.includes(e.id))
  if (need.length) {
    for (const s of [...new Set(need.map((e) => e.seasonNumber))].slice(0, 2)) {
      if (!timeLeft()) break
      searched.push(`Sonarr season search S${code2(s)}`)
      consider(await sonarr("/release", { query: { seriesId, seasonNumber: s }, timeoutMs: SEARCH_TIMEOUT_MS }))
    }
    const stillNeed = need.filter((e) => !hasSeededCandidate(e))
    for (const e of stillNeed.slice(0, MAX_EPISODE_SEARCHES)) {
      if (!timeLeft()) break
      searched.push(`Sonarr episode search ${sxe(e)}`)
      consider(await sonarr("/release", { query: { episodeId: e.id }, timeoutMs: SEARCH_TIMEOUT_MS }))
    }
  }

  // Seeded releases first, then the ones that cover the most, then the best seeded.
  const ranked = [...candidates.values()].sort((x, y) =>
    Number((y.raw.seeders ?? 0) > 0) - Number((x.raw.seeders ?? 0) > 0) || y.ids.length - x.ids.length || (y.raw.seeders ?? 0) - (x.raw.seeders ?? 0))
  const remaining = new Set(need.map((e) => e.id))
  const stalledIds = new Set(stalled.flatMap((s) => s.ids))
  for (const c of ranked) {
    if (actions.filter((x) => x.action === "grabbed").length >= FILL_MAX_GRABS) break
    const ids = c.ids.filter((id) => remaining.has(id))
    if (!ids.length) continue
    const seeded = (c.raw.seeders ?? 0) > 0
    // An unseeded release is no better than a stalled download: keep waiting on that instead.
    if (!seeded && ids.every((id) => stalledIds.has(id))) continue
    if (!c.raw.quality) continue
    // Replace a stalled download only with a release that holds everything it was fetching.
    for (const s of stalled.filter((x) => !x.replaced && x.ids.every((id) => ids.includes(id)))) {
      await sonarr(`/queue/${s.queue_id}`, { method: "DELETE", query: { removeFromClient: true, blocklist: true, skipRedownload: true } })
      s.replaced = true
      actions.push({ action: "blocklisted_stalled", title: s.title, percent: s.percent, stall: s.stall })
    }
    const body = { guid: c.raw.guid, indexerId: c.raw.indexerId, seriesId, episodeIds: ids, shouldOverride: true, quality: c.raw.quality, languages: Array.isArray(c.raw.languages) ? c.raw.languages : [] }
    const res = await sonarr("/release", { method: "POST", body })
    ids.forEach((id) => remaining.delete(id))
    actions.push({ action: "grabbed", title: c.raw.title ?? null, indexer: c.raw.indexer ?? null, seeders: c.raw.seeders ?? null, matched_by: c.basis,
                   episodes: ids.map((id) => sxe(byId.get(id))), download_id: res?.downloadId ?? null, ...(seeded ? {} : { may_never_finish: true }) })
    inFlight.push({ title: c.raw.title ?? null, download_id: res?.downloadId ?? null, episodes: ids.map((id) => sxe(byId.get(id))), state: "just_grabbed" })
  }
  for (const s of stalled.filter((x) => !x.replaced)) {
    inFlight.push({ title: s.title, download_id: s.download_id, episodes: s.episodes, percent: s.percent, queue_id: s.queue_id, added: s.added, state: "stalled", stall: s.stall,
                    note: "No other usable release was found, so this download was kept in case peers return." })
    s.ids.forEach((id) => remaining.delete(id))
  }

  const notFound = need.filter((e) => remaining.has(e.id)).map(code)
  const stuck = inFlight.filter((x) => x.state === "stalled")
  let evidence
  if (notFound.length || stuck.length) {
    // What exists on the indexers under any name, so a "can't find it" is backed by a listing.
    evidence = []
    const open = notFound.length ? need.filter((e) => remaining.has(e.id)) : wanted
    const ys = [...new Set(open.map((e) => e.airDate?.slice(0, 4)).filter(Boolean))].slice(0, 2)
    const scene = [...new Set(open.map((e) => e.sceneSeasonNumber).filter((n) => Number.isInteger(n)))].slice(0, 1)
    const queries = [...(ys.length ? ys : [""]).map((y) => `${seriesTitle} ${y}`.trim()), ...scene.map((n) => `${seriesTitle} S${code2(n)}`)]
    for (const q of queries) {
      if (!timeLeft()) break
      const raw = await prowlarr("/search", { query: { query: q, type: "search", limit: 100 }, timeoutMs: SEARCH_TIMEOUT_MS })
      const rows = (Array.isArray(raw) ? raw : []).sort((x, y) => (y.seeders ?? -1) - (x.seeders ?? -1)).slice(0, FILL_EVIDENCE_ROWS)
      evidence.push({ query: q, results: (Array.isArray(raw) ? raw.length : 0), top: rows.map((r) => ({ title: r.title ?? null, seeders: r.seeders ?? null, indexer: r.indexer ?? null })) })
    }
  }
  const grabbed = actions.filter((x) => x.action === "grabbed").length
  const summary = [
    `${have.length} of ${base.on_shelf.of} aired episodes are on the shelf; ${wanted.length} monitored ${wanted.length === 1 ? "episode is" : "episodes are"} missing.`,
    grabbed ? `Grabbed ${grabbed} release${grabbed === 1 ? "" : "s"} now.` : "",
    inFlight.filter((x) => x.state !== "stalled").length ? `${inFlight.filter((x) => x.state !== "stalled").length} download(s) in progress.` : "",
    stuck.length ? `${stuck.length} download(s) stalled with no peers and no other usable release (${stuck.map((s) => `${s.title} at ${s.percent}%`).join("; ")}).` : "",
    notFound.length ? `No usable release found for ${notFound.map((e) => e.code).join(", ")}.` : "",
  ].filter(Boolean).join(" ")
  const nextStep = stuck.length || notFound.length
    ? "Tell the owner exactly this outcome with the evidence; do not grab, import or blocklist anything by hand. Call media_fill_missing again later to retry."
    : "Work is in progress. Tell the owner what is downloading; call media_fill_missing again later to import and confirm. Do not search or grab anything else now."
  return { ...base, goal_met: false, in_flight: inFlight.map(({ ids, ...x }) => x), not_found: notFound, actions,
           searched, ...(rejected.size ? { rejected_releases: [...rejected.values()].slice(0, 12) } : {}), ...(evidence ? { indexer_evidence: evidence } : {}),
           ...(timeLeft() ? {} : { incomplete: true }), summary, next_step: nextStep }
}

// ------------------------------------------------------------------- schema

// The harness waits 30 s for a tool call unless the tool declares longer; indexer searches can take minutes.
const TIMEOUT_META_KEY = "ouro.bot/timeoutMs"

const TOOL_LIST = [
  {
    name: "media_search",
    annotations: { readOnlyHint: true },
    description: "Search or browse the household media catalogue. Use `query` for a title lookup: partial and misspelled titles are matched against the library first (Sonarr, Radarr, Jellyfin) and returned as `library_matches` with their kind and service id, and when nothing in the library matches, `lookup_candidates` (TVDB/TMDB) cover titles not in the library. Never say a title does not exist without reading both; use `genres`/`keywords`/`year_range` to browse by vibe (e.g. keywords ['autumn','thanksgiving'] for cozy fall films). `on_shelf: true` restricts to what is already downloaded, `false` to what is not, omit for both. Every item says whether it is on the shelf and carries its tmdb_id so a follow-up media_request needs no second lookup.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "Title or free text. Omit to browse by filters." },
      kind: { type: "string", enum: ["movie", "series", "any"], description: "Default any." },
      year_range: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[minYear, maxYear]" },
      genres: { type: "array", items: { type: "string" }, description: "TMDB genre names, e.g. ['Romance','Drama']." },
      keywords: { type: "array", items: { type: "string" }, description: "TMDB keywords, e.g. ['autumn','small town']. Best lever for mood/vibe requests." },
      on_shelf: { type: "boolean", description: "true = only what we already have; false = only what we do not; omit = both." },
      limit: { type: "number", description: "1-20, default 12." },
      sort: { type: "string", enum: ["relevance", "release_year"] },
    } },
  },
  {
    name: "media_request",
    description: "Request a film or series so it gets downloaded. Give tmdb_id when known (from media_search), otherwise title plus optional year. Idempotent: if it was already requested you get approval_state 'already_requested' and duplicate_of, never a duplicate. Returns the downstream sonarr_id/radarr_id so media_request_status needs no re-resolution.",
    inputSchema: { type: "object", properties: {
      tmdb_id: { type: "number" },
      title: { type: "string" },
      year: { type: "number" },
      kind: { type: "string", enum: ["movie", "series"] },
      season_number: { type: "number", description: "Series only. Omit to request all seasons." },
    } },
  },
  {
    name: "media_request_status",
    annotations: { readOnlyHint: true },
    description: "One call, every stage: request, indexer search, download, file on disk, plus acquisition-chain health and a deterministic `diagnosis` block naming what is stuck, why, and the fix. Use this for any 'is it here yet?' or 'why hasn't X downloaded?' question. A queue row is not proof of progress: a release sitting at zero bytes comes back as stalled, not as downloading. Never infer the cause yourself — read diagnosis.summary.",
    inputSchema: { type: "object", properties: {
      request_id: { type: "string", description: "e.g. jellyseerr:42" },
      tmdb_id: { type: "number" },
      title: { type: "string" },
    } },
  },
  {
    name: "media_diagnose_and_fix",
    description: "Act on a stuck request. Omit `action` to apply the fix that media_request_status already identified, including 'blocklist_and_research' for a release that has stalled at zero bytes. Refuses to act (result 'rejected_fix_unsafe') when the acquisition chain itself is down, because re-searching cannot help then. Use dry_run to preview.",
    inputSchema: { type: "object", properties: {
      request_id: { type: "string" }, tmdb_id: { type: "number" }, title: { type: "string" },
      action: { type: "string", enum: ["rescan", "enable_monitoring", "force_import_scan", "blocklist_and_research", "report_only"] },
      dry_run: { type: "boolean" },
    } },
  },
  {
    name: "media_chain_health",
    annotations: { readOnlyHint: true },
    description: "Health of the whole acquisition chain: Prowlarr indexers, their failure state, and whether Prowlarr is syncing to Sonarr/Radarr. Call this when several things are stuck at once, or before telling anyone a specific title is the problem — a dead chain blocks everything and is the single most likely cause.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "media_play_or_resolve",
    description: "Resolve something on the shelf to a playable link plus what is actually on disk (episode counts, size, path). If it is not playable you get the same diagnosis block explaining why.",
    inputSchema: { type: "object", properties: {
      request_id: { type: "string" }, tmdb_id: { type: "number" }, title: { type: "string" },
    } },
  },
  {
    name: "media_search_now",
    description: "Trigger a Sonarr/Radarr search for a series or movie that is already in the library, and report its queue. Use this when the owner asks to search, re-search, or look again for something already in Sonarr/Radarr; no Jellyseerr request id is needed. Identify it by service_id, tmdb_id, or exact title. Never adds anything new: zero or several matches come back as 'not_found' or 'ambiguous' with candidates. Never tell the owner to click Search in the web UI.",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["series", "movie"] },
      service_id: { type: "number", description: "Sonarr series id or Radarr movie id." },
      title: { type: "string" },
      tmdb_id: { type: "number" },
    }, required: ["kind"] },
  },
  {
    name: "media_blocklist_stalled",
    description: "Clear stuck downloads for a series or movie already in Sonarr/Radarr: remove stalled queue rows from the download client, blocklist those releases so they are not grabbed again, then search again (research, default true). Use this when the owner asks to clear stuck or stalled downloads; no Jellyseerr request id is needed. Without queue_ids it targets the item's stalled rows; with queue_ids only those, and each must belong to the item. Explicit queue_ids are removed even if still downloading, so pass them only when the owner named those downloads. Rows of one season pack are removed once; a delete that fails is reported in `failed` and the re-search still runs.",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["series", "movie"] },
      service_id: { type: "number", description: "Sonarr series id or Radarr movie id (media_search_now returns it)." },
      queue_ids: { type: "array", items: { type: "number" } },
      research: { type: "boolean", description: "Search again afterwards. Default true." },
    }, required: ["kind", "service_id"] },
  },
  {
    name: "media_fill_missing",
    _meta: { [TIMEOUT_META_KEY]: 240_000 },
    description: "Get a series' missing episodes, start to finish, in one call. Use this first whenever the owner asks why episodes are missing or asks to get them. It re-reads Sonarr, finds the monitored aired episodes without files, searches the indexers, matches releases to episodes by episode title and air year as well as Sonarr's parse (so streaming-volume numbering cannot fool it), prefers seeded releases, skips packs of episodes already on the shelf, grabs with the right episode mapping, imports finished downloads by title, and replaces a stalled download when a usable alternative exists. Returns on_shelf, in_flight, not_found, actions, indexer_evidence, summary and next_step. Safe to call again: it never grabs what is already in flight. When goal_met is true, stop. Report summary and next_step as they are; do not redo its steps by hand.",
    inputSchema: { type: "object", properties: {
      series: { type: "string", description: "Series title as the owner said it." },
      service_id: { type: "number", description: "Sonarr series id, when known." },
      season_number: { type: "number", description: "Limit to one season. Omit for the whole series (specials excluded)." },
    } },
  },
  {
    name: "media_episodes",
    annotations: { readOnlyHint: true },
    description: "List a Sonarr series' episodes (optionally one season): episode_id, SxxEyy code, scene_code (the numbering release names use, when Sonarr has a mapping), title, air date, has_file. Use it to see what the TVDB numbering calls each episode before searching for releases by hand.",
    inputSchema: { type: "object", properties: {
      service_id: { type: "number", description: "Sonarr series id." },
      season_number: { type: "number" },
    }, required: ["service_id"] },
  },
  {
    name: "media_indexer_search",
    annotations: { readOnlyHint: true },
    _meta: { [TIMEOUT_META_KEY]: 200_000 },
    description: "Free-text search across every indexer (Prowlarr), sorted by seeders. Discovery only, it grabs nothing. Use it when Sonarr/Radarr's own search finds nothing: try the scene code from media_episodes, 'Season N', the year, or an episode title, to learn whether any release exists and how it is named. Zero seeders means it cannot download right now.",
    inputSchema: { type: "object", properties: {
      query: { type: "string" },
      limit: { type: "number", description: "1-50, default 25." },
    }, required: ["query"] },
  },
  {
    name: "media_release_search",
    annotations: { readOnlyHint: true },
    _meta: { [TIMEOUT_META_KEY]: 240_000 },
    description: "Interactive release search for a series or movie already in the library: what the indexers offer and how Sonarr/Radarr parsed each release (full_season, parsed_season, parsed_episodes, mapped_episodes), whether it is rejected and why, and whether it is blocklisted. Series: give season_number or episode_ids. Can take a minute or more. `query` filters returned titles. Use it when the automatic search found nothing, then grab with media_release_grab.",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["series", "movie"] },
      service_id: { type: "number", description: "Sonarr series id or Radarr movie id." },
      season_number: { type: "number" },
      episode_ids: { type: "array", items: { type: "number" } },
      query: { type: "string", description: "Case-insensitive text the release title must contain." },
      limit: { type: "number", description: "1-100, default 40." },
    }, required: ["kind", "service_id"] },
  },
  {
    name: "media_release_grab",
    description: "Grab one release from the last media_release_search by guid and indexer_id. For a release Sonarr mis-parsed (streaming numbering vs TVDB), pass series_id plus episode_ids to override the mapping; episode_ids must belong to the series. Without episode_ids, a season pack that Sonarr parsed as a different season than season_number is refused ('season_pack_mismatch'). Returns the exact request sent and Sonarr's answer.",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["series", "movie"] },
      guid: { type: "string" },
      indexer_id: { type: "number" },
      series_id: { type: "number", description: "Required with episode_ids." },
      episode_ids: { type: "array", items: { type: "number" }, description: "Episodes this release really holds." },
      season_number: { type: "number", description: "Target season, checked against a season pack's parsed season when episode_ids is omitted." },
      download_client_id: { type: "number" },
    }, required: ["kind", "guid", "indexer_id"] },
  },
  {
    name: "media_blocklist",
    description: "List the blocklist for a series or movie in Sonarr/Radarr, and optionally remove entries (remove_ids) so the release can be grabbed again. Each id must belong to the item; a foreign id removes nothing.",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["series", "movie"] },
      service_id: { type: "number" },
      remove_ids: { type: "array", items: { type: "number" } },
    }, required: ["kind", "service_id"] },
  },
  {
    name: "media_manual_import",
    description: "Map downloaded files to episodes by hand when their names carry the wrong numbering (Sonarr only). mode 'preview' lists the files of a download with the parsed and mapped episodes and rejections. mode 'import' takes files [{path, episode_ids}]: paths must come from that download's preview and episode_ids must belong to the series; quality and languages come from the preview. Match files to episodes by title using media_episodes.",
    inputSchema: { type: "object", properties: {
      mode: { type: "string", enum: ["preview", "import"], description: "Default preview." },
      service_id: { type: "number", description: "Sonarr series id." },
      download_id: { type: "string", description: "Download client id of the completed download (queue row downloadId)." },
      files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, episode_ids: { type: "array", items: { type: "number" } } }, required: ["path", "episode_ids"] } },
    }, required: ["service_id", "download_id"] },
  },
]

// Every schema is closed: an argument the tool does not define (an invented dry_run,
// a misspelled id) is refused with its name, never silently ignored.
function closeSchema(schema) {
  if (!schema || typeof schema !== "object" || schema.type !== "object") return schema
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, v?.type === "array" && v.items ? { ...v, items: closeSchema(v.items) } : closeSchema(v)]))
  return { ...schema, properties, additionalProperties: false }
}

export const TOOLS = TOOL_LIST.map((t) => ({ ...t, inputSchema: closeSchema(t.inputSchema) }))

// The same check inside the server, for any caller that does not validate against the schema.
export function unknownArguments(toolName, args) {
  const tool = TOOLS.find((t) => t.name === toolName)
  const allowed = Object.keys(tool?.inputSchema?.properties ?? {})
  const unknown = Object.keys(args ?? {}).filter((k) => !allowed.includes(k))
  return unknown.length ? { error: "unknown_parameter", unknown, allowed,
    message: `${toolName} does not take ${unknown.map((k) => `'${k}'`).join(", ")}. It accepts only: ${allowed.join(", ") || "no parameters"}. Call it again without the unknown parameter.` } : null
}

const HANDLERS = {
  media_search: mediaSearch,
  media_request: mediaRequest,
  media_request_status: mediaRequestStatus,
  media_diagnose_and_fix: mediaDiagnoseAndFix,
  media_chain_health: mediaChainHealth,
  media_play_or_resolve: mediaPlayOrResolve,
  media_search_now: mediaSearchNow,
  media_blocklist_stalled: mediaBlocklistStalled,
  media_episodes: mediaEpisodes,
  media_fill_missing: mediaFillMissing,
  media_indexer_search: mediaIndexerSearch,
  media_release_search: mediaReleaseSearch,
  media_release_grab: mediaReleaseGrab,
  media_blocklist: mediaBlocklist,
  media_manual_import: mediaManualImport,
}

// ------------------------------------------------------------ jsonrpc stdio

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n") }

async function handle(msg) {
  const { id, method, params } = msg
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "sanctuary-media", version: "1.0.0" },
    } })
  }
  if (method === "initialized" || method === "notifications/initialized") return
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } })
  if (method === "tools/call") {
    const fn = HANDLERS[params?.name]
    if (!fn) return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: `Unknown tool: ${params?.name}` }] } })
    if (credError) {
      const payload = { error: "credentials_unavailable", message: credError, human_action_required: true,
                        human_action_reason: credError }
      return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(payload, null, 1) }] } })
    }
    const unknown = unknownArguments(params.name, params.arguments)
    if (unknown) return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(unknown, null, 1) }] } })
    try {
      const out = await fn(params.arguments ?? {})
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] } })
    } catch (e) {
      const payload = { error: e.code ?? "tool_failed", message: e.message,
                        human_action_required: true,
                        human_action_reason: `The media tool could not complete: ${e.message}. Report this failure rather than guessing the answer.` }
      return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(payload, null, 1) }] } })
    }
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
}

let buf = ""
let inFlight = 0
let stdinClosed = false

// Exit only when stdin is closed AND nothing is still running. Exiting on 'end'
// alone drops in-flight tool calls, which silently truncates a slow answer.
function exitWhenIdle() {
  if (stdinClosed && inFlight === 0) process.exit(0)
}

// Only run the stdio server when invoked directly (node media-mcp.mjs, exactly
// how agent.json launches it). Guarding this lets the test suite import the
// module for computeDownloadState/diagnose without attaching to stdin or exiting
// the test process. The launch is a plain node <abs-path>, so argv[1] is the
// file's own path and this comparison holds.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      inFlight += 1
      handle(msg)
        .catch((e) => {
          if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e.message } })
        })
        .finally(() => { inFlight -= 1; exitWhenIdle() })
    }
  })
  process.stdin.on("end", () => { stdinClosed = true; exitWhenIdle() })
}
