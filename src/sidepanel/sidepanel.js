import { MSG, sendToTab } from '../lib/messaging.js';
import { getSettings, onSettingsChanged } from '../lib/settings.js';
import { initTheme } from '../lib/theme.js';
import {
  createSession, forkSession, planOutputLanguage, promptJson, usage,
  estimateTokens, chunkText, isLanguageModelPresent, checkAvailability, isQuotaError,
  needsDownloadConsent, DOWNLOAD_NOTICE,
} from '../ai/language-model.js';
import { promptLocalized, localizeText, localizeAll } from '../ai/localize.js';
import {
  summarySystemPrompt, chunkSummarySystemPrompt, qaSystemPrompt, SUMMARY_SCHEMA,
} from '../ai/prompts.js';
import {
  explainUnavailable, explainModelError, isModelCrashError, describeError,
} from '../ai/capability.js';

/**
 * 側邊欄：整頁摘要 + 針對本頁的問答。
 *
 * 側邊欄是一般 document，所以可以直接呼叫 Prompt API（service worker 不行）。
 * 正文由 content script 抽取後透過訊息送過來。
 *
 * 輸出語言由 planOutputLanguage() 決定。中文不在 Prompt API 保證支援的輸出
 * 語言清單內，所以中文使用者拿到的是「模型輸出英文 → Translator 轉中文」。
 */

const $ = (id) => document.getElementById(id);

/** 模型狀態是整個瀏覽器共用的，不分分頁。 */
let settings = null;
let modelAvailability = null;
let recheckTimer = null;

/**
 * 每個分頁一份狀態。
 *
 * 側邊欄只有一個 document，內容跟著作用中的分頁換。但摘要動輒跑數十秒 ——
 * 使用者切去別的分頁看點東西再切回來，那份工作應該還在跑、或已經跑完等著他。
 * 所以狀態不能是全域的一份，否則換頁就只能二選一：中止它，或讓它把結果寫到
 * 錯誤的頁面上。
 *
 * Map 的插入順序當成 LRU。每個問答 session 都佔著模型的上下文記憶體，
 * 不能無限累積。
 */
const MAX_STATES = 8;
const states = new Map();
let activeId = null;

function newState(id) {
  return {
    id,
    url: null,
    article: null,          // { title, url, text }
    /** status: 'idle' | 'running' | 'done' | 'error' */
    summary: { status: 'idle', progress: null, result: null, error: null },
    notice: null,           // { kind, text, action }
    chatEl: null,           // 這個分頁的對話 DOM，切走時整塊留著
    session: null,          // 問答用的長期 session
    qaPlan: null,
    pendingContext: null,
    controller: null,
    busy: false,
    /** 內容作廢時 +1。進行中的工作靠它判斷自己的結果還算不算數。 */
    generation: 0,
  };
}

function stateFor(id) {
  let st = states.get(id);
  if (!st) st = newState(id);
  // 重新插入到尾端，維持 LRU 順序
  states.delete(id);
  states.set(id, st);
  evictOld();
  return st;
}

/** 丟掉最久沒用到的分頁狀態。正在跑的和正在顯示的都不動。 */
function evictOld() {
  for (const [id, st] of states) {
    if (states.size <= MAX_STATES) break;
    if (id === activeId || st.busy) continue;
    st.session?.destroy?.();
    states.delete(id);
  }
}

function current() { return activeId == null ? null : states.get(activeId) ?? null; }
function isCurrent(st) { return st != null && st === current(); }

/**
 * 這個分頁的內容已經不算數了（換了網址、或使用者手動重新讀取）。
 * 中止進行中的工作並清空狀態，但保留這個分頁在 map 裡。
 */
function discard(st) {
  st.generation++;
  st.controller?.abort();
  st.controller = null;
  st.busy = false;
  st.summary = { status: 'idle', progress: null, result: null, error: null };
  st.notice = null;
  st.chatEl = null;
  st.session?.destroy?.();
  st.session = null;
  st.qaPlan = null;
  st.pendingContext = null;
}

init().catch((e) => showNotice('err', `初始化失敗：${e.message}`));

