/**
 * 段落收集：把網頁切成一個個「翻譯單元」。
 *
 * 演算法：不是比對一份標籤白名單（那對真實網站太脆弱），而是
 *   1. 走訪所有有意義的文字節點
 *   2. 對每個文字節點往上找到最近的「非 inline」祖先，以它為分組鍵
 *   3. 同一祖先底下的文字節點合併成一個翻譯單元
 *
 * 這樣 `<p>Hello <a>world</a></p>` 是一個單元（不會被連結拆成兩段），
 * `<div><span>a</span><span>b</span></div>` 也會正確合併。
 *
 * 特別處理「混合容器」：`<div><div class="meta">…</div>正文文字</div>`
 * 外層 div 既有巢狀單元、又有自己的散落文字。此時外層只翻譯散落文字，
 * 譯文插在該段文字之後，而不是把整個外層重複翻一次。
 */

/** 這些標籤底下的內容整棵跳過。 */
const SKIP_SUBTREE = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'PRE', 'TEXTAREA', 'SELECT', 'OPTION',
  'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'AUDIO', 'VIDEO', 'MAP',
  'RUBY', 'RT', 'RP', 'READDUCK-TRANSLATION',
]);

/** 這些標籤視為 inline，不會單獨成為翻譯單元。 */
const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'BIG', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM',
  'FONT', 'I', 'INS', 'KBD', 'LABEL', 'MARK', 'NOBR', 'Q', 'S', 'SAMP', 'SMALL',
  'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TIME', 'TT', 'U', 'VAR', 'WBR', 'OUTPUT',
  'PICTURE', 'IMG', 'BR', 'BUTTON',
]);

/** 不該被翻譯的語意標記。 */
const SKIP_SELECTOR = [
  '[translate="no"]',
  '.notranslate',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[aria-hidden="true"]',
  '[data-readduck]',
  'readduck-translation',
].join(',');

const HAS_LETTER = /\p{L}/u;
/** 純網址、純數字、純標點的段落沒有翻譯價值。 */
const URL_ONLY = /^(https?:\/\/|www\.)\S+$/i;

export const UNIT_ATTR = 'data-readduck-id';
export const SRC_ATTR = 'data-readduck';

let nextId = 1;

/**
 * @param {Element} root
 * @param {{ minTextLength?: number }} opts
 * @returns {Array<{ id, el, text, mode, anchor }>}
 *   mode 'block'：譯文附加在 el 內部最後面
 *   mode 'inline'：譯文插在 anchor 節點之後（混合容器的散落文字）
 */
export function collect(root = document.body, { minTextLength = 4 } = {}) {
  if (!root) return [];

  /** 這一輪的 display 快取。getComputedStyle 很貴，同一個元素會被問很多次。 */
  const displayCache = new WeakMap();
  /** Element -> 直屬於它的文字節點 */
  const groups = new Map();

  const scanRoot = root.nodeType === Node.ELEMENT_NODE ? root : document.body;
  const walker = document.createTreeWalker(scanRoot, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const host = node.parentElement;
      if (!host || isSkipped(host)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const unit = nearestBlock(node.parentElement, displayCache);
    if (!unit || unit.hasAttribute(UNIT_ATTR)) continue;
    let list = groups.get(unit);
    if (!list) groups.set(unit, (list = []));
    list.push(node);
  }

  // 標出哪些單元內部還包著其他單元
  const unitSet = new Set(groups.keys());
  const hasNested = new Set();
  for (const el of unitSet) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (unitSet.has(p)) hasNested.add(p);
      if (p === scanRoot) break;
    }
  }

  const out = [];
  for (const [el, textNodes] of groups) {
    const mixed = hasNested.has(el);
    // innerText 會依照實際排版處理空白，品質比 textContent 好；但元素若沒有被
    // 排版（display:none 之類），innerText 會退回 textContent —— 那會連
    // <script>、<style> 這些我們特意排除的內容一起吃進來。這種情況改用
    // 走訪時收集到的文字節點，那些本來就已經過濾過了。
    const useTextNodes = mixed || !isRendered(el);
    const text = useTextNodes
      ? normalize(textNodes.map((n) => n.nodeValue).join(' '))
      : normalize(el.innerText ?? el.textContent ?? '');

    if (!isTranslatable(text, minTextLength)) continue;

    const id = `rd${nextId++}`;
    // 兩種模式都要標記。每個區塊元素最多產出一個單元，標記後
    // MutationObserver 觸發的增量掃描才不會把同一段重複收一次。
    el.setAttribute(UNIT_ATTR, id);
    el.setAttribute(SRC_ATTR, 'src');

    if (mixed) {
      // 譯文要插在最後一段散落文字之後。往上找到仍在 el 之內的最外層 inline 祖先，
      // 這樣譯文不會掉進 <a> 或 <strong> 裡面。
      const anchor = topmostInlineWithin(textNodes[textNodes.length - 1], el);
      out.push({ id, el, text, mode: 'inline', anchor });
    } else {
      out.push({ id, el, text, mode: 'block', anchor: el });
    }
  }
  return out;
}

