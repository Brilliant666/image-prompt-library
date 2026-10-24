# Image Prompt Library

**收藏圖片，保留提示詞，接著創作。** 一個以本機為主的工作區，讓你收集圖片參考、整理私人圖庫、生成圖片，並透過 Agent 反覆完善想法。

[![CI](https://github.com/Brilliant666/image-prompt-library/workflows/CI/badge.svg)](https://github.com/Brilliant666/image-prompt-library/actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

[English](README.md) · **繁體中文** · [简体中文](README_zh-CN.md)

[功能](#功能) · [快速開始](#快速開始) · [API 與圖片設定](#api-與圖片設定) · [常見問題](#常見問題) · [文件](#文件)

圖庫使用本機 SQLite 與圖片檔案。儲存、瀏覽、搜尋和整理不需要生成服務帳號；選用的 AI 功能會把請求送到所選供應商的伺服器處理。

> **獨立維護：** 由 [Brilliant666](https://github.com/Brilliant666/image-prompt-library) 維護，基於 [EddieTYP/image-prompt-library](https://github.com/EddieTYP/image-prompt-library) **v0.11.2**。本倉庫目前以原始碼維護，尚未提供發行安裝程式。請勿使用上游安裝或更新程式覆蓋此版本。本 README 描述隨附的原始碼，不代表每項功能都已包含在公開發行版或你目前安裝的副本中。詳見[維護與啟動說明](docs/INDEPENDENT_MAINTENANCE.md)。

<details>
<summary>📷 預覽圖庫——歷史公開截圖</summary>

![Library 中儲存的圖片與提示詞卡片](docs/assets/screenshots/local-app-library-overview.jpg)

![依收藏集排列的 Explore 畫面](docs/assets/screenshots/local-app-explore.jpg)

![參考卡片詳情：圖片、提示詞語言版本與來源](docs/assets/screenshots/local-app-detail.jpg)

這些既有截圖使用公開範例素材，呈現較早的圖庫畫面，並非最新的畫廊或 Agent 介面。新圖庫預設為空。

</details>

## 功能

| 工作區 | 可以做什麼 |
| --- | --- |
| **Explore** | 依收藏集瀏覽參考圖、搜尋及排序，再開啟圖片並複製提示詞。 |
| **Library** | 管理圖片／提示詞卡片、語言版本、標籤、收藏集、我的最愛與垃圾桶。 |
| **畫廊（Gallery）** | 提交圖片請求、查看佇列與歷史、比較結果，將選定的圖片收錄至 Library。 |
| **Agent** | 討論想法、由圖片反推提示詞，透過保存的對話與分支繼續創作。 |

### 🗂️ 收錄與整理

- **快速收錄**可將單張圖片連同提示詞及來源一起儲存。從瀏覽器收集內容時，可使用[本機 Chrome 側邊欄擴充功能](docs/BROWSER_CAPTURE.md)。
- **一張卡片可保存多張圖片**，包括結果圖和參考圖。在完整編輯器中上傳、拖放或貼上圖片檔案，選擇封面、調整順序，儲存前先預覽變更。文字欄位仍可正常貼上文字。
- 原始提示詞與翻譯可放在同一卡片，切換語言版本後閱讀或複製。啟用範本功能時，可在重用的生成提示詞中加入 `{{variables}}`，例如 `{{subject}}`。
- 搜尋標題、提示詞、標籤、收藏集、來源及備註；將關鍵字與 `tag:portrait`、`collection:architecture`、`sort:title` 等**結構化搜尋條件**搭配使用。也可調整排序，切換 Library 條目按直向或橫向順序排列；卡片內部始終是圖片在上、文字在下。
- 選取多張卡片後執行批次操作。**Tag** 會建議現有標籤；**Move** 可搜尋收藏集。收藏、封存或移至垃圾桶時，不必逐張編輯。
- **垃圾桶**保留已刪除卡片的圖片、提示詞和順序，方便還原。永久刪除需要另外確認，會移除記錄與圖片關聯；圖片檔案仍留在磁碟上，因此不會立即釋放空間。垃圾桶功能推出前已刪除的記錄不會自動復原。

### 🎨 生成與收錄

在**畫廊**輸入提示詞，選擇供應商與模型，並視需要從 Library、歷史記錄，或上傳、貼上、拖放的圖片檔案加入參考圖。選擇生成 1 張或一組 3／5／10 張圖片，再於**畫廊**查看目前及歷史任務。

- 檢視原圖、提示詞、請求參數與實際回傳尺寸；在燈箱中縮放、平移，或將選定的原圖下載為 ZIP。
- **另存為新項目**、附加至未經修改的來源卡片，或將後續結果加入第一張已收錄結果所建立的卡片。
- 還原請求後再次嘗試，或選擇**在 Agent 中繼續**，將圖片帶入對話。加入參考圖不會自動送出請求。
- 畫廊與 Agent 使用**同一套伺服器端生成佇列與 Library**，不需要第二個資產資料庫或額外的 Node 服務。
- **清理圖片**會清理符合條件、尚未收錄的結果檔案，並將它們從畫廊隱藏；任務記錄與原始請求仍保留在歷史中。這不等於「刪除記錄」，已收錄至 Library 的資產與受保護的參考圖會保留。

歷史記錄首次載入 48 筆，預設顯示**全部狀態**；可篩選進行中、成功、已收錄或失敗，瀏覽器會記住選擇。成功包含已收錄的結果；已清理的圖片不出現在畫廊及其計數中。關鍵字搜尋涵蓋已載入的頁面，按**載入更多**可查看更早的記錄。分頁內的中繼資料快取可在重新整理時暫時顯示前次清單，有效期最長 30 分鐘；其中不含圖片內容或憑證，也無法自行提交請求。

### 💬 與 Agent 協作

Agent 將對話、訊息分支和圖片參考保存在本機伺服器。編輯或重新生成訊息會建立分支，原有分支仍保留。你可以搜尋已儲存的對話、將生成圖片用作參考，或從結果返回來源對話。

- 選擇相容的 API 設定檔與完整的**文字模型 ID**。Hybrid 模式透過 Responses 處理文字與工具，再使用選定的 Images 設定檔建立圖片任務；Native 模式接收 Responses 圖片工具的結果。供應商必須支援所選路徑。
- **持續生圖模式預設關閉。** 你可以只授權某一輪生成圖片，或明確開啟生圖模式，讓目前對話之後送出的訊息也能生成圖片。每次請求仍會固定其圖片數量及模型步數上限。網路搜尋需要另外設定，並逐輪授權。
- 預設為 **Enter 送出**、**Shift+Enter 換行**，輸入法組字時不會送出。伺服器接受請求後會清空文字與參考圖，保留圖片設定；畫廊和 Agent 的輸入偏好可分別調整。
- **使用畫廊圖片設定**會將有效的 Images 設定檔與參數複製至 Agent 草稿，不會啟用生圖，也不會改動兩邊的提示詞。OAuth 與原生 Responses 圖片工具路徑不能以此方式替換。
- 內建的 `image-prompt-reverse` 與 `gpt-image` 指引協助分析圖片、改善提示詞及編輯圖片。這些是從固定來源版本改編、保留出處的文字章節，會在相關任務中載入；不會安裝或自動更新原始 skill 倉庫、執行其腳本，或授權生成圖片。詳見 [Agent 指引與授權](docs/agent-skills/README.md)。

Responses 的進度會串流至瀏覽器，無法串流時改用唯讀輪詢。重新整理或重新連線不會再次送出付費請求。**停止**會阻止新的呼叫；已送至上游的請求仍可能完成或計費。詳見[工作區行為與相容性限制](docs/PLAYGROUND.md)。

## 快速開始

從原始碼建置需要 **Python 3.10+** 和 **Node.js 24**。請在既有原始碼目錄依照[啟動與維護說明](docs/INDEPENDENT_MAINTENANCE.md)操作。Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e '.[dev]'
npm ci
npm run build
$env:IMAGE_PROMPT_LIBRARY_PATH = Join-Path $HOME 'ImagePromptLibrary'
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

啟動前請選定圖庫路徑，確認沒有其他執行個體使用同一圖庫，且 8000 連接埠空閒。開啟 [127.0.0.1:8000](http://127.0.0.1:8000)；在終端機按 `Ctrl-C` 停止。macOS/Linux 請參閱[開發指南](docs/DEVELOPMENT.md)。

新圖庫預設為空。選擇**快速收錄**，加入圖片與原始提示詞後儲存；AI 設定為選用。既有安裝副本可透過以下指令檢查：

```bash
image-prompt-library status
image-prompt-library doctor
```

編輯或建置原始碼目錄不會更新另外安裝的副本。本獨立倉庫尚未建立 Releases；更新請依維護指南進行，切換版本前保留相容的備份。

## API 與圖片設定

開啟**設定 → API**。API Key 設定檔支援 sub2api 等同步 OpenAI 相容服務，各自保存名稱、Base URL、金鑰、模型清單及預設值。帳號連線保留 **ChatGPT / Codex OAuth** 和實驗性的 **Grok OAuth**；個別工作階段可以暫時選用不同於 **Default AI provider** 的供應商。

| 設定 | 說明 |
| --- | --- |
| 模型清單 | **重新整理模型**會取得所選設定檔的模型清單。清單只是候選項，不保證支援 Images、Responses 或工具。手動輸入及歷史模型 ID 仍可使用；圖片模型選單推薦 `gpt-image` 名稱，也接受手動輸入完整模型 ID。 |
| 尺寸與比例 | 自動、比例預設及自訂尺寸用於選擇請求像素。4K 目標不保證回傳 4K；詳情會區分請求尺寸與實際解碼尺寸。儲存的原圖不會被拉伸。 |
| 品質與格式 | 可用設定取決於呼叫路徑。透明背景需要 PNG 或 WebP；壓縮只在支援時適用。供應商可能拒絕或忽略選用參數。 |
| 串流 | Images 串流及中間預覽取決於端點支援。部分圖片只代表進度，不代表最終成功結果。 |
| 授權 | 儲存或切換設定檔不會執行付費生圖測試。OAuth 的存取權、限制及計費仍由供應商決定。 |

端點規則、參考圖限制及疑難排解請見 [OpenAI 相容 API 設定](docs/OPENAI_COMPATIBLE.md)及[生成指南](docs/GENERATION.md)。模擬測試無法證實真實供應商的模型身分、計費、解析度或原生工具支援。

<details>
<summary>歷史截圖：選擇 Grok 帳號供應商</summary>

![生成供應商選單中選擇 Grok](docs/assets/screenshots/generation-grok-provider.png)

這張公開截圖早於目前分組的 API 設定介面。

</details>

## 隱私

- **私人提示詞與圖片圖庫**保存在你的電腦，沒有託管使用者資料庫或內建雲端同步；應用程式預設監聽 `127.0.0.1`。
- 生成圖片會將提示詞和選定的參考圖傳送至所選供應商。Agent 也會把選定的對話分支及必要圖片內容傳送至設定的模型；本機圖庫不代表 AI 推論在本機執行。
- **建議標題**只傳送**提示詞文字**。先檢視建議，再選擇 **Use title** 套用。生成結果的建議會標示 **via ChatGPT** 或 **via Grok**；所選供應商無法使用時，不會悄悄改送到其他服務。
- 選用的收錄整理與視覺命名使用另外設定的視覺服務，會**傳送圖片內容**。為已收錄的畫廊結果進行視覺命名，需要開啟命名選項，並已設定且啟用整理服務；手動填寫的標題會保留。此功能與只傳送文字的標題建議不同。
- 供應商、OAuth、配對及整理服務的憑證保存在圖庫之外，**不包含在可攜式備份中**。搬移或還原安裝環境時，請另行備份這些外部設定。

## 常見問題

<details>
<summary>收集參考圖需要 AI 帳號嗎？</summary>

不需要。Explore、Library、快速收錄及瀏覽器收錄都不需要生成服務憑證。只有選用的供應商功能需要相容連線。

</details>

<details>
<summary>為什麼畫廊中找不到失敗或等待中的任務？</summary>

預設顯示全部狀態，但瀏覽器會記住你之後選擇的篩選條件。切換回全部狀態，或開啟工作佇列／歷史記錄查看。篩選不會刪除任務，關鍵字搜尋只涵蓋已載入的頁面；已清理圖片的任務仍保留在歷史中。

</details>

<details>
<summary>是否包含 Playground 原始專案的全部功能？</summary>

沒有。目前改編版本未包含其畫布／註解系統、遮罩繪製編輯器、本機去背或任意非同步／自訂 HTTP 供應商。已實作功能與驗證限制請見[功能對照表](docs/PLAYGROUND.md#source-adaptation-and-capability-status)。

</details>

## 線上唯讀 demo

[上游線上唯讀 demo](https://eddietyp.github.io/image-prompt-library/)可用來瀏覽收藏集、搜尋範例及複製公開提示詞。這是上游的靜態展示，並非本獨立維護版的託管服務，也不是最新 Agent 功能的預覽。

<details>
<summary>公開範例 demo 截圖</summary>

![上游線上唯讀 demo 的 Explore 收藏集](docs/assets/screenshots/public-demo-explore.png)

編輯、私人圖庫管理及生成圖片僅在本機安裝中提供。

</details>

## Sample data 與 attribution

Demo 的參考內容與選用範例包保留來源連結及授權資訊。提示詞與圖片歸各自的來源所有。只需匯入偏好的收藏集語言：

```bash
image-prompt-library sample-data en
image-prompt-library sample-data zh_hans
image-prompt-library sample-data zh_hant
```

另有較大的繁體中文範例包，可使用 `image-prompt-library sample-data zh_hant awesome-gpt-image-2` 匯入。原始標題、提示詞及已有的語言版本會保留。

| 來源 | 授權 | 範例包 |
| --- | --- | --- |
| [wuyoscar/gpt_image_2_skill](https://github.com/wuyoscar/gpt_image_2_skill) | CC BY 4.0 | Starter pack |
| [freestylefly/awesome-gpt-image-2](https://github.com/freestylefly/awesome-gpt-image-2) | MIT | 較大的提示詞／圖片範例庫 |

詳情與校驗碼見 [sample-data/README.md](sample-data/README.md)。範例資料匯入與 Agent 的內建指引是獨立功能。

## 文件

[獨立維護與原始碼啟動](docs/INDEPENDENT_MAINTENANCE.md) · [工作區與 Agent](docs/PLAYGROUND.md) · [API 設定檔](docs/OPENAI_COMPATIBLE.md) · [生成圖片](docs/GENERATION.md) · [瀏覽器收錄](docs/BROWSER_CAPTURE.md) · [備份與還原](docs/BACKUP_AND_RESTORE.md) · [疑難排解](docs/TROUBLESHOOTING.md) · [開發](docs/DEVELOPMENT.md) · [參與開發](CONTRIBUTING.md)

## 授權與致謝

應用程式保留 **AGPL-3.0-or-later** 授權與原作者聲明，詳見 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。上游文件提到的商業授權不代表本獨立倉庫提供相同方案或作出授權承諾。

畫廊／Agent 的互動與部分原始碼改編自 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground)，並保留其 [MIT 聲明](licenses/Playground-MIT.txt)。Agent 指引另有[來源與授權說明](docs/agent-skills/README.md)；公開範例資料及第三方資產也保留各自的授權。
