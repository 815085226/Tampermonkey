// ==UserScript==
// @name         linsms
// @namespace    gavin.linsms
// @version      0.2.3
// @description  mkt.linsms.com/campaigns 列表"链接"列后显示模版编号 + 模版内容（优先现有接口，回退 adm.linsms.com/channel-templates）
// @author       Gavin
// @match        *://mkt.linsms.com/*
// @match        *://adm.linsms.com/*
// @connect      mkt.linsms.com
// @connect      adm.linsms.com
// @run-at       document-start
// @grant        GM_info
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
  'use strict';

  /* ================= 可配置区（根据实际接口调整） ================= */
  const DEBUG = true; // 控制台打印所有嗅探到的接口，便于定位真实 API

  // 任务详情接口候选（按顺序探测，{id} 会被替换）
  const DETAIL_API_CANDIDATES = [
    '/api/campaigns/{id}',
    '/api/campaign/{id}',
    '/mkt/api/campaigns/{id}',
    '/api/task/campaigns/{id}',
    '/api/campaigns/detail/{id}',
  ];

  // 模板列表接口候选（mkt 侧优先，失败回退 adm 侧）
  const TEMPLATE_API_CANDIDATES = [
    { host: 'http://mkt.linsms.com', path: '/api/channel-templates?pageNum=1&pageSize=500' },
    { host: 'http://mkt.linsms.com', path: '/api/channel/templates?pageNum=1&pageSize=500' },
    { host: 'http://mkt.linsms.com', path: '/api/templates?pageNum=1&pageSize=500' },
    { host: 'http://adm.linsms.com', path: '/api/channel-templates?pageNum=1&pageSize=500' },
    { host: 'http://adm.linsms.com', path: '/api/channel/templates?pageNum=1&pageSize=500' },
    { host: 'http://adm.linsms.com', path: '/api/templates?pageNum=1&pageSize=500' },
  ];

  // 模板编号字段候选 / 模板内容字段候选
  const TPL_NO_KEYS = ['templateNumber', 'templateNo', 'templateId', 'templateCode', 'channelTemplateId', 'tplId'];
  const TPL_CONTENT_KEYS = ['content', 'templateContent', 'text', 'copyWriting', 'body', 'message'];

  const CACHE_KEY = 'linsms_tpl_map_v1';
  const CACHE_TTL = 24 * 3600 * 1000; // 模板映射缓存 24h
  /* =============================================================== */

  const log = (...a) => console.log('%c[linsms]', 'color:#3f51b5;font-weight:bold', ...a);
  const dwarn = (...a) => DEBUG && console.warn('%c[linsms]', 'color:#ff9800;font-weight:bold', ...a);

  const campaignMap = new Map();   // taskName -> { id, tplNo, ...raw }
  const tplContentMap = new Map(); // tplNo -> content
  const rowDone = new WeakSet();   // 已注入的行

  /* ---------------- 1. 网络嗅探：捕获列表/详情接口 ---------------- */
  function deepFind(obj, keys) {
    if (obj == null || typeof obj !== 'object') return undefined;
    for (const k of keys) {
      if (k in obj && obj[k] !== null && obj[k] !== '') return obj[k];
    }
    for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        const r = deepFind(v, keys);
        if (r !== undefined) return r;
      }
    }
    return undefined;
  }

  function tryAbsorbRecord(rec) {
    if (!rec || typeof rec !== 'object') return false;
    // 任务名特征：较长的纯数字串（如 202610161339）
    const name =
      deepFind(rec, ['taskName', 'campaignName', 'name', 'taskNo', 'campaignNo']) ?? null;
    if (typeof name !== 'string' || !/^\d{10,}$/.test(name)) return false;
    const id = deepFind(rec, ['id', 'campaignId', 'taskId']);
    const tplNo = deepFind(rec, TPL_NO_KEYS);
    const prev = campaignMap.get(name) || {};
    campaignMap.set(name, { ...prev, ...rec, id: id ?? prev.id, tplNo: tplNo ?? prev.tplNo });
    if (DEBUG) log('捕获任务记录:', name, 'tplNo=', tplNo ?? '(无)', rec);
    return true;
  }

  function absorbJson(data) {
    if (!data || typeof data !== 'object') return;
    const scan = (v, depth) => {
      if (depth > 6 || v == null || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach((x) => scan(x, depth + 1)); return; }
      tryAbsorbRecord(v);
      for (const k in v) scan(v[k], depth + 1);
    };
    scan(data, 0);
    scheduleRender();
  }

  // 页面真实全局对象：grant 模式下沙箱内的 XMLHttpRequest/fetch 是副本，
  // 直接 patch 拦不到页面发出的请求，必须钩 unsafeWindow
  const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  function hookXhr() {
    const XHR = PAGE.XMLHttpRequest;
    const origOpen = XHR.prototype.open;
    XHR.prototype.open = function (method, url, ...rest) {
      this.__linsmsUrl = url;
      return origOpen.call(this, method, url, ...rest);
    };
    const origSend = XHR.prototype.send;
    XHR.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        const url = this.__linsmsUrl || '';
        if (!/linsms\.com/.test(location.host) && !url.includes('linsms.com')) return;
        // 静态资源噪音过滤
        if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(url)) return;
        const ct = this.getResponseHeader?.('content-type') || '';
        if (DEBUG) log(`XHR ${this.status} [${ct.split(';')[0] || '-'}]`, url);
        try {
          const data = JSON.parse(this.responseText);
          absorbJson(data);
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
        if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(url)) return res;
        const ct = res.headers?.get?.('content-type') || '';
        if (DEBUG) log(`FETCH ${res.status} [${ct.split(';')[0] || '-'}]`, url);
        const clone = res.clone();
        clone.text().then((t) => {
          try {
            absorbJson(JSON.parse(t));
          } catch (e) { /* 非 JSON 忽略 */ }
        }).catch(() => {});
      } catch (e) { /* ignore */ }
      return res;
    };
  }

  /* ---------------- 2. 模板内容获取 ---------------- */
  function loadTplCache() {
    try {
      const c = JSON.parse(GM_getValue(CACHE_KEY, '{}'));
      if (c.ts && Date.now() - c.ts < CACHE_TTL && c.map) {
        for (const [k, v] of Object.entries(c.map)) tplContentMap.set(k, v);
        log('已加载模板缓存', tplContentMap.size, '条');
      }
    } catch (e) { /* ignore */ }
  }

  function saveTplCache() {
    GM_setValue(CACHE_KEY, JSON.stringify({ ts: Date.now(), map: Object.fromEntries(tplContentMap) }));
  }

  function gmGet(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 10000,
        onload: (r) => {
          let data = null;
          try { data = JSON.parse(r.responseText); } catch (e) { /* 非 JSON */ }
          resolve({ status: r.status, data });
        },
        onerror: () => resolve({ status: 0, data: null }),
        ontimeout: () => resolve({ status: -1, data: null }),
      });
    });
  }

  async function fetchDetail(id) {
    for (const tpl of DETAIL_API_CANDIDATES) {
      const url = location.origin + tpl.replace('{id}', id);
      const { status, data } = await gmGet(url);
      if (DEBUG) log(`详情探测 ${status}`, url);
      if (data) {
        absorbJson(data);
        return data;
      }
    }
    return null;
  }

  async function buildTplMap() {
    for (const { host, path } of TEMPLATE_API_CANDIDATES) {
      const url = host + path;
      const { status, data } = await gmGet(url);
      if (DEBUG) log(`模板探测 ${status}`, url);
      if (!data) continue;
      // 展开为数组
      let arr = [];
      const walk = (v, d) => {
        if (d > 5 || v == null) return;
        if (Array.isArray(v)) { if (v.length) arr = arr.concat(v); return; }
        if (typeof v === 'object') { for (const k in v) walk(v[k], d + 1); }
      };
      walk(data, 0);
      if (!arr.length) continue;
      // 确认是模板数据：至少一条含内容字段
      let hit = 0;
      for (const item of arr) {
        if (typeof item !== 'object') continue;
        const no = deepFind(item, TPL_NO_KEYS);
        const content = deepFind(item, TPL_CONTENT_KEYS);
        if (no != null && content != null) {
          tplContentMap.set(String(no), String(content));
          hit++;
        }
      }
      if (hit > 0) {
        log(`模板接口命中: ${host}${path}，共 ${hit} 条模板`);
        saveTplCache();
        scheduleRender();
        return true;
      }
    }
    dwarn('所有模板接口候选均未命中，请查看控制台确认真实接口');
    return false;
  }

  /* ---------------- 3. 渲染：链接列后追加模版编号/内容 ---------------- */
  function findLinkColIndex(table) {
    const ths = table.querySelectorAll('thead th');
    for (let i = 0; i < ths.length; i++) {
      const t = (ths[i].textContent || '').trim();
      if (t === '链接' || t.startsWith('链接')) return i;
    }
    return -1;
  }

  function getTaskNameFromRow(row) {
    // 任务列中较长纯数字串
    const m = (row.textContent || '').match(/\b(\d{10,})\b/);
    return m ? m[1] : null;
  }

  async function renderRow(table, row, colIdx) {
    if (rowDone.has(row)) return;
    const cell = row.cells?.[colIdx];
    if (!cell) return;
    const taskName = getTaskNameFromRow(row);
    if (!taskName) return;

    let rec = campaignMap.get(taskName);
    let tplNo = rec?.tplNo;

    // 列表接口没带模板编号 → 探测详情接口
    if (tplNo == null && rec?.id != null) {
      await fetchDetail(rec.id);
      rec = campaignMap.get(taskName);
      tplNo = rec?.tplNo;
    }
    if (tplNo == null) return; // 拿不到编号就不注入

    rowDone.add(row);
    // 防止重复注入
    if (cell.querySelector('.linsms-tpl')) return;

    const wrap = document.createElement('div');
    wrap.className = 'linsms-tpl';
    wrap.style.cssText = 'margin-top:4px;font-size:12px;line-height:1.5;';

    const noLine = document.createElement('div');
    noLine.textContent = `模版编号: ${tplNo}`;
    noLine.style.cssText = 'color:#3f51b5;font-weight:600;';
    wrap.appendChild(noLine);

    const content = tplContentMap.get(String(tplNo));
    const contentLine = document.createElement('div');
    contentLine.className = 'linsms-tpl-content';
    contentLine.style.cssText = 'color:#666;max-width:260px;white-space:normal;word-break:break-all;';
    if (content != null) {
      contentLine.textContent = content;
    } else {
      contentLine.textContent = '模版内容获取中…';
      contentLine.dataset.linsmsPending = String(tplNo);
    }
    wrap.appendChild(contentLine);
    cell.appendChild(wrap);
  }

  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderAll();
    }, 300);
  }

  function renderAll() {
    if (!/\/campaigns/.test(location.pathname + location.hash)) return;
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const colIdx = findLinkColIndex(table);
      if (colIdx < 0) continue;
      const rows = table.querySelectorAll('tbody tr');
      for (const row of rows) renderRow(table, row, colIdx);
    }
  }

  /* ---------------- 4. 启动 ---------------- */
  function boot() {
    const ver = typeof GM_info !== 'undefined' ? GM_info.script.version : '?';
    log(`v${ver} 启动`, location.href);
    loadTplCache();

    // 页面在 /campaigns 时加载模板映射（不依赖嗅探）
    if (/\/campaigns/.test(location.pathname + location.hash)) {
      buildTplMap();
    }

    const mo = new MutationObserver(() => scheduleRender());
    mo.observe(document.documentElement, { childList: true, subtree: true });
    scheduleRender();
  }

  // 关键：document-start 阶段立即安装嗅探钩子，
  // 抢在页面首批 API 请求发出之前（DOMContentLoaded 后装会全部错过）
  hookXhr();
  hookFetch();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
