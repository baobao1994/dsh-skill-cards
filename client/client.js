/**
 * Browser half of dsh-skill-cards.
 *
 * Hand-written classic-script bundle (no build step): the host serves it from
 * `exports["./client"]` and expects `window.__ModuleLoader__.load` with `id`
 * equal to the package name. `react` is available via require(); JSX is replaced
 * by direct `React.createElement` calls. All CSS is inlined (see ensureStyle).
 *
 * Slots:
 *  | `shell.overlay`            | the card-grid modal + image-edit popover + toast   |
 *  | `settings.section`         | the skills manager rendered inline (no sidebar entry)|
 *  | `conversation.input.right` | composer button, below the input box, left of send  |
 *
 * The composer entry uses DSH's official `conversation.input.right` slot
 * (session-scoped list) instead of DOM probing, so it sits on the input row,
 * left of the model seat and the primary send button.
 *
 * Selecting skills and pressing "应用到本次会话" calls POST /skill-cards/introduce
 * with the selected names; the host registers them on the current session's
 * agent scope. No disk writes, so other sessions and the global catalog are
 * untouched.
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-cards',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const e = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React

    const NS = 'dsh-skill-cards'
    const API = (() => {
      // Resolve against the page base, not origin-absolute: DSH can be mounted
      // under a reverse-proxy sub-path, where a leading "/" drops the prefix and
      // the gateway 404s. Falls back to the root path when there is no document.
      try { return new URL('plugins/dsh-skill-cards', document.baseURI).pathname.replace(/\/$/, '') }
      catch { return '/plugins/dsh-skill-cards' }
    })()

    const CSS = `
/* ── design tokens ─────────────────────────────────────────────────────────
   The plugin follows the host theme through --dsw-alias-* variables, but a
   skill browser needs more than neutral surfaces: with ~95 installed skills
   and no cover art, a plain grid is an undifferentiated white wall. Each card
   therefore derives a stable accent from its own name (see tintIndex in
   client.js), so the grid reads as a recognisable mosaic and a skill keeps the
   same colour every time it is opened. */
.dsh-sc-root, .dsh-sc-composer-btn, .dsh-sc-backdrop, .dsh-sc-modal-mask {
  font-family: var(--dsw-alias-font-ui, system-ui, -apple-system, "Segoe UI", sans-serif); }

/* ── entries ─────────────────────────────────────────────────────────────── */
.dsh-sc-composer-btn { display:inline-flex; align-items:center; gap:4px; margin:0 6px; padding:4px 8px; border-radius:6px;
  cursor:pointer; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary);
  border:1px solid var(--dsw-alias-border-l1); font-size:12px; }
