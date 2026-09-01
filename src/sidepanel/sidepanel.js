import { MSG, send, sendToTab, PDF_VIEWER_SOURCE } from '../lib/messaging.js';
import { getSettings } from '../lib/settings.js';
import {
  createSession, planOutputLanguage, promptJson, usage,
  estimateTokens, chunkText, isLanguageModelPresent, checkAvailability, isQuotaError,
  needsDownloadConsent, DOWNLOAD_NOTICE,
} from '../ai/language-model.js';
import { promptLocalized, localizeText, localizeAll } from '../ai/localize.js';
import {
  summarySystemPrompt, chunkSummarySystemPrompt, qaSystemPrompt, SUMMARY_SCHEMA,
} from '../ai/prompts.js';
import { explainUnavailable } from '../ai/capability.js';

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

let settings = null;
let article = null;      // { title, url, text }
let tabId = null;
let session = null;      // 問答用的長期 session
let qaPlan = null;       // 這個 session 的輸出語言規劃
let modelAvailability = null;  // 語言模型的下載狀態
let recheckTimer = null;
/** session.append() 不可用時，正文改成夾在第一個提問前面送出 */
let pendingContext = null;
let controller = null;
let busy = false;

init().catch((e) => showNotice('err', `初始化失敗：${e.message}`));

async function init() {
  settings = await getSettings();
  bind();
  // 側邊欄一打開就先確認語言模型在不在，讓使用者在按下任何按鈕之前
  // 就知道狀態，而不是按了「產生摘要」才發現要下載數 GB。
  await Promise.all([loadArticle(), refreshModelState()]);

  chrome.tabs.onActivated.addListener(() => loadArticle().catch(() => {}));
  chrome.tabs.onUpdated.addListener((id, info) => {
    if (id === tabId && info.status === 'complete') loadArticle().catch(() => {});
  });
}

function bind() {
  $('reload').addEventListener('click', () => loadArticle());
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

/* ---------------------------------------------------------- 取得正文 */

async function loadArticle() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  tabId = tab.id;

  $('pageTitle').textContent = tab.title || '—';
  $('pageUrl').textContent = tab.url || '';

  // 先問那個分頁裡有沒有 ReadDuck 的 PDF 檢視器（它是擴充功能頁面，上面沒有
  // content script，只能用 runtime 訊息問）。
  //
  // 這裡刻意**不**靠 tab.url 判斷：tabs.query() 只有在擴充功能具備 tabs 權限、
  // 或 host permissions 涵蓋該網址時才會回傳 url，而 <all_urls> 並不涵蓋
  // chrome-extension://。也就是說我們自己的檢視器分頁，tab.url 是 undefined。
  const viewer = await extractFromViewer(tab.id);
  const isPdfViewer = viewer.answered;
  const res = isPdfViewer ? viewer.article : await sendToTab(tab.id, MSG.EXTRACT_ARTICLE);

  if (!res?.text) {
    article = null;
    $('summarize').disabled = true;

    // 瀏覽器內建的 PDF 檢視器不開放頁面文字。這裡不能只說「讀不到」，
    // 要直接給出可行的下一步 —— 用 ReadDuck 的檢視器開啟就能摘要。
    if (!isPdfViewer && await isNativePdfTab(tab)) {
      showNotice('warn',
        '瀏覽器內建的 PDF 檢視器不開放頁面文字，所以讀不到內容。\n'
        + '用 ReadDuck 的檢視器開啟這份 PDF 就能摘要。',
        { label: '用 ReadDuck 開啟', onClick: () => send(MSG.OPEN_PDF, { url: tab.url }) });
      return;
    }

    showNotice('warn', isPdfViewer
      ? '這份 PDF 沒有可抽取的文字（例如掃描檔）。'
      : '讀不到這個頁面的內容。可能是尚未載入 ReadDuck（重新整理即可），或這是瀏覽器內部頁面。');
    return;
  }
  hideNotice();
  article = res;
  $('summarize').textContent = '產生摘要';
  resetSession();
  renderIdle();
}

/**
 * 向 ReadDuck 的 PDF 檢視器要正文。
 *
 * 檔案還在解析時檢視器會回報 pending，這裡等它一下再問 —— 使用者常常一開檔
 * 就順手把側邊欄打開，那時候文件通常還沒讀完。
 *
 * @returns {Promise<{ answered: boolean, article: object|null }>}
 *   answered=false 代表那個分頁裡沒有檢視器，要改走 content script。
 */
async function extractFromViewer(tabId, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    const res = await send(MSG.EXTRACT_ARTICLE, { tabId });
    // 沒有帶標記就不是檢視器答的，代表這個分頁裡沒有檢視器
    if (res?.source !== PDF_VIEWER_SOURCE) return { answered: false, article: null };
    if (!res.pending) return { answered: true, article: res.text ? res : null };
    setStatusLoading(i);
    await new Promise((r) => setTimeout(r, 500));
  }
  return { answered: true, article: null };
}

