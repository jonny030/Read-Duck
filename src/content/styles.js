/** 所有注入 UI 的 CSS。放在 JS 裡是因為要餵給 Shadow DOM 的 adoptedStyleSheets。 */

export const TRANSLATION_CSS = `
:host { all: initial; display: block; }
.wrap {
  font: inherit;
  color: inherit;
  line-height: inherit;
  display: block;
  white-space: pre-wrap;
  word-break: break-word;
}
.text { font: inherit; color: inherit; }

/* 譯文樣式 —— 由 host 的 data-style 決定 */
:host([data-style="underline"]) .text {
  text-decoration: underline;
  text-decoration-style: dotted;
  text-decoration-color: rgba(251, 191, 36, .85);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
:host([data-style="background"]) .text {
  background: rgba(251, 191, 36, .16);
  border-radius: 3px;
  padding: 0 2px;
  box-decoration-break: clone;
}
:host([data-style="blur"]) .text {
  filter: blur(4px);
  transition: filter .15s ease;
  cursor: pointer;
}
:host([data-style="blur"]:hover) .text { filter: none; }

/* 載入中的骨架動畫 */
.skeleton {
  display: inline-block;
  width: min(22em, 70%);
  height: .85em;
  vertical-align: middle;
  border-radius: 3px;
  background: linear-gradient(90deg,
    rgba(148,163,184,.18) 25%,
    rgba(148,163,184,.35) 37%,
    rgba(148,163,184,.18) 63%);
  background-size: 400% 100%;
  animation: rd-shimmer 1.4s ease infinite;
}
@keyframes rd-shimmer { 0% { background-position: 100% 50% } 100% { background-position: 0 50% } }
@media (prefers-reduced-motion: reduce) { .skeleton { animation: none } }

.error {
  font: inherit;
  font-size: .9em;
  color: #b45309;
  cursor: pointer;
  border-bottom: 1px dashed currentColor;
}
:host([data-state="pending"]) .text { display: none; }
:host([data-state="done"]) .skeleton,
:host([data-state="error"]) .skeleton { display: none; }
:host([data-state="pending"]) .error,
:host([data-state="done"]) .error { display: none; }
`;