async function init() {
  initTheme();
  settings = await getSettings();
  bind();
  // 側邊欄一打開就先確認語言模型在不在，讓使用者在按下任何按鈕之前
  // 就知道狀態，而不是按了「產生摘要」才發現要下載數 GB。
  await Promise.all([loadArticle(), refreshModelState()]);

  // 側邊欄原本完全不理設定變更，settings 是開啟當下的快照 —— 在設定頁改了
  // 目標語言或提示詞，這裡要重開才會生效，看起來像「改了沒有用」。
  onSettingsChanged((patch) => {
    const before = settings;
    settings = { ...settings, ...patch };

    // 問答 session 的 system prompt 在建立時就固定了，改了就得重建。
    // 但只有 qa 那則和輸出語言會影響它 —— 改別則提示詞不該把使用者的對話清掉。
    const qaChanged = 'customPrompts' in patch
      && before.customPrompts?.qa !== settings.customPrompts?.qa;
    if (qaChanged || 'targetLanguage' in patch) {
      for (const st of states.values()) resetSession(st);
    }
    // 換了目標語言連帶換了模型的輸出語言，可用性要重查
    if ('targetLanguage' in patch) refreshModelState();
  });

  chrome.tabs.onActivated.addListener(() => loadArticle().catch(() => {}));
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (id === activeId && info.status === 'complete') loadArticle().catch(() => {});
  });
}

function bind() {
  // 手動重新讀取是明確的意圖，就算沒換頁也要重跑
  $('reload').addEventListener('click', () => loadArticle({ force: true }));
  $('summarize').addEventListener('click', () => summarize());
  $('ask').addEventListener('click', () => ask());
  $('resetChat').addEventListener('click', resetSession);

  const box = $('question');
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ask();
    }
  });
  box.addEventListener('input', () => {
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, 130) + 'px';
  });
}

/* ------------------------------------------------------------ 畫面 */

/**
 * 把某個分頁的狀態畫到畫面上。
 *
 * 所有會動到 DOM 的地方都先問 isCurrent(st) —— 背景分頁的工作跑完時，
 * 畫面上是別一頁，直接寫進去就會張冠李戴。
 */
function render(st) {
  paintNotice(st.notice);
  $('chat').replaceChildren(...(st.chatEl ? [st.chatEl] : []));
  renderSummaryArea(st);
  updateQuota(st.session);
}

function renderSummaryArea(st) {
  const body = $('summaryBody');
  switch (st.summary.status) {
    case 'running':
      body.replaceChildren(progressNode(st.summary.progress ?? '處理中…'));
      break;
    case 'done':
      renderSummary(st.summary.result);
      break;
    case 'error':
      body.replaceChildren();
      showSummaryError(st.summary.error);
      break;
    default:
      renderIdle(st);
  }
  updateButtons(st);
}

function updateButtons(st) {
  const canRun = !!st.article && modelAvailability !== 'unavailable';
  $('summarize').disabled = !canRun || st.busy;
  $('ask').disabled = !canRun || st.busy;
  $('summarize').textContent = st.summary.status === 'done' ? '重新產生' : '產生摘要';
}

function progressNode(text) {
  const p = document.createElement('p');
  p.className = 'small muted';
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  p.append(spinner, ' ' + text);
  return p;
}

/** 記下進度並且只在這個分頁還顯示著的時候更新畫面。 */
function setProgress(st, text) {
  st.summary.progress = text;
  if (isCurrent(st)) $('summaryBody').replaceChildren(progressNode(text));
}

/* ---------------------------------------------------------- 取得正文 */

/* ---------------------------------------------------------- 取得正文 */

