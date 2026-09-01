import { normalizeAvailability, describeError } from './capability.js';
import { canonical } from './languages.js';
import { currentBrowser, BROWSER_PROFILES } from '../lib/browser.js';

/**
 * LanguageModel（Prompt API）的 session 管理。
 *
 * 幾個實務重點：
 * - **每次請求都必須指定輸出語言。** 沒指定的話 Chrome 會在 console 警告
 *   「No output language was specified」，而且輸出品質與安全性都無法保證。
 *   可用的輸出語言由瀏覽器決定（見 promptOutputLanguages()）：Chrome 是
 *   en / ja / es / de / fr，Edge 只有 en。中文兩邊都不在其中，所以中文一律走
 *   「模型輸出英文 → Translator API 轉中文」的雙段管線，
 *   見 planOutputLanguage() 與 localize.js。
 * - params() 是擴充功能專屬能力，一般網頁拿不到 topK / temperature 調整權。
 *   翻譯與摘要這類任務用低 temperature 明顯更穩，這是本擴充相對網頁版的優勢。
 * - session 不 destroy() 會一直佔記憶體，離開頁面時務必清掉。
 * - 每次獨立任務用 clone() 分支，避免把一次性的提問塞進長期 session 的上下文。
 */

export function isLanguageModelPresent() {
  return typeof self !== 'undefined' && 'LanguageModel' in self;
}

/**
 * 檢查輸出語言是否合法。createSession 與 checkAvailability 共用 ——
 * 兩者都是 LanguageModel API request，都必須帶上輸出語言。
 */
function assertOutputLanguage(outputLanguage, languages = promptOutputLanguages()) {
  if (languages.includes(outputLanguage)) return;
  throw new Error(
    `Prompt API 不支援輸出語言 "${outputLanguage}"。` +
    `可用的只有 ${languages.join(' / ')}，` +
    '請先用 planOutputLanguage() 決定要讓模型輸出哪一種語言。'
  );
}

/**
 * 查詢模型可用性。
 *
 * `availability()` 本身就是一次 LanguageModel API request，不帶輸出語言呼叫
 * 同樣會讓 Chrome 警告 "No output language was specified"。因為它在每次開啟
 * 側邊欄、每次劃選、每次按摘要時都會跑，漏掉的話警告會一直洗版。
 *
 * @param {string} outputLanguage 必填，用 planOutputLanguage() 取得
 */
export async function checkAvailability(outputLanguage) {
  assertOutputLanguage(outputLanguage);
  if (!isLanguageModelPresent()) return 'unavailable';
  try {
    return normalizeAvailability(await self.LanguageModel.availability({
      expectedOutputs: [{ type: 'text', languages: [outputLanguage] }],
    }));
  } catch (e) {
    console.warn('[ReadDuck] LanguageModel.availability failed:', describeError(e));
    return 'unavailable';
  }
}

/**
 * Chrome 的 Prompt API 保證支援的輸出語言。這是模型本身的限制，不是我們的選擇。
 * 指定清單以外的語言會被拒絕；完全不指定則會拿到品質與安全性都不保證的輸出。
 *
 * 想知道「目前這個瀏覽器」能輸出什麼，請用 promptOutputLanguages() ——
 * Edge 的清單只有 en。
 */
export const PROMPT_API_OUTPUT_LANGUAGES = BROWSER_PROFILES.chrome.promptOutputLanguages;

/**
 * 目前瀏覽器的 Prompt API 可輸出語言。
 *
 * Chrome 保證 en / ja / es / de / fr；Edge（Phi-4-mini / Aion-1.0-Instruct）
 * 沒有公開保證任何語言，因此只採用 en，其餘一律交給 Translator API 轉換。
 */
export function promptOutputLanguages() {
  return currentBrowser().promptOutputLanguages;
}

/**
 * 決定「要讓模型用哪種語言輸出」以及「事後要不要轉譯」。
 *
 * 目標語言在支援清單內就直接讓模型輸出；不在清單內（例如中文）就讓模型
 * 輸出英文，再交給 Translator API 轉成目標語言。專用翻譯模型做翻譯，
 * 語言模型做理解與重組，各司其職。
 *
 * @returns {{ modelLanguage: string, finalLanguage: string, needsTranslation: boolean }}
 */
export function planOutputLanguage(targetLanguage, languages = promptOutputLanguages()) {
  const target = canonical(targetLanguage);
  if (languages.includes(target)) {
    return { modelLanguage: target, finalLanguage: target, needsTranslation: false };
  }
  return { modelLanguage: 'en', finalLanguage: target, needsTranslation: true };
}

/**
 * 語言模型尚未下載時要給使用者看的說明。
 *
 * 這個下載必須先問過使用者：它是數 GB 的檔案，而使用者按下的按鈕是
 * 「產生摘要」，不是「下載模型」。而且翻譯能用不代表這個模型也在 ——
 * Translator 與 LanguageDetector 用的是各自獨立的專家模型，
 * 摘要、解釋、問答用的才是這個基礎語言模型。
 */
export const DOWNLOAD_NOTICE = Object.freeze({
  title: '需要先下載語言模型',
  body: '摘要、解釋、簡化與問答使用瀏覽器的裝置端語言模型，'
      + '它和翻譯用的模型是分開的，所以即使翻譯已經可以用，這個仍需要另外下載。\n'
      + '檔案有數 GB，只需下載一次，之後所有 AI 功能都能直接使用。',
  confirm: '下載並繼續',
  cancel: '取消',
  /** 不是接在某個動作後面、單純要下載模型時用這個標籤 */
  action: '下載模型',
  /** 一句話版本，用於狀態列 */
  short: '尚未下載裝置端語言模型。它和翻譯用的模型是分開的，'
       + '摘要、解釋與問答需要它才能使用（數 GB，只需下載一次）。',
});

