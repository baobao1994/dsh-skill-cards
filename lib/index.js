/**
 * Host half of dsh-skill-cards.
 *
 * Responsibilities:
 *  - Expose HTTP routes the browser client calls (relative path fetch).
 *  - Enumerate locally-installed skills (global + project roots).
 *  - Serve an optional cover image from each skill directory.
 *  - Persist the user's custom card config (image / title / description) per skill.
 *  - Introduce selected skills into the *current session* only, by registering
 *    them on the agent's session-scoped skills service (no disk writes, so other
 *    sessions and the global catalog are untouched). The introduced set is
 *    persisted so a host restart can replay it for that session.
 *
 * Slots occupied (host side): none. The UI lives entirely in the client half.
 * @module dsh-skill-cards
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { createLogger, readJsonBody, readRawBody, sameOrigin, sendError, sendJson, sendFile } from './http.js'
import { defaultDshHome, scanInstalled, readCover } from './skills-scan.js'
import {
  CATEGORY_DEFS, suggestCategory, bumpUse, readStats, writeStats, categoriesFor,
  readCustomCategories, addCustomCategory, removeCustomCategory, renameCustomCategory,
  PREF_VALUES, readPrefs, writePrefs,
} from './stats.js'

const NS = 'dsh-skill-cards'
/**
 * Route prefix. DSH forwards only `/api/*` and `/plugins/*` from the shell to
 * the plugin host; any other prefix is answered 404 by the shell before it ever
 * reaches `webServer`. `/plugins/<package-name>` is the house convention and is
 * what the other installed plugins use (e.g. `/plugins/dsh-trae-checkin/...`).
 *
 * NOTE: no trailing slash. The host matches a prefix route with
 *   `pathname === prefix || pathname.startsWith(prefix + '/')`
 * (dsh-host-webserver `match()`), so registering a trailing slash would demand a
 * double slash in the request path and nothing would ever match — the route
 * silently 404s while everything else looks healthy.
 */
const API_PREFIX = '/plugins/dsh-skill-cards'
/** Same prefix as it appears in a request path; used to strip the route tail. */
const API_BASE = `${API_PREFIX}/`
const GET_ROUTES = ['skills', 'cards', 'cover', 'active-session', 'image', 'vendor', 'stats', 'applied', 'prefs']
const POST_ROUTES = ['cards', 'introduce', 'revoke', 'image', 'stats', 'categories', 'i18n', 'prefs']

/** Where uploaded custom cover images are stored (as files, never base64 in JSON). */
const IMAGE_DIR_NAME = 'skill-cards-images'
/** MIME → extension for accepted uploads. */
const IMAGE_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
}

/** Where the custom card config (image/title/description per skill) is stored. */
function cardConfigPath(home) {
  return join(home, 'skill-cards.json')
}

function readCardConfig(home) {
  const p = cardConfigPath(home)
  if (!existsSync(p)) return {}
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function writeCardConfig(home, config) {
  const p = cardConfigPath(home)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(config, null, 2), 'utf8')
}

/** Directory where uploaded custom cover images are stored. */
function imageStoreDir(home) {
  return join(home, IMAGE_DIR_NAME)
}

/** Resolve the on-disk path for a stored image id. */
function imagePath(home, id) {
  return join(imageStoreDir(home), id)
}

/**
 * Persist an uploaded image as a file and return a protected route URL.
 *
 * The browser reads a local file as a data:/blob URL; we do NOT persist that
 * base64 string into skill-cards.json (it would balloon the config). Instead we
 * write the raw bytes to `~/.dsh/skill-cards-images/<sha256><ext>` and hand back
 * a `/plugins/.../image?id=...` URL that the GET route serves with a bounded
 * cache. Only that URL is stored in the card config.
 */
function saveImage(home, buffer, mime, ext = IMAGE_MIME[mime] ?? '.png') {
  const dir = imageStoreDir(home)
  mkdirSync(dir, { recursive: true })
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 24)
  const id = `${hash}${ext}`
  const p = join(dir, id)
  if (!existsSync(p)) writeFileSync(p, buffer)
  return `${API_BASE}image?id=${encodeURIComponent(id)}`
}

