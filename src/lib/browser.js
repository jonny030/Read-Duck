/**
 * 瀏覽器差異的唯一真相。
 *
 * ReadDuck 同時支援 Chrome 與 Microsoft Edge。兩邊都是 Chromium，內建 AI 的
 * API 形狀完全一樣（`Translator` / `LanguageDetector` / `LanguageModel`，
 * 都有 availability() / create() / monitor / AbortController），所以主要的程式
 * 邏輯不需要分岔。真正不同的是這些「周邊事實」：
 *
 *   Chrome  Translator / LanguageDetector / Prompt API 都是 138 起，語言模型是
 *           Gemini Nano，Prompt API **保證** 的輸出語言有 en / ja / es / de / fr。
 *   Edge    Translator 要 Edge 148 起；Prompt API 從 138.0.3309.2 起是開發者預覽，
 *           只在 Canary / Dev 提供，而且必須在 edge://flags 手動開啟。語言模型是
 *           Phi-4-mini（低階裝置可改用預發布的 Aion-1.0-Instruct）。Microsoft 沒有
 *           公開保證任何輸出語言，所以我們只敢讓模型輸出英文，其餘一律交給
 *           Translator API 轉換 —— 見 promptOutputLanguages()。
 *
 * 版本門檻、`chrome://` / `edge://` 內部頁面網址、硬體需求說明這類字串都不要
 * 散落在各處，一律從這裡拿（`npm run check` 會擋下寫死在別處的內部頁面網址）。
 */

/** Prompt API 在 Chrome 上保證的輸出語言。中文不在其中，這是模型的限制。 */
const CHROME_OUTPUT_LANGUAGES = Object.freeze(['en', 'ja', 'es', 'de', 'fr']);

const CHROME = Object.freeze({
  id: 'chrome',
  name: 'Chrome',
  internalsUrl: 'chrome://on-device-internals',
  flagsUrl: 'chrome://flags',
  extensionsUrl: 'chrome://extensions',
  /** Translator / LanguageDetector 可用的最低版本 */
  minVersion: 138,
  /** Prompt API 可用的最低版本 */
  promptMinVersion: 138,
  promptModel: 'Gemini Nano',
  /** Prompt API 需不需要使用者自己去開 flag */
  promptNeedsFlag: false,
  promptFlag: null,
  promptNote: null,
  promptOutputLanguages: CHROME_OUTPUT_LANGUAGES,
  requirements: Object.freeze([
    'Chrome 138 以上（桌機版，行動版不支援）',
    '至少 22 GB 可用硬碟空間',
    '獨立 GPU（4 GB 以上 VRAM）或 16 GB RAM、4 核心以上 CPU',
    '作業系統 Windows 10/11、macOS 13+、Linux 或 ChromeOS',
    '首次下載模型時需要非計量網路',
  ]),
});

const EDGE = Object.freeze({
  id: 'edge',
  name: 'Microsoft Edge',
  internalsUrl: 'edge://on-device-internals',
  flagsUrl: 'edge://flags',
  extensionsUrl: 'edge://extensions',
  minVersion: 148,
  promptMinVersion: 138,
  promptModel: 'Phi-4-mini',
  promptNeedsFlag: true,
  promptFlag: 'Prompt API for on-device language model',
  promptNote:
    'edge://on-device-internals 的「裝置效能類別」是「中」或「低」時 Phi-4-mini 不會啟用，'
    + '可改用 Edge 150.0.4070 以上、並啟用「Enable pre-release on-device language model」'
    + '的 Aion-1.0-Instruct。',
  /**
   * 只讓模型輸出英文。
   *
   * Microsoft 的文件沒有列出 Prompt API 保證的輸出語言，Phi-4-mini 與
   * Aion-1.0-Instruct 的多語表現也沒有承諾。與其賭，不如固定走本專案既有的
   * 雙段管線：模型用英文輸出（所有 system prompt 本來就是英文）→ Translator
   * API 轉成目標語言。專用翻譯模型做翻譯，品質反而比讓小模型直接寫外語穩。
   */
  promptOutputLanguages: Object.freeze(['en']),
  requirements: Object.freeze([
    '翻譯需要 Edge 148 以上',
    '摘要／解釋／問答需要 Edge Canary 或 Dev 138.0.3309.2 以上（穩定版尚未提供）',
    '並在 edge://flags 把「Prompt API for on-device language model」設為 Enabled',
    '至少 20 GB 可用硬碟空間（低於 10 GB 時模型會被自動刪除）',
    '5.5 GB 以上 VRAM，且「裝置效能類別」為「高」以上',
    '作業系統 Windows 10/11 或 macOS 13.3 以上',
    '首次下載模型時需要非計量網路（計量連線不會下載模型）',
  ]),
});

export const BROWSER_PROFILES = Object.freeze({ chrome: CHROME, edge: EDGE });

/** 取得指定 id 的設定檔；不認得的 id 一律當 Chrome（兩者是同一個引擎）。 */
export function browserProfile(id) {
  return BROWSER_PROFILES[id] ?? CHROME;
}

/**
 * 從 UA 提示判斷是哪個瀏覽器。純函式，方便測試。
 *
 * 優先看 userAgentData.brands —— Edge 的 UA 字串裡同時有 `Chrome/` 和 `Edg/`，
 * 只比對 `Chrome/` 會把 Edge 誤判成 Chrome。
 *
 * @param {{userAgent?: string, brands?: Array<{brand?: string, version?: string}>}} hints
 * @returns {'chrome'|'edge'}
 */
export function detectBrowserId({ userAgent = '', brands = [] } = {}) {
  if (brands.some((b) => /edge/i.test(b?.brand ?? ''))) return 'edge';
  // Edg / EdgA（Android）/ EdgiOS。桌機只會是 Edg，其他兩個留著也不吃虧。
  if (/\bEdg[A-Za-z]*\/\d/.test(userAgent)) return 'edge';
  return 'chrome';
}

/**
 * 主要版本號。拿不到就回傳 null（不要假裝是 0，那會讓「版本過舊」誤報）。
 * @returns {number|null}
 */
export function detectVersion(hints = {}, id = detectBrowserId(hints)) {
  const { userAgent = '', brands = [] } = hints;
  const wanted = id === 'edge' ? /edge/i : /^(google chrome|chromium)$/i;
  const brand = brands.find((b) => wanted.test(b?.brand ?? ''));
  const fromBrand = Number.parseInt(brand?.version ?? '', 10);
  if (Number.isFinite(fromBrand)) return fromBrand;

  const m = userAgent.match(id === 'edge' ? /\bEdg[A-Za-z]*\/(\d+)/ : /\bChrome\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** 讀出這個執行情境能拿到的 UA 提示。navigator 在 service worker 裡也有。 */
function readHints() {
  if (typeof navigator === 'undefined') return {};
  return {
    userAgent: navigator.userAgent ?? '',
    brands: navigator.userAgentData?.brands ?? [],
  };
}

let cached = null;

/** 目前執行環境的瀏覽器設定檔。結果會被記住，一個情境只判斷一次。 */
export function currentBrowser() {
  if (!cached) cached = browserProfile(detectBrowserId(readHints()));
  return cached;
}

/** 目前瀏覽器的主要版本號，拿不到回傳 null。 */
export function currentVersion() {
  const hints = readHints();
  return detectVersion(hints, detectBrowserId(hints));
}

export function isEdge() {
  return currentBrowser().id === 'edge';
}
