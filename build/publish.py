"""
Sell-in 網頁報表：抓 NetSuite 最新資料、重建加密資料並發布到 GitHub（更新報表資料.command／.bat 呼叫這支）

步驟：同步 GitHub → ns_export.py（NetSuite 2026-07 起，只查詢）→ build_data.py → commit（docs/data.enc 與 build/ 的對照表 CSV）→ push。
任何一步失敗都會停下來並說明原因，不會顯示「完成」。
- data.enc 每次加密都用新的隨機值，所以改用「解密後的內容」判斷有沒有變化（不含建置時間），內容相同就不發布。
- Power BI 歷史（data/pbi_*.csv）不會每次重抓；舊資料要補時另外執行 build/pbi_export.py。
- 加 --no-fetch：不抓 NetSuite，只用 data/ 現有的 CSV 重建。
"""
import base64
import gzip
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent
DATA = "docs/data.enc"
CONFIG_CSV = ["build/通路對照.csv", "build/系列對照.csv", "build/劑型對照.csv"]


def git(*args, quiet=False):
    return subprocess.run(["git", *args], cwd=WEB, capture_output=quiet, text=True, encoding="utf-8")


def step(title):
    print(f"\n== {title}", flush=True)


def fail(msg):
    print(f"\n[失敗] {msg}")
    sys.exit(1)


def content_digest(path):
    """data.enc 解密後的內容指紋（不含 generated 建置時間）；讀不到或解不開回傳 None（視為有變化）。"""
    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
        pw = os.environ.get("SELLIN_PASSWORD") or (WEB / "build" / "password.txt").read_text(encoding="utf-8-sig").strip()
        enc = json.loads(Path(path).read_text(encoding="utf-8"))
        b = lambda s: base64.b64decode(s)
        key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=b(enc["salt"]), iterations=enc["iter"]).derive(pw.encode())
        obj = json.loads(gzip.decompress(AESGCM(key).decrypt(b(enc["iv"]), b(enc["ct"]), None)))
        obj.pop("generated", None)
        return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    except Exception:
        return None


def sync():
    """同步 GitHub。本機還沒推上去、只動到 data.enc 的 commit（例如上次推送失敗）先丟掉：這次會重建。"""
    if git("fetch", "origin").returncode:
        fail("無法連上 GitHub（網路或登入問題？），沒有發布。")
    ahead = git("log", "--format=%H", "origin/main..HEAD", quiet=True).stdout.split()
    if ahead:
        files = set(git("diff", "--name-only", "origin/main...HEAD", quiet=True).stdout.split())
        if files <= {DATA}:
            print(f"本機有 {len(ahead)} 個還沒推上去、只改 data.enc 的 commit，這次會重建，先捨棄。")
            git("reset", "--soft", "origin/main")
            git("checkout", "origin/main", "--", DATA)
    if git("pull", "--rebase", "--autostash").returncode:
        if (WEB / ".git" / "rebase-merge").exists() or (WEB / ".git" / "rebase-apply").exists():
            git("rebase", "--abort")
            fail("本機 commit 和 GitHub 上的版本衝突（不只 data.enc），已取消同步，沒有發布。請找維護的人處理 git 衝突。")
        fail("無法從 GitHub 取得最新版本（網路或登入問題？），沒有發布。")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    fetch = "--no-fetch" not in sys.argv
    step("[1/5] 取得 GitHub 上的最新版本")
    sync()
    before = content_digest(WEB / DATA)
    step("[2/5] 抓 NetSuite 資料（只查詢）" if fetch else "[2/5] 略過 NetSuite（--no-fetch）")
    if fetch and subprocess.run([sys.executable, str(WEB / "build" / "ns_export.py")], cwd=WEB).returncode:
        fail("NetSuite 取數失敗，請看上方訊息，沒有發布。")
    step("[3/5] 重建加密資料 docs/data.enc")
    if subprocess.run([sys.executable, str(WEB / "build" / "build_data.py")], cwd=WEB).returncode:
        fail("建置失敗，請看上方訊息，沒有發布。")
    step("[4/5] 建立 commit（docs/data.enc、build/ 對照表）")
    paths = []
    if before is not None and before == content_digest(WEB / DATA):
        git("checkout", "--", DATA)
        print("報表資料內容沒有變化。")
    else:
        paths.append(DATA)
    paths += [p for p in CONFIG_CSV if (WEB / p).exists()]
    if git("add", "--", *paths).returncode:
        fail("git add 失敗，沒有發布。")
    if git("diff", "--cached", "--quiet", "--", *paths).returncode == 0:
        print("\n資料與對照表都沒有變化，不需要發布。")
        return
    changed = git("-c", "core.quotepath=off", "diff", "--cached", "--name-only", "--", *paths, quiet=True).stdout.split()
    print("這次發布：" + "、".join(changed))
    if git("commit", "-m", "更新 sell-in 資料", "--", *paths).returncode:
        fail("git commit 失敗，請看上方訊息，沒有發布。")
    step("[5/5] 推送到 GitHub")
    if git("push").returncode:
        fail("推送到 GitHub 失敗（網路、登入或有人同時更新），報表還沒更新。排除問題後再執行一次即可。")
    print("\n完成，約 1 分鐘後 GitHub Pages 會更新。")


if __name__ == "__main__":
    main()
