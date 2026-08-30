import { getSettings, setSettings, resetSettings, DEFAULTS } from '../lib/settings.js';
import { SUPPORTED_LANGUAGES } from '../ai/languages.js';
import { MSG, send } from '../lib/messaging.js';

const $ = (id) => document.getElementById(id);

/** id -> 讀寫方式。集中定義才不會漏掉某個欄位的存檔。 */
const FIELDS = {
  targetLanguage:       { kind: 'value' },
  inputTargetLanguage:  { kind: 'value' },
  translationStyle:     { kind: 'value' },
  translationFontScale: { kind: 'number' },
  concurrency:          { kind: 'number' },
  minTextLength:        { kind: 'number' },
  showFloatingButton:   { kind: 'checked' },
  showSelectionToolbar: { kind: 'checked' },
  cacheEnabled:         { kind: 'checked' },
  autoTranslateDomains: { kind: 'lines' },
  neverTranslateDomains:{ kind: 'lines' },
};

let settings = null;

init();

async function init() {
  for (const id of ['targetLanguage', 'inputTargetLanguage']) {
    for (const [tag, name] of SUPPORTED_LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = tag;
      opt.textContent = name;
      $(id).appendChild(opt);
    }
  }

  settings = await getSettings();
  for (const [id, def] of Object.entries(FIELDS)) write(id, def, settings[id]);
  syncLabels();

  for (const [id, def] of Object.entries(FIELDS)) {
    const el = $(id);
    const event = def.kind === 'lines' ? 'input' : 'change';
    el.addEventListener(event, () => save(id, def));
    if (el.type === 'range') el.addEventListener('input', syncLabels);
    if (id === 'translationStyle') el.addEventListener('change', syncLabels);
  }

  $('clearCache').addEventListener('click', async () => {
    await send(MSG.CACHE_CLEAR);
    await refreshCacheStats();
    flash('快取已清除');
  });
  $('diagnostics').addEventListener('click', () =>
    chrome.tabs.create({ url: chrome.runtime.getURL('src/diagnostics/diagnostics.html') }));
  $('reset').addEventListener('click', async () => {
    if (!confirm('確定要把所有設定回復成預設值嗎？')) return;
    await resetSettings();
    settings = { ...DEFAULTS };
    for (const [id, def] of Object.entries(FIELDS)) write(id, def, settings[id]);
    syncLabels();
    flash('已回復預設值');
  });

  refreshCacheStats();
}

function write(id, def, value) {
  const el = $(id);
  switch (def.kind) {
    case 'checked': el.checked = !!value; break;
    case 'lines':   el.value = (value ?? []).join('\n'); break;
    default:        el.value = value; break;
  }
}

function read(id, def) {
  const el = $(id);
  switch (def.kind) {
    case 'checked': return el.checked;
    case 'number':  return Number(el.value);
    case 'lines':
      return [...new Set(
        el.value.split('\n')
          .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
          .filter(Boolean)
      )];
    default: return el.value;
  }
}

let saveTimer = null;
function save(id, def) {
  const value = read(id, def);
  settings[id] = value;
  clearTimeout(saveTimer);
  // 網域清單是邊打邊存，debounce 一下避免每個字元都寫一次 storage
  saveTimer = setTimeout(async () => {
    await setSettings({ [id]: value });
    flash('已儲存');
  }, def.kind === 'lines' ? 600 : 0);
}

function syncLabels() {
  $('scaleLabel').textContent = `${Math.round(Number($('translationFontScale').value) * 100)}%`;
  $('concurrencyLabel').textContent = $('concurrency').value;
  $('minLenLabel').textContent = $('minTextLength').value;
  const preview = $('preview');
  preview.dataset.style = $('translationStyle').value;
  preview.querySelector('.tr').style.fontSize = `${$('translationFontScale').value}em`;
}

async function refreshCacheStats() {
  const s = await send(MSG.CACHE_STATS);
  if (!s) { $('cacheStats').textContent = '無法取得快取統計'; return; }
  const size = s.bytes != null ? `，約 ${(s.bytes / 1048576).toFixed(1)} MB` : '';
  $('cacheStats').textContent = `已快取 ${s.count.toLocaleString()} / ${s.max.toLocaleString()} 段譯文${size}`;
}

let flashTimer = null;
function flash(text) {
  const el = $('saved');
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.style.opacity = '0'; }, 1400);
}
