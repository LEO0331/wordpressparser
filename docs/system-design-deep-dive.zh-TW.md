# WordPress Parser 系統設計深度解析

## 1) 系統目的與範圍
此系統將異質內容來源轉換為可重用的作者知識產物：
- 輸入：WordPress JSON、WordPress/Pixnet URL、WordPress WXR XML 匯出。
- 核心輸出：`skill.md`、`knowledge.md`、`persona.md`、`wiki.md`、metadata。
- 選配 Sidecar：MCP 伺服器（可列出/讀取/建立/更新/發布 WordPress 文章）。

主要目標：
- 本地優先且快速運行（Node + Express，不強制依賴外部 DB）。
- 維持既有產物流程相容性。
- 預設安全（URL 安全檢查、受控錯誤訊息、管理員權限保護變更操作）。
- 可部署於 Vercel，並可選擇使用 Blob 持久化。

目前非目標：
- 即時串流處理。
- 多租戶 RBAC 權限模型。
- 全文搜尋資料庫/引擎。
- 分散式佇列或事件匯流排。

---

## 2) 高階架構

### 2.1 執行拓樸
- **主應用（Express Monolith）**
  - 同一個程序提供 HTTP API 與靜態前端（`public/`）。
  - `src/` 內以模組邊界切分：擷取、正規化、分析、生成、儲存。
- **選配 MCP Sidecar（`mcp/`）**
  - 與主 HTTP 應用獨立的 stdio 程序。
  - 用安全工具契約封裝 WordPress REST API。

### 2.2 核心請求流程
1. 擷取來源（`/api/normalize`、`/api/extract-url`、`/api/convert-xml`）。
2. 正規化為統一資料型別：
   - `{ title, content, date, url, categories, tags }`（XML 情境保留必要擴充欄位）。
3. 語料分析（`analyzeCorpus`）：
   - knowledge 軌道 + persona 軌道。
4. 產物生成（`/api/generate` 或 `/api/build`/`/api/profiles/save`）。
5. 儲存到檔案系統或 Vercel Blob。

### 2.3 為何採單體 + 模組化檔案
現行選擇：
- 單一部署單元，維運與本地開發成本低。
- 以程式模組邊界維持可維護性，避免過早分散式化。

替代方案：
- 切分微服務（`ingestion`、`analysis`、`storage`、`api-gateway`）。
- 取捨：可得到更強隔離與獨立擴展，但會增加延遲、維運複雜度、重試/追蹤與跨服務授權成本。

---

## 3) 主要元件與取捨

## 3.1 API 層（`server.js`）
設計：
- 路由 handler 薄層化。
- 共用安全錯誤包裝（`sendSafeError`）。
- 更新/修正/回滾由管理員 middleware 保護。

取捨：
- 路由簡潔可讀，但商業邏輯仍在同程序同步匯入執行。
- 替代：導入 command-handler/DI 框架做更強策略注入；現況偏向降低複雜度。

## 3.2 正規化（`src/parser.js`）
設計：
- 支援多種上游 schema 候選（`posts`、`items`、`channel.item` 等）。
- HTML 清理 + entity decode 成純文字。
- 先正規化再進分析/生成。

取捨：
- 對上游資料噪音韌性高，但會損失部分富文本語意。
- 替代：保留富文本 AST/DOM 到後段再簡化；可提升保真但增加記憶體與實作複雜度。

## 3.3 URL 擷取（`src/url_extract.js`）
設計：
- 平台偵測（`auto|wordpress|pixnet`）。
- SSRF 防護：協議驗證、localhost 阻擋、DNS 解析、私網位址拒絕。
- 分頁抓取採固定上限（`MAX_PAGES`、`PAGE_SIZE`）。

取捨：
- 安全基線佳且行為可預測，但每次請求會有額外 DNS/IO 成本。
- 替代：只允許白名單網域（更嚴格）；安全更高但彈性降低。

## 3.4 XML Bridge（`src/xml_bridge.js`、`src/zip_writer.js`）
設計：
- 解析 WXR XML、清理/正規化、HTML 轉 Markdown。
- 每篇 post/page 產一個 markdown（含 frontmatter）。
- 以記憶體組 ZIP 後直接回傳。

取捨：
- 中等資料量下實作簡單、速度快。
- 替代：串流 ZIP，降低大檔高峰記憶體壓力。

