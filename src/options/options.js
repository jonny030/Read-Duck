import { getSettings, setSettings, resetSettings, DEFAULTS } from '../lib/settings.js';
import { SUPPORTED_LANGUAGES } from '../ai/languages.js';
import { MSG, send } from '../lib/messaging.js';
import { PROMPTS, MAX_PROMPT_LENGTH, respondInLine } from '../ai/prompts.js';
import { initTheme, applyTheme, THEMES, THEME_LABELS } from '../lib/theme.js';

const $ = (id) => document.getElementById(id);

/** id -> 讀寫方式。集中定義才不會漏掉某個欄位的存檔。 */
const FIELDS = {
  theme:                { kind: 'value' },
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
  initTheme();
  for (const value of THEMES) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = THEME_LABELS[value];
    $('theme').appendChild(opt);
  }

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
  buildPromptEditors();
  syncLabels();

  for (const [id, def] of Object.entries(FIELDS)) {
    const el = $(id);
    const event = def.kind === 'lines' ? 'input' : 'change';
    el.addEventListener(event, () => save(id, def));
    // initTheme() 註冊的監聽器也會收到這次變更，但那要等 storage 寫入round-trip
    // 回來。這裡直接套一次，切換才是即時的。applyTheme() 可重複呼叫。
    if (id === 'theme') el.addEventListener('change', () => applyTheme(el.value));
    if (el.type === 'range') el.addEventListener('input', syncLabels);
    if (id === 'translationStyle') el.addEventListener('change', syncLabels);
  }

  $('clearCache').addEventListener('click', async () => {
    await send(MSG.CACHE_CLEAR);
    await refreshCacheStats();
    flash('快取已清除');
  });
  $('resetPrompts').addEventListener('click', async () => {
    settings.customPrompts = {};
    await setSettings({ customPrompts: {} });
    buildPromptEditors();
    flash('提示詞已回復內建');
  });

  $('diagnostics').addEventListener('click', () =>
    chrome.tabs.create({ url: chrome.runtime.getURL('src/diagnostics/diagnostics.html') }));
  $('reset').addEventListener('click', async () => {
    if (!confirm('確定要把所有設定回復成預設值嗎？')) return;
    await resetSettings();
    settings = { ...DEFAULTS };
    for (const [id, def] of Object.entries(FIELDS)) write(id, def, settings[id]);
    applyTheme(settings.theme);
    buildPromptEditors();
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

/* ------------------------------------------------------------ 提示詞 */

/**
 * 每則 prompt 一個編輯區。清單來自 src/ai/prompts.js 的 PROMPTS ——
 * 新增一則 prompt 時設定頁會自動長出對應欄位，不必兩邊各改一次。
 *
 * 這些欄位是動態產生的，所以不用 $('id') 取值（那要求 HTML 裡先有 id）。
 */
function buildPromptEditors() {
  const host = $('prompts');
  host.replaceChildren();

  for (const def of PROMPTS) {
    const wrap = document.createElement('div');
    wrap.className = 'stack';
    wrap.style.gap = '6px';

    const head = document.createElement('div');
    head.className = 'row';
    const title = document.createElement('div');
    title.className = 'grow';
    const name = document.createElement('div');
    name.textContent = def.label;
    const where = document.createElement('div');
    where.className = 'small muted';
    where.textContent = def.where;
    title.append(name, where);

    const revert = document.createElement('button');
    revert.className = 'ghost';
    revert.textContent = '回復內建';
    head.append(title, revert);

    // 框裡直接放實際在用的提示詞，改它就是改實際送出的內容
    const box = document.createElement('textarea');
    box.rows = 7;
    box.spellcheck = false;
    box.maxLength = MAX_PROMPT_LENGTH;
    box.value = settings.customPrompts?.[def.key] ?? def.body;

    const foot = document.createElement('div');
    foot.className = 'small muted';

    const refresh = () => {
      const value = box.value.trim();
      const parts = [];
      if (!value) parts.push('空白，會使用內建提示詞');
      else if (value === def.body) parts.push('與內建相同');
      else parts.push(`已自訂 ${box.value.length} / ${MAX_PROMPT_LENGTH} 字元`);
      // 這一行不在框裡，但每次都會接上去。不講的話使用者會自己再寫一次。
      if (def.appendRespondIn) {
        parts.push(`結尾自動接上「${respondInLine(previewLanguage(def.key))}」`);
      }
      foot.textContent = parts.join('・');
      revert.disabled = value === def.body;
    };

    box.addEventListener('input', () => { refresh(); savePrompt(def.key, box.value, def.body); });
    revert.addEventListener('click', () => {
      box.value = def.body;
      refresh();
      savePrompt(def.key, def.body, def.body);
    });

    refresh();
    wrap.append(head, box, foot);
    host.appendChild(wrap);
  }
}

/**
 * 提示裡要顯示哪個語言。輸入框翻譯用的是它自己的目標語言，其餘用閱讀的目標語言。
 * 這只是給使用者看的近似值，真正送出時由 planOutputLanguage() 決定。
 */
function previewLanguage(key) {
  return key === 'inputRewrite' ? settings.inputTargetLanguage : settings.targetLanguage;
}

let promptTimer = null;
function savePrompt(key, value, builtIn) {
  const next = { ...settings.customPrompts };
  const trimmed = value.trim();
  // 和內建一模一樣就不必存 —— 存了只是佔 storage.sync 的額度，
  // 而且日後內建內容更新時會被舊的複本擋住
  if (trimmed && trimmed !== builtIn) next[key] = trimmed;
  else delete next[key];
  settings.customPrompts = next;

  clearTimeout(promptTimer);
  promptTimer = setTimeout(async () => {
    try {
      await setSettings({ customPrompts: next });
      flash('已儲存');
    } catch (err) {
      // storage.sync 每個項目只有 8 KB，六則加起來是有可能撐爆的
      flash(`儲存失敗：${err?.message || err}`);
    }
  }, 600);
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
