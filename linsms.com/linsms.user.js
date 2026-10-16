// ==UserScript==
// @name         linsms
// @namespace    gavin.linsms
// @version      0.3.2
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
  const warn = (...a) => console.warn('%c[linsms]', 'color:#ff9800;font-weight:bold', ...a);

  const CACHE_KEY = 'linsms_campaign_tpl_map_v1';

  // campaignId -> 模板id
  const tplByCampaign = new Map();
  const authHeaders = {};      // 从页面请求学到的鉴权头（重拉用）
  let lastListUrl = null;      // 最近嗅探到的列表请求 URL
  let badge = null;

  /* ---------- 0. 缓存：学到的映射永久保留 ---------- */
  function loadCache() {
    try {
      const raw = PAGE.localStorage.getItem(CACHE_KEY);
      if (raw) {
        for (const [k, v] of Object.entries(JSON.parse(raw))) tplByCampaign.set(k, v);
      }
    } catch (e) { /* ignore */ }
  }
  function saveCache() {
    try {
      PAGE.localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(tplByCampaign)));
    } catch (e) { /* ignore */ }
  }

  /* ---------- 1. 嗅探列表接口：records[].campaignId -> selectedChannelTemplateId ---------- */
  function absorb(data, url) {
    if (!data || typeof data !== 'object') return;
    if (!url || !url.includes('/customer/campaigns?')) return;
    lastListUrl = url;

    const records = Array.isArray(data.records) ? data.records : null;
    if (!records) {
      warn('列表响应无 records 数组:', JSON.stringify(data).slice(0, 200));
      return;
    }
    let n = 0;
    for (const rec of records) {
      if (rec && rec.campaignId != null && rec.selectedChannelTemplateId != null) {
        tplByCampaign.set(String(rec.campaignId), String(rec.selectedChannelTemplateId));
        n++;
      }
    }
    log(`列表嗅探: ${records.length} 条任务, ${n} 条带模板id (映射累计 ${tplByCampaign.size})`);
    if (n) {
      saveCache();
      renderAll();
    }
  }

  function hookXhr() {
    const X = PAGE.XMLHttpRequest;
    if (X.prototype.__linsmsHooked) return;
    X.prototype.__linsmsHooked = true;

    const origOpen = X.prototype.open;
    X.prototype.open = function (m, url, ...r) {
      this.__url = url;
      return origOpen.call(this, m, url, ...r);
    };
    const origHdr = X.prototype.setRequestHeader;
    X.prototype.setRequestHeader = function (k, v) {
      try { if (/^authorization$/i.test(k) && v) authHeaders.authorization = v; } catch (e) {}
      return origHdr.call(this, k, v);
    };
    const origSend = X.prototype.send;
    X.prototype.send = function (...a) {
      this.addEventListener('load', function () {
        try {
          const url = String(this.__url || '');
          if (!url.includes('/api/')) return;
          const data = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
          absorb(data, url);
        } catch (e) { /* 非 JSON 忽略 */ }
      });
      return origSend.apply(this, a);
    };
  }

  function hookFetch() {
    const origFetch = PAGE.fetch;
    PAGE.fetch = async function (...args) {
      try {
        const h = args[1]?.headers;
        if (h) {
          let auth = null;
          if (h instanceof Headers) auth = h.get('authorization');
          else if (Array.isArray(h)) auth = h.find(([k]) => String(k).toLowerCase() === 'authorization')?.[1];
          else auth = h.authorization || h.Authorization;
          if (auth) authHeaders.authorization = auth;
        }
      } catch (e) { /* ignore */ }

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

  /* ---------- 2. 兜底：页面还有 "-" 行时，带鉴权重拉一次列表 ---------- */
  function hasUnresolvedRow() {
    return !!document.querySelector('td[data-linsms-col]');
  }
  function refetchList() {
    if (!lastListUrl) { warn('重拉跳过: 没有嗅探到列表URL'); return; }
    log('主动重拉列表:', lastListUrl, 'auth=', Object.keys(authHeaders));
    const x = new PAGE.XMLHttpRequest();
    x.open('GET', lastListUrl);
    for (const [k, v] of Object.entries(authHeaders)) {
      try { x.setRequestHeader(k, v); } catch (e) {}
    }
    x.onload = () => {
      try { absorb(JSON.parse(x.responseText), lastListUrl); }
      catch (e) { warn('重拉解析失败:', e && e.message); }
    };
    x.onerror = () => warn('重拉请求失败');
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

  // 行 -> campaignId：行文本里的数字段在映射中即命中
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

      const headRow = table.querySelector('thead tr');
      if (headRow && !headRow.querySelector('th[data-linsms-col]')) {
        const th = document.createElement('th');
        th.dataset.linsmsCol = '1';
        th.textContent = '模板';
        headRow.children[colIdx].after(th);
      }

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
    updateBadge();
  }

  /* ---------- 4. 状态标：肉眼看映射状态，不用翻控制台 ---------- */
  function updateBadge() {
    if (!badge || !badge.isConnected) {
      badge = document.createElement('div');
      badge.style.cssText =
        'position:fixed;left:8px;bottom:8px;z-index:99999;background:#3f51b5;color:#fff;' +
        'font:600 11px/1.6 monospace;padding:2px 8px;border-radius:4px;pointer-events:none;opacity:.85;';
      (document.body || document.documentElement).appendChild(badge);
    }
    badge.textContent = `linsms 映射:${tplByCampaign.size}条`;
  }

  /* ---------- 5. 启动 ---------- */
  log('v0.3.2 启动', location.href);
  loadCache();
  hookXhr();
  hookFetch();

  let timer = null;
  const mo = new PAGE.MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(renderAll, 200);
  });
  const watch = () =>
    mo.observe(PAGE.document.documentElement || PAGE.document, { childList: true, subtree: true });
  if (PAGE.document.documentElement) watch();
  else PAGE.document.addEventListener('readystatechange', watch, { once: true });

  PAGE.document.addEventListener('DOMContentLoaded', () => {
    renderAll();
    // 4s 后仍有 "-" 行就带鉴权重拉；再不够 10s 补一次
    setTimeout(() => { if (hasUnresolvedRow()) refetchList(); }, 4000);
    setTimeout(() => { if (hasUnresolvedRow()) refetchList(); }, 10000);
  });
})();