async function loadArticle({ force = false } = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const url = tab.url ?? '';
  const switched = tab.id !== activeId;
  const st = stateFor(tab.id);
  activeId = tab.id;

  $('pageTitle').textContent = tab.title || '—';
  $('pageUrl').textContent = tab.url || '';

  // 剛切過來：先把這個分頁既有的狀態畫出來。摘要可能還在背景跑，
  // 也可能早就跑完在等他 —— 兩種都要立刻看得到。
  if (switched) render(st);

  // 同一個分頁、同一個網址、正文也還在 → 沒事可做。
  // onActivated 對**任何視窗**的分頁切換都會觸發，這道防線讓那些噪音變成 no-op。
  if (!force && st.article && st.url === url) return;

  // 同一個分頁換了網址（或使用者按了重新讀取）：舊的摘要與對話對不上新內容了
  if (st.url !== null && (st.url !== url || force)) discard(st);

  st.url = url;
  const gen = st.generation;

  const res = await sendToTab(tab.id, MSG.EXTRACT_ARTICLE);
  // 抽取期間又換頁 / 內容作廢了就不要再寫回去
  if (gen !== st.generation) return;

  if (!res?.text) {
    st.article = null;

    // PDF 不做摘要。這裡要講清楚是「不支援」而不是「讀不到」——
    // 後者會讓人以為重新整理或換個開法就有救。
    if (await isPdfTab(tab)) {
      if (gen !== st.generation) return;
      setNotice(st, 'warn',
        'PDF 不支援摘要與問答。\n'
        + 'ReadDuck 的 PDF 檢視器仍然可以做雙語對照翻譯。');
    } else {
      // PDF 也可能落到這裡 —— tabs.query() 對自己的檢視器分頁不一定給得出 url，
      // isPdfTab() 就認不出來。所以這則訊息也要把 PDF 列進去。
      setNotice(st, 'warn',
        '讀不到這個頁面的內容。可能是尚未載入 ReadDuck（重新整理即可）、'
        + '這是瀏覽器內部頁面，或這是 PDF —— PDF 不支援摘要。');
    }
    if (isCurrent(st)) { renderSummaryArea(st); }
    return;
  }

  clearNotice(st);
  st.article = res;
  if (isCurrent(st)) renderSummaryArea(st);
}

/**
 * 這個分頁是不是 PDF（不論用哪個檢視器開的）。
 *
 * 依序試四種判斷，因為每一種都有各自漏掉的情況：
 *  1. ReadDuck 自己的檢視器 —— 但 tabs.query() 對 chrome-extension:// 不一定
 *     給得出 url（要有 tabs 權限，而 <all_urls> 不涵蓋），所以只是盡力而為
 *  2. 副檔名 —— 最快，但 arXiv 那類網址（/pdf/1710.06963）根本沒有 .pdf
 *  3. 問 content script —— 它認得 application/pdf，但擴充功能重新載入後，
 *     還沒重新整理過的舊分頁上不會有 content script
 *  4. 問伺服器的 content-type —— 前面都失敗時的保底
 */
