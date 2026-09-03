import { normalizeAvailability, describeError, isModelCrashError } from './capability.js';
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
export async function checkAvailability(outputLanguage, { image = false } = {}) {
  assertOutputLanguage(outputLanguage);
  if (!isLanguageModelPresent()) return 'unavailable';
  const request = { expectedOutputs: [{ type: 'text', languages: [outputLanguage] }] };
  // 圖片是另一種模態，很可能是另一份模型資料。不帶這個宣告查到的是純文字
  // 模型的狀態 —— 會回報「可用」，然後在 create() 時才失敗。
  if (image) request.expectedInputs = [{ type: 'image' }];
  try {
    return normalizeAvailability(await self.LanguageModel.availability(request));
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
export async function needsDownloadConsent(outputLanguage, opts) {
  return (await checkAvailability(outputLanguage, opts)) === 'downloadable';
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
 * @param {boolean} [o.imageInput] 這個 session 要不要收圖片。查 availability 時
 *        也必須帶同一組宣告，否則查到的是純文字模型的狀態。
 */
export async function createSession({
  systemPrompt,
  mode = 'precise',
  outputLanguage,
  inputLanguages,
  imageInput = false,
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
  const expectedInputs = [];
  const langs = dedupe((inputLanguages ?? []).map(canonical))
    .filter((l) => promptOutputLanguages().includes(l));
  if (langs.length) expectedInputs.push({ type: 'text', languages: langs });
  if (imageInput) expectedInputs.push({ type: 'image' });
  if (expectedInputs.length) opts.expectedInputs = expectedInputs;

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

/**
 * 從基底 session 分出一個獨立的分支。
 *
 * 為什麼需要分支：一次性的提問不該污染長期 session 的上下文，否則下一次的
 * 回答會被上一次的內容影響，上下文也會愈積愈滿。
 *
 * 首選 clone() —— 它便宜，system prompt 與參數都不必重新處理。但 Edge 的
 * Prompt API 實作不支援 cloning，會回 InvalidStateError「The session cannot
 * be cloned.」。這種情況改成用同一份設定重新建一個 session：語意完全一樣，
 * 只是貴一點。
 *
 * @param {object} base 基底 session
 * @param {object} config 當初建立 base 用的設定，降級時要靠它重建
 */
let cloneUnsupported = false;

export async function forkSession(base, config, { signal } = {}) {
  if (!cloneUnsupported) {
    try {
      return await base.clone({ signal });
    } catch (err) {
      // 只有「不支援 cloning」才降級。其他錯誤（取消、模型崩潰）要原樣拋出，
      // 否則會把真正的問題掩蓋成一次多餘的 session 建立。
      if (err?.name !== 'InvalidStateError') throw err;
      cloneUnsupported = true;
      console.warn('[ReadDuck] 這個瀏覽器不支援 session cloning，改為每次重建：', describeError(err));
    }
  }
  return createSession({ ...config, signal });
}

/** 重置上面那個記憶。給測試用。 */
export function resetCloneSupport() {
  cloneUnsupported = false;
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

/**
 * 約束解碼在這個執行環境到底能不能用。
 *
 * 兩道關卡：瀏覽器本身支不支援（Edge 的 Phi-4-mini 會崩，見 lib/browser.js），
 * 以及這個 session 期間有沒有實際失敗過。失敗過一次就不再試 —— 失敗的代價
 * 可能是一次模型行程崩潰，而崩潰次數是有斷路器在數的。
 */
let constrainedOutputFailed = false;

function canConstrainOutput() {
  return currentBrowser().supportsResponseConstraint && !constrainedOutputFailed;
}

/** 重置上面那個記憶。給測試用。 */
export function resetConstrainedOutputState() {
  constrainedOutputFailed = false;
}

/**
 * 結構化輸出。回傳已 parse 的物件。
 *
 * 能用約束解碼就用 —— 那是最可靠的做法，模型在生成過程中就不可能吐出不合
 * schema 的東西。不能用（或試過會壞）的時候，改把 schema 寫進 prompt 文字，
 * 結果一樣要通過 JSON.parse 才算數。
 *
 * 這個降級和輸出語言那條規則不同，不衝突：拿掉 responseConstraint 只是少了
 * 生成期的保證，輸出仍然要能 parse 成物件；拿掉輸出語言則會讓模型產出品質與
 * 安全性都不受保證的內容，那是不能退的。
 */
export async function promptJson(session, input, schema, { signal } = {}) {
  if (!canConstrainOutput()) {
    return parseJsonOutput(await session.prompt(withSchemaInPrompt(input, schema), { signal }));
  }

  let raw;
  try {
    raw = await session.prompt(input, {
      responseConstraint: schema,
      // schema 本身不必送進模型的上下文，省 token
      omitResponseConstraintInput: true,
      signal,
    });
  } catch (err) {
    // 使用者取消、輸入本來就超長，重試都沒有意義
    if (err?.name === 'AbortError' || isQuotaError(err)) throw err;
    // 模型行程崩潰時更要停手：斷路器在數次數，多送一次只會讓整個模型版本
    // 更快被停用，代價遠大於「這次也許會成功」
    constrainedOutputFailed = true;
    if (isModelCrashError(err)) throw err;
    console.warn('[ReadDuck] 結構化輸出失敗，本次工作階段改用純文字要求 JSON：', describeError(err));
    raw = await session.prompt(withSchemaInPrompt(input, schema), { signal });
  }
  return parseJsonOutput(raw);
}

/** 降級路線：約束解碼不可用時，改用文字指示要求模型自己遵守 schema。 */
function withSchemaInPrompt(input, schema) {
  const instruction = [
    'Reply with a single JSON object matching this schema.',
    'Output only the JSON — no code fence, no commentary before or after.',
    JSON.stringify(schema),
  ].join('\n');

  // 多模態輸入是 [{ role, content: [...] }]，直接和字串相接會被轉成
  // "[object Object]"。這種時候把指示接成最後一則訊息的另一段文字。
  if (Array.isArray(input)) {
    const last = input.length - 1;
    return input.map((msg, i) => (i !== last ? msg : {
      ...msg,
      content: Array.isArray(msg.content)
        ? [...msg.content, { type: 'text', value: instruction }]
        : [{ type: 'text', value: String(msg.content) }, { type: 'text', value: instruction }],
    }));
  }
  return `${input}\n\n${instruction}`;
}

function parseJsonOutput(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // 沒有約束解碼護著的時候，模型很常把 JSON 包在 ``` 裡
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
