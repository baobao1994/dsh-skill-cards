/**
 * Regression tests for the card popovers (category picker + original text).
 *
 * Two bugs are pinned here, both found by driving the built panel in a real
 * browser (headless Chrome over the diagnose page, 8 cards / 22 categories):
 *
 *  1. COVERED — `.dsh-sc-card-wrap` carries `contain:layout`, so every card is
 *     its own paint layer and the menu opened from a card was painted UNDER the
 *     cards that follow it in source order.
 *  2. UNREACHABLE — the popover lives inside `.dsh-sc-stage`, the panel's only
 *     scroll container, which clips its overflow. The menu had no height cap, so
 *     on the lower rows its tail ran past the stage edge and could not be
 *     clicked. It now caps its height, scrolls internally, and is positioned
 *     inside the stage.
 *
 * The first version of the fix measured the space above/below the TRIGGER (the
 * category chip, which sits at the bottom of the card) while the popover is
 * anchored to the card WRAPPER — so a top-row card was told it had a whole card's
 * height of room above it and hung its menu 260px above the stage, where it was
 * clipped. The placement tests below drive that exact geometry.
 *
 * `popoverPlacement` is evaluated straight out of the client bundle (the browser
 * half is a single classic script with no module boundary), against fake DOM
 * boxes, so the geometry is tested as behaviour rather than as source shape.
 *
 * Run: node --test test/popover.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client', 'client.js')
const source = readFileSync(clientPath, 'utf8')

function cssBlock() {
  const start = source.indexOf('const CSS = `')
  assert.ok(start !== -1, 'CSS template literal not found')
  return source.slice(start + 'const CSS = `'.length, source.indexOf('function ensureStyle'))
}

/** Pull `popoverPlacement` out of the bundle and expose it as a plain function. */
function loadPlacement() {
  const start = source.indexOf('function popoverPlacement(')
  assert.ok(start !== -1, 'popoverPlacement must exist in client.js')
  const end = source.indexOf('\n    }', start)
  assert.ok(end !== -1, 'popoverPlacement body not found')
  const body = source.slice(start, end + '\n    }'.length)
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn popoverPlacement`)()
}

const rect = (top, bottom, left, right) => ({ top, bottom, left, right, height: bottom - top, width: right - left })

/**
 * A fake card: `anchor` is the clicked control (category chip / "原" button),
 * `card` the wrapper the popover is positioned against, `stage` the scroll
 * container that clips. `closest()` mirrors the real DOM lookup the code does.
 */
function fakeDom({ stage, card, anchor }) {
  const stageEl = { getBoundingClientRect: () => rect(stage.t, stage.b, stage.l, stage.r), closest: () => null }
  const cardEl = {
    getBoundingClientRect: () => rect(card.t, card.b, card.l, card.r),
    closest: (sel) => (sel === '.dsh-sc-stage' ? stageEl : null),
  }
  return {
    getBoundingClientRect: () => rect(anchor.t, anchor.b, anchor.l, anchor.r),
    closest: (sel) => (sel === '.dsh-sc-stage' ? stageEl : sel === '.dsh-sc-card-wrap' ? cardEl : null),
  }
}

/** The stage used throughout: the geometry measured in the browser probe. */
const STAGE = { t: 294, b: 724, l: 25, r: 875 }
/** Two card rows: 190x277 TCG cards, second row starting below the fold. */
const TOP_CARD = { t: 310, b: 587, l: 41, r: 231 }
const BOTTOM_CARD = { t: 601, b: 878, l: 654, r: 844 }

test('placement measures the CARD wrapper, not the trigger', () => {
  // The chip sits at the card's bottom edge; the "原" button at its top. Both
  // open the same panel in the same place, because the popover hangs off the
  // card — measuring the trigger instead is what sent the menu off the stage.
  const placement = loadPlacement()
  const chipAtBottom = fakeDom({
    stage: STAGE, card: TOP_CARD, anchor: { t: 564, b: 579, l: 58, r: 109 },
  })
  const buttonAtTop = fakeDom({
    stage: STAGE, card: TOP_CARD, anchor: { t: 316, b: 338, l: 173, r: 195 },
  })
  assert.deepEqual(placement(chipAtBottom, 200, 300), placement(buttonAtTop, 200, 300))
})

test('a top-row card never opens upward past the stage edge', () => {
  // Regression: the chip reported ~258px of room above it, so the panel was
  // placed above the stage (top: 52 for a stage starting at 294) and clipped.
  const placement = loadPlacement()
  const anchor = fakeDom({ stage: STAGE, card: TOP_CARD, anchor: { t: 564, b: 579, l: 58, r: 109 } })
  const p = placement(anchor, 200, 300)
  assert.equal(p.up, false, 'a card in the first row must open downward')
  assert.ok(TOP_CARD.t + p.top >= STAGE.t, 'the panel must start inside the stage')
  assert.ok(TOP_CARD.t + p.top + p.room <= STAGE.b, 'the panel must end inside the stage')
})

test('a card below the fold opens upward, fully inside the stage', () => {
  // Second row at scrollTop=0: the card runs from 601 to 878 while the stage
  // ends at 724, so downward is impossible and the panel flips up.
  const placement = loadPlacement()
  const anchor = fakeDom({ stage: STAGE, card: BOTTOM_CARD, anchor: { t: 855, b: 870, l: 670, r: 721 } })
  const p = placement(anchor, 200, 300)
  assert.equal(p.up, true, 'a card that is mostly below the fold must open upward')
  assert.ok(BOTTOM_CARD.t + p.top >= STAGE.t, 'the panel must start inside the stage')
  assert.ok(BOTTOM_CARD.t + p.top + p.room <= STAGE.b, 'the panel must end inside the stage')
})

test('the panel is clamped inside the stage for every row and scroll offset', () => {
  const placement = loadPlacement()
  const rows = [0, 186] // stage.scrollTop values that shift both rows by 186px
  const cards = [{ ...TOP_CARD }, { ...BOTTOM_CARD }]
  for (const offset of rows) {
    for (const card of cards) {
      const shifted = { t: card.t - offset, b: card.b - offset, l: card.l, r: card.r }
      const chip = { t: shifted.b - 23, b: shifted.b - 8, l: shifted.l + 17, r: shifted.l + 68 }
      for (const preferred of [300, 320]) {
        const p = placement(fakeDom({ stage: STAGE, card: shifted, anchor: chip }), 200, preferred)
        assert.ok(p.top !== null, 'a measurable stage must produce an explicit top')
        assert.ok(shifted.t + p.top >= STAGE.t - 0.5, `clipped above (offset ${offset}, top ${shifted.t + p.top})`)
        assert.ok(shifted.t + p.top + p.room <= STAGE.b + 0.5, `clipped below (offset ${offset})`)
        assert.ok(p.room >= 96 && p.room <= preferred, 'the height cap must stay useful and bounded')
      }
    }
  }
})

test('placement stays on screen even when the stage is partly scrolled away', () => {
  // The inline settings panel is NOT inside the fixed modal backdrop — it lives
  // in the host's own scroller, so the stage itself can be partly out of view.
  // Clamping to the stage alone would then still drop the panel off screen.
  const placement = loadPlacement()
  const anchor = fakeDom({ stage: STAGE, card: TOP_CARD, anchor: { t: 564, b: 579, l: 58, r: 109 } })
  const previous = globalThis.window
  globalThis.window = { innerHeight: 420, innerWidth: 900 }
  try {
    const p = placement(anchor, 200, 300)
    assert.ok(TOP_CARD.t + p.top >= 0, `panel starts above the viewport (${TOP_CARD.t + p.top})`)
    assert.ok(TOP_CARD.t + p.top + p.room <= 420, `panel ends below the viewport (${TOP_CARD.t + p.top + p.room})`)
    assert.ok(p.room >= 96, 'the panel must keep a usable height')
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
})

test('width and left keep the panel inside the stage horizontally', () => {
  const placement = loadPlacement()
  // A narrow card on the right edge: the panel is wider than the card, so it has
  // to be nudged left to stay on screen instead of spawning a scrollbar.
  const narrow = { t: 310, b: 500, l: 790, r: 866 }
  const anchor = fakeDom({ stage: STAGE, card: narrow, anchor: { t: 495, b: 505, l: 800, r: 850 } })
  const p = placement(anchor, 340, 300)
  assert.ok(p.width <= STAGE.r - STAGE.l - 16, 'the panel must fit the stage width')
  assert.ok(narrow.l + p.left >= STAGE.l - 0.5, 'the panel must not stick out on the left')
  assert.ok(narrow.l + p.left + p.width <= STAGE.r + 0.5, 'the panel must not stick out on the right')
})

test('placement degrades to the CSS fallback when no stage can be measured', () => {
  const placement = loadPlacement()
  assert.deepEqual(placement(null, 200, 300), { up: false, room: 300, width: 200, left: 0, top: null })
  const orphan = { getBoundingClientRect: () => rect(0, 20, 0, 20), closest: () => null }
  assert.equal(placement(orphan, 200, 300).top, null, 'no stage means no measured top')
})

test('the popover caps its height and scrolls, so a long list stays reachable', () => {
  const css = cssBlock()
  const rule = css.match(/\.dsh-sc-catpop, \.dsh-sc-srcpop \{([^}]*)\}/)
  assert.ok(rule, 'the shared popover rule must exist')
  assert.match(rule[1], /overflow-y:auto/, 'the panel must scroll its own overflow')
  assert.match(rule[1], /position:absolute/, 'the panel is anchored to the card')
  assert.match(rule[1], /top:100%/, 'top:100% is the no-stage fallback')
  // The measured cap travels as an inline max-height, since it depends on where
  // the card happens to sit inside the scrolling stage.
  assert.ok(
    source.includes('style: { width: pop.width, maxHeight: pop.room, left: pop.left, top: pop.top }'),
    'both popovers must apply the measured width/height/offset',
  )
})

test('opening a popover lifts that card above its siblings', () => {
  const css = cssBlock()
  assert.match(css, /\.dsh-sc-card-wrap\.pop-open \{ z-index:\d+/, 'the open card must outrank its siblings')
  assert.ok(
    source.includes("className: `dsh-sc-card-wrap${pop ? ' pop-open' : ''}`"),
    'the wrapper must carry the raised class while a popover is open',
  )
  // Both panels are children of the wrapper (a sibling of the card button), so
  // they escape the card's own overflow:hidden.
  assert.ok(source.includes("catOpen ? e('div', {\n          className: `dsh-sc-catpop"), 'the menu must be a wrapper child')
  assert.ok(source.includes("infoOpen ? e('div', {\n          className: `dsh-sc-srcpop"), 'the info panel must be a wrapper child')
})

