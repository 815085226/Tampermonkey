// ==UserScript==
// @name         linsms
// @namespace    gavin.linsms
// @version      0.3.1
// @description  mkt.linsms.com/campaigns 列表在"链接"列右侧新增"模板"列，显示任务关联的模版 id
// @author       Gavin
// @match        *://mkt.linsms.com/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const PAGE = unsafeWindow;
  const log = (...a) => console.log('%c[linsms]', 'color:#3f51b5;font-weight:bold', ...a);

  // campaignId -> selectedChannelTemplateId（从列表接口嗅探）
  const tplByCampaign = new Map();
  let lastListUrl = null;   // 最近一次嗅探到的列表请求 URL（兜底重拉用）
  let refetched = false;    // 兜底重拉只做一次

  /* ---------- 1. 嗅探：记录 campaignId -> 模板id ---------- */
  function absorb(data, url) {
    if (!data || typeof data !== 'object') return;
    if (url && url.includes('/customer/campaigns?')) lastListUrl = url;

    const records = Array.isArray(data.records) ? data.records : (Array.isArray(data) ? data : null);
    if (!records) return;
    for (const rec of records) {
      if (rec && rec.campaignId != null && rec.selectedChannelTemplateId != null) {
        tplByCampaign.set(String(rec.campaignId), String(rec.selectedChannelTemplateId));
      }
    }
    if (tplByCampaign.size) {
      log(`任务→模板映射 ${tplByCampaign.size} 条，刷新列`);
      renderAll();
    }
  }

  function hookXhr() {
    const X = PAGE.XMLHttpRequest;
    if (X.prototype.__linsmsHooked) return;
    X.prototype.__linsmsHooked = true;
    const origOpen = X.prototype.open;
    X.prototype.open = function (method, url, ...rest) {
      this.__url = url;
      return origOpen.call(this, method, url, ...rest);
    };
    const origSend = X.prototype.send;
    X.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        try {
          const url = String(this.__url || '');
          if (!url.includes('/api/')) return;
          const data = JSON.parse(this.responseText);
          absorb(data, url);
        } catch (e) { /* 非 JSON 忽略 */ }
      });
      return origSend.apply(this, args);
    };
  }

  function hookFetch() {
    const origFetch = PAGE.fetch;
    PAGE.fetch = async function (...args) {
      const res = await origFetch.apply(PAGE, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (String(url).includes('/api/')) {
          res.clone().json().then((d) => absorb(d, url)).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return res;
    };
  }

  /* ---------- 2. 兜底：4s 后仍无数据，用页面 XHR 重拉一次列表 ---------- */
  function refetchList() {
    if (refetched || tplByCampaign.size || !lastListUrl) return;
    refetched = true;
    log('未嗅探到模板id，重拉列表:', lastListUrl);
    const x = new PAGE.XMLHttpRequest();
    x.open('GET', lastListUrl);
    x.onload = () => { try { absorb(JSON.parse(x.responseText), lastListUrl); } catch (e) {} };
    x.send();
  }

  /* ---------- 3. 渲染：链接列后插入"模板"列 ---------- */
  function findLinkColIndex(table) {
    for (const th of table.querySelectorAll('thead th')) {
      if ((th.textContent || '').trim().includes('链接')) {
        return Array.from(th.parentElement.children).indexOf(th);
      }
    }
    return -1;
  }

  // 行 -> campaignId：行文本里出现过的数字段（如 6725）在映射里即命中
  function findCampaignId(row) {
    const nums = (row.textContent || '').match(/(?<!\d)(\d{2,12})(?!\d)/g) || [];
    for (const n of nums) {
      if (tplByCampaign.has(n)) return n;
    }
    return null;
  }

  function renderAll() {
    if (!/\/campaigns/.test(location.pathname + location.hash)) return;
    for (const table of document.querySelectorAll('table')) {
      const colIdx = findLinkColIndex(table);
      if (colIdx < 0) continue;

      // 表头加"模板"列（只加一次）
      const headRow = table.querySelector('thead tr');
      if (headRow && !headRow.querySelector('th[data-linsms-col]')) {
        const th = document.createElement('th');
        th.dataset.linsmsCol = '1';
        th.textContent = '模板';
        headRow.children[colIdx].after(th);
      }

      // 每行插入/更新单元格（每次渲染都刷新内容，映射后到也能回填）
      for (const row of table.querySelectorAll('tbody tr')) {
        const cell = row.cells?.[colIdx];
        if (!cell) continue;
        let td = row.querySelector('td[data-linsms-col]');
        if (!td) {
          td = document.createElement('td');
          td.dataset.linsmsCol = '1';
          cell.after(td);
        }

        const cid = findCampaignId(row);
        const tplId = cid ? tplByCampaign.get(cid) : null;
        td.textContent = tplId || '-';
        td.style.cssText = tplId
          ? 'color:#1565c0;font-weight:600;font-family:monospace;'
          : 'color:#999;';
      }
    }
  }

  /* ---------- 4. 启动 ---------- */
  log('v0.3.0 启动', location.href);
  hookXhr();
  hookFetch();

  let timer = null;
  const mo = new PAGE.MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(renderAll, 200);
  });
  const watch = () => mo.observe(PAGE.document.documentElement || PAGE.document, { childList: true, subtree: true });
  if (PAGE.document.documentElement) watch();
  else PAGE.document.addEventListener('readystatechange', watch, { once: true });

  PAGE.document.addEventListener('DOMContentLoaded', () => {
    renderAll();
    setTimeout(refetchList, 4000); // 兜底重拉
  });
})();
