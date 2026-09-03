/**
 * 在頁面繪製之前同步套用主題。
 *
 * 這支刻意是 classic script（不是 module）且要放在 <head> —— 它必須在
 * body 被繪製前就跑完，否則使用者會看到畫面先閃一下淺色再變深。
 *
 * 為什麼不直接讀設定：chrome.storage.sync 是非同步的，來不及。localStorage
 * 是同步的，而且所有擴充功能頁面同源、共用同一份。真正的設定仍然存在
 * storage.sync（可跨裝置同步），這裡只是它的鏡像，由 lib/theme.js 維護。
 */
try {
  const theme = localStorage.getItem('readduck-theme');
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  }
} catch {
  // 無痕視窗或封鎖了網站資料時讀不到，退回跟隨系統即可，不必吵。
}
