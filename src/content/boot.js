/**
 * content script 進入點。
 *
 * 這支檔案必須是 classic script —— MV3 的 content_scripts 不支援
 * "type": "module"。真正的程式碼全部寫成 ES module，由這裡動態載入。
 * 這樣 src/ai 與 src/lib 底下的模組可以被 content script、side panel、
 * popup、options 四邊共用，完全不需要打包工具。
 */
(() => {
  if (window.__readduckBooted) return;
  window.__readduckBooted = true;

  // 只在一般網頁上運作
  // PDF 也要放行：瀏覽器內建檢視器的最上層文件是可以操作的（檢視器本身在
  // 巢狀 iframe 裡），我們可以在上面掛一顆「用 ReadDuck 開啟」的浮動按鈕。
  const type = document.contentType;
  const supported = ['text/html', 'application/xhtml+xml', 'application/pdf'];
  if (!document.body || !supported.includes(type)) return;

  import(chrome.runtime.getURL('src/content/main.js'))
    .catch((err) => console.error('[ReadDuck] 無法載入主程式', err));
})();
