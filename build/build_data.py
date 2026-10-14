"""
Sell-in 網頁報表：資料建置
合併 Power BI 歷史（舊 ERP，2026-06 以前）與 NetSuite（2026-07 起，口徑同報表 405），
套用通路對照、系列對照後，以密碼加密（PBKDF2-SHA256 → AES-256-GCM）輸出 docs/data.enc。

先準備 data/ 的 CSV：
    python build/pbi_export.py     # Power BI 歷史（只有舊資料要補時才需要重跑）
    python build/ns_export.py      # NetSuite（每月更新）
再建置：
    python build/build_data.py              # 密碼讀 build/password.txt（不進版控）或環境變數 SELLIN_PASSWORD
    python build/build_data.py --check      # 只驗算，不輸出
"""
import argparse
import base64
import csv
import gzip
import json
import os
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = ROOT / "data"
PBKDF2_ITER = 250_000
CUTOVER = "202607"     # NetSuite 上線月：此月起用 NetSuite，之前用 Power BI
GIFT, LOAN = 1, 2      # 事實表 flag 位元：贈備品、領用

# 405 第十二版本期（預設：排除贈備品、領用；扣掉〔非品項收入〕〔總帳成本差額〕），2026-10-14 核對值。
# 前五欄與 sellin_export.py 的 EXPECT_405 相同（改的話兩邊一起改）；xnq＝拆組後淨量（規格書第 7 節）
EXPECT_405 = {
    "202607": {"amt": 110117707, "cogs": 21366112, "sq": 221879, "rq": -16199, "nq": 205680, "xnq": 264645},
    "202608": {"amt": 177299615, "cogs": 32269699, "sq": 288561, "rq": -9055, "nq": 279506, "xnq": 333683},
    "202609": {"amt": 117616663, "cogs": 22220933, "sq": 223486, "rq": -7614, "nq": 215872, "xnq": 233179},
}


def txt(v):
    s = "" if v is None else str(v).strip()
    return s or None


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def need(path):
    if not path.exists():
        sys.exit(f"[錯誤] 找不到 {path.relative_to(ROOT)}，請先執行 build/pbi_export.py 與 build/ns_export.py")
    return read_csv(path)


# ---------------------------------------------------------------- 對照表
def name_map(file, src_col, dst_col, strip_suffix=None):
    """系列對照／劑型對照：Power BI（舊 ERP）名稱 → NetSuite 名稱；沒列的照原名（系列另外去掉結尾「系列」）。"""
    f = HERE / file
    m = {txt(r[src_col]): txt(r[dst_col]) for r in read_csv(f)} if f.exists() else {}
    def norm(s):
        s = txt(s)
        if not s:
            return None
        if s in m:
            return m[s]
        return s[:-len(strip_suffix)] if strip_suffix and s.endswith(strip_suffix) and len(s) > len(strip_suffix) else s
    return norm


def channel_map():
    """通路對照.csv：（來源, 原通路別, 原通路名稱）→（通路類別, 通路名稱）。原通路名稱「*」＝整個通路別的預設，欄位留空＝不改。"""
    rows = read_csv(HERE / "通路對照.csv")
    exact, wild = {}, {}
    for r in rows:
        key = (txt(r["來源"]), txt(r["原通路別"]))
        val = (txt(r["通路類別"]), txt(r["通路名稱"]))
        if txt(r["原通路名稱"]) == "*":
            wild[key] = val
        else:
            exact[key + (txt(r["原通路名稱"]),)] = val
    used = set()

    def get(src, cat, name):
        w = wild.get((src, cat), (None, None))
        e = exact.get((src, cat, name))
        if e:
            used.add((src, cat, name))
        e = e or (None, None)
        return (e[0] or w[0] or cat or "(未分類)", e[1] or w[1] or name or cat or "(未分類)",
                bool(e[0] or e[1] or w[0] or w[1]))
    return get, exact, used


