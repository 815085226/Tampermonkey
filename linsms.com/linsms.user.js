// ==UserScript==
// @name         linsms
// @namespace    gavin.linsms
// @version      0.2.7
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

  // 任务详情接口候选（{id} 会被替换）——已按 2026-10-16 实测嗅探收敛
  const DETAIL_API_CANDIDATES = [
    '/api/v1/customer/campaigns/{id}',
    '/api/v1/customer/campaigns/detail/{id}',
    '/api/v1/customer/campaign/{id}',
  ];

  // 模板列表接口候选（host 留空 = mkt 同源；失败再回退 adm）
  const TEMPLATE_API_CANDIDATES = [
    { host: '', path: '/api/v1/customer/channel-templates?pageSize=500' },
    { host: '', path: '/api/v1/customer/channel-templates' },
    { host: 'http://adm.linsms.com', path: '/api/v1/customer/channel-templates?pageSize=500' },
    { host: 'http://adm.linsms.com', path: '/api/v1/customer/channel-templates' },
  ];

  // 模板编号字段候选 / 模板内容字段候选
  const TPL_NO_KEYS = ['templateNumber', 'templateNo', 'templateId', 'templateCode', 'channelTemplateId', 'tplId'];
  const TPL_CONTENT_KEYS = ['content', 'templateContent', 'text', 'copyWriting', 'body', 'message'];

  const CACHE_KEY = 'linsms_tpl_map_v1';
  const CACHE_TTL = 24 * 3600 * 1000; // 模板映射缓存 24h
  /* =============================================================== */

  const log = (...a) => console.log('%c[linsms]', 'color:#3f51b5;font-weight:bold', ...a);
  const dwarn = (...a) => DEBUG && console.warn('%c[linsms]', 'color:#ff9800;font-weight:bold', ...a);

  const campaignMap = new Map();   // taskName -> record（长数字名别名）
  const recById = new Map();       // String(campaignId) -> record（主索引）
  const idIndex = new Map();       // String(campaignId) -> taskName
  const detailTried = new Set();   // 已探测过详情的任务 id
  const tplContentMap = new Map(); // tplNo -> content
  const authHeaders = {};          // 从页面 XHR 捕获的鉴权头（authorization/token）
  let lastTplQuery = '';           // 最近一次嗅探到的 channel-templates 查询串（含 countryCode）
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
    // 形状门槛：campaignId/taskId 显式存在；或 id+name+type 且不含文案字段
    //（防止把模板记录 id=6105 之类误收为任务）
    const hasCampaignId = 'campaignId' in rec || 'taskId' in rec;
    const looksCampaign =
      typeof rec.type === 'string' &&
      typeof rec.name === 'string' &&
      TPL_CONTENT_KEYS.every((k) => !(k in rec));
    if (!hasCampaignId && !looksCampaign) return false;
    const id = hasCampaignId ? deepFind(rec, ['campaignId', 'taskId']) : rec.id;
    if (id == null) return false;
    const name = deepFind(rec, ['taskName', 'campaignName', 'name', 'taskNo', 'campaignNo']) ?? null;
    const tplNo = deepFind(rec, TPL_NO_KEYS);
    // 以任务 id 为主键归档（Quick 随机名任务也能存），长数字任务名额外建别名
    const key = String(id);
    const prev = recById.get(key) || {};
    const merged = { ...prev, ...rec, id: id ?? prev.id, tplNo: tplNo ?? prev.tplNo };
    recById.set(key, merged);
    if (typeof name === 'string' && /^\d{10,}$/.test(name)) {
      campaignMap.set(name, merged);
      idIndex.set(key, name);
    }
    if (DEBUG) log('捕获任务记录:', key, 'tplNo=', merged.tplNo ?? '(无)', rec);
    return true;
  }

  function absorbTemplates(data, url) {
    if (!url || !url.includes('channel-templates')) return;
    try {
      const q = new URL(url, location.href).search;
      if (q) lastTplQuery = q;
    } catch (e) { /* ignore */ }
    const items = [];
    const walk = (v, d) => {
      if (d > 6 || v == null || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach((x) => { if (x && typeof x === 'object' && !Array.isArray(x)) items.push(x); walk(x, d + 1); }); return; }
      for (const k in v) walk(v[k], d + 1);
    };
    walk(data, 0);
    if (!items.length) {
      // 打印响应结构，定位为什么解析不出模板（业务码封装/空列表/鉴权问题等）
      if (DEBUG) dwarn('channel-templates 无数组样本，响应结构:', JSON.stringify(data).slice(0, 600));
      return;
    }
    // id + 内容字段的通用映射；URL 已限定为模板接口，id 取值安全
    let hit = 0;
    for (const item of items) {
      const no = deepFind(item, ['id', ...TPL_NO_KEYS]);
      const content = deepFind(item, TPL_CONTENT_KEYS);
      if (no != null && content != null) {
        tplContentMap.set(String(no), String(content));
        hit++;
      }
    }
    if (hit > 0) {
      log(`从嗅探吸收模板 ${hit} 条（累计 ${tplContentMap.size}）`);
      saveTplCache();
      updatePendingContent();
    } else if (DEBUG) {
      // 字段名没猜中：打印首条样本，据此调整 TPL_NO_KEYS / TPL_CONTENT_KEYS
      dwarn('channel-templates 首条样本:', JSON.stringify(items[0]).slice(0, 800));
    }
  }

  let learnedDetailTpl = null; // 自学习：从"详情"抽屉请求推断的详情接口模板，如 /api/v1/customer/campaigns/{id}/detail

  function absorbJson(data, url) {
    if (!data || typeof data !== 'object') return;

    // 自学习详情接口：路径形如 .../campaigns/<数字> 或 .../campaigns/<数字>/detail
    // （ban-failure-counts 的 id 在 query 里，不会命中此正则）
    if (url && /\/campaigns\//.test(url)) {
      try {
        const pathname = new URL(url, location.href).pathname;
        const m = pathname.match(/^(.*\/campaigns\/)(\d+)(\/[a-z-]*)?$/);
        if (m) {
          const learned = m[1] + '{id}' + (m[3] || '');
          if (learned !== learnedDetailTpl) {
            // /detail 结尾的优先于无后缀（probe-smsplist 之类不含模板信息）
            const better =
              !learnedDetailTpl ||
              (learned.endsWith('/detail') && !learnedDetailTpl.endsWith('/detail'));
            if (better) {
              learnedDetailTpl = learned;
              detailTried.clear(); // 换用新接口后重新探测所有行
              log('学习到详情接口:', learnedDetailTpl);
            }
          }
        }
      } catch (e) { /* ignore */ }
    }

    const scan = (v, depth) => {
      if (depth > 6 || v == null || typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach((x) => scan(x, depth + 1)); return; }
      tryAbsorbRecord(v);
      for (const k in v) scan(v[k], depth + 1);
    };
    scan(data, 0);
    absorbTemplates(data, url);
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
    // 捕获鉴权头（接口探测返回 401 的原因：令牌在 Authorization 头里而非 Cookie）
    const origSH = XHR.prototype.setRequestHeader;
    XHR.prototype.setRequestHeader = function (k, v) {
      try {
        const lk = String(k).toLowerCase();
        if (lk === 'authorization' || lk.includes('token')) authHeaders[lk] = v;
      } catch (e) { /* ignore */ }
      return origSH.call(this, k, v);
    };
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
          absorbJson(data, url);
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
            absorbJson(JSON.parse(t), url);
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
        headers: Object.keys(authHeaders).length ? authHeaders : undefined,
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
    // 自学习的详情接口优先
    const candidates = [];
    if (learnedDetailTpl) candidates.push(learnedDetailTpl.replace('{id}', id));
    for (const tpl of DETAIL_API_CANDIDATES) candidates.push(tpl.replace('{id}', id));
    for (const path of candidates) {
      const url = location.origin + path;
      const { status, data } = await gmGet(url);
      if (DEBUG) log(`详情探测 ${status}`, url);
      if (data) {
        absorbJson(data, url);
        return data;
      }
    }
    return null;
  }

  async function buildTplMap() {
    // 优先复用嗅探到的查询串（含 countryCode，探测空参可能返回空列表）
    const dynamic = lastTplQuery
      ? [{ host: '', path: '/api/v1/customer/channel-templates' + lastTplQuery }]
      : [];
    for (const { host, path } of [...dynamic, ...TEMPLATE_API_CANDIDATES]) {
      const base = host || location.origin;
      const url = base + path;
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
        log(`模板接口命中: ${base}${path}，共 ${hit} 条模板`);
        saveTplCache();
        updatePendingContent();
        return true;
      }
    }
    dwarn('模板接口候选未命中（稍后自动重试，请留意控制台样本输出）');
    return false;
  }

  // 模板映射到位后，回填已注入行里的"获取中…"占位
  function updatePendingContent(failed) {
    document.querySelectorAll('.linsms-tpl-content[data-linsms-pending]').forEach((el) => {
      const no = el.dataset.linsmsPending;
      const content = tplContentMap.get(String(no));
      if (content != null) {
        el.textContent = content;
        delete el.dataset.linsmsPending;
      } else if (failed) {
        el.textContent = '未找到模版内容（接口未命中）';
        el.dataset.linsmsFailed = '1';
        delete el.dataset.linsmsPending;
      }
    });
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

  function findRecForRow(row) {
    // 1) 行内 10+ 位纯数字 = 任务名本身
    const m = (row.textContent || '').match(/\b(\d{10,})\b/);
    if (m && campaignMap.has(m[1])) return campaignMap.get(m[1]);
    // 2) 任务单元格里的短数字（如 6725）= 任务 ID，查主索引
    const taskCell = row.cells?.[1];
    if (taskCell) {
      const nums = taskCell.textContent.match(/(?<![/:\d.])(\d{2,8})(?![/:\d.])/g) || [];
      for (const n of nums) {
        const r = recById.get(n);
        if (r) return r;
      }
    }
    return m ? campaignMap.get(m[1]) : null;
  }

  async function renderRow(table, row, colIdx) {
    if (rowDone.has(row)) return;
    const cell = row.cells?.[colIdx];
    if (!cell) return;
    const rec = findRecForRow(row);
    if (!rec) return;

    let tplNo = rec.tplNo;

    // 列表接口没带模板编号 → 探测详情接口（每个 id 只探一次，防刷屏）
    if (tplNo == null && rec.id != null && !detailTried.has(String(rec.id))) {
      detailTried.add(String(rec.id));
      await fetchDetail(rec.id);
      tplNo = recById.get(String(rec.id))?.tplNo;
    }
    if (tplNo == null) return; // 拿不到编号就不注入

    // 详情若直接带了文案字段，优先用（省一次模板映射查询）
    const directContent = deepFind(rec, TPL_CONTENT_KEYS);
    const content = directContent != null ? String(directContent) : tplContentMap.get(String(tplNo));

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
    updatePendingContent();
  }

  /* ---------------- 4. 启动 ---------------- */
  function boot() {
    const ver = typeof GM_info !== 'undefined' ? GM_info.script.version : '?';
    log(`v${ver} 启动`, location.href);
    loadTplCache();

    // 页面在 /campaigns 时加载模板映射（不依赖嗅探）；
    // 5s 后若仍无模板数据，带上嗅探到的查询串（countryCode 等）重试一次
    if (/\/campaigns/.test(location.pathname + location.hash)) {
      buildTplMap();
      setTimeout(() => {
        if (tplContentMap.size === 0) {
          log('模板映射为空，复用嗅探查询串重试');
          buildTplMap();
        }
      }, 5000);
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
