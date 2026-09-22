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

const TIMEOUT_MS = 45_000

// ---------------------------------------------------------------- http helpers

async function req(base, path, { key, header = "X-Api-Key", method = "GET", body, query } = {}) {
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
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    throw new ServiceError(`${serviceOf(base)}_unreachable`, `${serviceOf(base)} did not respond: ${e.name === "TimeoutError" ? "timeout" : e.message}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new ServiceError(`${serviceOf(base)}_http_${res.status}`, `${serviceOf(base)} returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`)
  }
  if (res.status === 204) return null
  return res.json()
}

function serviceOf(base) {
  if (base === SEERR.url) return "jellyseerr"
  if (base === SONARR.url) return "sonarr"
  if (base === RADARR.url) return "radarr"
  if (base === PROWLARR.url) return "prowlarr"
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

// ------------------------------------------------------------- tool: search

async function mediaSearch(a) {
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
    applied_filters: { kind, year_range: a.year_range ?? null, genres: a.genres ?? [], keywords: a.keywords ?? [], on_shelf: onShelf ?? "any" },
    // So the agent never claims something is missing when the filter caused it:
    note: items.length === 0 ? "No matches for these filters. Loosen year_range/genres/keywords before concluding the shelf lacks it." : null,
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
  }
  return null
}

async function mediaRequestStatus(a) {
  const request = await resolveTarget(a)
  if (!request) {
    return { found: false, reason: "no_matching_request",
             searched: { request_id: a.request_id ?? null, tmdb_id: a.tmdb_id ?? null, title: a.title ?? null },
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
  // A season pack shows up as one queue row per episode, all sharing one
  // downloadId. Summing rows would report a 45 GB pack as 450 GB, so size and
  // "how many downloads" are both counted per distinct download, not per row.
  const byDownload = new Map()
  for (const r of queueRecs) byDownload.set(r.downloadId ?? `row:${r.id}`, r)
  const downloads = [...byDownload.values()]
  const sizeLeft = downloads.reduce((s, r) => s + (r.sizeleft ?? 0), 0)
  const sizeTotal = downloads.reduce((s, r) => s + (r.size ?? 0), 0)
  // A torrent that has not moved a byte since it was grabbed is not slow, it is
  // dead: no seeders, or a release the client cannot fetch. Radarr goes on
  // reporting trackedDownloadStatus "ok" for these indefinitely, so a queue row
  // on its own reads as healthy and any answer built from it reassures instead
  // of acting. Measuring progress against age is what separates the two.
  const now = Date.now()
  const stalledItems = downloads
    .filter((r) => (r.size ?? 0) > 0 && (r.sizeleft ?? 0) >= (r.size ?? 0) && r.added
      && (now - Date.parse(r.added)) / 3_600_000 >= STALL_AFTER_HOURS)
    .map((r) => ({
      title: r.title ?? null,
      added_at: r.added ?? null,
      age_hours: Math.round((now - Date.parse(r.added)) / 3_600_000),
      size_gb: Number(((r.size ?? 0) / 1073741824).toFixed(2)),
      queue_id: r.id ?? null,
    }))
  result.download = {
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

  const chain = await chainHealth()
  result.chain = chain
  result.diagnosis = diagnose({ shelf, result, chain, entity, kind })
  return result
}

// The deterministic core. The agent must never have to work this out itself.
function diagnose({ shelf, result, chain, entity, kind }) {
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

// ------------------------------------------------------------------- schema

const TOOLS = [
  {
    name: "media_search",
    description: "Search or browse the household media catalogue. Use `query` for a title lookup; use `genres`/`keywords`/`year_range` to browse by vibe (e.g. keywords ['autumn','thanksgiving'] for cozy fall films). `on_shelf: true` restricts to what is already downloaded, `false` to what is not, omit for both. Every item says whether it is on the shelf and carries its tmdb_id so a follow-up media_request needs no second lookup.",
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
]

const HANDLERS = {
  media_search: mediaSearch,
  media_request: mediaRequest,
  media_request_status: mediaRequestStatus,
  media_diagnose_and_fix: mediaDiagnoseAndFix,
  media_chain_health: mediaChainHealth,
  media_play_or_resolve: mediaPlayOrResolve,
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
