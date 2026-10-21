"""設定（GitHub Actions 用）：NetSuite 金鑰只從環境變數讀（GitHub Secrets），不讀 config.yaml／.env。
介面同 NS匯入程式 core/config.py 的 load_config()，ns_export.py／sellin_export.py 不用改。
"""
import os
import sys

KEYS = {"account_id": "NS_ACCOUNT_ID", "consumer_key": "NS_CONSUMER_KEY", "consumer_secret": "NS_CONSUMER_SECRET",
        "token_id": "NS_TOKEN_ID", "token_secret": "NS_TOKEN_SECRET"}


def load_config(path=None) -> dict:
    missing = [env for env in KEYS.values() if not os.environ.get(env, "").strip()]
    if missing:
        sys.exit("[錯誤] 缺少 NetSuite 金鑰（GitHub repo → Settings → Secrets and variables → Actions）：" + "、".join(missing))
    ns = {key: os.environ[env].strip() for key, env in KEYS.items()}
    ns["dry_run"] = True
    return {"netsuite": ns, "_env": "prod", "_base_dir": os.path.dirname(os.path.dirname(os.path.abspath(__file__)))}