/**
 * Track the active session for requests that do NOT name one.
 *
 * Only `fallbackId` (the most recently active agent) is kept here. An earlier
 * version also stored an `explicitId` set by whichever client last mentioned a
 * session, which leaked across windows: the host is one process shared by every
 * open window, so window A applying skills set `explicitId = A`, and window B —
 * which sent no id — was then answered with A's skills. Session ids now travel
 * with each request; this tracker is a last resort only.
 */
class ActiveSessionTracker {
  constructor(ctx) {
    this.ctx = ctx
    this.fallbackId = undefined
    this._disposers = []
    this._wire()
  }

  _wire() {
    const agents = service(this.ctx, 'agents')
    if (agents && typeof agents.on === 'function') {
      try {
        const handler = (agent) => {
          const id = agent?.session?.id ?? agent?.id
          if (id) this.fallbackId = id
        }
        // When a session's agent is removed, any skills we introduced into it
        // die with the registration — drop the registry entry so /applied and
        // the composer chips never list resurrected skills.
        const gone = (agent) => {
          const id = agent?.session?.id ?? agent?.id
          if (id) clearSession(id)
        }
        // Cordis services usually expose an emittery-like `on`.
        this._disposers.push(agents.on('agent-added', handler))
        this._disposers.push(agents.on('active', handler))
        this._disposers.push(agents.on('agent-removed', gone))
        this._disposers.push(agents.on('removed', gone))
      } catch {
        /* events not available; rely on fallback scan */
      }
    }
  }

  /** Best-effort current session id, used only when a request names none. */
  current() {
    if (this.fallbackId) return this.fallbackId
    // Last resort: pick the first live agent.
    try {
      const agents = service(this.ctx, 'agents')
      if (agents && typeof agents.list === 'function') {
        const list = agents.list()
        const first = list && list[0]
        if (first) return first.session?.id ?? first.id
      }
    } catch {
      /* ignore */
    }
    return undefined
  }

  dispose() {
    for (const d of this._disposers) {
      try { d?.() } catch { /* ignore */ }
    }
  }
}

/**
 * Session-scoped registry of introduced skills.
 *
 * `introduceIntoSession` returns the skills-service disposer for each
 * registration; without keeping it there is no way to remove an applied skill
 * (previously the disposer was dropped on the floor, so "revoke" was
 * impossible without restarting the session). Keyed by sessionId → skill
 * name → disposer. Entries die with the host process, which matches the
 * session-scoped nature of the registration itself.
 */
const introduced = new Map()

function rememberIntroduced(sessionId, name, dispose) {
  if (!introduced.has(sessionId)) introduced.set(sessionId, new Map())
  introduced.get(sessionId).set(name, dispose)
}

/** Unregister one skill from a session. Returns false when it was not applied. */
function revokeIntroduced(sessionId, name) {
  const byName = introduced.get(sessionId)
  const dispose = byName?.get(name)
  if (!dispose) return false
  try { dispose() } catch { /* already gone */ }
  byName.delete(name)
  if (byName.size === 0) introduced.delete(sessionId)
  return true
}

/** Unregister every skill applied to a session (used when the agent dies). */
function clearSession(sessionId) {
  const byName = introduced.get(sessionId)
  if (!byName) return
  for (const dispose of byName.values()) {
    try { dispose() } catch { /* already gone */ }
  }
  introduced.delete(sessionId)
}

/**
 * Introduce a skill into a session by registering it on the agent's session
 * scope. Returns the disposer so we can also remove it later if desired.
 * Logic mirrors dshp-plugin-panel's introduceSkill.
 */
async function introduceIntoSession(ctx, agent, skill) {
  // Must register on the *agent's* session-scoped skills service, never the
  // host-global one — otherwise the skill would leak into every session.
  const skills = agent.ctx?.get?.('skills')
  if (skills === undefined) return { ok: false, reason: 'skills 服务不可用（会话级）' }
  const def = await readSkillContent(skill)
  if (def === undefined) return { ok: false, reason: `"${skill.name}" 不可读` }
  const dispose = skills.register({
    name: def.name,
    description: def.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'dsh-skill-cards-session',
    content: def.content,
    resourceBase: { kind: 'directory', path: skill.rootDir },
  })
  return { ok: true, name: def.name, dispose }
}

async function readSkillContent(skill) {
  try {
    const raw = await import('node:fs/promises').then((m) => m.readFile(skill.skillFile, 'utf8'))
    // description already parsed by the scanner; content is the full doc.
    return { name: skill.name, description: skill.description, content: raw }
  } catch {
    return undefined
  }
}

