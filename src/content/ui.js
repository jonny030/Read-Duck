import { PANEL_CSS } from './styles.js';

/**
 * 頁面上所有浮動 UI（浮動按鈕、劃選工具列、結果面板、提示訊息）。
 * 全部掛在同一個 Shadow DOM 容器裡，與網頁樣式互不干擾。
 */

let root = null;

function ensureRoot() {
  if (root?.host.isConnected) return root;
  const host = document.createElement('readduck-ui');
  host.setAttribute('data-readduck', 'ui');
  host.setAttribute('translate', 'no');
  host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;';
  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(PANEL_CSS);
  shadow.adoptedStyleSheets = [sheet];
  (document.documentElement || document.body).appendChild(host);
  root = { host, shadow };
  return root;
}

/* ---------------------------------------------------------------- 浮動按鈕 */

let fabStack = null;
let fab = null;

/**
 * 鴨子圖案。刻意內嵌 SVG，而不是用 <img src=chrome.runtime.getURL(...)>。
 *
 * 注入到網頁裡的 <img> 要載入擴充功能的檔案，那個路徑必須列在 manifest 的
 * web_accessible_resources 裡，否則會被擋掉、變成破圖。內嵌就完全不需要
 * 對網站多開放任何資源，而且任何尺寸都清晰。
 *
 * 這裡沒有工具列圖示上的那條底線 —— 那是為方形畫布設計的，塞進 26px
 * 的圓形按鈕裡只會顯得擁擠。
 */
const DUCK_SVG = `
<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
  <polygon points="7.2,14.4 2.4,10.56 5.76,17.28" fill="#fbbf24"/>
  <ellipse cx="10.8" cy="14.76" rx="6.72" ry="4.44" fill="#fbbf24"/>
  <ellipse cx="14.04" cy="12" rx="2.52" ry="3.84" fill="#fbbf24"/>
  <ellipse cx="14.76" cy="8.52" rx="3.72" ry="3.6" fill="#fbbf24"/>
  <polygon points="17.64,7.68 22.68,9 17.64,10.32" fill="#f97316"/>
  <circle cx="15.72" cy="7.68" r="0.9" fill="#1f2937"/>
</svg>`;

/**
 * 齒輪。八個短齒繞中心旋轉，中央挖空。
 * 齒要短而寬 —— 細長的齒看起來會像太陽而不是齒輪。
 */
const GEAR_SVG = `
<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
  <g fill="currentColor">
    ${[0, 45, 90, 135, 180, 225, 270, 315]
      .map((deg) => `<rect x="10.2" y="3.1" width="3.6" height="5" rx="1" transform="rotate(${deg} 12 12)"/>`)
      .join('\n    ')}
    <circle cx="12" cy="12" r="6.3"/>
  </g>
  <circle cx="12" cy="12" r="2.7" fill="var(--rd-bg)"/>
</svg>`;

/**
 * 掛上浮動按鈕。滑鼠移上去（或用鍵盤 focus 進來）時展開「摘要」與「設定」。
 *
 * 這支模組刻意不依賴任何 chrome.* API，所以除了一般網頁的 content script，
 * PDF 檢視器那種擴充功能頁面也能直接拿來用。
 */
export function showFab({ onClick, onContextMenu, onSummary, onOptions, title }) {
  const { shadow } = ensureRoot();
  if (fabStack?.isConnected) return fab;

  fabStack = document.createElement('div');
  fabStack.className = 'fab-stack';

  const actions = document.createElement('div');
  actions.className = 'fab-actions';
  if (onOptions) actions.appendChild(makeAction('設定', GEAR_SVG, onOptions));
  if (onSummary) actions.appendChild(makeAction('摘要側欄', '摘', onSummary));

  fab = document.createElement('button');
  fab.className = 'fab';
  fab.type = 'button';
  fab.title = title ?? 'ReadDuck：切換雙語對照';
  fab.setAttribute('aria-label', fab.title);
  fab.innerHTML = DUCK_SVG;
  fab.addEventListener('click', onClick);
  if (onContextMenu) {
    fab.addEventListener('contextmenu', (e) => { e.preventDefault(); onContextMenu(e); });
  }

  fabStack.append(actions, fab);
  shadow.appendChild(fabStack);
  return fab;
}

function makeAction(label, content, onClick) {
  const btn = document.createElement('button');
  btn.className = 'fab-action';
  btn.type = 'button';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  if (content.trim().startsWith('<svg')) btn.innerHTML = content;
  else btn.textContent = content;
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(e); });
  return btn;
}

export function hideFab() {
  fabStack?.remove();
  fabStack = null;
  fab = null;
}

export function setFabState(active, badge) {
  if (!fab) return;
  fab.setAttribute('data-active', String(!!active));
  let el = fab.querySelector('.badge');
  if (badge == null || badge === '') {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('span');
    el.className = 'badge';
    fab.appendChild(el);
  }
  el.textContent = String(badge);
}

/* -------------------------------------------------------------- 劃選工具列 */

let toolbar = null;

/**
 * @param {DOMRect} rect 選取範圍的視窗座標
 * @param {Array<{label:string, onClick:Function}>} buttons
 */
export function showToolbar(rect, buttons) {
  const { shadow } = ensureRoot();
  hideToolbar();
  toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = b.label;
    // 用 mousedown 而非 click：click 之前選取範圍就會被清掉
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); b.onClick(); });
    toolbar.appendChild(btn);
  }
  shadow.appendChild(toolbar);
  positionNear(toolbar, rect, 8);
  return toolbar;
}

export function hideToolbar() {
  toolbar?.remove();
  toolbar = null;
}

/* ---------------------------------------------------------------- 結果面板 */

