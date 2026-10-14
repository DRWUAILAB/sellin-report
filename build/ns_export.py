"""
Sell-in 網頁報表：從 NetSuite 匯出 2026-07 起的資料（SuiteQL 唯讀，口徑同 NetSuite 報表 405）
直接沿用 NS 匯入程式的 sellin_export.py（連線設定、SQL、拆組都在那裡），這裡只把結果存成報表用的 CSV。

用法：
    python build/ns_export.py                         # 2026-07 ～ 本月
    python build/ns_export.py --from 2026-09 --to 2026-10
NS 匯入程式資料夾：--nsdir，或環境變數 NS_PROGRAM_DIR；預設 Mac 上的 DRWU/DrWu/02_NS匯入程式/NS匯入程式
輸出（data/ 不進版控）：
    data/ns_未拆組.csv、data/ns_拆組.csv：年月,通路別,客戶名稱,領用,品號,贈備品,銷貨數量,銷退數量,銷貨淨量,銷貨淨額,銷貨成本
    data/ns_品項.csv：品號,品名,產品代碼,前三碼,前六碼,系列別,劑型分類,存貨型態
已匯出的月份如果不在這次範圍內會保留（例：只重抓本月，其他月份不動）。
"""
import argparse
import csv
import datetime as dt
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
DEFAULT_NS = Path.home() / "Desktop/DRWU/DrWu/02_NS匯入程式/NS匯入程式"
FACT_HEAD = ["年月", "通路別", "客戶名稱", "領用", "品號", "贈備品", "銷貨數量", "銷退數量", "銷貨淨量", "銷貨淨額", "銷貨成本"]
ITEM_HEAD = ["品號", "品名", "產品代碼", "前三碼", "前六碼", "系列別", "劑型分類", "存貨型態"]


def read_rows(path):
    """已存在的 CSV（不含標題列）；沒有檔案回傳空串列。"""
    if not path.exists():
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.reader(f))[1:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="a", default="2026-07")
    ap.add_argument("--to", dest="b", default=dt.date.today().strftime("%Y-%m"))
    ap.add_argument("--nsdir", default=os.environ.get("NS_PROGRAM_DIR") or str(DEFAULT_NS))
    args = ap.parse_args()
    nsdir = Path(args.nsdir)
    if not (nsdir / "sellin_export.py").exists():
        sys.exit(f"[錯誤] 找不到 NS 匯入程式（{nsdir}），請用 --nsdir 指定")

    os.environ["NSIMP_ENV"] = "prod"
    sys.path.insert(0, str(nsdir))
    cwd = os.getcwd()
    os.chdir(nsdir)
    import sellin_export as se
    from core.config import load_config
    from core.netsuite import NetSuiteClient
    client = NetSuiteClient(load_config())
    os.chdir(cwd)

    months = se.month_list(args.a, args.b)
    print(f"NetSuite 正式區（只查詢）：{months[0][0]} ～ {months[-1][0]}")
    data = se.fetch(client, months)
    alloc = se.kit_alloc(data["bom"], data["prices"])
    detail = se.enrich(data["facts"], data, False)
    exploded = se.enrich(se.explode(data["facts"], alloc), data, True)

    DATA.mkdir(exist_ok=True)
    redo = {ym.replace("-", "") for ym, _, _ in months}
    for name, rows in (("未拆組", detail), ("拆組", exploded)):
        out = DATA / f"ns_{name}.csv"
        keep = [r for r in read_rows(out) if r[0] not in redo]
        new = [[g["ym"].replace("-", ""), g["chancat"], g["cust_name"], g["loan"], g["code"], g["gift"],
                round(g["sqty"], 4), round(g["rqty"], 4), round(g["qty"], 4), round(g["amt"], 4), round(g["cogs"], 4)]
               for g in rows]
        with open(out, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(FACT_HEAD)
            w.writerows(sorted(keep + new, key=lambda r: (r[0], r[2], r[4], r[5])))
        print(f"已輸出 {out}（這次 {len(new):,} 列，保留其他月份 {len(keep):,} 列）")

    # 品項主檔：累加（舊月份用到、這次沒查到的品號也保留）
    out = DATA / "ns_品項.csv"
    items = {r[0]: r for r in read_rows(out)}
    for r in data["items"].values():
        code = se.sid(r.get("code")) or se.sid(r.get("itemid"))
        spec = se.sid(r.get("spec"))
        items[code] = [code, se.sid(r.get("displayname")) or se.sid(r.get("itemid")), spec, spec[:3], spec[:6],
                       se.sid(r.get("series")), se.sid(r.get("dose")), se.sid(r.get("ptype"))]
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(ITEM_HEAD)
        w.writerows(items[k] for k in sorted(items))
    print(f"已輸出 {out}（{len(items):,} 個品號）")

    t = se.totals(detail)
    print("每月合計（排除贈備品、領用；對 405）：")
    for ym in sorted(t):
        x = t[ym]
        print(f"  {ym} 淨額 {x['amt']:,.0f} 成本 {x['cogs']:,.0f} 銷貨 {x['sqty']:,.0f} 銷退 {x['rqty']:,.0f} 淨量 {x['qty']:,.0f}")


if __name__ == "__main__":
    main()