async function isPdfTab(tab) {
  const url = tab.url ?? '';
  if (url.startsWith(chrome.runtime.getURL('src/pdf/pdf.html'))) return true;
  if (/\.pdf($|[?#])/i.test(url)) return true;

  const state = await sendToTab(tab.id, MSG.QUERY_STATE);
  if (state?.isPdf) return true;

  if (/^https?:/i.test(url)) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      return (res.headers.get('content-type') ?? '').toLowerCase().includes('application/pdf');
    } catch {
      return false;   // 連不到就當作不是，交給後面的一般訊息
    }
  }
  return false;
}

/* ------------------------------------------------------ 語言模型狀態 */

/**
 * 檢查裝置端語言模型的狀態。
 *
 * 摘要、解釋、問答用的是基礎語言模型，和翻譯用的專家模型是兩套東西 ——
 * 翻譯能用完全不代表這個也在。所以側邊欄一開就查清楚並顯示出來。
 */
async function refreshModelState() {
  clearTimeout(recheckTimer);
  modelAvailability = isLanguageModelPresent()
    ? await checkAvailability(currentModelLanguage())
    : 'unavailable';

  // 別的分頁或別的功能正在下載時，等它完成後自動更新畫面
  if (modelAvailability === 'downloading') {
    recheckTimer = setTimeout(() => refreshModelState(), 5000);
  }
  const st = current();
  if (st) renderSummaryArea(st);
}

/** 這個分頁目前該讓模型用哪種語言輸出。availability 與 create 都需要它。 */
function currentModelLanguage() {
  return planOutputLanguage(settings.targetLanguage).modelLanguage;
}

/** 還沒開始摘要時的畫面：正文統計 + 模型狀態。 */
function renderIdle(st) {
  const body = $('summaryBody');
  body.innerHTML = '';

  if (st.article) {
    const p = document.createElement('p');
    p.className = 'small muted';
    p.textContent = `已讀取 ${st.article.text.length.toLocaleString()} 個字元，`
      + `約 ${estimateTokens(st.article.text).toLocaleString()} tokens。`;
    body.appendChild(p);
  }

  switch (modelAvailability) {
    case 'available':
      body.appendChild(statusRow('ok', '裝置端語言模型已就緒，全部在本機執行。'));
      break;

    case 'downloading':
      body.appendChild(statusRow('warn', '裝置端語言模型正在下載中，完成後就能使用。'));
      break;

    case 'downloadable': {
      // 開啟側邊欄時只告知狀態，不直接跳確認框 —— 使用者可能只是想看看正文統計。
      // 按鈕本身就是明確的同意，不必再問一次。
      const holder = document.createElement('div');
      holder.className = 'stack';
      holder.style.gap = '8px';
      holder.appendChild(statusRow('warn', DOWNLOAD_NOTICE.short));

      const actions = document.createElement('div');
      actions.className = 'row';
      const btn = document.createElement('button');
      btn.className = 'primary';
      btn.textContent = DOWNLOAD_NOTICE.action;
      btn.addEventListener('click', () => downloadModel(holder));
      actions.appendChild(btn);
      holder.appendChild(actions);

      body.appendChild(holder);
      break;
    }

    case 'unavailable': {
      const info = explainUnavailable('unavailable', 'Prompt API');
      const box = document.createElement('div');
      box.className = 'notice err';
      const title = document.createElement('strong');
      title.textContent = info.title;
      const text = document.createElement('div');
      text.textContent = info.body;
      box.append(title, text);
      body.appendChild(box);
      break;
    }

    default:
      break;
  }
}

function statusRow(kind, text) {
  const row = document.createElement('div');
  row.className = 'row small muted';
  row.style.gap = '7px';
  const dot = document.createElement('span');
  dot.className = `dot ${kind}`;
  const label = document.createElement('span');
  label.textContent = text;
  row.append(dot, label);
  return row;
}

/** 使用者同意後，實際觸發模型下載。 */
async function downloadModel(container) {
  const plan = planOutputLanguage(settings.targetLanguage);
  container.innerHTML = '<p class="small muted"><span class="spinner"></span> 準備下載…</p>';
  try {
    const s = await createSession({
      outputLanguage: plan.modelLanguage,
      onDownloadProgress: (l) => {
        container.innerHTML =
          `<p class="small muted"><span class="spinner"></span> 下載中… ${Math.round(l * 100)}%</p>`;
      },
    });
    s.destroy?.();
    await refreshModelState();
  } catch (err) {
    container.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'notice err';
    box.textContent = `下載失敗：${err?.message || err}`;
    container.appendChild(box);
  }
}

/* ------------------------------------------------------------ 摘要 */

async function summarize() {
  const st = current();
  if (!st?.article || st.busy) return;

  const gate = await ensureModel();
  if (!gate) return;

  // 側邊欄開啟時就查過了，這裡再確認一次 —— 狀態可能在這段時間內變了
  // （例如使用者剛剛在別的分頁下載完）。
  if (await needsDownloadConsent(currentModelLanguage())) {
    const agreed = await confirmDownload($('summaryBody'));
    if (!agreed) { await refreshModelState(); return; }
    await downloadModel($('summaryBody'));
    if (modelAvailability !== 'available') return;
  }

  // 這次摘要的素材與世代先固定下來。底下每一個 await 之間都可能換頁或換網址，
  // 之後一律用 target，不要再讀 st.article —— 否則標題和正文會來自不同頁。
  const target = st.article;
  const gen = st.generation;

  st.busy = true;
  st.controller?.abort();
  st.controller = new AbortController();
  const { signal } = st.controller;

  st.summary = { status: 'running', progress: '閱讀中…', result: null, error: null };
  if (isCurrent(st)) renderSummaryArea(st);

  try {
    const plan = planOutputLanguage(settings.targetLanguage);
    const config = {
      systemPrompt: summarySystemPrompt(plan.modelLanguage, settings.customPrompts),
      mode: 'balanced',
      outputLanguage: plan.modelLanguage,
    };
    const s = await createSession({
      ...config,
      signal,
      onDownloadProgress: (l) => setProgress(st,
        `正在下載裝置端語言模型（只需下載一次）… ${Math.round(l * 100)}%`),
    });

    const { total } = usage(s);
    // 留一半空間給 system prompt、輸出與後續追問
    const budget = Math.max(1024, Math.floor((total || 4096) * 0.5));
    let source = target.text;

    if (estimateTokens(source) > budget) {
      source = await mapReduce(target.text, budget, plan, signal, (i, n) => {
        setProgress(st, `文章較長，分段閱讀中… ${i}/${n}`);
      });
    }

    const input = `標題：${target.title}\n\n正文：\n${source}`;
    const result = await promptJson(s, input, SUMMARY_SCHEMA, { signal });
    s.destroy?.();

    const localized = await localizeSummary(result, plan, signal);
    // 跑完才發現這份內容已經作廢（換了網址或手動重讀）
    if (gen !== st.generation) return;
    st.summary = { status: 'done', progress: null, result: localized, error: null };
  } catch (err) {
    if (err?.name === 'AbortError' || gen !== st.generation) return;
    st.summary = { status: 'error', progress: null, result: null, error: err };
  } finally {
    if (gen === st.generation) {
      st.busy = false;
      // 使用者可能已經切到別的分頁了 —— 那就只更新狀態，畫面留給那一頁
      if (isCurrent(st)) renderSummaryArea(st);
    }
  }
}

/**
 * 文章超過上下文長度時的處理：分段各自濃縮，再把濃縮結果接起來當作正文。
 */
async function mapReduce(text, budget, plan, signal, onProgress) {
  const chunks = chunkText(text, Math.floor(budget * 0.8));
  // 分段摘要是中繼結果，不轉譯 —— 它會再餵回模型做最終摘要，
  // 保持在模型的原生輸出語言比較準，也省掉一輪翻譯。
  // 分支降級時要靠同一份設定重建，所以先留著
  const config = {
    systemPrompt: chunkSummarySystemPrompt(plan.modelLanguage, settings.customPrompts),
    mode: 'precise',
    outputLanguage: plan.modelLanguage,
  };
  const s = await createSession({ ...config, signal });

  const parts = [];
  let lastError = null;

  try {
    for (let i = 0; i < chunks.length; i++) {
      onProgress(i + 1, chunks.length);
      // 每段用 clone 跑，避免前一段的內容影響下一段
      const branch = await forkSession(s, config, { signal });
      try {
        parts.push(await branch.prompt(chunks[i], { signal }));
      } catch (err) {
        lastError = err;
        if (err?.name === 'AbortError') throw err;
        // 模型行程崩潰時立刻停手。每一段都試一次就是崩潰一次，而瀏覽器對
        // 重複崩潰的容忍度只有個位數 —— 一篇長文足以在單次摘要裡就把整個
        // 模型版本弄成停用狀態。這裡少做幾段，換的是後面所有 AI 功能還活著。
        if (isModelCrashError(err)) throw err;
        // err 直接丟給 console 會被序列化成 [object DOMException]，
        // name 和 message 全部看不到，等於沒有記錄
        console.warn(
          isQuotaError(err) ? '[ReadDuck] 分段仍然過長，略過這一段：' : '[ReadDuck] 分段摘要失敗：',
          describeError(err),
        );
      } finally {
        branch.destroy?.();
      }
    }
  } finally {
    // 取消或中途拋錯時也要放掉基底 session，否則模型會一直留在記憶體裡
    s.destroy?.();
  }

  // 全部失敗時不能回空字串 —— 那會讓模型去摘要一篇沒有內容的文章，
  // 使用者拿到一段憑空捏造的摘要，卻不知道中間全錯了
  if (!parts.length) {
    throw lastError ?? new Error('文章分段後每一段都摘要失敗，沒有可用的內容。');
  }

  return parts.join('\n\n');
}

/** 把摘要的各個欄位轉成目標語言。專有名詞本身不翻，只翻解釋。 */
async function localizeSummary(result, plan, signal) {
  if (!plan.needsTranslation) return result;
  const opts = { signal };
  const [oneLiner, bullets, terms] = await Promise.all([
    localizeText(result.oneLiner, plan, opts),
    localizeAll(result.bullets, plan, opts),
    Promise.all((result.terms ?? []).map(async (t) => ({
      term: t.term,
      explain: await localizeText(t.explain, plan, opts),
    }))),
  ]);
  return { oneLiner, bullets, terms };
}

function renderSummary({ oneLiner, bullets, terms }) {
  const body = $('summaryBody');
  body.innerHTML = '';

  if (oneLiner) {
    const p = document.createElement('p');
    p.className = 'oneliner';
    p.textContent = oneLiner;
    body.appendChild(p);
  }
  if (bullets?.length) {
    const ul = document.createElement('ul');
    for (const b of bullets) {
      const li = document.createElement('li');
      li.textContent = b;
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }
  if (terms?.length) {
    const wrap = document.createElement('div');
    wrap.className = 'terms';
    for (const t of terms) {
      const d = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = t.term;
      d.append(b, document.createTextNode(`：${t.explain}`));
      wrap.appendChild(d);
    }
    body.append(document.createElement('hr'), wrap);
    wrap.previousSibling.className = 'divider';
  }
}

function showSummaryError(err) {
  if (isQuotaError(err)) {
    showNotice('err', `這篇文章超出模型的上下文長度（需要 ${err.requested}，上限 ${err.contextWindow}）。`);
    return;
  }
  showNotice('err', `摘要失敗：${explainModelError(err)}`);
}

/* ------------------------------------------------------------ 問答 */

async function ask() {
  const box = $('question');
  const question = box.value.trim();
  const st = current();
  if (!question || !st || st.busy) return;
  if (!st.article) { showNotice('warn', '還沒讀到頁面內容。'); return; }

  const gate = await ensureModel();
  if (!gate) return;

  if (!st.session && await needsDownloadConsent(currentModelLanguage())) {
    const holder = document.createElement('div');
    holder.className = 'card';
    chatOf(st).appendChild(holder);
    $('scroll').scrollTop = $('scroll').scrollHeight;
    const agreed = await confirmDownload(holder);
    if (!agreed) { holder.remove(); await refreshModelState(); return; }
    await downloadModel(holder);
    holder.remove();
    if (modelAvailability !== 'available') return;
  }

  box.value = '';
  box.style.height = 'auto';
  appendMessage(st, 'user', question);

  const bubble = appendMessage(st, 'assistant', '');
  const gen = st.generation;
  st.busy = true;
  if (isCurrent(st)) updateButtons(st);
  st.controller?.abort();
  st.controller = new AbortController();

  try {
    if (!st.session) st.session = await createQaSession(st, st.controller.signal);

    // append() 不可用時，把正文夾在第一個提問前面（只做一次）
    const input = st.pendingContext ? `${st.pendingContext}\n\nQuestion: ${question}` : question;
    st.pendingContext = null;

    await promptLocalized(st.session, input, {
      plan: st.qaPlan,
      signal: st.controller.signal,
      onChunk: (partial) => bubble.setText(partial, true),
    });
    bubble.commit();
    if (isCurrent(st)) updateQuota(st.session);
  } catch (err) {
    if (err?.name === 'AbortError') { bubble.commit(); return; }
    // 對話已經作廢（換了網址）：這顆泡泡不在任何畫面上了
    if (gen !== st.generation) return;
    if (isQuotaError(err)) {
      bubble.setError(`對話已經超出模型的上下文長度（需要 ${err.requested}，上限 ${err.contextWindow}）。請按「重設對話」重新開始。`);
    } else {
      bubble.setError(`發生錯誤：${explainModelError(err)}`);
    }
  } finally {
    if (gen === st.generation) {
      st.busy = false;
      if (isCurrent(st)) updateButtons(st);
    }
  }
}

async function createQaSession(st, signal) {
  st.qaPlan = planOutputLanguage(settings.targetLanguage);
  const s = await createSession({
    systemPrompt: qaSystemPrompt(st.qaPlan.modelLanguage, settings.customPrompts),
    mode: 'balanced',
    outputLanguage: st.qaPlan.modelLanguage,
    signal,
  });

  const { total } = usage(s);
  const budget = Math.max(1024, Math.floor((total || 4096) * 0.55));
  let text = st.article.text;
  if (estimateTokens(text) > budget) {
    // 問答不像摘要可以慢慢分段，這裡直接截斷並告知使用者
    const chunks = chunkText(text, budget);
    text = chunks[0];
    setNotice(st, 'warn', '文章較長，問答只涵蓋前半部內容。需要完整內容請先產生摘要。');
  }
  const context =
    'Here is the article. Answer all following questions from it. '
    + 'Questions may be written in any language; always answer in the language you were instructed to use.'
    + `\n\nTitle: ${st.article.title}\n\n${text}`;
  // append() 把正文放進上下文但不觸發生成，是最省事的做法；
  // 舊版瀏覽器沒有這個方法，退回「夾在第一個提問前面」。
  if (typeof s.append === 'function') {
    await s.append([{ role: 'user', content: context }]);
    st.pendingContext = null;
  } else {
    st.pendingContext = context;
  }
  if (isCurrent(st)) updateQuota(s);
  return s;
}

/** 這個分頁的對話容器。它可以是脫離文件的 —— 串流中的泡泡照樣寫得進去。 */
function chatOf(st) {
  if (!st.chatEl) {
    st.chatEl = document.createElement('div');
    if (isCurrent(st)) $('chat').replaceChildren(st.chatEl);
  }
  return st.chatEl;
}

function resetSession(st = current()) {
  if (!st) return;
  st.session?.destroy?.();
  st.session = null;
  st.qaPlan = null;
  st.pendingContext = null;
  st.chatEl = null;
  if (isCurrent(st)) {
    $('chat').replaceChildren();
    $('quota').hidden = true;
  }
}

function updateQuota(s) {
  if (!s) { $('quota').hidden = true; return; }
  const { used, total, ratio } = usage(s);
  if (!total) { $('quota').hidden = true; return; }
  $('quota').hidden = false;
  $('quotaText').textContent = `上下文 ${used.toLocaleString()} / ${total.toLocaleString()}（${Math.round(ratio * 100)}%）`;
}

/* ------------------------------------------------------------ 共用 */

function appendMessage(st, who, text) {
  const chat = chatOf(st);
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  const label = document.createElement('div');
  label.className = 'who';
  label.textContent = who === 'user' ? '你' : 'ReadDuck';
  const body = document.createElement('div');
  body.className = 'text';
  body.textContent = text;
  el.append(label, body);
  chat.appendChild(el);
  $('scroll').scrollTop = $('scroll').scrollHeight;

  return {
    setText(t, streaming) {
      body.textContent = t;
      if (streaming) {
        const caret = document.createElement('span');
        caret.className = 'caret';
        body.appendChild(caret);
      }
      $('scroll').scrollTop = $('scroll').scrollHeight;
    },
    commit() { body.querySelector('.caret')?.remove(); },
    setError(msg) {
      body.textContent = '';
      const e = document.createElement('div');
      e.className = 'notice err';
      e.textContent = msg;
      body.appendChild(e);
    },
  };
}

/**
 * 問使用者要不要下載語言模型。
 * 使用者按的是「產生摘要」，不是「下載數 GB 的模型」，所以要先問過。
 * @returns {Promise<boolean>}
 */
function confirmDownload(container) {
  return new Promise((resolve) => {
    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'stack';

    const title = document.createElement('strong');
    title.textContent = DOWNLOAD_NOTICE.title;

    const msg = document.createElement('p');
    msg.className = 'small muted';
    msg.style.whiteSpace = 'pre-wrap';
    msg.textContent = DOWNLOAD_NOTICE.body;

    const row = document.createElement('div');
    row.className = 'row';
    row.style.gap = '8px';

    const yes = document.createElement('button');
    yes.className = 'primary';
    yes.textContent = DOWNLOAD_NOTICE.confirm;
    yes.addEventListener('click', () => resolve(true));

    const no = document.createElement('button');
    no.textContent = DOWNLOAD_NOTICE.cancel;
    no.addEventListener('click', () => resolve(false));

    row.append(yes, no);
    wrap.append(title, msg, row);
    container.appendChild(wrap);
    yes.focus();
  });
}

/** 確認模型可用，不可用就顯示引導並回傳 false。 */
async function ensureModel() {
  if (!isLanguageModelPresent()) {
    showNotice('err', explainUnavailable('unavailable', 'Prompt API').body);
    return false;
  }
  const availability = await checkAvailability(currentModelLanguage());
  if (availability === 'unavailable') {
    const info = explainUnavailable('unavailable', 'Prompt API');
    showNotice('err', `${info.title}\n${info.body}`);
    return false;
  }
  hideNotice();
  return true;
}

/** 訊息也是每個分頁一份 —— 換頁時不該看到上一頁的警告。 */
function setNotice(st, kind, text, action) {
  st.notice = { kind, text, action };
  if (isCurrent(st)) paintNotice(st.notice);
}

function clearNotice(st) {
  st.notice = null;
  if (isCurrent(st)) paintNotice(null);
}

/** 沒有 state 在手上的呼叫端用這兩個，作用在目前顯示的分頁。 */
function showNotice(kind, text, action) {
  const st = current();
  if (st) return setNotice(st, kind, text, action);
  paintNotice({ kind, text, action });
}

function hideNotice() {
  const st = current();
  if (st) return clearNotice(st);
  paintNotice(null);
}

function paintNotice(notice) {
  const el = $('notice');
  if (!notice) { el.hidden = true; return; }
  const { kind, text, action } = notice;
  el.className = `notice ${kind}`;
  el.textContent = text;

  if (action) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.marginTop = '8px';
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    row.appendChild(btn);
    el.appendChild(row);
  }
  el.hidden = false;
}
