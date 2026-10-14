/* Sell-in 網頁報表：有格式的 Excel 匯出（沿用 Sell-out 報表的 ExcelJS 版面；載入失敗退回 SheetJS 無格式版本） */
window.XL = (() => {
  "use strict";
  // ------------------------------------------------------------ Excel
  // 有格式的 Excel（ExcelJS，按下載時才載入；載入失敗退回 SheetJS 無格式版本）
  // sheets: [{ name, aoa, fmt(r,c,v)→格式字串, cols:[寬度], head:標題列數, freeze:凍結列數, freezeCols:凍結欄數,
  //            levels:[每列大綱層級|null], total:最後一列是總計, hi:Set("列,欄") 標黃, merges:[[r1,c1,r2,c2]], autoFilter, boldRows:Set(列) }]
  const EXCELJS = { src: "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js",
    sri: "sha512-dlPw+ytv/6JyepmelABrgeYgHI0O+frEwgfnPdXDTOIZz+eDgfW07QXG02/O8COfivBdGNINy+Vex+lYmJ5rxw==" };
  let excelJsLoading = null;
  function loadExcelJS() {
    if (window.ExcelJS) return Promise.resolve(true);
    excelJsLoading ||= new Promise(resolve => {
      const s = document.createElement("script");
      s.src = EXCELJS.src; s.integrity = EXCELJS.sri; s.crossOrigin = "anonymous"; s.referrerPolicy = "no-referrer";
      s.onload = () => resolve(!!window.ExcelJS);
      s.onerror = () => { excelJsLoading = null; resolve(false); };
      document.head.appendChild(s);
    });
    return excelJsLoading;
  }

  const C = { headFill: "FFDCE6F2", headFont: "FF1F2937", lv0Fill: "FFEEF3FA", totalFill: "FFE5E7EB", hiFill: "FFFFF2CC", border: "FFC9D1DC" };
  const fill = argb => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

  async function downloadXlsx(filename, sheets) {
    if (!(await loadExcelJS())) return downloadXlsxBasic(filename, sheets);
    const wb = new ExcelJS.Workbook();
    wb.creator = "Sell-in 報表";
    wb.created = new Date();
    const used = new Set();
    for (const s of sheets) {
      let name = s.name.replace(/[\\/*?:[\]]/g, "_").slice(0, 31);
      for (let i = 2; used.has(name); i++) name = `${s.name.slice(0, 28)}_${i}`;
      used.add(name);
      const ws = wb.addWorksheet(name, {
        views: [{ state: "frozen", ySplit: s.freeze || 0, xSplit: s.freezeCols || 0 }],
        properties: { outlineProperties: { summaryBelow: false, summaryRight: false } },
      });
      // 用 reduce（不用 Math.max(...陣列)），列數很多時也不會超過函式參數上限
      const head = s.head ?? 0, nCols = s.aoa.reduce((m, r) => Math.max(m, r.length), 0), last = s.aoa.length - 1;
      const maxLv = (s.levels || []).reduce((m, v) => (v != null && v > m ? v : m), -1);
      s.aoa.forEach((row, r) => {
        const xr = ws.addRow(row.map(v => (v === "" ? null : v)));
        row.forEach((v, c) => {
          if (typeof v !== "number" || !s.fmt) return;
          const z = s.fmt(r, c, v);
          if (z) xr.getCell(c + 1).numFmt = z;
        });
        const lv = s.levels?.[r];
        const isHead = r < head, isTotal = s.total && r === last;
        if (lv != null && lv > 0) xr.outlineLevel = lv;
        if (isHead || isTotal || (lv != null && lv < maxLv) || s.boldRows?.has(r)) xr.font = { bold: true, color: isHead ? { argb: C.headFont } : undefined };
        for (let c = 1; c <= nCols; c++) {
          const cell = xr.getCell(c);
          if (isHead) {
            cell.fill = fill(C.headFill);
            cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
            cell.border = { bottom: { style: "thin", color: { argb: C.border } } };
          } else if (isTotal) {
            cell.fill = fill(C.totalFill);
            cell.border = { top: { style: "thin", color: { argb: "FF6B7280" } } };
          } else if (lv === 0 && maxLv > 0) {
            cell.fill = fill(C.lv0Fill);
          }
          if (s.hi?.has(`${r},${c - 1}`)) cell.fill = fill(C.hiFill);
        }
      });
      (s.cols || []).forEach((w, i) => { ws.getColumn(i + 1).width = w; });
      for (const m of s.merges || []) ws.mergeCells(...m);
      if (s.autoFilter && head) ws.autoFilter = { from: { row: head, column: 1 }, to: { row: head, column: nCols } };
    }
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  // 備用：SheetJS 無格式版本（只有數字格式、欄寬、凍結）
  function downloadXlsxBasic(filename, sheets) {
    const wb = XLSX.utils.book_new();
    const used = new Set();
    for (const s of sheets) {
      const ws = XLSX.utils.aoa_to_sheet(s.aoa);
      if (s.fmt) for (let r = 0; r < s.aoa.length; r++) for (let c = 0; c < (s.aoa[r] || []).length; c++) {
        const v = s.aoa[r][c];
        if (typeof v !== "number") continue;
        const z = s.fmt(r, c, v);
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (z && cell) cell.z = z;
      }
      if (s.cols) ws["!cols"] = s.cols.map(w => ({ wch: w }));
      let name = s.name.replace(/[\\/*?:[\]]/g, "_").slice(0, 31);
      for (let i = 2; used.has(name); i++) name = `${s.name.slice(0, 28)}_${i}`;
      used.add(name);
      XLSX.utils.book_append_sheet(wb, ws, name);
    }
    XLSX.writeFile(wb, filename);
  }

  return { downloadXlsx };
})();
