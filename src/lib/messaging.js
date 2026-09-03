/** 擴充功能內部訊息型別。集中在這裡避免字串散落各處打錯。 */
export const MSG = {
  // content script -> service worker
  CACHE_GET:        'cache:get',
  CACHE_PUT:        'cache:put',
  CACHE_STATS:      'cache:stats',
  CACHE_CLEAR:      'cache:clear',
  GET_SETTINGS:     'settings:get',
  SET_SETTINGS:     'settings:set',
  PAGE_STATE:       'page:state',      // 回報本分頁翻譯狀態給 popup
  EXTRACT_ARTICLE:  'page:extract',    // side panel 要正文
  OPEN_SIDE_PANEL:  'ui:openSidePanel',
  OPEN_OPTIONS:     'ui:openOptions',
  OPEN_PDF:         'ui:openPdf',
  /** 跨來源圖片只能由 service worker 抓，見那邊的說明 */
  FETCH_IMAGE:      'image:fetch',
  /** 抓不到時的後路：擷取可見畫面，再由 content script 裁出圖片那一塊 */
  CAPTURE_TAB:      'image:capture',

  // service worker -> content script
  TOGGLE:           'cmd:toggle',
  SET_ENABLED:      'cmd:setEnabled',
  TRANSLATE_INPUT:  'cmd:translateInput',
  EXPLAIN_SELECTION:'cmd:explainSelection',
  TRANSLATE_IMAGE:  'cmd:translateImage',
  QUERY_STATE:      'cmd:queryState',
  SETTINGS_CHANGED: 'evt:settingsChanged',

  // 能力探測（診斷頁用）
  PROBE:            'probe:run',        // payload: { target: 'service-worker'|'content'|'offscreen', options }
  OFFSCREEN_PROBE:  'probe:offscreen',  // service worker -> offscreen document

  /** content script -> service worker：請求改由 offscreen document 翻譯 */
  TRANSLATE_VIA_OFFSCREEN: 'offscreen:request',
  /** service worker -> offscreen document */
  OFFSCREEN_TRANSLATE: 'offscreen:translate',
};

/**
 * chrome.runtime.sendMessage 的 promise 版，並把 lastError 吞成 null。
 * 之所以要吞：service worker 剛被喚醒、或分頁沒有 content script 時很常見，
 * 不處理會在 console 噴一堆 Unchecked runtime.lastError。
 */
/**
 * ReadDuck PDF 檢視器回應正文請求時會帶上這個標記。
 * runtime 訊息是廣播給所有擴充功能情境的，沒有標記就分不出「檢視器答的」
 * 和「別的地方剛好回了些什麼」。
 */

export function send(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        void chrome.runtime.lastError;
        resolve(res ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** 對特定分頁的 content script 送訊息。 */
export function sendToTab(tabId, type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type, payload }, (res) => {
        void chrome.runtime.lastError;
        resolve(res ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}