export const name = NS

/**
 * Only `webServer` is declared: the plugin cannot expose any UI without it.
 * `agents` / `skills` are deliberately NOT injected — `skills` is an
 * agent-scoped service, and awaiting it at the root scope makes Cordis pend
 * `apply()` forever, so the HTTP routes never register (the symptom: the button
 * appears from the client half, but every request 404s). They are read
 * opportunistically through `ctx.get()` instead, which answers `undefined`
 * while absent rather than suspending the fiber.
 */
export const inject = ['webServer']

/** Opportunistic service lookup — never throws, answers undefined while absent. */
function service(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name)
    return ctx?.[name]
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  const log = createLogger(ctx.logger, NS)
  const home = defaultDshHome()
  const tracker = new ActiveSessionTracker(ctx)

  ctx.inject(['webServer'], (hostCtx) => {
    const dispose = hostCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        // Strip "/plugins/dsh-skill-cards/" (with slash) to leave the route tail.
        const route = url.pathname.startsWith(API_BASE)
          ? url.pathname.slice(API_BASE.length)
          : url.pathname.slice(API_PREFIX.length).replace(/^\//, '')
        const method = request.method ?? 'GET'
        const cors = sameOrigin(request)
        if (cors) {
          sendError(response, 403, cors)
          return
        }
        try {
          await dispatch({ route, method, url, request, response, ctx, home, tracker, log })
        } catch (error) {
          log.warn(`${method} ${route} failed: ${error instanceof Error ? error.message : String(error)}`)
          if (!response.headersSent) {
            sendError(response, 500, error instanceof Error ? error.message : String(error))
          } else {
            response.end()
          }
        }
      },
    })
    hostCtx.effect(() => dispose, `${NS}: http routes`)
  })

  ctx.effect(() => tracker.dispose(), `${NS}: active session tracker`)
}