/**
 * 元素目前有沒有被排版。
 * 隱藏的段落仍然會被收集 —— 它們只是還沒輪到翻譯而已，
 * IntersectionObserver 會在它們變成可見時才觸發。
 */
function isRendered(el) {
  if (typeof el.checkVisibility === 'function') return el.checkVisibility();
  return el.getClientRects().length > 0;
}

function topmostInlineWithin(node, boundary) {
  let cur = node;
  while (cur.parentNode && cur.parentNode !== boundary) cur = cur.parentNode;
  return cur;
}

function isSkipped(el) {
  for (let cur = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
    if (SKIP_SUBTREE.has(cur.tagName)) return true;
    if (cur.matches?.(SKIP_SELECTOR)) return true;
  }
  return false;
}

/** 往上找到第一個非 inline 的祖先。 */
function nearestBlock(el, cache) {
  let cur = el;
  while (cur && cur !== document.documentElement) {
    if (!INLINE_TAGS.has(cur.tagName)) {
      let display = cache.get(cur);
      if (display === undefined) {
        display = getComputedStyle(cur).display;
        cache.set(cur, display);
      }
      // 標籤看起來是 block，但網站可能用 CSS 改成 inline
      if (display !== 'inline' && display !== 'contents' && display !== 'inline-block') return cur;
    }
    cur = cur.parentElement;
  }
  return document.body;
}

export function normalize(text) {
  return text.replace(/[\t\f\v ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

export function isTranslatable(text, minTextLength = 4) {
  if (!text || text.length < minTextLength) return false;
  if (!HAS_LETTER.test(text)) return false;
  if (URL_ONLY.test(text)) return false;
  return true;
}

/** 清除所有標記，讓頁面可以重新收集。 */
export function resetMarks(root = document) {
  for (const el of root.querySelectorAll(`[${UNIT_ATTR}]`)) {
    el.removeAttribute(UNIT_ATTR);
    el.removeAttribute(SRC_ATTR);
  }
  nextId = 1;
}

/**
 * 抽出頁面正文（給側邊欄摘要用的精簡 readability）。
 * 做法：挑出文字密度最高、連結佔比最低的容器，再從中收集段落。
 */
export function extractArticle() {
  const candidates = [
    document.querySelector('article'),
    document.querySelector('main'),
    document.querySelector('[role="main"]'),
    ...document.querySelectorAll('.post, .article, .entry-content, .markdown-body, #content'),
    document.body,
  ].filter(Boolean);

  let best = document.body;
  let bestScore = 0;
  for (const el of candidates) {
    const score = scoreContainer(el);
    if (score > bestScore) { bestScore = score; best = el; }
  }

  const parts = [];
  const seen = new Set();
  for (const el of best.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,dd,figcaption')) {
    if (isSkipped(el)) continue;
    if (el.closest('nav,footer,aside,header')) continue;
    const text = normalize(el.innerText || '');
    if (text.length < 12 || seen.has(text)) continue;
    seen.add(text);
    parts.push(/^H[1-4]$/.test(el.tagName) ? `\n## ${text}` : text);
  }

  return { title: document.title, url: location.href, text: parts.join('\n\n').trim() };
}

function scoreContainer(el) {
  const text = el.innerText || '';
  if (text.length < 200) return 0;
  let linkChars = 0;
  for (const a of el.querySelectorAll('a')) linkChars += (a.innerText || '').length;
  const linkRatio = linkChars / text.length;
  return text.length * (1 - Math.min(linkRatio, 0.9));
}
