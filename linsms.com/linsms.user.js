// ==UserScript==
// @name         linsms
// @namespace    gavin.linsms
// @version      0.3.3
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
  const tplByCampaign = new Map(); // campaignId -> 模板id
  let badge = null;

  /* ---------- 0. 缓存 ---------- */
  function loadCache() {
    try {
      const raw = PAGE.localStorage.getItem(CACHE_KEY);
      if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) tplByCampaign.set(k, v);
      if (tplByCampaign.size) log(`缓存载入 ${tplByCampaign.size} 条映射`);
    } catch (e) { /* ignore */ }
  }
  function saveCache() {
    try {
      PAGE.localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(tplByCampaign)));
    } catch (e) { /* ignore */ }
  }

  /* ---------- 1. 数据吸收 ---------- */
  function absorbList(data) {
    const records = Array.isArray(data?.records) ? data.records : null;
    if (!records) return false;
    let n = 0;
    for (const rec of records) {
      if (rec && rec.campaignId != null && rec.selectedChannelTemplateId != null) {
        tplByCampaign.set(String(rec.campaignId), String(rec.selectedChannelTemplateId));
        n++;
      }
    }
    log(`列表数据: ${records.length} 条任务, ${n} 条带模板id (映射累计 ${tplByCampaign.size})`);
    if (n) {
      saveCache();
      renderAll();
      return true;
    }
    return false;
  }

  // 嗅探兜底：用户改筛选条件时页面自己发的请求也能更新映射
  function hookFetch() {
    const origFetch = PAGE.fetch;
    PAGE.fetch = async function (...args) {
      const res = await origFetch.apply(PAGE, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (String(url).includes('/customer/campaigns?')) {
          res.clone().json().then((d) => absorbList(d)).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return res;
    };
  }

  // 主动拉取：用页面 token 直接请求当天列表（2026-10-16 实测此方式 200 可用）
  async function loadListDirect() {
    const token = PAGE.localStorage.getItem('customer_token');
    if (!token) { warn('localStorage 无 customer_token，跳过主动拉取'); return; }
    const pad = (x) => String(x).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(); to.setHours(23, 59, 59, 999);
    const url = `/api/v1/customer/campaigns?page=1&pageSize=100&createdFrom=${encodeURIComponent(fmt(from))}&createdTo=${encodeURIComponent(fmt(to))}`;
    try {
      const r = await PAGE.fetch(url, { headers: { authorization: 'Bearer ' + token } });
      if (r.ok) {
        absorbList(await r.json());
      } else {
        warn('主动拉取失败:', r.status);
      }
    } catch (e) {
      warn('主动拉取异常:', e && e.message);
    }
  }

  /* ---------- 2. 行匹配：行内叶子元素文本精确等于 campaignId ----------
     （任务名的 hex 串会与 id 在 textContent 里粘连，如 "...39666725"，
       必须用叶子元素单独取数，2026-10-16 实测 16/16 行命中） */
  function findCampaignId(row) {
    for (const el of row.querySelectorAll('*')) {
      if (el.childElementCount !== 0) continue;
      const t = (el.textContent || '').trim();
      if (/^\d{2,8}$/.test(t) && tplByCampaign.has(t)) return t;
    }
    return null;
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

  /* ---------- 4. 状态标 ---------- */
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
  log('v0.3.3 启动', location.href);
  loadCache();
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
    setTimeout(loadListDirect, 1000); // 主动拉当天列表，不依赖嗅探
  });
})();