async function dispatch({ route, method, url, request, response, ctx, home, tracker, log }) {
  // Vendor static tails ("vendor/<file>") are not in GET_ROUTES (that list
  // holds bare route names) — admit them here; the vendor handler below
  // enforces its own allow-list.
  const isVendorTail = route === 'vendor' || route.startsWith('vendor/')
  if (!GET_ROUTES.includes(route) && !POST_ROUTES.includes(route) && !isVendorTail) {
    sendError(response, 404, `no such route: ${route}`)
    return
  }

  // ---- GET routes ----
  // Vendor static files shipped with the plugin (e.g. three.min.js for the 3D
  // card wall, card-back.jpg for the gacha back face). The route tail is
  // "vendor/<file>"; only allow-listed names are served, resolved against the
  // plugin's own vendor/ directory (import.meta.url is the package's lib/, so
  // ../vendor is the sibling directory).
  const VENDOR_FILES = {
    'three.min.js': 'application/javascript; charset=utf-8',
    'card-back.jpg': 'image/jpeg',
  }
  if (route === 'vendor' || route.startsWith('vendor/')) {
    const fileName = route.slice('vendor/'.length)
    const mime = VENDOR_FILES[fileName]
    if (method !== 'GET' || !mime) {
      sendError(response, 404, `no such vendor file: ${fileName}`)
      return
    }
    const vendorRoot = new URL('../vendor/', import.meta.url)
    const fileUrl = new URL(fileName, vendorRoot)
    // Stay inside the vendor directory (belt and braces after the allow-list).
    if (!fileUrl.pathname.startsWith(vendorRoot.pathname)) {
      sendError(response, 404, `no such vendor file: ${fileName}`)
      return
    }
    let buf
    try {
      buf = readFileSync(fileUrl)
    } catch {
      sendError(response, 404, `no such vendor file: ${fileName}`)
      return
    }
    response.writeHead(200, {
      'content-type': mime,
      'cache-control': 'public, max-age=31536000, immutable',
    })
    response.end(buf)
    return
  }
  if (route === 'skills' && method === 'GET') {
    const cwd = url.searchParams.get('cwd') || process.cwd()
    const scan = await scanInstalled(home, cwd)
    const skills = scan.skills
    const cards = readCardConfig(home)
    const stats = readStats(home)
    // Merge built-in + user-defined categories so the client can offer them all
    // (and so a skill assigned to a custom category resolves instead of falling
    // back to "其它"). Custom categories are flagged so the UI can make
    // built-in (auto-grouped) ones read-only versus user-editable ones.
    const customCats = readCustomCategories(stats)
    const defs = {
      ...CATEGORY_DEFS,
      ...Object.fromEntries(Object.entries(customCats).map(([id, def]) => [id, { ...def, custom: true }])),
    }
    const payload = skills.map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
      label: s.label || s.source,
      hasCover: s.hasCover,
      coverUrl: s.hasCover ? `${API_BASE}cover?skill=${encodeURIComponent(s.name)}` : null,
      custom: cards[s.name] ?? null,
      stats: stats[s.name] ?? null,
      category: categoriesFor({ name: s.name, description: s.description, stats: stats[s.name], defs }),
      suggestedCategory: suggestCategory(s.name, s.description),
    }))
    sendJson(response, 200, { ok: true, skills: payload, categories: defs, roots: scan.diagnostics })
    return
  }

  if (route === 'cards' && method === 'GET') {
    sendJson(response, 200, { ok: true, cards: readCardConfig(home) })
    return
  }

  if (route === 'stats' && method === 'GET') {
    const stats = readStats(home)
    const customCats = readCustomCategories(stats)
    const defs = {
      ...CATEGORY_DEFS,
      ...Object.fromEntries(Object.entries(customCats).map(([id, def]) => [id, { ...def, custom: true }])),
    }
    sendJson(response, 200, { ok: true, stats, categories: defs })
    return
  }

  if (route === 'prefs' && method === 'GET') {
    // Always fully populated (defaults filled in), so the client never has to
    // guess a default of its own.
    sendJson(response, 200, { ok: true, prefs: readPrefs(readStats(home)) })
    return
  }

  if (route === 'cover' && method === 'GET') {
    const name = url.searchParams.get('skill')
    if (!name) {
      sendError(response, 400, 'missing skill name')
      return
    }
    const skills = (await scanInstalled(home, process.cwd())).skills
    const skill = skills.find((s) => s.name === name)
    if (!skill) {
      sendError(response, 404, `skill not found: ${name}`)
      return
    }
    const cover = await readCover(skill.rootDir, skill.skillFile)
    if (!cover) {
      sendError(response, 404, 'no cover image')
      return
    }
    sendFile(response, 200, cover.mime, cover.buffer)
    return
  }

  if (route === 'active-session' && method === 'GET') {
    const id = tracker.current()
    sendJson(response, 200, { ok: true, sessionId: id ?? null })
    return
  }

  if (route === 'applied' && method === 'GET') {
    // Skills currently introduced into a session, newest last. `sessionId` must
    // be passed by the caller when it knows which window it is rendering —
    // otherwise the answer is whichever session happens to be most active, which
    // is shared across windows and therefore not what this window is showing.
    const explicit = url.searchParams.get('sessionId')
    const id = explicit || tracker.current()
    const byName = id !== undefined ? introduced.get(id) : undefined
    sendJson(response, 200, { ok: true, sessionId: id ?? null, skills: byName ? [...byName.keys()] : [] })
    return
  }

  if (route === 'image' && method === 'GET') {
    const id = url.searchParams.get('id')
    if (!id || !/^[a-f0-9]{24}\.(png|jpe?g|webp|gif|svg)$/.test(id)) {
      sendError(response, 400, 'bad image id')
      return
    }
    const p = imagePath(home, id)
    if (!existsSync(p)) {
      sendError(response, 404, 'image not found')
      return
    }
    const ext = extname(id).toLowerCase()
    const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.webp' ? 'image/webp' : ext === '.jpg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : 'image/png'
    const buf = readFileSync(p)
    sendFile(response, 200, mime, buf)
    return
  }

  // ---- POST routes (method enforcement) ----
  // Only routes explicitly meant for POST may pass; a GET on a POST-only route
  // (or a non-POST method) is rejected. Note `stats`/`categories` may also be
  // absent from GET_ROUTES, so gate on POST_ROUTES, not on the absence of GET.
  if (!POST_ROUTES.includes(route) || method !== 'POST') {
    sendError(response, 405, `method ${method} is not allowed on ${route}`)
    return
  }

  // Image upload carries a raw body (not JSON), so handle it before readJsonBody.
  if (route === 'image') {
    const contentType = String(request.headers['content-type'] || '')
    const mime = contentType.split(';')[0].trim().toLowerCase()
    if (!(mime in IMAGE_MIME)) {
      sendError(response, 415, 'unsupported image type')
      return
    }
    const buffer = await readRawBody(request)
    if (buffer.length === 0) {
      sendError(response, 400, 'empty image')
      return
    }
    const url = saveImage(home, buffer, mime)
    sendJson(response, 200, { ok: true, url })
    return
  }

  const body = await readJsonBody(request)

  if (route === 'cards') {
    // body: { name, image?, title?, description?, i18n? }  (image empty string clears;
    // i18n null clears the Chinese overlay, { zh, zhDesc? } sets it)
    const { name, image, title, description, i18n } = body
    if (typeof name !== 'string' || !name) {
      sendError(response, 400, 'missing skill name')
      return
    }
    // No base64 persistence: an image must be a served URL or a remote http(s)
    // link. Rejecting a pasted data: URI keeps skill-cards.json small.
    if (typeof image === 'string' && /^data:image\//i.test(image)) {
      sendError(response, 400, 'data:image is not supported; use a URL or local upload')
      return
    }
    if (i18n !== undefined && i18n !== null && (typeof i18n !== 'object' || typeof i18n.zh !== 'string' || !i18n.zh.trim())) {
      sendError(response, 400, 'i18n must be null or { zh, zhDesc? }')
      return
    }
    const config = readCardConfig(home)
    if (image === '' && title === undefined && description === undefined && i18n === undefined) {
      delete config[name]
    } else {
      const prev = config[name] || {}
      config[name] = {
        image: image === undefined ? (prev.image ?? null) : (image || null),
        title: title === undefined ? (prev.title ?? null) : (title || null),
        description: description === undefined ? (prev.description ?? null) : (description || null),
        // i18n: undefined keeps what is stored; null clears it; { zh,… } overwrites.
        i18n: i18n === undefined ? (prev.i18n ?? null) : (i18n ? { zh: i18n.zh.trim(), zhDesc: i18n.zhDesc ? String(i18n.zhDesc).trim() : null } : null),
      }
    }
    writeCardConfig(home, config)
    sendJson(response, 200, { ok: true, cards: config })
    return
  }

  if (route === 'i18n') {
    // body: { items: [{ name, zh, zhDesc? }] }  — batch Chinese-localisation
    // write produced by the in-panel prompt builder (or called directly by an
    // agent in the conversation). `name` must round-trip an installed skill;
    // unknown names are skipped so a stale client list cannot pollute config.
    const items = Array.isArray(body.items) ? body.items : []
    if (items.length === 0) {
      sendError(response, 400, 'items is empty')
      return
    }
    const skills = (await scanInstalled(home, process.cwd())).skills
    const known = new Set(skills.map((s) => s.name))
    const config = readCardConfig(home)
    let applied = 0
    const skipped = []
    for (const it of items) {
      if (!it || typeof it.name !== 'string' || !it.name) continue
      if (typeof it.zh !== 'string' || !it.zh.trim()) { skipped.push(it.name); continue }
      if (!known.has(it.name)) { skipped.push(it.name); continue }
      const prev = config[it.name] || {}
      config[it.name] = {
        image: prev.image ?? null,
        title: prev.title ?? null,
        description: prev.description ?? null,
        i18n: {
          zh: it.zh.trim(),
          zhDesc: typeof it.zhDesc === 'string' && it.zhDesc.trim() ? it.zhDesc.trim() : null,
        },
      }
      applied++
    }
    writeCardConfig(home, config)
    sendJson(response, 200, { ok: true, applied, skipped })
    return
  }

  if (route === 'stats') {
    // body: { name, category?, starred? }  — partial update to one skill's stats
    const { name } = body
    if (typeof name !== 'string' || !name) {
      sendError(response, 400, 'missing skill name')
      return
    }
    const stats = readStats(home)
    const prev = stats[name] || {}
    const next = { ...prev }
    if (body.category === undefined && body.starred === undefined) {
      sendError(response, 400, 'nothing to update (provide category or starred)')
      return
    }
    if (body.category !== undefined) {
      const customCats = readCustomCategories(stats)
      const known = body.category in CATEGORY_DEFS || body.category in customCats
      if (body.category === null || body.category === '' || body.category === false) {
        // clearing the override → will fall back to the auto-suggestion
        delete next.category
      } else if (typeof body.category === 'string' && known) {
        next.category = body.category
      } else {
        sendError(response, 400, `unknown category: ${body.category}`)
        return
      }
    }
    if (body.starred !== undefined) {
      next.starred = !!body.starred
    }
    const updated = { ...stats, [name]: next }
    writeStats(home, updated)
    sendJson(response, 200, { ok: true, stats: updated })
    return
  }

  if (route === 'prefs') {
    // body: { layout?: 'fan'|'wall' } — partial update to the user's UI prefs
    const patch = {}
    if (body.layout !== undefined) {
      if (!PREF_VALUES.layout.includes(body.layout)) {
        sendError(response, 400, `unknown layout: ${body.layout}`)
        return
      }
      patch.layout = body.layout
    }
    if (Object.keys(patch).length === 0) {
      sendError(response, 400, 'nothing to update (provide layout)')
      return
    }
    // `writePrefs` whitelists again on its own and always returns the full,
    // authoritative set — the response can never disagree with the file.
    sendJson(response, 200, { ok: true, prefs: writePrefs(home, patch) })
    return
  }

  if (route === 'categories') {
    // body: { action: "add"|"rename"|"remove", label?, id? }
    const { action } = body
    if (action === 'add') {
      const id = addCustomCategory(home, body.label)
      if (id === null) {
        sendError(response, 400, `invalid or empty category label: ${body.label}`)
        return
      }
      sendJson(response, 200, { ok: true, id })
      return
    }
    if (action === 'rename') {
      const ok = typeof body.id === 'string' && renameCustomCategory(home, body.id, body.label)
      if (!ok) {
        sendError(response, 400, `cannot rename category: ${body.id}`)
        return
      }
      sendJson(response, 200, { ok: true })
      return
    }
    if (action === 'remove') {
      const ok = typeof body.id === 'string' && removeCustomCategory(home, body.id)
      if (!ok) {
        sendError(response, 400, `cannot remove category: ${body.id}`)
        return
      }
      sendJson(response, 200, { ok: true })
      return
    }
    sendError(response, 400, `unknown action: ${action}`)
    return
  }

  if (route === 'introduce') {
    // body: { sessionId?, names: string[] }
    const names = Array.isArray(body.names) ? body.names : []
    if (names.length === 0) {
      sendError(response, 400, 'names is empty')
      return
    }
    const sessionId = body.sessionId && typeof body.sessionId === 'string' ? body.sessionId : tracker.current()
    if (sessionId === undefined) {
      sendError(response, 409, 'no active session available')
      return
    }
    const agent = service(ctx, 'agents')?.get?.(sessionId)
    if (agent === undefined) {
      sendError(response, 404, `session "${sessionId}" is not a live agent`)
      return
    }
    const skills = (await scanInstalled(home, process.cwd())).skills
    const byName = new Map(skills.map((s) => [s.name, s]))
    const results = []
    for (const n of names) {
      const skill = byName.get(n)
      if (!skill) {
        results.push({ name: n, ok: false, reason: 'skill not found locally' })
        continue
      }
      try {
        const r = await introduceIntoSession(ctx, agent, skill)
        if (r.ok) {
          rememberIntroduced(sessionId, r.name, r.dispose)
          results.push({ name: r.name, ok: true })
          log.info(`introduced "${r.name}" into session ${sessionId}`)
          bumpUse(home, skill.name)
        } else {
          results.push({ name: n, ok: false, reason: r.reason })
        }
      } catch (e) {
        results.push({ name: n, ok: false, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    sendJson(response, 200, { ok: true, sessionId, results })
    return
  }

  if (route === 'revoke') {
    // body: { sessionId?, names: string[] }  — remove applied skills from a session
    const names = Array.isArray(body.names) ? body.names : []
    if (names.length === 0) {
      sendError(response, 400, 'names is empty')
      return
    }
    const sessionId = body.sessionId && typeof body.sessionId === 'string' ? body.sessionId : tracker.current()
    if (sessionId === undefined) {
      sendError(response, 409, 'no active session available')
      return
    }
    const results = names.map((n) => ({ name: n, ok: revokeIntroduced(sessionId, n) }))
    const removed = results.filter((r) => r.ok).map((r) => r.name)
    if (removed.length > 0) log.info(`revoked [${removed.join(', ')}] from session ${sessionId}`)
    sendJson(response, 200, { ok: true, sessionId, results })
    return
  }
}
