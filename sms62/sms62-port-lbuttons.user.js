// ==UserScript==
// @name         sms62 端口页 L1-L5 设备快选按钮
// @namespace    gavin.sms62
// @version      1.15.0
// @description  在 http://web.sms62.com/mkt/port 的"合伙人"后面增加 L 设备组按钮（组名从业务配置 LOCATION:DEVICES:CONFIG 动态获取，新增组自动出现），一键把"设备"筛选条件设为对应设备组；并在筛选栏与列表之间增加可折叠的 L 组数据报表（发送总数>500 数量 + 套餐<1000 数量 + 发不出去数量 + 各状态分布）；「发不出去」数字可点击 → 设备组 + 封卡类状态筛选并勾选满足规则的行（每次自动筛选前先点页面「重置」清空历史条件）；另在 /mkt/send-task 的「批量创建失败补发任务」弹窗里，表格下方自动显示汇总（任务数 + 提交失败合计 + 发送失败合计）
// @author       Gavin
// @match        http://web.sms62.com/*
// @match        https://web.sms62.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ===== 兜底配置：接口拉取失败时使用（正常情况以 LOCATION:DEVICES:CONFIG 接口值为准）=====
  const FALLBACK_GROUPS = {
    L1: ['D1', 'D2', 'D3', 'L1D4', 'L1D5', 'L1D6', 'L1D7'],
    L2: ['D11', 'D12', 'D13'],
    L3: ['D6', 'D7', 'D14'],
    L4: ['D4', 'D5', 'D15'],
    L5: ['D8', 'D9', 'D10'],
  };
  const AUTO_SEARCH = true;   // 选完设备后自动点击"查询"，改为 false 则只设置筛选条件
  const PATH_KEYWORD = '/mkt/port';
  const CONFIG_API = '/prod-api/manage/sysCconfig/list?pageNum=1&pageSize=200';
  const CONFIG_KEY = 'LOCATION:DEVICES:CONFIG'; // 仅用于日志提示
  const PORT_LIST_API = '/prod-api/business/port/list';           // 端口列表（rows/total 分页）
  const STATUS_DICT_API = '/prod-api/system/dict/data/type/sys_port_status'; // 端口状态字典
  const REPORT_ID = 'gavin-lreport';
  // 套餐阈值：统计「套餐 < N」的端口数量（报表头部可调整），存入 sessionStorage 刷新后保留
  const PKG_THRESHOLD_KEY = 'gavin-lbtn-pkg-threshold';
  const PKG_THRESHOLD_DEFAULT = 1000;
  let pkgThreshold = loadPkgThreshold();

  function loadPkgThreshold() {
    try {
      const v = parseInt(sessionStorage.getItem(PKG_THRESHOLD_KEY) || '', 10);
      if (Number.isFinite(v) && v >= 0) return v;
    } catch (e) { /* sessionStorage 不可用时用默认值 */ }
    return PKG_THRESHOLD_DEFAULT;
  }

  function savePkgThreshold(v) {
    try {
      sessionStorage.setItem(PKG_THRESHOLD_KEY, String(v));
    } catch (e) { /* 忽略写入失败 */ }
  }

  let lastRows = [];          // 最近一次拉到的端口数据，调整阈值时免重新请求

  const BAR_ID = 'gavin-lbar';
  const log = (...a) =>
    console.log('%c[L按钮]', 'color:#409eff;font-weight:bold', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ===== 当前生效的分组（配置加载成功后会被替换）=====
  let GROUPS_CURRENT = { ...FALLBACK_GROUPS };
  let configLoaded = false;

  // ===== 捕获站点的 Authorization 请求头（token 存于 Admin-Token / 内存，脚本无法直接读取时靠挂钩获取）=====
  let AUTH = null;
  try {
    const m = document.cookie.match(/(?:^|;\s*)Admin-Token=([^;]+)/);
    if (m) AUTH = decodeURIComponent(m[1]);
    if (AUTH && !/^Bearer\s/i.test(AUTH)) AUTH = 'Bearer ' + AUTH;
  } catch (e) { /* ignore */ }

  // 站点发生写操作（推送/改状态/充值等非 GET 接口调用）后，报表缓存即视为不新鲜
  let CACHE_DIRTY = false;
  function markCacheDirty() { CACHE_DIRTY = true; }

  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const headers = new Headers(
        (init && init.headers) ||
          (typeof input === 'object' && input && input.headers) ||
          undefined
      );
      const a = headers.get('Authorization');
      if (a) AUTH = a;

      const method = String(
        (init && init.method) || (input && input.method) || 'GET'
      ).toUpperCase();
      const url = typeof input === 'string' ? input : String((input && input.url) || '');
      if (method !== 'GET' && /\/prod-api\//.test(url)) markCacheDirty();
    } catch (e) { /* ignore */ }
    return _fetch.apply(this, arguments);
  };
  const _setReqHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (String(k).toLowerCase() === 'authorization') AUTH = v;
    return _setReqHeader.apply(this, arguments);
  };
  const _xopen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__gavinMethod = String(m || 'GET').toUpperCase();
    this.__gavinUrl = String(u || '');
    return _xopen.apply(this, arguments);
  };
  const _xsend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (
      this.__gavinMethod &&
      this.__gavinMethod !== 'GET' &&
      /\/prod-api\//.test(this.__gavinUrl || '')
    ) {
      markCacheDirty();
    }
    return _xsend.apply(this, arguments);
  };

  // ===== 从 /mkt/config 的业务配置接口拉取 LOCATION:DEVICES:CONFIG =====
  // 在响应里深度查找形如 {"L1":"D1,D2,...","L2":...} 的配置值（不依赖具体字段名）
  function findGroupsDeep(o, depth) {
    if (o == null || depth > 6) return null;
    if (typeof o === 'string') {
      const s = o.trim();
      if (s.startsWith('{') && /"?\bL\d+\b"?/.test(s)) {
        try {
          const p = JSON.parse(s);
          if (p && typeof p === 'object' && p.L1) return p;
        } catch (e) { /* 不是 JSON，跳过 */ }
      }
      return null;
    }
    if (Array.isArray(o)) {
      for (const it of o) {
        const r = findGroupsDeep(it, depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (typeof o === 'object') {
      if (typeof o.L1 === 'string' && o.L1.length) return o; // 已是对象形式
      for (const v of Object.values(o)) {
        const r = findGroupsDeep(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  // 组名自然排序：L2 排在 L10 前面
  function sortGroups(g) {
    const out = {};
    Object.keys(g)
      .sort((a, b) => {
        const na = parseInt(a.replace(/\D/g, ''), 10) || 0;
        const nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
        return na - nb || a.localeCompare(b);
      })
      .forEach((k) => (out[k] = String(g[k]).split(/[,，\s]+/).filter(Boolean)));
    return out;
  }

  async function loadConfig() {
    for (let i = 0; i < 10 && !configLoaded; i++) {
      try {
        if (AUTH) {
          const res = await _fetch(CONFIG_API, {
            headers: { Authorization: AUTH },
            credentials: 'include',
          });
          const json = await res.json();
          const found = findGroupsDeep(json, 0);
          if (found) {
            GROUPS_CURRENT = sortGroups(found);
            configLoaded = true;
            log('✅ 已从业务配置 ' + CONFIG_KEY + ' 加载设备分组:', JSON.stringify(GROUPS_CURRENT));
            refreshBar(); // 配置到位后重建按钮（组名/数量可能变化）
            if (document.getElementById(REPORT_ID)) refreshReport(); // 报表按新分组重算
            return;
          }
          log('接口返回中未找到 ' + CONFIG_KEY + ' 配置值，使用内置兜底配置');
        }
      } catch (e) {
        log('拉取设备分组配置失败（第 ' + (i + 1) + ' 次）:', e && e.message);
      }
      await sleep(3000); // 等待页面自身请求带出 token 后重试
    }
    if (!configLoaded) log('⚠️ 配置拉取未成功，继续使用内置兜底配置');
  }

  // ===== L 组数据报表：筛选栏与列表之间的可折叠面板 =====
  let statusDict = {}; // status 值 -> 标签

  async function apiGet(url) {
    const res = await _fetch(url, {
      headers: AUTH ? { Authorization: AUTH } : {},
      credentials: 'include',
    });
    return res.json();
  }

  // 拉全量端口数据：先取第 1 页拿 total，剩余页并行请求（比串行快数倍）
  const REPORT_CACHE_KEY = 'gavin-lreport-cache-v3'; // v3：新增 充值次数/失败数量 字段，旧结构缓存自动作废
  const REPORT_CACHE_TTL = 30 * 60 * 1000; // 缓存最长可用 30 分钟（超过直接丢弃）
  const REPORT_FRESH_TTL = 30 * 1000;      // 新鲜期：30 秒内直接用、不再请求
  let reportDataPromise = null; // 进行中的拉取请求（防重复）
  let lastDataTs = 0;           // 当前展示数据的实际抓取时间
  let reportRefreshing = false; // 报表刷新中（防并发重复请求）

  function readCache() {
    try {
      const c = JSON.parse(sessionStorage.getItem(REPORT_CACHE_KEY) || 'null');
      if (!c || !Array.isArray(c.rows) || !c.rows.length) return null;
      if (typeof c.ts !== 'number' || Date.now() - c.ts >= REPORT_CACHE_TTL) {
        sessionStorage.removeItem(REPORT_CACHE_KEY); // 过期太久，清掉
        return null;
      }
      if (!('p' in c.rows[0]) || !('n' in c.rows[0])) return null; // 旧结构（缺套餐/充值次数）视为无效
      return c;
    } catch (e) { /* 缓存损坏则忽略 */ }
    return null;
  }

  function writeCache(rows) {
    try {
      // 只保留统计需要的字段，避免超出 sessionStorage 容量
      const slim = rows.map((r) => ({
        d: String(r.deviceName ?? ''),        // 设备名
        t: Number(r.totalSend) || 0,         // 发送总数
        s: r.status,                         // 状态
        p: r.pkgs,                           // 套餐
        n: Number(r.topupCount) || 0,        // 充值次数（充值测试次数同此字段）
        f: Number(r.recentSendFailCount) || 0, // 失败数量（连续失败）
      }));
      sessionStorage.setItem(REPORT_CACHE_KEY, JSON.stringify({ ts: Date.now(), rows: slim }));
    } catch (e) { /* 存不下就算了 */ }
  }

  function fetchPortPage(pageNum, pageSize) {
    return apiGet(PORT_LIST_API + '?pageNum=' + pageNum + '&pageSize=' + pageSize);
  }

  async function fetchAllPorts(force) {
    if (!force) {
      const cached = readCache();
      if (cached) {
        log('报表使用本地缓存（' + Math.round((Date.now() - cached.ts) / 1000) + ' 秒前），点「刷新报表」强制更新');
        return cached.rows;
      }
    }
    if (reportDataPromise) return reportDataPromise;

    reportDataPromise = (async () => {
      const pageSize = 1000; // 大页减少请求轮数
      const first = await fetchPortPage(1, pageSize);
      if (first.code !== undefined && first.code !== 200) throw new Error(first.msg || ('code ' + first.code));
      const rows = [...(first.rows || first.data?.rows || [])];
      const total = first.total ?? first.data?.total ?? rows.length;
      const pages = Math.min(Math.ceil(total / pageSize) || 1, 20);

      // 第 2..N 页并行拉取
      if (pages > 1) {
        const rest = await Promise.all(
          Array.from({ length: pages - 1 }, (_, i) =>
            fetchPortPage(i + 2, pageSize).catch(() => ({ rows: [] }))
          )
        );
        for (const j of rest) rows.push(...(j.rows || j.data?.rows || []));
      }
      writeCache(rows);
      CACHE_DIRTY = false; // 已拿到最新数据，失效标记复位
      lastDataTs = Date.now();
      return rows;
    })();

    try {
      return await reportDataPromise;
    } finally {
      reportDataPromise = null;
    }
  }

  // 状态字典：缓存到 sessionStorage，保证缓存秒开时状态文本也能立刻显示
  const STATUS_DICT_CACHE_KEY = 'gavin-sdict-cache-v1';
  const STATUS_DICT_TTL = 24 * 60 * 60 * 1000; // 字典几乎不变，缓存 1 天

  function readDictCache() {
    try {
      const c = JSON.parse(sessionStorage.getItem(STATUS_DICT_CACHE_KEY) || 'null');
      if (c && c.map && Object.keys(c.map).length && Date.now() - c.ts < STATUS_DICT_TTL) {
        return c.map;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  async function loadStatusDict(force) {
    if (!force) {
      const cachedDict = readDictCache();
      if (cachedDict) { statusDict = cachedDict; return statusDict; }
    }
    for (let i = 0; i < 3; i++) {
      try {
        const json = await apiGet(STATUS_DICT_API);
        const list = (json && json.data) || [];
        if (!list.length) throw new Error('字典为空');
        const map = {};
        for (const d of list) map[String(d.dictValue)] = d.dictLabel;
        statusDict = map;
        try {
          sessionStorage.setItem(
            STATUS_DICT_CACHE_KEY,
            JSON.stringify({ ts: Date.now(), map })
          );
        } catch (e) { /* 存不下就算了 */ }
        return statusDict;
      } catch (e) {
        if (i === 2) log('状态字典拉取失败，报表将显示状态原始值:', e && e.message);
        else await sleep(800);
      }
    }
    return statusDict;
  }

  // 确保状态字典就绪（有本地缓存时零等待）
  async function ensureStatusDict() {
    if (Object.keys(statusDict).length) return statusDict;
    return loadStatusDict();
  }

  const statusLabel = (v) => statusDict[String(v)] || String(v ?? '未知');

  // ===== 「发不出去」判定 =====
  // 条件（全部满足）：
  //   1) 状态标签含「封卡」
  //   2) 充值次数(topupCount) >= CANT_SEND_MIN_TOPUP（即 >= 1）
  //   3) 失败数量(recentSendFailCount) >= 有效发送数，且有效发送数需 > 0
  //      有效发送数 = 充值次数 > 1 ? 发送总数 - (充值次数-1) * PACKAGE_UNIT
  //                                : 发送总数（不扣减）
  const CANT_SEND_MIN_TOPUP = 1; // 充值次数下限（含），即「充值次数 >= 1」
  const PACKAGE_UNIT = 1500;     // 每次充值对应的发送额度（充值次数 >1 时按 (N-1) 扣减）
  // 「发送总数 > N」统计：固定阈值，不跟随套餐阈值、也不提供输入框
  const SEND_TOTAL_THRESHOLD = 500;

  // 纯判定（报表统计与表格逐行勾选共用）：statusText 为状态中文标签
  function cantSendHit(totalSend, topup, fail, statusText) {
    if (!String(statusText || '').includes('封卡')) return false; // 1) 封卡类状态
    if (!(topup >= CANT_SEND_MIN_TOPUP)) return false;            // 2) 充值次数 >= 1
    // 3) 有效发送数：仅当充值次数 > 1 时扣减充值带来的额度
    const effective =
      topup > 1 ? totalSend - (topup - 1) * PACKAGE_UNIT : totalSend;
    if (!(effective > 0)) return false;
    return fail >= effective;
  }

  function isCantSend(row) {
    return cantSendHit(
      Number(row.t ?? row.totalSend) || 0,
      Number(row.n ?? row.topupCount) || 0,
      Number(row.f ?? row.recentSendFailCount) || 0,
      statusLabel(row.s ?? row.status)
    );
  }

  function buildStats(rows) {
    const stats = [];
    for (const [name, devices] of Object.entries(GROUPS_CURRENT)) {
      const groupRows = rows.filter((r) =>
        // 兼容两种行结构：接口原始行 / 本地缓存的精简行（d/t/s）
        matchDevice(String(r.d ?? r.deviceName ?? '').trim(), devices)
      );
      // 套餐 < 阈值 的端口数量（空/无套餐数据不计入）
      const lowPkg = groupRows.filter((r) => {
        const raw = r.p ?? r.pkgs;
        const v = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
        return Number.isFinite(v) && v < pkgThreshold;
      }).length;
      // 发送总数 > 500 的端口数量（固定阈值，与套餐阈值无关）
      const overSend = groupRows.filter((r) => {
        const v = Number(r.t ?? r.totalSend);
        return Number.isFinite(v) && v > SEND_TOTAL_THRESHOLD;
      }).length;
      const cantSend = groupRows.filter(isCantSend).length; // 发不出去的卡数
      const statusMap = {};
      let pkgSum = 0; // 套餐汇总总数（组内 pkgs 求和）
      for (const r of groupRows) {
        const k = statusLabel(r.s ?? r.status);
        statusMap[k] = (statusMap[k] || 0) + 1;
        pkgSum += Number(r.p ?? r.pkgs) || 0;
      }
      stats.push({
        name,
        devices,
        total: groupRows.length,
        overSend,
        lowPkg,
        cantSend,
        statusMap,
        pkgSum,
      });
    }
    return stats;
  }

  // 可点击的状态标签：点击数字 → 反向筛选主列表（设备组 + 状态）
  function makeStatusChip(label, count, devices, style) {
    const span = document.createElement('span');
    span.style.cssText =
      'display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;border-radius:3px;' +
      'font-size:12px;cursor:pointer;transition:all .15s;' + style;
    span.innerHTML = label + ': <b>' + count + '</b>';
    span.title = '点击筛选列表: ' + (devices ? '设备组内' : '全部设备') + ' + 状态=' + label;
    span.addEventListener('mouseenter', () => (span.style.textDecoration = 'underline'));
    span.addEventListener('mouseleave', () => (span.style.textDecoration = 'none'));
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      // 组行传设备数组=设为该组；汇总行传 null=清空设备筛选，保证结果与报表数字口径一致
      applyFilters({ devices, statusLabel: label });
    });
    return span;
  }

  // 可点击的「发不出去」数字：点击 = 设备组(或全部) + 状态含封卡 → 查询 → 按规则勾选
  // devices: 数组=限定该设备组；null=不限设备（汇总行）
  function makeCantSendChip(count, devices, groupName) {
    const b = document.createElement('span');
    b.style.cssText =
      'display:inline-block;padding:1px 6px;border-radius:3px;cursor:pointer;' +
      'background:#fef0f0;color:#f56c6c;font-weight:600;transition:all .15s;';
    b.textContent = String(count);
    b.title =
      '点击筛选并勾选：' +
      (Array.isArray(devices) ? groupName + ' 设备组' : '全部设备') +
      ' + 状态含「封卡」的数据里、满足发不出去规则的行' +
      '（仅勾选当前页，跨页请手动翻页后再点）';
    b.addEventListener('mouseenter', () => (b.style.textDecoration = 'underline'));
    b.addEventListener('mouseleave', () => (b.style.textDecoration = 'none'));
    b.addEventListener('click', (e) => {
      e.stopPropagation(); // 避免触发外层折叠/行点击
      runCantSendFilter({ devices, groupName });
    });
    return b;
  }

  function buildReportTable(stats) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:10px 14px;overflow-x:auto;';

    const tbl = document.createElement('table');
    tbl.style.cssText =
      'border-collapse:collapse;font-size:13px;min-width:980px;width:100%;';
    const thead = document.createElement('thead');
    thead.innerHTML =
      '<tr>' +
      ['分组', '端口总数', '发送总数&gt;' + SEND_TOTAL_THRESHOLD, '套餐总数', '套餐&lt;' + pkgThreshold, '发不出去', '状态分布']
        .map(
          (h) =>
            '<th style="border:1px solid #ebeef5;background:#f5f7fa;padding:8px 12px;' +
            'text-align:left;font-weight:600;color:#606266;white-space:nowrap;">' +
            h +
            '</th>'
        )
        .join('') +
      '</tr>';
    tbl.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const s of stats) {
      const tr = document.createElement('tr');
      // 状态分布：按数量降序的可点击标签（点击 → 筛选该组 + 该状态）
      const statusTd = document.createElement('td');
      statusTd.style.cssText = 'border:1px solid #ebeef5;padding:8px 12px;';
      const entries = Object.entries(s.statusMap).sort((a, b) => b[1] - a[1]);
      if (!entries.length) {
        const none = document.createElement('span');
        none.style.cssText = 'color:#c0c4cc';
        none.textContent = '无数据';
        statusTd.appendChild(none);
      } else {
        for (const [label, count] of entries) {
          statusTd.appendChild(
            makeStatusChip(label, count, GROUPS_CURRENT[s.name],
              'background:#ecf5ff;color:#409eff;')
          );
        }
      }

      const tdName = document.createElement('td');
      tdName.style.cssText =
        'border:1px solid #ebeef5;padding:8px 12px;font-weight:600;' +
        'white-space:nowrap;line-height:1.5;';
      // 组名（加粗）+ 该组对应的设备配置（灰色小字）
      const nameSpan = document.createElement('span');
      nameSpan.textContent = s.name;
      tdName.appendChild(nameSpan);
      const devSpan = document.createElement('span');
      devSpan.style.cssText =
        'margin-left:6px;font-weight:400;font-size:12px;color:#909399;';
      devSpan.textContent = '(' + s.devices.join('、') + ')';
      tdName.appendChild(devSpan);
      const tdTotal = document.createElement('td');
      tdTotal.style.cssText = 'border:1px solid #ebeef5;padding:8px 12px;';
      tdTotal.textContent = s.total;

      // 发送总数 > 500（固定阈值，不随套餐阈值变化）
      const tdSendOver = document.createElement('td');
      tdSendOver.style.cssText =
        'border:1px solid #ebeef5;padding:8px 12px;' +
        (s.overSend > 0 ? 'color:#409eff;font-weight:600;' : 'color:#909399;');
      tdSendOver.textContent = s.overSend;
      tdSendOver.title =
        '发送总数 > ' + SEND_TOTAL_THRESHOLD + ' 的端口数量（固定阈值，与套餐阈值无关）';

      // 套餐汇总总数（组内 pkgs 求和）
      const pkgTd = document.createElement('td');
      pkgTd.style.cssText = 'border:1px solid #ebeef5;padding:8px 12px;';
      pkgTd.textContent = s.pkgSum;

      const tdOver = document.createElement('td');
      tdOver.style.cssText =
        'border:1px solid #ebeef5;padding:8px 12px;' +
        (s.lowPkg > 0 ? 'color:#e6a23c;font-weight:600;' : 'color:#909399;');
      tdOver.textContent = s.lowPkg;
      tdOver.title = '套餐 < ' + pkgThreshold + ' 的端口数量';

      // 发不出去：封卡状态 + 充值次数>=1 + 失败数量>=有效发送数
      // 有数量时可点击 → 设备组 + 封卡类状态筛选并勾选（数字与勾选结果同口径）
      const tdCant = document.createElement('td');
      tdCant.style.cssText = 'border:1px solid #ebeef5;padding:8px 12px;';
      if (s.cantSend > 0) {
        tdCant.appendChild(makeCantSendChip(s.cantSend, s.devices, s.name));
      } else {
        tdCant.style.color = '#909399';
        tdCant.textContent = '0';
      }
      tdCant.title =
        '发不出去判定：状态含「封卡」且 充值次数≥' + CANT_SEND_MIN_TOPUP +
        ' 且 失败数量 ≥ 有效发送数（有效发送数 = 充值次数>1 ? ' +
        '发送总数-(充值次数-1)×' + PACKAGE_UNIT + ' : 发送总数）';

      tr.appendChild(tdName);
      tr.appendChild(tdTotal);
      tr.appendChild(tdSendOver);
      tr.appendChild(pkgTd);
      tr.appendChild(tdOver);
      tr.appendChild(tdCant);
      tr.appendChild(statusTd);

      // 悬浮提示展示组内设备清单
      tr.title = s.name + ' 设备: ' + s.devices.join(', ');
      tbody.appendChild(tr);
    }

    // 状态汇总行：跨组合计每个状态的总数
    if (stats.length) {
      const sumMap = {};
      let sumTotal = 0;
      let sumSendOver = 0;
      let sumLowPkg = 0;
      let sumCantSend = 0;
      let sumPkg = 0;
      for (const s of stats) {
        sumTotal += s.total;
        sumSendOver += s.overSend;
        sumLowPkg += s.lowPkg;
        sumCantSend += s.cantSend;
        sumPkg += s.pkgSum;
        for (const [label, count] of Object.entries(s.statusMap)) {
          sumMap[label] = (sumMap[label] || 0) + count;
        }
      }

      const sumTr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.style.cssText =
        'border:1px solid #ebeef5;padding:8px 12px;font-weight:700;color:#303133;background:#fafafa;';
      tdName.textContent = '汇总';
      const tdTotal = document.createElement('td');
      tdTotal.style.cssText =
        'border:1px solid #ebeef5;padding:8px 12px;font-weight:700;background:#fafafa;';
      tdTotal.textContent = sumTotal;

      // 发送总数 > 500（跨组合计）
      const tdSendOver = document.createElement('td');
      tdSendOver.style.cssText =
        'border:1px solid #ebeef5;padding:8px 12px;font-weight:700;background:#fafafa;' +
        (sumSendOver > 0 ? 'color:#409eff;' : 'color:#909399;');
      tdSendOver.textContent = sumSendOver;

      // 套餐汇总总数（跨组合计）
      const pkgTd = document.createElement('td');
      pkgTd.style.cssText =
        'border:1px solid #ebeef5;padding:8px 12px;font-weight:700;background:#fafafa;';
      pkgTd.textContent = sumPkg;

      const tdOver = document.createElement('td');
      tdOver.style.cssText =
        'border:1px solid #ebeef5;padding:8px 12px;font-weight:700;background:#fafafa;' +
        (sumLowPkg > 0 ? 'color:#e6a23c;' : 'color:#909399;');
      tdOver.textContent = sumLowPkg;

      // 发不出去（跨组合计）：点击 = 不限设备 + 封卡类状态筛选并勾选
      const tdCant = document.createElement('td');
      tdCant.style.cssText =
        'border:1px solid #ebeef5;padding:8px 12px;font-weight:700;background:#fafafa;';
      if (sumCantSend > 0) {
        tdCant.appendChild(makeCantSendChip(sumCantSend, null, ''));
      } else {
        tdCant.style.color = '#909399';
        tdCant.textContent = '0';
      }

      const statusTd = document.createElement('td');
      statusTd.style.cssText =
        'border:1px solid #ebeef5;padding:8px 12px;background:#fafafa;';
      const sumEntries = Object.entries(sumMap).sort((a, b) => b[1] - a[1]);
      if (!sumEntries.length) {
        const none = document.createElement('span');
        none.style.cssText = 'color:#c0c4cc';
        none.textContent = '无数据';
        statusTd.appendChild(none);
      } else {
        for (const [label, count] of sumEntries) {
          // 汇总行点击 = 不限设备组，仅按状态筛选
          statusTd.appendChild(
            makeStatusChip(label, count, null,
              'background:#f0f9eb;color:#67c23a;')
          );
        }
      }
      sumTr.appendChild(tdName);
      sumTr.appendChild(tdTotal);
      sumTr.appendChild(tdSendOver);
      sumTr.appendChild(pkgTd);
      sumTr.appendChild(tdOver);
      sumTr.appendChild(tdCant);
      sumTr.appendChild(statusTd);
      tbody.appendChild(sumTr);
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);

    const foot = document.createElement('div');
    foot.style.cssText = 'margin-top:8px;font-size:12px;color:#909399;';
    foot.textContent =
      '统计范围: 全部端口数据（设备归属按业务配置 ' + CONFIG_KEY + ' 划分）' +
      (lastDataTs ? ' · 数据时间 ' + fmtTime(lastDataTs) : '') +
      '；「发不出去」= 封卡类状态 + 充值次数≥' + CANT_SEND_MIN_TOPUP +
      ' + 失败数量≥有效发送数（有效发送数 = 充值次数>1 ? 发送总数-(充值次数-1)×' +
      PACKAGE_UNIT + ' : 发送总数）' +
      '；「发送总数>' + SEND_TOTAL_THRESHOLD +
      '」为固定阈值统计（不随上方套餐阈值变化）' +
      '；「换卡推送」批量流程的勾选条件 = 套餐＜' + pkgThreshold +
      '（跟随上方输入框）' +
      '；点击状态标签可反筛列表；点「发不出去」数字 = 该分组设备 + 封卡类状态 → 查询并勾选满足规则的行（汇总行=不限设备），仅勾当前页；点「刷新报表」强制拉最新';
    wrap.appendChild(foot);
    return wrap;
  }

  // 阈值调整后用本地已拉取的数据即时重渲染（不重新发请求）
  function rebuildReportTable() {
    const body = document.getElementById(REPORT_ID + '-body');
    if (!body || !lastRows.length) return; // 数据还没拉到时等首次加载
    body.innerHTML = '';
    body.appendChild(buildReportTable(buildStats(lastRows)));
    updateTimeLabel();
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // 头部「数据 19:07:23（12 秒前）」标签
  function updateTimeLabel() {
    const el = document.getElementById(REPORT_ID + '-time');
    if (!el) return;
    if (!lastDataTs) { el.textContent = '数据 --:--:--'; return; }
    const age = Math.max(0, Math.round((Date.now() - lastDataTs) / 1000));
    el.textContent = '数据 ' + fmtTime(lastDataTs) + (age >= 5 ? '（' + age + ' 秒前）' : '');
    el.title = '报表数据抓取时间：' + new Date(lastDataTs).toLocaleString();
  }

  function setRefreshingUI(on) {
    const el = document.getElementById(REPORT_ID + '-updating');
    if (el) el.style.display = on ? 'inline' : 'none';
  }

  // 渲染一批数据（rows 可能是缓存精简行，也可能是接口原始行）
  function renderReportRows(rows) {
    const body = document.getElementById(REPORT_ID + '-body');
    const tip = document.getElementById(REPORT_ID + '-tip');
    if (!body) return;
    lastRows = rows;
    const stats = buildStats(rows);
    body.innerHTML = '';
    body.appendChild(buildReportTable(stats));
    if (tip) tip.style.display = 'none';
    updateTimeLabel();

    // 诊断：没有命中「发不出去」时，打印数据里实际存在的封卡类状态，便于核对口径
    if (!stats.some((s) => s.cantSend > 0)) {
      const labels = {};
      let sealed = 0;
      let sealedTopupOk = 0;
      for (const r of rows) {
        const lb = statusLabel(r.s ?? r.status);
        if (!lb.includes('封卡')) continue;
        labels[lb] = (labels[lb] || 0) + 1;
        sealed++;
        if ((Number(r.n ?? r.topupCount) || 0) >= CANT_SEND_MIN_TOPUP) sealedTopupOk++;
      }
      log('「发不出去」当前命中 0 张；数据中的封卡类状态: ' +
        (Object.keys(labels).length ? JSON.stringify(labels) : '无') +
        '（封卡 ' + sealed + ' 张，其中充值次数≥' + CANT_SEND_MIN_TOPUP +
        ' 的 ' + sealedTopupOk + ' 张；判定还要求 失败数量≥有效发送数，' +
        '有效发送数 = 充值次数>1 ? 发送总数-(充值次数-1)×' + PACKAGE_UNIT + ' : 发送总数）');
    }
  }

  // 策略：缓存命中先用缓存秒开；数据不够新（>30 秒或站点刚发生过写操作）再后台静默更新
  async function refreshReport(force) {
    if (reportRefreshing) return;
    if (!document.getElementById(REPORT_ID + '-body')) return; // 面板不在（非端口页）
    reportRefreshing = true;
    const tip = document.getElementById(REPORT_ID + '-tip');
    try {
      // 先保证状态字典可用（有 sessionStorage 缓存时零等待），否则缓存秒开会把状态显示成数字
      // 手动点「刷新报表」时顺带强制更新字典，避免新增状态名一直显示成数字
      if (force) await loadStatusDict(true);
      else await ensureStatusDict();

      const cached = force ? null : readCache();

      if (cached) {
        lastDataTs = cached.ts;
        renderReportRows(cached.rows); // 秒开：完全不发请求
        const age = Date.now() - cached.ts;
        const fresh = age < REPORT_FRESH_TTL && !CACHE_DIRTY;
        if (fresh) {
          log('报表使用本地缓存（' + Math.round(age / 1000) + ' 秒前），足够新不请求');
          return;
        }
        setRefreshingUI(true); // 先展示旧数据 + “更新中”，避免等待空白
        log('报表先用缓存渲染（' + Math.round(age / 1000) + ' 秒前' +
          (CACHE_DIRTY ? '，站点已有写操作' : '') + '），后台静默更新中…');
      } else {
        if (tip) {
          tip.textContent = '加载中…';
          tip.style.display = 'block';
        }
        setRefreshingUI(true);
      }

      const rows = await fetchAllPorts(true); // 强制走网络
      renderReportRows(rows);
      log('✅ L 组报表已更新（共 ' + rows.length + ' 条端口数据）');
    } catch (e) {
      if (tip && !lastRows.length) {
        tip.textContent = '报表加载失败: ' + (e && e.message);
        tip.style.display = 'block';
      }
      log('报表加载失败:', e);
    } finally {
      reportRefreshing = false;
      setRefreshingUI(false);
      updateTimeLabel();
    }
  }

  function buildReportPanel() {
    const panel = document.createElement('div');
    panel.id = REPORT_ID;
    panel.style.cssText =
      'margin:12px 0;border:1px solid #ebeef5;border-radius:6px;background:#fff;' +
      'box-shadow:0 1px 3px rgba(0,0,0,.04);overflow:hidden;';

    // 头部：标题 + 折叠/刷新
    const head = document.createElement('div');
    head.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;' +
      'padding:10px 14px;cursor:pointer;user-select:none;background:#f5f7fa;';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;font-size:14px;color:#303133;';
    const titleText = () =>
      '📊 L 组数据报表（发送>' + SEND_TOTAL_THRESHOLD + ' / 套餐<' + pkgThreshold + ' / 状态分布）';
    title.textContent = titleText();

    const ops = document.createElement('div');
    ops.style.cssText = 'display:flex;align-items:center;gap:8px;';

    // 数据时间标签：让「新/旧」一眼可见
    const timeSpan = document.createElement('span');
    timeSpan.id = REPORT_ID + '-time';
    timeSpan.style.cssText = 'font-size:12px;color:#909399;white-space:nowrap;';
    timeSpan.textContent = '数据 --:--:--';
    ops.appendChild(timeSpan);

    // 「更新中…」提示（后台静默更新时显示，不阻塞阅读）
    const updSpan = document.createElement('span');
    updSpan.id = REPORT_ID + '-updating';
    updSpan.style.cssText =
      'display:none;font-size:12px;color:#e6a23c;white-space:nowrap;';
    updSpan.textContent = '更新中…';
    ops.appendChild(updSpan);

    // 阈值输入：调整"套餐<N"的 N，改动后用本地数据即时重算（不发请求）
    const thLabel = document.createElement('span');
    thLabel.style.cssText = 'font-size:12px;color:#909399;';
    thLabel.textContent = '套餐＜';
    const thInput = document.createElement('input');
    thInput.type = 'number';
    thInput.min = '0';
    thInput.step = '1';
    thInput.value = pkgThreshold;
    thInput.title = '调整套餐阈值后立即重新统计；「换卡推送」批量流程的勾选条件也跟随此值' +
      '（阈值会记住，刷新后保留，关闭标签页恢复默认 ' + PKG_THRESHOLD_DEFAULT + '）';
    thInput.style.cssText =
      'width:76px;padding:3px 6px;font-size:12px;border:1px solid #dcdfe6;' +
      'border-radius:4px;color:#606266;outline:none;';
    const applyThreshold = () => {
      const v = parseInt(thInput.value, 10);
      if (isNaN(v) || v < 0) { thInput.value = pkgThreshold; return; }
      if (v === pkgThreshold) return;
      pkgThreshold = v;
      savePkgThreshold(v); // 记住阈值，刷新后仍生效
      thInput.value = v;
      title.textContent = titleText();
      rebuildReportTable(); // 用已拉取的数据重算，无需重新请求
      refreshBatchMenuTitles(); // 批量推送菜单提示同步新阈值
      log('阈值已调整为 套餐<' + pkgThreshold + '，报表已重新统计；' +
        '「换卡推送」批量流程同步使用该阈值');
    };
    thInput.addEventListener('change', applyThreshold);
    thInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') thInput.blur(); // 回车确认
    });
    thInput.addEventListener('click', (e) => e.stopPropagation()); // 不触发折叠
    ops.appendChild(thLabel);
    ops.appendChild(thInput);

    // 「发不出去筛选」：状态=封卡类 → 查询 → 勾选满足规则的行
    const cantBtn = document.createElement('button');
    cantBtn.type = 'button';
    cantBtn.id = REPORT_ID + '-cantsend';
    cantBtn.textContent = '发不出去筛选';
    cantBtn.title = '清空设备筛选 → 状态设为「' + SEALED_STATUS_LABEL +
      '」（含其他封卡类状态）→ 查询 → 勾选满足「发不出去」规则的行' +
      '（封卡类状态 + 充值次数≥' + CANT_SEND_MIN_TOPUP + ' + 失败数量≥有效发送数）' +
      '\n提示：直接点报表里「发不出去」列的数字，可只筛该分组的设备';
    cantBtn.style.cssText =
      'padding:4px 12px;font-size:12px;border:1px solid #f5c6cb;border-radius:4px;' +
      'background:#fef0f0;color:#f56c6c;cursor:pointer;white-space:nowrap;';
    cantBtn.addEventListener('mouseenter', () => {
      if (!cantBtn.disabled) cantBtn.style.background = '#fde2e2';
    });
    cantBtn.addEventListener('mouseleave', () => { cantBtn.style.background = '#fef0f0'; });
    cantBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // 不触发折叠
      runCantSendFilter();
    });
    ops.appendChild(cantBtn);

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.textContent = '刷新报表';
    refreshBtn.style.cssText =
      'padding:4px 12px;font-size:12px;border:1px solid #dcdfe6;border-radius:4px;' +
      'background:#fff;color:#606266;cursor:pointer;';
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // 不触发折叠
      refreshReport(true); // 手动点击 = 强制绕过缓存
    });
    const arrow = document.createElement('span');
    arrow.style.cssText = 'font-size:12px;color:#909399;transition:transform .2s;';
    arrow.textContent = '▼';
    ops.appendChild(refreshBtn);
    ops.appendChild(arrow);
    head.appendChild(title);
    head.appendChild(ops);

    // 折叠体
    const body = document.createElement('div');
    body.id = REPORT_ID + '-body';
    body.style.cssText = 'display:block;';
    const tip = document.createElement('div');
    tip.id = REPORT_ID + '-tip';
    tip.style.cssText = 'padding:14px;font-size:13px;color:#909399;';
    tip.textContent = '待加载…';
    body.appendChild(tip);

    let collapsed = false;
    head.addEventListener('click', () => {
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : 'block';
      arrow.style.transform = collapsed ? 'rotate(-90deg)' : '';
    });

    panel.appendChild(head);
    panel.appendChild(body);
    return panel;
  }

  // 把报表插到筛选栏（.toolbar）与列表（.panel）之间
  function tryInsertReport() {
    if (!onReportPage()) return;
    if (document.getElementById(REPORT_ID)) return;
    const page = document.querySelector('.page');
    const firstPanel = page && page.querySelector('.panel');
    if (page && firstPanel) {
      page.insertBefore(buildReportPanel(), firstPanel);
      log('✅ L 组报表面板已插入（筛选栏与列表之间）');
      refreshReport();
    }
  }

  function onTargetPage() {
    return (
      location.pathname.includes(PATH_KEYWORD) ||
      location.hash.includes(PATH_KEYWORD)
    );
  }

  // 报表只在 /mkt/port 显示；/mkt/port-group 等子路径不显示
  const REPORT_EXCLUDE_KEYWORDS = ['/mkt/port-group'];
  function onReportPage() {
    if (!onTargetPage()) return false;
    return !REPORT_EXCLUDE_KEYWORDS.some(
      (k) => location.pathname.includes(k) || location.hash.includes(k)
    );
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function fireClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  // 找 label 文本精确匹配的 .query-label（"设备"不会误中"设备状态"）
  function findQueryLabel(labelText) {
    for (const lb of document.querySelectorAll('span.query-label')) {
      if (lb.textContent.trim() === labelText && isVisible(lb)) return lb;
    }
    return null;
  }

  // 找某 label 对应的下拉框容器（label 的下一个兄弟元素）
  function findSelectAfter(labelText) {
    const lb = findQueryLabel(labelText);
    if (!lb) return null;
    let s = lb.nextElementSibling;
    for (let i = 0; i < 3 && s; i++) {
      if (s.classList.contains('el-select') || s.querySelector('.el-select')) return s;
      s = s.nextElementSibling;
    }
    return null;
  }

  // 选项文本与设备名匹配：优先整串相等，再按分隔符切词精确比较
  // （词级匹配是因为子串匹配有坑：D4 会误中 L1D4、D1 会误中 D11/D10）
  function matchDevice(text, devices) {
    if (devices.includes(text)) return true;
    const tokens = text.split(/[\s/|,，、()（）\[\]【】\-]+/).filter(Boolean);
    return devices.some((d) => tokens.includes(d));
  }

  function clickSearchButton() {
    for (const b of document.querySelectorAll('button')) {
      const t = b.textContent.trim();
      if (t === '查询' || t === '搜索') {
        b.click();
        log('已自动点击「' + t + '」');
        return true;
      }
    }
    log('未找到查询按钮，请手动点击查询');
    return false;
  }

  // 找查询区（包含 span.query-label 的 form/容器），用于把按钮查找限定在筛选栏内
  function findQueryScope() {
    const lb = document.querySelector('span.query-label');
    if (!lb) return null;
    return lb.closest('form') || lb.closest('.el-form') || null;
  }

  // 点击筛选栏的「重置」按钮，清空所有历史查询条件（含发送总数、卡号、运营商等残留）
  // 每次自动筛选前都先执行，保证结果只由本次设置的条件决定
  async function clickResetButton() {
    const scope = findQueryScope();
    const roots = scope ? [scope, document] : [document];
    for (const root of roots) {
      for (const b of root.querySelectorAll('button')) {
        if (!isVisible(b)) continue;
        if (b.closest('.el-dialog')) continue; // 跳过弹窗内的按钮，只清筛选栏
        const t = b.textContent.replace(/\s/g, '');
        if (t === '重置' || t === '重置条件' || t === '清空' || t.toLowerCase() === 'reset') {
          fireClick(b);
          log('已点击「' + b.textContent.trim() + '」清空查询条件');
          await sleep(700); // 等表单清空（部分页面重置后会自行查询一次）
          return true;
        }
      }
    }
    log('未找到「重置」按钮，按当前条件继续');
    return false;
  }

  // 同步多选下拉的选中项：按 wantFn 选上/取消选项（wantFn: 选项文本 => 是否想要）
  async function syncSelectionBy(dd, wantFn) {
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      const items = [...dd.querySelectorAll('.el-select-dropdown__item')];
      for (const it of items) {
        const text = it.textContent.trim();
        const isSel = it.classList.contains('is-selected');
        const want = wantFn(text);
        if (want && !isSel) {
          fireClick(it);
          changed = true;
          await sleep(150);
        } else if (!want && isSel) {
          fireClick(it); // 取消不想要的已选项
          changed = true;
          await sleep(150);
        }
      }
      if (!changed) return true; // 无变化 = 选择已精确同步
    }
    return false;
  }

  // 打开某 label 对应的下拉框、按 wantFn 同步选中项、收起（整个流程）
  // ddMatcher: 从可见浮层中识别目标下拉的谓词（默认取含 wantFn 命中项的浮层；
  //            清空场景 wantFn 永远不命中，需传入 (items) => true 取第一个有选项的浮层）
  async function syncDropdown(labelText, wantFn, ddMatcher) {
    const sel = findSelectAfter(labelText);
    if (!sel) { log('未找到「' + labelText + '」下拉框'); return false; }
    const wrapper = sel.querySelector('.el-select__wrapper') || sel;

    document.body.click(); // 先确保关闭，再重新打开，避免 toggle 关掉
    await sleep(250);
    fireClick(wrapper);
    await sleep(400);

    const matchDd =
      ddMatcher ||
      ((items) => items.some((it) => wantFn(it.textContent.trim())));

    // 找"已打开且符合条件"的下拉浮层（浮层 teleport 到 body）
    let dd = null;
    for (const d of document.querySelectorAll('.el-select-dropdown')) {
      if (d.offsetParent === null) continue;
      const items = [...d.querySelectorAll('.el-select-dropdown__item')];
      if (items.length && matchDd(items)) { dd = d; break; }
    }
    if (!dd) {
      document.body.click();
      log('未找到「' + labelText + '」的下拉浮层');
      return false;
    }

    const ok = await syncSelectionBy(dd, wantFn);
    await sleep(200);
    document.body.click(); // 收起下拉
    await sleep(300);
    if (!ok) log('⚠️ 「' + labelText + '」同步后未能完全确认，请核对下拉框选中项');
    return ok;
  }

  let busy = false;

  // 一键应用筛选，完成后点一次查询。devices 语义：
  //   数组   = 设备筛选设为该组
  //   null   = 清空设备筛选（汇总场景，保证结果与报表口径一致）
  //   undefined = 不动设备筛选
  async function applyFilters({ devices, statusLabel }) {
    if (busy) return;
    busy = true;
    try {
      let ok = true;
      // 先点「重置」清空历史条件：避免上次残留的发送总数/卡号等条件影响本次结果
      const resetOk = await clickResetButton();

      if (devices !== undefined) {
        const wantFn = devices
          ? (t) => matchDevice(t, devices)
          : () => false; // 清空：取消所有已选设备
        // 重置已成功时无需再逐个取消设备
        if (!(resetOk && devices === null)) {
          ok =
            (await syncDropdown('设备', wantFn, devices ? undefined : () => true)) &&
            ok;
        }
      }
      if (statusLabel) {
        ok =
          (await syncDropdown('状态', (t) => t === statusLabel)) && ok;
      }
      if (ok) {
        let desc = '';
        if (Array.isArray(devices)) {
          desc +=
            '设备=' +
            (Object.keys(GROUPS_CURRENT).find(
              (k) => GROUPS_CURRENT[k] === devices
            ) || '?') +
            ' ';
        } else if (devices === null) {
          desc += '设备=全部 ';
        }
        if (statusLabel) desc += '状态=' + statusLabel;
        log('✅ 已应用筛选 ' + desc);
        if (AUTO_SEARCH) clickSearchButton();
      }
    } finally {
      busy = false;
    }
  }

  async function applyGroup(devices, name) {
    await applyFilters({ devices });
  }

  // ===== 批量推送（换卡）：hover L 按钮下拉触发 =====
  // 批量条件：设备 = 单台 → 清空「发送总数」→ 查询 → 只勾选「套餐 < 报表阈值」的行
  // 菜单项 → 弹窗里「推送类型」选项的映射
  const MENU_PUSH_TYPE = {
    '换卡': '换卡',
  };

  function findSendTotalControls() {
    const lb = findQueryLabel('发送总数');
    if (!lb) return null;
    const container = lb.nextElementSibling; // el-input 容器
    if (!container) return null;
    const input =
      container.querySelector('input.el-input__inner') ||
      container.querySelector('input');
    // 规则下拉在输入框的 append 插槽里
    const appendSelect =
      container.querySelector('.el-input-group__append .el-select__wrapper') ||
      container.querySelector('.el-input-group__append .el-select');
    return { input, appendSelect };
  }

  function setInputValue(input, val) {
    input.value = val;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 切换"发送总数"的规则下拉（< / > / = ...）——备用：如需回到发送总数条件时可用
  async function setSendTotalRule(rule) {
    const c = findSendTotalControls();
    if (!c || !c.appendSelect) { log('未找到发送总数规则下拉'); return false; }
    document.body.click();
    await sleep(250);
    fireClick(c.appendSelect);
    await sleep(400);
    let item = null;
    for (const d of document.querySelectorAll('.el-select-dropdown')) {
      if (d.offsetParent === null) continue;
      for (const it of d.querySelectorAll('.el-select-dropdown__item')) {
        if (it.textContent.trim() === rule) { item = it; break; }
      }
      if (item) break;
    }
    if (!item) {
      document.body.click();
      log('未找到规则选项「' + rule + '」');
      return false;
    }
    fireClick(item);
    await sleep(200);
    document.body.click();
    await sleep(250);
    log('发送总数规则已设为「' + rule + '」');
    return true;
  }

  // 全选当前查询结果（点击表头复选框）。返回是否成功勾选到数据
  async function selectAllQueryRows() {
    // 已有选中行则直接认为可用
    if (document.querySelector('.el-table__body-wrapper .el-checkbox__input.is-checked')) {
      return true;
    }
    const headerCb = document.querySelector(
      '.el-table__header-wrapper .el-table__cell .el-checkbox'
    );
    if (!headerCb) { log('未找到表头全选复选框'); return false; }
    const input = headerCb.querySelector('input');
    fireClick(input || headerCb);
    await sleep(500);
    const ok = !!document.querySelector(
      '.el-table__body-wrapper .el-checkbox__input.is-checked'
    );
    if (ok) log('已自动全选查询结果');
    else log('全选后未检测到选中行（可能查询结果为空）');
    return ok;
  }

  // ===== 按「套餐 < N」筛选并勾选行（页面筛选栏没有套餐条件，只能逐行判断）=====
  // 批量的套餐阈值跟随报表头部「套餐＜N」输入框（pkgThreshold，默认 1000），不再单独写死
  function batchPkgLimit() {
    return pkgThreshold;
  }

  // 菜单里的阈值提示随输入框变化（按钮条重建时会重新生成，这里只处理阈值改动的情况）
  function refreshBatchMenuTitles() {
    const limit = batchPkgLimit();
    for (const el of document.querySelectorAll('[data-gavin-batch-menu="1"]')) {
      el.title =
        '逐台设备: 筛选设备 → 查询 → 只勾选「套餐<' + limit +
        '」的端口 → 推送（' + (MENU_PUSH_TYPE[el.dataset.gavinBatchItem] || '') +
        '）→ 等人工确认（阈值跟随报表头部输入框）';
      el.dataset.gavinBatchLimit = String(limit);
    }
  }

  // 清空「发送总数」条件，避免上一轮残留的 limit/规则影响结果
  function clearSendTotalCondition() {
    const c = findSendTotalControls();
    if (!c || !c.input) { log('⚠️ 未找到发送总数输入框，可能残留旧条件'); return false; }
    if (String(c.input.value || '') === '') return true;
    setInputValue(c.input, '');
    log('已清空「发送总数」筛选条件');
    return true;
  }

  // 「套餐」列在表格中的下标（表头与 tbody 的 td 顺序一致）
  function findPkgColumnIndex() {
    return findColumnIndex(['套餐']);
  }

  // 按表头文本找列下标：先精确匹配，退化为包含匹配
  function findColumnIndex(names) {
    const heads = [...document.querySelectorAll('.el-table__header-wrapper thead th')];
    const texts = heads.map((th) => (th.innerText || '').replace(/\s+/g, ''));
    let i = texts.findIndex((t) => names.includes(t));
    if (i >= 0) return i;
    i = texts.findIndex((t) => names.some((n) => t.includes(n)));
    return i;
  }

  function currentQueryRows() {
    return [...document.querySelectorAll(
      '.el-table__body-wrapper tbody tr.el-table__row'
    )];
  }

  // 清空表格已勾选行（表头复选框：全选 → 全不选）
  async function clearRowSelection() {
    if (!document.querySelector('.el-table__body-wrapper .el-checkbox__input.is-checked')) return;
    const headerCb = document.querySelector(
      '.el-table__header-wrapper .el-table__cell .el-checkbox'
    );
    if (!headerCb) return;
    const input = headerCb.querySelector('input');
    const headerChecked = headerCb
      .querySelector('.el-checkbox__input')
      ?.classList.contains('is-checked');
    if (!headerChecked) { fireClick(input || headerCb); await sleep(400); } // 先全选
    fireClick(input || headerCb); // 再全不选
    await sleep(400);
  }

  // 只勾选「套餐 < limit」的行，返回勾选到的行数
  async function selectRowsByPkg(limit) {
    const rows = currentQueryRows();
    if (!rows.length) { log('查询结果为空'); return 0; }

    const idx = findPkgColumnIndex();
    if (idx < 0) {
      log('⚠️ 未找到「套餐」列，退化为全选查询结果');
      return (await selectAllQueryRows()) ? currentQueryRows().length : 0;
    }

    // 分页保护提示：当前页未覆盖全部数据时给出警告
    const totalTxt = (document.querySelector('.el-pagination__total')?.innerText || '')
      .replace(/[^\d]/g, '');
    const totalNum = totalTxt ? Number(totalTxt) : 0;
    if (totalNum && totalNum > rows.length) {
      log('⚠️ 当前页仅 ' + rows.length + ' 行（共 ' + totalNum + ' 条），超出部分未参与勾选');
    }

    await clearRowSelection();
    let picked = 0;
    for (const tr of rows) {
      const cell = tr.querySelectorAll('td')[idx];
      if (!cell) continue;
      // 单元格可能带千分位/单位，取数字比较
      const txt = (cell.innerText || '').replace(/[^\d.\-]/g, '');
      const v = txt === '' ? NaN : Number(txt);
      if (!(Number.isFinite(v) && v < limit)) continue;
      const cbInput = tr.querySelector('.el-checkbox__input');
      if (!cbInput || cbInput.classList.contains('is-checked')) continue;
      const cb = tr.querySelector('.el-checkbox') || cbInput;
      fireClick(cb.querySelector('input') || cb);
      picked++;
      await sleep(90); // 逐行勾选，给框架响应时间
    }
    const checked = document.querySelectorAll(
      '.el-table__body-wrapper .el-checkbox__input.is-checked'
    ).length;
    log('按「套餐<' + limit + '」勾选（套餐列#' + idx + '）：命中 ' + picked +
      ' 行，当前已选 ' + checked + ' 行');
    return checked;
  }

  // ===== 「发不出去筛选」：状态=封卡类 → 查询 → 勾选满足发不出去规则的行 =====
  const SEALED_STATUS_LABEL = '疑似封卡'; // 首选状态名，找不到时退化为包含「封卡」的选项

  // 只勾选满足「发不出去」规则的行（逐行读 发送总数/充值次数/连续失败/状态 列）
  async function selectRowsByCantSend() {
    const rows = currentQueryRows();
    if (!rows.length) { log('查询结果为空'); return 0; }

    const iTotal = findColumnIndex(['发送总数']);
    const iTopup = findColumnIndex(['充值次数']);
    const iFail = findColumnIndex(['连续失败', '失败数量', '失败数']);
    const iStatus = findColumnIndex(['状态']);
    if (iTotal < 0 || iTopup < 0 || iFail < 0 || iStatus < 0) {
      log('⚠️ 缺少必要列（发送总数/充值次数/连续失败/状态），' +
        '请先在表格「列设置」里把这些列显示出来');
      return 0;
    }
    log('列定位：发送总数#' + iTotal + ' 充值次数#' + iTopup +
      ' 连续失败#' + iFail + ' 状态#' + iStatus);

    // 分页保护：当前页未覆盖全部数据时给出警告
    const totalTxt = (document.querySelector('.el-pagination__total')?.innerText || '')
      .replace(/[^\d]/g, '');
    const totalNum = totalTxt ? Number(totalTxt) : 0;
    if (totalNum && totalNum > rows.length) {
      log('⚠️ 当前页仅 ' + rows.length + ' 行（共 ' + totalNum + ' 条），超出部分未参与勾选');
    }

    await clearRowSelection();
    const numOf = (td) => {
      const txt = (td?.innerText || '').replace(/[^\d.\-]/g, '');
      return txt === '' ? NaN : Number(txt);
    };
    let picked = 0;
    let skippedByData = 0;
    for (const tr of rows) {
      const tds = tr.querySelectorAll('td');
      const totalSend = numOf(tds[iTotal]);
      const topup = numOf(tds[iTopup]);
      const fail = numOf(tds[iFail]);
      const statusText = (tds[iStatus]?.innerText || '').trim();
      if (!Number.isFinite(totalSend) || !Number.isFinite(topup) || !Number.isFinite(fail)) {
        skippedByData++;
        continue;
      }
      if (!cantSendHit(totalSend, topup, fail, statusText)) continue;
      const cbInput = tr.querySelector('.el-checkbox__input');
      if (!cbInput || cbInput.classList.contains('is-checked')) continue;
      const cb = tr.querySelector('.el-checkbox') || cbInput;
      fireClick(cb.querySelector('input') || cb);
      picked++;
      await sleep(90); // 逐行勾选，给框架响应时间
    }
    const checked = document.querySelectorAll(
      '.el-table__body-wrapper .el-checkbox__input.is-checked'
    ).length;
    log('「发不出去」勾选：命中 ' + picked + ' 行，当前已选 ' + checked + ' 行' +
      (skippedByData ? '（' + skippedByData + ' 行数值无法解析已跳过）' : ''));
    return checked;
  }

  // 一键：设备（可选限定某组）→ 状态=封卡类 → 查询 → 勾选满足发不出去规则的行
  // opts.devices: 数组=限定该设备组（报表组行数字点击）；null/undefined=清空设备（全部）
  async function runCantSendFilter(opts) {
    const o = opts || {};
    const devices = Array.isArray(o.devices) ? o.devices : null;
    const groupName = o.groupName || '';
    if (busy) { log('已有任务进行中，请稍候'); return; }
    if (batchRunning) { log('批量任务进行中，请稍候'); return; }
    busy = true;
    const btn = document.getElementById(REPORT_ID + '-cantsend');
    const oldText = btn ? btn.textContent : '';
    const setBtn = (t, disabled) => {
      if (!btn) return;
      btn.textContent = t;
      btn.disabled = !!disabled;
      btn.style.opacity = disabled ? '0.6' : '1';
      btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
    };
    try {
      setBtn('筛选中…', true);
      log('🚀 开始「发不出去筛选」：重置条件 → 设备=' +
        (devices ? groupName || '指定组' : '全部') +
        ' → 状态=封卡类（' + SEALED_STATUS_LABEL + ' 等）→ 查询 → 按规则勾选');

      // 0) 先点「重置」清空历史条件，避免残留条件把结果范围弄错
      const resetOk = await clickResetButton();

      // 1) 设备：有组 → 设为该组设备；无组 → 重置后已为空，无需再清
      if (devices) {
        const okDev = await syncDropdown('设备', (t) => matchDevice(t, devices));
        if (!okDev) {
          log('⚠️ 设备组「' + groupName + '」设置失败，已停止 —— ' +
            '避免结果超出该分组范围；可先点上方 ' + groupName +
            ' 按钮确认设备筛选，再点「发不出去筛选」');
          return;
        }
      } else if (!resetOk) {
        await syncDropdown('设备', () => false, () => true);
      }

      // 2) 状态 = 疑似封卡（找不到完全同名时退化为包含「封卡」的选项）
      const okStatus = await syncDropdown(
        '状态',
        (t) => t === SEALED_STATUS_LABEL || t.includes('封卡')
      );
      if (!okStatus) {
        log('⚠️ 状态筛选设置失败，已停止');
        return;
      }

      // 3) 查询并等列表刷新
      clickSearchButton();
      setBtn('勾选中…', true);
      await sleep(2200);

      // 4) 勾选满足规则的行
      const checked = await selectRowsByCantSend();
      if (!checked) {
        log('ℹ️ 没有满足「发不出去」规则的数据（或状态筛选结果为空）');
      } else {
        const scope = devices ? groupName + ' 组' : '全部设备';
        log('✅ [' + scope + '] 已勾选 ' + checked +
          ' 行满足「发不出去」规则的数据，可继续点「推送」或「修改状态」');
      }
    } catch (e) {
      log('「发不出去筛选」执行出错:', e);
    } finally {
      setBtn(oldText || '发不出去筛选', false);
      busy = false;
    }
  }

  function findPushDialog() {
    for (const dlg of document.querySelectorAll('.el-dialog')) {
      const t = dlg.querySelector('.el-dialog__title');
      if (!t || !t.textContent.includes('推送到 Telegram')) continue;
      if (dlg.getBoundingClientRect().width > 0) return dlg; // 可见
    }
    return null;
  }

  async function waitForPushDialog(timeoutMs) {
    const end = Date.now() + (timeoutMs || 8000);
    while (Date.now() < end) {
      const dlg = findPushDialog();
      if (dlg) return dlg;
      await sleep(400);
    }
    return null;
  }

  // 等人工在弹窗里点「确定」或「取消」（弹窗消失即继续）
  async function waitForDialogClose() {
    while (true) {
      const dlg = findPushDialog();
      if (!dlg) return true;
      await sleep(500);
    }
  }

  async function setPushTypeInDialog(dlg, pushType) {
    const selWrap =
      dlg.querySelector('.el-dialog__body .el-select__wrapper') ||
      dlg.querySelector('.el-dialog__body .el-select');
    if (!selWrap) { log('推送弹窗中未找到推送类型下拉'); return false; }
    fireClick(selWrap);
    await sleep(400);
    let item = null;
    for (const d of document.querySelectorAll('.el-select-dropdown')) {
      if (d.offsetParent === null) continue;
      for (const it of d.querySelectorAll('.el-select-dropdown__item')) {
        if (it.textContent.trim() === pushType) { item = it; break; }
      }
      if (item) break;
    }
    if (!item) {
      log('未找到推送类型选项「' + pushType + '」');
      return false;
    }
    fireClick(item);
    await sleep(250);
    fireClick(selWrap); // 再点一下收起下拉（避免误关弹窗）
    await sleep(300);
    log('推送类型已选「' + pushType + '」，等待人工确认');
    return true;
  }

  // 批量进度浮层（含「终止」按钮）
  let batchStopFlag = false;
  function batchProgress() {
    let el = document.getElementById('gavin-batch-progress');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gavin-batch-progress';
      el.style.cssText =
        'position:fixed;top:16px;right:16px;z-index:99999;background:#303133;color:#fff;' +
        'padding:10px 16px;border-radius:6px;font-size:13px;line-height:1.5;' +
        'box-shadow:0 4px 12px rgba(0,0,0,.25);max-width:380px;' +
        'display:flex;align-items:center;gap:12px;';
      const txt = document.createElement('span');
      txt.id = 'gavin-batch-progress-text';
      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.textContent = '终止';
      stopBtn.title = '结束批量任务（当前设备流程走完即停止）';
      stopBtn.style.cssText =
        'flex-shrink:0;padding:3px 12px;font-size:12px;border:none;border-radius:4px;' +
        'background:#f56c6c;color:#fff;cursor:pointer;';
      stopBtn.addEventListener('click', () => {
        if (batchStopFlag) return;
        batchStopFlag = true;
        stopBtn.textContent = '终止中…';
        stopBtn.disabled = true;
        stopBtn.style.cursor = 'default';
        log('🛑 已请求终止批量任务，当前设备流程走完后停止');
      });
      el.appendChild(txt);
      el.appendChild(stopBtn);
      document.body.appendChild(el);
    }
    const txt = document.getElementById('gavin-batch-progress-text');
    return (text) => { txt.textContent = text; };
  }
  function removeBatchProgress() {
    const el = document.getElementById('gavin-batch-progress');
    if (el) el.remove();
  }

  // 批量主流程：遍历组内设备，逐台 筛选→查询→推送→人工确认
  let batchRunning = false;
  async function runBatch(groupName, menuItem) {
    if (batchRunning || busy) { log('已有任务进行中，请稍候'); return; }
    const devices = GROUPS_CURRENT[groupName];
    if (!devices || !devices.length) { log('L 组 ' + groupName + ' 无设备'); return; }
    const pushType = MENU_PUSH_TYPE[menuItem] || menuItem;
    const pkgLimit = batchPkgLimit(); // 本次批量使用的套餐阈值（开始时的快照）

    batchRunning = true;
    busy = true; // 批量期间禁用其他快选操作
    batchStopFlag = false;
    const prog = batchProgress();
    try {
      log('🚀 开始批量' + menuItem + '推送：L ' + groupName + '（' +
        devices.length + ' 台设备，套餐<' + pkgLimit + '，阈值取自报表头部输入框）');
      for (let i = 0; i < devices.length; i++) {
        if (batchStopFlag) {
          log('🛑 批量任务已终止，剩余 ' + (devices.length - i) + ' 台设备未处理');
          break;
        }
        const dev = devices[i];
        prog('📋 批量' + menuItem + '（' + groupName + '）' +
          (i + 1) + '/' + devices.length + ' — 设备 ' + dev + '：设置筛选…');

        // 0) 先点「重置」清空上一轮残留的查询条件（设备/状态/卡号/发送总数）
        await clickResetButton();

        // 1) 设备筛选 = 仅这台设备
        const okDev = await syncDropdown('设备', (t) => t === dev);
        if (!okDev) { log('⚠️ 设备 ' + dev + ' 筛选设置失败，跳过'); continue; }

        // 2) 清空「发送总数」条件（改用套餐阈值筛选，避免残留 >500 之类的旧条件）
        clearSendTotalCondition();

        // 3) 查询
        clickSearchButton();
        await sleep(2000); // 等列表刷新
        if (batchStopFlag) {
          log('🛑 批量任务已终止（设备 ' + dev + ' 未推送）');
          break;
        }

        // 3.5) 只勾选「套餐 < pkgLimit」的行（推送按钮要求先选中行）
        prog('📋 批量' + menuItem + '（' + groupName + '）' +
          (i + 1) + '/' + devices.length + ' — 设备 ' + dev +
          '：勾选「套餐<' + pkgLimit + '」的端口…');
        const selected = await selectRowsByPkg(pkgLimit);
        if (!selected) {
          log('ℹ️ 设备 ' + dev + ': 无「套餐<' + pkgLimit +
            '」的端口，跳过');
          continue;
        }

        // 4) 点推送
        let pushBtn = null;
        for (const b of document.querySelectorAll('button')) {
          if (b.textContent.trim() === '推送') { pushBtn = b; break; }
        }
        if (!pushBtn) { log('⚠️ 设备 ' + dev + ': 未找到「推送」按钮，跳过'); continue; }
        if (pushBtn.disabled) {
          log('ℹ️ 设备 ' + dev + ': 无符合条件的数据（推送按钮不可用），跳过');
          continue;
        }
        prog('📋 批量' + menuItem + '（' + groupName + '）' +
          (i + 1) + '/' + devices.length + ' — 设备 ' + dev + '：打开推送弹窗…');
        pushBtn.click();
        const dlg = await waitForPushDialog();
        if (!dlg) { log('⚠️ 设备 ' + dev + ': 推送弹窗未弹出，跳过'); continue; }

        // 5) 推送类型
        const okType = await setPushTypeInDialog(dlg, pushType);
        if (!okType) {
          log('⚠️ 设备 ' + dev + ': 推送类型设置失败，请人工处理当前弹窗');
          await waitForDialogClose();
          continue;
        }

        // 6) 等人工点确定/取消（弹窗消失 = 处理完，继续下一台）
        prog('⏳ 批量' + menuItem + '（' + groupName + '）' +
          (i + 1) + '/' + devices.length + ' — 设备 ' + dev +
          '：等待人工确认（确定/取消）…');
        await waitForDialogClose();
        log('✅ 设备 ' + dev + ' 处理完成（' + (i + 1) + '/' + devices.length + '）');
        await sleep(500);
      }
      prog(batchStopFlag
        ? '🛑 批量' + menuItem + '（' + groupName + '）已终止'
        : '🎉 批量' + menuItem + '（' + groupName + '）全部设备处理完毕');
      log(batchStopFlag ? '🛑 批量' + menuItem + '推送流程已终止' : '🎉 批量' + menuItem + '推送流程结束');
    } finally {
      batchRunning = false;
      busy = false;
      setTimeout(removeBatchProgress, 4000);
      // 批量改过端口状态，报表立刻重算一次（不强求，失败静默）
      if (document.getElementById(REPORT_ID)) {
        setTimeout(() => refreshReport(true), 800);
      }
    }
  }

  function makeBtn(name, devices) {
    // 外层容器承载 hover 下拉（换卡推送），内层是原快选按钮
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;display:inline-block;';

    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = name;
    b.title = '设备筛选: ' + devices.join(', ') + '\n悬停可选「换卡推送」批量流程';
    b.style.cssText =
      'padding:5px 16px;font-size:13px;border:1px solid #dcdfe6;border-radius:4px;' +
      'background:#fff;color:#606266;cursor:pointer;transition:all .15s;display:block;';
    const hoverOn = () => {
      b.style.color = '#409eff';
      b.style.borderColor = '#c6e2ff';
      b.style.background = '#ecf5ff';
    };
    const hoverOff = () => {
      b.style.color = '#606266';
      b.style.borderColor = '#dcdfe6';
      b.style.background = '#fff';
    };
    b.addEventListener('mouseenter', hoverOn);
    b.addEventListener('mouseleave', hoverOff);
    b.addEventListener('click', () => applyGroup(devices, name));
    wrap.appendChild(b);

    // hover 下拉：换卡推送（批量流程）
    const menu = document.createElement('div');
    menu.style.cssText =
      'display:none;position:absolute;top:100%;left:0;z-index:9999;min-width:88px;' +
      'background:#fff;border:1px solid #e4e7ed;border-radius:4px;padding:4px 0;' +
      'box-shadow:0 4px 12px rgba(0,0,0,.12);';
    let hideTimer = null;
    const showMenu = () => {
      clearTimeout(hideTimer);
      menu.style.display = 'block';
      hoverOn();
    };
    const scheduleHide = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        menu.style.display = 'none';
        hoverOff();
      }, 250); // 延迟收起，留出移到下拉的时间
    };
    wrap.addEventListener('mouseenter', showMenu);
    wrap.addEventListener('mouseleave', scheduleHide);
    for (const item of ['换卡']) {
      const mi = document.createElement('div');
      mi.textContent = item + '推送';
      mi.dataset.gavinBatchMenu = '1';
      mi.dataset.gavinBatchItem = item;
      mi.title = '逐台设备: 筛选设备 → 查询 → 只勾选「套餐<' + batchPkgLimit() +
        '」的端口 → 推送（' + (MENU_PUSH_TYPE[item] || item) +
        '）→ 等人工确认（阈值跟随报表头部输入框）';
      mi.style.cssText =
        'padding:6px 14px;font-size:12px;color:#606266;cursor:pointer;white-space:nowrap;';
      mi.addEventListener('mouseenter', () => {
        mi.style.background = '#ecf5ff';
        mi.style.color = '#409eff';
      });
      mi.addEventListener('mouseleave', () => {
        mi.style.background = '';
        mi.style.color = '';
      });
      mi.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.style.display = 'none';
        runBatch(name, item);
      });
      menu.appendChild(mi);
    }
    wrap.appendChild(menu);
    return wrap;
  }

  function buildBar() {
    // 内联按钮条：作为 flex 容器的普通子项，紧跟在"合伙人"下拉框后面
    const bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.style.cssText =
      'display:inline-flex;align-items:center;gap:6px;margin-left:12px;vertical-align:middle;';
    for (const [name, devices] of Object.entries(GROUPS_CURRENT)) {
      bar.appendChild(makeBtn(name, devices));
    }
    return bar;
  }

  // 配置加载完成后重建按钮条（组名/组数变化时按钮自动更新）
  function refreshBar() {
    const old = document.getElementById(BAR_ID);
    if (old) old.replaceWith(buildBar());
  }

  // ============ /mkt/send-task：「批量创建失败补发任务」弹窗汇总 ============
  // 弹窗里列的是「提交失败 / 发送失败」明细，没有合计 → 表格下方补一条汇总条
  const RESEND_PATH_KEYWORD = '/mkt/send-task';
  const RESEND_DIALOG_TITLE = '批量创建失败补发任务';
  const RESEND_BAR_ID = 'gavin-resend-summary';
  const RESEND_THROTTLE_MS = 200;
  const rlog = (...a) =>
    console.log('%c[补发汇总]', 'color:#009688;font-weight:bold', ...a);

  function onResendPage() {
    return (
      location.pathname.includes(RESEND_PATH_KEYWORD) ||
      location.hash.includes(RESEND_PATH_KEYWORD)
    );
  }

  // 找当前可见的补发弹窗（同名弹窗只认可见的那个）
  function findResendDialog() {
    for (const d of document.querySelectorAll('.el-dialog')) {
      if (d.getBoundingClientRect().width <= 0) continue;
      const t = d.querySelector('.el-dialog__title');
      if (t && t.textContent.includes(RESEND_DIALOG_TITLE)) return d;
    }
    return null;
  }

  // "1,234" / "8" / "" → 数字（空值按 0 计）
  function parseResendNum(text) {
    const s = String(text == null ? '' : text).replace(/[^\d.\-]/g, '');
    if (!s || s === '-' || s === '.') return 0;
    const v = Number(s);
    return Number.isFinite(v) ? v : 0;
  }

  // 从弹窗表格取值求和（列位置按表头文字定位，站点调列顺序也不会错）
  function computeResend(dlg) {
    const table = dlg.querySelector('.el-table');
    if (!table) return null;
    const heads = [...table.querySelectorAll('.el-table__header-wrapper thead th')]
      .map((th) => th.innerText.trim());
    const iSend = heads.indexOf('发送失败');
    const iSub = heads.indexOf('提交失败');
    if (iSend < 0) return null; // 表头还没渲染 / 不是这个弹窗

    let send = 0;
    let sub = 0;
    let rows = 0;
    for (const tr of table.querySelectorAll('.el-table__body-wrapper tbody tr')) {
      const tds = tr.querySelectorAll('td');
      if (!tds.length || iSend >= tds.length) continue;
      send += parseResendNum(tds[iSend].innerText);
      if (iSub >= 0 && iSub < tds.length) sub += parseResendNum(tds[iSub].innerText);
      rows++;
    }
    return { table, rows, sub, send, hasSub: iSub >= 0 };
  }

  function makeResendBar() {
    const bar = document.createElement('div');
    bar.id = RESEND_BAR_ID;
    bar.style.cssText =
      'display:flex;align-items:center;gap:18px;margin-top:8px;padding:8px 12px;' +
      'background:#f5f7fa;border:1px solid #ebeef5;border-radius:4px;' +
      'font-size:13px;color:#606266;line-height:1.5;';
    return bar;
  }

  function renderResendSummary(data) {
    const { table, rows, sub, send, hasSub } = data;
    const fmtN = (n) => n.toLocaleString('en-US');
    let bar = document.getElementById(RESEND_BAR_ID);
    // 表格换了（重新打开弹窗）或位置不对 → 重建并紧贴表格下方
    if (!bar || bar.previousElementSibling !== table) {
      if (bar) bar.remove();
      bar = makeResendBar();
      if (table.nextSibling) table.parentElement.insertBefore(bar, table.nextSibling);
      else table.parentElement.appendChild(bar);
    }
    const html =
      '<span>合计 <b style="color:#303133;font-size:14px">' + fmtN(rows) + '</b> 个任务</span>' +
      (hasSub
        ? '<span>提交失败 <b style="color:#303133">' + fmtN(sub) + '</b></span>'
        : '') +
      '<span>发送失败 <b style="color:#f56c6c;font-size:15px">' + fmtN(send) + '</b></span>' +
      (rows ? '' : '<span style="color:#909399">当前没有可补发的任务</span>');
    if (bar.__sig !== html) {
      bar.innerHTML = html;
      bar.__sig = html;
    }
  }

  let resendLastSig = '';

  function refreshResendSummary() {
    if (!onResendPage()) return;
    const dlg = findResendDialog();
    if (!dlg) {
      resendLastSig = ''; // 弹窗关闭，允许下次重算
      return;
    }
    const data = computeResend(dlg);
    if (!data) return;
    const sig = data.rows + '|' + data.sub + '|' + data.send + '|' + (data.hasSub ? 1 : 0);
    if (sig === resendLastSig && document.getElementById(RESEND_BAR_ID)) return;
    resendLastSig = sig;
    renderResendSummary(data);
    rlog('汇总：' + data.rows + ' 个任务，提交失败 ' + data.sub + '，发送失败 ' + data.send);
  }

  // 弹窗内数字异步渲染 / 勾选数变化 → 节流重算
  let resendTimer = null;
  function scheduleResendSummary() {
    if (resendTimer) return;
    resendTimer = setTimeout(() => {
      resendTimer = null;
      refreshResendSummary();
    }, RESEND_THROTTLE_MS);
  }

  // 诊断日志（10 秒最多一次，避免刷屏）
  let lastDiag = 0;
  function diag() {
    const now = Date.now();
    if (now - lastDiag < 10000) return;
    lastDiag = now;
    const labels = [...document.querySelectorAll('.query-label')].map(
      (e) => e.textContent.trim()
    );
    if (labels.length) {
      log('未找到「合伙人」，当前 query-label: [' + labels.join(' | ') + ']');
    } else {
      log('页面上没有 .query-label，可能不在筛选页或站点已改版');
    }
  }

  function tryInsert() {
    if (!onTargetPage()) return;
    if (document.getElementById(BAR_ID)) return;

    // 按真实结构：插到「合伙人」下拉框（label 的下一个兄弟）后面
    const partnerSelect = findSelectAfter('合伙人');
    if (partnerSelect) {
      partnerSelect.parentNode.insertBefore(buildBar(), partnerSelect.nextSibling);
      log('✅ 按钮已插入「合伙人」下拉框后面（' +
        Object.keys(GROUPS_CURRENT).join('/') + '）');
      return;
    }
    diag();
  }

  // SPA 路由切换 / 表格重渲染兜底轮询（站点重渲染筛选栏后自动补插）
  setInterval(tryInsert, 1500);
  setInterval(tryInsertReport, 1500);
  setInterval(refreshResendSummary, 1500); // 补发弹窗兜底刷新（仅 /mkt/send-task 生效）

  // 后台保鲜：每 60 秒静默更新一次（先渲染缓存、再拉最新，不打断阅读）
  setInterval(() => {
    if (document.hidden) return;
    if (!document.getElementById(REPORT_ID)) return;
    refreshReport();
  }, 60 * 1000);

  // 从后台标签页切回来时立即补一次
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!document.getElementById(REPORT_ID)) return;
    refreshReport();
  });

  // run-at document-start 时 body 可能还不存在，就绪后再挂观察器
  function start() {
    new MutationObserver(() => {
      tryInsert();
      tryInsertReport();
    }).observe(document.body, {
      childList: true,
      subtree: true,
    });
    tryInsert();
    tryInsertReport();

    // 补发弹窗汇总：只在 /mkt/send-task 挂观察器
    if (onResendPage()) {
      new MutationObserver(scheduleResendSummary).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      refreshResendSummary();
      rlog('已加载：打开「批量补发失败」弹窗后会在表格下方显示汇总');
    }

    loadConfig(); // 异步拉取业务配置，成功后自动刷新按钮
    if (onReportPage()) {
      fetchAllPorts().catch(() => {}); // 提前预取端口数据，与页面渲染并行
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  log('v1.15.0 已加载，设备分组来源：业务配置 ' + CONFIG_KEY + '（拉取失败时用内置兜底）');
})();
