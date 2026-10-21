"""
Power BI 歷史 CSV 加密打包：讓 GitHub Actions（雲端）也拿得到舊資料，repo 上只有加密檔。

    python build/pbi_pack.py pack      # data/pbi_*.csv → build/pbi.enc（重跑 pbi_export.py 後執行，再 commit build/pbi.enc）
    python build/pbi_pack.py unpack    # build/pbi.enc → data/pbi_*.csv（GitHub Actions 用）
密碼同 data.enc：build/password.txt 或環境變數 SELLIN_PASSWORD。加密方式同 build_data.py（PBKDF2-SHA256 → AES-256-GCM）。
"""
import base64
import gzip
import json
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
ENC = HERE / "pbi.enc"
FILES = ["pbi_品項.csv", "pbi_未拆組.csv", "pbi_拆組.csv"]
PBKDF2_ITER = 250_000


def password():
    pw = os.environ.get("SELLIN_PASSWORD")
    pwf = HERE / "password.txt"
    if not pw and pwf.exists():
        pw = pwf.read_text(encoding="utf-8-sig").strip()
    if not pw:
        sys.exit("沒有密碼：請建立 build/password.txt 或設定環境變數 SELLIN_PASSWORD")
    return pw


def derive(salt, iters):
    return PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iters).derive(password().encode())


def pack():
    missing = [f for f in FILES if not (DATA / f).exists()]
    if missing:
        sys.exit(f"[錯誤] 找不到 data/{'、'.join(missing)}，請先執行 build/pbi_export.py")
    raw = json.dumps({f: (DATA / f).read_text(encoding="utf-8-sig") for f in FILES}, ensure_ascii=False).encode("utf-8")
    salt, iv = os.urandom(16), os.urandom(12)
    ct = AESGCM(derive(salt, PBKDF2_ITER)).encrypt(iv, gzip.compress(raw, 9), None)
    b64 = lambda b: base64.b64encode(b).decode()
    ENC.write_text(json.dumps({"v": 1, "kdf": "PBKDF2-SHA256", "iter": PBKDF2_ITER,
                               "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}), encoding="utf-8")
    print(f"已輸出 {ENC.relative_to(HERE.parent)}（CSV {len(raw) / 1e6:.1f} MB → 加密 {ENC.stat().st_size / 1e6:.1f} MB）")


def unpack():
    if not ENC.exists():
        sys.exit(f"[錯誤] 找不到 {ENC.relative_to(HERE.parent)}，請在本機執行 python build/pbi_pack.py pack 後 commit")
    enc = json.loads(ENC.read_text(encoding="utf-8"))
    b = base64.b64decode
    try:
        raw = gzip.decompress(AESGCM(derive(b(enc["salt"]), enc["iter"])).decrypt(b(enc["iv"]), b(enc["ct"]), None))
    except Exception:
        sys.exit("[錯誤] build/pbi.enc 解不開：密碼（SELLIN_PASSWORD）和打包時不同？")
    DATA.mkdir(exist_ok=True)
    for name, text in json.loads(raw).items():
        (DATA / name).write_text(text, encoding="utf-8-sig")
        print(f"已還原 data/{name}")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    {"pack": pack, "unpack": unpack}.get(cmd, lambda: sys.exit("用法：python build/pbi_pack.py pack | unpack"))()
