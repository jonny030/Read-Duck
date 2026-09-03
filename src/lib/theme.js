import { getSettings, onSettingsChanged } from './settings.js';

/**
 * 深淺色主題。
 *
 * 'system' 不掛 data-theme，讓 CSS 的 prefers-color-scheme 決定；
 * 'light' / 'dark' 掛上去覆寫。詳細的三態規則見 src/shared.css 的註解。
 */
export const THEMES = Object.freeze(['system', 'light', 'dark']);

export const THEME_LABELS = Object.freeze({
  system: '跟隨系統',
  light: '淺色',
  dark: '深色',
});

/** theme-boot.js 讀的同一個 key。改這裡要一起改那邊。 */
const MIRROR_KEY = 'readduck-theme';

export function normalizeTheme(theme) {
  return THEMES.includes(theme) ? theme : 'system';
}

/** 套用到目前這個擴充功能頁面，並更新給 theme-boot.js 用的鏡像。 */
export function applyTheme(theme) {
  const value = normalizeTheme(theme);
  const root = document.documentElement;
  if (value === 'system') delete root.dataset.theme;
  else root.dataset.theme = value;

  try {
    localStorage.setItem(MIRROR_KEY, value);
  } catch {
    // 寫不進去只是下次開頁會閃一下，功能不受影響
  }
}

/**
 * 擴充功能頁面啟動時呼叫：套用目前設定，之後設定變更也自動跟著換
 * （在別的分頁改了設定，這一頁不必重新整理）。
 */
export async function initTheme() {
  const { theme } = await getSettings();
  applyTheme(theme);
  onSettingsChanged((patch) => {
    if (patch.theme !== undefined) applyTheme(patch.theme);
  });
}
