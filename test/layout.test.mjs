/**
 * Tests for the layout switch («墙» 网格卡墙 / «扇形» fan) on the CLIENT side:
 * the layout preference plumbing (default / whitelist / localStorage mirror),
 * CardFan's `initialFocus` handoff, and the panel-level wiring that ties the two
 * layouts and the toolbar buttons together.
 *
 * Two habits from the rest of this suite are kept:
 *   - test/fan.test.mjs: the client is a classic script with no exports, so the
 *     REAL functions/component are sliced out of the source and run in a vm
 *     sandbox with hand-rolled React hooks — no browser, and no second
 *     implementation of the thing under test that could drift.
 *   - test/prefs.test.mjs: the client's vocabulary is asserted against the
 *     host's real constants (lib/stats.js), never against a hard-coded copy.
 *
 * The focus handoff is covered as a contract in both directions: CardFan reports
 * the card it centers on through `onFocusChange` (on mount and after every flip),
 * and the panel keeps that name in `focusRef` so switching to the wall can scroll
 * to — and flash — the very same card.
 *
 * Run: node --test test/layout.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { PREF_DEFAULTS, PREF_VALUES } from '../lib/stats.js'

const clientSrc = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

// ── 源码抽取工具 ────────────────────────────────────────────────────────────

/** 切出一个具名函数体（客户端没有模块导出，只能从源码里取真实实现）。 */
function functionSource(name) {
  const start = clientSrc.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} 必须存在`)
  const end = clientSrc.indexOf('\n    }', start)
  assert.notEqual(end, -1, `${name} 的函数体必须收在 4 空格缩进上`)
  return clientSrc.slice(start, end + '\n    }'.length)
}

/** 切出一行顶层 const（箭头函数式的工具用它）。 */
function constSource(name) {
  const match = clientSrc.match(new RegExp(`^\\s*const ${name} = .*$`, 'm'))
  assert.notEqual(match, null, `${name} 必须存在`)
  return match[0].trim()
}

/** 切出 startMarker…endMarker（含）之间的一段源码，用于面板层断言。 */
function sliceBetween(startMarker, endMarker) {
  const start = clientSrc.indexOf(startMarker)
  assert.notEqual(start, -1, `找不到: ${startMarker}`)
  const end = clientSrc.indexOf(endMarker, start)
  assert.notEqual(end, -1, `在 ${startMarker} 之后找不到: ${endMarker}`)
  return clientSrc.slice(start, end + endMarker.length)
}

/** 以 marker 为中心取一段源码，断言「这个属性挂在这个元素上」之类的就近关系。 */
function around(marker, before = 200, after = 200) {
  const index = clientSrc.indexOf(marker)
  assert.notEqual(index, -1, `找不到: ${marker}`)
  return clientSrc.slice(Math.max(0, index - before), index + after)
}

/** 去掉注释：注释里提到某个 API 不算「调用了它」。 */
const stripComments = (code) => code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

// ── 布局偏好工具：真实实现 + 假 localStorage ─────────────────────────────────

const LAYOUT_MODEL = [
  constSource('DEFAULT_LAYOUT'),
  constSource('LAYOUTS'),
  constSource('LAYOUT_STORAGE_KEY'),
  constSource('normalizeLayout'),
  functionSource('readCachedLayout'),
  functionSource('cacheLayout'),
].join('\n')

// 末尾的括号不能省：`{ a, b }` 会被当成块语句，脚本的完成值就不再是这个对象。
const LAYOUT_EXPORTS = '({ DEFAULT_LAYOUT, LAYOUTS, LAYOUT_STORAGE_KEY, normalizeLayout, readCachedLayout, cacheLayout })'

/**
 * 在沙箱里实例化一份真实的布局工具。
 * `window` 由调用方伪造 —— 实现里是 `window.localStorage?.getItem(...)`，
 * 所以沙箱必须提供 window，也只有这样才能测到「读/写抛异常」的分支。
 */
function layoutModule(window) {
  return runInNewContext(`${LAYOUT_MODEL}\n${LAYOUT_EXPORTS}`, { window })
}

/** 一个 Map 支撑的假 Storage（只实现实现用到的那两个方法）。 */
function fakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries))
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  }
}

const { DEFAULT_LAYOUT, LAYOUTS, LAYOUT_STORAGE_KEY, normalizeLayout } = layoutModule({})

test('normalizeLayout 只放行白名单值，其余一律落回默认布局', () => {
  assert.equal(normalizeLayout('fan'), 'fan')
  assert.equal(normalizeLayout('wall'), 'wall')
  assert.equal(DEFAULT_LAYOUT, 'fan', '默认布局是扇形')
  // 脏镜像 / 脏响应 / 未来版本写入的值 / 非字符串：一个都不许穿过去。
  const dirty = [
    undefined, null, '', 'morph', 'FAN', 'Wall', ' fan ', 0, 1, Number.NaN,
    true, false, {}, [], ['fan'], { layout: 'wall' }, new String('wall'), () => 'wall',
  ]
  for (const value of dirty) {
    assert.equal(normalizeLayout(value), 'fan', `${String(value)} 必须落回默认布局`)
  }
  // 返回值永远是自己的字符串，不是外来对象。
  assert.equal(typeof normalizeLayout(new String('fan')), 'string')
})

test('cacheLayout 写本地镜像，readCachedLayout 原样读回', () => {
  const mod = layoutModule({ localStorage: fakeStorage() })
  assert.equal(mod.readCachedLayout(), 'fan', '空镜像落回默认布局')
  mod.cacheLayout('wall')
  assert.equal(mod.readCachedLayout(), 'wall', '写过的镜像必须能读回来')
  assert.deepEqual([...mod.LAYOUT_STORAGE_KEY], [...LAYOUT_STORAGE_KEY], '读与写必须用同一个 key')
  mod.cacheLayout('fan')
  assert.equal(mod.readCachedLayout(), 'fan')
})

test('脏镜像被归一化，读镜像抛异常时落回默认值', () => {
  const mirror = fakeStorage({ [LAYOUT_STORAGE_KEY]: 'morph' })
  assert.equal(layoutModule({ localStorage: mirror }).readCachedLayout(), 'fan', '镜像里只认白名单值')

  const throwing = layoutModule({ localStorage: { getItem() { throw new Error('SecurityError') } } })
  assert.equal(throwing.readCachedLayout(), 'fan', '隐私模式/沙箱里读 localStorage 会抛，必须兜住')

  assert.equal(layoutModule({}).readCachedLayout(), 'fan', '连 window 都没有时也不能抛')
  assert.equal(layoutModule({ localStorage: undefined }).readCachedLayout(), 'fan', '没有 localStorage 时回落默认')
  assert.equal(layoutModule({ localStorage: {} }).readCachedLayout(), 'fan', '没有 getItem 的假实现也不能抛')
})

test('缓存写失败是静默的（首屏镜像存不下不影响功能）', () => {
  const throwing = layoutModule({ localStorage: { setItem() { throw new Error('QuotaExceededError') } } })
  assert.doesNotThrow(() => throwing.cacheLayout('wall'))

  assert.doesNotThrow(() => layoutModule({}).cacheLayout('wall'), '没有 window/localStorage 也要静默')
  assert.doesNotThrow(() => layoutModule({ localStorage: {} }).cacheLayout('wall'), '没有 setItem 也要静默')

  // cacheLayout 不替调用方做白名单（chooseLayout/normalizeLayout 负责），
  // 但脏值写下去后读回来仍会被归一化。
  const storage = fakeStorage()
  layoutModule({ localStorage: storage }).cacheLayout('morph')
  assert.equal(storage.map.get(LAYOUT_STORAGE_KEY), 'morph')
  assert.equal(layoutModule({ localStorage: storage }).readCachedLayout(), 'fan')
})

test('客户端布局默认值与白名单跟宿主 /prefs 保持一致（不硬编码）', () => {
  assert.equal(DEFAULT_LAYOUT, PREF_DEFAULTS.layout, '客户端默认布局必须等于宿主 PREF_DEFAULTS.layout')
  assert.deepEqual([...LAYOUTS], [...PREF_VALUES.layout], '客户端白名单必须与宿主 PREF_VALUES.layout 一致')
  assert.equal(normalizeLayout(PREF_DEFAULTS.layout), PREF_DEFAULTS.layout, '宿主默认值必须是合法布局')
  assert.equal(LAYOUT_STORAGE_KEY, 'dsh-skill-cards.layout', '首屏镜像要有个稳定的 key')
  for (const value of PREF_VALUES.layout) {
    assert.ok(clientSrc.includes(`'${value}'`), `客户端必须认识布局值 "${value}"`)
  }
})

// ── CardFan：initialFocus 交接 ──────────────────────────────────────────────

const FAN_MODEL = [
  constSource('FAN_DRAG_START'),
  constSource('FAN_CLICK_SLOP'),
  constSource('FAN_DRAG_MAX'),
  functionSource('clampDragUnits'),
  functionSource('fanMetrics'),
  functionSource('fanPose'),
].join('\n')

function descendants(node) {
  if (!node || typeof node !== 'object') return []
  return [node, ...(node.children || []).flatMap(descendants)]
}

function byClass(tree, name) {
  return descendants(tree).filter((node) => node.props?.className?.split(' ').includes(name))
}

/**
 * 渲染真实的 CardFan —— 与 test/fan.test.mjs 的 mountFan 同法（手工 hook
 * 运行器，保留 state / effect / ref 的跨动作连续性）。这里的用例只关心焦点，
 * 所以卡片仍是空壳（Card 桩），不重造宿主应用。
 */
function mountFan(list, { width = 1000, height = 900, initialFocus = null, onFocusChange } = {}) {
  const hooks = []
  const effects = []
  const timers = new Map()
  const events = new Map()
  let cursor = 0
  let timerId = 0
  let dirty = false
  let tree
  let props
  const Card = function Card() {}
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const scope = {
    Card,
    e: (type, nodeProps, ...children) => ({
      type,
      props: nodeProps || {},
      children: children.flat(Infinity).filter((item) => item != null && item !== false),
    }),
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], (next) => {
        const value = typeof next === 'function' ? next(hooks[index]) : next
        if (!Object.is(value, hooks[index])) { hooks[index] = value; dirty = true }
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    useCallback(fn, deps) {
      const index = cursor++
      if (!sameDeps(hooks[index]?.deps, deps)) hooks[index] = { fn, deps }
      return hooks[index].fn
    },
    useEffect(fn, deps) {
      const index = cursor++
      if (sameDeps(hooks[index]?.deps, deps)) return
      effects.push(() => {
        hooks[index]?.cleanup?.()
        hooks[index] = { deps, cleanup: fn() }
      })
    },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id },
    clearTimeout(id) { timers.delete(id) },
    window: {
      innerHeight: height,
      addEventListener(type, fn) { events.set(type, fn) },
      removeEventListener(type) { events.delete(type) },
    },
  }
  const CardFan = runInNewContext(`${FAN_MODEL}\n${functionSource('CardFan')}\nCardFan`, scope)
  props = {
    skills: list, selected: new Set(), t: (key) => key, catDefs: {},
    initialFocus, onFocusChange,
    onToggle() {}, onStar() {}, onSetImage() {},
  }
  function render(next = {}) {
    props = { ...props, ...next }
    for (let attempt = 0; attempt < 12; attempt++) {
      dirty = false
      cursor = 0
      tree = CardFan(props)
      for (const node of descendants(tree)) {
        if (node.props.ref && !node.props.ref.current) {
          node.props.ref.current = {
            get clientWidth() { return width },
            getBoundingClientRect: () => ({ left: 0, top: 0, width, height: 1 }),
          }
        }
      }
      while (effects.length) effects.shift()()
      if (!dirty) return tree
    }
    throw new Error('CardFan 的 effect 没有收敛')
  }
  render()
  return {
    get tree() { return tree },
    get slots() { return byClass(tree, 'dsh-sc-fan-slot') },
    get current() { return byClass(tree, 'is-current')[0]?.children[0].props.skill.name },
    get nav() { return byClass(tree, 'dsh-sc-fan-nav')[0]?.children.filter((node) => node.type === 'button') },
    render,
    step(delta) { this.nav[delta < 0 ? 0 : 1].props.onClick(); return render() },
    clickCard(name) {
      const card = this.slots.map((slot) => slot.children[0]).find((node) => node.props.skill.name === name)
      assert.ok(card, `${name} 必须已挂载才能点它`)
      card.props.onToggle(name)
      return render()
    },
  }
}

const skills = (count) => Array.from({ length: count }, (_, index) => ({ name: `skill-${index}`, description: `description ${index}` }))

test('CardFan 命中 initialFocus 时以它居中，两个方向都还能走', () => {
  const list = skills(5)
  const first = mountFan(list, { initialFocus: 'skill-0' })
  assert.equal(first.current, 'skill-0')
  assert.deepEqual(first.nav.map((button) => button.props.disabled), [true, false], '已经在头一张：往回不可走')

  const last = mountFan(list, { initialFocus: 'skill-4' })
  assert.equal(last.current, 'skill-4')
  assert.deepEqual(last.nav.map((button) => button.props.disabled), [false, true])

  // 大库也一样：接住那张，而不是又落回正中。
  const middle = mountFan(skills(95), { initialFocus: 'skill-70' })
  assert.equal(middle.current, 'skill-70')
  assert.deepEqual(middle.nav.map((button) => button.props.disabled), [false, false])

  // 承接下来后仍能正常翻牌。
  middle.step(1)
  assert.equal(middle.current, 'skill-71')
})

test('initialFocus 不在结果里（或为 null）时回落到列表正中', () => {
  // 正中 = (length - 1) >> 1 —— 与 CardFan 的原生开局行为一致。
  for (const [count, middle] of [[1, 0], [2, 0], [3, 1], [4, 1], [5, 2], [95, 47]]) {
    const list = skills(count)
    for (const focus of [null, undefined, '', 'skill-999', 'nope']) {
      assert.equal(mountFan(list, { initialFocus: focus }).current, list[middle].name,
        `${count} 张卡、initialFocus=${JSON.stringify(focus)} 应回落正中`)
    }
    assert.equal(mountFan(list).current, list[middle].name, '不传 initialFocus 也是正中')
  }
  // 过滤/搜索后交接的那张不在结果里：必须回落，不能渲染出没有当前卡的扇形。
  const filtered = skills(5).filter((skill) => skill.name !== 'skill-2')
  const fan = mountFan(filtered, { initialFocus: 'skill-2' })
  assert.equal(fan.current, 'skill-1', '被过滤掉的交接对象回落到剩余结果的正中')
  assert.ok(fan.slots.length > 0, '回落之后仍要渲染出扇形，不能变成空舞台')
})

test('CardFan 挂载与每次翻牌后都把当前卡名回报给 onFocusChange', () => {
  // 挂载：回报初始居中那张（initialFocus 命中时就是它，否则是列表正中）。
  const reported = []
  const fan = mountFan(skills(5), { onFocusChange: (name) => reported.push(name) })
  assert.deepEqual(reported, ['skill-2'], '挂载后必须回报一次当前卡名')

  // 翻牌：下一张、再上一张，每次都回报新的当前卡。
  fan.step(1)
  assert.deepEqual(reported, ['skill-2', 'skill-3'])
  fan.step(-1)
  assert.deepEqual(reported, ['skill-2', 'skill-3', 'skill-2'])

  // 点侧牌（browse）也是翻牌，同样要回报。
  fan.clickCard('skill-4')
  assert.deepEqual(reported, ['skill-2', 'skill-3', 'skill-2', 'skill-4'])

  // 与当前卡无关的重渲染不重复回报（deps 只认卡名与回调本身）。
  fan.render()
  assert.deepEqual(reported, ['skill-2', 'skill-3', 'skill-2', 'skill-4'])

  // 从墙接过来的那张必须回报出去，否则切回墙时会定错位。
  const handed = []
  mountFan(skills(5), { initialFocus: 'skill-4', onFocusChange: (name) => handed.push(name) })
  assert.deepEqual(handed, ['skill-4'])

  // 没有任何结果时回报 null（面板据此知道「没有当前卡」），而不是漏报或抛错。
  const empty = []
  mountFan([], { onFocusChange: (name) => empty.push(name) })
  assert.deepEqual(empty, [null])

  // onFocusChange 是可选参数：不传不能抛（旧的调用点、独立渲染都不会传）。
  assert.doesNotThrow(() => mountFan(skills(3)))
})

// ── 面板层：根节点 / 工具栏 / 持久化 / 切墙定位 ──────────────────────────────

test('面板根节点声明 data-layout，舞台按 layout 分支渲染两种布局', () => {
  assert.match(clientSrc, /'data-layout': layout/, '当前布局必须挂到 DOM 上（CSS 的高度档位读它）')
  assert.match(around("'data-layout': layout"), /`dsh-sc-panel/, 'data-layout 必须挂在 .dsh-sc-panel 根节点上')

  const stage = clientSrc.slice(clientSrc.indexOf("className: 'dsh-sc-stage'"), clientSrc.indexOf("className: 'dsh-sc-stage'") + 2600)
  assert.match(stage, /layout === 'wall'\s*\?\s*e\(CardWall,/, '墙分支渲染 CardWall')
  assert.match(stage, /:\s*e\(CardFan,/, '另一分支渲染 CardFan')

  const wallStart = clientSrc.indexOf('e(CardWall, {')
  const fanStart = clientSrc.indexOf('e(CardFan, {', wallStart)
  assert.ok(wallStart !== -1 && fanStart > wallStart, '两种布局都必须被渲染')
  const wallProps = clientSrc.slice(wallStart, fanStart)
  assert.doesNotMatch(wallProps, /initialFocus|onFocusChange/, '墙里没有「当前卡」，不参与焦点接力')
  const fanProps = clientSrc.slice(fanStart, fanStart + 700)
  assert.match(fanProps, /initialFocus: focusRef\.current/, '扇形要接住墙里浏览的那张卡')
  assert.match(fanProps, /onFocusChange: noteFocus/, '扇形要把当前卡写回同一个 ref')
  assert.match(clientSrc, /const noteFocus = useCallback\(\(name\) => \{ focusRef\.current = name \}, \[\]\)/,
    'noteFocus 只改 ref，不触发重渲染')
})

