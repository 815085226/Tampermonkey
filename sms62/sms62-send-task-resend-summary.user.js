// ==UserScript==
// @name         sms62 批量补发失败弹窗汇总
// @namespace    gavin.sms62
// @version      1.0.0
// @description  在 http://web.sms62.com/mkt/send-task 的「批量创建失败补发任务」弹窗中，表格下方自动显示汇总：任务数 + 提交失败合计 + 发送失败合计（红色）；弹窗内容变化时自动更新
// @author       Gavin
// @match        http://web.sms62.com/*
// @match        https://web.sms62.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const PATH_KEYWORD = '/mkt/send-task';        // 仅此页面生效
  const DIALOG_TITLE_KEYWORD = '批量创建失败补发任务';
  const BAR_ID = 'gavin-resend-summary';
  const THROTTLE_MS = 200;

  const log = (...a) =>
    console.log('%c[补发汇总]', 'color:#009688;font-weight:bold', ...a);

  const onTargetPage = () =>
    location.pathname.includes(PATH_KEYWORD) || location.hash.includes(PATH_KEYWORD);

  // 找当前可见的补发弹窗
  function findDialog() {
    for (const d of document.querySelectorAll('.el-dialog')) {
      if (d.getBoundingClientRect().width <= 0) continue;
      const t = d.querySelector('.el-dialog__title');
      if (t && t.textContent.includes(DIALOG_TITLE_KEYWORD)) return d;
    }
    return null;
  }

  // "1,234" / "8" / "" → 数字（空值按 0 计）
  function parseNum(text) {
    const s = String(text == null ? '' : text).replace(/[^\d.\-]/g, '');
    if (!s || s === '-' || s === '.') return 0;
    const v = Number(s);
    return Number.isFinite(v) ? v : 0;
  }

  const fmt = (n) => n.toLocaleString('en-US');

  // 从表格 DOM 读取并求和（列位置按表头文字定位，不写死索引）
  function compute(dlg) {
    const table = dlg.querySelector('.el-table');
    if (!table) return null;
    const heads = [...table.querySelectorAll('.el-table__header-wrapper thead th')]
      .map((th) => th.innerText.trim());
    const iSend = heads.indexOf('发送失败');
    if (iSend < 0) return null;
    const iSub = heads.indexOf('提交失败');

    let send = 0;
    let sub = 0;
    let rows = 0;
    for (const tr of table.querySelectorAll('.el-table__body-wrapper tbody tr')) {
      const tds = tr.querySelectorAll('td');
      if (!tds.length || iSend >= tds.length) continue;
      send += parseNum(tds[iSend].innerText);
      if (iSub >= 0 && iSub < tds.length) sub += parseNum(tds[iSub].innerText);
      rows++;
    }
    return { table, rows, sub, send, hasSub: iSub >= 0 };
  }

  function makeBar() {
    const bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.style.cssText =
      'display:flex;align-items:center;gap:18px;margin-top:8px;padding:8px 12px;' +
      'background:#f5f7fa;border:1px solid #ebeef5;border-radius:4px;' +
      'font-size:13px;color:#606266;line-height:1.5;';
    return bar;
  }

  function render(data) {
    const { table, rows, sub, send, hasSub } = data;
    let bar = document.getElementById(BAR_ID);
    // 表格换了（重新打开弹窗）或位置不对 → 重建并紧贴表格下方
    if (!bar || bar.previousElementSibling !== table) {
      if (bar) bar.remove();
      bar = makeBar();
      if (table.nextSibling) table.parentElement.insertBefore(bar, table.nextSibling);
      else table.parentElement.appendChild(bar);
    }
    const html =
      '<span>合计 <b style="color:#303133;font-size:14px">' + fmt(rows) + '</b> 个任务</span>' +
      (hasSub
        ? '<span>提交失败 <b style="color:#303133">' + fmt(sub) + '</b></span>'
        : '') +
      '<span>发送失败 <b style="color:#f56c6c;font-size:15px">' + fmt(send) + '</b></span>' +
      (rows ? '' : '<span style="color:#909399">当前没有可补发的任务</span>');
    if (bar.__sig !== html) {
      bar.innerHTML = html;
      bar.__sig = html;
    }
  }

  let lastSig = '';

  function refresh() {
    if (!onTargetPage()) return;
    const dlg = findDialog();
    if (!dlg) {
      lastSig = ''; // 弹窗关闭，允许下次重算
      return;
    }
    const data = compute(dlg);
    if (!data) return;
    const sig = data.rows + '|' + data.sub + '|' + data.send + '|' + (data.hasSub ? 1 : 0);
    if (sig === lastSig && document.getElementById(BAR_ID)) return;
    lastSig = sig;
    render(data);
    log('汇总：' + data.rows + ' 个任务，提交失败 ' + data.sub + '，发送失败 ' + data.send);
  }

  let timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      refresh();
    }, THROTTLE_MS);
  }

  const ob = new MutationObserver(schedule);
  ob.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  setInterval(refresh, 1500); // 兜底（虚拟滚动/异步数字更新）

  if (location.pathname.includes(PATH_KEYWORD)) {
    log('已加载：打开「批量补发失败」弹窗后会自动在表格下方显示汇总');
  }
})();