let panel = null;

/**
 * 建立串流結果面板。
 * @returns {{ setText, appendCaret, setError, setStatus, close, el }}
 */
export function showPanel(rect, title, { onClose, actions = [] } = {}) {
  const { shadow } = ensureRoot();
  closePanel();

  panel = document.createElement('div');
  panel.className = 'panel';

  const header = document.createElement('header');
  const label = document.createElement('span');
  label.textContent = title;
  header.appendChild(label);
  const grow = document.createElement('span');
  grow.className = 'grow';
  header.appendChild(grow);

  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = a.label;
    btn.addEventListener('click', () => a.onClick(api));
    header.appendChild(btn);
  }
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  closeBtn.title = '關閉（Esc）';
  closeBtn.addEventListener('click', () => { closePanel(); onClose?.(); });
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'body';

  panel.append(header, body);
  shadow.appendChild(panel);
  positionNear(panel, rect, 10);

  const onKey = (e) => {
    if (e.key === 'Escape') { closePanel(); onClose?.(); }
  };
  document.addEventListener('keydown', onKey, true);

  const api = {
    el: panel,
    setText(text, streaming) {
      body.textContent = text;
      if (streaming) {
        const caret = document.createElement('span');
        caret.className = 'caret';
        body.appendChild(caret);
      }
      body.scrollTop = body.scrollHeight;
    },
    getText: () => body.textContent,
    setStatus(text) {
      body.innerHTML = '';
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = text;
      body.appendChild(hint);
    },
    setError(text) {
      body.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'err';
      err.textContent = text;
      body.appendChild(err);
    },
    /**
     * 問使用者要不要繼續。回傳 Promise<boolean>。
     * 面板被關掉或動作被中止時解析為 false，不會卡住呼叫端。
     */
    setConfirm({ title, message, confirmLabel, cancelLabel = '取消', signal }) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

        body.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'confirm';
        if (title) {
          const h = document.createElement('strong');
          h.textContent = title;
          wrap.appendChild(h);
        }
        const p = document.createElement('p');
        p.textContent = message;
        const row = document.createElement('div');
        row.className = 'confirm-actions';
        const yes = document.createElement('button');
        yes.type = 'button';
        yes.className = 'primary';
        yes.textContent = confirmLabel;
        yes.addEventListener('click', () => finish(true));
        const no = document.createElement('button');
        no.type = 'button';
        no.textContent = cancelLabel;
        no.addEventListener('click', () => finish(false));
        row.append(yes, no);
        wrap.append(p, row);
        body.appendChild(wrap);
        yes.focus();

        signal?.addEventListener('abort', () => finish(false), { once: true });
      });
    },
    close() { document.removeEventListener('keydown', onKey, true); closePanel(); },
  };
  panel.__api = api;
  panel.__onKey = onKey;
  return api;
}

export function closePanel() {
  if (panel?.__onKey) document.removeEventListener('keydown', panel.__onKey, true);
  panel?.remove();
  panel = null;
}

export function isPanelOpen() {
  return !!panel?.isConnected;
}

/* ---------------------------------------------------------------- 提示訊息 */

let toast = null;
let toastTimer = null;

/**
 * @param {string} message
 * @param {{ actions?: Array<{label, onClick}>, timeout?: number, progress?: number|null }} opts
 */
export function showToast(message, { actions = [], timeout = 6000, progress = null } = {}) {
  const { shadow } = ensureRoot();
  hideToast();

  toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');

  const grow = document.createElement('div');
  grow.className = 'grow';
  const text = document.createElement('div');
  text.textContent = message;
  grow.appendChild(text);

  let bar = null;
  if (progress != null) {
    const wrap = document.createElement('div');
    wrap.className = 'progress';
    bar = document.createElement('i');
    bar.style.width = `${Math.round(progress * 100)}%`;
    wrap.appendChild(bar);
    grow.appendChild(wrap);
  }
  toast.appendChild(grow);

  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = a.label;
    btn.addEventListener('click', () => a.onClick(api));
    toast.appendChild(btn);
  }
  shadow.appendChild(toast);

  clearTimeout(toastTimer);
  if (timeout > 0) toastTimer = setTimeout(hideToast, timeout);

  const api = {
    update(msg, p) {
      text.textContent = msg;
      if (bar && p != null) bar.style.width = `${Math.round(p * 100)}%`;
    },
    close: hideToast,
  };
  return api;
}

export function hideToast() {
  clearTimeout(toastTimer);
  toast?.remove();
  toast = null;
}

/* ------------------------------------------------------------------ 共用 */

/**
 * 把浮層放在目標矩形附近，並確保不會超出視窗。
 * 用 absolute + 頁面座標（而非 fixed），這樣頁面捲動時浮層會跟著內容走。
 */
function positionNear(el, rect, gap) {
  const sx = window.scrollX, sy = window.scrollY;
  // 先量尺寸
  el.style.visibility = 'hidden';
  el.style.left = '0px';
  el.style.top = '0px';
  const w = el.offsetWidth, h = el.offsetHeight;

  let left = sx + rect.left + rect.width / 2 - w / 2;
  let top = sy + rect.bottom + gap;

  // 下方放不下就翻到上方
  if (rect.bottom + gap + h > window.innerHeight && rect.top - gap - h > 0) {
    top = sy + rect.top - gap - h;
  }
  const maxLeft = sx + window.innerWidth - w - 8;
  left = Math.min(Math.max(left, sx + 8), Math.max(sx + 8, maxLeft));

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.visibility = '';
}

export function teardownUi() {
  hideToolbar();
  closePanel();
  hideToast();
  hideFab();
  root?.host.remove();
  root = null;
}