/**
 * 這次呼叫會不會觸發模型下載？
 * true 代表呼叫端應該先徵得使用者同意，再去建立 session。
 * 已經在下載中（'downloading'）不會重複詢問。
 */
export async function needsDownloadConsent(outputLanguage) {
  return (await checkAvailability(outputLanguage)) === 'downloadable';
}

let cachedParams = null;
export async function getParams() {
  if (cachedParams) return cachedParams;
  try {
    cachedParams = await self.LanguageModel.params();
  } catch {
    cachedParams = null;
  }
  return cachedParams;
}

/**
 * 建立 session。
 * @param {object} o
 * @param {string} o.systemPrompt
 * @param {'precise'|'balanced'|'creative'} [o.mode] 決定 temperature/topK
 * @param {string} o.outputLanguage **必填**，且必須是 promptOutputLanguages()
 *        裡的其中一個。用 planOutputLanguage() 取得。
 * @param {string[]} [o.inputLanguages] 用來填 expectedInputs
 */
export async function createSession({
  systemPrompt,
  mode = 'precise',
  outputLanguage,
  inputLanguages,
  signal,
  onDownloadProgress,
  initialPrompts,
} = {}) {
  if (!isLanguageModelPresent()) throw new Error('LanguageModel 不存在於此執行情境');

  const opts = { signal };

  const params = await getParams();
  if (params) {
    const factor = mode === 'creative' ? 0.9 : mode === 'balanced' ? 0.45 : 0.1;
    opts.temperature = clamp(params.defaultTemperature * factor * 2, 0, params.maxTemperature);
    opts.topK = mode === 'precise'
      ? 1
      : clamp(params.defaultTopK, 1, params.maxTopK);
  }

  const prompts = initialPrompts ? [...initialPrompts] : [];
  if (systemPrompt) prompts.unshift({ role: 'system', content: systemPrompt });
  if (prompts.length) opts.initialPrompts = prompts;

  // 輸出語言一律指定，不給呼叫端「忘記填」的空間 —— 沒填的話 Chrome 會
  // 警告 "No output language was specified"，輸出品質與安全性都不保證。
  assertOutputLanguage(outputLanguage);
  opts.expectedOutputs = [{ type: 'text', languages: [outputLanguage] }];

  // 輸入語言只宣告確定支援的，宣告不支援的會直接拋 NotSupportedError。
  // 這個欄位可以省略，省略也不會有警告。
  const inputs = dedupe((inputLanguages ?? []).map(canonical))
    .filter((l) => promptOutputLanguages().includes(l));
  if (inputs.length) {
    opts.expectedInputs = [{ type: 'text', languages: inputs }];
  }

  if (onDownloadProgress) {
    opts.monitor = (m) => {
      m.addEventListener('downloadprogress', (e) => onDownloadProgress(e.loaded));
    };
  }

  const session = await self.LanguageModel.create(opts);
  session.addEventListener?.('contextoverflow', () => {
    console.warn('[ReadDuck] LanguageModel 上下文溢位，最早的訊息已被丟棄');
  });
  return session;
}

/** 串流提問。onChunk 收到的是「累積到目前為止的完整文字」。 */
export async function promptStream(session, input, { signal, onChunk } = {}) {
  const stream = session.promptStreaming(input, { signal });
  let acc = '';
  for await (const chunk of stream) {
    acc += chunk;
    onChunk?.(acc);
  }
  return acc;
}

/** 結構化輸出。回傳已 parse 的物件。 */
export async function promptJson(session, input, schema, { signal } = {}) {
  const raw = await session.prompt(input, {
    responseConstraint: schema,
    // schema 本身不必送進模型的上下文，省 token
    omitResponseConstraintInput: true,
    signal,
  });
  try {
    return JSON.parse(raw);
  } catch {
    // 極少數情況模型會把 JSON 包在 ``` 裡
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('模型輸出不是合法 JSON');
  }
}

/** 上下文用量。規格改過名字，兩套都讀。 */
export function usage(session) {
  const used = session.contextUsage ?? session.inputUsage ?? 0;
  const total = session.contextWindow ?? session.inputQuota ?? 0;
  return { used, total, ratio: total ? used / total : 0 };
}

export function isQuotaError(err) {
  return err?.name === 'QuotaExceededError';
}

/**
 * 粗估 token 數。用來決定要不要走 map-reduce，不需要精確。
 * CJK 大約 1 字 = 1 token，拉丁文字大約 4 字元 = 1 token。
 */
export function estimateTokens(text) {
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xac00 && c <= 0xd7af)) cjk++;
  }
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

/** 依 token 上限把長文切成數段，盡量在段落邊界切開。 */
export function chunkText(text, maxTokens) {
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = '';
  let currentTokens = 0;

  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
    currentTokens = 0;
  };

  for (const p of paragraphs) {
    const t = estimateTokens(p);
    if (t > maxTokens) {
      // 單一段落就超長：退而求其次，按句子切
      push();
      const sentences = p.split(/(?<=[。！？.!?])\s*/);
      for (const s of sentences) {
        const st = estimateTokens(s);
        if (currentTokens + st > maxTokens) push();
        current += s;
        currentTokens += st;
      }
      push();
      continue;
    }
    if (currentTokens + t > maxTokens) push();
    current += (current ? '\n\n' : '') + p;
    currentTokens += t;
  }
  push();
  return chunks;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function dedupe(arr) { return [...new Set(arr.filter(Boolean))]; }