## 3.5 分析與生成（`src/generator.js`、`src/skill_template.js`）
設計：
- 決定性 parser mode + 可選 AI mode。
- 在地化模板（`en`、`zh-TW`）。
- knowledge/persona 分軌，輸出穩定且可解釋。

取捨：
- 模板驅動可預測，但彈性不如全生成式流程。
- 替代：全 AI 生成；表達力高，但可測性與穩定性較差。

## 3.6 儲存層（`src/profile_store.js`）
設計：
- 雙後端抽象：本地檔案系統或 Vercel Blob。
- 兩後端共享同一 profile 契約。
- 透過版本快照支援回滾。

取捨：
- 基礎設施成本低；快照式儲存在長期可能造成容量成長。
- 替代：資料庫增量版本（如 Postgres + JSONB）；可查詢性更好，但維運/遷移成本更高。

## 3.7 MCP Sidecar（`mcp/`）
設計：
- 以獨立程序 + `Content-Length` JSON-RPC over stdio。
- WP API 版本回退策略（`v3` -> `v2`）。

取捨：
- 可與主應用故障隔離，避免強耦合。
- 替代：整合進主 Express；部署更簡單但隔離性下降。

---

## 4) 核心資料型別（Canonical Data Shapes）

### 4.1 正規化語料項目
```ts
{
  title: string;
  content: string;
  date: string | null;
  url: string | null;
  categories: string[];
  tags: string[];
}
```

### 4.2 Profile 產物包
```ts
{
  meta: object;
  knowledgeMarkdown: string;
  personaMarkdown: string;
  skillMarkdown: string;
  wikiMarkdown: string;
  knowledgeAnalysis: object;
  personaAnalysis: object;
  normalizedItems: NormalizedItem[];
}
```

### 4.3 XML 轉換結果
```ts
{
  zipBuffer: Buffer;
  metadata: {
    totalItems: number;
    convertedItems: number;
    skippedItems: number;
    warningCount: number;
    warnings: string[];
  }
}
```

---

## 5) 資料結構選擇：為何這樣選、替代是什麼

| 區域 | 現行資料結構 | 為何適合目前場景 | 替代方案 | 取捨摘要 |
|---|---|---|---|---|
| Stopword 查詢 | `Set<string>` | 高頻 membership 查詢，平均 O(1) | Array + `includes`、Trie | `Set` 最簡單且快；Trie 對前綴場景才有優勢 |
| HTML entity 對照 | `Map<string,string>` | key-value 語意清楚、可迭代 | Plain object | `Map` 避免 prototype key 問題且順序可控 |
| 關鍵字頻率 | `Map<string, number>` | 大量動態 key 的累加/更新 | Plain object、Counter lib | `Map` 寫法更乾淨，少邊界陷阱 |
| 語料資料容器 | `Array<Item>` | 排序、切片、序列掃描自然 | Linked list、平衡樹 | 中等規模下 Array 快且可讀性高 |
| Query 組裝 | `URLSearchParams` | 自動處理編碼，避免手串錯誤 | 手工串接 query string | 安全且可維護性更好 |
| ZIP 輸出 | `Buffer` + chunk arrays | 原生二進位操作，Node 友好 | Base64、streaming lib | 記憶體組裝簡單；超大檔可考慮串流 |
| CRC 查表 | `Uint32Array(256)` | 固定大小、索引快、記憶體緊湊 | JS number array | TypedArray 對二進位計算更穩定 |
| 私網位址策略 | `Set` + helper 函式 | Host 快速比對 + 可讀 IP 判斷 | 單一 regex 規則 | 結構化檢查較安全、可維護 |
| 錯誤分類 | `Error` + `code` 字串 | 輕量、足夠區分客戶端/伺服器錯誤 | Custom Error classes | 字串碼簡單；類別更強型別但樣板多 |
| 版本清單 | `Array<string>` 反序排序 | 直接回應 API/UI 需求 | Priority queue / tree | 現階段規模下最直接 |
| Blob profile 聚合 | `Map<slug, meta>` | 掃描物件時自然去重 | Object dictionary | `Map` 動態 key 操作與迭代更清楚 |
| MCP 工具分派 | `switch` | 工具數量小、控制流程明確 | Object command map | `switch` 稍冗長；map 可減少樣板 |

---

## 6) 架構決策取捨（Design Decisions）

### 決策 A：先正規化到統一模型
- 現行：來源專屬解析後，盡早收斂成共通 item shape。
- 原因：降低後段分析/生成/儲存分支複雜度。
- 替代：全流程保留來源特化模型。
- 取捨：維護成本低，但可能損失來源特有語意。

