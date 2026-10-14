# Sell-in 網頁報表

Sell-in 報表的網頁版，做法同 [sellout-report](https://github.com/DRWUAILAB/sellout-report)：部署在 GitHub Pages，資料以密碼加密（PBKDF2-SHA256 25 萬次 → AES-256-GCM），repo 與網站上只有加密後的 `docs/data.enc`，沒有原始明細。詳細規格見內部文件 `SellIn報表_規格書.md`（不進版控）。

| 頁籤 | 內容 |
| --- | --- |
| ① 系列別 | 系列別 → 品項 |
| ② 劑型分類 | 劑型分類 → 品項 |
| ③ 產品代碼 | 前三碼 → 前六碼 → 品項 |
| ④ 通路別 | 通路別 → 通路名稱 → 品項 |
| ⑤ 系列別 by 月 | 系列別／劑型分類／通路別 × 銷貨年月（銷貨淨額、淨量、成本、數量），可展開到品號 |
| 資料檢核 | 405 對帳（含拆組後淨量）、各月合計（依來源、拆組前後差額）、通路對照、品項缺分類 |

①～④ 仿 NetSuite 報表 405「Sell in 成本分析」：欄＝前期、本期（銷貨數量、銷退數量、銷貨淨量、銷貨淨額、占比、銷貨成本、成本率）、本年累計、變化（Sell-in 差異、成長率、成本率增減）。篩選：口徑（未拆組／拆組，預設未拆組）、前期、本期、品牌、通路別、通路名稱；右上「含贈備品」「含領用」預設關閉（同 405）。每頁可「⬇ 下載 Excel」（有格式、大綱群組可用左上 1/2/3 收合，附篩選條件），「⬇ 全部報表」放在同一個 Excel。

## 資料來源

| 期間 | 來源 | 取數 |
| --- | --- | --- |
| 2019/01～2026/06 | Power BI「Sellin 通路及系列別分析 (未拆組&拆組)」（工作區 drwu_data_platform，舊 ERP） | `build/pbi_export.py`（DAX 唯讀，`az login` 身分） |
| 2026/07 起 | NetSuite SuiteQL（唯讀，口徑同 405 第十二版） | `build/ns_export.py`（呼叫 NS匯入程式 的 `sellin_export.py`） |

切換月 `CUTOVER = "202607"`（`build/build_data.py`）。Power BI 的贈品＋備品合成一列「贈備品」（數量、成本，金額 0）；領用只有 NetSuite 有。不含 405 的〔非品項收入〕〔總帳成本差額〕與總帳表，所以要跟 405 的商品行合計比。

驗收：`python build/build_data.py --check` 印出 NetSuite 各月對 405 的五欄＋拆組後淨量，應全部「✔ 一致」（2026-10-14 核對：7／8／9 月一元不差）。

## 對照表（build/，進版控）

- `通路對照.csv`（來源,原通路別,原通路名稱,通路類別,通路名稱,說明）：Power BI 與 NetSuite 的通路對成同一套名稱；原通路名稱「*」＝整個通路別的預設，欄位留空＝不改。NetSuite 名稱是標準，Power BI 對不到的（只有舊資料才有，例如 yahoo、韓國）在資料檢核標黃。標「請確認」的是推測的對應。
- `系列對照.csv`、`劑型對照.csv`：Power BI 名稱 → NetSuite 名稱（依兩邊都有的品號對出來，例：實驗室配方 → 實驗室精萃、精華油 → 臉部油）。品項主檔以 NetSuite 為準，舊品號才用 Power BI。

## 每月更新

點 `更新報表資料.command`（Mac）或 `更新報表資料.bat`（Windows）：同步 GitHub → 抓 NetSuite 2026/07 至本月 → 重建 `docs/data.enc` → push，GitHub Pages 約 1 分鐘後更新；內容沒有變化時不發布。加 `--no-fetch` 只用 `data/` 現有的 CSV 重建。

Power BI 歷史不需要每月重抓；要補舊資料時：`az login --allow-no-subscriptions` → `python build/pbi_export.py`。

密碼放在 `build/password.txt`（不進版控），或設定環境變數 `SELLIN_PASSWORD`。repo 是公開的，**舊版 data.enc 仍留在 git 歷史裡，用舊密碼還是打得開**；如果是因為密碼外流才換，必須清除 git 歷史。

需求：Python 3.10+、`openpyxl`、`PyYAML`、`requests`、`cryptography`；NS匯入程式（`--nsdir` 或 `NS_PROGRAM_DIR`）；Azure CLI。這台 Mac：`~/.local/sellin-venv`（Python 3.12）、`~/.local/bin/az`、`~/.local/bin/gh`。
