/* Sell-in 網頁報表
 * data.enc：build/build_data.py 產生（gzip JSON → PBKDF2-SHA256 → AES-256-GCM）
 *   items    [品號, 品名, 產品代碼, 前三碼, 前六碼, 系列, 劑型, 存貨型態, 品牌, 主檔來源]
 *   channels [來源, 原通路別, 原通路名稱, 通路類別, 通路名稱, 有對上 NetSuite 名稱]
 *   single（未拆組）／combo（拆組）：[年月索引, 通路索引, 品項索引, flag(1 贈備品、2 領用), 銷貨數量, 銷退數量, 銷貨淨量, 銷貨淨額, 銷貨成本]
 *   依年月排序。2026/06 以前＝Power BI（舊 ERP），2026/07 起＝NetSuite（口徑同 405）。
 */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const PW_KEY = "sellin.pw";
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* 無痕或封鎖時略過 */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* 略過 */ } },
  };

  // ------------------------------------------------------------ 解密
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function decrypt(enc, password) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: b64(enc.salt), iterations: enc.iter },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const gz = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(enc.iv) }, key, b64(enc.ct));
    const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }
  let ENC = null;
  async function open(password) {
    if (!ENC) ENC = await (await fetch("data.enc", { cache: "no-cache" })).json();
    return decrypt(ENC, password);
  }

  // ------------------------------------------------------------ 格式
  const nf0 = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
  const fmtN = v => (v == null ? "" : nf0.format(Math.round(v) === 0 ? 0 : v));
  const fmtR = v => (v == null || !isFinite(v) ? "" : (v * 100).toFixed(1) + "%");
  const div = (a, b) => (b ? a / b : null);
  const ymLabel = ym => ym.slice(0, 4) + "/" + ym.slice(4);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const NONE = "(未分類)";
  const isUncat = label => /^[（(]?(未分類|無)[)）]?$/.test(String(label ?? "").trim());
  const uncatLast = arr => arr.filter(x => !isUncat(x?.label ?? x)).concat(arr.filter(x => isUncat(x?.label ?? x)));

  // ------------------------------------------------------------ 資料
  let D = null;
  const I = { CODE: 0, NAME: 1, SPEC: 2, P3: 3, P6: 4, SERIES: 5, DOSAGE: 6, INV: 7, BRAND: 8, SRC: 9 };
  const F = { YM: 0, CH: 1, IT: 2, FLAG: 3, SQ: 4, RQ: 5, NQ: 6, AMT: 7, COGS: 8 };
  const GIFT = 1, LOAN = 2;

  function prepare(d) {
    d.chCat = d.channels.map(c => c[3] || NONE);
    d.chName = d.channels.map(c => c[4] || NONE);
    const uniq = arr => uncatLast([...new Set(arr)].sort((a, b) => a.localeCompare(b, "zh-Hant")));
    d.allCats = uniq(d.chCat);
    d.allChNames = uniq(d.chName);
    d.years = [...new Set(d.yms.map(y => y.slice(0, 4)))];
    d.cutIx = d.yms.findIndex(y => y >= d.cutover);
    // 每個年月在事實表的列範圍（事實表依年月排序）
    const ranges = rows => {
      const r = d.yms.map(() => [0, 0]);
      let s = 0;
      for (let i = 1; i <= rows.length; i++) {
        if (i === rows.length || rows[i][0] !== rows[s][0]) { r[rows[s][0]] = [s, i]; s = i; }
      }
      return r;
    };
    d.rng = { single: ranges(d.single), combo: ranges(d.combo) };
    // 和 405 基準不一致的月份（舊版 data.enc 的欄位名稱是 nsMissingReturns）
    d.mismatch405 = new Set(d.source.ns405Mismatch || d.source.nsMissingReturns || []);
    return d;
  }

  const S = {
    tab: "ser", gift: false, loan: false,
    basis: { ser: "未拆組", dos: "未拆組", code: "未拆組", ch: "未拆組", mon: "未拆組" },   // 預設同 405 匯出（未拆組，組包歸「組合」）
    t: null,     // ①～④ 共用篩選：{ c0, c1 本期起迄, p0, p1 前期起迄, mode 前期取法, brand, cat:Set, ch:Set }（月份索引）
    m: null,     // ⑤：{ year, measure, dim }
    open: { ser: new Set(), dos: new Set(), code: new Set(), ch: new Set(), mon: new Set() },
  };
  const keep = flag => (S.gift || !(flag & GIFT)) && (S.loan || !(flag & LOAN));

  // ①～④ 的列維度（最後一層都是品號）
  const item = it => [it[I.CODE], it[I.NAME]];
  const TREES = {
    ser: { title: "By 系列別（可展開至品項）", head: ["系列別", "品號"], levels: (it) => [[it[I.SERIES] || NONE]] },
    dos: { title: "By 劑型分類（可展開至品項）", head: ["劑型分類", "品號"], levels: (it) => [[it[I.DOSAGE] || NONE]] },
    code: { title: "By 產品代碼前三碼（可展開至 產品代碼前六碼 → 品項）", head: ["前三碼", "前六碼", "品號"],
      levels: (it) => [[it[I.P3] || NONE], [it[I.P6] || NONE]] },
    ch: { title: "By 通路別（可展開至 通路名稱 → 品項）", head: ["通路別", "通路名稱", "品號"], levels: null },
  };

  // ------------------------------------------------------------ 共用元件
  function multiSelect(label, all, selected, onChange) {
    const el = document.createElement("div");
    el.className = "f";
    const sum = () => (selected.size === all.length ? "全部" : selected.size === 0 ? "（未選）" : [...selected].join("、"));
    el.innerHTML = `<span>${esc(label)}</span><details class="ms"><summary></summary><div class="ms-pop">
      <div class="ms-act"><button type="button" class="ghost sm" data-a="all">全選</button><button type="button" class="ghost sm" data-a="none">清除</button></div>
      ${all.map(v => `<label><input type="checkbox" value="${esc(v)}" ${selected.has(v) ? "checked" : ""}>${esc(v)}</label>`).join("")}
    </div></details>`;
    const summary = $("summary", el);
    summary.textContent = sum();
    el.addEventListener("change", e => {
      if (e.target.type !== "checkbox") return;
      e.target.checked ? selected.add(e.target.value) : selected.delete(e.target.value);
      summary.textContent = sum();
      onChange();
    });
    el.addEventListener("click", e => {
      const a = e.target.dataset?.a;
      if (!a) return;
      selected.clear();
      if (a === "all") all.forEach(v => selected.add(v));
      el.querySelectorAll("input[type=checkbox]").forEach(cb => (cb.checked = a === "all"));
      summary.textContent = sum();
      onChange();
    });
    return el;
  }
  function selectBox(label, options, value, onChange) {
    const el = document.createElement("label");
    el.className = "f";
    el.innerHTML = `<span>${esc(label)}</span><select>${options.map(([v, t]) =>
      `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
    $("select", el).addEventListener("change", e => onChange(e.target.value));
    return el;
  }
  function rangeBox(label, options, a, b, onChange) {
    const el = document.createElement("label");
    el.className = "f";
    const sel = v => `<select>${options.map(([o, t]) => `<option value="${esc(o)}" ${o === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
    el.innerHTML = `<span>${esc(label)}</span><div class="rng">${sel(a)}<i>～</i>${sel(b)}</div>`;
    const [s0, s1] = el.querySelectorAll("select");
    const fire = () => { const x = +s0.value, y = +s1.value; onChange(Math.min(x, y), Math.max(x, y)); };
    s0.addEventListener("change", fire);
    s1.addEventListener("change", fire);
    return el;
  }
  function seg(label, options, value, onChange) {
    const el = document.createElement("div");
    el.className = "f";
    el.innerHTML = `<span>${esc(label)}</span><div class="seg">${options.map(o =>
      `<button type="button" class="${o === value ? "on" : ""}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
    el.addEventListener("click", e => {
      const v = e.target.dataset?.v;
      if (v == null) return;
      el.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
      onChange(v);
    });
    return el;
  }

  // 樹狀表：node = { key, label, sub, v: [...], c: [...], kids: Map }
  function node(key, label, sub, n) { return { key, label, sub, v: new Array(n).fill(0), c: new Array(n).fill(0), kids: new Map() }; }
  function child(parent, key, label, sub, n) {
    let k = parent.kids.get(key);
    if (!k) { k = node(parent.key + "\u0001" + key, label, sub, n); parent.kids.set(key, k); }
    return k;
  }
  function treeRows(root, depth, openSet, sortKids, cells, maxDepth) {
    let html = "";
    for (const nd of uncatLast(sortKids([...root.kids.values()]))) {
      const hasKids = depth < maxDepth && nd.kids.size > 0;
      const isOpen = openSet.has(nd.key);
      html += `<tr class="lv${depth}"><td class="l ind${depth}${hasKids ? " tg" : ""}" ${hasKids ? `data-k="${esc(nd.key)}"` : ""}>` +
        `<span class="caret">${hasKids ? (isOpen ? "▾" : "▸") : ""}</span>${esc(nd.label)}${nd.sub ? `<span class="name">${esc(nd.sub)}</span>` : ""}</td>` +
        cells(nd) + "</tr>";
      if (hasKids && isOpen) html += treeRows(nd, depth + 1, openSet, sortKids, cells, maxDepth);
    }
    return html;
  }
  function allKeys(root, out = []) { for (const k of root.kids.values()) { out.push(k.key); allKeys(k, out); } return out; }

  // ------------------------------------------------------------ ①～④ 樹狀表（仿 NetSuite 405）
  // 值陣列 15 格：期間 k（0 前期、1 本期、2 本年累計）× [銷貨數量, 銷退數量, 銷貨淨量, 銷貨淨額, 銷貨成本]
  const NV = 15;
  let treeLast = null;

  function initTree() {
    const n = D.yms.length;
    // 本期預設＝最後一個完整月份（最新月份還在月中時用前一個月）
    const today = new Date(), thisYm = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}`;
    const cur = D.yms[n - 1] === thisYm && n > 1 ? n - 2 : n - 1;
    S.t = { c0: cur, c1: cur, mode: "上一期", brand: "全部", cat: new Set(D.allCats), ch: new Set(D.allChNames) };
    setPre();
    buildTreeFilters();
  }
  // 前期取法：上一期＝緊接在本期前、同樣長度的月份；去年同期＝本期往前 12 個月；自訂＝自己選
  function setPre() {
    const t = S.t, len = t.c1 - t.c0;
    if (t.mode === "上一期") {
      t.p1 = Math.max(0, t.c0 - 1); t.p0 = Math.max(0, t.p1 - len);
    } else if (t.mode === "去年同期") {
      const back = ym => { const i = D.yms.indexOf(String(+ym.slice(0, 4) - 1) + ym.slice(4)); return i < 0 ? 0 : i; };
      t.p0 = back(D.yms[t.c0]); t.p1 = Math.max(t.p0, back(D.yms[t.c1]));
    }
  }
  function buildTreeFilters() {
    const f = $("#treeFilters");
    f.innerHTML = "";
    const opts = D.yms.map((y, i) => [i, ymLabel(y) + (i >= D.cutIx ? "" : "（PBI）")]);
    f.append(
      seg("口徑", ["拆組", "未拆組"], S.basis[S.tab], v => { S.basis[S.tab] = v; renderTree(); }),
      rangeBox("本期（起～迄）", opts, S.t.c0, S.t.c1, (a, b) => { S.t.c0 = a; S.t.c1 = b; setPre(); buildTreeFilters(); renderTree(); }),
      seg("前期", ["上一期", "去年同期", "自訂"], S.t.mode, v => { S.t.mode = v; setPre(); buildTreeFilters(); renderTree(); }),
      rangeBox("前期（起～迄）", opts, S.t.p0, S.t.p1, (a, b) => { S.t.p0 = a; S.t.p1 = b; S.t.mode = "自訂"; buildTreeFilters(); renderTree(); }),
      seg("品牌", ["全部", "DR.WU", "Redermx"], S.t.brand, v => { S.t.brand = v; renderTree(); }),
      multiSelect("通路別", D.allCats, S.t.cat, renderTree),
      multiSelect("通路名稱", D.allChNames, S.t.ch, renderTree),
    );
  }

  function calcTree(tab) {
    const cfg = TREES[tab];
    const { p0, p1, c0, c1, brand, cat, ch } = S.t;
    const basis = S.basis[tab], kind = basis === "未拆組" ? "single" : "combo";
    const rows = D[kind], rng = D.rng[kind];
    const y = D.yms[c1].slice(0, 4);
    const ytd0 = D.yms.findIndex(v => v.startsWith(y));
    const root = node(tab, "", "", NV), tot = node("t", "", "", NV);
    const yms = new Set();
    for (const [a, b] of [[p0, p1], [c0, c1], [ytd0, c1]]) for (let i = a; i <= b; i++) yms.add(i);
    for (const ym of yms) {
      const hits = [ym >= p0 && ym <= p1, ym >= c0 && ym <= c1, ym >= ytd0 && ym <= c1];
      const [s, e] = rng[ym];
      for (let i = s; i < e; i++) {
        const r = rows[i];
        if (!keep(r[F.FLAG])) continue;
        const c = r[F.CH];
        if (!cat.has(D.chCat[c]) || !ch.has(D.chName[c])) continue;
        const it = D.items[r[F.IT]];
        if (brand !== "全部" && it[I.BRAND] !== brand) continue;
        const lv = cfg.levels ? cfg.levels(it) : [[D.chCat[c]], [D.chName[c]]];
        let nd = root;
        const path = [tot];
        for (const [label] of lv) { nd = child(nd, label, label, "", NV); path.push(nd); }
        const [code, name] = item(it);
        path.push(child(nd, code, code, name, NV));
        hits.forEach((h, k) => {
          if (!h) return;
          for (const p of path) {
            p.v[k * 5] += r[F.SQ]; p.v[k * 5 + 1] += r[F.RQ]; p.v[k * 5 + 2] += r[F.NQ];
            p.v[k * 5 + 3] += r[F.AMT]; p.v[k * 5 + 4] += r[F.COGS]; p.c[k] += 1;
          }
        });
      }
    }
    const calc = nd => {
      const g = k => (nd.c[k] > 0 ? { sq: nd.v[k * 5], rq: nd.v[k * 5 + 1], nq: nd.v[k * 5 + 2], a: nd.v[k * 5 + 3],
        cost: nd.v[k * 5 + 4], cr: div(nd.v[k * 5 + 4], nd.v[k * 5 + 3]) } : null);
      const p = g(0), c = g(1), t = g(2);
      return {
        p, c, t,
        pShare: p && div(p.a, tot.v[3]), cShare: c && div(c.a, tot.v[8]),
        diff: p || c ? (c?.a || 0) - (p?.a || 0) : null,
        growth: p && c && p.a ? c.a / p.a - 1 : null,
        dCr: p?.cr != null && c?.cr != null ? c.cr - p.cr : null,
      };
    };
    const sortKids = arr => arr.sort((a, b) => (b.v[8] - a.v[8]) || (b.v[3] - a.v[3]) || (b.v[13] - a.v[13]));
    const span = (a, b) => (a === b ? ymLabel(D.yms[a]) : `${ymLabel(D.yms[a])}～${ymLabel(D.yms[b])}`);
    const pl = span(p0, p1), cl = span(c0, c1), yl = span(ytd0, c1);
    const depth = (cfg.levels ? cfg.levels(D.items[0]).length : 2);
    return { tab, cfg, basis, root, tot, calc, sortKids, pl, cl, yl, depth, p0, p1, c0, c1 };
  }

  function renderTree() {
    const T = calcTree(S.tab);
    const { cfg, root, tot, calc, sortKids, pl, cl, yl, depth, basis, p0, p1, c0, c1 } = T;
    $("#treeTitle").textContent = cfg.title;
    const sign = (v, f) => (v == null ? "" : `<span class="${v > 0 ? "up" : v < 0 ? "down" : ""}">${v > 0 ? "+" : ""}${f(v)}</span>`);
    const pp = v => (v * 100).toFixed(1) + " pp";
    const per = (x, share, strong) => (x
      ? `<td class="sep">${fmtN(x.sq)}</td><td>${fmtN(x.rq)}</td><td>${fmtN(x.nq)}</td><td class="${strong ? "strong" : ""}">${fmtN(x.a)}</td>` +
        (share === undefined ? "" : `<td>${fmtR(share)}</td>`) + `<td>${fmtN(x.cost)}</td><td>${fmtR(x.cr)}</td>`
      : `<td class="sep"></td><td></td><td></td><td></td>${share === undefined ? "" : "<td></td>"}<td></td><td></td>`);
    const cells = nd => {
      const m = calc(nd);
      return per(m.p, m.pShare) + per(m.c, m.cShare, true) + per(m.t) +
        `<td class="sep">${sign(m.diff, fmtN)}</td><td>${sign(m.growth, fmtR)}</td><td>${sign(m.dCr, pp)}</td>`;
    };
    const sub7 = `<th class="sep">銷貨數量</th><th>銷退數量</th><th>銷貨淨量</th><th>銷貨淨額</th><th>占比</th><th>銷貨成本</th><th>成本率</th>`;
    const sub6 = `<th class="sep">銷貨數量</th><th>銷退數量</th><th>銷貨淨量</th><th>銷貨淨額</th><th>銷貨成本</th><th>成本率</th>`;
    const body = treeRows(root, 0, S.open[S.tab], sortKids, cells, depth);
    $("#treeTable").innerHTML = `<thead>
      <tr class="grp"><th class="l" rowspan="2">${esc(cfg.head.join(" / "))}</th><th colspan="7" class="sep">前期（${pl}）</th>
        <th colspan="7" class="sep">本期（${cl}）</th><th colspan="6" class="sep">本年累計（${yl}）</th><th colspan="3" class="sep">變化（本期 vs 前期）</th></tr>
      <tr>${sub7}${sub7}${sub6}<th class="sep">Sell-in 差異</th><th>成長率</th><th>成本率增減</th></tr></thead>
      <tbody>${body || `<tr><td colspan="24" class="empty">沒有符合條件的資料</td></tr>`}</tbody>
      <tfoot><tr class="total"><td class="l">總計</td>${cells(tot)}</tr></tfoot>`;

    const btns = depth === 2
      ? `<button class="ghost sm" data-collapse="1">只看第一層</button><button class="ghost sm" data-expand="2">展開到第二層</button><button class="ghost sm" data-expand="all">全部展開</button>`
      : `<button class="ghost sm" data-collapse="1">只看第一層</button><button class="ghost sm" data-expand="all">全部展開</button>`;
    $("#treeBtns").innerHTML = btns;

    const t = calc(tot);
    const kpi = (k, v, d) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v || "—"}</div><div class="d">${d}</div></div>`;
    const src = (a, b) => (a >= D.cutIx ? "NetSuite" : b < D.cutIx ? "Power BI" : "Power BI＋NetSuite");
    $("#treeKpis").innerHTML =
      kpi(`本期銷貨淨額（${cl}）`, t.c && fmtN(t.c.a), t.growth != null ? `${sign(t.growth, fmtR)} <span class="muted">vs 前期 ${pl}</span>` : `<span class="muted">前期無資料</span>`) +
      kpi(`本期成本率（${cl}）`, t.c && fmtR(t.c.cr), t.dCr != null ? `${sign(t.dCr, pp)} <span class="muted">vs 前期</span>` : "") +
      kpi(`本年累計銷貨淨額`, t.t && fmtN(t.t.a), `<span class="muted">${yl}</span>`) +
      kpi(`本年累計成本率`, t.t && fmtR(t.t.cr), `<span class="muted">${basis}・${S.gift ? "含" : "不含"}贈備品・${S.loan ? "含" : "不含"}領用</span>`);
    const miss = D.yms.filter((y, i) => ((i >= p0 && i <= p1) || (i >= c0 && i <= c1)) && D.mismatch405.has(y));
    $("#treeNote").innerHTML =
      (miss.length ? `<b class="down">⚠ ${miss.map(ymLabel).join("、")} 的 NetSuite 資料和 405 對不上（API 權限或月結還在動），請看資料檢核。</b><br>` : "") +
      (p1 - p0 !== c1 - c0 ? `<b>注意：前期 ${p1 - p0 + 1} 個月、本期 ${c1 - c0 + 1} 個月，長度不同，成長率請斟酌。</b><br>` : "") +
      `資料來源：前期 ${src(p0, p1)}、本期 ${src(c0, c1)}（2026/06 以前＝Power BI 舊 ERP，2026/07 起＝NetSuite，口徑同報表 405）。` +
      `占比＝占所選範圍該期總淨額；成本率＝銷貨成本 ÷ 銷貨淨額；本期、前期可選多個月份（起～迄）；本年累計＝本期迄月所在年度 1 月至迄月；Sell-in 差異、成長率、成本率增減為本期 vs 前期。各層依本期淨額由大到小排序。` +
      (basis === "拆組" ? "拆組：組包依 BOM 拆成成分，金額、成本依建議售價 × 用量分攤。" : "");
    treeLast = T;
  }

  // ------------------------------------------------------------ ⑤ 系列別 by 月
  const MEASURES = { 銷貨淨額: F.AMT, 銷貨淨量: F.NQ, 銷貨成本: F.COGS, 銷貨數量: F.SQ };
  const DIMS = { 系列別: it => it[I.SERIES] || NONE, 劑型分類: it => it[I.DOSAGE] || NONE, 通路別: null };
  let monLast = null;
  function initMon() {
    S.m = { year: D.years[D.years.length - 1], measure: "銷貨淨額", dim: "系列別" };
    const f = $("#monFilters");
    f.innerHTML = "";
    f.append(
      selectBox("年度", D.years.slice().reverse().map(y => [y, y]), S.m.year, v => { S.m.year = v; renderMon(); }),
      seg("口徑", ["拆組", "未拆組"], S.basis.mon, v => { S.basis.mon = v; renderMon(); }),
      seg("數值", Object.keys(MEASURES), S.m.measure, v => { S.m.measure = v; renderMon(); }),
      seg("列", Object.keys(DIMS), S.m.dim, v => { S.m.dim = v; S.open.mon.clear(); renderMon(); }),
    );
  }
  function renderMon() {
    const { year, measure, dim } = S.m;
    const kind = S.basis.mon === "未拆組" ? "single" : "combo";
    const rows = D[kind], rng = D.rng[kind], col = MEASURES[measure];
    const months = D.yms.map((y, i) => [y, i]).filter(([y]) => y.startsWith(year));
    const n = months.length + 1;
    const root = node("mon", "", "", n), tot = node("t", "", "", n);
    months.forEach(([, ym], j) => {
      const [s, e] = rng[ym];
      for (let i = s; i < e; i++) {
        const r = rows[i];
        if (!keep(r[F.FLAG])) continue;
        const it = D.items[r[F.IT]];
        const g = DIMS[dim] ? DIMS[dim](it) : D.chCat[r[F.CH]];
        const n1 = child(root, g, g, "", n), n2 = child(n1, it[I.CODE], it[I.CODE], it[I.NAME], n);
        for (const p of [n1, n2, tot]) { p.v[j] += r[col]; p.v[n - 1] += r[col]; p.c[j] += 1; }
      }
    });
    const cells = nd => nd.v.map((v, j) => `<td class="${j === n - 1 ? "sep strong" : ""}">${j < n - 1 && !nd.c[j] ? "" : fmtN(v)}</td>`).join("");
    const sortKids = arr => arr.sort((a, b) => b.v[n - 1] - a.v[n - 1]);
    $("#monTitle").textContent = `${dim} × 銷貨年月（${measure}・${S.basis.mon}・${year}）`;
    $("#monTable").innerHTML = `<thead><tr><th class="l">${dim} / 品號</th>${months.map(([y]) =>
      `<th>${ymLabel(y)}</th>`).join("")}<th class="sep">合計</th></tr></thead>
      <tbody>${treeRows(root, 0, S.open.mon, sortKids, cells, 1) || `<tr><td colspan="${n + 1}" class="empty">沒有資料</td></tr>`}</tbody>
      <tfoot><tr class="total"><td class="l">總計</td>${cells(tot)}</tr></tfoot>`;
    monLast = { root, tot, months, sortKids, n };
  }

  // ------------------------------------------------------------ 資料檢核
  function sumBy(kind, keyFn) {
    const m = new Map();
    for (const r of D[kind]) {
      if (!keep(r[F.FLAG])) continue;
      const k = keyFn(r);
      let v = m.get(k);
      if (!v) m.set(k, (v = [0, 0, 0, 0, 0]));
      for (let j = 0; j < 5; j++) v[j] += r[F.SQ + j];
    }
    return m;
  }
  function renderChk() {
    // 405 對帳（固定排除贈備品、領用、未拆組，與 405 預設相同）
    // v：[銷貨數量, 銷退數量, 銷貨淨量, 銷貨淨額, 銷貨成本, 拆組後淨量]
    const t405 = new Map();
    const acc = y => { let v = t405.get(y); if (!v) t405.set(y, (v = [0, 0, 0, 0, 0, 0])); return v; };
    for (const r of D.single) {
      const y = D.yms[r[F.YM]];
      if (r[F.FLAG] || !D.expect405[y]) continue;
      const v = acc(y);
      for (let j = 0; j < 5; j++) v[j] += r[F.SQ + j];
    }
    for (const r of D.combo) {
      const y = D.yms[r[F.YM]];
      if (r[F.FLAG] || !D.expect405[y]) continue;
      acc(y)[5] += r[F.NQ];
    }
    const K = [["銷貨淨額", "amt", 3], ["銷貨成本", "cogs", 4], ["銷貨數量", "sq", 0], ["銷退數量", "rq", 1], ["銷貨淨量", "nq", 2],
      ["拆組後淨量", "xnq", 5]].filter(([, k]) => Object.values(D.expect405).some(e => k in e));
    let bad405 = 0, html = `<thead><tr><th class="l">年月</th>${K.map(([k]) => `<th class="sep">${k}</th><th>405</th><th>差異</th>`).join("")}</tr></thead><tbody>`;
    for (const [y, e] of Object.entries(D.expect405)) {
      const v = t405.get(y);
      if (!v) continue;
      html += `<tr><td class="l">${ymLabel(y)}</td>` + K.map(([, k, j]) => {
        const d = v[j] - e[k], hi = Math.abs(d) > 1;
        if (hi) bad405++;
        return `<td class="sep">${fmtN(v[j])}</td><td>${fmtN(e[k])}</td><td class="${hi ? "hi" : ""}">${fmtN(d)}</td>`;
      }).join("") + "</tr>";
    }
    $("#chk405").innerHTML = html + "</tbody>";

    // 各月合計
    const s = sumBy("single", r => r[F.YM]), c = sumBy("combo", r => r[F.YM]);
    let mh = `<thead><tr><th class="l">年月</th><th>來源</th><th class="sep">未拆組淨額</th><th>拆組淨額</th><th>拆組差額</th>
      <th class="sep">銷貨數量</th><th>銷退數量</th><th>銷貨淨量</th><th class="sep">銷貨成本</th><th>成本率</th></tr></thead><tbody>`;
    let badSplit = 0;
    for (let i = D.yms.length - 1; i >= 0; i--) {
      const a = s.get(i) || [0, 0, 0, 0, 0], b = c.get(i) || [0, 0, 0, 0, 0], d = b[3] - a[3];
      const hi = Math.abs(d) > Math.max(1000, Math.abs(a[3]) * 0.001);
      if (hi) badSplit++;
      const miss = D.mismatch405.has(D.yms[i]);
      mh += `<tr><td class="l">${ymLabel(D.yms[i])}</td><td>${i >= D.cutIx ? "NetSuite" : "Power BI"}</td><td class="sep">${fmtN(a[3])}</td><td>${fmtN(b[3])}</td>` +
        `<td class="${hi ? "hi" : ""}">${fmtN(d)}</td><td class="sep">${fmtN(a[0])}</td><td class="${miss ? "hi" : ""}"${miss ? ' title="這個月和 405 對不上，請看上方 405 對帳"' : ""}>${fmtN(a[1])}</td>` +
        `<td>${fmtN(a[2])}</td><td class="sep">${fmtN(a[4])}</td><td>${fmtR(div(a[4], a[3]))}</td></tr>`;
    }
    $("#chkMonths").innerHTML = mh + "</tbody>";

    // 通路對照
    const chAmt = sumBy("single", r => r[F.CH]);
    const lastYm = new Map();
    for (const r of D.single) lastYm.set(r[F.CH], r[F.YM]);
    const chs = D.channels.map((ch, i) => ({ ch, i, a: (chAmt.get(i) || [0, 0, 0, 0])[3] }))
      .sort((x, y) => (x.ch[5] - y.ch[5]) || x.ch[0].localeCompare(y.ch[0]) || (y.a - x.a));
    $("#chkCh").innerHTML = `<thead><tr><th class="l">來源</th><th class="l">原通路別</th><th class="l">原通路名稱</th><th class="l sep">→ 通路別</th><th class="l">→ 通路名稱</th>
      <th class="sep">淨額（全期間）</th><th>最後月份</th></tr></thead><tbody>` +
      chs.map(({ ch, i, a }) => `<tr><td class="l">${ch[0] === "NS" ? "NetSuite" : "Power BI"}</td><td class="l">${esc(ch[1])}</td><td class="l">${esc(ch[2])}</td>` +
        `<td class="l sep">${esc(ch[3])}</td><td class="l ${ch[5] ? "" : "hi"}"${ch[5] ? "" : ' title="NetSuite 沒有這個通路名稱（只有舊資料才有，或通路對照漏了）"'}>${esc(ch[4])}</td>` +
        `<td class="sep">${fmtN(a)}</td><td>${lastYm.has(i) ? ymLabel(D.yms[lastYm.get(i)]) : ""}</td></tr>`).join("") + "</tbody>";

    // 品項缺分類（有銷售、缺系列或劑型）
    const itAmt = sumBy("combo", r => r[F.IT]);
    const miss = [...itAmt].map(([i, v]) => ({ it: D.items[i], a: v[3] }))
      .filter(x => Math.abs(x.a) >= 1 && (!x.it[I.SERIES] || !x.it[I.DOSAGE]))
      .sort((x, y) => Math.abs(y.a) - Math.abs(x.a));
    $("#chkItems").innerHTML = `<thead><tr><th class="l">品號</th><th class="l">品名</th><th class="l">產品代碼</th><th class="l">缺</th><th class="l">主檔</th><th class="sep">淨額（拆組・全期間）</th></tr></thead><tbody>` +
      (miss.map(({ it, a }) => `<tr><td class="l">${esc(it[I.CODE])}</td><td class="l">${esc(it[I.NAME])}</td><td class="l">${esc(it[I.SPEC])}</td>` +
        `<td class="l">${[!it[I.SERIES] && "系列", !it[I.DOSAGE] && "劑型"].filter(Boolean).join("、")}</td><td class="l">${it[I.SRC] === "NS" ? "NetSuite" : it[I.SRC] === "PBI" ? "Power BI" : "找不到"}</td>` +
        `<td class="sep">${fmtN(a)}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">沒有</td></tr>`) + "</tbody>";

    const kpi = (k, v, d, bad) => `<div class="kpi"><div class="k">${k}</div><div class="v ${bad ? "down" : ""}">${v}</div><div class="d muted">${d}</div></div>`;
    $("#chkKpis").innerHTML =
      kpi("資料期間", `${ymLabel(D.yms[0])}–${ymLabel(D.yms[D.yms.length - 1])}`, `NetSuite 自 ${ymLabel(D.cutover)} 起`) +
      kpi("405 對帳", bad405 ? `${bad405} 格不一致` : "一致", bad405 ? "先跑 sellin_export.py --probe 確認 API 權限" : "NetSuite 月份與 405 相同（含拆組後淨量）", bad405) +
      kpi("拆組前後淨額差", badSplit ? `${badSplit} 個月` : "無", "差額超過 0.1% 的月份", badSplit) +
      kpi("缺分類品項", String(miss.length), "有銷售但缺系列或劑型", miss.length > 0);
  }

  // ------------------------------------------------------------ 匯出 Excel
  const NUM = "#,##0", PCT = "0.0%";
  const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; };
  const setLbl = (set, all) => (set.size === all.length ? "全部" : [...set].join("、"));
  const flagCond = () => [["贈備品", S.gift ? "含" : "不含"], ["領用", S.loan ? "含" : "不含"]];
  const condRows = pairs => [...pairs, ...flagCond(), ["資料更新", D.generated],
    ["來源", `${D.source.pbi}（～${ymLabel(D.yms[D.cutIx - 1] || D.yms[0])}）＋ ${D.source.ns}（${ymLabel(D.cutover)}～）`],
    ["匯出時間", new Date().toLocaleString("zh-TW")]];
  const condSheet = pairs => ({ name: "篩選條件", cols: [14, 100], head: 1, aoa: [["項目", "設定"], ...condRows(pairs)] });
  function flatten(root, depth, sortKids, out = [], lv = 0) {
    for (const nd of uncatLast(sortKids([...root.kids.values()]))) {
      out.push({ nd, lv });
      if (lv < depth) flatten(nd, depth, sortKids, out, lv + 1);
    }
    return out;
  }
  const labelRow = (n, lv, label) => Array.from({ length: n }, (_, i) => (i === lv ? label : ""));

  const TAB_NAMES = { ser: "①系列別", dos: "②劑型分類", code: "③產品代碼", ch: "④通路別", mon: "⑤系列別by月", chk: "資料檢核" };
  function buildTree(tab) {
    const T = tab === treeLast?.tab ? treeLast : calcTree(tab);
    const { cfg, root, tot, calc, sortKids, pl, cl, yl, depth, basis } = T;
    const x = v => (v == null ? "" : v);
    const per = (p, share) => (p ? [p.sq, p.rq, p.nq, p.a, ...(share === undefined ? [] : [x(share)]), p.cost, x(p.cr)]
      : new Array(share === undefined ? 6 : 7).fill(""));
    const vals = nd => { const m = calc(nd); return [...per(m.p, m.pShare), ...per(m.c, m.cShare), ...per(m.t), x(m.diff), x(m.growth), x(m.dCr)]; };
    const flat = flatten(root, depth, sortKids);
    const nl = cfg.head.length;   // 標籤欄數（最後一欄品號）＋品名
    const lead = nl + 1;
    const h7 = ["銷貨數量", "銷退數量", "銷貨淨量", "銷貨淨額", "占比", "銷貨成本", "成本率"];
    const h6 = ["銷貨數量", "銷退數量", "銷貨淨量", "銷貨淨額", "銷貨成本", "成本率"];
    const top = [...new Array(lead).fill(""), `前期（${pl}）`, ...new Array(6).fill(""), `本期（${cl}）`, ...new Array(6).fill(""),
      `本年累計（${yl}）`, ...new Array(5).fill(""), "變化（本期 vs 前期）", "", ""];
    const aoa = [top, [...cfg.head, "品名", ...h7, ...h7, ...h6, "Sell-in 差異", "成長率", "成本率增減"],
      ...flat.map(({ nd, lv }) => [...labelRow(nl, lv, nd.label), lv === depth ? nd.sub : "", ...vals(nd)]),
      ["總計", ...new Array(nl).fill(""), ...vals(tot)]];
    const pctCols = new Set([4, 6, 11, 13, 19, 21].map(c => c + lead));
    const s = lead + 1;
    return {
      file: `SellIn_${TAB_NAMES[tab].slice(1)}_${cl.replaceAll("/", "").replace("～", "-")}_${basis}_${stamp()}.xlsx`,
      sheets: [{ name: TAB_NAMES[tab], aoa, head: 2, total: true, freeze: 2, freezeCols: nl,
        levels: [null, null, ...flat.map(f => f.lv), null],
        merges: [[1, s, 1, s + 6], [1, s + 7, 1, s + 13], [1, s + 14, 1, s + 19], [1, s + 20, 1, s + 22]],
        fmt: (r, c) => (r < 2 ? null : pctCols.has(c) ? PCT : c === lead + 22 ? "+0.0%;-0.0%" : NUM),
        cols: [...new Array(nl).fill(14), 36, ...new Array(23).fill(11)] }],
      cond: [["口徑", basis], ["前期", pl + (S.t.mode === "自訂" ? "" : `（${S.t.mode}）`)], ["本期", cl], ["本年累計", yl], ["品牌", S.t.brand],
        ["通路別", setLbl(S.t.cat, D.allCats)], ["通路名稱", setLbl(S.t.ch, D.allChNames)]],
    };
  }
  function buildMon() {
    if (!monLast) renderMon();
    const { root, tot, months, sortKids, n } = monLast;
    const flat = flatten(root, 1, sortKids);
    const vals = nd => nd.v.map((v, j) => (j < n - 1 && !nd.c[j] ? "" : v));
    const aoa = [[S.m.dim, "品號", "品名", ...months.map(([y]) => ymLabel(y)), "合計"],
      ...flat.map(({ nd, lv }) => [...labelRow(2, lv, nd.label), lv === 1 ? nd.sub : "", ...vals(nd)]),
      ["總計", "", "", ...vals(tot)]];
    return {
      file: `SellIn_${S.m.dim}by月_${S.m.year}_${S.m.measure}_${stamp()}.xlsx`,
      sheets: [{ name: TAB_NAMES.mon, aoa, head: 1, total: true, freeze: 1, freezeCols: 1, levels: [null, ...flat.map(f => f.lv), null],
        fmt: r => (r < 1 ? null : NUM), cols: [16, 14, 36, ...new Array(n).fill(12)] }],
      cond: [["年度", S.m.year], ["口徑", S.basis.mon], ["數值", S.m.measure], ["列", S.m.dim]],
    };
  }
  function buildChk() {
    const tbl = id => [...document.querySelectorAll(`${id} tr`)].map(tr => [...tr.cells].map(td => {
      const t = td.textContent.trim(), n = t.replace(/,/g, "");
      return /^-?\d+(\.\d+)?$/.test(n) ? +n : /^-?\d+(\.\d+)?%$/.test(n) ? +n.slice(0, -1) / 100 : t;
    }));
    const sh = (name, id) => ({ name, aoa: tbl(id), head: 1, freeze: 1, autoFilter: true,
      fmt: (r, c, v) => (r < 1 ? null : Math.abs(v) < 1 && v % 1 ? PCT : NUM), cols: new Array(16).fill(13) });
    return { file: `SellIn_資料檢核_${stamp()}.xlsx`, cond: [],
      sheets: [sh("405對帳", "#chk405"), sh("各月合計", "#chkMonths"), sh("通路對照", "#chkCh"), sh("品項缺分類", "#chkItems")] };
  }
  const BUILDERS = { ser: () => buildTree("ser"), dos: () => buildTree("dos"), code: () => buildTree("code"), ch: () => buildTree("ch"),
    mon: buildMon, chk: buildChk };

  async function withBusy(btn, fn) {
    const t = btn.textContent;
    btn.disabled = true; btn.textContent = "產生 Excel 中…";
    try { await fn(); }
    catch (err) { console.error(err); alert("Excel 產生失敗：" + err.message); }
    finally { btn.disabled = false; btn.textContent = t; }
  }
  function exportCurrent(e) {
    return withBusy(e.currentTarget, async () => {
      const b = BUILDERS[S.tab]();
      await XL.downloadXlsx(b.file, b.cond.length ? [...b.sheets, condSheet(b.cond)] : [...b.sheets, condSheet([])]);
    });
  }
  function exportAll(e) {
    return withBusy(e.currentTarget, async () => {
      const parts = ["ser", "dos", "code", "ch", "mon", "chk"].map(k => [TAB_NAMES[k], BUILDERS[k]()]);
      const cond = [["項目", "設定"]];
      for (const [title, b] of parts) {
        if (!b.cond.length) continue;
        cond.push([title, ""], ...b.cond.map(([k, v]) => ["　" + k, v]));
      }
      cond.push(["共通", ""], ...condRows([]).map(([k, v]) => ["　" + k, v]));
      const sheets = [{ name: "篩選條件", cols: [16, 100], head: 1, aoa: cond, boldRows: new Set(cond.map((r, i) => (r[1] === "" && i ? i : -1))) },
        ...parts.flatMap(([, b]) => b.sheets)];
      await XL.downloadXlsx(`SellIn_全部報表_${S.t.c0 === S.t.c1 ? D.yms[S.t.c1] : D.yms[S.t.c0] + "-" + D.yms[S.t.c1]}_${stamp()}.xlsx`, sheets);
    });
  }

  // ------------------------------------------------------------ 互動
  function showTab(tab) {
    S.tab = tab;
    document.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("active", x.dataset.tab === tab));
    const isTree = !!TREES[tab];
    $("#tree").hidden = !isTree;
    $("#mon").hidden = tab !== "mon";
    $("#chk").hidden = tab !== "chk";
    if (isTree) { buildTreeFilters(); renderTree(); }
  }
  function renderAll() {
    if (TREES[S.tab]) renderTree();
    renderMon();
    renderChk();
  }

  function bindApp() {
    document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
    $("#incGift").addEventListener("change", e => { S.gift = e.target.checked; renderAll(); });
    $("#incLoan").addEventListener("change", e => { S.loan = e.target.checked; renderAll(); });
    $("#xlsx").addEventListener("click", exportCurrent);
    $("#xlsxAll").addEventListener("click", exportAll);
    $("#logout").addEventListener("click", () => { store.del(PW_KEY); location.reload(); });
    document.addEventListener("click", e => {
      const td = e.target.closest("td.tg");
      if (td) {
        const which = td.closest("main").id === "mon" ? "mon" : S.tab;
        const set = S.open[which];
        set.has(td.dataset.k) ? set.delete(td.dataset.k) : set.add(td.dataset.k);
        which === "mon" ? renderMon() : renderTree();
        return;
      }
      const ex = e.target.dataset?.expand, co = e.target.dataset?.collapse;
      if (e.target.closest("#mon")) {
        if (ex) { allKeys(monLast.root).forEach(k => S.open.mon.add(k)); renderMon(); }
        if (co) { S.open.mon.clear(); renderMon(); }
      } else if (ex || co) {
        const set = S.open[S.tab];
        set.clear();
        if (ex === "all") allKeys(treeLast.root).forEach(k => set.add(k));
        if (ex === "2") for (const n1 of treeLast.root.kids.values()) set.add(n1.key);
        renderTree();
      }
      document.querySelectorAll("details.ms[open]").forEach(d => { if (!d.contains(e.target)) d.open = false; });
    });
  }

  function load(raw) {
    D = prepare(raw);
    $("#meta").textContent = `資料期間 ${ymLabel(D.yms[0])}–${ymLabel(D.yms[D.yms.length - 1])}・更新 ${D.generated}・` +
      `Power BI（～${ymLabel(D.yms[D.cutIx - 1] || D.yms[0])}）＋ NetSuite（${ymLabel(D.cutover)}～）`;
    initTree(); initMon();
    showTab("ser");
    renderMon(); renderChk();
  }

  async function start(password, remember) {
    const raw = await open(password);
    if (remember) store.set(PW_KEY, password);
    $("#login").hidden = true;
    $("#app").hidden = false;
    bindApp();
    load(raw);
  }

  $("#loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    const btn = $("#loginBtn"), msg = $("#loginMsg");
    btn.disabled = true; msg.textContent = ""; btn.textContent = "解密中…";
    try {
      await start($("#pw").value, $("#remember").checked);
    } catch (err) {
      console.error(err);
      msg.textContent = err instanceof DOMException || err.name === "OperationError" ? "密碼不正確" : "無法載入資料：" + err.message;
    } finally {
      btn.disabled = false; btn.textContent = "開啟報表";
    }
  });

  const saved = store.get(PW_KEY);
  if (saved) start(saved, true).catch(() => store.del(PW_KEY));
})();