### 決策 B：以環境切換雙儲存後端
- 現行：預設本地檔案；有 token 時改用 Vercel Blob。
- 原因：本地開發方便，雲端部署可持久化。
- 替代：一律使用託管 DB/Object Store。
- 取捨：導入門檻低，但查詢能力相對有限。

### 決策 C：Admin Key 保護變更型端點
- 現行：透過 env key + middleware 保護更新/修正/回滾。
- 原因：對內部工具提供最小可行保護。
- 替代：OAuth/JWT/Session + 細粒度角色權限。
- 取捨：輕量易用，但粒度較粗、依賴金鑰管理。

### 決策 D：MCP 走 Sidecar
- 現行：與主 HTTP 應用分離。
- 原因：隔離 WordPress 發布能力與協定風險。
- 替代：內嵌在主 API。
- 取捨：故障隔離佳，但多一個執行元件要維運。

### 決策 E：保留 deterministic parser fallback
- 現行：AI mode 可選，parser mode 永遠可用。
- 原因：可用性與可測性穩定。
- 替代：AI-only 流程。
- 取捨：穩定性高，但內容細膩度可能略低。

---

## 7) 可擴展性與可靠性觀察

現有優勢：
- 分頁抓取上限明確（`MAX_PAGES`、`PAGE_SIZE`）。
- 讀取端點與管理變更端點邊界清楚。
- 測試覆蓋 parser/routes/MCP/storage 等主路徑。

現階段瓶頸：
- 大型 XML/語料工作負載可能造成記憶體峰值。
- 尚無佇列/背壓機制處理長時間任務。
- Blob 以 prefix 掃描列舉 profile，物件量大時成本上升。

務實演進路線：
1. 增加請求級資源預算（大小/時間）並導入 async job 模式。
2. 對 ZIP 與大型產物改採串流。
3. 補一層 metadata index（SQLite/Postgres），artifact 仍放 blob/files。

---

## 8) 深度提問準備（Q&A）

## 8.1 系統設計常見問題
1. **為何先做單體？**
   - 單一部署產物、低維運成本、迭代快；在需求擴大前以模組邊界控制複雜度。

2. **如何避免不同來源流程互相耦合？**
   - 透過早期正規化到統一 item schema，讓後段流程來源無關。

3. **如何處理向後相容？**
   - 維持既有端點契約；新能力以獨立路由新增（`/api/convert-xml`），並保留 legacy fallback（`rag.json` -> `wiki.md`）。

4. **目前最大運維風險是什麼？**
   - 大檔 XML/語料的記憶體峰值。

## 8.2 資料結構常見問題
1. **為何 `Set/Map` 不用 object/array？**
   - 主要操作是 membership 與頻率聚合，`Set/Map` 平均 O(1) 且語意更清楚。

2. **為何 ZIP 用 `Buffer` 與 typed array？**
   - 二進位格式需精準 byte-level 操作，Node 原生支援與效能都更好。

3. **為何核心資料用 `Array`？**
   - 需要排序、切片、線性掃描，且資料量可控，Array 簡單且 cache-friendly。

## 8.3 安全常見問題
1. **如何防 SSRF？**
   - 協議驗證、localhost 阻擋、DNS 解析與私網 IP 拒絕。

2. **變更型端點如何保護？**
   - update/correct/rollback 全部經過 admin key middleware。

3. **Markdown 轉換輸出如何控風險？**
   - HTML 清理 + URL 協議過濾（`javascript:`、`data:` 等會被拒絕）。

## 8.4 架構取捨挑戰題
1. **為何目前不用關聯式 DB？**
   - 現在是 artifact-centric、快照型工作負載，files/blob 足夠且維運成本低。

2. **為何不是事件驅動架構？**
   - 當前同步 request-response 足以滿足需求，避免過早引入分散式複雜度。

3. **何時該拆服務？**
   - 當 p95 延遲、記憶體壓力、或 ingestion/generation 需要獨立擴展時。

---

## 9) 若會議被追問：下一步改進建議
1. 對大型 XML/生成任務導入非同步 job queue。
2. 改為串流 ZIP 管線，降低記憶體峰值。
3. 建立 profile metadata index，提升列表與搜尋效率。
4. 補齊結構化可觀測性（trace id、延遲指標、錯誤基數）。
5. 針對正式多用戶場景，將 admin key 升級為 scoped auth（JWT/OAuth）。
