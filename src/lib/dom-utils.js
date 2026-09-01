/** 建立一個掛在 <html> 底下、樣式與網頁完全隔離的 Shadow DOM 容器。
 *
 * 掛在 documentElement 而非 body，是因為有些網站會整包重寫 body。
 * 用一個自訂標籤名，網站的 CSS 選擇器不會意外命中。
 */
export function createShadowHost(tagName, css) {
  const host = document.createElement(tagName);
  host.setAttribute('data-readduck', 'ui');
  // 這些是唯一會影響網頁版面的樣式，必須用 !important 防止網站的
  // `* { ... }` 之類的規則把它推歪
  host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;';
  const shadow = host.attachShadow({ mode: 'open' });
  if (css) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
  }
  (document.documentElement || document.body).appendChild(host);
  return { host, shadow };
}

/**
 * 這個文件是不是瀏覽器內建 PDF 檢視器所呈現的 PDF。
 *
 * 最上層文件的 contentType 是 application/pdf，但它仍然有 body、也能注入
 * 元素（檢視器本身在巢狀 iframe 裡），所以我們可以在上面掛浮動按鈕。
 */
export function isPdfDocument(contentType = (typeof document !== 'undefined' ? document.contentType : '')) {
  return contentType === 'application/pdf';
}

/** 元素是否真的看得到（用於排除隱藏的段落）。 */
export function isVisible(el) {
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}

/** requestIdleCallback 的安全版（Safari 沒有，雖然這裡只跑 Chromium，但成本很低）。 */
export const idle =
  typeof requestIdleCallback === 'function'
    ? (fn, opts) => requestIdleCallback(fn, opts)
    : (fn) => setTimeout(fn, 1);

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function throttle(fn, ms) {
  let last = 0;
  let pending = null;
  return (...args) => {
    const now = performance.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      clearTimeout(pending);
      last = now;
      fn(...args);
    } else if (!pending) {
      pending = setTimeout(() => {
        pending = null;
        last = performance.now();
        fn(...args);
      }, wait);
    }
  };
}

/** HTML 逸出，用於把模型輸出安全地放進 innerHTML。 */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
