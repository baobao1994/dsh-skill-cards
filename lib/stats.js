/**
 * Behavioural stats for skills: user-assigned category, "starred" (常用) and a
 * use counter. This is deliberately a SEPARATE file from skill-cards.json (the
 * custom cover/title/description config): stats change on every apply, so they
 * should live separately from the largely-stable display config, both so writes
 * don't churn the config file and so a corrupted stats file can't hide the user's
 * custom covers. Optional decorators like an SVG or a little "常用" badge can
 * read this alongside the config.
 *
 * The persisted shape is a map keyed by skill name:
 *   { "<skillName>": { category?, starred?, uses? } }
 *
 * @module dsh-skill-cards/stats
 */

import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** File name for the stats store (kept separate from skill-cards.json). */
export const STATS_FILE_NAME = 'skill-cards-stats.json'

/**
 * Reserved stats key holding user-created categories, so a skill name can never
 * collide with it. Shape: { "<id>": { label } }. These are distinct from the
 * built-in `CATEGORY_DEFS` (which are auto-grouped and NOT user-editable).
 */
export const CUSTOM_CATEGORY_KEY = '_customCategories'

/**
 * Reserved stats key holding user-interface preferences, so they can never be
 * mistaken for a skill name. Shape: { layout?: 'fan' | 'wall' }.
 *
 * Kept in the SAME file as `_customCategories` rather than a new prefs file:
 * these are behavioral user state (like the star/use counters) and live
 * alongside the other reserved keys, so a user's existing backup/restore path
 * (`local-config-backup/`) picks them up with no extra plumbing.
 */
export const PREFS_KEY = '_prefs'

/** Allowed values per preference key. The single source of truth for both the
 *  store's sanitizer and the HTTP route's validation. */
export const PREF_VALUES = {
  /** 'fan' = 扇形卡牌浏览（默认），'wall' = 网格卡墙 */
  layout: ['fan', 'wall'],
}

/** Defaults, used when the store is empty or holds an unsupported value. */
export const PREF_DEFAULTS = { layout: 'fan' }

/** `id` must be lowercase-latin for the client to derive a CSS class safely. */
export const CATEGORY_DEFS = {
  dev:      { label: '开发',     en: 'Dev',        hint: 'git/lint/refactor/code' },
  test:     { label: '测试',     en: 'Testing',    hint: 'testing/qa/regression' },
  design:   { label: '设计',     en: 'Design',     hint: 'design/ui/ux/canvas/theme' },
  write:    { label: '写作 · 文档', en: 'Writing', hint: 'writing/coauthor/editorial' },
  doc:      { label: '办公文档',  en: 'Office Docs', hint: 'docx/pptx/pdf/xlsx' },
  ai:       { label: 'AI · 智能体', en: 'AI',      hint: 'claude/llm/mcp/agent' },
  workflow: { label: '流程 · 工程', en: 'Workflow', hint: 'planning/shipping/ci/incremental' },
  research: { label: '研究 · 分析', en: 'Research', hint: 'research/audit/observability' },
  skills:   { label: '技能 · 管理', en: 'Skills',   hint: 'skill-creator/skill-*' },
  security: { label: '安全',     en: 'Security',   hint: 'security/harden/guardrail' },
  data:     { label: '数据',     en: 'Data',       hint: 'xlsx/pdf/obsidian' },
  other:    { label: '其它',     en: 'Other',      hint: 'everything else' },
}

/**
 * Ordered keyword rules for auto-grouping skills by name/description. More
 * specific patterns come first so a name matching several keywords lands on the
 * most meaningful group (e.g. "frontend-design" should be 设计, not 开发).
 */
