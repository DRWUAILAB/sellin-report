"""
Sell-in 網頁報表：從 Power BI 匯出歷史資料（舊 ERP，NetSuite 上線前）
資料集「Sellin 通路及系列別分析 (未拆組&拆組)」，用 DAX executeQueries 唯讀查詢，逐月彙總到 年月 × 通路別 × 通路名稱 × 品號。

用法（先 az login 過）：
    python build/pbi_export.py                       # 預設 2019-01 ～ 2026-06
    python build/pbi_export.py --from 2025-01 --to 2026-06
輸出（data/ 不進版控）：
    data/pbi_未拆組.csv、data/pbi_拆組.csv：年月,通路別,通路名稱,品號,銷貨數量,銷退數量,銷貨淨量,銷貨淨額,銷貨成本,贈品數量,備品數量,贈品成本,備品成本
    data/pbi_品項.csv：品號,品名,規格,前三碼,前六碼,系列別,劑型分類,存貨型態,產品分類（兩張表都有時以未拆組為準）
"""
import argparse
import csv
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
GROUP = "c795b50a-2009-4f16-a1b1-fc1052644a79"      # 工作區 drwu_data_platform
DATASET = "82d3a3b4-07e4-401f-9e13-dac6f2b3eda8"    # Sellin 通路及系列別分析 (未拆組&拆組)
TABLES = {"未拆組": "vw_sellinsingle_staging", "拆組": "vw_sellincombo_staging"}
MEASURES = [("銷貨數量", "銷貨數量"), ("銷退數量", "銷退數量"), ("銷貨淨量", "銷貨淨量"), ("銷貨淨額", "台幣銷貨淨額"),
            ("銷貨成本", "銷貨成本"), ("贈品數量", "贈品數量"), ("備品數量", "備品數量"), ("贈品成本", "贈品成本"), ("備品成本", "備品成本")]
ITEM_COLS = [("品號", "品號"), ("品名", "品名"), ("規格", "規格"), ("前三碼", "規格前三碼"), ("前六碼", "規格前六碼"),
             ("系列別", "系列別"), ("劑型分類", "劑型分類"), ("存貨型態", "存貨型態"), ("產品分類", "產品分類")]


def token():
    az = shutil.which("az") or str(Path.home() / ".local/bin/az")
    r = subprocess.run([az, "account", "get-access-token", "--resource", "https://analysis.windows.net/powerbi/api",
                        "--query", "accessToken", "-o", "tsv"], capture_output=True, text=True,
                       env={**__import__("os").environ, "PYTHONWARNINGS": "ignore"})
    if r.returncode:
        sys.exit("[錯誤] 取不到 Power BI 權杖，請先執行 az login --allow-no-subscriptions\n" + r.stderr[-500:])
    return r.stdout.strip()


class PBI:
    def __init__(self):
        self.tok, self.t0 = token(), time.time()

    def query(self, dax):
        if time.time() - self.t0 > 2400:      # 權杖約 1 小時到期，40 分鐘換一次
            self.tok, self.t0 = token(), time.time()
        url = f"https://api.powerbi.com/v1.0/myorg/groups/{GROUP}/datasets/{DATASET}/executeQueries"
        for attempt in range(4):
            r = requests.post(url, headers={"Authorization": f"Bearer {self.tok}"}, timeout=300,
                              json={"queries": [{"query": dax}], "serializerSettings": {"includeNulls": True}})
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(10 * (attempt + 1))
                continue
            if r.status_code != 200:
                sys.exit(f"[錯誤] DAX 查詢失敗 {r.status_code}：{r.text[:500]}\n{dax}")
            res = r.json()["results"][0]
            if "error" in res:
                sys.exit(f"[錯誤] DAX：{json.dumps(res['error'], ensure_ascii=False)[:500]}")
            rows = res["tables"][0]["rows"]
            # 欄名形如 "表[欄]" 或 "[量值]"，只留中括號內
            return [{k[k.rfind("[") + 1:-1]: v for k, v in row.items()} for row in rows]
        sys.exit("[錯誤] Power BI 一直回 429/5xx，稍後再試")


def months(a, b):
    y, m = map(int, a.split("-"))
    y2, m2 = map(int, b.split("-"))
    while (y, m) <= (y2, m2):
        yield f"{y:04d}-{m:02d}"
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def fact_dax(t, ym):
    meas = ",".join(f'"{k}",SUM(\'{t}\'[{c}])' for k, c in MEASURES)
    return (f"EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('{t}'[通路別],'{t}'[通路名稱],'{t}'[品號],{meas}),"
            f"'{t}'[銷貨年月]=\"{ym}\")")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="a", default="2019-01")
    ap.add_argument("--to", dest="b", default="2026-06", help="NetSuite 2026-07 上線，之後的月份改用 ns_export.py")
    args = ap.parse_args()
    DATA.mkdir(exist_ok=True)
    pbi = PBI()
    heads = ["年月", "通路別", "通路名稱", "品號"] + [k for k, _ in MEASURES]
    for name, t in TABLES.items():
        out = DATA / f"pbi_{name}.csv"
        n = 0
        with open(out, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(heads)
            for ym in months(args.a, args.b):
                rows = pbi.query(fact_dax(t, ym))
                for r in rows:
                    w.writerow([ym.replace("-", ""), r["通路別"], r["通路名稱"], r["品號"]] +
                               [round(r[k] or 0, 4) for k, _ in MEASURES])
                n += len(rows)
                print(f"\r{name} {ym}：{len(rows):,} 列（累計 {n:,}）", end="", flush=True)
        print(f"\n已輸出 {out}")

    items = {}
    for name in ("拆組", "未拆組"):      # 未拆組後寫入 → 優先
        t = TABLES[name]
        cols = ",".join(f"'{t}'[{c}]" for _, c in ITEM_COLS)
        for r in pbi.query(f"EVALUATE SUMMARIZE('{t}',{cols})"):
            if r["品號"]:
                items[r["品號"]] = [r[c] for _, c in ITEM_COLS]
    out = DATA / "pbi_品項.csv"
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow([k for k, _ in ITEM_COLS])
        w.writerows(items[k] for k in sorted(items))
    print(f"已輸出 {out}（{len(items):,} 個品號）")


if __name__ == "__main__":
    main()