test('the trigger is exempt from the outside-click close, so it also closes its own panel', () => {
  // Without the exemption the pointerdown that precedes a click on the trigger
  // closed the panel and the click reopened it, so the toggle never closed.
  const effect = source.slice(source.indexOf('if (!pop) return'), source.indexOf("}, [pop])"))
  for (const guard of ['popRef.current.contains(target)', 'catAnchorRef.current.contains(target)', 'infoAnchorRef.current.contains(target)']) {
    assert.ok(effect.includes(guard), `the close handler must exempt ${guard}`)
  }
  assert.ok(
    effect.indexOf('infoAnchorRef.current.contains(target)') < effect.indexOf('setPop(null)'),
    'every exemption must be checked before closing',
  )
  assert.match(effect, /ev\.key === 'Escape'/, 'Escape must close the panel')
})

test('the card exposes the skill\'s own name and description ("原")', () => {
  assert.ok(source.includes("className: 'dsh-sc-srcbtn'"), 'the original-text button must exist')
  assert.match(source, /'aria-label': t\('origTitle'\)/, 'the button must be labelled from the dictionary')
  // The panel must show the RAW skill fields, not the translated/edited overlays
  // the card face renders (that overlay is the whole reason the button exists).
  assert.match(source, /e\('div', \{ className: 'dsh-sc-srcpop-name' \}, skill\.name\)/)
  assert.match(source, /skill\.description \|\| t\('origNoDesc'\)/)
  assert.match(source, /skill\.label \? e\('div', \{ className: 'dsh-sc-srcpop-meta' \}/)
  // The description must be readable and copyable, not clamped like the face.
  const css = cssBlock()
  assert.match(css, /\.dsh-sc-srcpop-desc \{[^}]*user-select:text/)
  assert.ok(!/\.dsh-sc-srcpop-desc \{[^}]*line-clamp/.test(css), 'the original text must not be clamped')
})

test('every card tool lives in one wrapping cluster in the top-left corner', () => {
  const css = cssBlock()
  const rule = css.match(/\.dsh-sc-card \.dsh-sc-cardtools \{([^}]*)\}/)
  assert.ok(rule, 'the tool cluster rule must exist')
  assert.match(rule[1], /top:6px/, 'the cluster owns the top edge')
  assert.match(rule[1], /left:6px/, 'and the left edge')
  // Hand-placed offsets per button could not survive the grid's width range
  // (measured: 237px cards in a wide modal, 192px on a narrow window), where a
  // sixth absolutely positioned button was clipped by the card's own overflow
  // or landed on top of an existing one.
  assert.match(rule[1], /flex-wrap:wrap/, 'the row must wrap instead of overflowing')
  assert.match(rule[1], /right:\d+px/, 'and must stop short of the selection tick')
  // The row spans the title bar, so only the controls themselves take clicks.
  assert.match(rule[1], /pointer-events:none/, 'the container must not swallow card clicks')
  assert.match(css, /\.dsh-sc-cardtools > \* \{[^}]*pointer-events:auto/, 'the controls must re-enable clicks')
  // One reveal rule on the container (keyboard focus included) replaces six.
  assert.match(css, /\.dsh-sc-card:hover \.dsh-sc-cardtools,[\s\S]{0,80}\.dsh-sc-cardtools:focus-within \{ opacity:1; \}/,
    'hovering the card or focusing a tool must reveal the cluster')
  // A selected card's tick must never be covered by a later-in-DOM control.
  const tick = css.match(/\.dsh-sc-card \.dsh-sc-check \{([^}]*)\}/)
  assert.ok(tick, 'the tick needs a game-card rule to stack above the cluster')
  assert.ok(Number(tick[1].match(/z-index:(\d+)/)[1]) > 6, 'the tick must outrank the cluster (z-index 6)')
})

