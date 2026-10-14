/**
 * Tests for user UI preferences: the `_prefs` reserved key in the stats store
 * and the `/prefs` route that reads/writes it.
 *
 * These are deliberately behavioural: the route test boots the real plugin with
 * a stubbed `webServer`, then drives the registered handler with fake
 * request/response objects, so a change to the whitelist, the merge semantics
 * or the default resolution fails here instead of silently shipping.
 *
 * Run: node --test test/prefs.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  PREFS_KEY, PREF_DEFAULTS, PREF_VALUES, readPrefs, writePrefs, readStats, writeStats, statsFilePath,
} from '../lib/stats.js'
import { apply } from '../lib/index.js'

const tempHome = () => mkdtempSync(join(tmpdir(), 'sc-prefs-'))

// ── store layer ─────────────────────────────────────────────────────────────

test('readPrefs always answers a complete set, falling back to defaults', () => {
  assert.deepEqual(readPrefs({}), PREF_DEFAULTS)
  assert.deepEqual(readPrefs({ [PREFS_KEY]: null }), PREF_DEFAULTS)
  assert.deepEqual(readPrefs({ [PREFS_KEY]: 'wall' }), PREF_DEFAULTS, 'a non-object prefs value must not throw')
  assert.deepEqual(readPrefs({ [PREFS_KEY]: { layout: 'morph' } }), PREF_DEFAULTS, 'an unsupported value falls back')
  assert.deepEqual(readPrefs({ [PREFS_KEY]: { layout: 'wall' } }), { layout: 'wall' })
  assert.deepEqual(
    readPrefs({ [PREFS_KEY]: { layout: 'wall', future: 'x' } }),
    { layout: 'wall' },
    'unknown keys are dropped (a newer client cannot inject them)',
  )
})

test('writePrefs merges, whitelists, and leaves the skill stats alone', () => {
  const dir = tempHome()
  try {
    writeStats(dir, { someSkill: { uses: 2, starred: true }, [PREFS_KEY]: { layout: 'wall' } })
    assert.deepEqual(writePrefs(dir, { layout: 'fan' }), { layout: 'fan' }, 'returns the authoritative full set')
    const stats = readStats(dir)
    assert.equal(stats[PREFS_KEY].layout, 'fan')
    assert.deepEqual(stats.someSkill, { uses: 2, starred: true }, 'per-skill stats must survive a prefs write')
    // An unsupported value keeps the stored one instead of clobbering it.
    assert.deepEqual(writePrefs(dir, { layout: 'morph', future: 'x' }), { layout: 'fan' })
    assert.deepEqual(readStats(dir)[PREFS_KEY], { layout: 'fan' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writePrefs creates the store when there is none yet', () => {
  const dir = tempHome()
  try {
    assert.deepEqual(writePrefs(dir, { layout: 'wall' }), { layout: 'wall' })
    assert.deepEqual(JSON.parse(readFileSync(statsFilePath(dir), 'utf8')), { [PREFS_KEY]: { layout: 'wall' } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── route layer (real dispatch, stubbed host) ───────────────────────────────

/** Boot the plugin against a temp DSH home and return its registered handler. */
function bootHost(home) {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let spec
  const ctx = {
    logger: undefined,
    get: () => undefined,
    effect: (fn) => fn(),
    // Mirror the host contract: inject() hands back a child scope that owns the
    // webServer service AND its own effect() registration.
    inject: (names, cb) => cb({
      effect: (fn) => fn(),
      webServer: { register: (registered) => { spec = registered; return () => {} } },
    }),
  }
  try {
    apply(ctx)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
  assert.ok(spec && typeof spec.handler === 'function', 'the plugin must register a prefix handler')
  assert.equal(spec.path, '/plugins/dsh-skill-cards')
  return spec.handler
}

/** Drive the handler with a fake request/response pair (loopback host = same origin). */
async function call(handler, { method = 'GET', route = '', body } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const request = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : [])
  request.url = `/plugins/dsh-skill-cards/${route}`
  request.method = method
  request.headers = { host: '127.0.0.1:19387', 'content-type': 'application/json' }
  const response = {
    statusCode: 0, headersSent: false, body: '',
    writeHead(status) { this.statusCode = status; this.headersSent = true; return this },
    end(chunk) { if (chunk) this.body += chunk },
  }
  await handler(request, response)
  return { status: response.statusCode, json: response.body ? JSON.parse(response.body) : null }
}

test('GET /prefs serves the default, then whatever was persisted', async () => {
  const dir = tempHome()
  try {
    const handler = bootHost(dir)
    let res = await call(handler, { route: 'prefs' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { ok: true, prefs: { layout: 'fan' } }, 'a fresh install defaults to the fan')

    res = await call(handler, { method: 'POST', route: 'prefs', body: { layout: 'wall' } })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { ok: true, prefs: { layout: 'wall' } })

    res = await call(handler, { route: 'prefs' })
    assert.deepEqual(res.json.prefs, { layout: 'wall' }, 'the choice survives a re-read')
    // Same file as the skill stats, under the reserved key.
    assert.deepEqual(JSON.parse(readFileSync(statsFilePath(dir), 'utf8'))[PREFS_KEY], { layout: 'wall' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /prefs rejects unsupported values and empty patches without writing', async () => {
  const dir = tempHome()
  try {
    const handler = bootHost(dir)
    await call(handler, { method: 'POST', route: 'prefs', body: { layout: 'wall' } })

    let res = await call(handler, { method: 'POST', route: 'prefs', body: { layout: 'morph' } })
    assert.equal(res.status, 400)
    assert.match(res.json.error, /unknown layout/)

    res = await call(handler, { method: 'POST', route: 'prefs', body: { theme: 'dark' } })
    assert.equal(res.status, 400)
    assert.match(res.json.error, /nothing to update/)

    assert.equal(readStats(dir)[PREFS_KEY].layout, 'wall', 'a rejected write must not touch the store')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt stats file cannot take the prefs route down', async () => {
  const dir = tempHome()
  try {
    writeFileSync(statsFilePath(dir), '{ not json', 'utf8')
    const handler = bootHost(dir)
    let res = await call(handler, { route: 'prefs' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.prefs, { layout: 'fan' }, 'a corrupt store degrades to defaults')

    res = await call(handler, { method: 'POST', route: 'prefs', body: { layout: 'wall' } })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(readFileSync(statsFilePath(dir), 'utf8')), { [PREFS_KEY]: { layout: 'wall' } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── drift guards ────────────────────────────────────────────────────────────

test('the prefs route is registered in both method tables and validates via PREF_VALUES', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /GET_ROUTES = \[[^\]]*'prefs'[^\]]*\]/, "GET_ROUTES must list 'prefs'")
  assert.match(src, /POST_ROUTES = \[[^\]]*'prefs'[^\]]*\]/, "POST_ROUTES must list 'prefs'")
  assert.match(src, /PREF_VALUES\.layout\.includes\(body\.layout\)/, 'route validation must reuse the store whitelist')
})

test('the client default and storage key match the host default', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, new RegExp(`DEFAULT_LAYOUT = '${PREF_DEFAULTS.layout}'`), 'client default must match PREF_DEFAULTS.layout')
  assert.match(client, /LAYOUT_STORAGE_KEY = 'dsh-skill-cards\.layout'/, 'client needs a stable local mirror key')
  for (const value of PREF_VALUES.layout) {
    assert.ok(client.includes(`'${value}'`), `client must know the layout value "${value}"`)
  }
})