/** 浮動按鈕 + 劃選工具列 + 結果面板共用的一套 UI 樣式。 */
export const PANEL_CSS = `
:host {
  all: initial;
  --rd-bg: #ffffff;
  --rd-fg: #1f2937;
  --rd-muted: #6b7280;
  --rd-border: rgba(15, 23, 42, .12);
  --rd-accent: #fbbf24;
  --rd-shadow: 0 8px 28px rgba(15, 23, 42, .16), 0 2px 6px rgba(15, 23, 42, .08);
  font-family: system-ui, -apple-system, "Noto Sans TC", "PingFang TC", sans-serif;
}
/*
 * 主題三態。這裡是注入到網頁裡的 Shadow DOM，讀不到擴充功能頁面的
 * <html data-theme>，所以由 ui.setTheme() 把屬性掛在 shadow host 上。
 *
 * 媒體查詢的 :not([data-theme="light"]) 是關鍵：少了它，系統是深色時
 * 使用者選淺色會沒有反應。tests/browser/run.mjs 會模擬系統深色驗證這件事。
 */
@media (prefers-color-scheme: dark) {
  :host(:not([data-theme="light"])) {
    --rd-bg: #1f2937;
    --rd-fg: #f1f5f9;
    --rd-muted: #94a3b8;
    --rd-border: rgba(255, 255, 255, .14);
    --rd-shadow: 0 8px 28px rgba(0, 0, 0, .5), 0 2px 6px rgba(0, 0, 0, .3);
  }
}
:host([data-theme="dark"]) {
  --rd-bg: #1f2937;
  --rd-fg: #f1f5f9;
  --rd-muted: #94a3b8;
  --rd-border: rgba(255, 255, 255, .14);
  --rd-shadow: 0 8px 28px rgba(0, 0, 0, .5), 0 2px 6px rgba(0, 0, 0, .3);
}
* { box-sizing: border-box; }

/* 浮動按鈕與它懸停時展開的功能選單。
   兩者放在同一個 flex 容器裡，中間的 gap 也算在容器範圍內，
   所以游標從鴨子移到上方按鈕的過程不會離開 hover 區域。 */
.fab-stack {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.fab-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  opacity: 0;
  transform: translateY(8px) scale(.85);
  pointer-events: none;
  transition: opacity .14s ease, transform .14s ease;
}
.fab-stack:hover .fab-actions,
.fab-stack:focus-within .fab-actions {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
@media (prefers-reduced-motion: reduce) {
  .fab-actions { transition: none; }
}

.fab-action {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--rd-border);
  background: var(--rd-bg);
  color: var(--rd-fg);
  box-shadow: var(--rd-shadow);
  cursor: pointer;
  padding: 0;
  display: grid;
  place-items: center;
  font-family: inherit;
  font-size: 15px;
  font-weight: 600;
  line-height: 1;
  transition: transform .12s ease, background .12s ease;
}
.fab-action:hover { background: rgba(251, 191, 36, .22); transform: scale(1.08); }
.fab-action:active { transform: scale(.94); }
.fab-action:focus-visible { outline: 2px solid var(--rd-accent); outline-offset: 2px; }
.fab-action svg { width: 17px; height: 17px; display: block; }

.fab {
  position: relative;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  border: 1px solid var(--rd-border);
  background: var(--rd-bg);
  box-shadow: var(--rd-shadow);
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 0;
  transition: transform .12s ease;
}
.fab:hover { transform: scale(1.06); }
.fab:active { transform: scale(.96); }
.fab svg { width: 26px; height: 26px; display: block; }
.fab[data-active="true"] { outline: 2px solid var(--rd-accent); outline-offset: 2px; }
.fab .badge {
  position: absolute;
  inset: auto -2px -2px auto;
  min-width: 16px; height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--rd-accent);
  color: #1f2937;
  font-size: 10px; font-weight: 700; line-height: 16px;
  text-align: center;
}

.toolbar {
  position: absolute;
  display: flex;
  gap: 2px;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid var(--rd-border);
  background: var(--rd-bg);
  box-shadow: var(--rd-shadow);
  z-index: 2147483000;
}
.toolbar button {
  font: inherit;
  font-size: 13px;
  color: var(--rd-fg);
  background: none;
  border: 0;
  border-radius: 7px;
  padding: 5px 10px;
  cursor: pointer;
  white-space: nowrap;
}
.toolbar button:hover { background: rgba(251, 191, 36, .18); }

.panel {
  position: absolute;
  width: min(420px, calc(100vw - 32px));
  max-height: min(58vh, 520px);
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  border: 1px solid var(--rd-border);
  background: var(--rd-bg);
  color: var(--rd-fg);
  box-shadow: var(--rd-shadow);
  z-index: 2147483000;
  overflow: hidden;
}
.panel header {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 10px 9px 12px;
  border-bottom: 1px solid var(--rd-border);
  font-size: 12px; font-weight: 600; color: var(--rd-muted);
  letter-spacing: .02em;
  cursor: grab;
  /* 拖曳時不要順手選到標題文字 */
  -webkit-user-select: none;
  user-select: none;
  touch-action: none;
}
.panel[data-dragging] header { cursor: grabbing; }
/* 拖曳中連內文的選取也停掉，否則游標掃過內文會反白一整片 */
.panel[data-dragging] .body { -webkit-user-select: none; user-select: none; }
/* 按鈕上不要顯示成可拖曳，它們有自己的行為 */
.panel header button { cursor: pointer; }
.panel header .grow { flex: 1; }
.panel header button {
  font: inherit; font-size: 12px;
  border: 0; background: none; color: var(--rd-muted);
  padding: 3px 7px; border-radius: 6px; cursor: pointer;
}
.panel header button:hover { background: rgba(148, 163, 184, .2); color: var(--rd-fg); }
.panel .body {
  padding: 12px;
  overflow: auto;
  font-size: 14px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  -webkit-user-select: text;
  user-select: text;
}
.panel .body .caret {
  display: inline-block;
  width: 2px; height: 1em;
  vertical-align: -.15em;
  background: var(--rd-accent);
  animation: rd-blink 1s steps(2) infinite;
}
@keyframes rd-blink { 50% { opacity: 0 } }
.panel .hint { color: var(--rd-muted); font-size: 12px; }
.panel .confirm { display: flex; flex-direction: column; gap: 8px; }
.panel .confirm strong { font-size: 14px; }
.panel .confirm p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--rd-muted); white-space: pre-wrap; }
.panel .confirm-actions { display: flex; gap: 7px; margin-top: 2px; }
.panel .confirm-actions button {
  font: inherit; font-size: 13px;
  border: 1px solid var(--rd-border);
  background: none; color: var(--rd-fg);
  border-radius: 7px; padding: 6px 12px; cursor: pointer;
}
.panel .confirm-actions button:hover { background: rgba(148, 163, 184, .2); }
.panel .confirm-actions button.primary {
  background: var(--rd-accent); border-color: var(--rd-accent);
  color: #1f2937; font-weight: 650;
}
.panel .confirm-actions button.primary:hover { filter: brightness(1.06); }
.panel .err { color: #dc2626; font-size: 13px; white-space: pre-wrap; }

.toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  max-width: min(520px, calc(100vw - 32px));
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--rd-border);
  background: var(--rd-bg);
  color: var(--rd-fg);
  box-shadow: var(--rd-shadow);
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  z-index: 2147483000;
  display: flex; gap: 10px; align-items: flex-start;
}
.toast .grow { flex: 1; }
.toast button {
  font: inherit; font-size: 12px; font-weight: 600;
  border: 1px solid var(--rd-border); background: none; color: var(--rd-fg);
  border-radius: 6px; padding: 4px 9px; cursor: pointer; white-space: nowrap;
}
.toast button:hover { background: rgba(251, 191, 36, .2); }
.toast .progress {
  height: 3px; border-radius: 2px; margin-top: 7px;
  background: rgba(148, 163, 184, .25); overflow: hidden;
}
.toast .progress i { display: block; height: 100%; background: var(--rd-accent); transition: width .2s ease; }
`;
