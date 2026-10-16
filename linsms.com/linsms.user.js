// ==UserScript==
// @name         linsms
// @namespace    gavin.linsms
// @version      0.4.0
// @description  mkt campaigns 列表"链接"列后新增"模板"列（模版id+文案）；文案从 adm 已登录会话自动学习获取。不保存任何账号密码。
// @author       Gavin
// @match        *://mkt.linsms.com/*
// @match        *://adm.linsms.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      adm.linsms.com
// ==/UserScript==

(function () {
  'use strict';

  const PAGE = unsafeWindow;
  const IS_ADM = location.hostname.startsWith('adm.');
  const log = (...a) => console.log('%c[linsms]', 'color:#3f51b5;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[linsms]', 'color:#ff9800;font-weight:bold', ...a);

  const CACHE_KEY = 'linsms_campaign_tpl_map_v1'; // GM: campaignId -> 模板id（mkt 用）
  const TPLC_KEY = 'linsms_tpl_content_v1';       // GM: 模板id -> 文案（跨域共享）
  const ADM_KEY = 'linsms_adm_auth_v1';           // GM: adm 会话 token + 已学习的模板接口 URL

  const tplByCampaign = new Map(); // campaignId -> 模板id
  const tplContent = new Map();    // 模板id -> 文案
  let badge = null;

  /* ============ 0. GM 存储 ============ */
  function gmLoadMap(key, target) {
    try {
      const raw = GM_getValue(key);
      if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) target.set(k, v);
    } catch (e) { /* ignore */ }
  }
  function gmSaveMap(key, map) {
    try { GM_setValue(key, JSON.stringify(Object.fromEntries(map))); } catch (e) { /* ignore */ }
  }

  /* ============ 1. 模板文案吸收（adm/mkt 通用） ============ */
  // 响应 JSON 中找 [{id, content}] 形状的模板数组
  function absorbTpl(data) {
    if (!data || typeof data !== 'object') return 0;
    let n = 0;
    const walk = (v, d) => {
      if (d > 6 || v == null || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item && typeof item === 'object' && !Array.isArray(item) &&
              item.id != null && typeof item.content === 'string' && item.content) {
            const no = String(item.id);
            if (tplContent.get(no) !== item.content) {
              tplContent.set(no, item.content);
              n++;
            }
          } else if (item && typeof item === 'object') {
            walk(item, d + 1);
          }
        }
        return;
      }
      for (const k in v) walk(v[k], d + 1);
    };
    walk(data, 0);
    if (n) {
      gmSaveMap(TPLC_KEY, tplContent);
      log(`模板文案吸收 ${n} 条（累计 ${tplContent.size}）`);
      if (!IS_ADM) renderAll();
    }
    return n;
  }

  /* ============ 2. adm 侧：学习会话 token + 模板接口 URL ============ */
  function saveAdmToken(token) {
    if (!token) return;
    const prev = gmGetAdm();
    if (prev.token === token) return;
    GM_setValue(ADM_KEY, JSON.stringify({ token, url: prev.url || '' }));
    log('已记录 adm 会话凭证（仅存油猴本地存储，不进脚本/git）');
  }
  function gmGetAdm() {
    try { return JSON.parse(GM_getValue(ADM_KEY) || '{}'); } catch (e) { return {}; }
  }

  function hookAdm() {
    const F = PAGE.fetch;
    PAGE.fetch = async function (...args) {
      try {
        const h = args[1]?.headers;
        if (h) {
          let auth = null;
          if (h instanceof Headers) auth = h.get('authorization');
          else if (Array.isArray(h)) auth = h.find(([k]) => String(k).toLowerCase() === 'authorization')?.[1];
          else auth = h.authorization || h.Authorization;
          if (auth) saveAdmToken(String(auth).replace(/^Bearer\s+/i, ''));
        }
      } catch (e) { /* ignore */ }

      const res = await F.apply(PAGE, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (String(url).toLowerCase().includes('template')) {
          const prev = gmGetAdm();
          if (prev.url !== url) {
            GM_setValue(ADM_KEY, JSON.stringify({ token: prev.token || '', url }));
            log('学习到 adm 模板接口:', url);
          }
          res.clone().json().then((d) => absorbTpl(d)).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return res;
    };

    // localStorage 兜底扫描 token
    try {
      for (let i = 0; i < PAGE.localStorage.length; i++) {
        const k = PAGE.localStorage.key(i);
        if (!/token/i.test(k)) continue;
        let v = PAGE.localStorage.getItem(k);
        try {
          const j = JSON.parse(v);
          if (j && typeof j === 'object') v = j.token || j.access_token || v;
        } catch (e) { /* 非JSON */ }
        if (typeof v === 'string' && v.length > 20) { saveAdmToken(v); break; }
      }
    } catch (e) { /* ignore */ }
  }

  // mkt 侧用 GM 请求拉 adm 模板文案（只 GET，只读）。拿不到不阻塞业务，仅提示
  function fetchAdmTemplates() {
    const adm = gmGetAdm();
    if (typeof GM_xmlhttpRequest !== 'function') return;
    if (!adm.token || !adm.url) {
      log('提示: 未获取到 adm 会话数据，模板列暂只显示 id。需在浏览器打开一次 adm.linsms.com/channel-templates（已登录状态）后自动补全文案');
      return;
    }
    const url = adm.url.startsWith('http') ? adm.url : 'http://adm.linsms.com' + adm.url;
    log('向 adm 拉取模板文案:', url);
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      headers: { authorization: /^bearer/i.test(adm.token) ? adm.token : 'Bearer ' + adm.token },
      timeout: 10000,
      onload: (r) => {
        try { absorbTpl(JSON.parse(r.responseText)); }
        catch (e) { warn('adm 响应解析失败:', r.status); }
      },
      onerror: () => warn('adm 请求失败'),
      ontimeout: () => warn('adm 请求超时'),
    });
  }

  /* ============ 3. mkt 侧：任务 → 模板id ============ */
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
      gmSaveMap(CACHE_KEY, tplByCampaign);
      renderAll();
      return true;
    }
    return false;
  }

  function hookMkt() {
    const F = PAGE.fetch;
    PAGE.fetch = async function (...args) {
      const res = await F.apply(PAGE, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (String(url).includes('/customer/campaigns?')) {
          res.clone().json().then((d) => absorbList(d)).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return res;
    };
  }

  async function loadListDirect() {
    const token = PAGE.localStorage.getItem('customer_token');
    if (!token) return;
    const pad = (x) => String(x).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(); to.setHours(23, 59, 59, 999);
    const url = `/api/v1/customer/campaigns?page=1&pageSize=100&createdFrom=${encodeURIComponent(fmt(from))}&createdTo=${encodeURIComponent(fmt(to))}`;
    try {
      const r = await PAGE.fetch(url, { headers: { authorization: 'Bearer ' + token } });
      if (r.ok) {
        if (absorbList(await r.json())) fetchAdmTemplates();
      }
    } catch (e) { /* ignore */ }
  }

  /* ============ 4. 行匹配与渲染 ============ */
  function findCampaignId(row) {
    for (const el of row.querySelectorAll('*')) {
      if (el.childElementCount !== 0) continue;
      const t = (el.textContent || '').trim();
      if (/^\d{2,8}$/.test(t) && tplByCampaign.has(t)) return t;
    }
    return null;
  }

  function findLinkColIndex(table) {
    for (const th of table.querySelectorAll('thead th')) {
      if ((th.textContent || '').trim().includes('链接')) {
        return Array.from(th.parentElement.children).indexOf(th);
      }
    }
    return -1;
  }

  function renderAll() {
    if (IS_ADM || !/\/campaigns/.test(location.pathname + location.hash)) return;
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
        if (!tplId) {
          td.textContent = '-';
          td.style.cssText = 'color:#999;';
          continue;
        }
        const content = tplContent.get(tplId);
        if (content) td.title = content;
        td.innerHTML = '';
        const idLine = document.createElement('div');
        idLine.textContent = tplId;
        idLine.style.cssText = 'color:#1565c0;font-weight:600;font-family:monospace;';
        td.appendChild(idLine);
        const cLine = document.createElement('div');
        if (content) {
          cLine.textContent = content.length > 60 ? content.slice(0, 60) + '…' : content;
          cLine.style.cssText = 'color:#666;font-size:11px;max-width:260px;white-space:pre-wrap;word-break:break-all;';
        } else {
          cLine.textContent = '文案未获取（打开 adm 模板页后自动补全）';
          cLine.style.cssText = 'color:#bbb;font-size:11px;';
        }
        td.appendChild(cLine);
      }
    }
    updateBadge();
  }

  function updateBadge() {
    if (!badge || !badge.isConnected) {
      badge = document.createElement('div');
      badge.style.cssText =
        'position:fixed;left:8px;bottom:8px;z-index:99999;background:#3f51b5;color:#fff;' +
        'font:600 11px/1.6 monospace;padding:2px 8px;border-radius:4px;pointer-events:none;opacity:.85;';
      (document.body || document.documentElement).appendChild(badge);
    }
    badge.textContent = IS_ADM
      ? `linsms adm 文案库:${tplContent.size}条`
      : `linsms 映射:${tplByCampaign.size} 文案:${tplContent.size}`;
  }

  /* ============ 5. 启动 ============ */
  log(`v0.4.0 启动 (${IS_ADM ? 'adm' : 'mkt'})`, location.href);
  gmLoadMap(CACHE_KEY, tplByCampaign);
  gmLoadMap(TPLC_KEY, tplContent);

  if (IS_ADM) {
    hookAdm();
  } else {
    hookMkt();
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
      setTimeout(loadListDirect, 1000);
      setTimeout(fetchAdmTemplates, 2500); // 有 adm 会话数据则补全文案
    });
  }
})();