test('the cluster holds all six tools, ordered state -> text -> artwork', () => {
  const start = source.indexOf("e('div', { className: 'dsh-sc-cardtools' }")
  assert.ok(start !== -1, 'the cluster must be rendered by the card')
  const cluster = source.slice(start, source.indexOf("catOpen ? e('div', {", start))
  const order = [
    "className: 'dsh-sc-star'",                     // 常用 (state)
    "className: 'dsh-sc-trans'",                    // 中文化
    "className: 'dsh-sc-trans dsh-sc-trans-reset'", // 还原
    "className: 'dsh-sc-srcbtn'",                   // 原
    "className: 'dsh-sc-artbtn'",                   // 卡图
    "className: 'dsh-sc-setimg'",                   // 自定义
  ]
  let previous = -1
  for (const cls of order) {
    const at = cluster.indexOf(cls)
    assert.ok(at !== -1, `${cls} must live inside the cluster`)
    assert.ok(at > previous, `${cls} is out of order`)
    previous = at
  }
})

test('no card tool is positioned by hand any more', () => {
  const css = cssBlock()
  // Regression: 自定义 and 原 were each pinned individually at some point
  // (bottom-left, then the art window, then top-right) and every hand-placed
  // corner collided with something at some column width — the category chip,
  // the art button, or the tick. Only the cluster may position them now.
  for (const sel of ['setimg', 'star', 'trans', 'artbtn', 'srcbtn']) {
    for (const m of css.matchAll(new RegExp(`\\.[\\w-]*\\b${sel}\\b[^{,]*\\{([^}]*)\\}`, 'g'))) {
      assert.ok(!/(^|;)\s*(position:absolute|left:\d|right:\d|bottom:\d|top:\d)/.test(m[1]),
        `.${sel} must not be positioned by hand: ${m[0]}`)
    }
  }
  // The cover affordance in particular must stay out of the chip's corner.
  assert.ok(!/\.dsh-sc-setimg \{[^}]*bottom:/.test(css),
    'the 自定义 pill must not return to the bottom-left corner (the chip sits there)')
  // The reveal belongs to the container. A leftover per-button reveal rule does
  // nothing (the container's opacity:0 multiplies down) but it lies about how
  // the cluster works — and the refactor left exactly two of them behind.
  const perButtonReveal = [...css.matchAll(/\.dsh-sc-card:hover \.dsh-sc-(?:star|trans|artbtn|srcbtn|setimg)\b[^{]*\{[^}]*opacity/g)]
  assert.deepEqual(perButtonReveal.map((m) => m[0]), [], 'per-button reveal rules must be gone')
})

test('Escape dismisses a card popover without closing the whole panel', () => {
  // The panel's own Escape handler is registered at mount, so it runs BEFORE the
  // popover's. Without this guard a single Escape closed the entire panel (and
  // the settings section) when the user only meant to dismiss a category menu.
  const handler = source.slice(
    source.indexOf('// Close on Escape (the image form first'),
    source.indexOf('}, [editing, onRequestClose])'),
  )
  assert.ok(handler.length > 0, 'the panel Escape handler must exist')
  assert.match(handler, /document\.querySelector\('\.dsh-sc-catpop, \.dsh-sc-srcpop'\)\) return/,
    'an open card popover must own the Escape key')
  assert.ok(
    handler.indexOf('dsh-sc-catpop') < handler.indexOf('onRequestClose()'),
    'the popover guard must come before closing the panel',
  )
})