function setStatusLoading(attempt) {
  $('summaryBody').innerHTML =
    `<p class="small muted"><span class="spinner"></span> PDF 讀取中…${attempt > 4 ? '（檔案較大，請稍候）' : ''}</p>`;
}

/**
 * 這個分頁是不是用瀏覽器內建檢視器開的 PDF。
 *
 * 三種判斷依序試，因為每一種都有各自漏掉的情況：
 *  1. 副檔名 —— 最快，但 arXiv 那類網址（/pdf/1710.06963）根本沒有 .pdf
 *  2. 問 content script —— 它認得 application/pdf，但擴充功能重新載入後，
 *     還沒重新整理過的舊分頁上不會有 content script
 *  3. 問伺服器的 content-type —— 前兩者都失敗時的保底
 */
async function isNativePdfTab(tab) {
  const url = tab.url ?? '';
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
  renderIdle();
}

/** 這個分頁目前該讓模型用哪種語言輸出。availability 與 create 都需要它。 */
function currentModelLanguage() {
  return planOutputLanguage(settings.targetLanguage).modelLanguage;
}

/** 還沒開始摘要時的畫面：正文統計 + 模型狀態。 */
function renderIdle() {
  const body = $('summaryBody');
  if (busy) return;
  body.innerHTML = '';

  if (article) {
    const p = document.createElement('p');
    p.className = 'small muted';
    p.textContent = `已讀取 ${article.text.length.toLocaleString()} 個字元，`
      + `約 ${estimateTokens(article.text).toLocaleString()} tokens。`;
    body.appendChild(p);
  }

  const canRun = !!article && modelAvailability !== 'unavailable';
  $('summarize').disabled = !canRun;
  $('ask').disabled = !canRun;

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
  if (!article || busy) return;
  const gate = await ensureModel();
  if (!gate) return;

  const body = $('summaryBody');

  // 側邊欄開啟時就查過了，這裡再確認一次 —— 狀態可能在這段時間內變了
  // （例如使用者剛剛在別的分頁下載完）。
  if (await needsDownloadConsent(currentModelLanguage())) {
    const agreed = await confirmDownload(body);
    if (!agreed) { await refreshModelState(); return; }
    await downloadModel(body);
    if (modelAvailability !== 'available') return;
  }

  busy = true;
  $('summarize').disabled = true;
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;

  body.innerHTML = '<p class="small muted"><span class="spinner"></span> 閱讀中…</p>';

  try {
    const plan = planOutputLanguage(settings.targetLanguage);
    const s = await createSession({
      systemPrompt: summarySystemPrompt(plan.modelLanguage),
      mode: 'balanced',
      outputLanguage: plan.modelLanguage,
      signal,
      onDownloadProgress: (l) => {
        body.innerHTML = `<p class="small muted"><span class="spinner"></span> 正在下載裝置端語言模型（只需下載一次）… ${Math.round(l * 100)}%</p>`;
      },
    });

    const { total } = usage(s);
    // 留一半空間給 system prompt、輸出與後續追問
    const budget = Math.max(1024, Math.floor((total || 4096) * 0.5));
    let source = article.text;

    if (estimateTokens(source) > budget) {
      source = await mapReduce(article.text, budget, plan, signal, (i, n) => {
        body.innerHTML = `<p class="small muted"><span class="spinner"></span> 文章較長，分段閱讀中… ${i}/${n}</p>`;
      });
    }

    const input = `標題：${article.title}\n\n正文：\n${source}`;
    const result = await promptJson(s, input, SUMMARY_SCHEMA, { signal });
    s.destroy?.();

    renderSummary(await localizeSummary(result, plan, signal));
  } catch (err) {
    if (err?.name === 'AbortError') return;
    body.innerHTML = '';
    showSummaryError(err);
  } finally {
    busy = false;
    $('summarize').disabled = !article;
    $('summarize').textContent = '重新產生';
  }
}

/**
 * 文章超過上下文長度時的處理：分段各自濃縮，再把濃縮結果接起來當作正文。
 */
