# Image Generation Skill for Microsoft Foundry MAI-Image

此 skill 供 AI coding agent（GitHub Copilot CLI、Codex 等）使用，藉由 Microsoft Foundry 上的 MAI-Image 系列模型產生或編輯點陣圖影像，例如網站 hero image、產品圖、遊戲素材、UI mockup、插圖、海報與資訊圖表。

預設模型為 `MAI-Image-2.6-Flash`。本專案只支援 MAI-Image 系列；若要使用 Azure OpenAI 的 GPT Image 模型，請改用同層的 `imagegen-aoai` 專案。

## 功能特色

- 產生新影像：呼叫 `/mai/v1/images/generations`，可自訂寬高。
- 編輯與合成影像：呼叫 `/mai/v1/images/edits`，最多可傳入五張 PNG 或 JPEG 參考圖。
- 自動長寬比（`--auto-aspect-ratio`）：由模型依提示詞與輸入影像決定最適合的比例，僅限 MAI-Image-2.6 系列。
- 網路搜尋輔助（`--web-grounding`）：模型可參考 Bing 搜尋結果，適合需要最新真實世界資訊的提示詞，僅限 MAI-Image-2.6 系列。
- 批次產生：以 JSONL 描述多個工作，送出前會先完整驗證所有工作。
- 透明背景：以 chroma-key 純色背景產圖，再用本機工具去背。
- Dry-run：不需網路與憑證即可檢查 request 內容與輸出路徑。
- 自動重試：遇到 429、5xx 或網路錯誤時依 `Retry-After` 重試。

## 支援的模型

| 模型 | 產圖 | 編輯 | 最大畫素數（寬 × 高） | `auto_aspect_ratio`／`web_grounding` |
| --- | --- | --- | --- | --- |
| `MAI-Image-2.6-Flash`（預設） | 支援 | 支援 | 2,359,296（約 1536×1536） | 支援 |
| `MAI-Image-2.6` | 支援 | 支援 | 2,359,296 | 支援 |
| `MAI-Image-2.5-Pro` | 支援 | 支援 | 1,048,576（約 1024×1024） | 不支援 |
| `MAI-Image-2.5-Flash` | 支援 | 支援 | 1,048,576 | 不支援 |
| `MAI-Image-2.5` | 支援 | 支援 | 1,048,576 | 不支援 |
| `MAI-Image-2`、`MAI-Image-2e`（舊款） | 支援 | 不支援 | 1,048,576 | 不支援 |

- 寬與高各自至少 768px；官方未限制長寬比，只要總畫素數不超過上限即可，例如 2.6 系列可用 `2048x1152`。
- MAI-Image-2.6 系列的狀態：Microsoft Learn 頁面（2026-09-21）標示為 Preview，Microsoft Foundry blog 則在 2026-10-27 宣布 GA，實際狀態請以 Foundry portal 為準。
- 輸出一律為 PNG，沒有 `quality`、`n`、`background`、`output_format`、`input_fidelity` 或 mask 參數。

## 專案結構

```text
.
├── SKILL.md
├── README.md
├── agents/
│   └── openai.yaml
├── assets/
│   ├── imagegen.png
│   └── imagegen-small.svg
├── references/
│   ├── cli.md
│   ├── codex-network.md
│   ├── image-api.md
│   ├── prompting.md
│   └── sample-prompts.md
├── scripts/
│   ├── image_gen.js
│   └── remove_chroma_key.js
├── test/
│   └── image_gen.test.js
└── package.json
```

本專案只維護 Node.js 版 CLI，不提供 `imagegen-aoai` 中的 Python 版腳本。

## 部署 MAI-Image-2.6-Flash

1. 在支援 MAI image 模型的區域建立 Microsoft Foundry resource。
2. 在 Foundry portal 部署 `MAI-Image-2.6-Flash`，或使用 Azure CLI：

   ```bash
   az cognitiveservices account deployment create \
     --name <ACCOUNT_NAME> \
     --resource-group <RESOURCE_GROUP> \
     --deployment-name MAI-Image-2.6-Flash \
     --model-name "MAI-Image-2.6-Flash" \
     --model-format Microsoft \
     --model-version 2026-07-31 \
     --sku-name GlobalStandard \
     --sku-capacity 1
   ```

3. 到 resource 的 Keys and Endpoint 頁面取得 endpoint 與 API key。

建議讓 deployment 名稱與模型名稱相同，CLI 就能自動套用正確的模型限制。

## 環境變數設定

```bash
export IMAGEGEN_MAI_ENDPOINT="https://<resource-name>.services.ai.azure.com"
export IMAGEGEN_MAI_API_KEY="<key>"
export IMAGEGEN_MAI_IMAGE_DEPLOYMENT="MAI-Image-2.6-Flash"
```