test('工具栏是「墙 / 扇」两个真按钮，aria-pressed 跟随 layout', () => {
  const bar = sliceBetween("e('span', { className: 'dsh-sc-layout'", "t('layoutFan')))")
  assert.equal((bar.match(/e\('button', \{/g) || []).length, 2, '必须是两个真按钮，不是 role=radio 的假控件')
  assert.match(bar, /role: 'group'/, '分段控件要有分组语义')
  assert.match(bar, /type: 'button'/, '按钮必须显式声明 type=button')
  assert.match(bar, /'aria-pressed': layout === 'wall' \? 'true' : 'false'/, '「墙」的按压态跟随 layout')
  assert.match(bar, /'aria-pressed': layout === 'fan' \? 'true' : 'false'/, '「扇形」的按压态跟随 layout')
  assert.match(bar, /onClick: \(\) => chooseLayout\('wall'\)/, '点「墙」走 chooseLayout("wall")')
  assert.match(bar, /onClick: \(\) => chooseLayout\('fan'\)/, '点「扇形」走 chooseLayout("fan")')
  assert.match(bar, /title: t\('layoutWall'\)/)
  assert.match(bar, /title: t\('layoutFan'\)/)
})

test('chooseLayout 乐观更新并落盘到 /prefs，首屏用本地镜像再被权威值覆盖', () => {
  const fn = sliceBetween('const chooseLayout = useCallback(async (next) => {', '}, [layout, showToast, t])')
  assert.match(fn, /const value = normalizeLayout\(next\)/, '传进来的值也要过白名单')
  assert.match(fn, /if \(value === layout\) return/, '已经是这个布局就不重复落盘')
  assert.match(fn, /setLayout\(value\)\s*\n\s*cacheLayout\(value\)/, '先乐观更新：点了立刻生效并写本地镜像')
  assert.match(fn, /api\('\/prefs', \{[\s\S]{0,200}?method: 'POST'[\s\S]{0,200}?JSON\.stringify\(\{ layout: value \}\)/,
    '必须 POST /prefs 持久化（换窗口/重启都跟着走）')
  assert.match(fn, /const served = normalizeLayout\(res\?\.prefs\?\.layout\)[\s\S]{0,120}?setLayout\(served\)[\s\S]{0,120}?cacheLayout\(served\)/,
    '以宿主返回的权威值为准，避免本地状态与存储长期分叉')
  assert.match(fn, /catch \(err\) \{[\s\S]{0,200}?showToast/, '落盘失败要提示用户（未重启的旧宿主没有 /prefs 是常态）')

  assert.match(clientSrc, /const \[layout, setLayout\] = useState\(\(\) => readCachedLayout\(\)\)/,
    'layout 初值取本地镜像，避免读到权威值前先闪一下默认布局')
  const boot = sliceBetween('let alive = true', 'return () => { alive = false }')
  assert.match(boot, /let alive = true/, '挂载时异步读偏好，卸载后不得再 setState')
  assert.match(boot, /normalizeLayout\(res\?\.prefs\?\.layout\)/, '宿主返回的值也要归一化')
  assert.match(boot, /setLayout\(served\)[\s\S]{0,80}?cacheLayout\(served\)/, '读到权威值后同步镜像')
  assert.match(boot, /catch\(\(\) =>/, '读不到偏好就保留镜像/默认值，不弹错')
})

test('切到墙只滚 stage 自己并短暂描边，绝不用 scrollIntoView', () => {
  const effect = sliceBetween('// 切到墙：', '}, [layout])')
  assert.match(effect, /if \(layout !== 'wall'\) return/, '只在墙模式里定位')
  assert.match(effect, /const name = focusRef\.current[\s\S]{0,200}?if \(!name \|\| !stage\) return/,
    '没有交接对象或没有舞台就直接跳过')
  assert.match(effect, /querySelectorAll\('\.dsh-sc-card'\)[\s\S]{0,120}?dataset\.name === name/,
    '按名字找卡（排序/过滤后仍对得上同一张）')
  assert.match(effect, /closest\('\.dsh-sc-card-wrap'\)/, '描边加在卡壳上')
  assert.match(effect, /stage\.scrollTop = Math\.max\(0, top\)/, '只改 stage 自己的 scrollTop')
  assert.match(effect, /classList\.add\('focus-flash'\)/)
  assert.match(effect, /setTimeout\(\(\) => target\.classList\.remove\('focus-flash'\), 700\)/, '描边是短暂的')
  assert.match(effect, /clearTimeout\(id\); target\.classList\.remove\('focus-flash'\)/, '切换/卸载时要收尾')
  // 「不用 scrollIntoView」是这段代码的核心约束：它会连带把宿主页面一起滚走。
  assert.ok(!stripComments(effect).includes('scrollIntoView'), '切墙定位不得使用 scrollIntoView')
  assert.doesNotMatch(stripComments(clientSrc), /scrollIntoView/, '整个客户端都不该出现 scrollIntoView')

  // 描边样式必须真的存在，并且尊重「减弱动态效果」。
  assert.match(clientSrc, /\.dsh-sc-card-wrap\.focus-flash \{ animation:dshScFocusFlash/)
  assert.match(clientSrc, /\.dsh-sc-card-wrap\.focus-flash \{ animation:none; box-shadow:/,
    'prefers-reduced-motion 下不播脉冲，改成静态描边')
})
