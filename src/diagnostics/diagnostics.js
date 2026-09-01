import { MSG, send, sendToTab } from '../lib/messaging.js';
import { probe, API_NAMES, explainUnavailable } from '../ai/capability.js';
import { getSettings } from '../lib/settings.js';
import { SUPPORTED_LANGUAGES, languageName } from '../ai/languages.js';
import { translateText, checkAvailability } from '../ai/translator-pool.js';
import { getParams, planOutputLanguage, promptOutputLanguages } from '../ai/language-model.js';
import { currentBrowser, currentVersion } from '../lib/browser.js';

/**
 * M0 能力探測頁。
 *
 * 四個執行情境各跑一次探測，把結果並排出來：
 *   extension-page（本頁）／service-worker／content-script／offscreen
 * 這是決定架構的實測依據，也是使用者回報問題時最有用的一頁。
 */

const $ = (id) => document.getElementById(id);

const CONTEXTS = [
  { key: 'extension-page', label: '擴充功能頁面（本頁 / 側邊欄 / popup）' },
  { key: 'service-worker', label: 'background service worker' },
  { key: 'content',        label: 'content script（目前分頁）' },
  { key: 'offscreen',      label: 'offscreen document' },
];

let settings = null;
let results = {};

init();

async function init() {
  settings = await getSettings();
  for (const [tag, name] of SUPPORTED_LANGUAGES) {
    const o = document.createElement('option');
    o.value = tag; o.textContent = name;
    $('testTarget').appendChild(o);
  }
  $('testTarget').value = settings.targetLanguage;

  $('rerun').addEventListener('click', runAll);
  $('openInternals').textContent = `開啟 ${currentBrowser().internalsUrl}`;
  $('openInternals').addEventListener('click', () => chrome.tabs.create({ url: currentBrowser().internalsUrl }));
  $('downloadTranslator').addEventListener('click', downloadTranslator);
  $('downloadLm').addEventListener('click', downloadLanguageModel);
  $('testRun').addEventListener('click', runTest);
  $('copyRaw').addEventListener('click', () => {
    navigator.clipboard.writeText($('raw').textContent);
    $('copyRaw').textContent = '已複製';
    setTimeout(() => { $('copyRaw').textContent = '複製'; }, 1400);
  });

  await runAll();
}

async function runAll() {
  $('rerun').disabled = true;
  renderEnv();
  results = {};

  const options = { sourceLanguage: 'en', targetLanguage: settings.targetLanguage };

  results['extension-page'] = await probe(options).catch((e) => ({ error: String(e) }));
  results['service-worker'] = await send(MSG.PROBE, { target: 'service-worker', options })
    ?? { error: '無回應' };
  results['offscreen'] = await send(MSG.PROBE, { target: 'offscreen', options })
    ?? { error: '無法建立 offscreen document' };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  results['content'] = tab?.id
    ? (await sendToTab(tab.id, MSG.PROBE, { options })) ?? { error: '目前分頁沒有載入 content script（開一個一般網頁後重新檢測）' }
    : { error: '找不到作用中的分頁' };

  renderMatrix();
  await renderModels();
  $('raw').textContent = JSON.stringify({ userAgent: navigator.userAgent, results }, null, 2);
  $('rerun').disabled = false;
}