.dsh-sc-composer-btn:hover { background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-primary); }
.dsh-sc-fab-dot { width:6px; height:6px; border-radius:50%; flex:none;
  background:linear-gradient(135deg,var(--sc-gold-hi,#f0d48a),var(--sc-gold,#c9a24b));
  box-shadow:0 0 6px rgba(201,162,75,.6); }
.dsh-sc-composer { display:inline-flex; align-items:center; gap:6px; }
.dsh-sc-appliedchips { display:inline-flex; align-items:center; gap:4px; flex-wrap:wrap; max-width:52vw;
  animation:dshScAppear .18s ease; }
.dsh-sc-appliedlead { font-size:10.5px; color:var(--dsw-alias-label-tertiary); }
/* The composer entry sits in the HOST chrome, so it only borrows the gold
   frame accent — it must not repaint the host's own surfaces. */
.dsh-sc-composer-btn { background:rgba(201,162,75,.10); color:var(--sc-gold,#c9a24b);
  border-color:rgba(201,162,75,.34); }
.dsh-sc-composer-btn:hover { background:rgba(201,162,75,.20); color:var(--sc-gold-hi,#f0d48a); }
.dsh-sc-appliedchip { padding:2px 8px; border-radius:20px; font-size:10.5px; color:#fff; white-space:nowrap;
  background:linear-gradient(180deg,var(--sc-gold-hi,#f0d48a),var(--sc-gold,#c9a24b));
  color:#241b0a; box-shadow:0 2px 8px rgba(201,162,75,.4); }
@keyframes dshScAppear { from { opacity:0; transform:translateY(-3px); } to { opacity:1; transform:none; } }

/* ── shell tokens ────────────────────────────────────────────────────────────
   The cards are Yu-Gi-Oh style: a gold metal frame around an obsidian well.
   Every container and control in the plugin reuses that same vocabulary so the
   modal reads as "the playmat the cards sit on" rather than a generic dialog:
   obsidian surface, hairline gold double-border, gold for emphasis. */
.dsh-sc-root, .dsh-sc-composer-btn, .dsh-sc-backdrop, .dsh-sc-modal-mask,
.dsh-sc-catman, .dsh-sc-toast, .dsh-sc-panel {
  --sc-shell:#1a1a22; --sc-shell-2:#23232e; --sc-shell-3:#2e2e3c;
  --sc-gold:#c9a24b; --sc-gold-hi:#f0d48a; --sc-gold-dim:#7a5f24;
  --sc-line:rgba(201,162,75,.34); --sc-line-soft:rgba(201,162,75,.16);
  --sc-ink:#f3ead6; --sc-ink-2:#c9c2b0; --sc-ink-3:#918a7a;
  --sc-danger:#e8705a; }

/* ── shell ───────────────────────────────────────────────────────────────── */
.dsh-sc-backdrop { position:fixed; inset:0; z-index:9000;
  background:radial-gradient(120% 100% at 50% 0%, rgba(20,16,10,.62), rgba(6,6,10,.86));
  backdrop-filter:var(--dsw-mask-blur,blur(3px)) saturate(.85);
  display:flex; align-items:center; justify-content:center; padding:24px; }
.dsh-sc-modal { width:min(1040px,100%); max-height:86vh; display:flex; flex-direction:column;
  background:
    radial-gradient(140% 60% at 50% 0%, rgba(201,162,75,.10), transparent 62%),
    linear-gradient(180deg, var(--sc-shell-2), var(--sc-shell) 42%, #131319);
  color:var(--sc-ink); border-radius:16px; overflow:hidden; position:relative;
  border:1px solid var(--sc-line);
  box-shadow:0 0 0 1px rgba(0,0,0,.7), 0 0 0 3px rgba(201,162,75,.13),
    0 30px 80px rgba(0,0,0,.62), inset 0 1px 0 rgba(255,255,255,.07); }
/* Scope border-box to the plugin's own subtree — this stylesheet is injected
   globally, so a bare star selector would leak into the whole app. */
.dsh-sc-backdrop, .dsh-sc-backdrop * { box-sizing:border-box; }

/* The header is the card's name bar: gold rules top and bottom. */
.dsh-sc-head { display:flex; align-items:center; gap:10px; padding:14px 16px;
  border-bottom:1px solid var(--sc-line-soft); flex:none; position:relative; }
.dsh-sc-head::before { content:''; position:absolute; left:0; right:0; top:0; height:2px;
  background:linear-gradient(90deg, transparent, var(--sc-gold), transparent); opacity:.7; }
.dsh-sc-title { display:flex; align-items:baseline; gap:8px; flex:none; }
.dsh-sc-title-text { font-size:15px; font-weight:650; letter-spacing:.02em; color:var(--sc-ink);
  text-shadow:0 0 12px rgba(201,162,75,.25); }
.dsh-sc-title-count { font-size:11px; font-variant-numeric:tabular-nums; color:var(--sc-gold); opacity:.8;
  padding:1px 7px; border:1px solid var(--sc-line); border-radius:10px; }
.dsh-sc-search { flex:1; min-width:0; padding:7px 10px; border-radius:8px; background:rgba(0,0,0,.34);
  border:1px solid var(--sc-line-soft); color:var(--sc-ink); font-size:13px; font-family:inherit;
  transition:border-color .12s ease, box-shadow .12s ease; }
.dsh-sc-search::placeholder { color:var(--sc-ink-3); }
.dsh-sc-search:focus { outline:none; border-color:var(--sc-gold);
  box-shadow:0 0 0 2px rgba(201,162,75,.16); }
.dsh-sc-close { flex:none; cursor:pointer; border:1px solid transparent; background:transparent; color:var(--sc-ink-2);
  font-size:18px; line-height:1; padding:2px 9px; border-radius:50%;
  transition:background .12s ease, color .12s ease, border-color .12s ease; }
.dsh-sc-close:hover { background:rgba(201,162,75,.12); border-color:var(--sc-line); color:var(--sc-gold-hi); }

/* ── inline panel (settings.section) ────────────────────────────────────── */
/* The settings section renders this panel directly on the host's own surface —
   there is NO .dsh-sc-modal behind it, so the panel must carry the playmat
   background itself (it used to stay transparent and let the host's light
   settings background show through, which read as a white page next to the
   dark modal). Same gradient vocabulary as .dsh-sc-modal. */
.dsh-sc-panel { display:flex; flex-direction:column; min-height:0; flex:1 1 auto;
  height:100%; overflow:hidden;
  /* height:100% resolves to auto inside the settings section (its parent
     .dsh-sc-root has no definite height), which leaves .dsh-sc-stage with an
     auto height — and overflow-y:auto never fires on an auto-height box. The
     result was: cards grew with the content, the host's outer settings
     scrollbar was the only thing that scrolled, and the wheel over the cards
     did nothing. A vh cap gives the flex column a definite height in BOTH
     contexts, so .dsh-sc-stage becomes the real scroll container. */
  max-height:82vh;
  background:
    radial-gradient(140% 60% at 50% 0%, rgba(201,162,75,.10), transparent 62%),
    linear-gradient(180deg, var(--sc-shell-2), var(--sc-shell) 42%, #131319);
  color:var(--sc-ink);
  border:1px solid var(--sc-line); border-radius:12px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.07); }
/* Inside the modal the panel IS the modal's inner area — no extra frame. */
.dsh-sc-modal > .dsh-sc-panel { background:none; border:0; border-radius:0; box-shadow:none; }
.dsh-sc-search-row { display:flex; align-items:center; gap:10px; padding:12px 16px 0; flex:none; }
.dsh-sc-search-row .dsh-sc-search { flex:1 1 auto; }
.dsh-sc-search-row .dsh-sc-title-count { flex:none; }

.dsh-sc-toolbar { display:flex; align-items:center; gap:8px; padding:10px 16px;
  border-bottom:1px solid var(--sc-line-soft); font-size:12px;
  color:var(--sc-ink-2); flex:none; }
/* Toolbar buttons are small "pressed foil" plates, not host-theme pills. */
.dsh-sc-toolbar button { cursor:pointer; padding:5px 11px; border-radius:7px;
  background:linear-gradient(180deg, rgba(255,255,255,.05), rgba(0,0,0,.25));
  color:var(--sc-ink); border:1px solid var(--sc-line-soft); font-size:12px; font-family:inherit;
  transition:border-color .12s ease, color .12s ease, box-shadow .12s ease; }
.dsh-sc-toolbar button:hover:not(:disabled) { border-color:var(--sc-gold); color:var(--sc-gold-hi);
  box-shadow:0 0 0 1px rgba(201,162,75,.15), 0 2px 10px rgba(0,0,0,.4); }
.dsh-sc-spacer { flex:1; }
.dsh-sc-selected-count { font-variant-numeric:tabular-nums; color:var(--sc-ink-3); }
/* The one committed action: a gold plate, like the card's own frame. */
.dsh-sc-apply { cursor:pointer; padding:6px 16px; border-radius:8px; font-size:12px; font-weight:650; font-family:inherit;
  color:#241b0a !important;
  background:linear-gradient(180deg, var(--sc-gold-hi), var(--sc-gold) 55%, #a8822f) !important;
  border:1px solid rgba(255,232,178,.55) !important;
  box-shadow:0 0 14px rgba(201,162,75,.30), inset 0 1px 0 rgba(255,255,255,.5);
  transition:filter .12s ease, box-shadow .12s ease; }
.dsh-sc-apply:hover:not(:disabled) { filter:brightness(1.07); box-shadow:0 0 20px rgba(201,162,75,.5), inset 0 1px 0 rgba(255,255,255,.5); }
.dsh-sc-apply:disabled, .dsh-sc-toolbar button:disabled { opacity:.4; cursor:not-allowed; box-shadow:none; }

/* Keyboard focus, on every interactive surface, without relying on mouse state. */
.dsh-sc-composer-btn:focus-visible, .dsh-sc-close:focus-visible,
.dsh-sc-toolbar button:focus-visible, .dsh-sc-apply:focus-visible, .dsh-sc-cardhit:focus-visible,
.dsh-sc-catchip:focus-visible, .dsh-sc-imgform button:focus-visible,
.dsh-sc-catpop button:focus-visible, .dsh-sc-file-btn:focus-visible {
  outline:2px solid var(--sc-gold, #c9a24b); outline-offset:2px; }

/* ── stage (3D card wall) ───────────────────────────────────────────────── */
/* The stage owns the scroll: flex:1 + min-height:0 makes it the only scrolling
   child (a flex item defaults to min-height:auto, so without min-height:0 it
   keeps its content height, overflows the modal max-height and gets clipped).
   The WebGL canvas is absolutely layered behind the grid (pointer-events:none,
   so cards stay clickable); the grid itself keeps its own height so its cards
   can take per-card 3D transforms. */
.dsh-sc-stage { position:relative; flex:1 1 auto; min-height:0; overflow-y:auto;
  overscroll-behavior:contain; padding:16px;
  /* Wheel events over the 3D canvas/grid must scroll THIS stage, not the host's
     outer settings scroller. Without this the cards never scroll with the mouse
     and only the far-right page scrollbar moves. */
  touch-action:pan-y; }
.dsh-sc-fx { position:absolute; inset:0; width:100%; height:100%; pointer-events:none;
  z-index:0; opacity:0; transition:opacity .5s ease; }
.dsh-sc-panel.fx .dsh-sc-fx { opacity:1; }

/* 4-across grid, rows sized by the real card ratio (59:86 ≈ 1:1.458):
   every card is a true TCG rectangle and every row height matches. */
.dsh-sc-grid { position:relative; z-index:1; display:grid; gap:14px; align-content:start;
  grid-auto-rows:1fr;
  grid-template-columns:repeat(4,minmax(0,1fr)); }
.dsh-sc-grid .dsh-sc-card-wrap { aspect-ratio:59/86; }
/* PERF: the compositor layer is promoted ONLY while a card is actually moving.
   A blanket will-change:transform on ~95 cards keeps 95 texture layers alive
   for as long as the panel is open — hundreds of MB of GPU memory on a Retina
   display, and it makes scrolling the worst case. Promotion is scoped to
   .tilting / .settling (added by initCard3D only for the duration of a hover)
   and dropped the instant the card comes to rest. */
.dsh-sc-card { backface-visibility:hidden; }
.dsh-sc-card.tilting, .dsh-sc-card.settling {
  will-change:transform; transform-style:preserve-3d; }

/* Entrance: ONE keyframe on the grid container, so the stagger is a single
   compositor-driven animation instead of 95 inline transition strings that
   JS has to write and later clear (every write invalidates that card's style
   and re-evaluates its transition machinery). */
.dsh-sc-grid.enter .dsh-sc-card { animation:dshScCardIn .62s cubic-bezier(.2,.7,.2,1) both; }
/* Stagger via nth-child instead of a per-card inline animation-delay: the same
   visual wave with zero per-card React props and zero style writes. Quantised to
   24 steps so the delay table stays small, and CAPPED at 400ms so the last card
   never waits behind a long queue (the old cap, kept so the wave feels brisk). */
.dsh-sc-grid.enter .dsh-sc-card:nth-child(4n+1) { animation-delay:.02s; }
.dsh-sc-grid.enter .dsh-sc-card:nth-child(4n+2) { animation-delay:.06s; }
.dsh-sc-grid.enter .dsh-sc-card:nth-child(4n+3) { animation-delay:.10s; }
.dsh-sc-grid.enter .dsh-sc-card:nth-child(4n+4) { animation-delay:.14s; }
.dsh-sc-grid.enter .dsh-sc-card:nth-child(n+5)  { animation-delay:.18s; }
.dsh-sc-grid.enter .dsh-sc-card:nth-child(n+9)  { animation-delay:.24s; }
.dsh-sc-grid.enter .dsh-sc-card:nth-child(n+13) { animation-delay:.30s; }
.dsh-sc-grid.enter .dsh-sc-card:nth-child(n+17) { animation-delay:.36s; }
.dsh-sc-grid.enter .dsh-sc-card:nth-child(n+21) { animation-delay:.40s; }
@keyframes dshScCardIn {
  from { opacity:0; transform:perspective(900px) translateZ(-300px); }
  to   { opacity:1; transform:perspective(900px) translateZ(0); } }

/* PERF: layout containment per card. Each face is a gradient art well + a
   parchment box + a four-part inset/outset shadow stack; without containment a
   reflow triggered by one card is free to invalidate its neighbours in the same
   row. Deliberately NOT paint containment: the category popover
   (.dsh-sc-catpop) is a child of this wrapper and is meant to overflow the card
   bounds — paint containment would clip it away. Size containment is also
   unsafe: the row height comes from the cards' aspect-ratio, not their content. */
.dsh-sc-grid .dsh-sc-card-wrap { contain:layout; }

/* 扇形只变换外层，卡面、详情与业务勾选仍复用原组件。 */
/* 固定高度只给扇形：它必须拿到确定高度才能算卡位坐标。墙是内容自适应 +
   .dsh-sc-panel 自带的 max-height:82vh（否则只有 3 张卡时也会撑出 82vh 空白）。 */
.dsh-sc-panel.has-cards[data-layout="fan"] { height:82vh; }

/* ── 布局切换（墙 / 扇形）────────────────────────────────────────────────── */
.dsh-sc-layout { display:inline-flex; align-items:center; gap:2px; padding:2px;
  border-radius:9px; background:var(--sc-shell-2); border:1px solid var(--sc-line); }
.dsh-sc-layout button { cursor:pointer; font:inherit; font-size:11.5px; padding:4px 10px;
  border-radius:7px; border:1px solid transparent; background:transparent; color:var(--sc-ink-2);
  transition:color .12s ease, background .12s ease, border-color .12s ease; }
.dsh-sc-layout button:hover { color:var(--sc-gold-hi); }
.dsh-sc-layout button[aria-pressed="true"] { background:var(--sc-shell); border-color:var(--sc-gold);
  color:var(--sc-gold-hi); }
.dsh-sc-layout button:focus-visible { outline:2px solid var(--sc-gold); outline-offset:1px; }
/* 切换布局时给「当前浏览的那张卡」一个短暂描边：墙模式下用来指认它落在哪。 */
.dsh-sc-card-wrap.focus-flash { animation:dshScFocusFlash .7s ease; }
@keyframes dshScFocusFlash {
  0%, 100% { box-shadow:none; }
  25% { box-shadow:0 0 0 3px var(--sc-gold, #c9a24b); }
}
.dsh-sc-fan { position:relative; z-index:1; min-width:0; }
.dsh-sc-fan-hand { position:relative; touch-action:pan-y; isolation:isolate;
  /* 点空白翻页与拖动翻页都是直接操作：光标先给出提示，拖动时不要选中卡面文字。 */
  cursor:pointer; user-select:none; -webkit-user-select:none; }
/* 拖动期间必须关掉过渡 —— 卡牌要逐帧跟着指针走；松手后去掉 is-dragging，
   过渡在同一帧恢复，于是从指尖位置平滑吸附到最近的卡位。 */
.dsh-sc-fan-hand.is-dragging { cursor:grabbing; }
.dsh-sc-fan-hand.is-dragging .dsh-sc-fan-slot { transition:none; will-change:transform; }
.dsh-sc-fan-slot { position:absolute; left:50%; top:20px; transform-origin:50% 100%;
  transition:transform .46s cubic-bezier(.22,.8,.25,1), opacity .3s ease; }
.dsh-sc-fan-slot > .dsh-sc-card-wrap { height:100%; }
.dsh-sc-fan-slot .dsh-sc-card, .dsh-sc-fan-slot .dsh-sc-card:hover { transform:none; }
.dsh-sc-fan-slot.is-current .dsh-sc-gcard { box-shadow:0 0 0 1px var(--sc-gold), 0 12px 28px rgba(0,0,0,.5); }
.dsh-sc-fan-slot:not(.is-ready) .dsh-sc-cardtools { visibility:hidden; pointer-events:none; }
.dsh-sc-fan-nav { display:flex; justify-content:center; align-items:center; gap:16px; padding:4px 0 12px; }
.dsh-sc-fan-position { color:var(--sc-gold-hi); font-size:12px; font-variant-numeric:tabular-nums; }
.dsh-sc-fan-nav button, .dsh-sc-details-actions button { cursor:pointer; font:inherit; font-size:12px;
  color:var(--sc-ink); background:var(--sc-shell-2); border:1px solid var(--sc-line); border-radius:7px; padding:7px 12px; }
.dsh-sc-fan-nav button { min-width:44px; min-height:36px; }
.dsh-sc-fan-nav button:disabled { opacity:.35; cursor:not-allowed; }
.dsh-sc-fan-nav button:focus-visible, .dsh-sc-details-actions button:focus-visible,
.dsh-sc-fan-hand:focus-visible { outline:2px solid var(--sc-gold); outline-offset:2px; }
.dsh-sc-fan-hint { text-align:center; color:var(--sc-ink-3); font-size:11px; margin:0 0 12px; }
.dsh-sc-details { max-width:640px; margin:0 auto; padding:14px 16px;
  border:1px solid var(--sc-line-soft); border-radius:10px; background:var(--sc-shell); }
.dsh-sc-details h3 { margin:0 0 6px; font-size:16px; color:var(--sc-gold-hi); overflow-wrap:anywhere; }
.dsh-sc-details-desc { margin:0; font-size:12px; line-height:1.65; white-space:pre-wrap; overflow-wrap:anywhere;
  color:var(--sc-ink-2); user-select:text; }
.dsh-sc-details-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
.dsh-sc-details-actions button[aria-pressed=true] { border-color:var(--sc-gold); color:var(--sc-gold-hi); }
.dsh-sc-toolbar { flex-wrap:wrap; }
/* 卡组区（短窗口、长描述时会滚动）会滚动，但滚动条紧贴面板右内沿，视觉上割裂
   卡面与细节区，所以隐藏轨道、保留滚动能力：滚轮 / 触控板照常，聚焦卡组区后
   方向键、PageUp·PageDown、空格也能滚。只作用于插件自己的容器，不碰宿主设置
   页的滚动条。 */
.dsh-sc-stage { overflow-x:hidden; scrollbar-width:none; }
.dsh-sc-stage::-webkit-scrollbar { width:0; height:0; display:none; }
@media (max-width:480px) {
  .dsh-sc-backdrop { padding:8px; }
  .dsh-sc-stage { padding:10px; }
  .dsh-sc-toolbar { gap:6px; padding:8px 10px; }
  .dsh-sc-toolbar button { padding:5px 8px; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-sc-fan-slot { transition:none; }
  /* 减弱动态效果下不播脉冲，改成静态描边（JS 700ms 后照旧摘掉）。 */
  .dsh-sc-card-wrap.focus-flash { animation:none; box-shadow:0 0 0 3px var(--sc-gold, #c9a24b); }
}

/* ── card ────────────────────────────────────────────────────────────────── */
/* height:100% makes every card in a row match the tallest one, while the row
   itself stays content-sized. */
.dsh-sc-card { position:relative; height:100%; display:flex; flex-direction:column; text-align:left;
  border-radius:12px; overflow:hidden; cursor:pointer; padding:0; font:inherit; color:inherit;
  background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1);
  transition:border-color .14s ease, box-shadow .14s ease, transform .14s ease; }
.dsh-sc-card:hover { border-color:var(--dsw-alias-border-l2); box-shadow:0 6px 20px rgba(0,0,0,.13); transform:translateY(-1px); }
.dsh-sc-card.selected { border-color:var(--sc-gold,#c9a24b);
  box-shadow:0 0 0 1px var(--sc-gold,#c9a24b), 0 6px 20px rgba(201,162,75,.22); }

/* The tile is the identity plate: real cover art when the skill ships one,
   otherwise a stable colour derived from the skill name with a monogram. */
.dsh-sc-tile { position:relative; width:100%; aspect-ratio:16/10; flex:none; overflow:hidden;
  display:flex; align-items:center; justify-content:center;
  background:linear-gradient(135deg, var(--sc-a,#6366F1), var(--sc-b,#8B5CF6)); }
.dsh-sc-card-img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; }
.dsh-sc-mono { font-size:30px; font-weight:700; letter-spacing:-.03em; line-height:1;
  color:rgba(255,255,255,.92); user-select:none; }
/* A soft sheen keeps the flat gradient from looking like a swatch. */
.dsh-sc-tile::after { content:''; position:absolute; inset:0; pointer-events:none;
  background:radial-gradient(120% 90% at 80% 0%, rgba(255,255,255,.22), transparent 60%); }
.dsh-sc-card-img ~ .dsh-sc-tile-sheen { display:none; }

.dsh-sc-body { display:flex; flex-direction:column; gap:4px; padding:9px 11px 11px; flex:1 1 auto; }
.dsh-sc-name { font-size:12.5px; font-weight:650; letter-spacing:-.01em; line-height:1.25;
  color:var(--dsw-alias-label-primary); word-break:break-word;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.dsh-sc-desc { font-size:11.5px; color:var(--dsw-alias-label-secondary); line-height:1.45;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }

/* Selection mark: quiet until it matters. */
.dsh-sc-check { position:absolute; top:8px; right:8px; width:20px; height:20px; border-radius:50%;
  background:rgba(255,255,255,.92); border:1.5px solid var(--dsw-alias-border-l2);
  display:flex; align-items:center; justify-content:center; color:transparent; font-size:12px;
  line-height:1; box-shadow:0 1px 4px rgba(0,0,0,.20);
  /* 角标只是状态显示：不拦截指针，点它等同于点卡面（勾选/取消）。 */
  pointer-events:none;
  transition:background .12s ease, border-color .12s ease, color .12s ease; }
.dsh-sc-card:hover .dsh-sc-check { border-color:var(--sc-gold,#c9a24b); }
.dsh-sc-card.selected .dsh-sc-check { background:linear-gradient(180deg,var(--sc-gold-hi,#f0d48a),var(--sc-gold,#c9a24b));
  border-color:var(--sc-gold,#c9a24b); color:#241b0a; }

/* Card hover controls are laid out as one cluster — see .dsh-sc-cardtools in
   the game-card section below, which owns their shape, colour and reveal. */

/* ── states ──────────────────────────────────────────────────────────────── */
.dsh-sc-empty { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; gap:6px;
  align-items:center; justify-content:center; padding:40px; text-align:center;
  color:var(--sc-ink-2); font-size:13px; }
.dsh-sc-empty-hint { font-size:11.5px; color:var(--sc-ink-3); }
/* Scanned-root report shown when no skills were found. A path the host never
   saw is the single most useful thing to surface here: without it the hint
   text is guesswork, and on a machine whose home directory resolves
   differently the "no skills" case looks identical to a broken install. */
.dsh-sc-roots { margin-top:14px; padding-top:12px; border-top:1px solid var(--sc-line-soft);
  text-align:left; max-width:640px; margin-left:auto; margin-right:auto; }
.dsh-sc-roots-label { font-size:11px; color:var(--sc-ink-3); margin-bottom:6px; letter-spacing:.02em; }
.dsh-sc-roots ul { list-style:none; margin:0; padding:0; }
.dsh-sc-roots li { display:flex; align-items:baseline; gap:8px; padding:3px 0;
  font-size:11px; line-height:1.5; }
.dsh-sc-roots code { flex:1 1 auto; min-width:0; overflow-wrap:anywhere; word-break:break-all;
  font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
  color:var(--sc-ink-2); background:rgba(0,0,0,.28); border:1px solid var(--sc-line-soft);
  border-radius:5px; padding:1px 6px; }
.dsh-sc-roots li.missing code { color:var(--sc-ink-3); text-decoration:line-through;
  text-decoration-color:rgba(232,112,90,.55); border-style:dashed; }
.dsh-sc-roots-note { flex:none; color:var(--sc-danger); opacity:.85; }
.dsh-sc-roots li.exists .dsh-sc-roots-note { color:var(--sc-ink-3); }
.dsh-sc-err { color:var(--sc-danger); font-size:12px; padding:8px 16px 10px; flex:none;
  border-bottom:1px solid rgba(232,112,90,.25); background:rgba(232,112,90,.08); }

/* ── image form ──────────────────────────────────────────────────────────── */
.dsh-sc-modal-mask { position:fixed; inset:0; z-index:9100;
  background:radial-gradient(120% 100% at 50% 0%, rgba(20,16,10,.62), rgba(6,6,10,.86));
  backdrop-filter:blur(3px) saturate(.85);
  display:flex; align-items:center; justify-content:center; padding:24px; }
/* The dialog is a single card face: same frame, inner gold hairline. */
.dsh-sc-imgform { width:min(430px,100%);
  background:
    radial-gradient(140% 60% at 50% 0%, rgba(201,162,75,.10), transparent 62%),
    linear-gradient(180deg, var(--sc-shell-2), var(--sc-shell) 45%, #131319);
  border:1px solid var(--sc-line); border-radius:14px; padding:18px; position:relative;
  color:var(--sc-ink);
  box-shadow:0 0 0 1px rgba(0,0,0,.7), 0 0 0 3px rgba(201,162,75,.12), 0 24px 70px rgba(0,0,0,.6),
    inset 0 1px 0 rgba(255,255,255,.07); }
.dsh-sc-imgform h4 { margin:0 0 4px; font-size:14px; font-weight:650; letter-spacing:.02em;
  color:var(--sc-gold-hi); }
.dsh-sc-imgform .dsh-sc-imgform-sub { margin:0 0 12px; font-size:11.5px; color:var(--sc-ink-3);
  word-break:break-all; }
.dsh-sc-imgform label { display:block; font-size:12px; color:var(--sc-ink-2); margin:10px 0 4px; }
.dsh-sc-imgform input[type=text], .dsh-sc-imgform textarea { width:100%; box-sizing:border-box; padding:7px 9px;
  border-radius:8px; background:rgba(0,0,0,.34); color:var(--sc-ink);
  border:1px solid var(--sc-line-soft); font-size:13px; font-family:inherit; }
.dsh-sc-imgform input[type=text]::placeholder, .dsh-sc-imgform textarea::placeholder { color:var(--sc-ink-3); }
.dsh-sc-imgform input[type=text]:focus, .dsh-sc-imgform textarea:focus { outline:none;
  border-color:var(--sc-gold); box-shadow:0 0 0 2px rgba(201,162,75,.16); }
.dsh-sc-imgform textarea { resize:vertical; min-height:64px; }
.dsh-sc-imgform .row { display:flex; gap:8px; justify-content:flex-end; margin-top:16px;
  padding-top:14px; border-top:1px solid var(--sc-line-soft); }
.dsh-sc-imgform .row button { cursor:pointer; padding:7px 14px; border-radius:8px; font-size:13px; font-family:inherit;
  border:1px solid var(--sc-line-soft); background:rgba(255,255,255,.05); color:var(--sc-ink);
  transition:border-color .12s ease, color .12s ease; }
.dsh-sc-imgform .row button:hover:not(:disabled) { border-color:var(--sc-gold); color:var(--sc-gold-hi); }
.dsh-sc-imgform .row button:disabled { opacity:.4; cursor:not-allowed; }
.dsh-sc-imgform .row .dsh-sc-primary { color:#241b0a; font-weight:650;
  background:linear-gradient(180deg, var(--sc-gold-hi), var(--sc-gold) 55%, #a8822f);
  border-color:rgba(255,232,178,.55); box-shadow:0 0 14px rgba(201,162,75,.3); }
.dsh-sc-imgform .row .dsh-sc-primary:hover:not(:disabled) { color:#241b0a; filter:brightness(1.07); }
.dsh-sc-imgform .row .dsh-sc-danger { margin-right:auto; color:var(--sc-danger); border-color:rgba(232,112,90,.3); }
.dsh-sc-imgform .row .dsh-sc-danger:hover:not(:disabled) { border-color:var(--sc-danger); color:#ff9a86; }

.dsh-sc-file-row { display:flex; align-items:center; gap:8px; margin-top:10px; }
.dsh-sc-file-btn { cursor:pointer; padding:6px 12px; border-radius:7px; font-size:12px; font-family:inherit;
  background:rgba(255,255,255,.05); color:var(--sc-ink);
  border:1px solid var(--sc-line-soft); transition:border-color .12s ease, color .12s ease; }
.dsh-sc-file-btn:hover:not(:disabled) { border-color:var(--sc-gold); color:var(--sc-gold-hi); }
.dsh-sc-file-btn:disabled { opacity:.4; cursor:not-allowed; }
.dsh-sc-file-name { font-size:11.5px; color:var(--sc-ink-2); max-width:230px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

.dsh-sc-toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:9200;
  padding:10px 16px; border-radius:10px; font-size:13px; max-width:min(420px,calc(100vw - 48px));
  background:linear-gradient(180deg, var(--sc-shell-2), var(--sc-shell));
  color:var(--sc-ink); border:1px solid var(--sc-line);
  box-shadow:0 0 0 1px rgba(0,0,0,.6), 0 10px 30px rgba(0,0,0,.5); }

/* ── accent palette ──────────────────────────────────────────────────────── */
/* Twelve hues spread evenly around the wheel (every ~30°, with one warm slot
   doubled) so no two neighbours in the grid read as the same colour. Each pair
   is dark→light at a lightness that keeps white monogram text legible in both
   the light and dark host themes, because the tile paints its own gradient
   rather than sitting on a themed surface. */
.dsh-sc-t0  { --sc-a:#4F46E5; --sc-b:#818CF8 }  /* indigo   */
.dsh-sc-t1  { --sc-a:#0E7490; --sc-b:#22D3EE }  /* cyan     */
.dsh-sc-t2  { --sc-a:#15803D; --sc-b:#4ADE80 }  /* green    */
.dsh-sc-t3  { --sc-a:#A16207; --sc-b:#FACC15 }  /* amber    */
.dsh-sc-t4  { --sc-a:#C2410C; --sc-b:#FB923C }  /* orange   */
.dsh-sc-t5  { --sc-a:#BE123C; --sc-b:#FB7185 }  /* rose     */
.dsh-sc-t6  { --sc-a:#A21CAF; --sc-b:#E879F9 }  /* fuchsia  */
.dsh-sc-t7  { --sc-a:#6D28D9; --sc-b:#A78BFA }  /* violet   */
.dsh-sc-t8  { --sc-a:#0F766E; --sc-b:#2DD4BF }  /* teal     */
.dsh-sc-t9  { --sc-a:#1D4ED8; --sc-b:#60A5FA }  /* blue     */
.dsh-sc-t10 { --sc-a:#9F1239; --sc-b:#E11D48 }  /* crimson  */
.dsh-sc-t11 { --sc-a:#3F6212; --sc-b:#A3E635 }  /* lime     */

/* ── category filter row ──────────────────────────────────────────────────── */
.dsh-sc-catrow { display:flex; align-items:center; gap:6px; padding:8px 16px 2px; flex:none; flex-wrap:wrap; }
.dsh-sc-catchip { cursor:pointer; padding:4px 11px; border-radius:14px; font-size:11.5px; font-family:inherit;
  background:rgba(255,255,255,.04); color:var(--sc-ink-2); border:1px solid var(--sc-line-soft);
  transition:background .12s ease, color .12s ease, border-color .12s ease, box-shadow .12s ease; }
.dsh-sc-catchip:hover { border-color:var(--sc-line); color:var(--sc-gold-hi); }
/* Active = the frame colour itself, so the filter row echoes the card frames. */
.dsh-sc-catchip.active { color:#241b0a; font-weight:650;
  background:linear-gradient(180deg, var(--sc-gold-hi), var(--sc-gold) 60%, #a8822f);
  border-color:rgba(255,232,178,.5); box-shadow:0 0 12px rgba(201,162,75,.32); }
.dsh-sc-catchip .n { font-variant-numeric:tabular-nums; opacity:.75; margin-left:3px; font-size:10.5px; }
.dsh-sc-catrow .dsh-sc-sortsel { margin-left:auto; cursor:pointer; padding:4px 8px; border-radius:7px; font-size:11.5px; font-family:inherit;
  background:rgba(0,0,0,.3); color:var(--sc-ink-2); border:1px solid var(--sc-line-soft); }
.dsh-sc-catrow .dsh-sc-sortsel:focus { outline:none; border-color:var(--sc-gold); }
.dsh-sc-catrow .dsh-sc-sortsel option { background:#1a1a22; color:#f3ead6; }

/* ── card shell (button now wrapped so the popover can escape overflow) ──── */
.dsh-sc-card-wrap { position:relative; display:flex; flex-direction:column; height:100%; }
.dsh-sc-grid .dsh-sc-card-wrap { min-width:0; }
.dsh-sc-card-wrap .dsh-sc-card { flex:1 1 auto; min-height:0; }
.dsh-sc-card-wrap .dsh-sc-card:hover { position:relative; z-index:2; }

/* The star is one of the card's hover tools, styled with the rest of the
   cluster in the game-card section (.dsh-sc-cardtools). */


/* ── game-card (Yu-Gi-Oh style) skin ──────────────────────────────────────
   Proportions follow the real card (59×86mm ≈ 1:1.458, per the 300dpi
   697×1016 template measurements): name bar ≈6% of card height, level row
   ≈4%, art window ≈55%, description box ≈25%, ATK row ≈6%. The grid fixes
   the aspect ratio via aspect-ratio, so every card is a true TCG rectangle. */
.dsh-sc-gcard { position:relative; width:100%; height:100%; border-radius:10px;
  background:var(--gc-frame,#8a6a2f); padding:5.5% 4.5%;
  box-shadow:0 0 0 1px rgba(0,0,0,.55), 0 6px 18px rgba(0,0,0,.4),
    inset 0 1px 2px rgba(255,255,255,.3), inset 0 -2px 4px rgba(0,0,0,.35);
  display:flex; flex-direction:column; overflow:hidden;
  transition:border-color .14s ease, box-shadow .14s ease, transform .14s ease; }
.dsh-sc-gcard .gc-inner { flex:1 1 auto; min-height:0; display:flex; flex-direction:column;
  border-radius:5px; background:linear-gradient(160deg,#2a2a35,#17171f);
  border:1px solid rgba(0,0,0,.55); box-shadow:inset 0 0 0 2px rgba(255,255,255,.05);
  overflow:hidden; }
.gc-name { flex:none; display:flex; align-items:center; gap:4px; padding:4px 6px 0;
  font-size:11px; font-weight:700; letter-spacing:.02em; color:#f5ead0;
  white-space:nowrap; overflow:hidden; }
/* Level stars sit UNDER the name bar, right-aligned (≈4% of card height). */
/* Rarity plate: a small gold foil tag pinned to the right of the name bar. */
.gc-sr { flex:none; margin-left:auto; padding:0 4px; border-radius:3px;
  font-size:7.5px; font-weight:800; font-style:italic; letter-spacing:.06em; line-height:1.5;
  color:#241b0a; background:linear-gradient(150deg, #f7e3a6, #d9b357 55%, #a8822f);
  border:1px solid rgba(255,246,214,.7);
  box-shadow:0 0 6px rgba(201,162,75,.55), inset 0 1px 0 rgba(255,255,255,.6); }
.gc-level { flex:none; display:flex; align-items:center; justify-content:flex-end; gap:2px;
  padding:1px 7px; font-size:9px; color:#ffb84d; letter-spacing:.08em; }
.gc-badge { flex:none; width:13px; height:13px; border-radius:50%;
  background:radial-gradient(circle at 35% 30%, rgba(255,255,255,.5), transparent 60%), var(--gc-frame,#8a6a2f);
  border:1px solid rgba(0,0,0,.65); box-shadow:0 0 4px var(--gc-glow,rgba(138,106,47,.55)); }
/* The art window: ≈55% of the card — the dominant region, like the real card. */
.gc-art { flex:none; position:relative; margin:1px 5px; flex:0 0 55%; min-height:0; border-radius:4px;
  border:2px solid var(--gc-art-edge,#292018); overflow:hidden;
  background:var(--gc-art,#34406b);
  display:flex; align-items:center; justify-content:center; }
.gc-art img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
.gc-art .gc-glyph { font-size:44px; user-select:none;
  /* Bright mix of the frame colour: a mid-tone like frame 70%+white still
     drowns in the near-black art gradient, so pull toward white and add a
     themed glow for legibility. */
  color:var(--gc-glyph,#cfe0f5);
  }
.gc-art::after { content:''; position:absolute; inset:0; pointer-events:none;
  background:radial-gradient(circle at 70% 18%, rgba(255,255,255,.16), transparent 55%); }
/* Description box: fixed at 25% of card height (like the printed card), so the
   ATK row always sits at the bottom — a short description must never let the
   category/uses row ride up. The inner span carries the 6-line clamp with an
   ellipsis: the outer box has a FIXED height taller than the clamped text, so
   the clamp must live on a child that sizes to its own lines. */
.gc-desc { flex:0 0 auto; height:25%; min-height:0; margin:2px 5px; border-radius:4px;
  background:linear-gradient(170deg, var(--gc-paper,#e8e0c8), var(--gc-paper-shade,#d6ccae));
  border:1px solid var(--gc-paper-edge,#9a8a5a);
  padding:3px 5px; font-size:8.5px; line-height:1.4; color:var(--gc-ink,#3a3020); overflow:hidden; }
.gc-desc .gc-desc-text { display:-webkit-box; -webkit-line-clamp:6; -webkit-box-orient:vertical;
  overflow:hidden; }
.gc-desc b { color:var(--gc-ink-strong,#6b4a10); }
.gc-stats { flex:none; display:flex; align-items:center; justify-content:space-between; gap:4px;
  padding:3px 7px 5px; font-size:9px; }
.gc-stats .gc-cat { color:rgba(224,213,184,.7); letter-spacing:.06em; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.gc-stats .dsh-sc-cat { font-size:9.5px; padding:1px 6px; }
.gc-stats .gc-nums { flex:none; font-family:var(--dsw-alias-font-mono,ui-monospace,Menlo,monospace);
  font-weight:700; color:#f0e6c8; letter-spacing:.04em; }
.gc-stats .gc-nums span { color:#e8c76a; }

/* ── foil sweep (light-bar translation: both endpoints sit fully outside the
   card, so the loop seam is invisible) ─────────────────────────────────── */
.dsh-sc-gcard .gc-foil { position:absolute; inset:0; z-index:5; pointer-events:none;
  overflow:hidden; border-radius:10px; opacity:0; transition:opacity .3s; }
.dsh-sc-gcard .gc-foil::before { content:''; position:absolute; top:-20%; bottom:-20%;
  width:45%; left:-60%; transform:skewX(-20deg);
  background:linear-gradient(90deg, transparent 0%, rgba(255,255,255,.5) 30%,
    rgba(160,220,255,.45) 50%, rgba(255,190,120,.45) 70%, transparent 100%);
  mix-blend-mode:screen;
  animation:dshScFoilSweep 2.4s linear infinite; }
  /* PERF: the sweep is paused at rest, not merely transparent. animation-play-state
   is the only switch that stops the compositor from ticking a 2.4s loop — a
   display:none / visibility toggle would reflow the card and kill the fade-in.
   With ~95 cards each running its own infinite keyframe, the resting grid was
   asking the compositor for ~95 animations a second for an effect nobody can
   see (the foil is opacity:0 until hover). Only the hovered card animates. */
.dsh-sc-gcard .gc-foil::before { animation-play-state:paused; }
.dsh-sc-gcard:hover .gc-foil::before { animation-play-state:running; }
@keyframes dshScFoilSweep {
  from { transform:translateX(0) skewX(-20deg); }
  to   { transform:translateX(340%) skewX(-20deg); } }
/* Foil sweep is HOVER-ONLY for every card (a permanently sweeping card read
   as "moving without being touched"). An SR card is distinguished by a static
   golden halo + warm frame glow instead — visible at rest, animated on hover. */
.dsh-sc-gcard:hover .gc-foil { opacity:1; }
.dsh-sc-gcard.sr { box-shadow:0 0 0 1px rgba(0,0,0,.55), 0 6px 18px rgba(0,0,0,.4),
  0 0 14px rgba(201,162,75,.22), inset 0 1px 2px rgba(255,255,255,.3), inset 0 -2px 4px rgba(0,0,0,.35); }
.dsh-sc-gcard.sr:hover { box-shadow:0 0 0 1px rgba(0,0,0,.55), 0 6px 18px rgba(0,0,0,.4),
  0 0 22px rgba(201,162,75,.45), inset 0 1px 2px rgba(255,255,255,.3), inset 0 -2px 4px rgba(0,0,0,.35); }

/* The selection tick keeps its own corner and stays above the tool cluster:
   the cluster is later in the DOM, and a selected card must never have its
   state mark covered by a hover control. */
/* The selection target: a real <button> wrapping the card FACE only, so the
   tick and the tool cluster can be SIBLINGS of it rather than nested inside it
   (a button inside a button is invalid HTML, and the same nesting under
   role="button" would have made the tools presentational for assistive tech).
   It fills the card so a click anywhere on the face selects the card, and it
   keeps the face hovered — which is what still drives .dsh-sc-gcard:hover
   (foil sweep, SR glow). */
.dsh-sc-cardhit { flex:1 1 auto; min-height:0; width:100%; display:flex; flex-direction:column;
  padding:0; border:0; background:transparent; color:inherit; font:inherit;
  text-align:left; cursor:pointer; overflow:visible; }

.dsh-sc-card .dsh-sc-check { z-index:7; }

/* ── card tool cluster (a card's hover controls, top-left) ────────────────
   Every hover control on a card lives in ONE flex row in the top-left corner
   and wraps when the column is narrow. Per-button absolute offsets could not
   survive the grid's width range: a card measured 237px in a wide modal and
   192px on a narrow window, and at the narrow end the sixth hand-placed button
   either ran past the card's own overflow:hidden or landed on top of an
   existing one — hit-testing caught both. A wrapping row keeps the same order
   at every width and never hides a control.
   Order groups like with like, most-used first:
     ★ 常用 (state) → 译 / ↺ 中文化 (its text) → 原 原文 → 🎨 卡图 → 自定义 封面
   The cluster stops short of the selection tick in the opposite corner, and it
   keeps pointer-events OFF itself: the row spans the title bar, so clicking
   anywhere else on the card must still select the card.
   One opacity rule on the container replaces the six per-button reveal rules. */
.dsh-sc-card .dsh-sc-cardtools { position:absolute; top:6px; left:6px; right:34px; z-index:6;
  display:flex; flex-wrap:wrap; align-items:center; gap:4px;
  opacity:0; transition:opacity .12s ease; pointer-events:none; }
.dsh-sc-card:hover .dsh-sc-cardtools,
.dsh-sc-cardtools:focus-within { opacity:1; }
.dsh-sc-cardtools > * { flex:none; pointer-events:auto; }
/* Shared shape: a 22px dark coin, tinted per tool. */
.dsh-sc-cardtools > button { width:22px; height:22px; padding:0; border-radius:50%; cursor:pointer;
  background:rgba(17,20,26,.58); color:#fff; border:1px solid rgba(255,255,255,.25);
  display:flex; align-items:center; justify-content:center; font-family:inherit;
  font-size:11px; line-height:1; transition:background .12s ease, border-color .12s ease; }
.dsh-sc-cardtools > button:hover { background:rgba(17,20,26,.88); border-color:rgba(255,255,255,.55); }
.dsh-sc-cardtools > button:focus-visible { outline:1px solid var(--dsw-alias-border-l2); outline-offset:1px; }
.dsh-sc-cardtools .dsh-sc-star { font-size:13px; }
.dsh-sc-cardtools .dsh-sc-star[aria-pressed="true"] { color:#FFD166; border-color:#FFD166; }
.dsh-sc-cardtools .dsh-sc-trans { color:#7fd4ff; }
.dsh-sc-cardtools .dsh-sc-trans-reset { color:#f0a8a8; }
.dsh-sc-card.i18n-done .dsh-sc-trans { color:#7fe0a8; }
.dsh-sc-cardtools .dsh-sc-srcbtn { color:#d9c8ff; }
.dsh-sc-cardtools .dsh-sc-srcbtn[aria-expanded="true"] { background:rgba(17,20,26,.88); border-color:#d9c8ff; }
.dsh-sc-cardtools .dsh-sc-artbtn { color:#ffd88a; }
/* "自定义" is the one LABELLED control — a pill rather than a glyph, so it reads
   as the entry to the card editor instead of another icon. */
.dsh-sc-cardtools .dsh-sc-setimg { width:auto; display:inline-flex; align-items:center; height:22px; padding:0 9px;
  border-radius:11px; white-space:nowrap; cursor:pointer; color:#fff;
  background:rgba(17,20,26,.58); border:1px solid rgba(255,255,255,.25);
  font-size:10px; line-height:1; transition:background .12s ease, border-color .12s ease; }
.dsh-sc-cardtools .dsh-sc-setimg:hover { background:rgba(17,20,26,.88); border-color:rgba(255,255,255,.55); }
.dsh-sc-cardtools .dsh-sc-setimg:focus-visible { outline:1px solid var(--dsw-alias-border-l2); outline-offset:1px; }

/* ── gacha reveal (card-back fly-in → staggered flip → SR flash) ────────── */
.dsh-sc-gacha { position:fixed; inset:0; z-index:9250; pointer-events:auto;
  background:rgba(6,6,10,.78); backdrop-filter:blur(3px); }
.dsh-sc-gacha-row { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  display:flex; gap:30px; flex-wrap:wrap; justify-content:center; max-width:94vw; }
/* Card size scales with the hand: a single reveal is imposing (300×438, real
   card ratio), multi-draws step down so the row always fits. */
.dsh-sc-gacha-slot { width:268px; height:392px; perspective:1300px; position:relative; }
.dsh-sc-gacha-row[data-count="1"] .dsh-sc-gacha-slot { width:318px; height:466px; }
.dsh-sc-gacha-row[data-count="2"] .dsh-sc-gacha-slot { width:280px; height:410px; }
.dsh-sc-gacha-row[data-count="3"] .dsh-sc-gacha-slot { width:250px; height:366px; }
.dsh-sc-gacha-row[data-count="4"] .dsh-sc-gacha-slot { width:232px; height:340px; }
.dsh-sc-gacha-row[data-count="5"] .dsh-sc-gacha-slot,
.dsh-sc-gacha-row[data-count="6"] .dsh-sc-gacha-slot { width:212px; height:310px; }
.dsh-sc-gacha-flip { width:100%; height:100%; position:relative; transform-style:preserve-3d;
  transition:transform .75s cubic-bezier(.35,.1,.22,1); }
.dsh-sc-gacha-slot.flipped .dsh-sc-gacha-flip { transform:rotateY(180deg); }
.dsh-sc-gacha-face { position:absolute; inset:0; backface-visibility:hidden; -webkit-backface-visibility:hidden; }
.dsh-sc-gacha-face.front { transform:rotateY(180deg); }
/* Card back: a real engraved-filigree texture (vendor/card-back.jpg, grayscale
   gold) tinted by the category theme. Layers, bottom-up:
   1. the texture (cover, fills the face)
   2. a theme-coloured linear wash with multiply blending (colours the gold)
   3. a radial light at the medallion so the centre reads
   Border, sigil ring and glow stay CSS/theme-driven. The texture URL is
   resolved against the page base like every other plugin asset. */
.dsh-sc-gacha-face .gc-backface { width:100%; height:100%;
  box-sizing:border-box; border-radius:12px;
  border:7px solid var(--gc-frame,#8a6a2f);
  box-shadow:inset 0 0 0 2px var(--gc-inset-ring,rgba(138,106,47,.55)),
    inset 0 0 28px rgba(0,0,0,.55), 0 6px 22px rgba(0,0,0,.5);
  display:flex; align-items:center; justify-content:center; position:relative; overflow:hidden;
  background-color:var(--gc-dark,#5c4418); }
/* The engraved texture layer: bottom of the stack, plain cover fill. */
/* The engraved texture as a real <img> with object-fit:cover — a decades-old
   mechanism that depends on none of the things that kept failing here: inset
   shorthand, background-size with a var() url(), blend modes, or compositor
   stacking inside the preserve-3d flip. The tint is a sibling layer above. */
.dsh-sc-gacha-face .gc-backface .gc-back-img { position:absolute; left:0; top:0;
  width:100%; height:100%; object-fit:cover; object-position:center center;
  display:block; user-select:none; -webkit-user-drag:none; }
/* The theme tint: translucent gradient layers painted OVER the texture with
   regular alpha compositing. --gc-tint-hi/lo are pre-computed rgba strings. */
.dsh-sc-gacha-face .gc-backface .gc-back-tint { position:absolute; left:0; top:0;
  width:100%; height:100%;
  background-image:
    radial-gradient(circle at 50% 42%, rgba(255,255,255,.08) 0%, rgba(0,0,0,.28) 80%),
    linear-gradient(160deg, var(--gc-tint-hi,rgba(36,86,160,.28)) 0%, var(--gc-tint-lo,rgba(10,14,26,.38)) 100%); }
.dsh-sc-gacha-face .gc-backface::before { content:''; position:absolute; left:10px; top:10px;
  right:10px; bottom:10px; border-radius:50%;
  border:2px solid var(--gc-sigil,#cfe0f5);
  box-shadow:0 0 16px var(--gc-sigil-glow,rgba(138,106,47,.55)),
    inset 0 0 12px var(--gc-sigil-soft,rgba(138,106,47,.3)); }
.dsh-sc-gacha-face .gc-backface::after { content:'✦'; font-size:42px;
  color:var(--gc-star,#e8eeff);
}
.dsh-sc-gacha-slot.enter { animation:dshScGachaEnter .45s cubic-bezier(.2,.8,.3,1.15) both; }
@keyframes dshScGachaEnter { from { opacity:0; transform:translateY(54px) rotate(7deg) scale(.82); }
  to { opacity:1; transform:none; } }
.dsh-sc-gacha-slot.flash::after { content:''; position:absolute; inset:-18px; z-index:9;
  pointer-events:none; border-radius:16px;
  background:radial-gradient(circle, rgba(255,240,190,.95), rgba(160,220,255,.45) 45%, transparent 70%);
  animation:dshScGachaFlash 1s ease-out forwards; }
@keyframes dshScGachaFlash { from { opacity:1; transform:scale(.55); } to { opacity:0; transform:scale(1.5); } }
.dsh-sc-gacha-skip { position:absolute; bottom:26px; left:50%; transform:translateX(-50%);
  font-size:11.5px; color:rgba(255,255,255,.55); }

/* 4-across grid steps down on narrow containers so cards never get too small
   to read (the settings panel can be much narrower than the modal). */
@media (max-width: 860px) {
  .dsh-sc-grid { grid-template-columns:repeat(3,minmax(0,1fr)); } }
@media (max-width: 640px) {
  .dsh-sc-grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }

@media (prefers-reduced-motion: reduce) {
  .dsh-sc-gcard:hover .gc-foil { opacity:.22; }
  .dsh-sc-gcard:hover .gc-foil::before, .dsh-sc-gcard.sr .gc-foil::before { animation:none; left:30%; }
  .dsh-sc-gacha-slot.enter { animation:none; }
  .dsh-sc-gacha-flip { transition:none; }
  .dsh-sc-gacha-slot.flash::after { animation:none; opacity:0; }
  /* The grid entrance is normally not even rendered under reduced motion, but
     the media query is the authority: if the class ever renders, no card may
     fly in from translateZ(-300px). */
  .dsh-sc-grid.enter .dsh-sc-card { animation:none; }
}

/* ── card meta row (category badge left + uses badge right) ──────────────── */
.dsh-sc-meta { display:flex; align-items:center; justify-content:space-between; gap:6px;
  margin-top:auto; padding-top:7px; }
.dsh-sc-uses { flex:none; padding:1px 7px; border-radius:8px; font-size:10px;
  font-variant-numeric:tabular-nums; letter-spacing:.02em;
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary);
  font-family:var(--dsw-alias-font-mono,ui-monospace,Menlo,monospace); }
.dsh-sc-cat { cursor:pointer; padding:2px 9px; border-radius:6px; font-size:11px; font-family:inherit;
  background:rgba(255,255,255,.05); color:var(--sc-ink-2); border:1px solid var(--sc-line-soft);
  transition:border-color .12s ease, color .12s ease; }
.dsh-sc-cat:hover { border-color:var(--sc-line); color:var(--sc-gold-hi); }
/* 切牌过渡中的当前卡：同一个盒子，只是不可交互（别给手型，别吃指针）。 */
.dsh-sc-cat.is-inert { cursor:inherit; pointer-events:none; }
.dsh-sc-managecats { cursor:pointer; padding:6px 12px; border-radius:8px; font-size:11.5px; font-family:inherit;
  background:transparent; color:var(--sc-ink-2); border:1px dashed var(--sc-line); }
.dsh-sc-managecats:hover { color:var(--sc-gold-hi); border-color:var(--sc-gold);
  background:rgba(201,162,75,.08); }

/* ── category manager dialog ──────────────────────────────────────────────── */
.dsh-sc-catman.modal-mask { position:fixed; inset:0; z-index:9400;
  background:radial-gradient(120% 100% at 50% 0%, rgba(20,16,10,.62), rgba(6,6,10,.86));
  backdrop-filter:blur(3px) saturate(.85);
  display:flex; align-items:center; justify-content:center; padding:24px; }
.dsh-sc-catman-box { width:min(420px,100%); max-height:80vh; overflow:auto; position:relative;
  background:
    radial-gradient(140% 60% at 50% 0%, rgba(201,162,75,.10), transparent 62%),
    linear-gradient(180deg, var(--sc-shell-2), var(--sc-shell) 45%, #131319);
  border:1px solid var(--sc-line); border-radius:14px; padding:16px;
  color:var(--sc-ink);
  box-shadow:0 0 0 1px rgba(0,0,0,.7), 0 0 0 3px rgba(201,162,75,.12), 0 24px 70px rgba(0,0,0,.6),
    inset 0 1px 0 rgba(255,255,255,.07); }
.dsh-sc-catman-box::before { content:''; position:absolute; left:0; right:0; top:0; height:2px;
  background:linear-gradient(90deg, transparent, var(--sc-gold), transparent); opacity:.7; }
.dsh-sc-catman-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
.dsh-sc-catman-head strong { font-size:14px; font-weight:650; letter-spacing:.02em; color:var(--sc-gold-hi); }
.dsh-sc-catman-head .dsh-sc-close { background:none; border:1px solid transparent; cursor:pointer; font-size:18px;
  color:var(--sc-ink-2); line-height:1; padding:2px 9px; border-radius:50%; }
.dsh-sc-catman-head .dsh-sc-close:hover { background:rgba(201,162,75,.12); border-color:var(--sc-line); color:var(--sc-gold-hi); }
.dsh-sc-catman-add { display:flex; gap:8px; margin-bottom:8px; }
.dsh-sc-catman-add input { flex:1; min-width:0; padding:7px 9px; border-radius:8px; font-size:13px; font-family:inherit;
  background:rgba(0,0,0,.34); color:var(--sc-ink); border:1px solid var(--sc-line-soft); }
.dsh-sc-catman-add input:focus { outline:none; border-color:var(--sc-gold); }
.dsh-sc-catman-add button, .dsh-sc-catman-rename button { cursor:pointer; padding:7px 12px; border-radius:8px; font-size:12px;
  font-family:inherit; border:1px solid var(--sc-line-soft); background:rgba(255,255,255,.05);
  color:var(--sc-ink); transition:border-color .12s ease, color .12s ease; }
.dsh-sc-catman-add button:hover:not(:disabled), .dsh-sc-catman-rename button:hover:not(:disabled) {
  border-color:var(--sc-gold); color:var(--sc-gold-hi); }
.dsh-sc-catman-add .dsh-sc-primary, .dsh-sc-catman-rename .dsh-sc-primary { color:#241b0a; font-weight:650;
  background:linear-gradient(180deg, var(--sc-gold-hi), var(--sc-gold) 60%, #a8822f);
  border-color:rgba(255,232,178,.5); box-shadow:0 0 12px rgba(201,162,75,.3); }
.dsh-sc-catman-add .dsh-sc-primary:hover:not(:disabled), .dsh-sc-catman-rename .dsh-sc-primary:hover:not(:disabled) {
  color:#241b0a; filter:brightness(1.07); }
.dsh-sc-catman-note { font-size:11px; color:var(--sc-ink-3); margin-bottom:10px; }
.dsh-sc-catman-list { display:flex; flex-direction:column; gap:4px; }
.dsh-sc-catman-item { padding:6px 8px; border-radius:8px; background:rgba(255,255,255,.04);
  border:1px solid var(--sc-line-soft); }
.dsh-sc-catman-row { display:flex; align-items:center; gap:8px; }
.dsh-sc-catman-id { font-size:10.5px; color:var(--sc-ink-3);
  font-family:var(--dsw-alias-font-mono,ui-monospace,Menlo,monospace); }
.dsh-sc-catman-label { flex:1; font-size:13px; }
.dsh-sc-catman-badge { font-size:10px; color:var(--sc-gold); background:rgba(201,162,75,.10);
  padding:1px 6px; border-radius:6px; border:1px solid var(--sc-line-soft); }
.dsh-sc-catman-row button { background:none; border:none; cursor:pointer; font-size:13px;
  color:var(--sc-ink-2); padding:2px 4px; }
.dsh-sc-catman-row button:hover { color:var(--sc-gold-hi); }
.dsh-sc-catman-rename { display:flex; gap:6px; align-items:center; }
.dsh-sc-catman-rename input { flex:1; min-width:0; padding:6px 8px; border-radius:6px; font-size:12px; font-family:inherit;
  background:rgba(0,0,0,.34); color:var(--sc-ink); border:1px solid var(--sc-line-soft); }
.dsh-sc-catman-rename input:focus { outline:none; border-color:var(--sc-gold); }

/* ── anchored popovers (category picker / original text) ──────────────────
   Both are absolutely positioned inside .dsh-sc-card-wrap, which caused two
   usability bugs on a full wall:
   1. COVERED — .dsh-sc-card-wrap carries contain:layout, so every card is
      its own paint layer. A menu opened from a card therefore sat UNDER the
      cards that follow it in source order: the next row painted straight over
      it. Opening a popover now raises that one wrapper above its siblings,
      which lifts the whole card — popover included.
   2. UNREACHABLE — the stage (.dsh-sc-stage) is the scroll container, so it
      clips its overflow: a menu listing every category ran past the stage's
      bottom edge on the lower rows and the tail of the list could never be
      clicked. The panel now caps its own height and scrolls internally, and
      client.js gives it an inline top/left positioned inside the stage (see
      popoverPlacement). The top:100% / left:0 below are only the fallback used
      when no stage can be measured, and .up then carries nothing but the
      direction the open animation comes from. */
.dsh-sc-card-wrap.pop-open { z-index:70; }
.dsh-sc-catpop, .dsh-sc-srcpop { position:absolute; z-index:70; top:100%; left:0;
  overflow-y:auto; overscroll-behavior:contain;
  background:linear-gradient(180deg, var(--sc-shell-3), var(--sc-shell)); border:1px solid var(--sc-line);
  border-radius:10px;
  box-shadow:0 0 0 1px rgba(0,0,0,.6), 0 12px 34px rgba(0,0,0,.55);
  animation:dshScPopDown .14s ease; }
.dsh-sc-catpop.up, .dsh-sc-srcpop.up { animation:dshScPopUp .14s ease; }
@keyframes dshScPopDown { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }
@keyframes dshScPopUp { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }

.dsh-sc-catpop { padding:6px; display:flex; flex-direction:column; gap:2px; }
.dsh-sc-catpop button { text-align:left; cursor:pointer; padding:6px 10px; border:none; background:transparent;
  color:var(--sc-ink); font-size:12.5px; font-family:inherit; border-radius:6px; }
.dsh-sc-catpop button:hover { background:rgba(201,162,75,.14); color:var(--sc-gold-hi); }
.dsh-sc-catpop button.active { color:var(--sc-gold); font-weight:650; }
.dsh-sc-catpop button.clear { color:var(--sc-danger); border-top:1px solid var(--sc-line-soft); margin-top:4px; }
.dsh-sc-catpop button.clear:hover { background:rgba(232,112,90,.14); color:#ff9a86; }

/* ── original-text panel (the skill's own name / description) ─────────────
   The card face shows the Chinese overlay once a card has been translated, and
   it clamps the description to six card-sized lines either way — so the text
   the skill was actually installed with becomes unreadable. This panel is the
   plain, selectable copy of it. */
.dsh-sc-srcpop { padding:10px 12px; color:var(--sc-ink); }
.dsh-sc-srcpop-title { font-size:11px; letter-spacing:.08em; color:var(--sc-gold); margin-bottom:6px; }
.dsh-sc-srcpop-label { font-size:10.5px; color:var(--sc-ink-3); margin:9px 0 3px; }
.dsh-sc-srcpop-name { font-size:12.5px; font-weight:650; color:var(--sc-gold-hi); word-break:break-word;
  font-family:var(--dsw-alias-font-mono,ui-monospace,Menlo,monospace); }
.dsh-sc-srcpop-desc { font-size:12px; line-height:1.55; word-break:break-word; white-space:pre-wrap;
  user-select:text; }
.dsh-sc-srcpop-desc.empty { color:var(--sc-ink-3); font-style:italic; }
.dsh-sc-srcpop-meta { margin-top:10px; padding-top:8px; border-top:1px solid var(--sc-line-soft);
  font-size:10px; color:var(--sc-ink-3); word-break:break-all; }

/* composer chips: skills already applied to the active session.
   Collapsed by default (a count pill) so the composer row never grows; the
   full chip list opens in an anchored popover. */
.dsh-sc-applied { position:relative; display:inline-flex; align-items:center; margin:0 4px; }
.dsh-sc-applied-toggle { display:inline-flex; align-items:center; gap:5px; padding:3px 10px; border-radius:999px;
  font-size:11.5px; line-height:1.2; cursor:pointer; user-select:none;
  color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-3);
  border:1px solid var(--dsw-alias-border-l1); font-family:inherit; }
.dsh-sc-applied-toggle:hover { border-color:var(--dsw-alias-border-l2); }
.dsh-sc-applied-count { min-width:15px; height:15px; padding:0 4px; border-radius:999px; font-size:10px;
  display:inline-flex; align-items:center; justify-content:center; color:#fff;
  background:linear-gradient(135deg,#6366F1,#8B5CF6); font-weight:600; }
.dsh-sc-applied-caret { font-size:9px; color:var(--dsw-alias-label-tertiary); transition:transform .16s ease; }
.dsh-sc-applied.open .dsh-sc-applied-caret { transform:rotate(180deg); }
.dsh-sc-chip-pop { position:absolute; bottom:calc(100% + 8px); left:0; z-index:9300; min-width:220px; max-width:320px;
  max-height:260px; overflow-y:auto; padding:8px; border-radius:10px;
  background:var(--dsw-alias-bg-layer-3); border:1px solid var(--dsw-alias-border-l2);
  box-shadow:0 10px 30px rgba(0,0,0,.22);
  animation:dshScPopIn .18s cubic-bezier(.2,.9,.3,1.15); transform-origin:bottom left; }
@keyframes dshScPopIn { from { opacity:0; transform:translateY(5px) scale(.96); } to { opacity:1; transform:none; } }
.dsh-sc-chip-pop-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:0 2px 6px; }
.dsh-sc-chip-pop-head span { font-size:11px; color:var(--dsw-alias-label-tertiary); }
.dsh-sc-chip-clear { border:none; background:none; cursor:pointer; font-size:11px; font-family:inherit; padding:2px 6px;
  border-radius:6px; color:var(--dsw-alias-state-error-primary,#e5484d); }
.dsh-sc-chip-clear:hover { background:rgba(229,72,77,.12); }
.dsh-sc-chip-clear:disabled { opacity:.45; cursor:default; }
.dsh-sc-chip-pop-list { display:flex; flex-direction:column; gap:2px; }
.dsh-sc-chip { display:inline-flex; align-items:center; gap:5px; padding:3px 4px 3px 8px; border-radius:999px;
  font-size:11.5px; line-height:1.2; max-width:170px; cursor:default; user-select:none;
  color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-3);
  border:1px solid var(--dsw-alias-border-l1);
  animation:dshScChipIn .3s cubic-bezier(.2,.9,.3,1.2); }
.dsh-sc-chip-row { display:inline-flex; max-width:none; width:100%; justify-content:space-between;
  background:transparent; border:none; border-radius:8px; padding:2px; }
.dsh-sc-chip-row:hover { background:var(--dsw-alias-bg-layer-4, rgba(128,128,128,.12)); }
.dsh-sc-chip-dot { width:8px; height:8px; border-radius:50%; flex:none;
  background:var(--chip-ca,#6366F1); box-shadow:0 0 6px var(--chip-ca,#6366F1); }
.dsh-sc-chip-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-sc-chip-x { flex:none; width:16px; height:16px; display:flex; align-items:center; justify-content:center;
  border:none; border-radius:50%; cursor:pointer; font-size:11px; line-height:1; padding:0;
  color:var(--dsw-alias-label-tertiary); background:transparent; }
.dsh-sc-chip-x:hover { color:#fff; background:rgba(229,72,77,.85); }
.dsh-sc-chip-x:focus-visible { outline:1px solid var(--dsw-alias-border-l2); }
.dsh-sc-chip.out { animation:dshScChipOut .28s ease forwards; pointer-events:none; }
@keyframes dshScChipIn { from { opacity:0; transform:translateX(8px) scale(.8); } to { opacity:1; transform:none; } }
@keyframes dshScChipOut { to { opacity:0; transform:scale(.6); filter:blur(3px); } }
.dsh-sc-applied-label { font-size:11px; color:var(--dsw-alias-label-tertiary); }
`
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-skill-cards-style')) return
      const style = document.createElement('style')
      style.id = 'dsh-skill-cards-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /* ------------------------------------------------------------------ *
     * Strings
     * ------------------------------------------------------------------ */
    const STRINGS = {
      zh: {
        nav: '技能', title: '技能卡片', search: '搜索技能名称或描述…',
        loading: '正在读取本机技能…',
        empty: '还没有已安装的技能。',
        emptyHint: '把技能放进 ~/.agents/skills（或 ~/.dsh/skills）后刷新。技能放在别处？设置 DSH_SKILL_CARDS_ROOTS 环境变量指向它。',
        scannedRoots: '本次扫描的目录：',
        rootMissing: '不存在',
        rootEmpty: '无有效技能 · ',
        noMatch: '没有匹配的技能。',
        noMatchHint: '换个关键词，或清空搜索框看全部。',
        selectAll: '全选', clear: '清空', selected: '已选', noneSelected: '未选择',
        previousCard: '上一张', nextCard: '下一张', browseCards: '浏览技能卡牌',
        fanHint: '拖动卡牌左右滑动 · 点两侧空白翻一张 · 点中央卡勾选 · 侧牌居中 · 方向键可用',
        layoutGroup: '布局', layoutWall: '墙', layoutFan: '扇形',
        selectCard: '勾选技能', deselectCard: '取消勾选', favoriteCard: '设为常用', unfavoriteCard: '取消常用',
        apply: '应用到本次会话', applying: '正在应用…',
        setImage: '自定义', imgTitle: '标题', imgDesc: '描述', imageUrl: '图片 URL（可选）',
        imageHint: '本地选图或粘贴 http(s) 图片链接。留空则用自动配色。',
        chooseFile: '选择本地图片', removeFile: '移除所选图片',
        uploadUnsupported: '不支持该图片类型',
        save: '保存', cancel: '取消', clearImage: '清除图片', close: '关闭',
        toastApplied: '已应用到本次会话', toastAppliedSome: '部分技能应用成功',
        toastFail: '应用失败：', noSession: '无法确认当前会话，请先打开一个会话再试。', composing: '保存',
        // categories / stats
        filterAll: '全部', filterStarred: '常用', setCategory: '设置分类', clearCategory: '清除分类',
        usesCount: '{n} 次', theseSkills: '已选技能', catEditorTitle: '分类', noCategory: '未分类',
        sortDefault: '默认', sortByUses: '按使用次数', showAll: '全部', collapsedHint: '展开', sortLabel: '排序 / 筛选',
        manageCats: '分类管理', addCat: '新增分类', catPlaceholder: '分类名称', builtinCatNote: '智能分类由系统生成，不可编辑',
        renameCat: '重命名', deleteCat: '删除', saveCat: '保存', catNameLabel: '名称', builtinLabel: '内置',
        appliedTo: '已应用到本次会话：',
        revoke: '移除该技能', revokeFail: '移除失败：', appliedNone: '本会话未应用技能',
        revokeAll: '全部移除',
        // original text of the skill (the card face may be translated/clamped)
        origTitle: '原始信息', origName: '原始技能名', origDesc: '原始描述',
        origNoDesc: '（这个技能没有写描述）', origFrom: '来源：',
      },
      en: {
        nav: 'Skills', title: 'Skill Cards', search: 'Search skill name or description…',
        loading: 'Reading local skills…',
        empty: 'No skills installed yet.',
        emptyHint: 'Drop skills into ~/.agents/skills (or ~/.dsh/skills) and refresh. Elsewhere? Point DSH_SKILL_CARDS_ROOTS at it.',
        scannedRoots: 'Directories scanned:',
        rootMissing: 'not found',
        rootEmpty: 'no valid skills · ',
        noMatch: 'No skills match that search.',
        noMatchHint: 'Try another keyword, or clear the box to see everything.',
        selectAll: 'Select all', clear: 'Clear', selected: 'Selected', noneSelected: 'None selected',
        previousCard: 'Previous card', nextCard: 'Next card', browseCards: 'Browse skill cards',
        fanHint: 'Drag the cards or click the sides to browse · Click the center to select · Arrow keys work',
        layoutGroup: 'Layout', layoutWall: 'Wall', layoutFan: 'Fan',
        selectCard: 'Select skill', deselectCard: 'Deselect skill', favoriteCard: 'Favorite', unfavoriteCard: 'Unfavorite',
        apply: 'Apply to this session', applying: 'Applying…',
        setImage: 'Customize', imgTitle: 'Title', imgDesc: 'Description', imageUrl: 'Image URL (optional)',
        imageHint: 'Pick a local file or paste an http(s) image link. Leave empty for the generated colours.',
        chooseFile: 'Choose local image', removeFile: 'Remove selected image',
        uploadUnsupported: 'Unsupported image type',
        save: 'Save', cancel: 'Cancel', clearImage: 'Clear image', close: 'Close',
        toastApplied: 'Applied to this session', toastAppliedSome: 'Some skills applied',
        toastFail: 'Failed: ', noSession: 'Cannot determine the current session; open a session first.', composing: 'Save',
        // categories / stats
        filterAll: 'All', filterStarred: 'Favorites', setCategory: 'Set category', clearCategory: 'Clear category',
        usesCount: '{n}×', theseSkills: 'Selected skills', catEditorTitle: 'Category', noCategory: 'Ungrouped',
        sortDefault: 'Default', sortByUses: 'By usage', showAll: 'All', collapsedHint: 'Expand', sortLabel: 'Sort / Filter',
        manageCats: 'Manage categories', addCat: 'Add category', catPlaceholder: 'Category name', builtinCatNote: 'Smart categories are system-generated and not editable',
        renameCat: 'Rename', deleteCat: 'Delete', saveCat: 'Save', catNameLabel: 'Name', builtinLabel: 'Built-in',
        appliedTo: 'Applied to this session:',
        revoke: 'Remove this skill', revokeFail: 'Failed to remove: ', appliedNone: 'No skills applied yet',
        revokeAll: 'Remove all',
        // original text of the skill (the card face may be translated/clamped)
        origTitle: 'Original skill', origName: 'Original name', origDesc: 'Original description',
        origNoDesc: '(this skill ships no description)', origFrom: 'Source: ',
      },
    }

    /* ------------------------------------------------------------------ *
     * Shared store (open/close + current session id seeding)
     * ------------------------------------------------------------------ */
    function createStore() {
      let state = { open: false, sessionId: undefined, gacha: null, lastApplied: null, applied: [] }
      const listeners = new Set()
      const emit = () => { for (const l of listeners) l() }
      // Revocation notice (one-shot per event): skills removed from the session
      // by the composer chips. The panel listens for this and drops the same
      // names from its selection — the two views must not disagree about what
      // the session holds. The composer popover is the ONLY writer.
      let revokedSeq = 0
      const revokedListeners = new Set()
      return {
        get: () => state,
        subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) },
        open() { state = { ...state, open: true }; emit() },
        close: () => { state = { ...state, open: false }; emit() },
        setSession: (id) => { if (id && state.sessionId !== id) { state = { ...state, sessionId: id }; emit() } },
        // Most-recently-applied skills, shown as confirmation chips in the
        // composer area ("已应用：skill-a · skill-b") until they fade.
        setLastApplied: (names) => { state = { ...state, lastApplied: names }; emit() },
        // Skills currently applied to the active session (revocable chips).
        setApplied: (names) => {
          const next = Array.isArray(names) ? names : []
          // identity-stable update: skip the emit when nothing actually changed
          if (next.length === state.applied.length && next.every((n, i) => n === state.applied[i])) return
          state = { ...state, applied: next }; emit()
        },
        // Fired by the composer chips after a successful POST /revoke so the
        // panel can un-check the revoked skills in its selection.
        onRevoked: (l) => { revokedListeners.add(l); return () => revokedListeners.delete(l) },
        notifyRevoked: (names) => {
          if (!Array.isArray(names) || names.length === 0) return
          revokedSeq += 1
          for (const l of revokedListeners) {
            try { l(names, revokedSeq) } catch { /* a bad listener must not block the rest */ }
          }
        },
        // The gacha reveal is global (survives the modal closing): the panel
        // hands over cards+meta on apply, the overlay keeps playing the
        // flip show AFTER the modal is dismissed. Lives on the store — panel
        // state would die with the unmounting modal.
        // The category dictionary travels with the gacha payload so the reveal
        // can resolve ids to labels (an Overlay-layer render has no catDefs).
        triggerGacha: (gacha) => { state = { ...state, gacha }; emit() },
        clearGacha: () => { if (state.gacha) { state = { ...state, gacha: null }; emit() } },
      }
    }
    function useStore(store) {
      return useSyncExternalStore(store.subscribe, store.get, store.get)
    }

    /**
     * Session selector for the `sessions` standard source. The snapshot has no
     * `current` field; the actively-watched session is the one `mainView`
     * retains (same derivation the shell's settings-onboarding uses). Falls
     * back to the first retained session if none is marked main.
     */
    function currentSessionIdOf(snapshot) {
      const state = snapshot || {}
      const byId = state.byId && typeof state.byId === 'object' ? state.byId : {}
      const ids = Object.keys(byId)
      if (ids.length === 0) return undefined
      const retained = ids.filter((id) => (byId[id]?.retainedBy?.mainView ?? 0) > 0)
      const id = retained[0] ?? ids[0]
      return id || undefined
    }

    /**
     * Resolve the session id this mount belongs to.
     *
     * This is what keeps two windows apart. The host half is a single process
     * shared by every window, so any id it "remembers" is global: a client that
     * does not state its own session gets whichever window touched the plugin
     * last, which is how skills applied in window A appeared in window B.
     *
     * Slots are session-scoped, and the renderer hands the owning session to
     * session-scoped slots directly as `sessionId` (see the slot contract in
     * dsh-cordis-client-runner). Prefer it; fall back to the `useSessions`
     * selector for any slot that only exposes the hook.
     */
    function useOwnSessionId(props) {
      const direct = props && props.sessionId
      if (typeof direct === 'string' && direct) return direct
      const useSessions = props && props.useSessions
      return typeof useSessions === 'function' ? useSessions(currentSessionIdOf) : undefined
    }

    /* ------------------------------------------------------------------ *
     * API helpers
     * ------------------------------------------------------------------ */
    async function api(path, opts) {
      const res = await fetch(`${API}${path}`, { cache: 'no-store', ...opts })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    }

    /* ------------------------------------------------------------------ *
     * 3D card wall (three.js)
     *
     * DSH's client module table seeds only a fixed set of packages (react,
     * cordis, dsh-client-*, …) — `three` is not among them, so a classic
     * `require('three')` throws. Instead the plugin ships its own UMD build at
     * vendor/three.min.js and loads it as a same-origin classic script through
     * the host route (the same mechanism DSH itself uses for bundle chunks).
     * Every failure path degrades to the plain flat grid: no WebGL, no crash.
     * ------------------------------------------------------------------ */
    let threePromise = null
    function ensureThree() {
      if (typeof window !== 'undefined' && window.THREE) return Promise.resolve(window.THREE)
      if (threePromise) return threePromise
      // Wrap the whole construction so a DOM availability issue can never throw
      // synchronously — callers run this inside passive effects, and a sync throw
      // would land on the slot error boundary and blank the whole panel (the
      // "opens then instantly disappears" failure). Rejections are always handled.
      try {
        threePromise = new Promise((resolve, reject) => {
          const el = document.createElement('script')
          el.src = `${API}/vendor/three.min.js`
          el.async = true
          el.onload = () => {
            if (window.THREE) resolve(window.THREE)
            else { threePromise = null; reject(new Error('THREE failed to initialise')) }
          }
          el.onerror = () => { threePromise = null; reject(new Error('failed to load three.js')) }
          document.head.appendChild(el)
        })
      } catch (err) {
        threePromise = null
        return Promise.reject(err)
      }
      return threePromise
    }

    /**
     * Deterministic per-card hash (kept for tests / future per-card variance).
     * The resting 3D jitter it used to feed is retired: a flat resting pose
     * means the wall is perfectly still until the pointer touches a card.
     */
    function card3DJitter(name) {
      let h = 2166136261
      for (let i = 0; i < name.length; i++) {
        h ^= name.charCodeAt(i)
        h = Math.imul(h, 16777619)
      }
      return {
        rx: (((h >>> 0) % 5) - 2) * 0.8,  // rotateY  –1.6°..1.6°
        ry: (((h >>> 12) % 5) - 2) * 0.6, // rotateX  –1.2°..1.2°
        z: ((h >>> 24) % 7) * 4,           // translateZ 0..24px
      }
    }

    /**
     * Lay 3D transforms on the grid's DOM cards: a hover tilt that follows the
     * cursor, plus a one-time staggered entrance on first mount ONLY.
     *
     * Motion discipline (the "cards animate without being touched" bug): a
     * card carries NO transform of its own until the pointer is over it — the
     * resting pose is the plain flat card. The old resting jitter (per-name
     * rotateY/rotateX/translateZ) made the wall look like it was constantly
     * shifting, and the per-filter replay of the entrance turned every search
     * keystroke into a wave. Now: entrance plays once per panel mount, hover
     * is opt-in per card, and `pointermove` is attached to the grid only to
     * route the event to the card under the cursor (delegation).
     * Returns a cleanup that removes listeners and resets inline styles.
     */
    /* The two hover-tilt timings, defined here so the transition JS writes and
       the timeout that releases layer promotion can never drift apart. */
    const CARD_TILT_TRANSITION = 'transform .16s ease-out'
    const CARD_SETTLE_TRANSITION = 'transform .34s ease'
    /** Matches CARD_SETTLE_TRANSITION (340ms) plus a frame of slack. */
    const CARD_SETTLE_MS = 360
    function initCard3D(grid) {
      const reduced = typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false
      const cards = Array.from(grid.querySelectorAll('.dsh-sc-card'))
      if (cards.length === 0) return () => {}
      // O(1) membership test — `cards.includes(card)` is a linear scan over ~95
      // elements on EVERY pointermove, i.e. on the hot path of every single
      // mouse event over the grid.
      const cardSet = new Set(cards)

      let raf = 0
      let active = null      // the card currently tilted
      let activeRect = null  // its cached box, filled on enter
      let pending = null     // latest coalesced pointer event
      // One pending "release promotion" timer per card. Needed because a card
      // can be re-entered before its settle timer fires: without this, the stale
      // timer would strip the transition off a card that is mid-tilt again, and
      // the tilt would snap instead of easing.
      const settleTimers = new Map()

      // Cache the hovered card's box on enter. Calling getBoundingClientRect()
      // inside the move handler forces a synchronous layout on every event.
      const applyTilt = () => {
        raf = 0
        const ev = pending
        pending = null
        if (!active || !ev || !activeRect) return
        const dx = (ev.clientX - activeRect.left) / activeRect.width - 0.5
        const dy = (ev.clientY - activeRect.top) / activeRect.height - 0.5
        active.style.transform =
          `perspective(900px) translateZ(42px) rotateY(${dx * 9}deg) rotateX(${-dy * 9}deg)`
      }

      const tilt = (ev) => {
        if (reduced) return
        const card = ev.target.closest ? ev.target.closest('.dsh-sc-card') : null
        if (!card || !cardSet.has(card)) return
        if (card !== active) {
          // Entering a new card: settle the previous one, promote the new one.
          if (active) resetCard(active)
          active = card
          activeRect = card.getBoundingClientRect()
          // Re-entering a card that is still settling: cancel its pending
          // release, or that stale timer would clear the tilt's transition
          // mid-motion and the card would jump instead of easing.
          const stale = settleTimers.get(card)
          if (stale) { clearTimeout(stale); settleTimers.delete(card) }
          card.classList.remove('settling')
          card.classList.add('tilting')
          card.style.transition = CARD_TILT_TRANSITION
        }
        // COALESCE: a mouse fires pointermove several times per display frame
        // (it bursts while tracking). Writing a transform per event meant
        // several style/layout updates per frame; now it is at most one.
        pending = ev
        if (!raf) raf = requestAnimationFrame(applyTilt)
      }

      // Per-card un-hover: reset that card only (pointerleave on the grid is
      // NOT enough — moving between two cards must settle the first one).
      const leaveCard = (ev) => {
        const card = ev.target.closest ? ev.target.closest('.dsh-sc-card') : null
        if (!card || !cardSet.has(card) || card !== active) return
        resetCard(card)
        active = null
        activeRect = null
      }

      function resetCard(card) {
        // `.settling` keeps the layer promoted for the length of the return
        // transition, and the timer drops it — promotion must never outlive
        // the motion that needed it (that is the permanent-layer cost again).
        card.classList.remove('tilting')
        card.classList.add('settling')
        card.style.transition = CARD_SETTLE_TRANSITION
        card.style.transform = 'perspective(900px) translateZ(0px)'
        const prior = settleTimers.get(card)
        if (prior) clearTimeout(prior)
        settleTimers.set(card, setTimeout(() => {
          settleTimers.delete(card)
          card.classList.remove('settling')
          card.style.transition = ''
        }, CARD_SETTLE_MS))
      }

      grid.addEventListener('pointermove', tilt, { passive: true })
      grid.addEventListener('pointerout', leaveCard, { passive: true })
      return () => {
        cancelAnimationFrame(raf)
        raf = 0
        pending = null
        grid.removeEventListener('pointermove', tilt)
        grid.removeEventListener('pointerout', leaveCard)
        // Never leave a settle timer pending: it would fire after teardown and
        // touch styles on cards React is about to reuse.
        for (const id of settleTimers.values()) clearTimeout(id)
        settleTimers.clear()
        cards.forEach((card) => {
          card.style.transform = ''
          card.style.transition = ''
          card.style.opacity = ''
          card.classList.remove('tilting', 'settling')
        })
      }
    }

    /**
     * Create the WebGL particle nebula behind the card wall. Pure decorative
     * layer: pointer-events none, static single frame under reduced motion,
     * fully disposed (GPU + listeners) when the panel unmounts.
     * Returns null when WebGL is unavailable (caller keeps the flat grid).
     *
     * PERF notes (this is a full-screen WebGL pass — the single most expensive
     * thing the panel does, and it is only a soft blurred backdrop behind an
     * opaque card wall):
     *  - antialias:false. MSAA costs a multisampled framebuffer + resolve every
     *    frame. The subject is 900 blurred additive points — there are no hard
     *    geometric edges for MSAA to smooth, so the samples buy nothing visible.
     *  - Pixel ratio capped at 1.5 (was 2). This backdrop is behind a layer of
     *    cards; nobody can resolve 2× detail in it, but the fill cost is
     *    quadratic in the ratio.
     *  - Frame rate capped at ~30fps. A slow parallax drift and a soft particle
     *    field do not read as 30fps; halving the fill rate does read on a laptop
     *    that is otherwise busy laying out 95 cards.
     *  - Renders are suspended when the stage scrolls out of view
     *    (IntersectionObserver) and when the tab is hidden. An offscreen WebGL
     *    canvas still burns a full render pass every frame.
     *  - Pointer tracking is scoped to the stage with a cached rect, instead of a
     *    window-wide listener doing getBoundingClientRect() on every event.
     */
    const NEBULA_FRAME_MS = 1000 / 30
    function createParticleScene(canvas, THREE) {
      const reduced = typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false
      let renderer
      try {
        // antialias:false — see the note above. powerPreference stays
        // 'high-performance' (discrete/integrated GPU hint), unchanged.
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'high-performance' })
      } catch { return null }
      const parent = canvas.parentElement
      const W = parent?.clientWidth || canvas.clientWidth || 400
      const H = parent?.clientHeight || canvas.clientHeight || 300
      renderer.setPixelRatio(Math.min(typeof window !== 'undefined' && window.devicePixelRatio || 1, 1.5))
      renderer.setSize(W, H, false)
      renderer.setClearColor(0x000000, 0)

      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 1000)
      camera.position.z = 60
      const group = new THREE.Group()
      scene.add(group)

      // Nebula: softly glowing additive points in the plugin's accent hues.
      const ACCENTS = ['#6366F1', '#8B5CF6', '#EC4899', '#22D3EE']
      const count = 900
      const positions = new Float32Array(count * 3)
      const colors = new Float32Array(count * 3)
      const c = new THREE.Color()
      for (let i = 0; i < count; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 170
        positions[i * 3 + 1] = (Math.random() - 0.5) * 105
        positions[i * 3 + 2] = (Math.random() - 0.5) * 130
        c.set(ACCENTS[i % ACCENTS.length])
        colors[i * 3] = c.r
        colors[i * 3 + 1] = c.g
        colors[i * 3 + 2] = c.b
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      const mat = new THREE.PointsMaterial({
        size: 0.55, vertexColors: true, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
      const points = new THREE.Points(geo, mat)
      group.add(points)

      // Floating wireframe accents for depth.
      const shapes = []
      const defs = [
        () => new THREE.IcosahedronGeometry(3, 0),
        () => new THREE.TorusKnotGeometry(2.4, 0.7, 40, 8),
        () => new THREE.OctahedronGeometry(2.6, 0),
      ]
      for (let i = 0; i < defs.length; i++) {
        const mesh = new THREE.Mesh(defs[i](), new THREE.MeshBasicMaterial({
          color: ACCENTS[i], wireframe: true, transparent: true, opacity: 0.14,
        }))
        mesh.position.set(-30 + i * 30, (i % 2 ? -1 : 1) * 19, -34 - i * 9)
        group.add(mesh)
        shapes.push(mesh)
      }

      let mx = 0, my = 0, raf = 0, disposed = false
      let lastFrame = 0
      // "Should we be drawing at all?" — offscreen stage or hidden tab.
      let visible = true
      let stageVisible = true

      // Pointer tracking scoped to the stage, using a rect cached on resize
      // instead of measuring inside the event handler (a forced layout per
      // event on a page that is also animating 95 cards).
      let rect = parent?.getBoundingClientRect() || null
      const onMove = (ev) => {
        if (!rect) return
        mx = (ev.clientX - rect.left) / rect.width - 0.5
        my = (ev.clientY - rect.top) / rect.height - 0.5
      }
      const draw = (now) => {
        const t = now * 0.0002
        group.rotation.y = t + mx * 0.5
        group.rotation.x = my * 0.35
        points.rotation.z = t * 0.2
        for (let i = 0; i < shapes.length; i++) {
          shapes[i].rotation.x = t * (1 + i * 0.3)
          shapes[i].rotation.y = t * 0.8 * (i + 1)
        }
        renderer.render(scene, camera)
      }
      const tick = (now) => {
        if (disposed) return
        raf = requestAnimationFrame(tick)
        // Throttle: rAF still fires at display rate, but we only pay for the
        // WebGL pass every ~33ms.
        if (!visible || !stageVisible) return
        if (now - lastFrame < NEBULA_FRAME_MS) return
        lastFrame = now
        draw(now)
      }
      const syncRunState = () => {
        if (disposed) return
        const shouldRun = !reduced && visible && stageVisible
        if (shouldRun && !raf) {
          lastFrame = 0
          raf = requestAnimationFrame(tick)
        } else if (!shouldRun && raf) {
          cancelAnimationFrame(raf)
          raf = 0
        }
      }
      const onVisibility = () => {
        visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
        syncRunState()
      }
      const onResize = () => {
        const w = parent?.clientWidth || canvas.clientWidth
        const h = parent?.clientHeight || canvas.clientHeight
        if (parent) rect = parent.getBoundingClientRect()
        if (!w || !h) return
        renderer.setSize(w, h, false)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
      }
      onResize()
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null
      if (ro && parent) ro.observe(parent)
      parent?.addEventListener('pointermove', onMove, { passive: true })
      document?.addEventListener?.('visibilitychange', onVisibility)
      // Stop drawing once the stage scrolls out of the modal / off screen.
      const io = typeof IntersectionObserver !== 'undefined' && parent
        ? new IntersectionObserver((entries) => {
            for (const en of entries) stageVisible = en.isIntersecting
            syncRunState()
          }, { threshold: 0 })
        : null
      io?.observe(parent)

      syncRunState()
      if (reduced) draw(0)

      return {
        dispose() {
          disposed = true
          cancelAnimationFrame(raf)
          raf = 0
          parent?.removeEventListener('pointermove', onMove)
          document?.removeEventListener?.('visibilitychange', onVisibility)
          io?.disconnect()
          ro?.disconnect()
          geo.dispose()
          mat.dispose()
          shapes.forEach((s) => { s.geometry.dispose(); s.material.dispose() })
          renderer.dispose()
        },
      }
    }

    /* ------------------------------------------------------------------ *
     * Card identity
     * ------------------------------------------------------------------ */
    /** Number of accent pairs declared by the `.dsh-sc-tN` rules in CSS. */
    const TINTS = 12
    /** Light-slot accent of each tint class (matches --sc-b in the CSS above);
        chips use it for the glowing dot so a chip echoes its card's colour. */
    const TINT_ACCENTS = ['#818CF8', '#22D3EE', '#4ADE80', '#FACC15', '#FB923C', '#FB7185', '#E879F9', '#A78BFA', '#2DD4BF', '#60A5FA', '#E11D48', '#A3E635']

    /**
     * Stable accent for a skill.
     *
     * Most skills ship no cover art, so without this the grid is a uniform wall
     * of identical cards and is genuinely hard to scan. Hashing the name gives
     * each skill a fixed colour: the same skill always lands on the same tint
     * across sessions and machines, the mosaic becomes recognisable by shape and
     * colour, and no configuration is needed.
     */
    function tintIndex(name) {
      let h = 2166136261 // FNV-1a
      for (let i = 0; i < name.length; i++) {
        h ^= name.charCodeAt(i)
        h = Math.imul(h, 16777619)
      }
      return (h >>> 0) % TINTS
    }

    /**
     * Two-character glyph for the tile when there is no cover art.
     *
     * Word initials with the first letter of the *last* word as the second
     * character (`brand-guidelines` → "BG", `browser-testing-with-devtools` →
     * "BD"). Taking the second word's initial instead collapses whole families
     * onto one glyph — those two names both gave "BG", and paired with their
     * tint they became indistinguishable cards. Measured over the 95 skills
     * installed here this yields 94 unique glyph+tint combinations, the best of
     * the schemes tried, while still reading as initials.
     */
    function monogram(name) {
      const words = String(name).split(/[-_\s]+/).filter(Boolean)
      if (words.length >= 2) {
        return (words[0][0] + words[words.length - 1][0]).toUpperCase()
      }
      // CJK titles have no [a-z0-9] left after stripping — fall back to the
      // first two characters themselves (中文名 → 取前两字做字纹).
      const cjk = String(name).replace(/[^a-zA-Z0-9\u4e00-\u9fff\u3040-\u30ff]/g, '')
      if (cjk.length >= 2) return cjk.slice(0, 2)
      if (cjk.length === 1) return cjk
      const alnum = String(name).replace(/[^a-z0-9]/gi, '')
      return (alnum[0] + (alnum[1] ?? '')).toUpperCase() || '?'
    }

    /* ------------------------------------------------------------------ *
     * Game-card theme table (Yu-Gi-Oh style frame per category)
     * ------------------------------------------------------------------ *
     * Each built-in category id maps to a frame colour set: --gc-frame (metal
     * frame), --gc-glow (selection/SR halo) and --gc-art (illustration-well
     * gradient). A user-created (or unknown) category gets a hue hashed from
     * its own id, with saturation/lightness pinned to ranges that read as a
     * card frame — so EVERY future category automatically has a harmonious
     * skin and no card ever falls back to a generic colour. */
    const GC_THEMES = {
      dev:      { frame: '#a05a22', dark: '#6b3a12', art: ['#4a3418', '#241a0c'] },
      test:     { frame: '#2e7d4f', dark: '#1b5232', art: ['#1a3a2a', '#0c1c14'] },
      design:   { frame: '#7b3fa0', dark: '#52266d', art: ['#3a2050', '#1c0e28'] },
      write:    { frame: '#3a7a8a', dark: '#205260', art: ['#1a3a44', '#0c1c22'] },
      doc:      { frame: '#2a6a9a', dark: '#184462', art: ['#18344a', '#0a1826'] },
      ai:       { frame: '#2456a0', dark: '#153564', art: ['#182c50', '#0a1226'] },
      workflow: { frame: '#8a6a2f', dark: '#5c4418', art: ['#3c3018', '#1e180a'] },
      research: { frame: '#5a6a8a', dark: '#38445c', art: ['#262e42', '#12161f'] },
      skills:   { frame: '#8a8540', dark: '#5c5826', art: ['#3c3a1c', '#1e1c0c'] },
      security: { frame: '#8a2440', dark: '#5a1428', art: ['#3e1420', '#1e0a10'] },
      data:     { frame: '#2a7a6a', dark: '#185044', art: ['#16342e', '#0a1a16'] },
      other:    { frame: '#5c5470', dark: '#3c3650', art: ['#2a2638', '#141220'] },
    }
    function gcHashHue(str) {
      let h = 0
      for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) % 360
      return h
    }
    function gcThemeOf(categoryId) {
      const theme = GC_THEMES[categoryId]
      if (theme) return theme
      const h = gcHashHue(categoryId || 'card')
      return {
        frame: `hsl(${h} 55% 42%)`,
        dark: `hsl(${h} 55% 26%)`,
        art: [`hsl(${h} 35% 16%)`, `hsl(${h} 40% 7%)`],
      }
    }
    /* ------------------------------------------------------------------ *
     * Art-prompt builder (gpt-image-2 era text-to-image prompts)
     * ------------------------------------------------------------------ *
     * Every category gets a rich visual MOTIF (a character archetype, a
     * palette, a lighting mood, signature props), so same-category skills
     * share a family look while each card's subject comes from the skill's
     * own semantics. Hard rules across all motifs: a SINGLE full-height
     * character, NO text of any kind, no card frame — the prompt feeds a
     * generator whose output becomes the card's art window.
     */
    const GC_MOTIFS = {
      dev: {
        archetype: 'master blacksmith artificer in ornate bronze-trimmed leather apron',
        props: 'glowing rune-forged hammer, floating anvil of molten code-runes, sparks of ember-orange',
        palette: 'ember orange and bronze palette',
        mood: 'forge-fire backlight, steam and floating cinders',
      },
      test: {
        archetype: 'alchemical ritualist in green-trimmed robes holding a crystal vial',
        props: 'glowing green transmutation circle on the ground, floating glass flasks, spiralling verification sigils',
        palette: 'emerald green and parchment palette',
        mood: 'laboratory glow, green magical mist',
      },
      design: {
        archetype: 'arcane illustrator with an enchanted quill, flowing artist cloak',
        props: 'floating canvas of living paint, orbiting colour spirits, ink brush trailing violet light',
        palette: 'royal violet and gold-leaf palette',
        mood: 'studio window light, drifting violet petals',
      },
      write: {
        archetype: 'scribe-sage in teal-trimmed scholar robes with a floating tome',
        props: 'levitating quill writing streams of light, open codex of glowing pages, drifting paper scrolls',
        palette: 'deep teal and ivory palette',
        mood: 'candlelit archive, floating dust motes',
      },
      doc: {
        archetype: 'chancellor herald in blue-trimmed court regalia bearing a sealed scroll',
        props: 'floating ledgers and charts, wax-seal sigil glowing blue, spectral quill assistants',
        palette: 'cobalt blue and silver palette',
        mood: 'great hall daylight, hovering documents',
      },
      ai: {
        archetype: 'star-oracle mage with a crystal orb staff, constellation-embroidered cloak',
        props: 'orb of swirling neural constellations, orbiting rune satellites, arcs of azure lightning',
        palette: 'azure blue and starlight palette',
        mood: 'night observatory, nebula backlight',
      },
      workflow: {
        archetype: 'clockwork engineer in brass goggles and layered guild coat',
        props: 'vast orrery of meshing gears, blueprint scrolls unfurling, brass automata assisting',
        palette: 'brass gold and walnut palette',
        mood: 'workshop warmth, cog-dust in light beams',
      },
      research: {
        archetype: 'astronomer investigator with a brass spyglass and rune-lens monocle',
        props: 'orrery charts, floating magnifying runes, constellation maps unfolding like wings',
        palette: 'slate blue and antique silver palette',
        mood: 'tower study under stars, moody lamplight',
      },
      skills: {
        archetype: 'guildkeeper curator with a ring of master keys and satchel of cards',
        props: 'floating archive cards in a halo, golden catalog ledger, key sigils orbiting',
        palette: 'antique gold and olive palette',
        mood: 'archive glow, golden dust streams',
      },
      security: {
        archetype: 'crimson knight in ornate plate armour with a greattower shield',
        props: 'warding seal of crimson runes, chain-and-lock sigils shattering, ember shield glow',
        palette: 'crimson red and dark iron palette',
        mood: 'fortress night watch, torchlight rim light',
      },
      data: {
        archetype: 'crystal archivist in teal-trimmed vestments tending a living data-tree',
        props: 'tree of glowing data-crystals, floating ledger tablets, streams of teal glyphs',
        palette: 'teal green and crystal white palette',
        mood: 'crystal cavern glow, drifting glyph-fireflies',
      },
      other: {
        archetype: 'wandering arcana duelist in a hooded travel cloak',
        props: 'floating playing-card sigils, shimmering portal, mystic compass of light',
        palette: 'dusky violet and silver palette',
        mood: 'twilight crossroads, arcane mist',
      },
    }
    /** Deterministic motif for unknown (user-created) categories: pick from the
        built-in list by name hash so custom categories still get a full look. */
    function gcMotifOf(categoryId) {
      if (GC_MOTIFS[categoryId]) return GC_MOTIFS[categoryId]
      const ids = Object.keys(GC_MOTIFS)
      return GC_MOTIFS[ids[gcHashHue(categoryId || 'card') % ids.length]]
    }
    /** Subject line describing WHAT the skill does, as a character concept. */
    function gcArtSubject(skill) {
      const zh = skill.custom?.i18n?.zh
      const desc = skill.custom?.i18n?.zhDesc || skill.description || ''
      return `skill "${skill.name}"${desc ? ` — ${desc.slice(0, 120)}` : ''}${zh ? ` (chinese card name: ${zh})` : ''}`
    }
    /** Compose the final gpt-image-2 style prompt for one skill's card art.
     *  Size: the on-screen art window measures ≈1.17:1 (slightly landscape),
     *  so recommend the 1024×1024 square — object-fit:cover crops a little of
     *  the top/bottom and keeps the character intact; 1536×1024 also works.
     *  Background: the art well behind the cover image is a deep theme
     *  gradient (≈#182C50→#0A1226 for AI-blue), so the prompt asks for a dark
     *  atmospheric background in the motif palette that reads well under the
     *  card's inner frame instead of a white studio void. */
    function buildArtPrompt(skill) {
      const m = gcMotifOf(skill.category)
      const sr = isSrCard(skill.name) ? ' legendary golden holographic aura, ultra-rare masterpiece finish,' : ''
      return [
        'Yu-Gi-Oh! trading card artwork, fantasy character illustration in painterly anime style,',
        `subject: a single ${m.archetype} personifying ${gcArtSubject(skill)},`,
        `dynamic full-body pose composed for a slightly landscape window (recommend 1024×1024; keep head and weapon inside the middle 80%),`,
        `signature elements: ${m.props},`,
        `${m.palette}, ${m.mood},`,
        `background: deep atmospheric ${m.palette.split(' ')[0]} tones fading to near-black at the edges, vignette, empty at the center-top for the character, no flat white studio backdrop,`,
        'dramatic rim lighting, intricate details, rich textures, museum-quality illustration,',
        sr,
        'STRICT: no text, no letters, no numbers, no watermark, no signature, no card frame, no borders, single character only',
      ].filter(Boolean).join(' ')
    }
    /** Agent-assist prompt: the agent turns the raw subject line into a vivid
        character concept and returns ONLY the finished art prompt. */
    const ART_PROMPT_TMPL = (skill, draft) => `你是卡牌插画艺术指导。下面是一条技能的语义信息和一个生图提示词草稿，请把草稿中的 subject 行改写成一个具体的游戏王风格角色设定（who they are、their pose、what they wield，40 词以内，与技能语义强关联的隐喻），其余行保持原样，输出最终完整英文提示词。只输出提示词本身，不要任何解释。

技能：${JSON.stringify({ name: skill.name, desc: skill.description || '', category: skill.category })}

草稿：
${draft}`

    /** Hex/rgba colour mixer (replaces CSS color-mix, which older Electron
     *  engines reject — one invalid function drops the WHOLE declaration,
     *  the "card back shows a fifth" class of bug). pct is the share of a. */
    function mixColor(a, b, pct) {
      const parse = (c) => {
        const h = String(c).replace('#', '')
        const f = h.length === 3 ? h.split('').map((x) => x + x).join('') : h
        return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)]
      }
      const [r1, g1, b1] = parse(a)
      const [r2, g2, b2] = parse(b)
      const ch = (v1, v2) => Math.round(v1 * pct + v2 * (1 - pct))
      return `rgb(${ch(r1, r2)}, ${ch(g1, g2)}, ${ch(b1, b2)})`
    }
    /** rgba() with alpha, from a hex colour. */
    function alphaColor(hex, a) {
      const h = String(hex).replace('#', '')
      const f = h.length === 3 ? h.split('').map((x) => x + x).join('') : h
      return `rgba(${parseInt(f.slice(0, 2), 16)}, ${parseInt(f.slice(2, 4), 16)}, ${parseInt(f.slice(4, 6), 16)}, ${a})`
    }

    /* PERF: gcStyleProps is pure — same category id always yields the same
       custom-property bag — but it costs ~12 string colour mixes per call, and
       it is called once per card per render (95 cards → >1100 mixes per render).
       Memoising per category id turns that into 12 computations total, and the
       stable object identity also lets React skip re-diffing the style bag.
       Keyed on the raw id (incl. undefined) so a category-less card still hits
       the cache instead of falling through to a fresh mix every render. */
    const GC_STYLE_CACHE = new Map()
    function gcStyleProps(categoryId) {
      const key = categoryId == null ? '' : String(categoryId)
      const hit = GC_STYLE_CACHE.get(key)
      if (hit) return hit
      const props = buildGcStyleProps(key)
      GC_STYLE_CACHE.set(key, props)
      return props
    }
    function buildGcStyleProps(categoryId) {
      const theme = gcThemeOf(categoryId)
      const frame = theme.frame
      const dark = theme.dark
      return {
        '--gc-frame': frame,
        '--gc-dark': dark,
        '--gc-glow': alphaColor(frame, 0.55),
        '--gc-art': `linear-gradient(150deg, ${theme.art[0]}, ${theme.art[1]} 60%, #0d1020)`,
        '--gc-paper': mixColor(frame, '#f4eede', 0.14),
        '--gc-paper-edge': mixColor(frame, '#9a8a5a', 0.45),
        '--gc-ink': mixColor(frame, '#241c0e', 0.62),
        '--gc-ink-strong': mixColor(frame, '#1c150a', 0.80),
        /* Pre-computed mixes the CSS used to do with color-mix(). */
        '--gc-art-edge': mixColor(dark, '#000000', 0.70),
        '--gc-glyph': mixColor(frame, '#ffffff', 0.70),
        '--gc-paper-shade': mixColor(mixColor(frame, '#f4eede', 0.14), '#7a6a4a', 0.86),
        '--gc-inset-ring': alphaColor(frame, 0.55),
        '--gc-wash-hi': mixColor(frame, '#ffffff', 0.45),
        '--gc-wash-lo': mixColor(frame, '#1a1408', 0.30),
        '--gc-sigil': mixColor(frame, '#ffffff', 0.70),
        '--gc-sigil-glow': alphaColor(frame, 0.55),
        '--gc-sigil-soft': alphaColor(frame, 0.30),
        '--gc-star': mixColor(frame, '#ffffff', 0.75),
        /* Card-back tint layers (plain rgba, no blend modes). */
        '--gc-tint-hi': alphaColor(frame, 0.28),
        '--gc-tint-lo': alphaColor(mixColor(frame, '#0a0e1a', 0.35), 0.38),
      }
    }

    /**
     * SR (super-rare) marking: deterministic per skill name so a card keeps the
     * same rarity across opens — roughly 1 in 8 skills is "SR", enough to make
     * a few cards shine without cheapening the rest.
     */
    function isSrCard(name) {
      let h = 2166136261
      for (let i = 0; i < name.length; i++) {
        h ^= name.charCodeAt(i)
        h = Math.imul(h, 16777619)
      }
      return (h >>> 0) % 8 === 0
    }
      /** Level stars from the use counter (the only "growth" axis a skill has).
     *  Log-ish ladder tuned to real usage data (most skills sit at 1-20 uses):
     *  0 次=1★, 1-2=2★, 3-9=3★, 10-29=4★, 30+=5★ — so stars actually move
     *  within the range real libraries live in, instead of pinning 95% of
     *  cards at 2★. Shared by the grid and the gacha reveal. */
    function levelOf(uses) {
      if (uses >= 30) return 5
      if (uses >= 10) return 4
      if (uses >= 3) return 3
      if (uses >= 1) return 2
      return 1
    }

    /** Build the game-card face DOM (title/art/description/ATK row). */
      // gcCardChildren is defined at module level with a static signature; the
      // popover anchor is passed as `catChip` (an element) instead of a closure.
    function gcCardChildren({ title, desc, img, glyph, catLabel, uses, lv, sr, catChip }) {
      const stars = '★'.repeat(Math.max(1, Math.min(5, lv))) + '☆'.repeat(Math.max(0, 5 - Math.max(1, Math.min(5, lv))))
      const kids = []
      kids.push(e('div', { className: 'gc-name', key: 'name' },
        e('i', { className: 'gc-badge', 'aria-hidden': 'true' }),
        e('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, title),
        // Explicit rarity plate: the halo alone is only a hint, this is the
        // label a player can actually read at grid size.
        sr ? e('span', { className: 'gc-sr', title: 'SR · 稀有卡' }, 'SR') : null))
      // Level stars live on their own row UNDER the name bar, right-aligned
      // (the TCG "level" line), not squeezed into the title.
      kids.push(e('div', { className: 'gc-level', key: 'level', 'aria-hidden': 'true' }, stars))
      kids.push(e('div', { className: 'gc-art', key: 'art' },
        img
          ? e('img', { src: img, alt: '', loading: 'lazy', onError: (ev) => { ev.target.style.display = 'none' } })
          : e('span', { className: 'gc-glyph', 'aria-hidden': 'true' }, glyph)))
      kids.push(e('div', { className: 'gc-desc', key: 'desc' },
        e('span', { className: 'gc-desc-text' },
          e('b', null, `【${title}】`), desc ? ` ${desc}` : '')))
      kids.push(e('div', { className: 'gc-stats', key: 'stats' },
        catChip || e('span', { className: 'gc-cat' }, catLabel),
        e('span', { className: 'gc-nums' }, 'ATK ', e('span', null, String(uses)))))
      kids.push(e('div', { className: 'gc-foil', 'aria-hidden': 'true' }))
      return kids
    }

    /** Category chip anchored on the card's stats row (opens the popover). */
    function gcCatChip({ catLabel, catOpen, onToggle, anchorRef, interactive = true }) {
      // 切牌期间「当前卡」不能开分类弹层（弹层坐标要在卡牌稳定后测量），但**不能
      // 卸载这个标签**：它在 .gc-stats 行里与 ATK 数值同一行，卸载重挂会让整行
      // 重排 —— 表现为分类标签与数值"闪一下"。所以非交互态保留同一个元素与样式，
      // 只摘掉 role/tabIndex/事件（纯视觉），DOM 节点与盒子完全不变。
      if (!interactive) {
        return e('span', { className: 'dsh-sc-cat is-inert' }, catLabel || '分类')
      }
      return e('span', {
        className: 'dsh-sc-cat', role: 'button', tabIndex: 0,
        // The ref lets the popover exempt its own trigger from the outside-click
        // close, so the chip can also close the menu it opened.
        ref: anchorRef,
        'aria-haspopup': 'true', 'aria-expanded': catOpen ? 'true' : 'false',
        onClick: (ev) => { ev.stopPropagation(); onToggle() },
        onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); onToggle() } },
      }, catLabel || '分类')
    }

    /* ------------------------------------------------------------------ *
     * Chinese-localisation (i18n) prompt protocol
     * ------------------------------------------------------------------ *
     * The panel builds a prompt listing untranslated skills; the user pastes
     * it into the conversation, the agent replies with a JSON array, and the
     * reply is pasted back and POSTed to /i18n. Batch (toolbar) and single-card
     * ("译" button) share the same protocol and the same endpoint, so an agent
     * can also POST /plugins/dsh-skill-cards/i18n directly. */
    const I18N_PROMPT_HEAD = `你是本地技能库的中文化助手。请把下面 JSON 里每个技能翻译成游戏王风格的中文名与描述：
- name → 中文卡名：2-6 字，简短有力（参考："tdd"→"测试仪式"、"skill-creator"→"技能创世神"）
- desc → 中文卡牌描述：60 字以内，风格戏剧化但功能描述必须准确，不得虚构能力

只返回 JSON 数组，不要任何解释或代码块标记，格式：
[{"name":"原始英文名(原样返回)","zh":"中文卡名","zhDesc":"中文描述"}]

待翻译列表：
`
    function buildI18nPrompt(items) {
      return I18N_PROMPT_HEAD + JSON.stringify(items, null, 2)
    }
    /** Parse an agent reply: strips ``` fences, validates the array shape. */
    function parseI18nReply(raw) {
      const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
      const data = JSON.parse(cleaned)
      if (!Array.isArray(data)) throw new Error('not an array')
      const out = []
      for (const d of data) {
        if (!d || typeof d.name !== 'string' || !d.name) continue
        if (typeof d.zh !== 'string' || !d.zh.trim()) continue
        out.push({ name: d.name, zh: d.zh.trim(), zhDesc: typeof d.zhDesc === 'string' ? d.zhDesc.trim() : '' })
      }
      if (out.length === 0) throw new Error('no valid entries')
      return out
    }

    /* ------------------------------------------------------------------ *
     * Image-edit popover
     * ------------------------------------------------------------------ */
    function ImageForm({ skill, current, t, onClose, onSaved, onError }) {
      const [title, setTitle] = useState(current?.title ?? '')
      const [description, setDescription] = useState(current?.description ?? '')
      const [image, setImage] = useState(current?.image ?? '')
      // Chinese-localised card name / description (the i18n overlay). Shown so
      // an agent-written translation is editable here too.
      const [zh, setZh] = useState(current?.i18n?.zh ?? '')
      const [zhDesc, setZhDesc] = useState(current?.i18n?.zhDesc ?? '')
      // A local file the user picked but has not saved yet: { file, previewUrl }.
      const [pending, setPending] = useState(null)
      const [busy, setBusy] = useState(false)
      const fileRef = useRef(null)

      const postCards = async (payload) => {
        await api('/cards', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: skill.name, ...payload }),
        })
      }

      // Upload a picked local file to the host, which persists it as a file and
      // returns a served URL. Only that URL reaches skill-cards.json — the raw
      // bytes / base64 never do (that is what keeps the config small).
      // Returns the served URL (and records it in state for the live preview).
      const uploadPending = async () => {
        if (!pending?.file) return null
        const bytes = await pending.file.arrayBuffer()
        const res = await fetch(`${API}/image`, {
          method: 'POST',
          headers: { 'content-type': pending.file.type || 'image/png' },
          body: bytes,
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
        dropPending()
        setImage(data.url)
        return data.url
      }

      const onPick = (ev) => {
        const file = ev.target.files?.[0]
        if (!file) return
        const mime = file.type || ''
        if (!/^image\/(png|jpe?g|webp|gif|svg\+xml)$/i.test(mime)) {
          onError(t('uploadUnsupported'))
          ev.target.value = ''
          return
        }
        setPending({ file, previewUrl: URL.createObjectURL(file) })
      }
      // Release the preview object URL and reset the hidden input.
      const dropPending = () => {
        if (pending?.previewUrl) try { URL.revokeObjectURL(pending.previewUrl) } catch { /* ignore */ }
        setPending(null)
        if (fileRef.current) fileRef.current.value = ''
      }

      const submit = async () => {
        setBusy(true)
        try {
          const uploaded = await uploadPending()
          // /cards carries the whole card record; i18n rides along so one save
          // covers title/description/image AND the Chinese overlay. An empty
          // zh clears the translation (the host treats empty zh as removal).
          const i18n = zh.trim() ? { zh: zh.trim(), zhDesc: zhDesc.trim() || null } : null
          await postCards({ title, description, image: uploaded || image, i18n })
          onSaved({ title: title || null, description: description || null, image: (uploaded || image) || null, i18n })
          onClose()
        } catch (err) { onError(`${t('toastFail')}${err.message}`) } finally { setBusy(false) }
      }

      const clearImg = async () => {
        setBusy(true)
        try {
          dropPending()
          await postCards({ title, description, image: '', i18n: zh.trim() ? { zh: zh.trim(), zhDesc: zhDesc.trim() || null } : null })
          setImage(''); onSaved({ title: title || null, description: description || null, image: null, i18n: zh.trim() ? { zh: zh.trim(), zhDesc: zhDesc.trim() || null } : null })
        } catch (err) { onError(`${t('toastFail')}${err.message}`) } finally { setBusy(false) }
      }

      return e('div', { className: 'dsh-sc-modal-mask', onClick: (ev) => { if (ev.target === ev.currentTarget) onClose() } },
        e('div', { className: 'dsh-sc-imgform', role: 'dialog', 'aria-modal': 'true' },
          e('h4', null, t('setImage')),
          e('p', { className: 'dsh-sc-imgform-sub' }, skill.name),
          e('label', null, t('imgTitle')),
          e('input', { type: 'text', value: title, placeholder: current?.i18n?.zh || skill.name, onChange: (ev) => setTitle(ev.target.value) }),
          e('label', null, t('imgDesc')),
          e('textarea', { rows: 3, value: description, placeholder: current?.i18n?.zhDesc || skill.description || '', onChange: (ev) => setDescription(ev.target.value) }),
          e('label', null, t('imageUrl')),
          e('input', { type: 'text', value: image, placeholder: 'https://…', onChange: (ev) => setImage(ev.target.value) }),
          e('label', null, '中文卡名'),
          e('input', { type: 'text', value: zh, placeholder: '留空则显示英文名', onChange: (ev) => setZh(ev.target.value) }),
          e('label', null, '中文描述'),
          e('textarea', { rows: 3, value: zhDesc, placeholder: '留空则显示原描述', onChange: (ev) => setZhDesc(ev.target.value) }),
          e('div', { className: 'dsh-sc-file-row' },
            e('button', { type: 'button', className: 'dsh-sc-file-btn', onClick: () => fileRef.current?.click(), disabled: busy },
              t('chooseFile')),
            pending
              ? e('span', { className: 'dsh-sc-file-name', title: pending.file.name }, pending.file.name)
              : null),
          e('input', { ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', style: { display: 'none' }, onChange: onPick }),
          e('p', { className: 'dsh-sc-imgform-sub' }, t('imageHint')),
          e('div', { className: 'row' },
            e('button', { className: 'dsh-sc-danger', onClick: clearImg, disabled: busy }, t('clearImage')),
            e('button', { onClick: onClose, disabled: busy }, t('cancel')),
            e('button', { className: 'dsh-sc-primary', onClick: submit, disabled: busy }, t('composing')),
          ),
        ),
      )
    }

    /**
     * Geometry for a popover anchored to a card, measured against the stage.
     *
     * The stage (`.dsh-sc-stage`) is the panel's only scroll container and it
     * clips its overflow, so a hard-coded `top:100%` menu was wrong twice over
     * on a full wall: a long category list ran past the stage's bottom edge and
     * the tail of it could not be clicked at all, and (because every card is its
     * own paint layer) the menu was painted over by the cards that follow it.
     *
     * Measure ONCE, when the popover opens — never during render, never per
     * event — and hand back the numbers the popover needs as inline styles:
     *   up     — which side of the card it hangs off (animation direction)
     *   room   — its max height before the stage would clip it (it scrolls)
     *   width  — clamped to the stage, so it never spawns a horizontal scrollbar
     *   left   — horizontal offset from the card, nudged only as far as needed
     *   top    — vertical offset from the card, likewise nudged back inside the
     *            stage; when the free space beside the card is too small to be
     *            useful the panel is allowed to slide OVER its own card (never
     *            over the stage edge), because a menu you can read beats one
     *            that is clipped away
     *
     * Everything is measured off the card WRAPPER, not off the trigger: the
     * wrapper is the popover's containing block, so `top:100%` hangs off the
     * card's bottom edge no matter how far down the card the chip sits.
     *
     * The clamps use the part of the stage that is actually ON SCREEN: in the
     * modal the two coincide, but the inline settings panel lives inside the
     * host's own scroller, so the stage itself can be partially scrolled out of
     * view — a panel placed "inside the stage" would then still be off screen.
     *
     * With no measurable stage (DOM-less tests, an exotic mount) it degrades to
     * plain `top:100%` behaviour from CSS instead of refusing to open.
     */
    function popoverPlacement(anchorEl, wantedWidth, preferredHeight) {
      const fallback = { up: false, room: preferredHeight, width: wantedWidth, left: 0, top: null }
      if (!anchorEl || typeof anchorEl.closest !== 'function' || typeof anchorEl.getBoundingClientRect !== 'function') {
        return fallback
      }
      const stage = anchorEl.closest('.dsh-sc-stage')
      const box = anchorEl.closest('.dsh-sc-card-wrap') || anchorEl
      if (!stage || typeof box.getBoundingClientRect !== 'function') return fallback
      const a = box.getBoundingClientRect()
      const s = stage.getBoundingClientRect()
      if (!s.height || !a.height) return fallback
      const GAP = 4   // the seam between the card and the panel
      const PAD = 8   // keep this much clear of the stage's own edge
      const MIN = 160 // below this, prefer overlapping the card to a sliver of menu
      const vp = typeof window !== 'undefined' && window.innerHeight ? window : null
      const bound = {
        top: (vp ? Math.max(s.top, 0) : s.top) + PAD,
        bottom: (vp ? Math.min(s.bottom, vp.innerHeight) : s.bottom) - PAD,
        left: (vp ? Math.max(s.left, 0) : s.left) + PAD,
        right: (vp ? Math.min(s.right, vp.innerWidth) : s.right) - PAD,
      }
      const width = Math.max(170, Math.min(wantedWidth, bound.right - bound.left))
      const spaceBelow = bound.bottom - a.bottom - GAP
      const spaceAbove = a.top - bound.top - GAP
      const up = spaceBelow < preferredHeight && spaceAbove > spaceBelow
      const outside = Math.max(0, up ? spaceAbove : spaceBelow)
      const room = Math.min(preferredHeight, Math.max(outside, Math.min(MIN, Math.max(96, bound.bottom - bound.top))))
      // Where it wants to sit relative to the card, then shifted back inside the
      // stage. minTop is the top-edge bound, maxTop the bottom-edge one; taking
      // max(minTop, maxTop) keeps the interval valid when a card is taller than
      // the stage, so the clamp can never invert.
      const wanted = up ? -room - GAP : a.height + GAP
      const minTop = bound.top - a.top
      const maxTop = bound.bottom - a.top - room
      const top = Math.round(Math.min(Math.max(wanted, minTop), Math.max(minTop, maxTop)))
      const left = Math.round(Math.max(bound.left - a.left, Math.min(0, bound.right - a.left - width)))
      return { up, room, width, left, top }
    }

    /* ------------------------------------------------------------------ *
     * Card
     * ------------------------------------------------------------------ */
    /* PERF: React.memo on the card. The panel re-renders on every keystroke,
       selection tick, and popover open; without memo all ~95 cards re-render
       (and re-diff their ~18 style custom properties) even when nothing about
       them changed. Memo only pays off because every prop below is referentially
       stable — the handlers are useCallback'd and `skill` is a memoised object,
       so an unchanged card really does bail out. */
    const Card = React.memo(function Card({ skill, custom, selected, interactive = true, isCurrent = true, onToggle, onSetImage, onTranslate, onResetI18n, onArtPrompt, t, catDefs, onStar, onCategory }) {
      const effectiveTitle = custom?.i18n?.zh || custom?.title || skill.name
      const effectiveDesc = custom?.i18n?.zhDesc || custom?.description || skill.description || ''
      const [imgError, setImgError] = useState(false)
      // ONE card popover at a time: the category picker ('cat') and the
      // original-text panel ('info'). It carries the measured placement, so
      // opening is a single state write — the layout read happens in the click
      // handler, never during render. `null` = both closed.
      const [pop, setPop] = useState(null)
      const popRef = useRef(null)        // the open popover itself
      const catAnchorRef = useRef(null)  // the category chip that opens it
      const infoAnchorRef = useRef(null) // the "原" button that opens it
      const catOpen = !!pop && pop.kind === 'cat'
      const infoOpen = !!pop && pop.kind === 'info'
      // 切换或缩放期间关闭弹层，避免拿过渡中的矩阵测量菜单坐标。
      useEffect(() => { if (!interactive) setPop(null) }, [interactive])
      /**
       * Toggle a card popover. `anchor` is the ref of the control it hangs off;
       * that control is exempt from the outside-click close below, so it can
       * also close its own menu — without the exemption the pointerdown that
       * precedes a click on the anchor closed the menu and the click instantly
       * reopened it, so the toggle never closed anything.
       */
      const togglePop = (kind, anchor, wantedWidth, preferredHeight) => {
        if (pop && pop.kind === kind) { setPop(null); return }
        const el = anchor && anchor.current ? anchor.current : anchor
        setPop({ kind, ...popoverPlacement(el, wantedWidth, preferredHeight) })
      }
      // The host answers an absolute "/plugins/..." path; re-anchor it to the
      // page base so a reverse-proxy sub-path mount still resolves. Applies to
      // both the scanned cover and an uploaded custom image URL.
      const resolveUrl = (u) => {
        if (!u) return undefined
        try { return new URL(u.replace(/^\//, ''), document.baseURI).href } catch { return u }
      }
      const effectiveImg = resolveUrl(custom?.image) || resolveUrl(skill.coverUrl)
      const tint = `dsh-sc-t${tintIndex(skill.name)}`
      const starred = !!skill.starred
      const uses = typeof skill.uses === 'number' ? skill.uses : 0
      const catLabel = catDefs[skill.category]?.label || skill.category || ''
      // `usesCount` is a plain '{n}' template (NOT a function): DSH's real
      // `t(key, params)` interpolates by calling `template.replace(...)` on the
      // dictionary value, so a function-valued entry crashes the whole panel with
      // "template.replace is not a function". Keep it a string template and fall
      // back defensively so a null/odd `t` can never blank the panel either.
      // The ATK row shows the raw number; this formatted text stays available
      // for surfaces that want "N 次" (locale contract: key declared + called).
      const usesText = (() => {
        let s = t('usesCount', { n: uses })
        if (typeof s === 'function') s = s({ n: uses })
        return s == null ? String(uses) : String(s)
      })()
      // Reset the error latch when the URL changes (e.g. after the user edits
      // the image from broken to valid), so a later load can succeed again.
      useEffect(() => { setImgError(false) }, [effectiveImg])
      // Close the card popover on outside click / Escape. Both anchors are
      // exempt: the pointerdown that precedes a click on the anchor would
      // otherwise close the menu, and the click would immediately reopen it —
      // so the toggle could never close its own menu.
      useEffect(() => {
        if (!pop) return
        const close = (ev) => {
          const target = ev.target
          if (popRef.current && popRef.current.contains(target)) return
          if (catAnchorRef.current && catAnchorRef.current.contains(target)) return
          if (infoAnchorRef.current && infoAnchorRef.current.contains(target)) return
          setPop(null)
        }
        const onKey = (ev) => { if (ev.key === 'Escape') setPop(null) }
        window.addEventListener('pointerdown', close)
        window.addEventListener('keydown', onKey)
        return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', onKey) }
      }, [pop])
      // Game-card (Yu-Gi-Oh style) face: theme-variable frame + art well +
      // parchment description + ATK/uses row. The category theme drives the
      // colours; an SR skill keeps a permanent foil sweep. The translation
      // button ("译") opens the single-card i18n form.
      const lv = levelOf(uses)
      const sr = isSrCard(skill.name)
      // `pop-open` raises THIS card's wrapper so the popover is not covered by
      // the cards that follow it (every card is its own paint layer — see the
      // .dsh-sc-card-wrap.pop-open rule).
      return e('div', { className: `dsh-sc-card-wrap${pop ? ' pop-open' : ''}` },
        // The card is a plain container, NOT the click target. It owns the
        // selection ring and the 3D pose, and holds three SIBLINGS: the
        // selection button (wrapping the face), the tick, and the tool cluster.
        // That layout is deliberate — the face used to be a <button> with the
        // tool buttons nested inside it, which is invalid HTML, and the same
        // nesting under role="button" would have hidden the tools from
        // assistive tech (a button's children are presentational).
        e('div', {
          className: `dsh-sc-card ${tint}${selected ? ' selected' : ''}${custom?.i18n?.zh ? ' i18n-done' : ''}`,
          'data-name': skill.name,
          style: { padding: 0, border: 'none', background: 'transparent', overflow: 'visible' },
        },
          // A real <button> around the face: native Enter/Space, native focus
          // ring, and it keeps the face hovered — `.dsh-sc-gcard:hover` still
          // drives the foil sweep and the ATK row's hover glow.
          e('button', {
            type: 'button',
            className: 'dsh-sc-cardhit',
            onClick: () => onToggle(skill.name),
            'aria-pressed': selected ? 'true' : 'false',
            'aria-label': effectiveDesc ? `${effectiveTitle} — ${effectiveDesc}` : effectiveTitle,
            title: effectiveTitle,
          },
            e('div', {
              className: `dsh-sc-gcard${sr ? ' sr' : ''}`,
              style: gcStyleProps(skill.category),
            },
              e('div', { className: 'gc-inner' },
                gcCardChildren({
                  title: effectiveTitle,
                  desc: effectiveDesc,
                  img: effectiveImg && !imgError ? effectiveImg : null,
                  glyph: monogram(effectiveTitle),
                  catLabel: catLabel || '·',
                  uses,
                  lv,
                  sr,
                  // 当前卡**始终**挂 chip（只切交互能力，避免切牌时卸载重排）；
                  // 侧牌不挂，沿用 gcCardChildren 的纯文本标签，外观与原来一致。
                  catChip: isCurrent ? gcCatChip({
                    catLabel,
                    catOpen,
                    anchorRef: catAnchorRef,
                    // 200px fits every category label; 300px is roughly eight rows
                    // before the panel starts scrolling.
                    onToggle: () => togglePop('cat', catAnchorRef, 200, 300),
                    interactive,
                  }) : null,
                }))),
          ),
          e('div', { className: 'dsh-sc-check', 'aria-hidden': 'true' }, selected ? '✓' : ''),
          // Every hover control, in one wrapping row in the top-LEFT corner —
          // see .dsh-sc-cardtools. Order reads state → the card's text tools
          // (中文化 / 还原 / 原文) → its artwork tools (卡图 / 封面).
          e('div', { className: 'dsh-sc-cardtools' },
            e('button', {
              type: 'button',
              className: 'dsh-sc-star',
              'aria-pressed': starred ? 'true' : 'false',
              'aria-label': starred ? 'unstar' : 'star',
              title: starred ? '取消常用' : '设为常用',
              onClick: (ev) => { ev.stopPropagation(); onStar(skill.name) },
            }, starred ? '★' : '☆'),
            e('button', {
              type: 'button',
              className: 'dsh-sc-trans',
              'aria-label': 'translate',
              title: custom?.i18n?.zh ? '修改中文化' : '中文化这张卡',
              onClick: (ev) => { ev.stopPropagation(); onTranslate(skill) },
            }, '译'),
            custom?.i18n?.zh ? e('button', {
              type: 'button',
              className: 'dsh-sc-trans dsh-sc-trans-reset',
              'aria-label': 'reset translation',
              title: '还原为英文原名（清除中文化）',
              onClick: (ev) => { ev.stopPropagation(); onResetI18n(skill) },
            }, '↺') : null,
            // The skill's OWN name/description. The face shows the Chinese
            // overlay once translated and clamps the description to six
            // card-sized lines either way, so without this the installed text
            // is simply not readable anywhere in the panel.
            e('button', {
              type: 'button',
              className: 'dsh-sc-srcbtn',
              ref: infoAnchorRef,
              'aria-haspopup': 'dialog',
              'aria-expanded': infoOpen ? 'true' : 'false',
              'aria-label': t('origTitle'),
              title: t('origTitle'),
              onClick: (ev) => { ev.stopPropagation(); togglePop('info', infoAnchorRef, 340, 320) },
            }, '原'),
            e('button', {
              type: 'button',
              className: 'dsh-sc-artbtn',
              'aria-label': 'art prompt',
              title: '生成卡图提示词 / 导入生成图',
              onClick: (ev) => { ev.stopPropagation(); onArtPrompt(skill) },
            }, '🎨'),
            // The one labelled control: the entry to the card editor
            // (cover / title / description). A real <button> — it is a SIBLING
            // of the face button, so nothing forces it to be a role="button"
            // div with hand-rolled Enter/Space handling.
            e('button', {
              type: 'button',
              className: 'dsh-sc-setimg',
              onClick: (ev) => { ev.stopPropagation(); onSetImage(skill) },
            }, t('setImage')),
          ),
        ),
        catOpen ? e('div', {
          className: `dsh-sc-catpop${pop.up ? ' up' : ''}`,
          ref: popRef, role: 'menu',
          // Placement measured on open: capped height (it scrolls) plus a
          // top/left clamped inside the stage, so no row of the list is ever
          // clipped away unreachable.
          style: { width: pop.width, maxHeight: pop.room, left: pop.left, top: pop.top },
        },
          Object.entries(catDefs).map(([id, def]) =>
            e('button', {
              key: id, type: 'button', role: 'menuitem', 'data-cat': id,
              className: skill.category === id ? 'active' : '',
              onClick: (ev) => { ev.stopPropagation(); onCategory(skill.name, id); setPop(null) },
            }, def.label)),
          e('button', {
            type: 'button', role: 'menuitem', className: skill.category === skill.suggestedCategory ? '' : 'clear',
            onClick: (ev) => { ev.stopPropagation(); onCategory(skill.name, null); setPop(null) },
          }, t('clearCategory')),
        ) : null,
        infoOpen ? e('div', {
          className: `dsh-sc-srcpop${pop.up ? ' up' : ''}`,
          ref: popRef, role: 'dialog', 'aria-label': t('origTitle'),
          style: { width: pop.width, maxHeight: pop.room, left: pop.left, top: pop.top },
        },
          e('div', { className: 'dsh-sc-srcpop-title' }, t('origTitle')),
          e('div', { className: 'dsh-sc-srcpop-label' }, t('origName')),
          e('div', { className: 'dsh-sc-srcpop-name' }, skill.name),
          e('div', { className: 'dsh-sc-srcpop-label' }, t('origDesc')),
          e('div', { className: `dsh-sc-srcpop-desc${skill.description ? '' : ' empty'}` },
            skill.description || t('origNoDesc')),
          skill.label ? e('div', { className: 'dsh-sc-srcpop-meta' }, `${t('origFrom')}${skill.label}`) : null,
        ) : null,
      )
    })

    // 宽度来自实际面板，设置栏与弹窗共用同一套计算。留一张透明缓冲卡，
    // 连续切换时相邻卡保留 DOM 节点，CSS 可以从旧位置平滑过渡。
    function fanMetrics(width, viewportHeight, availableHeight = Infinity) {
      const radius = width >= 800 ? 3 : width >= 540 ? 2 : 1
      // 为导航与详情留出空间；短窗口保留最小可辨卡面，再由 stage 纵向滚动。
      const heightBudget = Math.max(200, Math.min(viewportHeight * .44, availableHeight - 288 - radius * radius * 6))
      const cardWidth = Math.min(260, width * .56, heightBudget * 59 / 86)
      const cardHeight = cardWidth * 86 / 59
      const angle = radius * 5 * Math.PI / 180
      const outerWidth = (cardWidth / 2 * Math.cos(angle) + cardHeight * Math.sin(angle)) * (1 - radius * .09)
      const step = Math.max(0, Math.min(cardWidth * .48, (width / 2 - 14 - outerWidth) / radius))
      const bottom = cardWidth / 2 * Math.sin(angle) * (1 - radius * .09)
      return { radius, cardWidth, cardHeight, step, height: Math.ceil(cardHeight + 32 + bottom + radius * radius * 6) }
    }

    // 横向手势的两个阈值：越过 START 才算拖动（此前仍是点击，手抖不会吃掉勾选），
    // 松手后在 CLICK_SLOP 内且没越过 START 的按下按点击处理。
    const FAN_DRAG_START = 12
    const FAN_CLICK_SLOP = 8
    // 一次拖动最多带走几张：手指拖得再远也只走到这里，避免为了跟随而挂载整副卡组。
    const FAN_DRAG_MAX = 3
    // 拖动位移换算出「已经走过几个卡位」，到列表头尾或 FAN_DRAG_MAX 就顶住。
    function clampDragUnits(units, index, total) {
      return Math.max(-Math.min(index, FAN_DRAG_MAX), Math.min(Math.min(total - 1 - index, FAN_DRAG_MAX), units))
    }

    /* ── 布局偏好：扇形（默认）或网格卡墙 ─────────────────────────────────────
       宿主端 `/prefs` 是权威值（跟分类/封面一样落在 ~/.dsh 里，换入口、换窗口、
       重启都跟着走）；localStorage 只是首屏镜像，避免读到权威值前先闪一下默认
       布局。默认值必须与 lib/stats.js 的 PREF_DEFAULTS.layout 一致（有单测守着）。 */
    const DEFAULT_LAYOUT = 'fan'
    const LAYOUTS = ['fan', 'wall']
    const LAYOUT_STORAGE_KEY = 'dsh-skill-cards.layout'
    /** 只认白名单值：脏镜像/脏响应一律落回默认。 */
    const normalizeLayout = (value) => (LAYOUTS.includes(value) ? value : DEFAULT_LAYOUT)
    function readCachedLayout() {
      // 隐私模式 / 沙箱里访问 localStorage 本身就可能抛，所以连读取都要兜住。
      try { return normalizeLayout(window.localStorage?.getItem(LAYOUT_STORAGE_KEY)) } catch { return DEFAULT_LAYOUT }
    }
    function cacheLayout(value) {
      try { window.localStorage?.setItem(LAYOUT_STORAGE_KEY, value) } catch { /* 存不下不影响功能 */ }
    }

    function fanPose(offset, metrics) {
      const distance = Math.abs(offset)
      return {
        transform: `translate3d(${offset * metrics.step}px, ${distance * distance * 6}px, 0) rotate(${offset * 5}deg) scale(${1 - distance * .09})`,
        // offset 允许是小数（拖动中的卡位），z-index 只能是整数。
        zIndex: Math.round(20 - distance),
        // 整数 offset 下与原来一致（半径内 1、半径外 0）；拖动中在半径处淡出。
        opacity: Math.max(0, Math.min(1, metrics.radius + 1 - distance)),
      }
    }

    /* ── 布局二：网格卡墙 ─────────────────────────────────────────────────────
       扇形之前的老布局，恢复成一个独立组件：两种布局只共用 Card 与各 handler，
       互不干扰 —— 入场波浪与悬停 3D 倾斜都只发生在墙里，不会和扇形的卡位
       transform 抢（扇形那边显式把卡面 transform 归零）。

       入场波浪的 deps 刻意不含 `skills`：每敲一次搜索都重播一次波浪是踩过的坑，
       只在进入墙模式（本组件挂载）时播一次。 */
    function CardWall({ skills, selected, t, frozen = false, ...cardProps }) {
      const gridRef = useRef(null)
      const prefersReduced = typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false
      const [entrance, setEntrance] = useState(() => !prefersReduced)
      // 波浪跑完就摘掉类名：留着会让每张卡各挂一个合成器动画，也会和悬停倾斜抢 transform。
      useEffect(() => {
        if (!entrance) return
        const id = setTimeout(() => setEntrance(false), 620 + 400 + 80)
        return () => clearTimeout(id)
      }, [entrance])
      // 悬停倾斜（事件委托在容器上，逐卡不挂监听）。真实 DOM 的异常绝不能把整个
      // 面板打成空白 —— 这是"点开一闪而过"那个 bug 的成因，所以照旧 try/catch。
      // deps 里的 skills 不能省：initCard3D 用「当时查到的卡片」做 Set 快照（cardSet），
      // 过滤后新挂载的卡不在快照里、悬停会失效；这与入场波浪刻意不含 skills 是两个理由。
      useEffect(() => {
        const grid = gridRef.current
        if (!grid || frozen || !skills.length) return
        try {
          const cleanup = initCard3D(grid)
          return () => { try { cleanup && cleanup() } catch { /* ignore */ } }
        } catch (err) {
          console.error('[skill-cards] initCard3D failed:', err)
          return () => {}
        }
      }, [skills, frozen])
      return e('div', { className: `dsh-sc-grid${entrance ? ' enter' : ''}`, ref: gridRef },
        skills.map((skill) => e(Card, {
          ...cardProps, key: skill.name, skill, custom: skill.custom,
          selected: selected.has(skill.name), t,
        })))
    }

    function CardFan({ skills, selected, t, initialFocus = null, onFocusChange, ...cardProps }) {
      // 默认把浏览焦点放在卡组正中：扇形左右各有邻牌，一打开就是完整形态，
      // 而且两个方向都能立刻滑。焦点始终以「名字」保存，排序/过滤后仍跟着同一张卡。
      // `initialFocus` 是切回扇形时从墙承接过来的那张（不存在就回落到正中）。
      const [activeName, setActiveName] = useState(() => {
        if (initialFocus && skills.some((s) => s.name === initialFocus)) return initialFocus
        return skills.length ? skills[(skills.length - 1) >> 1].name : null
      })
      const [size, setSize] = useState({ width: 0, height: 0, availableHeight: 0 })
      const [moving, setMoving] = useState(false)
      // 拖动中的横向位移（px）；null 表示当前没有拖动。
      const [dragX, setDragX] = useState(null)
      const handRef = useRef(null)
      const gesture = useRef(null)
      const suppressClick = useRef(false)
      // 用名字保存浏览对象；收藏导致排序改变时，仍以同一张卡为中心。
      const activeIndex = Math.max(0, skills.findIndex((s) => s.name === activeName))
      const current = skills[activeIndex]
      // 把浏览焦点报给面板（面板只写 ref，不触发渲染）：切布局时两边靠它对齐。
      useEffect(() => {
        setActiveName(current?.name || null)
        onFocusChange?.(current?.name || null)
      }, [current?.name, onFocusChange])
      useEffect(() => {
        const el = handRef.current
        if (!el) return
        const stage = el.closest?.('.dsh-sc-stage')
        const measure = () => setSize({ width: el.clientWidth, height: window.innerHeight, availableHeight: stage?.clientHeight || window.innerHeight })
        measure()
        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
        observer?.observe(el)
        if (stage) observer?.observe(stage)
        window.addEventListener('resize', measure)
        return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
      }, [])
      // 仅最终中央卡可开工具弹层；尺寸变化也需等卡牌稳定后再测量。
      useEffect(() => {
        setMoving(true)
        const timer = setTimeout(() => setMoving(false), 480)
        return () => clearTimeout(timer)
      }, [activeIndex, current?.name, size.width, size.height, size.availableHeight])
      const metrics = fanMetrics(size.width, size.height, size.availableHeight)
      const step = metrics.step || 1
      // 拖动位移换算成「卡位」：一格正好一个 step，于是松手时中央卡落在最近的卡位。
      // 到列表头尾、或超过 FAN_DRAG_MAX 之后顶住不动（不做回弹，行为可预期）。
      const dragUnits = dragX == null ? 0 : clampDragUnits(-dragX / step, activeIndex, skills.length)
      const dragging = dragX != null
      // 拖动中高亮跟着「将要居中的那张」走：过半就有反馈，也不会出现一张当前卡都没有的帧
      //（.is-current 还是 reveal 动画取坐标的锚点，必须始终存在）。
      const anchorIndex = activeIndex + (dragging ? Math.round(dragUnits) : 0)
      // 拖动中同样视为「不稳定」：中央卡的悬浮工具栏先收起来，别在拖动里被误点。
      const busy = dragging || moving
      const move = (delta) => {
        const next = Math.max(0, Math.min(skills.length - 1, activeIndex + delta))
        if (next !== activeIndex) setActiveName(skills[next].name)
      }
      const browse = useCallback((name) => {
        if (name === current?.name) cardProps.onToggle(name)
        else setActiveName(name)
      }, [current?.name, cardProps.onToggle])
      // 结束一次拖动：按已经走过的卡位吸附到最近的卡，并复位偏移让过渡接管。
      const settleDrag = (dx) => {
        setDragX(null)
        const units = Math.round(clampDragUnits(-dx / step, activeIndex, skills.length))
        if (units) move(units)
      }
      if (!current) return null
      const custom = current.custom
      const title = custom?.i18n?.zh || custom?.title || current.name
      const desc = custom?.i18n?.zhDesc || custom?.description || current.description || t('origNoDesc')
      // 拖动中多留出几张缓冲卡，跟随方向上的卡才有 DOM 节点可以一起平移。
      const buffer = metrics.radius + 1 + (dragging ? Math.ceil(Math.abs(dragUnits)) + 1 : 0)
      const from = Math.max(0, activeIndex - buffer)
      const mounted = size.width > 0 ? skills.slice(from, activeIndex + buffer + 1) : []
      return e('div', { className: 'dsh-sc-fan' },
        e('div', {
          className: `dsh-sc-fan-hand${dragging ? ' is-dragging' : ''}`, ref: handRef,
          role: 'region', 'aria-label': t('browseCards'), tabIndex: 0,
          style: { height: metrics.height },
          onKeyDown: (ev) => {
            suppressClick.current = false
            if (ev.target !== ev.currentTarget && !ev.target.classList.contains('dsh-sc-cardhit')) return
            if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
            ev.preventDefault()
            // 卡牌移出虚拟窗口后仍保留键盘焦点，避免掉回宿主页面。
            ev.currentTarget.focus({ preventScroll: true })
            move(ev.key === 'ArrowLeft' ? -1 : 1)
          },
          onPointerDown: (ev) => {
            // 已经有一次按下在进行（多指同时触摸）：忽略后来者，也别清掉拖动期间的
            // 点击抑制标记，否则松手时多出来的那次 click 会误勾选。
            if (gesture.current) return
            suppressClick.current = false
            // 鼠标只认左键；工具按钮与卡牌弹层维持原交互，不参与拖动。
            if (!ev.isPrimary || (ev.pointerType === 'mouse' && ev.button !== 0)) return
            if (ev.target.closest?.('.dsh-sc-cardtools, .dsh-sc-cat, .dsh-sc-catpop, .dsh-sc-srcpop')) return
            gesture.current = {
              id: ev.pointerId, x: ev.clientX, y: ev.clientY,
              // 「在卡上」= 落在任何卡位里（卡面、勾选角标都算），只有卡外的留白才算背景。
              onCard: !!ev.target.closest?.('.dsh-sc-fan-slot'),
            }
          },
          onPointerMove: (ev) => {
            const start = gesture.current
            if (!start || ev.pointerId !== start.id) return
            const dx = ev.clientX - start.x
            const dy = ev.clientY - start.y
            if (!start.dragging) {
              // 纵向手势交给 stage 滚动；横向位移够大才接管成拖动。
              if (Math.abs(dx) < FAN_DRAG_START || Math.abs(dx) <= Math.abs(dy)) return
              start.dragging = true
              suppressClick.current = true
              // 指针滑出手部（甚至滑出窗口）后仍要收到事件，否则拖动会半路丢失。
              try { ev.currentTarget.setPointerCapture(ev.pointerId) } catch { /* 老引擎：退化为手部内滑动 */ }
            }
            start.dx = dx
            setDragX(dx)
          },
          onPointerUp: (ev) => {
            const start = gesture.current
            gesture.current = null
            if (!start || ev.pointerId !== start.id) return
            const dx = ev.clientX - start.x
            const dy = ev.clientY - start.y
            if (start.dragging) { settleDrag(start.dx ?? dx); return }
            // 指针事件被合并（快速甩动）时 move 不一定发出：按方向补一张。
            if (Math.abs(dx) >= FAN_DRAG_START && Math.abs(dx) > Math.abs(dy)) {
              suppressClick.current = true
              move(dx < 0 ? 1 : -1)
              return
            }
            if (Math.abs(dx) > FAN_CLICK_SLOP || Math.abs(dy) > FAN_CLICK_SLOP) return
            // 点在卡牌之外的空白上（左右留白）：按点击的那一侧翻一张。
            if (start.onCard) return
            const rect = handRef.current?.getBoundingClientRect?.()
            move(rect && ev.clientX < rect.left + rect.width / 2 ? -1 : 1)
          },
          onPointerCancel: (ev) => {
            if (gesture.current?.id !== ev.pointerId) return
            gesture.current = null
            setDragX(null)
          },
          // 捕获丢失（元素被卸载、系统接管手势）时收尾，避免卡在拖动状态。
          onLostPointerCapture: () => { gesture.current = null; setDragX(null) },
          onClickCapture: (ev) => {
            if (!suppressClick.current) return
            suppressClick.current = false
            ev.preventDefault(); ev.stopPropagation()
          },
        }, mounted.map((skill, index) => {
          // 拖动时整副牌一起平移：小数卡位让位移/旋转/缩放连续变化，松手即可吸附。
          const offset = from + index - activeIndex - dragUnits
          const visible = Math.abs(offset) <= metrics.radius
          const active = from + index === anchorIndex
          return e('div', {
            key: skill.name,
            className: `dsh-sc-fan-slot${active ? ' is-current' : ''}${active && !busy ? ' is-ready' : ''}`,
            'aria-current': active ? 'true' : undefined,
            'aria-hidden': visible ? undefined : 'true', inert: visible ? undefined : '',
            style: { width: metrics.cardWidth, height: metrics.cardHeight, marginLeft: -metrics.cardWidth / 2,
              ...fanPose(offset, metrics), pointerEvents: visible ? 'auto' : 'none' },
          }, e(Card, { ...cardProps, skill, custom: skill.custom, selected: selected.has(skill.name), t,
            isCurrent: active, interactive: active && !busy, onToggle: browse }))
        })),
        e('div', { className: 'dsh-sc-fan-nav' },
          e('button', { type: 'button', onClick: () => move(-1), disabled: activeIndex === 0, 'aria-label': t('previousCard') }, '←'),
          e('span', { className: 'dsh-sc-fan-position', role: 'status', 'aria-live': 'polite' }, `${anchorIndex + 1} / ${skills.length}`),
          e('button', { type: 'button', onClick: () => move(1), disabled: activeIndex === skills.length - 1, 'aria-label': t('nextCard') }, '→')),
        e('p', { className: 'dsh-sc-fan-hint' }, t('fanHint')),
        e('section', { className: 'dsh-sc-details', 'aria-label': title },
          e('h3', null, title),
          e('p', { className: 'dsh-sc-details-desc' }, desc),
          e('div', { className: 'dsh-sc-details-actions' },
            e('button', { type: 'button', 'aria-pressed': selected.has(current.name),
              onClick: () => cardProps.onToggle(current.name) }, selected.has(current.name) ? t('deselectCard') : t('selectCard')),
            e('button', { type: 'button', 'aria-pressed': !!current.starred,
              onClick: () => cardProps.onStar(current.name) }, current.starred ? t('unfavoriteCard') : t('favoriteCard')),
            e('button', { type: 'button', onClick: () => cardProps.onSetImage(current) }, t('setImage')))))
    }

    /* ------------------------------------------------------------------ *
     * Category filter row (chips + sort toggle)
     * ------------------------------------------------------------------ */
    function CatFilterRow({ catDefs, catFilter, setCatFilter, sortBy, setSortBy, counts, t, onManage }) {
      const chips = [
        { id: 'all', label: t('filterAll') },
        { id: 'starred', label: t('filterStarred') },
        ...Object.entries(catDefs).map(([id, def]) => ({ id, label: def.label })),
      ]
      return e('div', { className: 'dsh-sc-catrow' },
        chips.map((c) =>
          e('button', {
            key: c.id, type: 'button', className: 'dsh-sc-catchip' + (catFilter === c.id ? ' active' : ''),
            onClick: () => setCatFilter(c.id), 'aria-pressed': catFilter === c.id ? 'true' : 'false',
          }, c.label, typeof counts[c.id] === 'number' ? e('span', { className: 'n' }, counts[c.id]) : null)),
        e('select', {
          className: 'dsh-sc-sortsel', 'aria-label': t('sortLabel'),
          value: sortBy, onChange: (ev) => setSortBy(ev.target.value),
        },
          e('option', { value: 'default' }, t('sortDefault')),
          e('option', { value: 'uses' }, t('sortByUses')),
          e('option', { value: 'starred' }, t('filterStarred'))))
    }

    /* ------------------------------------------------------------------ *
     * Category manager — add / rename / delete USER-created categories.
     * Built-in (smart) categories are shown but not editable.
     * ------------------------------------------------------------------ */
    function CategoryManager({ catDefs, onAdd, onRename, onDelete, t, onClose }) {
      const [name, setName] = useState('')
      const [renaming, setRenaming] = useState(null) // { id, label }
      const submit = (ev) => {
        ev.preventDefault()
        const txt = name.trim()
        if (!txt) return
        onAdd(txt)
        setName('')
      }
      return e('div', { className: 'dsh-sc-catman modal-mask', onClick: (ev) => { if (ev.target === ev.currentTarget) onClose() } },
        e('div', { className: 'dsh-sc-catman-box', role: 'dialog', 'aria-label': t('manageCats') },
          e('div', { className: 'dsh-sc-catman-head' },
            e('strong', null, t('manageCats')),
            e('button', { className: 'dsh-sc-close', type: 'button', 'aria-label': t('close'), onClick: onClose }, '×')),
          e('form', { className: 'dsh-sc-catman-add', onSubmit: submit },
            e('input', {
              type: 'text', value: name, placeholder: t('catPlaceholder'),
              onChange: (ev) => setName(ev.target.value), 'aria-label': t('addCat'),
            }),
            e('button', { type: 'submit', className: 'dsh-sc-primary', disabled: !name.trim() }, t('addCat'))),
          e('div', { className: 'dsh-sc-catman-note' }, t('builtinCatNote')),
          e('div', { className: 'dsh-sc-catman-list' },
            Object.entries(catDefs).map(([id, def]) => {
              const isCustom = !!def.custom
              return e('div', { key: id, className: 'dsh-sc-catman-item' + (isCustom ? ' custom' : '') },
                renaming && renaming.id === id
                  ? e('form', {
                    className: 'dsh-sc-catman-rename',
                    onSubmit: (ev) => { ev.preventDefault(); onRename(id, renaming.label); setRenaming(null) },
                  },
                    e('input', {
                      type: 'text', value: renaming.label, autoFocus: true,
                      onChange: (ev) => setRenaming({ id, label: ev.target.value }), 'aria-label': t('catNameLabel'),
                    }),
                    e('button', { type: 'submit', className: 'dsh-sc-primary' }, t('saveCat')),
                    e('button', { type: 'button', onClick: () => setRenaming(null) }, t('cancel')))
                  : e('div', { className: 'dsh-sc-catman-row' },
                    e('span', { className: 'dsh-sc-catman-id' }, id),
                    e('span', { className: 'dsh-sc-catman-label' }, def.label),
                    e('span', { className: 'dsh-sc-catman-badge' }, isCustom ? '' : t('builtinLabel')),
                    isCustom ? e('button', { type: 'button', title: t('renameCat'), onClick: () => setRenaming({ id, label: def.label }) }, '✎') : null,
                    isCustom ? e('button', { type: 'button', title: t('deleteCat'), onClick: () => onDelete(id) }, '🗑') : null),
              )
            })),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Capture the on-screen rects for the given skill names before the panel
     * is dismissed, so the burst can start each card from where it actually sat.
     * ------------------------------------------------------------------ */
    function captureCardRects(grid, names) {
      if (!grid || !names || names.length === 0) return []
      const cards = []
      for (const n of names.slice(0, 6)) {
        // 多选可以跨出浏览窗口；缺席的卡仍从中央位置揭示，保留应用反馈。
        const el = grid.querySelector(`.dsh-sc-card[data-name="${n}"]`) || grid.querySelector('.dsh-sc-fan-slot.is-current .dsh-sc-card')
        if (!el) continue
        const r = el.getBoundingClientRect()
        cards.push({ name: n, x: r.left, y: r.top, w: r.width, h: r.height })
      }
      return cards
    }

    /* ------------------------------------------------------------------ *
     * I18n panel — Chinese-localisation via the conversation agent.
     * ------------------------------------------------------------------ *
     * Two modes over one protocol:
     *  - target=null  → batch: lists every untranslated skill;
     *  - target=skill → single card: only that skill, prefilled edit fields.
     * ① Build a prompt and copy it; the user pastes it into the conversation.
     * ② The agent replies with a JSON array; the reply (or a hand edit) is
     *   written via POST /i18n. An agent can also POST that route directly.
     */
    function I18nPanel({ t, skills, target, onClose, onSaved, onError, showToast }) {
      const single = target || null
      const [text, setText] = useState('')
      const [tip, setTip] = useState('')
      // Single-card mode keeps editable zh/zhDesc fields (a translation already
      // on the card prefills them; the user can tweak and re-save without the
      // agent at all).
      const [zh, setZh] = useState(single ? (single.custom?.i18n?.zh ?? '') : '')
      const [zhDesc, setZhDesc] = useState(single ? (single.custom?.i18n?.zhDesc ?? '') : '')
      const untranslated = useMemo(
        () => skills.filter((s) => !(s.custom && s.custom.i18n && s.custom.i18n.zh))
          .map((s) => ({ name: s.name, desc: s.description || '' })),
        [skills])
      const genPrompt = async () => {
        const items = single
          ? [{ name: single.name, desc: single.description || '' }]
          : untranslated.slice(0, 40) // keep the prompt bounded
        if (items.length === 0) { setTip('所有技能都已有中文名了'); return }
        const prompt = buildI18nPrompt(items)
        setText(prompt)
        try { await navigator.clipboard.writeText(prompt); setTip(`✅ 提示词已复制（${items.length} 个技能），粘贴到对话框发给 agent`) }
        catch { setTip('⚠️ 自动复制失败，请手动全选复制') }
      }
      const apply = async () => {
        let items
        try { items = parseI18nReply(text) }
        catch (err) { setTip(`❌ 解析失败：${err.message}；请粘贴 agent 返回的纯 JSON 数组`); return }
        // Single-card mode: force the reply to target ONLY this skill.
        if (single) items = items.filter((it) => it.name === single.name)
        if (items.length === 0) { setTip(single ? `❌ 返回里没有 ${single.name} 的条目` : '❌ 没有有效条目'); return }
        try {
          const res = await api('/i18n', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ items }),
          })
          const names = items.map((it) => `${it.name}→${it.zh}`).join('、')
          setTip(`✅ 已写入 ${res.applied} 条：${names}${res.skipped?.length ? `；跳过 ${res.skipped.length} 条（未知技能名）` : ''}`)
          showToast(`已写入 ${res.applied} 条中文卡名`)
          setTimeout(() => onSaved(), 900)
        } catch (err) { onError(`${t('toastFail')}${err.message}`) }
      }
      // Single-card direct save: no agent round-trip needed for a hand edit.
      const saveSingle = async () => {
        if (!zh.trim()) { setTip('❌ 中文卡名不能为空（清空翻译请用卡片上的 ↺ 还原按钮）'); return }
        try {
          await api('/i18n', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ items: [{ name: single.name, zh: zh.trim(), zhDesc: zhDesc.trim() }] }),
          })
          showToast('已保存中文卡名')
          setTimeout(() => onSaved(), 500)
        } catch (err) { onError(`${t('toastFail')}${err.message}`) }
      }
      return e('div', { className: 'dsh-sc-modal-mask', onClick: (ev) => { if (ev.target === ev.currentTarget) onClose() } },
        e('div', { className: 'dsh-sc-imgform', role: 'dialog', 'aria-modal': 'true', style: { width: 'min(560px,100%)' } },
          e('h4', null, single ? '中文化这张卡' : '技能中文化'),
          e('p', { className: 'dsh-sc-imgform-sub' }, single
            ? `${single.name} — 直接在下面填写保存，或复制提示词发给 agent 后把返回的 JSON 粘入写入。`
            : `① 生成提示词并复制 → 粘贴到对话框发给 agent；② 复制 agent 返回的 JSON 粘到下面，点「写入」。当前未翻译 ${untranslated.length} 个。`),
          single ? [
            e('label', { key: 'zl' }, '中文卡名'),
            e('input', { key: 'zi', type: 'text', value: zh, placeholder: single.name, onChange: (ev) => setZh(ev.target.value) }),
            e('label', { key: 'dl' }, '中文描述'),
            e('textarea', { key: 'dt', rows: 3, value: zhDesc, placeholder: single.description || '', onChange: (ev) => setZhDesc(ev.target.value) }),
          ] : null,
          e('div', { className: 'dsh-sc-file-row', style: { marginTop: single ? 10 : 0, marginBottom: 8 } },
            e('button', { type: 'button', className: 'dsh-sc-file-btn', onClick: genPrompt }, '复制提示词'),
            single
              ? e('button', { type: 'button', className: 'dsh-sc-file-btn dsh-sc-primary', onClick: saveSingle, disabled: !zh.trim() }, '保存')
              : e('button', { type: 'button', className: 'dsh-sc-file-btn', onClick: apply, disabled: !text.trim() }, '② 写入')),
          // Import path: single-card mode keeps the JSON textarea visible too —
          // a translation produced outside this dialog (another agent, another
          // tool) can be pasted in and applied to THIS card only.
          e('textarea', {
            rows: single ? 5 : 9, value: text, style: { width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 8,
              background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
              border: '1px solid var(--dsw-alias-border-l1)', fontSize: 12, fontFamily: 'var(--dsw-alias-font-mono,ui-monospace,Menlo,monospace)' },
            placeholder: single ? '也可在此粘贴 agent 返回的 JSON（[{"name":"…","zh":"…","zhDesc":"…"}]），点下方「导入 JSON」只应用到这张卡' : 'agent 返回的 JSON 数组粘到这里…',
            onChange: (ev) => setText(ev.target.value),
          }),
          single ? e('div', { className: 'dsh-sc-file-row', style: { marginTop: 8 } },
            e('button', { type: 'button', className: 'dsh-sc-file-btn', onClick: apply, disabled: !text.trim() }, '导入 JSON'),
          ) : null,
          tip ? e('p', { className: 'dsh-sc-imgform-sub', style: { marginTop: 8, color: 'var(--dsw-alias-label-secondary)' } }, tip) : null,
          e('div', { className: 'row' }, e('button', { onClick: onClose }, t('close'))),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * ArtPanel — gpt-image-2 prompt builder + generated-art import.
     * ------------------------------------------------------------------ *
     * ① 「复制提示词」 copies a finished Yu-Gi-Oh-style art prompt (category
     *   motif + skill semantics). For a richer subject, 「复制给 agent 润色」
     *   copies an instruction asking the conversation agent to rewrite the
     *   subject line; paste the reply back and it becomes the prompt.
     * ② 生成后把图拖进面板（或选文件）→ POST /image → 自动设为该卡封面，
     *   与「自定义」弹窗共用同一条上传通道。
     */
    function ArtPanel({ skill, t, onClose, onError, showToast, onSaved }) {
      const [text, setText] = useState(() => buildArtPrompt(skill))
      const [tip, setTip] = useState('')
      const [busy, setBusy] = useState(false)
      const [pending, setPending] = useState(null) // { file, previewUrl }
      const fileRef = useRef(null)
      const copy = async (value, msg) => {
        setText(value)
        try { await navigator.clipboard.writeText(value); setTip(msg) }
        catch { setTip('⚠️ 自动复制失败，请手动全选复制') }
      }
      const onPick = (ev) => {
        const file = ev.target.files?.[0]
        if (!file) return
        if (!/^image\/(png|jpe?g|webp|gif|svg\+xml)$/i.test(file.type || '')) {
          onError(t('uploadUnsupported')); ev.target.value = ''; return
        }
        setPending({ file, previewUrl: URL.createObjectURL(file) })
      }
      const onDrop = (ev) => {
        ev.preventDefault()
        const file = ev.dataTransfer?.files?.[0]
        if (!file) return
        if (!/^image\/(png|jpe?g|webp|gif|svg\+xml)$/i.test(file.type || '')) {
          onError(t('uploadUnsupported')); return
        }
        setPending({ file, previewUrl: URL.createObjectURL(file) })
      }
      const applyImage = async () => {
        if (!pending?.file) return
        setBusy(true)
        try {
          const bytes = await pending.file.arrayBuffer()
          const res = await fetch(`${API}/image`, {
            method: 'POST', headers: { 'content-type': pending.file.type || 'image/png' }, body: bytes,
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
          await api('/cards', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: skill.name, image: data.url }),
          })
          showToast('已设为卡面插画')
          onSaved && onSaved()
          onClose()
        } catch (err) { onError(`${t('toastFail')}${err.message}`) } finally { setBusy(false) }
      }
      return e('div', { className: 'dsh-sc-modal-mask', onClick: (ev) => { if (ev.target === ev.currentTarget) onClose() } },
        e('div', { className: 'dsh-sc-imgform', role: 'dialog', 'aria-modal': 'true', style: { width: 'min(600px,100%)' } },
          e('h4', null, '卡图提示词'),
          e('p', { className: 'dsh-sc-imgform-sub' }, `${skill.name} — 复制提示词去 gpt-image-2 生成（无文字、纯角色、竖构图），再把图拖回下面即可设为卡面。`),
          e('div', { className: 'dsh-sc-file-row', style: { marginBottom: 8 } },
            e('button', { type: 'button', className: 'dsh-sc-file-btn', onClick: () => copy(buildArtPrompt(skill), '✅ 提示词已复制（自动版）') }, '复制提示词'),
            e('button', { type: 'button', className: 'dsh-sc-file-btn', onClick: () => copy(ART_PROMPT_TMPL(skill, buildArtPrompt(skill)), '✅ 润色指令已复制，发给对话框 agent，把它的回复粘回下面') }, '复制给 agent 润色')),
          e('textarea', {
            rows: 10, value: text, style: { width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 8,
              background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
              border: '1px solid var(--dsw-alias-border-l1)', fontSize: 11.5, lineHeight: 1.6, fontFamily: 'var(--dsw-alias-font-mono,ui-monospace,Menlo,monospace)' },
            onChange: (ev) => setText(ev.target.value),
          }),
          e('div', {
            onDrop, onDragOver: (ev) => ev.preventDefault(),
            style: { marginTop: 10, padding: '14px', border: '1px dashed var(--dsw-alias-border-l2,#556)', borderRadius: 8,
              textAlign: 'center', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
          },
            pending
              ? e('div', null,
                  e('img', { src: pending.previewUrl, alt: '', style: { maxWidth: '100%', maxHeight: 120, borderRadius: 6, display: 'block', margin: '0 auto 8px' } }),
                  e('div', { className: 'dsh-sc-file-row', style: { justifyContent: 'center' } },
                    e('button', { type: 'button', className: 'dsh-sc-file-btn dsh-sc-primary', onClick: applyImage, disabled: busy }, busy ? t('applying') : '设为卡面插画'),
                    e('button', { type: 'button', className: 'dsh-sc-file-btn', onClick: () => { URL.revokeObjectURL(pending.previewUrl); setPending(null) } }, t('cancel'))))
              : e('div', null, '把生成好的图拖到这里，或',
                  e('button', { type: 'button', className: 'dsh-sc-file-btn', style: { marginLeft: 6 }, onClick: () => fileRef.current?.click() }, '选择文件'),
                  e('div', { style: { marginTop: 6, fontSize: 11 } }, '支持 png/jpg/webp/gif/svg · 上传后存为文件并设为该卡封面'))),
          e('input', { ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', style: { display: 'none' }, onChange: onPick }),
          tip ? e('p', { className: 'dsh-sc-imgform-sub', style: { marginTop: 8, color: 'var(--dsw-alias-label-secondary)' } }, tip) : null,
          e('div', { className: 'row' }, e('button', { onClick: onClose }, t('close'))),
        ),
      )
    }

    /**
     * Self-diagnosis for the gacha card back. Dumps every layer's REAL rendered
     * box plus the image load state and computed sizing to the console, so a
     * "texture only shows a fraction of the card" report can be pinned to an
     * exact layer/measurement instead of guesswork. Enabled by
     * `?scDiag=1` or `localStorage.dshSkillCardsDiag`, harmless otherwise.
     */
    function dumpCardBackDiag(slotEl) {
      try {
        if (typeof document === 'undefined') return
        const flag = (() => {
          try { return localStorage.getItem('dshSkillCardsDiag') === '1' } catch { return false }
        })()
        const on = flag || (typeof location !== 'undefined' && /[?&]scDiag=1/.test(location.search))
        if (!on) return
        const box = (el, label) => {
          if (!el) return { layer: label, missing: true }
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          return {
            layer: label,
            w: Math.round(r.width), h: Math.round(r.height),
            left: Math.round(r.left), top: Math.round(r.top),
            position: cs.position,
            cssWidth: cs.width, cssHeight: cs.height,
            objectFit: cs.objectFit,
            display: cs.display, overflow: cs.overflow,
          }
        }
        const q = (sel) => (slotEl || document).querySelector(sel)
        const img = q('.gc-back-img')
        const rows = [
          box(slotEl, 'slot(.dsh-sc-gacha-slot)'),
          box(q('.dsh-sc-gacha-flip'), 'flip(preserve-3d)'),
          box(q('.dsh-sc-gacha-face.back'), 'face.back'),
          box(q('.gc-backface'), 'backface(red base)'),
          box(img, 'img(texture, green outline)'),
          box(q('.gc-back-tint'), 'tint(yellow)'),
        ]
        const info = {
          viewport: innerWidth + 'x' + innerHeight,
          dpr: devicePixelRatio,
          slotCount: (slotEl ? [slotEl] : [...document.querySelectorAll('.dsh-sc-gacha-slot')]).length,
          imgSrc: img ? img.getAttribute('src') : null,
          imgComplete: img ? img.complete : null,
          imgNatural: img ? img.naturalWidth + 'x' + img.naturalHeight : null,
          imgLoaded: img ? (img.complete && img.naturalWidth > 0) : null,
          textureVar: getComputedStyle(document.documentElement).getPropertyValue('--dsh-sc-back-tex') || '(not set)',
        }
        console.group('[skill-cards] gacha card-back diagnosis')
        console.table(rows)
        console.log('[skill-cards] details', info)
        if (img && !img.complete) {
          img.addEventListener('load', () => console.log('[skill-cards] texture loaded after mount', img.naturalWidth + 'x' + img.naturalHeight), { once: true })
          img.addEventListener('error', () => console.error('[skill-cards] texture FAILED to load:', img.src), { once: true })
        }
        console.groupEnd()
      } catch (err) {
        console.error('[skill-cards] diagnosis failed', err)
      }
    }

    /** Same-origin URL for the bundled card-back texture (resolved once). */
    function backTexUrl() {
      try { return new URL('plugins/dsh-skill-cards/vendor/card-back.jpg', document.baseURI).href }
      catch { return '' }
    }
    /** Anchor a plugin-served image path to the page base (same logic the
        grid card uses) so gacha faces show covers, not the text fallback. */
    function resolveCoverUrl(u) {
      if (!u) return undefined
      try { return new URL(String(u).replace(/^\//, ''), document.baseURI).href } catch { return u }
    }
    /** Compose a card's effective cover URL: custom upload wins, then the
        skill's scanned cover. Shared by the grid and the gacha reveal. */
    function effectiveCoverOf(meta) {
      const custom = meta.custom || null
      return resolveCoverUrl(custom?.image) || resolveCoverUrl(meta.coverUrl) || null
    }

    /* ------------------------------------------------------------------ *
     * GachaReveal — the "draw" show played after "应用到本次会话".
     * ------------------------------------------------------------------ *
     * Card-backs fly in staggered, then flip face-up one by one (SR cards
     * flash gold on reveal). Click anywhere to skip. Replaces the old
     * fly-to-centre burst as the post-apply ceremony; pure CSS, so it works
     * wherever the panel does.
     */
    function GachaReveal({ gacha, onDone }) {
      // Category ids → labels (same resolution the grid card does), so the
      // reveal shows 「设计」 rather than the raw `design` id.
      const catLabelOf = (id) => (gacha.catDefs && gacha.catDefs[id] && gacha.catDefs[id].label) || id || ''
      const FLIP_START = 950   // ms before the first flip
      const FLIP_GAP = 420     // ms between flips
      const TAIL = 1400        // ms after the last flip before auto-dismiss
      const [flipped, setFlipped] = useState(() => new Set())
      const [gone, setGone] = useState(false)
      const timers = useRef([])
      const skip = useCallback(() => {
        for (const id of timers.current) clearTimeout(id)
        timers.current = []
        setGone(true)
        setTimeout(onDone, 180)
      }, [onDone])
      useEffect(() => {
        const count = gacha.cards.length
        for (let i = 0; i < count; i++) {
          timers.current.push(setTimeout(() => {
            setFlipped((prev) => new Set(prev).add(i))
          }, FLIP_START + i * FLIP_GAP))
        }
        timers.current.push(setTimeout(() => { setGone(true); setTimeout(onDone, 220) }, FLIP_START + count * FLIP_GAP + TAIL))
        const onKey = (ev) => { if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === ' ') skip() }
        window.addEventListener('keydown', onKey)
        return () => {
          for (const id of timers.current) clearTimeout(id)
          timers.current = []
          window.removeEventListener('keydown', onKey)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [gacha])
      if (gone) return null
      const metaByName = new Map((gacha.meta || []).map((m) => [m.name, m]))
      return e('div', {
        className: 'dsh-sc-gacha', onClick: skip, role: 'presentation',
      },
        e('div', { className: 'dsh-sc-gacha-row', 'data-count': String(gacha.cards.length) },
          gacha.cards.map((c, i) => {
            const meta = metaByName.get(c.name) || {}
            const custom = meta.custom || null
            const title = custom?.i18n?.zh || custom?.title || c.name
            const desc = custom?.i18n?.zhDesc || custom?.description || meta.description || ''
            const categoryId = meta.category || 'other'
            const uses = typeof meta.uses === 'number' ? meta.uses : 0
            const lv = levelOf(uses)
            const sr = isSrCard(c.name)
            return e('div', {
              key: c.name,
              className: `dsh-sc-gacha-slot enter${flipped.has(i) ? ' flipped' : ''}${flipped.has(i) && sr ? ' flash' : ''}`,
              style: { animationDelay: `${i * 130}ms`, ...gcStyleProps(categoryId) },
            },
              e('div', { className: 'dsh-sc-gacha-flip', ref: (el) => { if (el) dumpCardBackDiag(el.parentElement) } },
                e('div', { className: 'dsh-sc-gacha-face back' },
                  e('div', { className: 'gc-backface' },
                    e('img', { className: 'gc-back-img', src: backTexUrl(), alt: '', draggable: false, 'aria-hidden': 'true' }),
                    e('div', { className: 'gc-back-tint', 'aria-hidden': 'true' }))),
                e('div', { className: 'dsh-sc-gacha-face front' },
                  e('div', { className: `dsh-sc-gcard${sr ? ' sr' : ''}`, style: gcStyleProps(categoryId) },
                    e('div', { className: 'gc-inner' },
                      gcCardChildren({
                        title, desc, img: effectiveCoverOf(meta), glyph: monogram(title),
                        catLabel: catLabelOf(meta.category) || '·', uses, lv, sr,
                      })),
                    e('div', { className: 'gc-foil', 'aria-hidden': 'true' })))),
            )
          })),
        e('div', { className: 'dsh-sc-gacha-skip' }, '点击任意处跳过'),
      )
    }

    /* Debounce for the search box: long enough to coalesce a burst of keystrokes
       into ONE filter+render pass over the card wall, short enough (~120ms) that
       the result list still feels like it tracks the keyboard. */
    const SEARCH_DEBOUNCE_MS = 120
    /* ------------------------------------------------------------------ *
     * Skills panel (shared by the settings section and the modal)
     * ------------------------------------------------------------------ */
    function SkillsPanel({ store, t, onApplyDone, onRequestClose }) {
      const [skills, setSkills] = useState(null)
      // Which directories the host actually scanned, and how many skills each
      // yielded. Shown only in the empty state, where the difference between
      // "the folder does not exist" and "it exists but holds no SKILL.md" is
      // otherwise impossible to tell from the panel alone.
      const [roots, setRoots] = useState([])
      // Local overrides applied on top of the per-skill `custom` the host already
      // embeds in /skills. The host's read of skill-cards.json is the source of
      // truth; this map only reflects edits made in this session, avoiding a
      // second round-trip for /cards on every open.
      const [cardOverrides, setCardOverrides] = useState({})
      // Raw text in the input, and the DEBOUNCED value the filter actually runs
      // on. Typing stays instant (the box is uncontrolled-by-render: it always
      // shows `query`), while the 95-card filter/sort/re-render only runs once
      // the user pauses. Without this, every keystroke re-filtered and re-rendered
      // the whole wall; at ~95 cards that is visible lag on a fast typist.
      // SEARCH_DEBOUNCE_MS is short enough (~120ms) that the list feels live.
      const [query, setQuery] = useState('')
      const [debouncedQuery, setDebouncedQuery] = useState('')
      const queryTimer = useRef(null)
      useEffect(() => {
        clearTimeout(queryTimer.current)
        queryTimer.current = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
        return () => clearTimeout(queryTimer.current)
      }, [query])
      const [selected, setSelected] = useState(() => new Set())
      const [editing, setEditing] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [toast, setToast] = useState('')
      const [fx, setFx] = useState(false)
      // Category filter ("all" | "starred" | <categoryId>).
      const [catFilter, setCatFilter] = useState('all')
      // Sort order ("default" | "uses").
      const [sortBy, setSortBy] = useState('default')
      // True while the "分类管理" dialog is open (add/rename/delete custom categories).
      const [catMgrOpen, setCatMgrOpen] = useState(false)
      // True while the "中文化" panel is open (batch translate prompt builder).
      // i18n panel state: null = batch mode; a skill = single-card mode.
      const [i18nOpen, setI18nOpen] = useState(false)
      // Art-prompt panel state: the skill whose card art is being produced.
      const [artSkill, setArtSkill] = useState(null)
      // The host returns the category dictionary alongside /skills.
      const [catDefs, setCatDefs] = useState({})
      // Local stats overrides (category/starred edits made in this session, not
      // yet persisted — /stats POST is the persist; the host /skills read is the
      // source of truth for what survives a refresh).
      const [statsOverrides, setStatsOverrides] = useState({})
      const toastTimer = useRef(null)
      const gridRef = useRef(null)
      const canvasRef = useRef(null)
      const fxRef = useRef(null)
      // 布局偏好：扇形（默认）/ 网格卡墙。初值取本地镜像，挂载后再用宿主
      // /prefs 的权威值覆盖（见 DEFAULT_LAYOUT 附近的说明）。
      const [layout, setLayout] = useState(() => readCachedLayout())
      // 「当前浏览的那张卡」：扇形居中 / 墙里滚动定位都靠它。存 ref 而不是 state ——
      // 每翻一张牌都重渲染整个面板不值得。
      const focusRef = useRef(null)
      const noteFocus = useCallback((name) => { focusRef.current = name }, [])
      const showToast = useCallback((msg) => {
        setToast(msg)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(''), 2600)
      }, [])

      // 读宿主权威偏好（与分类/封面同一份存储，换入口、换窗口、重启都跟着走）。
      // 读失败就保留镜像/默认值 —— 偏好读不到不该在面板上弹错误。
      useEffect(() => {
        let alive = true
        api('/prefs')
          .then((res) => {
            if (!alive) return
            const served = normalizeLayout(res?.prefs?.layout)
            setLayout(served)
            cacheLayout(served)
          })
          .catch(() => { /* 保留镜像/默认值 */ })
        return () => { alive = false }
      }, [])

      // 切换布局：先乐观更新（点了立刻生效），再落盘。落盘失败**不回滚** ——
      // lib/ 的改动要重启 DSH 才生效，重启前宿主没有 /prefs，回滚会让用户觉得
      // "切不过去"；本地照切 + 写镜像 + 提示，下次打开仍是这个布局。
      const chooseLayout = useCallback(async (next) => {
        const value = normalizeLayout(next)
        if (value === layout) return
        setLayout(value)
        cacheLayout(value)
        try {
          const res = await api('/prefs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ layout: value }),
          })
          // 以宿主返回的权威值为准，避免本地状态与存储长期分叉。
          const served = normalizeLayout(res?.prefs?.layout)
          setLayout(served)
          cacheLayout(served)
        } catch (err) {
          showToast(`${t('toastFail')}${err.message}`)
        }
      }, [layout, showToast, t])

      // 切到墙：把扇形里浏览的那张卡滚进视口并短暂描边，让两边"同一张卡"对得上。
      // 只滚 stage 自己（不用 scrollIntoView，免得连带滚动宿主页面）。
      useEffect(() => {
        if (layout !== 'wall') return
        const name = focusRef.current
        const stage = gridRef.current
        if (!name || !stage) return
        const card = Array.from(stage.querySelectorAll('.dsh-sc-card')).find((el) => el.dataset.name === name)
        if (!card) return
        const target = card.closest('.dsh-sc-card-wrap') || card
        const stageRect = stage.getBoundingClientRect()
        const cardRect = target.getBoundingClientRect()
        const top = stage.scrollTop + (cardRect.top - stageRect.top) - (stageRect.height - cardRect.height) / 2
        stage.scrollTop = Math.max(0, top)
        target.classList.add('focus-flash')
        const id = setTimeout(() => target.classList.remove('focus-flash'), 700)
        return () => { clearTimeout(id); target.classList.remove('focus-flash') }
      }, [layout])

      // Clear the toast timer when the panel unmounts so a stale `setToast`
      // never fires after it is gone.
      useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

      // Close on Escape (the image form first if it is open, then a card
      // popover, then the overlay the panel lives in — the modal or the
      // settings section handler). Card popovers are per-card local state, so
      // the layering is detected from the DOM: this handler is registered at
      // mount and therefore runs BEFORE the popover's own Escape handler, which
      // is what makes "dismiss the menu without losing the panel" possible.
      useEffect(() => {
        const onKey = (ev) => {
          if (ev.key !== 'Escape') return
          if (document.querySelector('.dsh-sc-catpop, .dsh-sc-srcpop')) return
          if (editing) setEditing(null)
          else if (onRequestClose) onRequestClose()
        }
        window.addEventListener('keydown', onKey)
        return () => { window.removeEventListener('keydown', onKey) }
      }, [editing, onRequestClose])

      const load = useCallback(async () => {
        setError('')
        try {
          // /skills already carries each skill's `custom` (from skill-cards.json
          // on the host), so a separate /cards call is redundant.
          const sk = await api('/skills')
          setSkills(sk.skills || [])
          setRoots(Array.isArray(sk.roots) ? sk.roots : [])
          if (sk.categories && typeof sk.categories === 'object') setCatDefs(sk.categories)
          // The server payload is the source of truth: drop every local
          // optimistic override, or a stale one (e.g. an old reset/save made
          // before this refresh) keeps shadowing the fresh i18n data forever —
          // the "writes only appear after closing the app" bug.
          setCardOverrides({})
        } catch (err) {
          console.error('[skill-cards] load failed:', err)
          setError(err.message || String(err))
          setSkills([])
        }
      }, [])

      useEffect(() => { load() }, [load])

      // Seed the selection with the skills already applied to the active
      // session (GET /applied), so re-opening the panel shows them pre-checked
      // instead of inviting a blind re-apply. Runs when the skills load and
      // again whenever the selection is empty (the modal remounts on every
      // open; the settings panel is persistent, so the empty-check also gives
      // the user's manual un-checks precedence — we never re-check a skill the
      // user deliberately deselected, we only seed a blank slate).
      useEffect(() => {
        if (skills === null || selected.size > 0) return
        let disposed = false
        ;(async () => {
          try {
            const ap = await api('/applied')
            if (disposed) return
            const names = ap.skills || []
            // Keep the composer chips in sync with the same answer.
            store.setApplied(names)
            if (names.length > 0) setSelected(new Set(names))
          } catch { /* no session / revoked elsewhere — nothing to seed */ }
        })()
        return () => { disposed = true }
      }, [skills, selected.size, store])

      const merged = useMemo(() => (skills || []).map((s) => {
        const so = statsOverrides[s.name]
        const stats = { ...(s.stats || {}), ...(so || {}) }
        // Effective category: an explicitly-cleared override (null) falls back to
        // the host's auto-suggestion; otherwise a local override wins.
        let category = s.category
        if (so && typeof so.category !== 'undefined') {
          category = so.category === null ? s.suggestedCategory : so.category
        }
        return {
          ...s,
          custom: cardOverrides[s.name] || s.custom || null,
          stats,
          category,
          starred: !!stats.starred,
          uses: typeof stats.uses === 'number' ? stats.uses : 0,
        }
      }), [skills, cardOverrides, statsOverrides])

      // Apply category filter + search + sort (starred first in default order;
      // when filtering "starred" only starred cards remain).
      const filtered = useMemo(() => {
        const q = debouncedQuery.trim().toLowerCase()
        let list = merged
        if (catFilter === 'starred') list = list.filter((s) => s.starred)
        else if (catFilter !== 'all') list = list.filter((s) => s.category === catFilter)
        // The dropdown's "收藏" view also narrows to starred skills.
        if (sortBy === 'starred') list = list.filter((s) => s.starred)
        if (q) list = list.filter((s) => {
          const zh = s.custom?.i18n?.zh || ''
          const zhDesc = s.custom?.i18n?.zhDesc || ''
          return s.name.toLowerCase().includes(q) ||
            (s.custom?.description || s.description || '').toLowerCase().includes(q) ||
            zh.toLowerCase().includes(q) ||
            zhDesc.toLowerCase().includes(q)
        })
        const sorted = [...list]
        if (sortBy === 'uses') sorted.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
        else if (sortBy === 'starred') sorted.sort((a, b) => a.name.localeCompare(b.name))
        else sorted.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || a.name.localeCompare(b.name))
        return sorted
      }, [merged, debouncedQuery, catFilter, sortBy])

      // Per category-count for the filter chips (so "文档 (12)" reads instantly).
      const catCounts = useMemo(() => {
        const counts = { all: merged.length, starred: 0 }
        for (const s of merged) {
          if (s.starred) counts.starred++
          counts[s.category] = (counts[s.category] || 0) + 1
        }
        return counts
      }, [merged])

      // 扇形姿态只由当前浏览索引计算，避免随机 3D 倾斜与切换动画争用 transform。
      // The WebGL particle nebula is the only part that needs three.js. It is
      // purely decorative: created once per structural change (not per search
      // keystroke), disposed on unmount, and its failure (script blocked, no
      // WebGL, init crash) only hides the background — cards stay usable in the fan.
      // `gridVisible` (not `filtered` identity) keeps it from being recreated on
      // every keystroke while still reattaching after the grid reappears.
      const gridVisible = filtered.length > 0
      useEffect(() => {
        if (!gridVisible) return
        let disposed = false
        let scene = null
        try {
          ensureThree().then((THREE) => {
            if (disposed) return
            const canvas = canvasRef.current
            if (canvas) {
              try {
                scene = createParticleScene(canvas, THREE)
              } catch { scene = null }
            }
            if (scene) setFx(true)
          }).catch(() => {
            // three.js unavailable → flat background; the DOM fan already works.
          })
        } catch (err) {
          // never let a real-DOM quirk blank the panel on open
          console.error('[skill-cards] particle init failed:', err)
        }
        return () => {
          disposed = true
          if (scene) { try { scene.dispose() } catch { /* ignore */ } }
        }
      }, [skills, editing, gridVisible])

      const toggle = useCallback((name) => {
        setSelected((prev) => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next })
      }, [])
      const selectAll = useCallback(() => setSelected(new Set(filtered.map((s) => s.name))), [filtered])
      // "清空" clears the selection AND revokes every selected skill that is
      // already applied to the session — opening the panel seeds the selection
      // with applied skills, so clearing must undo those too, not just untick.
      const clear = useCallback(() => {
        const appliedSelected = [...selected].filter((n) => store.get().applied.includes(n))
        setSelected(new Set())
        if (appliedSelected.length > 0) {
          api('/revoke', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: store.get().sessionId, names: appliedSelected }),
          }).then(() => {
            const gone = new Set(appliedSelected)
            store.setApplied(store.get().applied.filter((n) => !gone.has(n)))
            store.notifyRevoked(appliedSelected)
            showToast(`${t('revoke')} × ${appliedSelected.length}`)
          }).catch((err) => showToast(`${t('revokeFail')}${err.message}`))
        }
      }, [selected, store, t, showToast])

      // One-way sync from the composer popover: when chips revoke skills from
      // the session (single × or "remove all"), drop the same names from this
      // panel's selection. The panel never touches the session itself — the
      // popover is the only revocation writer.
      useEffect(() => store.onRevoked((names) => {
        setSelected((prev) => {
          if (prev.size === 0) return prev
          const gone = new Set(names)
          let changed = false
          const next = new Set()
          for (const n of prev) {
            if (gone.has(n)) { changed = true; continue }
            next.add(n)
          }
          return changed ? next : prev
        })
      }), [store])

      // Persist a category / starred change for a skill and reflect it locally.
      const updateStats = useCallback(async (name, patch) => {
        try {
          const res = await api('/stats', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, ...patch }),
          })
          // Reflect the served stats (and, if we cleared, drop to auto-suggested).
          if (res.stats && res.stats[name]) {
            setStatsOverrides((prev) => ({ ...prev, [name]: { ...res.stats[name] } }))
          }
        } catch (err) { showToast(`${t('toastFail')}${err.message}`) }
      }, [t, showToast])

      /* Card handlers hoisted out of the render body. These used to be inline
         arrows, which meant a NEW function identity on every panel render —
         React.memo compares props by identity, so every card re-rendered no
         matter what changed. These read the freshest values through refs, so
         they stay referentially stable for the panel's whole life. */
      const mergedRef = useRef(merged)
      mergedRef.current = merged

      const openImageForm = useCallback((sk) => {
        setEditing({ skill: sk, current: sk.custom || null })
      }, [])

      const toggleStar = useCallback((name) => {
        const cur = mergedRef.current.find((m) => m.name === name)
        updateStats(name, { starred: !(cur && cur.starred) })
      }, [updateStats])

      // Clear the Chinese overlay on one card (the card's ↺ button): POST /cards
      // with i18n:null keeps image/title/description and drops only i18n.
      const resetI18n = useCallback(async (skill) => {
        try {
          const c = skill.custom || {}
          const res = await api('/cards', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: skill.name,
              image: c.image ?? '', title: c.title ?? '', description: c.description ?? '',
              i18n: null,
            }),
          })
          const next = res.cards?.[skill.name] || null
          setCardOverrides((prev) => ({ ...prev, [skill.name]: next }))
          showToast(`已还原 ${skill.name} 的英文原名`)
        } catch (err) { showToast(`${t('toastFail')}${err.message}`) }
      }, [t, showToast])

      /* Same identity rule for the remaining card actions — each of these was
         an inline arrow per render, which defeated React.memo on the card.
         Declared after resetI18n/updateStats so the closures bind real values. */
      const openTranslate = useCallback((sk) => setI18nOpen(sk), [])
      const openArtPrompt = useCallback((sk) => setArtSkill(sk), [])
      const runResetI18n = useCallback((sk) => { resetI18n(sk) }, [resetI18n])
      const setCardCategory = useCallback((name, cat) => {
        updateStats(name, { category: cat })
      }, [updateStats])

      const applyFn = useCallback(async () => {
        const names = [...selected]
        if (names.length === 0) return
        setBusy(true); setError('')
        try {
          let sessionId = store.get().sessionId
          if (!sessionId) {
            try { const a = await api('/active-session'); sessionId = a.sessionId || undefined } catch { /* ignore */ }
          }
          if (!sessionId) { showToast(t('noSession')); setBusy(false); return }
          const res = await api('/introduce', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, names }),
          })
          const okCount = (res.results || []).filter((r) => r.ok).length
          showToast(okCount === names.length ? t('toastApplied') : t('toastAppliedSome'))
          const okNames = (res.results || []).filter((r) => r.ok).map((r) => r.name)
          // Capture each applied card's on-screen position BEFORE the panel is
          // torn down, so the reveal can fly it from where it actually sat.
          const cards = captureCardRects(gridRef.current, okNames)
          // Confirm in the composer area WHICH skills entered this session, so
          // the user knows the apply actually landed on the active session.
          // Merge into (not replace) the applied list — the panel can also be
          // opened from settings, where an earlier apply already landed.
          store.setApplied([...new Set([...store.get().applied, ...okNames])])
          onApplyDone && onApplyDone() // close the modal AFTER capturing rects
          // Gacha reveal: card-backs fly in over the live session, then flip
          // face-up one by one (SR cards flash). Handed to the STORE (not panel
          // state) because the modal closes right here — panel state would be
          // unmounted before the show plays. Skipped under reduced motion.
          const reduced = typeof window !== 'undefined' && window.matchMedia
            ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
            : false
          if (cards.length > 0 && !reduced) {
            // `merged` carries the derived fields (uses / category / custom);
            // raw `skills` only nests them under stats.*, which made the
            // reveal cards show ATK 0.
            const meta = merged.filter((s) => okNames.includes(s.name))
            store.triggerGacha({ cards, meta, catDefs })
          }
          return
        } catch (err) { setError(`${t('toastFail')}${err.message}`) } finally { setBusy(false) }
      }, [selected, store, t, showToast, onApplyDone, merged])

      return e('div', { className: `dsh-sc-panel${fx ? ' fx' : ''}${filtered.length ? ' has-cards' : ''}`, 'data-layout': layout },
        e('div', { className: 'dsh-sc-search-row' },
          skills ? e('span', { className: 'dsh-sc-title-count' }, `${filtered.length}/${skills.length}`) : null,
          e('input', {
            className: 'dsh-sc-search', value: query, placeholder: t('search'),
            'aria-label': t('search'),
            onChange: (ev) => setQuery(ev.target.value),
          })),
        e(CatFilterRow, { catDefs, catFilter, setCatFilter, sortBy, setSortBy, counts: catCounts, t }),
        e('div', { className: 'dsh-sc-toolbar' },
          e('span', { className: 'dsh-sc-selected-count' },
            selected.size > 0 ? `${t('selected')}: ${selected.size}` : t('noneSelected')),
          e('button', { onClick: selectAll, disabled: filtered.length === 0 }, t('selectAll')),
          e('button', { onClick: clear, disabled: selected.size === 0 }, t('clear')),
          e('span', { className: 'dsh-sc-spacer' }),
          // 布局切换：墙 / 扇形。分段控件用两个真按钮 + aria-pressed（与仓库里
          // 其它开关一致，不用 role=radio），键盘可 Tab/Enter，方向键仍归卡组区。
          e('span', { className: 'dsh-sc-layout', role: 'group', 'aria-label': t('layoutGroup') },
            e('button', {
              type: 'button', 'aria-pressed': layout === 'wall' ? 'true' : 'false',
              title: t('layoutWall'), onClick: () => chooseLayout('wall'),
            }, t('layoutWall')),
            e('button', {
              type: 'button', 'aria-pressed': layout === 'fan' ? 'true' : 'false',
              title: t('layoutFan'), onClick: () => chooseLayout('fan'),
            }, t('layoutFan'))),
          e('button', { type: 'button', className: 'dsh-sc-managecats', onClick: () => setCatMgrOpen(true), title: t('manageCats') }, t('manageCats')),
          e('button', { type: 'button', className: 'dsh-sc-managecats', onClick: () => setI18nOpen(true), title: '中文化' }, '中文化'),
          e('button', { className: 'dsh-sc-apply', onClick: applyFn, disabled: busy || selected.size === 0 }, busy ? t('applying') : t('apply'))),
        error ? e('div', { className: 'dsh-sc-err', role: 'alert' }, error) : null,
        e(AppliedChips, { store, t }),
        skills === null
          ? e('div', { className: 'dsh-sc-empty' }, t('loading'))
          : filtered.length === 0
            ? e('div', { className: 'dsh-sc-empty' },
                e('div', null, skills.length === 0 ? t('empty') : t('noMatch')),
                e('div', { className: 'dsh-sc-empty-hint' }, skills.length === 0 ? t('emptyHint') : t('noMatchHint')),
                // Only meaningful when nothing at all was found: list what the
                // host looked at so a missing directory is visibly missing.
                skills.length === 0 && roots.length > 0
                  ? e('div', { className: 'dsh-sc-roots' },
                      e('div', { className: 'dsh-sc-roots-label' }, t('scannedRoots')),
                      e('ul', null,
                        roots.map((r) => e('li', { key: r.path, className: r.exists ? 'exists' : 'missing' },
                          e('code', null, r.path),
                          e('span', { className: 'dsh-sc-roots-note' },
                            r.exists ? `${t('rootEmpty')}${r.found}` : t('rootMissing'))))))
                  : null)
            : e('div', { className: 'dsh-sc-stage', ref: gridRef },
                e('canvas', { ref: canvasRef, className: 'dsh-sc-fx', 'aria-hidden': 'true' }),
                layout === 'wall'
                  ? e(CardWall, {
                      skills: filtered, selected, t, catDefs,
                      frozen: !!editing,
                      onToggle: toggle, onSetImage: openImageForm,
                      onTranslate: openTranslate,
                      onArtPrompt: openArtPrompt,
                      onResetI18n: runResetI18n,
                      onStar: toggleStar,
                      onCategory: setCardCategory,
                    })
                  : e(CardFan, {
                      skills: filtered, selected, t, catDefs,
                      initialFocus: focusRef.current,
                      onFocusChange: noteFocus,
                      onToggle: toggle, onSetImage: openImageForm,
                      onTranslate: openTranslate,
                      onArtPrompt: openArtPrompt,
                      onResetI18n: runResetI18n,
                      onStar: toggleStar,
                      onCategory: setCardCategory,
                    })),
        catMgrOpen ? e(CategoryManager, {
          catDefs, t,
          onAdd: async (label) => {
            try {
              await api('/categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'add', label }) })
              load()
            } catch (err) { showToast(`${t('toastFail')}${err.message}`) }
          },
          onRename: async (id, label) => {
            try {
              await api('/categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'rename', id, label }) })
              load()
            } catch (err) { showToast(`${t('toastFail')}${err.message}`) }
          },
          onDelete: async (id) => {
            try {
              await api('/categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'remove', id }) })
              load()
            } catch (err) { showToast(`${t('toastFail')}${err.message}`) }
          },
          onClose: () => setCatMgrOpen(false),
        }) : null,
        editing ? e(ImageForm, { skill: editing.skill, current: editing.current, t, onClose: () => setEditing(null), onError: showToast, onSaved: (c) => { setCardOverrides((prev) => ({ ...prev, [editing.skill.name]: c })); setEditing(null) } }) : null,
        i18nOpen ? e(I18nPanel, {
          t, skills: merged, target: i18nOpen === true ? null : i18nOpen,
          onClose: () => setI18nOpen(false),
          onSaved: async () => { setI18nOpen(false); await load() },
          onError: showToast, showToast,
        }) : null,
        artSkill ? e(ArtPanel, {
          skill: artSkill, t, onClose: () => setArtSkill(null), onError: showToast, showToast,
          onSaved: () => load(),
        }) : null,
        toast ? e('div', { className: 'dsh-sc-toast' }, toast) : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * Modal (full-screen overlay for the chat-page composer button)
     * ------------------------------------------------------------------ */
    /**
     * Error boundary around the shared skills panel.
     *
     * DSH's slot renderer wraps each slot in its own error boundary, which
     * swallows a render crash and leaves the section blank (the "opens then
     * instantly disappears" / blank-settings failure). Wrapping the panel here
     * keeps the failure INSIDE the plugin: the modal/section stays mounted and
     * shows the actual message, which is the only way to see the real cause
     * without opening devtools.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { err: null }
      }
      static getDerivedStateFromError(err) {
        return { err }
      }
      componentDidCatch(err, info) {
        console.error('[skill-cards] panel crashed:', err, info && info.componentStack)
      }
      render() {
        const err = this.state.err
        if (err) {
          return e('div', { className: 'dsh-sc-err', role: 'alert' },
            e('div', null, '技能面板渲染失败'),
            e('div', { className: 'dsh-sc-empty-hint' },
              (err && err.message) ? err.message : String(err)))
        }
        return this.props.children
      }
    }

    function Modal({ store, t }) {
      return e('div', { className: 'dsh-sc-backdrop', onClick: (ev) => { if (ev.target === ev.currentTarget) store.close() } },
        e('div', { className: 'dsh-sc-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('title') },
          e('div', { className: 'dsh-sc-head' },
            e('div', { className: 'dsh-sc-title' },
              e('span', { className: 'dsh-sc-title-text' }, t('title'))),
            e('button', { className: 'dsh-sc-close', onClick: () => store.close(), 'aria-label': t('close') }, '×')),
          e(PanelBoundary, null,
            e(SkillsPanel, { store, t, onApplyDone: () => store.close(), onRequestClose: () => store.close() }))),
      )
    }

    /* ------------------------------------------------------------------ *
     * Entry components
     * ------------------------------------------------------------------ */
    /**
     * Applied-skills indicator next to the composer button. Collapsed by
     * default to a count pill (so the composer row never grows or wraps);
     * clicking opens an anchored popover with the full chip list. Each chip's
     * × revokes that skill via POST /revoke; the popover header has a
     * clear-all action that revokes everything at once.
     */
    function AppliedChips({ store, t }) {
      const applied = useStore(store).applied
      const [leaving, setLeaving] = useState(() => new Set())
      const [busy, setBusy] = useState(false)
      const [open, setOpen] = useState(false)
      const rootRef = useRef(null)
      // Chinese card names for the chips: one /cards fetch per applied-list
      // change, mapped name → zh (missing entries fall back to the raw name).
      const [zhMap, setZhMap] = useState({})
      useEffect(() => {
        if (applied.length === 0) { setZhMap({}); return }
        let disposed = false
        api('/cards').then((d) => {
          if (disposed) return
          const map = {}
          for (const n of applied) {
            const zh = d.cards?.[n]?.i18n?.zh
            if (zh) map[n] = zh
          }
          setZhMap(map)
        }).catch(() => { /* chips keep English names */ })
        return () => { disposed = true }
      }, [applied])
      // Close the popover on outside click / Escape.
      useEffect(() => {
        if (!open) return
        const close = (ev) => { if (rootRef.current && !rootRef.current.contains(ev.target)) setOpen(false) }
        const onKey = (ev) => { if (ev.key === 'Escape') setOpen(false) }
        window.addEventListener('pointerdown', close)
        window.addEventListener('keydown', onKey)
        return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', onKey) }
      }, [open])
      // Auto-collapse when the list empties out (nothing to show).
      useEffect(() => { if (open && applied.length === 0 && leaving.size === 0) setOpen(false) }, [open, applied.length, leaving.size])
      if (applied.length === 0 && leaving.size === 0) return null
      const revokeNames = async (names) => {
        if (busy || names.length === 0) return
        for (const n of names) setLeaving((prev) => new Set(prev).add(n))
        // let the dissolve animation play before the chips actually disappear
        setTimeout(() => setLeaving((prev) => {
          const n = new Set(prev)
          for (const name of names) n.delete(name)
          return n
        }), 300)
        try {
          setBusy(true)
          await api('/revoke', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: store.get().sessionId, names }),
          })
          const gone = new Set(names)
          store.setApplied(store.get().applied.filter((n) => !gone.has(n)))
          // Tell the panel to drop the same names from its selection — the
          // popover is the single writer of revocations (one-way sync).
          store.notifyRevoked(names)
        } catch (err) {
          console.error('[skill-cards] revoke failed:', err)
        } finally { setBusy(false) }
      }
      const revoke = (name) => revokeNames([name])
      const revokeAll = () => revokeNames([...applied])
      return e('span', { className: `dsh-sc-applied${open ? ' open' : ''}`, ref: rootRef },
        e('button', {
          className: 'dsh-sc-applied-toggle', type: 'button',
          'aria-expanded': open ? 'true' : 'false', 'aria-label': t('appliedTo'),
          onClick: () => setOpen((v) => !v),
        },
          e('span', { className: 'dsh-sc-applied-count', 'aria-hidden': 'true' }, applied.length),
          e('span', { className: 'dsh-sc-applied-label' }, t('appliedTo')),
          e('span', { className: 'dsh-sc-applied-caret', 'aria-hidden': 'true' }, '▾')),
        open ? e('div', { className: 'dsh-sc-chip-pop', role: 'menu', 'aria-label': t('appliedTo') },
          e('div', { className: 'dsh-sc-chip-pop-head' },
            e('span', null, `${t('theseSkills')} · ${applied.length}`),
            e('button', {
              className: 'dsh-sc-chip-clear', type: 'button', role: 'menuitem',
              disabled: busy || applied.length === 0, onClick: revokeAll,
            }, t('revokeAll'))),
          e('div', { className: 'dsh-sc-chip-pop-list' },
            applied.map((name) => {
              const ca = TINT_ACCENTS[tintIndex(name)] || '#6366F1'
              return e('span', {
                key: name, className: `dsh-sc-chip dsh-sc-chip-row${leaving.has(name) ? ' out' : ''}`,
                style: { '--chip-ca': ca }, title: name,
              },
                e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, overflow: 'hidden' } },
                  e('span', { className: 'dsh-sc-chip-dot', 'aria-hidden': 'true' }),
                  e('span', { className: 'dsh-sc-chip-name' }, zhMap[name] || name)),
                e('button', {
                  className: 'dsh-sc-chip-x', type: 'button', role: 'menuitem',
                  'aria-label': `${t('revoke')}: ${name}`,
                  disabled: busy, onClick: () => revoke(name),
                }, '×'))
            }))) : null,
      )
    }

    function ComposerButton({ store, t }) {
      // Host-parity with the version that worked: no hooks, no subscription.
      // DSH's `conversation.input.right` is a session-scoped slot that can
      // remount as sessions change; subscribing here (useStore) was the one
      // behavioural delta in this entry and is not worth a cosmetic chip.
      return e('span', { className: 'dsh-sc-composer' },
        e('button', { className: 'dsh-sc-composer-btn', onClick: () => store.open(), type: 'button' },
          e('span', { className: 'dsh-sc-fab-dot', 'aria-hidden': 'true' }),
          t('nav')),
        e(AppliedChips, { store, t }))
    }

    /**
     * Wrap the entry with an effect that keeps `store.applied` in sync with the
     * host (GET /applied). Runs once per mount of the composer slot — cheap,
     * and it means the chips survive page reloads. Fails silently: no session
     * or a 4xx simply means "nothing applied".
     */
    function withAppliedSync(Component) {
      return function AppliedSynced(props) {
        const { store } = props
        // This window's own session. Passed on every call so the host never has
        // to fall back to its shared "last explicit session" — otherwise two open
        // windows show each other's chips.
        const ownSessionId = useOwnSessionId(props)
        useEffect(() => {
          if (ownSessionId) store.setSession(ownSessionId)
        }, [store, ownSessionId])
        useEffect(() => {
          let disposed = false
          const q = ownSessionId ? `?sessionId=${encodeURIComponent(ownSessionId)}` : ''
          ;(async () => {
            try {
              const ap = await api(`/applied${q}`)
              if (!disposed) store.setApplied(ap.skills || [])
            } catch { /* no session / no applied — chips stay hidden */ }
          })()
          return () => { disposed = true }
        }, [store, ownSessionId])
        // Applying is always one-shot: the skills are revoked when the user
        // submits their next message. See watchComposerSubmit for why the
        // signal is the Enter key and not the draft going empty.
        useEffect(() => watchComposerSubmit(store), [store])
        return e(Component, props)
      }
    }

    /**
     * Revoke the session's skills once the user sends their next message.
     *
     * Semantics: applying skills is ALWAYS one-shot. The user applies a set for
     * the message they are about to send, and the set is torn down as soon as
     * that message is submitted. There is deliberately no toggle — a session-
     * scoped apply that silently persists for every later message is the thing
     * this feature exists to avoid.
     *
     * Why keydown rather than watching the draft drain: the host only clears the
     * editor on `submit-settled` with `ev.ok` (see the submission policy's
     * `commit-draft` effect), i.e. AFTER the turn is accepted, and it may keep
     * the text while the turn is in flight. Watching for "draft went empty" is
     * therefore both late and unreliable. The intent signals are the two the host
     * itself acts on: Enter in the composer, and a click on its primary button
     * (both end in `keyboard.submit(mode, …)`).
     *
     * The host's own markers are used: the editable is
     * div[role=textbox][aria-multiline][data-composer-input], and the primary
     * button is matched by its aria-label. Enter during IME composition and
     * Shift+Enter insert a newline instead of submitting, so both are filtered.
     */
    function watchComposerSubmit(store) {
      if (typeof document === 'undefined') return undefined
      let busy = false

      /** Revoke every applied skill once, then clear the chips. */
      const fire = () => {
        const names = store.get().applied
        if (names.length === 0 || busy) return
        // A second submit while the first is still in flight is not a new send.
        busy = true
        const sessionId = store.get().sessionId
        api('/revoke', { method: 'POST', body: JSON.stringify({ sessionId, names }) })
          .then(() => {
            store.setApplied([])
            store.notifyRevoked(names)
          })
          // A failed revoke must leave the chips alone: claiming the skills are
          // gone when the host still holds them would be a lie.
          .catch(() => { /* keep state; the chips stay accurate */ })
          .finally(() => { busy = false })
      }

      const onKeyDown = (ev) => {
        if (ev.key !== 'Enter') return
        // Shift+Enter inserts a newline; Enter mid-composition picks a candidate.
        if (ev.shiftKey || ev.isComposing || ev.keyCode === 229) return
        if (!ev.target?.closest?.('[data-composer-input]')) return
        fire()
      }

      // The primary button calls the same `keyboard.submit(mode, 'click')` path as
      // Enter, so it must revoke too. The host gives it no data attribute, and
      // BOTH the send and the stop button carry the same `primary` class — so the
      // match is anchored on our own composer entry instead:
      //   1. the clicked button must live in the same input bar as our button
      //      (walk up from `.dsh-sc-composer` until an ancestor contains it),
      //   2. it must look primary (class) or carry a send label,
      //   3. it must not be the stop button (cancelling a turn is not a submit).
      const STOP_HINT = /stop|停止|中止|取消/i
      const SUBMIT_LABELS = new Set([
        '发送消息', '排队发送', '插话发送', '发送',
        'Send message', 'Send', 'Queue message', 'Send as steer', 'Steer', 'Send as follow-up',
      ])
      const sameInputBar = (btn) => {
        const mine = document.querySelector('.dsh-sc-composer')
        if (!mine) return true // cannot verify — do not block the feature
        for (let n = mine.parentElement; n && n !== document.body; n = n.parentElement) {
          if (n.contains(btn)) return true
        }
        return false
      }
      const onDocClick = (ev) => {
        const btn = ev.target?.closest?.('button')
        if (!btn || btn.disabled) return
        const label = (btn.getAttribute('aria-label') || '').trim()
        if (STOP_HINT.test(label)) return
        const looksPrimary = /primary/i.test(String(btn.className || '')) || SUBMIT_LABELS.has(label)
        if (!looksPrimary) return
        if (!sameInputBar(btn)) return
        fire()
      }

      // Capture phase for the key: the host's own keymap stops propagation on
      // Enter, so a bubble-phase listener on document would never see the event.
      document.addEventListener('keydown', onKeyDown, true)
      document.addEventListener('click', onDocClick, true)
      return () => {
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('click', onDocClick, true)
      }
    }

    function Overlay({ store, t }) {
      const state = useStore(store)
      // Nothing at all when idle. The gacha reveal mounts HERE (not inside the
      // panel) because the modal closes on apply — this layer must outlive it
      // for the flip show to play over the live session view.
      if (!state.open && !state.gacha) return null
      return e('div', { className: 'dsh-sc-root' },
        state.open ? e(Modal, { store, t }) : null,
        state.gacha ? e(GachaReveal, { gacha: state.gacha, onDone: () => store.clearGacha() }) : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * Registration
     * ------------------------------------------------------------------ */
    function apply(ctx) {
      const store = createStore()
      ensureStyle()
      const dictionaries = STRINGS
      ctx.effect(() => ctx.locale.register(NS, dictionaries), `${NS}: dictionaries`)
      const t = ctx.locale.bind(NS)

      const register = (slot, meta, component, label) => {
        ctx.slots.inject(slot, () => {
          try {
            const off = ctx.slots.register({ name: slot, ...meta }, component)
            return typeof off === 'function' ? off : () => {}
          } catch (error) {
            console.error(`[${NS}] failed ${label}:`, error)
            return () => {}
          }
        })
      }

      register('shell.overlay',
        { id: NS, order: 20, label: () => t('nav'), locale: NS, inject: () => ({ store, t }) },
        () => e(Overlay, { store, t }), 'shell overlay')

      register('settings.section',
        { id: NS, order: 30, label: () => t('nav'), locale: NS, inject: () => ({ store, t }) },
        (props = {}) => {
          // Standard slot props are React hooks (`useSessions` is a selector
          // hook bound by the slot renderer). They MUST be called at the top of
          // the component, never inside an effect — calling one inside
          // useEffect throws "Rendered more hooks than during the previous
          // render", the slot's error boundary swallows it, and the whole
          // "设置 → 技能" section renders blank.
          const sessionId = useOwnSessionId(props)
          useEffect(() => {
            if (sessionId) store.setSession(sessionId)
          }, [sessionId])
          // The skills manager renders inline — this is the replacement for
          // the removed sidebar entry. The session seed keeps "应用到本次会话"
          // targeting the session the user is actually viewing.
          return e('div', { className: 'dsh-sc-root' },
            e(PanelBoundary, null,
              e(SkillsPanel, { store, t, onApplyDone: () => {}, onRequestClose: () => {} })))
        }, 'settings section')

      register('conversation.input.right',
        { id: NS, order: 10, label: () => t('nav'), locale: NS, inject: () => ({ store, t }) },
        // `props` must reach the wrapper: it carries `useSessions`, the only way
        // to learn which session THIS window is showing.
        (props = {}) => e(withAppliedSync(ComposerButton), { store, t, ...props }), 'composer input right')
    }

    exports.name = NS
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return exports
  },
})
