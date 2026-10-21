# -*- coding: utf-8 -*-
"""NetSuite REST 客戶端（唯讀精簡版）— OAuth 1.0 (TBA) HMAC-SHA256 簽章。

從 NS匯入程式 core/netsuite.py 複製，只留簽章與 SuiteQL 查詢（給 GitHub Actions 上的 ns_export.py 用），
沒有 record／RESTlet 等寫入方法。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
import urllib.parse

import requests


def _pct(s: str) -> str:
    return urllib.parse.quote(str(s), safe="~-._")


class NetSuiteClient:
    def __init__(self, cfg: dict):
        ns = cfg["netsuite"]
        self.account = ns["account_id"]
        self.ck = ns["consumer_key"]
        self.cs = ns["consumer_secret"]
        self.tk = ns["token_id"]
        self.ts_ = ns["token_secret"]
        self.dry_run = bool(ns.get("dry_run", True))

    @property
    def rest_host(self) -> str:
        return self.account.lower().replace("_", "-")

    def _auth_header(self, method: str, url: str) -> str:
        base_url, _, query = url.partition("?")
        oauth = {
            "oauth_consumer_key": self.ck,
            "oauth_token": self.tk,
            "oauth_signature_method": "HMAC-SHA256",
            "oauth_timestamp": str(int(time.time())),
            "oauth_nonce": secrets.token_hex(16),
            "oauth_version": "1.0",
        }
        # 簽章參數 = oauth 參數 + URL query 參數
        params = dict(urllib.parse.parse_qsl(query, keep_blank_values=True))
        params.update(oauth)
        norm = "&".join(
            f"{k}={v}"
            for k, v in sorted((_pct(k), _pct(v)) for k, v in params.items())
        )
        # 注意:上面已先 percent-encode 再排序,符合 RFC 5849
        base_string = "&".join([method.upper(), _pct(base_url), _pct(norm)])
        key = f"{_pct(self.cs)}&{_pct(self.ts_)}".encode()
        sig = base64.b64encode(
            hmac.new(key, base_string.encode(), hashlib.sha256).digest()
        ).decode()
        oauth["oauth_signature"] = sig
        header = ", ".join(f'{k}="{_pct(v)}"' for k, v in sorted(oauth.items()))
        return f'OAuth realm="{self.account}", {header}'

    def suiteql(self, query: str, limit: int = 1000) -> tuple:
        """執行 SuiteQL 查詢,自動翻頁。回傳 (是否成功, 列list, 錯誤訊息)。"""
        url = (f"https://{self.rest_host}.suitetalk.api.netsuite.com"
               f"/services/rest/query/v1/suiteql?limit={min(limit, 1000)}")
        out: list = []
        body = json.dumps({"q": query})
        try:
            while url:
                r = requests.post(
                    url, data=body.encode("utf-8"),
                    headers={
                        "Authorization": self._auth_header("POST", url),
                        "Content-Type": "application/json",
                        "Prefer": "transient",
                    },
                    timeout=120,
                )
                if r.status_code != 200:
                    return False, out, f"HTTP {r.status_code}\n{r.text[:1000]}"
                j = r.json()
                out.extend(j.get("items", []))
                nxt = [l.get("href") for l in j.get("links", []) if l.get("rel") == "next"]
                url = nxt[0] if (j.get("hasMore") and nxt) else None
                if len(out) >= limit:
                    break
            return True, out[:limit], ""
        except requests.RequestException as e:
            return False, out, f"連線失敗:{e}"
