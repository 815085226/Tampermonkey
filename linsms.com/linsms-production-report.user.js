// ==UserScript==
// @name         linsms 生产报表导出
// @namespace    gavin.sms62
// @version      0.1.1
// @description  adm.linsms.com/monitoring-reports 页面数据加载完成后，在「查询日报」前显示「生产报表」按钮；点击后按 国家/企业/用户/通道 汇总导出 CSV，单价从 /user-products 按 用户名+国家 匹配（国家为 ISO2 码，如 BR/ID/IN/MX）
// @author       Gavin
// @match        http://adm.linsms.com/*
// @match        https://adm.linsms.com/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
  'use strict';

  /* ======================= 可配置区 ======================= */
  const DEBUG = true; // 控制台打印嗅探到的接口，便于核对/调整字段

  // 报表记录字段候选（按顺序取第一个非空值）
  const COUNTRY_KEYS = ['country', 'countryName', 'nation', 'countryCn', 'countryChineseName'];
  const ENTERPRISE_KEYS = ['enterprise', 'enterpriseName', 'company', 'companyName', 'customer', 'customerName', 'client', 'clientName', 'customName'];
  const USER_KEYS = ['userName', 'username', 'userAccount', 'account', 'accountName', 'accountNo', 'loginName'];
  const CHANNEL_KEYS = ['supplier', 'supplierName', 'channel', 'channelName', 'channelCode', 'productName', 'route', 'routeName', 'gateway', 'gatewayName'];
  const COUNT_KEYS = ['billingCount', 'billedCount', 'chargeCount', 'feeCount', 'billingNum', 'billCount', 'sendMessageCount', 'sendCount', 'submitCount', 'count', 'num', 'quantity', 'total'];

  // user-products（用户产品/单价）记录字段候选
  const UP_USER_KEYS = USER_KEYS;
  const UP_PRICE_KEYS = ['unitPrice', 'price', 'smsPrice', 'salePrice', 'pricePerMsg', 'fee'];
  const UP_COUNTRY_KEYS = COUNTRY_KEYS;

  // 单价缓存
  const PRICE_CACHE_KEY = 'linsms_userprice_map_v1';
  const PRICE_CACHE_TTL = 24 * 3600 * 1000; // 24h

  // 兜底：生成报表时若价格缺失，尝试主动拉取 user-products 列表接口
  const USER_PRODUCTS_API_CANDIDATES = [
    '/api/user-products?pageNum=1&pageSize=2000',
    '/api/user/products?pageNum=1&pageSize=2000',
    '/api/userProducts?pageNum=1&pageSize=2000',
    '/api/user-product/list?pageNum=1&pageSize=2000',
  ];

  // 页面国家字段为 ISO2 码（实测：BR/ID/IN/MX）；通道名内是国家全名（CG-Brazil-BytePlus）。
  // 此映射用于两侧格式不一致时桥接匹配（key/value 均为小写）
  const ISO2_NAME = {
    af:'afghanistan', al:'albania', dz:'algeria', ar:'argentina', am:'armenia', au:'australia',
    at:'austria', az:'azerbaijan', bd:'bangladesh', by:'belarus', be:'belgium', bo:'bolivia',
    ba:'bosnia and herzegovina', br:'brazil', bg:'bulgaria', kh:'cambodia', cm:'cameroon',
    ca:'canada', cl:'chile', cn:'china', co:'colombia', cr:'costa rica', hr:'croatia',
    cy:'cyprus', cz:'czech republic', dk:'denmark', do:'dominican republic', ec:'ecuador',
    eg:'egypt', sv:'el salvador', ee:'estonia', et:'ethiopia', fi:'finland', fr:'france',
    ge:'georgia', de:'germany', gh:'ghana', gr:'greece', gt:'guatemala', hn:'honduras',
    hk:'hong kong', hu:'hungary', is:'iceland', in:'india', id:'indonesia', iq:'iraq',
    ie:'ireland', il:'israel', it:'italy', jp:'japan', jo:'jordan', kz:'kazakhstan',
    ke:'kenya', kw:'kuwait', kg:'kyrgyzstan', la:'laos', lv:'latvia', lb:'lebanon',
    ly:'libya', lt:'lithuania', lu:'luxembourg', mo:'macao', my:'malaysia', mv:'maldives',
    mt:'malta', mx:'mexico', md:'moldova', mn:'mongolia', me:'montenegro', ma:'morocco',
    mm:'myanmar', np:'nepal', nl:'netherlands', nz:'new zealand', ni:'nicaragua',
    ng:'nigeria', mk:'north macedonia', no:'norway', om:'oman', pk:'pakistan', pa:'panama',
    py:'paraguay', pe:'peru', ph:'philippines', pl:'poland', pt:'portugal', qa:'qatar',
    ro:'romania', ru:'russia', sa:'saudi arabia', rs:'serbia', sg:'singapore', sk:'slovakia',
    si:'slovenia', za:'south africa', kr:'south korea', es:'spain', lk:'sri lanka',
    se:'sweden', ch:'switzerland', tw:'taiwan', tj:'tajikistan', tz:'tanzania', th:'thailand',
    tn:'tunisia', tr:'turkey', tm:'turkmenistan', ug:'uganda', ua:'ukraine', ae:'united arab emirates',
    gb:'united kingdom', us:'united states', uy:'uruguay', uz:'uzbekistan', ve:'venezuela',
    vn:'vietnam', ye:'yemen', zw:'zimbabwe', zm:'zambia',
  };
  /* ======================================================= */

  const log = (...a) => console.log('%c[生产报表]', 'color:#e91e63;font-weight:bold', ...a);
  const dwarn = (...a) => DEBUG && console.warn('%c[生产报表]', 'color:#ff9800;font-weight:bold', ...a);

  /* ---------------- 状态（内存态：刷新即重置） ---------------- */
  let reportRows = [];        // 监控报表页嗅探到的原始记录
  const seenSig = new Set();  // 记录去重
  let showBtn = false;        // 数据加载完成后才显示按钮
  let fetchTried = false;     // 兜底接口本次会话是否已尝试

  // 单价映射（GM 持久化，独立于报表数据）
  let priceByKey = new Map();  // "user|country"(小写) -> price
  let priceByUser = new Map(); // user(小写) -> price

  /* ---------------- 工具函数 ---------------- */
  const norm = (v) => (v == null ? '' : String(v).trim());
  const normLow = (v) => norm(v).toLowerCase();

  function toNum(v) {
    if (v == null || v === '') return NaN;
    const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
    return isNaN(n) ? NaN : n;
  }

  // 在对象内按候选 key 取值（key 大小写不敏感）
  function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    const lower = {};
    for (const k in obj) lower[k.toLowerCase()] = obj[k];
    for (const k of keys) {
      const v = lower[k.toLowerCase()];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  // 递归遍历 JSON 中所有数组元素对象
  function walkRecords(data, cb, depth = 0) {
    if (depth > 6 || data == null || typeof data !== 'object') return;
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item && typeof item === 'object' && !Array.isArray(item)) cb(item);
        walkRecords(item, cb, depth + 1);
      }
      return;
    }
    for (const k in data) walkRecords(data[k], cb, depth + 1);
  }

  /* ---------------- 单价映射（user-products） ---------------- */
  function loadPriceCache() {
    try {
      const c = JSON.parse(GM_getValue(PRICE_CACHE_KEY, '{}'));
      if (c.ts && Date.now() - c.ts < PRICE_CACHE_TTL && c.map) {
        for (const [k, v] of Object.entries(c.map)) {
          const [u, ...rest] = k.split('|');
          const country = rest.join('|');
          priceByKey.set(k, v);
          if (!priceByUser.has(u)) priceByUser.set(u, v);
        }
        log('已加载单价缓存', priceByKey.size, '条');
      }
    } catch (e) { /* ignore */ }
  }

  function savePriceCache() {
    GM_setValue(PRICE_CACHE_KEY, JSON.stringify({ ts: Date.now(), map: Object.fromEntries(priceByKey) }));
  }

  function absorbPriceRecord(rec) {
    const user = norm(pick(rec, UP_USER_KEYS));
    const price = toNum(pick(rec, UP_PRICE_KEYS));
    if (!user || isNaN(price)) return false;
    const country = normLow(pick(rec, UP_COUNTRY_KEYS));
    const key = `${user.toLowerCase()}|${country}`;
    priceByKey.set(key, price);
    if (!priceByUser.has(user.toLowerCase())) priceByUser.set(user.toLowerCase(), price);
    return true;
  }

  // 国家等价判断：ISO2 码与全名桥接，其余必须全等（避免 niger/nigeria 之类包含误配）
  function countryEq(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const an = ISO2_NAME[a] || '';
    const bn = ISO2_NAME[b] || '';
    return (an && an === b) || (bn && bn === a) || (an && an === bn);
  }

  // 按 用户名+国家 匹配单价；找不到返回 null
  function matchPrice(user, country) {
    const u = normLow(user);
    const c = normLow(country);
    if (!u) return null;
    let p = priceByKey.get(`${u}|${c}`);
    if (p != null) return p;
    // 同用户名下做国家等价匹配（ISO2 码 ↔ 全名），仅一个维度可匹配时直接采用
    let fallback = priceByUser.get(u);
    if (fallback == null) fallback = null;
    let matched = null;
    for (const [k, v] of priceByKey) {
      if (!k.startsWith(u + '|')) continue;
      const kc = k.slice(u.length + 1);
      if (!kc || !c) { matched = v; break; } // 缓存只存了用户维度
      if (countryEq(kc, c)) { matched = v; break; }
    }
    return matched ?? fallback;
  }

  /* ---------------- 报表数据嗅探 ---------------- */
  function isReportPage() {
    return /monitoring-reports/.test(location.pathname + location.hash);
  }
  function isUserProductsPage() {
    return /user-products/.test(location.pathname + location.hash);
  }

  function recordSig(rec) {
    try { return JSON.stringify(rec); } catch (e) { return null; }
  }

  function absorbReportRecord(rec) {
    // 形状要求：有通道/供应商字段 + 计费条数为数字（可为 0）
    const channel = pick(rec, CHANNEL_KEYS);
    const count = toNum(pick(rec, COUNT_KEYS));
    if (norm(channel) === '' || isNaN(count)) return false;
    const user = pick(rec, USER_KEYS);
    const enterprise = pick(rec, ENTERPRISE_KEYS);
    if (norm(user) === '' && norm(enterprise) === '') return false;
    const sig = recordSig(rec);
    if (sig && seenSig.has(sig)) return true;
    if (sig) seenSig.add(sig);
    reportRows.push(rec);
    return true;
  }

  function handleJson(url, data) {
    if (DEBUG) log('JSON:', url);

    // user-products 单价：任何页面都吸收（含兜底接口）
    let priceHit = 0;
    walkRecords(data, (rec) => { if (absorbPriceRecord(rec)) priceHit++; });
    if (priceHit > 0) {
      log(`捕获单价记录 ${priceHit} 条（缓存共 ${priceByKey.size}）`);
      savePriceCache();
    }

    // 监控报表数据：仅报表页吸收
    if (isReportPage()) {
      let hit = 0;
      walkRecords(data, (rec) => { if (absorbReportRecord(rec)) hit++; });
      if (hit > 0) {
        log(`捕获报表记录 ${hit} 条（累计 ${reportRows.length}） ← ${url}`);
        showBtn = true;
        scheduleSync();
      }
    }
  }

  function hookXhr() {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__linsmsUrl = url;
      return origOpen.call(this, method, url, ...rest);
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        const url = this.__linsmsUrl || '';
        const ct = this.getResponseHeader?.('content-type') || '';
        if (!ct.includes('json')) return;
        try { handleJson(url, JSON.parse(this.responseText)); } catch (e) { /* 非 JSON 忽略 */ }
      });
      return origSend.apply(this, args);
    };
  }

  function hookFetch() {
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        const ct = res.headers?.get?.('content-type') || '';
        if (ct.includes('json')) {
          res.clone().json().then((data) => handleJson(url, data)).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return res;
    };
  }

  /* ---------------- 兜底：主动拉取 user-products ---------------- */
  async function tryFetchUserProducts() {
    if (fetchTried) return;
    fetchTried = true;
    for (const path of USER_PRODUCTS_API_CANDIDATES) {
      try {
        const res = await fetch(location.origin + path, { credentials: 'include' });
        if (!res.ok) continue;
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('json')) continue;
        const data = await res.json();
        const before = priceByKey.size;
        walkRecords(data, (rec) => absorbPriceRecord(rec));
        if (priceByKey.size > before) {
          log(`兜底单价接口命中: ${path}（缓存共 ${priceByKey.size}）`);
          savePriceCache();
          return;
        }
      } catch (e) { /* 下一个候选 */ }
    }
    dwarn('兜底单价接口均未命中，请先访问一次 /user-products 页面让脚本缓存单价');
  }

  // 全名 → ISO2 码（小写），找不到原样返回
  function toIso2(name) {
    const s = normLow(name);
    if (ISO2_NAME[s]) return s;
    for (const [code, full] of Object.entries(ISO2_NAME)) {
      if (full === s || full.includes(s) || s.includes(full)) return code;
    }
    return s;
  }

  /* ---------------- 字段提取 ---------------- */
  function getCountry(rec) {
    const c = norm(pick(rec, COUNTRY_KEYS));
    if (c) return c;
    // 回退：从通道名解析，如 "CG—Brazil—BytePlus—8cb620fd" → Brazil → br
    const channel = norm(pick(rec, CHANNEL_KEYS));
    if (channel) {
      const parts = channel.split(/[—–\-_]+/).map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) return toIso2(parts[1]);
      if (parts.length === 1) return toIso2(parts[0]);
    }
    return '';
  }

  /* ---------------- 报表生成与 CSV 导出 ---------------- */
  function fmt2(n) { return (Math.round(n * 100) / 100).toFixed(2); }

  async function generateReport() {
    if (!reportRows.length) { alert('尚未捕获到报表数据，请先在页面完成查询'); return; }

    // 价格缺失时尝试兜底拉取
    const missing = reportRows.some((rec) => {
      const user = norm(pick(rec, USER_KEYS));
      const price = toNum(pick(rec, UP_PRICE_KEYS));
      return user && matchPrice(user, getCountry(rec)) == null && isNaN(price);
    });
    if (missing) await tryFetchUserProducts();

    // 分组：国家 | 企业 | 用户 | 通道
    const groups = new Map();
    let noPriceCount = 0;
    for (const rec of reportRows) {
      const country = getCountry(rec);
      const enterprise = norm(pick(rec, ENTERPRISE_KEYS));
      const user = norm(pick(rec, USER_KEYS));
      const channel = norm(pick(rec, CHANNEL_KEYS));
      const count = toNum(pick(rec, COUNT_KEYS)) || 0;
      // 单价优先 user-products 匹配，回退记录自带价格
      let price = matchPrice(user, country);
      if (price == null) {
        const own = toNum(pick(rec, UP_PRICE_KEYS));
        if (!isNaN(own)) price = own;
      }
      if (price == null) noPriceCount++;

      const key = `${country}\u0001${enterprise}\u0001${user}\u0001${channel}`;
      const g = groups.get(key) || { country, enterprise, user, channel, count: 0, price: null };
      g.count += count;
      if (price != null) g.price = price; // 同组单价应一致，取最后匹配值
      groups.set(key, g);
    }

    // 排序：国家 → 企业 → 用户 → 通道
    const rows = [...groups.values()].sort((a, b) =>
      a.country.localeCompare(b.country) || a.enterprise.localeCompare(b.enterprise) ||
      a.user.localeCompare(b.user) || a.channel.localeCompare(b.channel));

    // 汇总
    let totalCount = 0, totalAmount = 0;
    for (const r of rows) {
      totalCount += r.count;
      if (r.price != null) totalAmount += r.count * r.price;
    }

    // CSV（带 BOM，Excel 直接打开不乱码）
    const esc = (s) => {
      s = norm(s);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['国家,企业,用户,通道,计费条数,单价,金额'];
    for (const r of rows) {
      const amount = r.price != null ? fmt2(r.count * r.price) : '';
      lines.push([esc(r.country), esc(r.enterprise), esc(r.user), esc(r.channel),
        r.count, r.price != null ? r.price : '', amount].join(','));
    }
    lines.push([`合计,,,,${totalCount},,${fmt2(totalAmount)}`].join(','));

    if (noPriceCount > 0) {
      dwarn(`有 ${noPriceCount} 条记录未匹配到单价（金额留空）。请先访问 /user-products 页面，或核对用户名/国家字段`);
    }

    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `生产报表_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.csv`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    log(`已导出 ${name}：${rows.length} 组，计费条数合计 ${totalCount}，金额合计 ${fmt2(totalAmount)}`);
    if (noPriceCount > 0) alert(`已导出，但有 ${noPriceCount} 条记录未匹配到单价（金额留空）。\n请先访问 /user-products 页面后重试。`);
  }

  /* ---------------- 按钮：插在「查询日报」前 ---------------- */
  const BTN_ID = 'linsms-prod-report-btn';

  function findAnchorBtn() {
    for (const b of document.querySelectorAll('button')) {
      const t = (b.textContent || '').replace(/\s/g, '');
      if (t.includes('查询日报')) return b;
    }
    return null;
  }

  function syncButton() {
    const anchor = findAnchorBtn();
    if (!anchor || !anchor.parentNode) return;

    let btn = document.getElementById(BTN_ID);
    if (!showBtn) {
      if (btn) btn.remove();
      return;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.id = BTN_ID;
      // 复用站点按钮样式（Element UI），换色区分
      btn.className = 'el-button el-button--warning';
      btn.type = 'button';
      const span = document.createElement('span');
      span.textContent = '生产报表';
      btn.appendChild(span);
      btn.addEventListener('click', () => { generateReport().catch((e) => { console.error(e); alert('生成报表失败：' + e.message); }); });
    }
    if (btn.style.marginLeft !== '12px') btn.style.marginLeft = '12px';
    if (btn.previousElementSibling !== anchor || btn.parentNode !== anchor.parentNode) {
      anchor.parentNode.insertBefore(btn, anchor);
    }
  }

  let syncTimer = null;
  function scheduleSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(() => { syncTimer = null; syncButton(); }, 200);
  }

  /* ---------------- 路由守卫：离开报表页重置 ---------------- */
  let lastOnPage = null;
  function routeWatch() {
    const on = isReportPage();
    if (lastOnPage === null) { lastOnPage = on; return; }
    if (lastOnPage !== on) {
      lastOnPage = on;
      if (!on) {
        reportRows = [];
        seenSig.clear();
        showBtn = false;
        fetchTried = false;
        const btn = document.getElementById(BTN_ID);
        if (btn) btn.remove();
        log('离开报表页，数据已重置');
      }
    }
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    log('v0.1.1 启动', location.href);
    loadPriceCache();
    hookXhr();
    hookFetch();

    const mo = new MutationObserver(() => { scheduleSync(); routeWatch(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(routeWatch, 1000);
    scheduleSync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