const SUGGEST_BY_KEYWORD = [
  // ── skills · 管理 (most specific first)
  [/^skill-creator$|skill-updater|baidu-skill-index|skill-creator/, 'skills'],
  // ── ai · 智能体
  [/claude|llm|mcp|anthropic|to-questionnaire|to-ticket|to-spec\b|to-question/, 'ai'],
  // ── 办公文档 (word-boundary docx/pptx/xlsx/pdf)
  [/\bdocx\b|\bpptx\b|\bxlsx\b|\bpdf\b|\bword\b|\bexcel\b|\bppt\b|office/, 'doc'],
  // ── 测试
  [/test|qa\b|regression|eval|verif/, 'test'],
  // ── 安全
  [/security|harden|guardrail|vulnerab/, 'security'],
  // ── 设计 (frontend-design / ui / ux / canvas / theme / art / brand)
  [/frontend-design|\bui\b|\bux\b|canvas|theme|design|art|brand|impeccable|frontend-standardization/, 'design'],
  // ── 写作 · 文档
  [/writing|coauthor|editorial|article|\bcopy\b|documentation\b|internal-comms|comms/, 'write'],
  // ── 设计 · 媒体 (incl. gif/animation creators)
  [/slack-gif|gif-creator|video|animation|media|illustrat/, 'design'],
  // ── 研究 · 分析
  [/research|audit|observability|analytics|analyse|diagnos|report|session-report|context-engineering/, 'research'],
  // ── 流程 · 工程
  [/planning|roadmap|shipping|launch|\bci\b|incremental|scaffold|workflow|migrat|refactor|release|prd-sync|handoff/, 'workflow'],
  // ── 开发 (git/lint/code/debug/ts/standardization/build)
  [/git|versioning|lint|regex|\bts\b|typescript|code-review|code-simplif|debug|deep-module|js-fn|build|standardization|engineering|tdd|implement|performance|source-driven|spec-driven|improv|architectur|merge-conflict|merge-conflic|pre-commit|domain-model|conflict|commit|doubt-driven|ubiquitous/, 'dev'],
  // ── 数据
  [/obsidian|xlsx|spreadsheet|csv|dataset|\bdata\b/, 'data'],
  // ── fallback descriptors shared across meta-skills
  [/skill|meta|guide|prototype/, 'skills'],
]

const LOWER_LIST = [
  'ask-matt', 'batch-grill-me', 'grill-me', 'grilling', 'grill-with-docs', 'loop-me',
  'clarify', 'craft', 'idea-refine', 'interview-me', 'teach', 'wizard', 'wayfinder',
  'live', 'best-practices', 'q', 'triage',
].map((s) => s.toLowerCase())

/**
 * Suggest a default category id for a skill name (or its description).
 * Falls back to 'other'. Deterministic and dependency-free.
 */
export function suggestCategory(name, description = '') {
  const haystack = `${name} ${description}`.toLowerCase()
  for (const [re, id] of SUGGEST_BY_KEYWORD) {
    if (re.test(haystack)) return id
  }
  // A name in the curated "process / prompt-craft" list is grouped under
  // workflow so it doesn't silently vanish into "其它".
  if (LOWER_LIST.includes(String(name).toLowerCase())) return 'workflow'
  return 'other'
}

/**
 * Resolve the effective category for a skill: user override if present,
 * otherwise the auto-suggestion. The override may be 'other' (explicitly
 * ungrouped) or any category id; an unknown id also falls back to 'other'.
 */
export function categoriesFor({ name, description = '', stats = null, defs = CATEGORY_DEFS } = {}) {
  const override = stats && typeof stats.category === 'string' ? stats.category : null
  if (override && override in defs) return override
  return suggestCategory(name ?? '', description ?? '')
}

/** Absolute path to the stats store for a given DSH home. */
export function statsFilePath(home) {
  return join(home || homedir(), STATS_FILE_NAME)
}

/** Read the stats store; tolerates a missing/corrupt file (returns {}). */
export function readStats(home) {
  const p = statsFilePath(home)
  if (!existsSync(p)) return {}
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

/** Write the stats store, creating parent dirs. */
export function writeStats(home, stats) {
  const p = statsFilePath(home)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(stats, null, 2), 'utf8')
}

/**
 * Read UI preferences from the stats store, always fully populated (defaults
 * filled in). Unknown keys are dropped and unsupported values fall back to the
 * default, so a newer version's prefs can never make an older read throw and a
 * hand-edited file cannot inject an unknown layout.
 */
export function readPrefs(stats = {}) {
  const store = stats || {}
  const raw = store[PREFS_KEY]
  const out = { ...PREF_DEFAULTS }
  if (!raw || typeof raw !== 'object') return out
  for (const [key, allowed] of Object.entries(PREF_VALUES)) {
    const value = raw[key]
    if (typeof value === 'string' && allowed.includes(value)) out[key] = value
  }
  return out
}