async function mapReduce(text, budget, plan, signal, onProgress) {
  const chunks = chunkText(text, Math.floor(budget * 0.8));
  // 分段摘要是中繼結果，不轉譯 —— 它會再餵回模型做最終摘要，
  // 保持在模型的原生輸出語言比較準，也省掉一輪翻譯。
  const s = await createSession({
    systemPrompt: chunkSummarySystemPrompt(plan.modelLanguage),
    mode: 'precise',
    outputLanguage: plan.modelLanguage,
    signal,
  });

  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress(i + 1, chunks.length);
    // 每段用 clone 跑，避免前一段的內容影響下一段
    const branch = await s.clone({ signal });
    try {
      parts.push(await branch.prompt(chunks[i], { signal }));
    } catch (err) {
      if (isQuotaError(err)) {
        console.warn('[ReadDuck] 分段仍然過長，略過這一段', err);
      } else if (err?.name === 'AbortError') {
        throw err;
      } else {
        console.warn('[ReadDuck] 分段摘要失敗', err);
      }
    } finally {
      branch.destroy?.();
    }
  }
  s.destroy?.();
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
  showNotice('err', `摘要失敗：${err?.message || err}`);
}

/* ------------------------------------------------------------ 問答 */

async function ask() {
  const box = $('question');
  const question = box.value.trim();
  if (!question || busy) return;
  if (!article) { showNotice('warn', '還沒讀到頁面內容。'); return; }

  const gate = await ensureModel();
  if (!gate) return;

  if (!session && await needsDownloadConsent(currentModelLanguage())) {
    const holder = document.createElement('div');
    holder.className = 'card';
    $('chat').appendChild(holder);
    $('scroll').scrollTop = $('scroll').scrollHeight;
    const agreed = await confirmDownload(holder);
    if (!agreed) { holder.remove(); await refreshModelState(); return; }
    await downloadModel(holder);
    holder.remove();
    if (modelAvailability !== 'available') return;
  }

  box.value = '';
  box.style.height = 'auto';
  appendMessage('user', question);

  const bubble = appendMessage('assistant', '');
  busy = true;
  $('ask').disabled = true;
  controller?.abort();
  controller = new AbortController();

  try {
    if (!session) session = await createQaSession(controller.signal);

    // append() 不可用時，把正文夾在第一個提問前面（只做一次）
    const input = pendingContext ? `${pendingContext}\n\nQuestion: ${question}` : question;
    pendingContext = null;

    await promptLocalized(session, input, {
      plan: qaPlan,
      signal: controller.signal,
      onChunk: (partial) => bubble.setText(partial, true),
    });
    bubble.commit();
    updateQuota();
  } catch (err) {
    if (err?.name === 'AbortError') { bubble.commit(); return; }
    if (isQuotaError(err)) {
      bubble.setError(`對話已經超出模型的上下文長度（需要 ${err.requested}，上限 ${err.contextWindow}）。請按「重設對話」重新開始。`);
    } else {
      bubble.setError(`發生錯誤：${err?.message || err}`);
    }
  } finally {
    busy = false;
    $('ask').disabled = false;
  }
}

async function createQaSession(signal) {
  qaPlan = planOutputLanguage(settings.targetLanguage);
  const s = await createSession({
    systemPrompt: qaSystemPrompt(qaPlan.modelLanguage),
    mode: 'balanced',
    outputLanguage: qaPlan.modelLanguage,
    signal,
  });

  const { total } = usage(s);
  const budget = Math.max(1024, Math.floor((total || 4096) * 0.55));
  let text = article.text;
  if (estimateTokens(text) > budget) {
    // 問答不像摘要可以慢慢分段，這裡直接截斷並告知使用者
    const chunks = chunkText(text, budget);
    text = chunks[0];
    showNotice('warn', '文章較長，問答只涵蓋前半部內容。需要完整內容請先產生摘要。');
  }
  const context =
    'Here is the article. Answer all following questions from it. '
    + 'Questions may be written in any language; always answer in the language you were instructed to use.'
    + `\n\nTitle: ${article.title}\n\n${text}`;
  // append() 把正文放進上下文但不觸發生成，是最省事的做法；
  // 舊版瀏覽器沒有這個方法，退回「夾在第一個提問前面」。
  if (typeof s.append === 'function') {
    await s.append([{ role: 'user', content: context }]);
    pendingContext = null;
  } else {
    pendingContext = context;
  }
  updateQuota(s);
  return s;
}

function resetSession() {
  session?.destroy?.();
  session = null;
  qaPlan = null;
  pendingContext = null;
  $('chat').innerHTML = '';
  $('quota').hidden = true;
}

function updateQuota(s = session) {
  if (!s) { $('quota').hidden = true; return; }
  const { used, total, ratio } = usage(s);
  if (!total) { $('quota').hidden = true; return; }
  $('quota').hidden = false;
  $('quotaText').textContent = `上下文 ${used.toLocaleString()} / ${total.toLocaleString()}（${Math.round(ratio * 100)}%）`;
}

/* ------------------------------------------------------------ 共用 */

function appendMessage(who, text) {
  const chat = $('chat');
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

function showNotice(kind, text, action) {
  const el = $('notice');
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

function hideNotice() { $('notice').hidden = true; }
