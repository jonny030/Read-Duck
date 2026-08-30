# PDF.js（內建）

- 來源：https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/
- 版本：pdfjs-dist 4.10.38
- 授權：Apache License 2.0（見 LICENSE）

## 為什麼要內建

MV3 禁止載入遠端程式碼，函式庫必須隨擴充功能一起打包。

## 檔案

| 檔案 | 用途 |
|---|---|
| `pdf.min.mjs` | 主程式庫，由 `src/pdf/pdf-viewer.js` 以 ES module 載入 |
| `pdf.worker.min.mjs` | 解析用的 worker，透過 `GlobalWorkerOptions.workerSrc` 指定 |

## 沒有一起收錄的東西

- `cmaps/`：CJK 編碼 PDF 的字元對應表。少了它，以 CJK 編碼嵌入的文字可能抽不出來。
  ReadDuck 的用途是把外文翻成中文，來源多半是拉丁文字，所以先不收（約 1~2 MB）。
- `standard_fonts/`：未內嵌標準 14 字型的 PDF 會改用瀏覽器字型替代，畫面可能略有差異。

## 更新方式

換掉上面兩個檔案並更新這裡的版本號即可，沒有建置步驟。