# ---------------------------------------------------------------- 主程式
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "docs" / "data.enc"))
    ap.add_argument("--check", action="store_true", help="只驗算，不輸出")
    args = ap.parse_args()

    norm_s = name_map("系列對照.csv", "原系列名稱", "報表系列名稱", "系列")
    norm_d = name_map("劑型對照.csv", "原劑型名稱", "報表劑型名稱")
    ch_get, ch_exact, ch_used = channel_map()

    # 品項：NetSuite 主檔優先（現行分類），NetSuite 留空的欄位與舊品號用 Power BI
    items = {}
    for r in need(DATA / "pbi_品項.csv"):
        items[r["品號"]] = [r["品號"], txt(r["品名"]), txt(r["規格"]), txt(r["前三碼"]), txt(r["前六碼"]),
                           norm_s(r["系列別"]), norm_d(r["劑型分類"]), txt(r["存貨型態"]), "PBI"]
    for r in need(DATA / "ns_品項.csv"):
        old = items.get(r["品號"]) or [None] * 9
        new = [r["品號"], txt(r["品名"]), txt(r["產品代碼"]), txt(r["前三碼"]), txt(r["前六碼"]),
               norm_s(r["系列別"]), norm_d(r["劑型分類"]), txt(r["存貨型態"]), "NS"]
        items[r["品號"]] = [n if n is not None else o for n, o in zip(new, old)]

    yms, chans, its = {}, {}, {}
    def ix(d, k):
        if k not in d:
            d[k] = len(d)
        return d[k]

    def item_ix(code):
        if code not in items:
            items[code] = [code, None, None, None, None, None, None, None, "?"]
        return ix(its, code)

    facts = {"single": defaultdict(lambda: [0.0] * 5), "combo": defaultdict(lambda: [0.0] * 5)}
    per_src = defaultdict(lambda: [0, 0.0])

    def add(kind, ym, ch, code, flag, sq, rq, nq, amt, cogs):
        if not (sq or rq or nq or amt or cogs):
            return
        k = (ix(yms, ym), ch, item_ix(code), flag)
        v = facts[kind][k]
        v[0] += sq; v[1] += rq; v[2] += nq; v[3] += amt; v[4] += cogs

    for kind, name in (("single", "未拆組"), ("combo", "拆組")):
        for r in need(DATA / f"pbi_{name}.csv"):
            ym = r["年月"]
            if ym >= CUTOVER:
                continue
            ch = ix(chans, ("PBI", txt(r["通路別"]), txt(r["通路名稱"])))
            code = txt(r["品號"]) or "(空白)"
            add(kind, ym, ch, code, 0, num(r["銷貨數量"]), num(r["銷退數量"]), num(r["銷貨淨量"]),
                num(r["銷貨淨額"]), num(r["銷貨成本"]))
            # Power BI 的贈品、備品是另外的欄位：當成一列「贈備品」（數量、成本，金額 0），預設排除同 405
            gq = num(r["贈品數量"]) + num(r["備品數量"])
            gc = num(r["贈品成本"]) + num(r["備品成本"])
            add(kind, ym, ch, code, GIFT, gq, 0, gq, 0, gc)
            if kind == "single":
                p = per_src[("PBI", ym)]
                p[0] += 1; p[1] += num(r["銷貨淨額"])
        for r in need(DATA / f"ns_{name}.csv"):
            ym = r["年月"]
            if ym < CUTOVER:
                continue
            ch = ix(chans, ("NS", txt(r["通路別"]), txt(r["客戶名稱"])))
            flag = (GIFT if r["贈備品"] == "Y" else 0) | (LOAN if r["領用"] == "Y" else 0)
            add(kind, ym, ch, txt(r["品號"]) or "(空白)", flag, num(r["銷貨數量"]), num(r["銷退數量"]),
                num(r["銷貨淨量"]), num(r["銷貨淨額"]), num(r["銷貨成本"]))
            if kind == "single":
                p = per_src[("NS", ym)]
                p[0] += 1; p[1] += num(r["銷貨淨額"])

    # 年月重新排序（事實表的年月索引跟著換）
    ym_list = sorted(yms)
    remap = {yms[y]: i for i, y in enumerate(ym_list)}
    ch_list = sorted(chans, key=lambda k: chans[k])
    item_list = sorted(its, key=lambda k: its[k])

    # 通路：NetSuite 的通路名稱是標準；Power BI 的通路對到 NetSuite 也有的名稱＝有對上（最後一欄 1），
    # 對不上的（只有舊資料才有的通路，或對照表漏了）在資料檢核標黃
    channels = [[src, cat, name, *ch_get(src, cat, name)[:2]] for src, cat, name in ch_list]
    canon = {c[4] for c in channels if c[0] == "NS"}
    for c in channels:
        c.append(1 if c[0] == "NS" or c[4] in canon else 0)
    out_items = []
    for code in item_list:
        it = items[code]
        spec = it[2] or ""
        brand = "Redermx" if spec[:1] in ("X", "x") else "DR.WU"
        out_items.append([it[0], it[1], it[2], it[3], it[4], it[5], it[6], it[7], brand, it[8]])

    def pack(kind):
        rows = [[remap[k[0]], k[1], k[2], k[3]] + [round(x, 2) for x in v] for k, v in facts[kind].items()]
        rows.sort(key=lambda r: (r[0], r[1], r[2], r[3]))
        return rows

    single, combo = pack("single"), pack("combo")

    # ---- 驗算
    print("各月來源（未拆組）：")
    for y in ym_list:
        src = "NS" if y >= CUTOVER else "PBI"
        n, a = per_src[(src, y)]
        if y >= "202501":
            print(f"  {y} {src:<3} {n:>6,} 列 淨額 {a:>16,.0f}")
    print("NetSuite 月份對 405（排除贈備品、領用、未拆組）：")
    warn = []
    tot = defaultdict(lambda: [0.0] * 5)
    for r in single:
        if r[3]:
            continue
        t = tot[ym_list[r[0]]]
        for i in range(5):
            t[i] += r[4 + i]
    xnq = defaultdict(float)
    for r in combo:
        if not r[3]:
            xnq[ym_list[r[0]]] += r[6]
    for y, e in EXPECT_405.items():
        if y not in tot:
            continue
        t = tot[y]
        got = {"amt": t[3], "cogs": t[4], "sq": t[0], "rq": t[1], "nq": t[2], "xnq": xnq[y]}
        bad = [k for k in e if abs(got[k] - e[k]) > 1]
        print(f"  {y} 淨額 {t[3]:,.0f} 成本 {t[4]:,.0f} 銷貨 {t[0]:,.0f} 銷退 {t[1]:,.0f} 淨量 {t[2]:,.0f} 拆組後淨量 {xnq[y]:,.0f}  "
              + ("✔ 一致" if not bad else "✘ 不一致：" + "、".join(f"{k} 差 {got[k] - e[k]:,.0f}" for k in bad)))
        if bad:
            warn.append(y)
    if warn:
        print("  [注意] NetSuite 與 405 不一致：先跑 sellin_export.py --probe 確認 API 權限（缺權限時 SuiteQL 只會少資料）；"
              "月結還在動的月份也會有落差")
    unmapped = [c for c in channels if not c[5]]
    if unmapped:
        print(f"Power BI 有 {len(unmapped)} 個通路對不到 NetSuite 的通路名稱（只有舊資料才有？）："
              + "、".join(f"{c[1]}/{c[2]}→{c[4]}" for c in unmapped))
    unused = sorted(set(ch_exact) - ch_used)
    if unused:
        print("[注意] 通路對照有、資料裡沒有的列（打錯？）：" + "、".join("/".join(map(str, k)) for k in unused))
    print(f"品項 {len(out_items):,}；未拆組 {len(single):,} 列；拆組 {len(combo):,} 列")
    if args.check:
        return

    data = {
        "v": 1,
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "cutover": CUTOVER,
        "source": {"pbi": "Power BI「Sellin 通路及系列別分析 (未拆組&拆組)」", "ns": "NetSuite SuiteQL（口徑同報表 405）",
                   "nsMissingReturns": warn},
        "yms": ym_list,
        "itemCols": ["品號", "品名", "產品代碼", "前三碼", "前六碼", "系列", "劑型", "存貨型態", "品牌", "主檔來源"],
        "items": out_items,
        "chCols": ["來源", "原通路別", "原通路名稱", "通路類別", "通路名稱", "有對照"],
        "channels": channels,
        "factCols": ["年月", "通路", "品項", "flag(1贈備品 2領用)", "銷貨數量", "銷退數量", "銷貨淨量", "銷貨淨額", "銷貨成本"],
        "single": single,
        "combo": combo,
        "expect405": EXPECT_405,
    }
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    pw = os.environ.get("SELLIN_PASSWORD")
    pwf = HERE / "password.txt"
    if not pw and pwf.exists():
        pw = pwf.read_text(encoding="utf-8-sig").strip()
    if not pw:
        sys.exit("沒有密碼：請建立 build/password.txt 或設定環境變數 SELLIN_PASSWORD")
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=PBKDF2_ITER).derive(pw.encode())
    ct = AESGCM(key).encrypt(iv, gzip.compress(raw, 9), None)
    b64 = lambda b: base64.b64encode(b).decode()
    enc = {"v": 1, "kdf": "PBKDF2-SHA256", "iter": PBKDF2_ITER, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}
    Path(args.out).parent.mkdir(exist_ok=True)
    Path(args.out).write_text(json.dumps(enc), encoding="utf-8")
    print(f"已輸出 {args.out}（JSON {len(raw) / 1e6:.2f} MB → 加密 {Path(args.out).stat().st_size / 1e6:.2f} MB）")


if __name__ == "__main__":
    main()