/**
 * Merge a preference patch into the stats store and return the persisted result.
 * Keys outside `PREF_VALUES` are ignored (forward compatible: a client that
 * knows a newer key cannot corrupt the ones this version understands). Always
 * returns the authoritative full set, so the caller can adopt it verbatim.
 */
export function writePrefs(home, patch = {}) {
  const stats = readStats(home)
  const next = { ...readPrefs(stats) }
  for (const [key, allowed] of Object.entries(PREF_VALUES)) {
    const value = patch?.[key]
    if (typeof value === 'string' && allowed.includes(value)) next[key] = value
  }
  writeStats(home, { ...stats, [PREFS_KEY]: next })
  return next
}

/**
 * Read the user's custom category definitions from the stats store.
 * Returns { "<id>": { label } } (empty object when none). The store reserves
 * `CUSTOM_CATEGORY_KEY` for this, so it is never mistaken for a skill.
 */
export function readCustomCategories(stats = {}) {
  const store = stats || {}
  const raw = store[CUSTOM_CATEGORY_KEY]
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [id, def] of Object.entries(raw)) {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(id)) continue
    const label = typeof def?.label === 'string' ? def.label.trim() : ''
    if (label) out[id] = { label }
  }
  return out
}

/** Persist custom category definitions back into the stats store. */
function persistCustomCategories(home, categories) {
  const stats = readStats(home)
  const next = { ...stats, [CUSTOM_CATEGORY_KEY]: categories }
  writeStats(home, next)
  return categories
}

/**
 * Add a custom category. Returns the new id (slug) or null when the label is
 * invalid/empty. Auto-suggests a unique slug even when the label is CJK or
 * collides with a built-in id.
 */
export function addCustomCategory(home, label) {
  const text = typeof label === 'string' ? label.trim() : ''
  if (!text) return null
  const base = slugify(text)
  if (!base || base === CUSTOM_CATEGORY_KEY) return null
  const defs = readCustomCategories(readStats(home))
  let id = base
  let n = 2
  while (id in CATEGORY_DEFS || id in defs || id === CUSTOM_CATEGORY_KEY) { id = `${base}-${n++}` }
  persistCustomCategories(home, { ...defs, [id]: { label: text } })
  return id
}

/** Remove a custom category id (no-op if it is a built-in or absent). */
export function removeCustomCategory(home, id) {
  const defs = readCustomCategories(readStats(home))
  if (!(id in defs)) return false
  delete defs[id]
  // Also drop any skill that pointed at it so they fall back to a suggestion.
  const stats = readStats(home)
  for (const [name, s] of Object.entries(stats)) {
    if (s && s.category === id) { delete s.category }
  }
  const next = { ...stats, [CUSTOM_CATEGORY_KEY]: defs }
  writeStats(home, next)
  return true
}

/** Rename a custom category's label. Returns true on success. */
export function renameCustomCategory(home, id, label) {
  const text = typeof label === 'string' ? label.trim() : ''
  if (!text || id in CATEGORY_DEFS) return false
  const defs = readCustomCategories(readStats(home))
  if (!(id in defs)) return false
  persistCustomCategories(home, { ...defs, [id]: { label: text } })
  return true
}

function slugify(text) {
  // Prefer a latin/alnum slug; CJK/emoji labels get a deterministic latin-ish id.
  const latin = text.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (latin) return latin.slice(0, 24)
  let out = ''
  for (const ch of text) {
    out += 'x' + ch.codePointAt(0).toString(36)
  }
  return (out || 'cat').slice(0, 24)
}

/**
 * Record a use of `name` and return the whole store (primed with defaults so
 * the caller can decide). Increments uses, keeps starred/category. Fails open
 * (never throws) so a stats hiccup can't block a skill application.
 */
export function bumpUse(home, name, stats = readStats(home)) {
  const s = stats[name] || {}
  // Increment only for clean, known names to avoid polluting the store.
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) return stats
  const next = {
    ...s,
    uses: (typeof s.uses === 'number' ? s.uses : 0) + 1,
  }
  const out = { ...stats, [name]: next }
  try { writeStats(home, out) } catch { /* ignore */ }
  return out
}