test('the face button wraps the face only — no button inside a button', () => {
  // The card face used to BE a <button> with the tool buttons inside it: invalid
  // HTML, and under role="button" the same nesting would have made the tools
  // presentational for assistive tech. Now the face button wraps the face, and
  // the tick + tool cluster are its siblings.
  //
  // One interactive element deliberately stays inside the face: the category
  // chip, which is part of the printed card's ATK row (bottom-left). It is a
  // <span role="button"> so the HTML stays valid; the nesting is a known ARIA
  // nuance, and hoisting it out would mean either replicating the card's
  // proportional layout in absolute offsets or moving the category trigger into
  // the tool cluster (a UX change). Asserted here so it stays deliberate.
  const faceAt = source.indexOf("className: 'dsh-sc-cardhit'")
  assert.ok(faceAt !== -1, 'the face button must exist')
  // Everything between the face button's opening and the tick is the face; no
  // interactive element may live in there.
  const face = source.slice(faceAt, source.indexOf("className: 'dsh-sc-check'", faceAt))
  assert.ok(!face.includes("e('button'"), 'the face button must not wrap another button')
  assert.ok(!/role: 'button'/.test(face), 'and must not wrap a role="button" control either')
  // The cluster and the tick are siblings of the face button, inside the card.
  const clusterAt = source.indexOf("className: 'dsh-sc-cardtools'")
  assert.ok(clusterAt > faceAt, 'the tool cluster must follow the face button')
  const cardAt = source.indexOf("className: `dsh-sc-card ")
  assert.ok(faceAt > cardAt && clusterAt > cardAt, 'face and cluster both live in the card container')
  // A real <button> gives native Enter/Space and a native focus ring.
  assert.match(source, /className: 'dsh-sc-cardhit',\n\s+onClick: \(\) => onToggle\(skill\.name\),\n\s+'aria-pressed'/)
  assert.match(cssBlock(), /\.dsh-sc-cardhit:focus-visible/, 'the face button carries the focus ring')
  // The click target must fill the card, or clicking the face would miss.
  const hit = cssBlock().match(/\.dsh-sc-cardhit \{([^}]*)\}/)
  assert.ok(hit, 'the face button needs its own rule')
  assert.match(hit[1], /flex:1 1 auto/, 'the face button must fill the card')
  // the one accepted exception, and it must stay keyboard-operable
  assert.match(source, /function gcCatChip\(\{[^)]*interactive = true[^)]*\}\)/)
  assert.match(source, /className: 'dsh-sc-cat', role: 'button', tabIndex: 0/)
  // While the current card is settling, the chip must stay MOUNTED and only lose
  // its interaction: it shares the .gc-stats row with the ATK numbers, so
  // unmounting it reflows that row — which reads as a flicker on every switch.
  assert.match(source, /if \(!interactive\) \{\n\s+return e\('span', \{ className: 'dsh-sc-cat is-inert' \}/)
  assert.match(cssBlock(), /\.dsh-sc-cat\.is-inert \{[^}]*pointer-events:none/)
})

test('the card container keeps the identity the rest of the panel relies on', () => {
  // The 3D tilt, the gacha reveal's rect capture and the hover reveal all key
  // off the CARD container (not the face button), so it must stay the element
  // that carries data-name and the pose.
  assert.match(source, /className: `dsh-sc-card \$\{tint\}/)
  assert.match(source, /'data-name': skill\.name/)
  assert.match(source, /grid\.querySelectorAll\('\.dsh-sc-card'\)/, 'the 3D wall still tilts the card')
  assert.match(source, /closest\('\.dsh-sc-card'\)/, 'pointer routing still resolves to the card')
  assert.match(source, /querySelector\(`\.dsh-sc-card\[data-name=/)
  // Hover styling that must keep working through the face button.
  const css = cssBlock()
  assert.match(css, /\.dsh-sc-card:hover \.dsh-sc-cardtools/, 'hovering the card reveals the cluster')
  assert.match(css, /\.dsh-sc-gcard:hover \.gc-foil::before\s*\{\s*animation-play-state:running/,
    'the face must still be hovered (the foil sweep depends on it)')
})
