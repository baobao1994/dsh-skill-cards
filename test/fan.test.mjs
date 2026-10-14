import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

// The client is a classic script, so exercise its real functions without
// introducing a browser or a second implementation of the layout algorithm.
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist`)
  const end = source.indexOf('\n    }', start)
  return source.slice(start, end + '\n    }'.length)
}

// CardFan reads these thresholds, so they travel with it into the sandbox.
function constSource(name) {
  const match = source.match(new RegExp(`^\\s*const ${name} = .*$`, 'm'))
  assert.notEqual(match, null, `${name} must exist`)
  return match[0].trim()
}

const MODEL = [
  constSource('FAN_DRAG_START'),
  constSource('FAN_CLICK_SLOP'),
  constSource('FAN_DRAG_MAX'),
  functionSource('clampDragUnits'),
  functionSource('fanMetrics'),
  functionSource('fanPose'),
].join('\n')

const { fanMetrics, fanPose, clampDragUnits, FAN_DRAG_MAX } = runInNewContext(`
  ${MODEL}
  ({ fanMetrics, fanPose, clampDragUnits, FAN_DRAG_MAX })
`)

const { captureCardRects } = runInNewContext(`
  ${functionSource('captureCardRects')}
  ({ captureCardRects })
`)

function transformParts(pose) {
  const numbers = pose.transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px, 0\) rotate\(([-\d.]+)deg\) scale\(([-\d.]+)\)/)
  assert.ok(numbers, 'the pose must use a composited translation, rotation and scale')
  return { x: Number(numbers[1]), y: Number(numbers[2]), angle: Number(numbers[3]), scale: Number(numbers[4]) }
}

// Transform the rectangle's four corners using the actual CSS origin and top
// inset. This independently catches bounds errors in the sizing helper.
function cardCorners(width, metrics, pose) {
  // Anchored at the line start so the .is-dragging override of the same class
  // (which carries no geometry) cannot be picked up instead.
  const slotRule = source.match(/^\.dsh-sc-fan-slot \{([^}]+)\}/m)[1]
  const top = Number(slotRule.match(/top:([\d.]+)px/)[1])
  assert.match(slotRule, /transform-origin:50% 100%/)
  const { x, y, angle, scale } = transformParts(pose)
  const radians = angle * Math.PI / 180
  return [-metrics.cardWidth / 2, metrics.cardWidth / 2].flatMap((cx) =>
    [-metrics.cardHeight, 0].map((cy) => ({
      x: width / 2 + x + scale * (cx * Math.cos(radians) - cy * Math.sin(radians)),
      y: top + metrics.cardHeight + y + scale * (cx * Math.sin(radians) + cy * Math.cos(radians)),
    })))
}

test('fan poses keep the current card largest and above symmetric neighbours', () => {
  for (const width of [280, 560, 1024]) {
    const metrics = fanMetrics(width, 900)
    const center = fanPose(0, metrics)
    const centerTransform = transformParts(center)
    assert.equal(centerTransform.x, 0)
    assert.equal(centerTransform.angle, 0)
    assert.equal(centerTransform.scale, 1)
    let previousScale = centerTransform.scale
    let previousLayer = center.zIndex
    for (let distance = 1; distance <= metrics.radius; distance++) {
      const left = fanPose(-distance, metrics)
      const right = fanPose(distance, metrics)
      const l = transformParts(left)
      const r = transformParts(right)
      assert.equal(l.x, -r.x)
      assert.equal(l.y, r.y)
      assert.equal(l.angle, -r.angle)
      assert.equal(l.scale, r.scale)
      assert.equal(left.zIndex, right.zIndex)
      assert.ok(r.scale < previousScale, 'each further card must be smaller')
      assert.ok(right.zIndex < previousLayer, 'each further card must be behind its neighbour')
      assert.ok(r.scale > 0 && r.x > 0, 'side cards must remain visible and separated')
      previousScale = r.scale
      previousLayer = right.zIndex
    }
  }
})

test('every visible card stays inside the hand across narrow, wide and short windows', () => {
  for (const width of [240, 320, 539, 540, 799, 800, 1024, 1600]) {
    for (const height of [360, 600, 900, 1200]) {
      const metrics = fanMetrics(width, height)
      assert.ok(metrics.cardWidth > 0 && metrics.cardHeight > 0)
      for (let offset = -metrics.radius; offset <= metrics.radius; offset++) {
        for (const corner of cardCorners(width, metrics, fanPose(offset, metrics))) {
          const context = `${width}×${height}, offset ${offset}: ${JSON.stringify(corner)}`
          assert.ok(corner.x >= 0 && corner.x <= width, `horizontal overflow: ${context}`)
          assert.ok(corner.y >= 0 && corner.y <= metrics.height, `vertical overflow: ${context}; hand height ${metrics.height}`)
        }
      }
    }
  }
})

test('available stage height shrinks cards to leave room for details without making short-window cards unreadable', () => {
  const roomy = fanMetrics(1000, 1200, 900)
  const compact = fanMetrics(1000, 1200, 650)
  const shorter = fanMetrics(1000, 1200, 540)
  assert.ok(roomy.cardHeight > compact.cardHeight && compact.cardHeight > shorter.cardHeight,
    'the actual stage height must affect card size even when viewport size is unchanged')
  for (const width of [560, 1000]) {
    for (const available of [540, 650, 900]) {
      const metrics = fanMetrics(width, 1200, available)
      assert.ok(available - metrics.height >= 180,
        `${width}px stage with ${available}px height must leave a useful area below the fan`)
      assert.ok(metrics.cardHeight >= 200, 'height-constrained cards must retain a readable minimum')
    }
    const small = fanMetrics(width, 360, 300)
    const tiny = fanMetrics(width, 240, 200)
    assert.ok(Math.abs(small.cardHeight - 200) < 1e-8)
    assert.equal(tiny.cardHeight, small.cardHeight, 'shorter windows must scroll instead of continuously shrinking cards')
    assert.ok(tiny.height > 200, 'the minimum card and its fan may exceed a tiny stage and require scrolling')
  }
})

function descendants(node) {
  if (!node || typeof node !== 'object') return []
  return [node, ...(node.children || []).flatMap(descendants)]
}

function byClass(tree, name) {
  return descendants(tree).filter((node) => node.props?.className?.split(' ').includes(name))
}

// One pointer event, as the hand's handlers read them: `onCard` decides whether
// the press landed on a card slot or on the empty gutter around the fan.
function pointerEvent(clientX, clientY, { pointerType = 'touch', onCard = false, pointerId = 11, isPrimary = true } = {}) {
  return {
    pointerType, button: 0, isPrimary, pointerId, clientX, clientY,
    target: { closest: (selector) => (onCard && selector === '.dsh-sc-fan-slot' ? {} : null) },
    currentTarget: { setPointerCapture() {} },
  }
}

// A small hook runner renders CardFan itself, preserving state, effect cleanup
// and refs across user actions. Cards remain opaque so this tests the fan's
// integration contract rather than recreating the entire host application.
function mountFan(skills, { width = 1000, height = 900, selected = new Set() } = {}) {
  const hooks = []
  const effects = []
  const timers = new Map()
  const events = new Map()
  let cursor = 0
  let timerId = 0
  let dirty = false
  let tree
  let props
  const toggled = []
  const Card = function Card() {}
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const scope = {
    Card,
    e: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((item) => item != null && item !== false) }),
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
  const CardFan = runInNewContext(`
    ${MODEL}
    ${functionSource('CardFan')}
    CardFan
  `, scope)
  props = {
    skills, selected, t: (key) => key, catDefs: {},
    onToggle: (name) => { toggled.push(name); selected.has(name) ? selected.delete(name) : selected.add(name) },
    onStar() {}, onSetImage() {},
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
            // 点空白翻页按手部矩形的左右半区判断方向。
            getBoundingClientRect: () => ({ left: 0, top: 0, width, height: 1 }),
          }
        }
      }
      while (effects.length) effects.shift()()
      if (!dirty) return tree
    }
    throw new Error('CardFan effects did not settle')
  }
  render()
  return {
    get tree() { return tree },
    get slots() { return byClass(tree, 'dsh-sc-fan-slot') },
    get current() { return byClass(tree, 'is-current')[0]?.children[0].props.skill.name },
    get nav() { return byClass(tree, 'dsh-sc-fan-nav')[0]?.children.filter((node) => node.type === 'button') },
    get details() { return byClass(tree, 'dsh-sc-details-actions')[0]?.children },
    toggled, selected, render,
    settle() { for (const [id, fn] of [...timers]) { timers.delete(id); fn() } return render() },
    resize(nextWidth, nextHeight) { width = nextWidth; scope.window.innerHeight = nextHeight; events.get('resize')?.(); return render() },
    clickCard(name) {
      const card = this.slots.map((slot) => slot.children[0]).find((card) => card.props.skill.name === name)
      assert.ok(card, `${name} must be mounted to click it`)
      card.props.onToggle(name)
      return render()
    },
    step(delta) { this.nav[delta < 0 ? 0 : 1].props.onClick(); return render() },
  }
}

const skills = (count) => Array.from({ length: count }, (_, index) => ({ name: `skill-${index}`, description: `description ${index}` }))

test('the fan bounds mounted cards and makes transparent buffers noninteractive', () => {
  const list = skills(95)
  const fan = mountFan(list)
  for (let i = 0; i < 40; i++) fan.step(1)
  for (const width of [320, 600, 1000]) {
    fan.resize(width, 900)
    assert.ok(fan.slots.length <= 9, 'large libraries must not mount the whole collection')
    const visible = fan.slots.filter((slot) => slot.props.style.opacity > 0)
    assert.ok(visible.length <= 7)
    for (const slot of fan.slots.filter((slot) => slot.props.style.opacity === 0)) {
      assert.equal(slot.props['aria-hidden'], 'true')
      assert.equal(slot.props.inert, '')
      assert.equal(slot.props.style.pointerEvents, 'none')
    }
    fan.settle()
    const enabled = fan.slots.filter((slot) => slot.children[0].props.interactive)
    assert.equal(enabled.length, 1, 'only the stable center may open card popovers')
    assert.equal(enabled[0].children[0].props.skill.name, fan.current)
  }
})

test('the current card keeps its category chip mounted while it settles', () => {
  // 切牌瞬间当前卡进入 480ms 的"不稳定"窗口：interactive 关闭（不许开分类弹层，
  // 弹层坐标要在卡牌稳定后测量），但 isCurrent 必须仍为 true —— 否则分类标签会被
  // 卸载重挂，.gc-stats 行重排，用户看到"闪一下"。
  const fan = mountFan(skills(9))
  fan.step(1)
  const cardOf = (name) => fan.slots.find((slot) => slot.children[0].props.skill.name === name).children[0]
  assert.equal(cardOf(fan.current).props.isCurrent, true, 'chip stays mounted while settling')
  assert.equal(cardOf(fan.current).props.interactive, false, 'but must not open its popover yet')
  fan.settle()
  assert.equal(cardOf(fan.current).props.isCurrent, true)
  assert.equal(cardOf(fan.current).props.interactive, true, 'and becomes interactive once settled')
  // 侧牌维持原来的纯文本标签（不挂 chip），外观不变。
  const side = fan.slots.find((slot) => slot.children[0].props.skill.name !== fan.current && slot.props.style.opacity > 0)
  assert.equal(side.children[0].props.isCurrent, false, 'side cards keep the plain label')
})

test('the fan opens with the middle card centered, whatever the library size', () => {
  assert.equal(mountFan(skills(1)).current, 'skill-0')
  assert.equal(mountFan(skills(2)).current, 'skill-0')
  assert.equal(mountFan(skills(3)).current, 'skill-1')
  assert.equal(mountFan(skills(4)).current, 'skill-1')
  // 95 张卡里居中的是第 47 张（0 起算），两侧各 47 张，扇形左右对称。
  const fan = mountFan(skills(95))
  assert.equal(fan.current, 'skill-47')
  assert.deepEqual(fan.nav.map((button) => button.props.disabled), [false, false],
    'opening in the middle must leave both directions available')
})

test('first and last cards clamp navigation, including a single-card result', () => {
  const fan = mountFan(skills(3))
  assert.equal(fan.current, 'skill-1')
  fan.step(-1)
  assert.equal(fan.current, 'skill-0')
  assert.equal(fan.nav[0].props.disabled, true)
  fan.step(1)
  fan.step(1)
  assert.equal(fan.current, 'skill-2')
  assert.equal(fan.nav[1].props.disabled, true)
  fan.step(1)
  assert.equal(fan.current, 'skill-2')
  fan.render({ skills: [skills(3)[1]] })
  assert.equal(fan.current, 'skill-1')
  assert.ok(fan.nav.every((button) => button.props.disabled))
  fan.render({ skills: [] })
  assert.equal(fan.tree, null)
  fan.render({ skills: skills(2) })
  assert.equal(fan.current, 'skill-0')
})

test('reordering retains the browsed skill while filtering safely chooses a remaining card', () => {
  const list = skills(5)
  const fan = mountFan(list)
  // 默认居中在第 2 张（5 张的正中），排序后仍要跟着同一张卡。
  assert.equal(fan.current, 'skill-2')
  fan.render({ skills: [...list].reverse() })
  assert.equal(fan.current, 'skill-2', 'sort changes should preserve identity')
  fan.render({ skills: [list[4], list[1]] })
  assert.equal(fan.current, 'skill-4', 'a removed current card should fall back within the results')
  assert.equal(fan.nav[0].props.disabled, true)
  assert.deepEqual(fan.toggled, [], 'filtering and sorting are browsing, not selection')
})

test('browsing leaves business multi-selection intact and details target the current card', () => {
  const selected = new Set(['skill-0', 'skill-90'])
  const fan = mountFan(skills(95), { selected })
  assert.equal(fan.current, 'skill-47')
  fan.clickCard('skill-48')
  fan.step(1)
  assert.equal(fan.current, 'skill-49')
  assert.deepEqual([...selected], ['skill-0', 'skill-90'])
  assert.deepEqual(fan.toggled, [])
  fan.details[0].props.onClick()
  fan.render()
  assert.deepEqual(fan.toggled, ['skill-49'])
  assert.ok(selected.has('skill-49'))
  assert.ok(selected.has('skill-90'), 'an unmounted selected skill must remain selected')
  fan.clickCard('skill-49')
  assert.ok(!selected.has('skill-49'), 'clicking the central face retains the existing toggle action')
  const current = fan.slots.find((slot) => slot.children[0].props.skill.name === 'skill-49')
  assert.equal(current.children[0].props.selected, false)
})

test('horizontal touch swipes browse once without toggling, while vertical gestures do not browse', () => {
  const fan = mountFan(skills(10))
  let hand = byClass(fan.tree, 'dsh-sc-fan-hand')[0]
  hand.props.onPointerDown(pointerEvent(180, 100))
  hand.props.onPointerUp(pointerEvent(80, 110))
  fan.render()
  assert.equal(fan.current, 'skill-5')
  assert.deepEqual(fan.toggled, [])
  let prevented = false
  let stopped = false
  hand = byClass(fan.tree, 'dsh-sc-fan-hand')[0]
  hand.props.onClickCapture({ preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
  assert.ok(prevented && stopped, 'the synthetic click following a swipe must be swallowed')
  hand.props.onPointerDown(pointerEvent(180, 100))
  hand.props.onPointerUp(pointerEvent(130, 250))
  fan.render()
  assert.equal(fan.current, 'skill-5')
})

test('a drag on the card follows the pointer and snaps to the nearest position', () => {
  const width = 1000
  const { step } = fanMetrics(width, 900, 900)
  const fan = mountFan(skills(9), { width, height: 900 })
  const hand = () => byClass(fan.tree, 'dsh-sc-fan-hand')[0]
  assert.equal(fan.current, 'skill-4')
  // 起手在中央卡面（鼠标也要能拖 —— 旧实现直接忽略了鼠标拖动）。
  hand().props.onPointerDown(pointerEvent(500, 300, { pointerType: 'mouse', onCard: true }))
  hand().props.onPointerMove(pointerEvent(500 - step * 1.2, 302))
  fan.render()
  assert.ok(byClass(fan.tree, 'dsh-sc-fan-hand')[0].props.className.includes('is-dragging'),
    'the hand must expose the dragging state so CSS can drop the transition')
  const centered = fan.slots.find((slot) => slot.children[0].props.skill.name === 'skill-4')
  assert.ok(Math.abs(transformParts(centered.props.style).x + step * 1.2) < 1e-6,
    'the browsed card must follow the pointer while dragging')
  // 拖动过半后高亮（is-current）已移向吸附目标（reveal 动画取坐标的锚点必须一直在）
  assert.equal(byClass(fan.tree, 'is-current')[0].children[0].props.skill.name, 'skill-5')
  // 多指同时按下：后来者不得清掉点击抑制，否则松手那次 click 会误勾选。
  byClass(fan.tree, 'dsh-sc-fan-hand')[0].props.onPointerDown(
    pointerEvent(700, 320, { pointerId: 22, isPrimary: false }))
  // 拖过 1.2 格：松手吸附到 1 格之后的卡，并清除拖动状态。
  hand().props.onPointerUp(pointerEvent(500 - step * 1.2, 302))
  fan.render()
  assert.equal(fan.current, 'skill-5')
  assert.ok(!byClass(fan.tree, 'dsh-sc-fan-hand')[0].props.className.includes('is-dragging'))
  assert.deepEqual(fan.toggled, [], 'dragging is browsing, never selecting')
  // 拖动后的那次合成 click 必须被吞掉，且要点空白才知道高亮回到中央。
  let prevented = false
  byClass(fan.tree, 'dsh-sc-fan-hand')[0].props.onClickCapture(
    { preventDefault() { prevented = true }, stopPropagation() {} })
  assert.ok(prevented, 'the synthetic click after a drag must be swallowed')
})

test('a press that barely moves stays a click, and dragging sticks to the list ends', () => {
  const width = 1000
  const { step } = fanMetrics(width, 900, 900)
  const fan = mountFan(skills(3), { width, height: 900 })
  const hand = () => byClass(fan.tree, 'dsh-sc-fan-hand')[0]
  // 手抖 5px 不算拖动：随后的点击必须照常勾选。
  hand().props.onPointerDown(pointerEvent(500, 300, { onCard: true }))
  hand().props.onPointerMove(pointerEvent(505, 302))
  hand().props.onPointerUp(pointerEvent(505, 302))
  fan.render()
  assert.equal(fan.current, 'skill-1')
  let prevented = false
  hand().props.onClickCapture({ preventDefault() { prevented = true }, stopPropagation() {} })
  assert.equal(prevented, false, 'a wobble must not swallow the card click')
  // 纵向手势交给滚动，不翻牌。
  hand().props.onPointerDown(pointerEvent(500, 100, { onCard: true }))
  hand().props.onPointerMove(pointerEvent(520, 260))
  fan.render()
  assert.ok(!byClass(fan.tree, 'dsh-sc-fan-hand')[0].props.className.includes('is-dragging'),
    'a vertical gesture must not turn into a drag')
  hand().props.onPointerUp(pointerEvent(520, 260))
  fan.render()
  assert.equal(fan.current, 'skill-1')
  // 已经在头一张：往右拖到底顶住，松手也不越界。
  fan.step(-1)
  assert.equal(fan.current, 'skill-0')
  const edge = () => byClass(fan.tree, 'dsh-sc-fan-hand')[0]
  edge().props.onPointerDown(pointerEvent(500, 300, { onCard: true }))
  edge().props.onPointerMove(pointerEvent(500 + step * 3, 300))
  fan.render()
  const first = fan.slots.find((slot) => slot.children[0].props.skill.name === 'skill-0')
  assert.equal(transformParts(first.props.style).x, 0, 'the first card must not be dragged past the edge')
  byClass(fan.tree, 'dsh-sc-fan-hand')[0].props.onPointerUp(pointerEvent(500 + step * 3, 300))
  fan.render()
  assert.equal(fan.current, 'skill-0')
  assert.deepEqual(fan.toggled, [])
})

test('clicking the empty gutter around the fan browses one card toward that side', () => {
  const fan = mountFan(skills(9), { width: 1000, height: 900 })
  const click = (clientX) => {
    const hand = () => byClass(fan.tree, 'dsh-sc-fan-hand')[0]
    hand().props.onPointerDown(pointerEvent(clientX, 300))
    hand().props.onPointerUp(pointerEvent(clientX, 300))
    return fan.render()
  }
  assert.equal(fan.current, 'skill-4')
  click(20)
  assert.equal(fan.current, 'skill-3', 'the left half steps back')
  click(980)
  assert.equal(fan.current, 'skill-4', 'the right half steps forward')
  click(400)
  assert.equal(fan.current, 'skill-3')
  assert.deepEqual(fan.toggled, [], 'gutter clicks are browsing, never selecting')
})

test('dragging inside the mount window keeps every followed card mounted', () => {
  // 拖动时缓冲卡要跟着扩展，否则跟随方向上的牌会中途"消失"。
  const width = 520
  const metrics = fanMetrics(width, 900, 900)
  const fan = mountFan(skills(30), { width, height: 900 })
  const hand = () => byClass(fan.tree, 'dsh-sc-fan-hand')[0]
  const before = fan.slots.length
  hand().props.onPointerDown(pointerEvent(260, 300, { onCard: true }))
  hand().props.onPointerMove(pointerEvent(260 - metrics.step * (FAN_DRAG_MAX + 1), 300))
  fan.render()
  assert.equal(Math.round(clampDragUnits(FAN_DRAG_MAX + 1, 14, 30)), FAN_DRAG_MAX,
    'a long drag is capped so it cannot mount the whole library')
  assert.ok(fan.slots.length >= before + FAN_DRAG_MAX,
    `dragging must mount the incoming cards (${before} → ${fan.slots.length})`)
  // 缓冲只随被夹住的拖动距离增长：两侧各 (radius+1) + 拖动格数 + 1。
  assert.ok(fan.slots.length <= 2 * (metrics.radius + FAN_DRAG_MAX + 2) + 1)
})

test('reveal captures mounted cards and uses the center for unmounted selected skills', () => {
  const visibleRect = { left: 25, top: 40, width: 160, height: 233 }
  const centerRect = { left: 400, top: 20, width: 260, height: 379 }
  const grid = {
    querySelector(selector) {
      if (selector === '.dsh-sc-card[data-name="visible"]') return { getBoundingClientRect: () => visibleRect }
      if (selector === '.dsh-sc-fan-slot.is-current .dsh-sc-card') return { getBoundingClientRect: () => centerRect }
      return null
    },
  }
  const result = captureCardRects(grid, ['visible', 'outside', 'third', 'fourth', 'fifth', 'sixth', 'seventh'])
  assert.equal(result.length, 6, 'preserve the existing reveal cap')
  assert.deepEqual(Array.from(result, (card) => card.name), ['visible', 'outside', 'third', 'fourth', 'fifth', 'sixth'])
  assert.deepEqual({ ...result[0] }, { name: 'visible', x: 25, y: 40, w: 160, h: 233 })
  assert.deepEqual({ ...result[1] }, { name: 'outside', x: 400, y: 20, w: 260, h: 379 })
  assert.equal(captureCardRects(null, ['outside']).length, 0)
  assert.equal(captureCardRects(grid, []).length, 0)
  assert.equal(captureCardRects({ querySelector: () => null }, ['outside']).length, 0)
})
