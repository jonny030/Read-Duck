import { TRANSLATION_CSS } from './styles.js';
import { UNIT_ATTR, SRC_ATTR } from './collector.js';

/**
 * 譯文節點的注入與移除。
 *
 * 每個譯文用一個 <readduck-translation> 自訂元素，內容包在 Shadow DOM 裡。
 * 用 Shadow DOM 的理由：網站的 CSS（`article * { ... }`、`p > * { display:inline }`
 * 之類）不會誤傷我們的節點，我們也不會汙染網站。字型與顏色屬於繼承性屬性，
 * 仍然會從原段落繼承下來，所以譯文看起來像是網站自己的內容。
 */

const TAG = 'readduck-translation';

/** 所有譯文節點共用同一份 stylesheet，避免每段各存一份。 */
let sheet = null;
function getSheet() {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(TRANSLATION_CSS);
  }
  return sheet;
}

/** id -> { host, textEl, unit } */
const nodes = new Map();
let currentStyle = 'underline';
let currentScale = 1;

export function setStyle(styleName) {
  currentStyle = styleName;
  for (const { host } of nodes.values()) host.setAttribute('data-style', styleName);
}

export function setFontScale(scale) {
  currentScale = scale;
  for (const { host } of nodes.values()) applyHostStyle(host);
}

function applyHostStyle(host) {
  const inline = host.getAttribute('data-mode') === 'inline';
  // 用 inline style + !important，因為 :host 規則會被網頁的樣式表蓋過去
  host.style.cssText = [
    inline ? 'display:inline!important' : 'display:block!important',
    'all:revert',
    inline ? '' : 'margin-top:.35em!important',
    currentScale !== 1 ? `font-size:${currentScale}em!important` : '',
    'color:inherit',
  ].filter(Boolean).join(';');
}

/** 建立（或取得）某個單元的譯文節點。 */
export function ensure(unit) {
  const existing = nodes.get(unit.id);
  if (existing?.host.isConnected) return existing;

  const host = document.createElement(TAG);
  host.setAttribute(SRC_ATTR, 'translation');
  host.setAttribute('data-for', unit.id);
  host.setAttribute('data-style', currentStyle);
  host.setAttribute('data-state', 'pending');
  host.setAttribute('data-mode', unit.mode);
  host.setAttribute('translate', 'no');
  host.setAttribute('lang', 'zh-Hant');
  applyHostStyle(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.adoptedStyleSheets = [getSheet()];
  shadow.innerHTML =
    '<span class="wrap"><span class="skeleton"></span>' +
    '<span class="text"></span><span class="error" role="button" tabindex="0"></span></span>';

  const entry = {
    host,
    textEl: shadow.querySelector('.text'),
    errEl: shadow.querySelector('.error'),
    unit,
  };

  if (unit.mode === 'inline' && unit.anchor?.parentNode) {
    unit.anchor.parentNode.insertBefore(host, unit.anchor.nextSibling);
  } else {
    // 附加在元素內部而非當兄弟節點：這樣表格儲存格、清單項目、標題的
    // 版面與樣式（含字級）都會自然套用到譯文上。
    unit.el.appendChild(host);
  }

  nodes.set(unit.id, entry);
  return entry;
}

export function setPending(unit) {
  const e = ensure(unit);
  e.host.setAttribute('data-state', 'pending');
  return e;
}

export function setText(unit, text) {
  const e = ensure(unit);
  e.textEl.textContent = text;
  e.host.setAttribute('data-state', 'done');
  return e;
}

export function setError(unit, message, onRetry) {
  const e = ensure(unit);
  e.errEl.textContent = message || '翻譯失敗，點此重試';
  e.errEl.title = message || '';
  e.host.setAttribute('data-state', 'error');
  if (onRetry) {
    e.errEl.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); onRetry(); };
    e.errEl.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onRetry(); } };
  }
  return e;
}

export function has(id) {
  return nodes.has(id) && nodes.get(id).host.isConnected;
}

export function remove(id) {
  const e = nodes.get(id);
  if (!e) return;
  e.host.remove();
  nodes.delete(id);
}

export function count() {
  return nodes.size;
}

/**
 * 全部移除並還原頁面。開關切換時一定要呼叫，否則會留下孤兒節點，
 * 下一次開啟時就會出現重複譯文。
 */
export function teardown() {
  for (const e of nodes.values()) e.host.remove();
  nodes.clear();
  // 保險起見，把可能因為網站重繪而脫離管理的節點也清掉
  for (const el of document.querySelectorAll(TAG)) el.remove();
  for (const el of document.querySelectorAll(`[${UNIT_ATTR}]`)) {
    el.removeAttribute(UNIT_ATTR);
    el.removeAttribute(SRC_ATTR);
  }
}