| 變數 | 必填 | 說明 |
| --- | --- | --- |
| `IMAGEGEN_MAI_ENDPOINT` | 是 | Foundry resource endpoint，格式為 `https://<resource-name>.services.ai.azure.com`。結尾帶 `/mai/v1` 也可以，其他路徑會被忽略並顯示警告。 |
| `IMAGEGEN_MAI_API_KEY` | 二擇一 | API key，以 `api-key` header 送出。 |
| `IMAGEGEN_MAI_AUTH_TOKEN` | 二擇一 | Microsoft Entra ID token，以 `Authorization: Bearer` 送出；只在未設定 API key 時使用。 |
| `IMAGEGEN_MAI_IMAGE_DEPLOYMENT` | 否 | 預設 deployment 名稱，未設定時為 `MAI-Image-2.6-Flash`。 |
| `IMAGEGEN_MAI_BASE_MODEL` | 否 | deployment 使用自訂名稱時，指定其基礎模型，例如 `MAI-Image-2.6-Flash`。 |

> 注意：MAI image API 位於 `*.services.ai.azure.com`，與 Azure OpenAI 的 `*.openai.azure.com` 不同，`imagegen-aoai` 的 `IMAGEGEN_AZURE_OPENAI_*` 變數無法直接沿用。

使用 Microsoft Entra ID 時，可用 Azure CLI 取得 token（約一小時後過期）：

```bash
export IMAGEGEN_MAI_AUTH_TOKEN="$(az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv)"
```

### 自訂 deployment 名稱

在 Microsoft Foundry 中，CLI 的 `--model` 參數代表 deployment 名稱，不一定等於模型名稱。CLI 會以不分大小寫的方式比對 deployment 名稱與上方模型表；若 deployment 名稱是自訂的（例如 `prod-flash`），請指定基礎模型，否則 CLI 會拒絕執行：

```bash
export IMAGEGEN_MAI_IMAGE_DEPLOYMENT="prod-flash"
export IMAGEGEN_MAI_BASE_MODEL="MAI-Image-2.6-Flash"
```

## 安裝相依套件

需要 Node.js 20 以上。API 呼叫使用 Node 內建 `fetch`，縮圖與去背使用 `sharp`：

```bash
npm install
```

## CLI 快速開始

```bash
export IMAGE_GEN="<skill-dir>/scripts/image_gen.js"
```

`<skill-dir>` 為 `SKILL.md` 所在的目錄。

### Dry-run

不呼叫 API，也不需要網路與憑證：

```bash
node "$IMAGE_GEN" generate \
  --prompt "Test" \
  --out output/imagegen/test.png \
  --dry-run
```

### 產生影像

```bash
node "$IMAGE_GEN" generate \
  --prompt "A cozy alpine cabin at dawn" \
  --size 1536x1024 \
  --out output/imagegen/alpine-cabin.png
```

### 讓模型決定長寬比並參考網路資訊

```bash
node "$IMAGE_GEN" generate \
  --prompt "A travel poster for Taipei 101 during the New Year fireworks" \
  --auto-aspect-ratio \
  --web-grounding \
  --out output/imagegen/taipei-poster.png
```

### 編輯與合成影像

```bash
node "$IMAGE_GEN" edit \
  --image product.png \
  --image logo.png \
  --prompt "Image 1: edit target. Image 2: logo. Print the logo from Image 2 on the mug in Image 1; keep everything else unchanged." \
  --out output/imagegen/mug-with-logo.png
```

- `--image` 可重複最多五次，順序有意義，請在提示詞中以編號說明每張圖的角色。
- 編輯 API 不接受 `--width`、`--height`、`--size`。

### 批次產生影像

```bash
mkdir -p tmp/imagegen
cat > tmp/imagegen/prompts.jsonl << 'EOF'
{"prompt":"Cavernous hangar interior with a compact shuttle parked near the center","use_case":"stylized-concept","size":"1536x1024","out":"hangar.png"}
{"prompt":"Gray wolf in profile in a snowy forest","width":1024,"height":1024}
{"prompt":"Current skyline of Taipei at dusk","auto_aspect_ratio":true,"web_grounding":true}
EOF

node "$IMAGE_GEN" generate-batch \
  --input tmp/imagegen/prompts.jsonl \
  --out-dir output/imagegen/batch
```

#### JSONL 格式

每一行是一個工作，可以是純文字提示詞，或含 `prompt` 的 JSON 物件；空行與 `#` 開頭的註解行會被忽略，最多 500 個工作。JSONL 中的屬性會覆蓋 CLI 參數。

