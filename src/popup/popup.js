import { MSG, send, sendToTab } from '../lib/messaging.js';
import { getSettings, setSettings, hostnameOf, domainListMatches } from '../lib/settings.js';
import { SUPPORTED_LANGUAGES, languageName } from '../ai/languages.js';
import { checkAvailability } from '../ai/translator-pool.js';
import { explainUnavailable } from '../ai/capability.js';

const $ = (id) => document.getElementById(id);

let settings = null;
let tab = null;
let state = null;

init().catch((err) => showNotice('err', `初始化失敗：${err.message}`));

async function init() {
  settings = await getSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  fillLanguages();
  $('targetLanguage').value = settings.targetLanguage;
  $('translationStyle').value = settings.translationStyle;

  const host = hostnameOf(tab?.url ?? '');
  $('host').textContent = host ?? '此頁面不支援';
  $('autoDomain').checked = domainListMatches(settings.autoTranslateDomains, host);
  if (!host) {
    $('toggle').disabled = true;
    $('autoDomain').disabled = true;
    showNotice('warn', 'ReadDuck 只能在一般網頁上運作（http / https）。');
  }

  if (isPdfUrl(tab?.url)) {
    $('pdf').className = 'primary';
    // 標籤要短，否則按鈕列會換行，把後面的按鈕擠到第二行
    $('pdf').textContent = '翻譯 PDF';
    showNotice('warn', '瀏覽器內建的 PDF 檢視器無法加上譯文，請用 ReadDuck 的檢視器開啟。');
  }

  bind();
  await refreshState();
  await checkTranslatorHealth();
}

function fillLanguages() {
  const sel = $('targetLanguage');
  for (const [tag, name] of SUPPORTED_LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = tag;
    opt.textContent = name;
    sel.appendChild(opt);
  }
}

function bind() {
  $('toggle').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    setStateText(enabled ? '啟動中…' : '關閉中…');
    const res = await sendToTab(tab.id, MSG.SET_ENABLED, { enabled });
    if (!res) {
      showNotice('warn', '這個分頁還沒載入 ReadDuck。請重新整理頁面後再試。');
      e.target.checked = false;
      return;
    }
    state = res;
    render();
  });

  $('targetLanguage').addEventListener('change', async (e) => {
    await setSettings({ targetLanguage: e.target.value });
    settings.targetLanguage = e.target.value;
    await checkTranslatorHealth();
  });

  $('translationStyle').addEventListener('change', (e) => {
    setSettings({ translationStyle: e.target.value });
  });

  $('autoDomain').addEventListener('change', async (e) => {
    const host = hostnameOf(tab.url);
    if (!host) return;
    const list = new Set(settings.autoTranslateDomains);
    if (e.target.checked) list.add(host); else list.delete(host);
    settings.autoTranslateDomains = [...list];
    await setSettings({ autoTranslateDomains: settings.autoTranslateDomains });
  });

  $('sidePanel').addEventListener('click', () => {
    // 直接在這裡呼叫，不繞道 service worker。sidePanel.open() 需要使用者手勢，
    // 而訊息往返會讓 activation 過期；popup 的點擊本身就是手勢。
    // tab 是開啟 popup 時就抓好的，所以這裡不需要 await。
    if (!tab?.id) return;
    chrome.sidePanel.open({ tabId: tab.id }).then(
      () => window.close(),
      (err) => showNotice('err', `無法開啟側邊欄：${err?.message || err}`)
    );
  });

  $('pdf').addEventListener('click', () => {
    // 目前分頁就是 PDF 的話直接帶過去，否則開空的檢視器讓使用者拖檔案進來
    send(MSG.OPEN_PDF, { url: isPdfUrl(tab?.url) ? tab.url : null });
    window.close();
  });

  $('diagnostics').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/diagnostics/diagnostics.html') });
    window.close();
  });

  $('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

async function refreshState() {
  if (!tab?.id) return;
  state = await sendToTab(tab.id, MSG.QUERY_STATE);
  render();
}

function render() {
  const dot = $('stateDot');
  if (!state) {
    dot.className = 'dot';
    setStateText('尚未載入（重新整理頁面即可）');
    return;
  }
  if (state.isPdf) {
    dot.className = 'dot warn';
    $('toggle').checked = false;
    $('toggle').disabled = true;
    setStateText('瀏覽器內建的檢視器無法加上譯文');
    return;
  }
  if (state.disabledByDomain) {
    dot.className = 'dot warn';
    $('toggle').checked = false;
    $('toggle').disabled = true;
    setStateText('這個網域在設定中被停用');
    showNotice('warn', `${state.hostname} 在「完全停用」清單中。可到設定頁移除。`);
    return;
  }
  $('toggle').checked = !!state.enabled;
  dot.className = `dot ${state.enabled ? 'ok' : ''}`;

  if (!state.enabled) {
    setStateText('尚未開始');
    return;
  }
  const s = state.stats ?? {};
  const src = state.sourceLanguage ? languageName(state.sourceLanguage) : '偵測中';
  const parts = [`${src} → ${languageName(state.targetLanguage)}`];
  if (s.total) parts.push(`${s.done}/${s.total} 段`);
  if (s.pending) parts.push(`翻譯中 ${s.pending}`);
  if (s.failed) parts.push(`失敗 ${s.failed}`);
  setStateText(parts.join(' · '));
}

function setStateText(t) { $('stateText').textContent = t; }

function isPdfUrl(url) { return /\.pdf($|[?#])/i.test(url ?? ''); }

/** 檢查目前的目標語言在這台機器上是否真的可用，早點告訴使用者而不是等翻譯失敗。 */
async function checkTranslatorHealth() {
  if (!('Translator' in self)) {
    showNotice('err', explainUnavailable('unavailable', '翻譯').body);
    return;
  }
  const src = state?.sourceLanguage || 'en';
  const availability = await checkAvailability(src, settings.targetLanguage);
  if (availability === 'available') { hideNotice(); return; }
  const info = explainUnavailable(availability, '翻譯');
  if (!info) { hideNotice(); return; }
  showNotice(availability === 'unavailable' ? 'err' : 'warn', `${info.title}\n${info.body}`);
}

function showNotice(kind, text) {
  const el = $('notice');
  el.className = `notice ${kind}`;
  el.textContent = text;
  el.hidden = false;
}

function hideNotice() { $('notice').hidden = true; }

// 翻譯進行中時讓狀態文字持續更新
setInterval(() => { if (state?.enabled) refreshState(); }, 900);