function renderEnv() {
  const b = currentBrowser();
  const version = currentVersion();
  // 版本讀不到時不要亂判「過舊」—— 那比沒有資訊更誤導。
  const versionCell = version == null
    ? `未知 ${pill('na', '讀不到版本')}`
    : `${version} ${pill(
        version >= b.minVersion ? 'ok' : 'err',
        version >= b.minVersion ? `符合（需 ${b.minVersion}+）` : `過舊，需 ${b.minVersion} 以上`,
      )}`;

  const rows = [
    ['瀏覽器', b.name],
    [`${b.name} 版本`, versionCell],
    ['平台', navigator.platform ?? '未知'],
    ['邏輯核心數', navigator.hardwareConcurrency ?? '未知'],
    ['裝置記憶體', navigator.deviceMemory ? `約 ${navigator.deviceMemory} GB` : '瀏覽器未提供'],
    ['擴充功能版本', chrome.runtime.getManifest().version],
  ];

  // Edge 的 Prompt API 還是開發者預覽，沒開 flag 的話 LanguageModel 根本不存在，
  // 只看「API 不存在」會以為是裝置不支援。
  if (b.promptNeedsFlag) {
    rows.push([
      'Prompt API',
      `需要 ${b.name} ${b.promptMinVersion}+（Canary / Dev），並在 `
      + `<span class="mono">${b.flagsUrl}</span> 啟用「${escapeHtml(b.promptFlag)}」`,
    ]);
  }

  $('env').innerHTML = rows
    .map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`)
    .join('');
}

function renderMatrix() {
  const head = `<tr><th>執行情境</th>${API_NAMES.map((n) => `<th>${n}</th>`).join('')}</tr>`;
  const body = CONTEXTS.map(({ key, label }) => {
    const r = results[key];
    if (!r || r.error) {
      return `<tr><td class="ctx">${label}</td><td colspan="${API_NAMES.length}">${pill('na', r?.error ?? '無資料')}</td></tr>`;
    }
    const cells = API_NAMES.map((name) => {
      if (!r.present?.[name]) return `<td>${pill('err', '不存在')}</td>`;
      const a = r.availability?.[name];
      if (!a) return `<td>${pill('ok', '存在')}</td>`;
      return `<td>${availabilityPill(a)}</td>`;
    }).join('');
    return `<tr><td class="ctx">${label}</td>${cells}</tr>`;
  }).join('');
  $('matrix').innerHTML = head + body;
}

function availabilityPill(a) {
  switch (a) {
    case 'available':    return pill('ok', '可用');
    case 'downloadable': return pill('warn', '需下載');
    case 'downloading':  return pill('warn', '下載中');
    default:             return pill('err', '不可用');
  }
}

function pill(kind, text) {
  return `<span class="pill ${kind}">${text}</span>`;
}

async function renderModels() {
  const here = results['extension-page'] ?? {};
  const rows = [];

  const tAvail = here.availability?.Translator;
  rows.push([
    `翻譯模型（en → ${languageName(settings.targetLanguage)}）`,
    tAvail ? availabilityPill(tAvail) : pill('err', 'Translator API 不存在'),
  ]);
  rows.push([
    '語言偵測模型',
    here.availability?.LanguageDetector
      ? availabilityPill(here.availability.LanguageDetector)
      : pill('err', 'LanguageDetector API 不存在'),
  ]);
  rows.push([
    '語言模型（Prompt API）',
    here.availability?.LanguageModel
      ? availabilityPill(here.availability.LanguageModel)
      : pill('err', 'LanguageModel API 不存在'),
  ]);

  const plan = planOutputLanguage(settings.targetLanguage);
  rows.push([
    '語言模型輸出語言',
    plan.needsTranslation
      ? `<span class="pill warn">${languageName(plan.modelLanguage)}</span> ` +
        `→ 再由翻譯模型轉成 ${languageName(plan.finalLanguage)}` +
        `<div class="small muted" style="margin-top:4px">${currentBrowser().name} 的 Prompt API 可輸出的語言只有 ` +
        `${promptOutputLanguages().join(' / ')}，不含${languageName(plan.finalLanguage)}。</div>`
      : `<span class="pill ok">${languageName(plan.modelLanguage)}</span> 直接輸出，不需轉譯`,
  ]);

  const params = here.params ?? (await getParams());
  rows.push([
    '模型參數',
    params
      ? `<span class="mono">temperature 預設 ${params.defaultTemperature} / 上限 ${params.maxTemperature}，topK 預設 ${params.defaultTopK} / 上限 ${params.maxTopK}</span>`
      : pill('na', '取不到（params() 是擴充功能與 Origin Trial 專屬）'),
  ]);

  const worst = ['LanguageModel', 'Translator', 'LanguageDetector']
    .map((n) => here.availability?.[n] ?? 'unavailable')
    .find((a) => a === 'unavailable');
  if (worst) {
    const info = explainUnavailable('unavailable');
    rows.push(['需求說明', `<span style="white-space:pre-wrap">${escapeHtml(info.body)}</span>`]);
  }

  $('models').innerHTML = rows
    .map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`)
    .join('');
}

/* -------------------------------------------------------- 下載與實測 */

async function downloadTranslator() {
  const status = $('downloadStatus');
  const target = settings.targetLanguage;
  status.textContent = '準備下載…';
  try {
    // 這裡是使用者點擊的呼叫鏈上，具備 user activation，可以觸發下載
    await translateText('Hello, world.', 'en', target, {
      onDownloadProgress: (l) => { status.textContent = `下載中… ${Math.round(l * 100)}%`; },
    });
    status.textContent = '翻譯模型已就緒。';
    await runAll();
  } catch (err) {
    status.textContent = `下載失敗：${err?.name} ${err?.message}`;
  }
}

async function downloadLanguageModel() {
  const status = $('downloadStatus');
  status.textContent = '準備下載…';
  try {
    if (!('LanguageModel' in self)) {
      const b = currentBrowser();
      throw new Error(
        `這個${b.name}沒有 LanguageModel API`
        + (b.promptNeedsFlag ? `（請先在 ${b.flagsUrl} 啟用「${b.promptFlag}」）` : ''),
      );
    }
    // expectedOutputs 一定要帶。少了它瀏覽器會警告
    // "No output language was specified"，而且輸出品質與安全性都不保證。
    const plan = planOutputLanguage(settings.targetLanguage);
    const s = await self.LanguageModel.create({
      expectedOutputs: [{ type: 'text', languages: [plan.modelLanguage] }],
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          status.textContent = `下載中… ${Math.round(e.loaded * 100)}%`;
        });
      },
    });
    s.destroy?.();
    status.textContent = '語言模型已就緒。';
    await runAll();
  } catch (err) {
    status.textContent = `下載失敗：${err?.name} ${err?.message}`;
  }
}

async function runTest() {
  const out = $('testOut');
  const text = $('testInput').value.trim();
  const target = $('testTarget').value;
  if (!text) return;

  out.hidden = false;
  out.className = 'notice';
  out.textContent = '翻譯中…';

  try {
    const availability = await checkAvailability('en', target);
    if (availability === 'unavailable') {
      out.className = 'notice err';
      out.textContent = `en → ${languageName(target)} 不支援。`;
      return;
    }
    const started = performance.now();
    const result = await translateText(text, 'en', target, {
      onDownloadProgress: (l) => { out.textContent = `下載模型中… ${Math.round(l * 100)}%`; },
    });
    const ms = Math.round(performance.now() - started);
    out.className = 'notice';
    out.textContent = `${result}\n\n（耗時 ${ms} ms）`;
  } catch (err) {
    out.className = 'notice err';
    out.textContent = `失敗：${err?.name}: ${err?.message}`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