| JSONL 屬性 | 必填 | 說明 |
| --- | --- | --- |
| `prompt` | 是 | 此工作的提示詞。 |
| `model` | 否 | 此工作使用的 deployment；指定後不再沿用 CLI 的 `--base-model`。 |
| `base_model` | 否 | 自訂 deployment 名稱的基礎模型。 |
| `width`、`height`、`size` | 否 | 輸出尺寸；只要指定其中任一個，就整組取代 CLI 的尺寸設定。 |
| `auto_aspect_ratio`、`web_grounding` | 否 | 布林值，僅限 MAI-Image-2.6 系列。 |
| `out` | 否 | `--out-dir` 底下的輸出檔名（目錄部分會被忽略）；未指定時依序號與提示詞產生。 |
| `use_case`、`scene`、`subject`、`style`、`composition`、`lighting`、`palette`、`materials`、`text`、`constraints`、`negative` | 否 | 提示詞擴充欄位。 |
| `fields` | 否 | 以物件提供上述擴充欄位；同層欄位優先。 |

CLI 會在送出第一個請求前驗證所有工作，並檢查輸出檔名是否重複或已存在。MAI-Image-2.6-Flash 在 Tier 1 只有每分鐘 6 個請求，因此 `--concurrency` 預設為 2。

## 預設值

| 設定 | 預設值 |
| --- | --- |
| Deployment | `IMAGEGEN_MAI_IMAGE_DEPLOYMENT`，未設定時為 `MAI-Image-2.6-Flash` |
| 尺寸 | `1024x1024`；使用 `--auto-aspect-ratio` 且未指定尺寸時不送寬高 |
| 輸出格式 | PNG（API 固定） |
| 輸出路徑 | `output/imagegen/output.png` |
| 重試次數 | 3 次（`--max-attempts`） |
| 批次並行數 | 2（`--concurrency`，上限 10） |

## 常用參數

| 參數 | 說明 |
| --- | --- |
| `--prompt`／`--prompt-file` | 提示詞文字或檔案 |
| `--model` | Deployment 名稱 |
| `--base-model` | 自訂 deployment 名稱的基礎模型 |
| `--width`、`--height`／`--size` | 輸出尺寸（僅產圖） |
| `--auto-aspect-ratio` | 由模型決定長寬比（僅 2.6 系列） |
| `--web-grounding` | 允許模型參考 Bing 搜尋結果（僅 2.6 系列） |
| `--image` | 編輯用的輸入影像，最多五張 |
| `--out`／`--out-dir` | 單次輸出路徑／批次輸出目錄 |
| `--dry-run` | 只輸出 request，不呼叫 API |
| `--force` | 覆寫既有輸出檔案 |
| `--no-augment` | 原樣送出提示詞，不加上 `Primary request:` 等標籤 |
| `--downscale-max-dim` | 額外產生長邊受限的縮圖 |

完整說明請見 `references/cli.md`。

## 透明背景策略

MAI image 模型一律輸出不透明 PNG，沒有原生透明背景選項，因此透明背景需求一律採用 chroma-key 流程：

```bash
node "$IMAGE_GEN" generate \
  --prompt "A ceramic coffee mug on a perfectly flat solid #00ff00 chroma-key background; no shadow, no reflection, no gradient; do not use #00ff00 in the mug" \
  --out tmp/imagegen/mug-key.png

node "<skill-dir>/scripts/remove_chroma_key.js" \
  --input tmp/imagegen/mug-key.png \
  --out output/imagegen/mug.png \
  --auto-key border \
  --soft-matte \
  --transparent-threshold 12 \
  --opaque-threshold 220 \
  --despill
```

- 預設背景色為 `#00ff00`，主體是綠色時改用 `#ff00ff`。
- 去背後請確認輸出具有 alpha channel、四角透明，且邊緣沒有殘留背景色。
- 毛髮、玻璃、煙霧、液體等半透明或反光主體不適合 chroma-key 去背。

## 測試

```bash
npm run check   # 語法檢查
npm test        # 以本機 mock server 驗證 API 請求格式與參數驗證
```

測試不會呼叫真正的 Foundry API。

## 輸出慣例

- 專案內的最終輸出建議放在 `output/imagegen/`。
- 暫存 JSONL 或 chroma-key 原圖建議放在 `tmp/imagegen/`。
- 預設不覆寫既有檔案；若確定要覆寫，請加上 `--force`。

## 參考文件

- `SKILL.md`：skill 的主要規則與工作流程。
- `references/cli.md`：CLI 使用細節。
- `references/image-api.md`：MAI image API 參數、限制、錯誤排除與價格。
- `references/prompting.md`：提示詞設計建議。
- `references/sample-prompts.md`：常見使用情境提示詞範本。
- `references/codex-network.md`：網路與 sandbox 相關說明。
- [Deploy and use MAI image models in Microsoft Foundry](https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image)

## 授權

請參考 `LICENSE.txt`。
