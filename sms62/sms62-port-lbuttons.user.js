// ==UserScript==
// @name         sms62 端口页 L1-L5 设备快选按钮
// @namespace    gavin.sms62
// @version      1.8.4
// @description  在 http://web.sms62.com/mkt/port 的"合伙人"后面增加 L 设备组按钮（组名从业务配置 LOCATION:DEVICES:CONFIG 动态获取，新增组自动出现），一键把"设备"筛选条件设为对应设备组；并在筛选栏与列表之间增加可折叠的 L 组数据报表（发送总数>500 数量 + 各状态分布）
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
  let over500Threshold = 500; // 发送总数阈值（可在报表头部输入框调整）
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
    } catch (e) { /* ignore */ }
    return _fetch.apply(this, arguments);
  };
  const _setReqHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (String(k).toLowerCase() === 'authorization') AUTH = v;
    return _setReqHeader.apply(this, arguments);
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
  const REPORT_CACHE_KEY = 'gavin-lreport-cache-v1';
  const REPORT_CACHE_TTL = 5 * 60 * 1000; // 缓存 5 分钟
  let reportDataPromise = null; // 进行中的拉取请求（防重复）

  function readCache() {
    try {
      const c = JSON.parse(sessionStorage.getItem(REPORT_CACHE_KEY) || 'null');
      if (c && Date.now() - c.ts < REPORT_CACHE_TTL && Array.isArray(c.rows)) return c;
    } catch (e) { /* 缓存损坏则忽略 */ }
    return null;
  }

  function writeCache(rows) {
    try {
      // 只保留统计需要的字段，避免超出 sessionStorage 容量
      const slim = rows.map((r) => ({
        d: String(r.deviceName ?? ''), // 设备名
        t: Number(r.totalSend) || 0,   // 发送总数
        s: r.status,                   // 状态
        p: r.pkgs,                     // 套餐
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
      return rows;
    })();

    try {
      return await reportDataPromise;
    } finally {
      reportDataPromise = null;
    }
  }

  async function loadStatusDict() {
    try {
      const json = await apiGet(STATUS_DICT_API);
      const list = json.data || [];
      statusDict = {};
      for (const d of list) statusDict[String(d.dictValue)] = d.dictLabel;
    } catch (e) {
      log('状态字典拉取失败，报表将直接显示状态原始值');
    }
  }

  const statusLabel = (v) => statusDict[String(v)] || String(v ?? '未知');

  function buildStats(rows) {
    const stats = [];
    for (const [name, devices] of Object.entries(GROUPS_CURRENT)) {
      const groupRows = rows.filter((r) =>
        // 兼容两种行结构：接口原始行 / 本地缓存的精简行（d/t/s）
        matchDevice(String(r.d ?? r.deviceName ?? '').trim(), devices)
      );
      const over500 = groupRows.filter(
        (r) => Number(r.t ?? r.totalSend) > over500Threshold
      ).length;
      const statusMap = {};
      const pkgMap = {};
      for (const r of groupRows) {
        const k = statusLabel(r.s ?? r.status);
        statusMap[k] = (statusMap[k] || 0) + 1;
        const pkg = String(r.p ?? r.pkgs ?? '').trim();
        if (pkg) pkgMap[pkg] = (pkgMap[pkg] || 0) + 1;
      }
      stats.push({
        name,
        devices,
        total: groupRows.length,
        over500,
        statusMap,
        pkgMap,
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

  // 套餐标签（灰色，仅展示；套餐在筛选栏没有对应过滤条件，不做点击筛选）
  function makePkgChip(label, count) {
    const span = document.createElement('span');
    span.style.cssText =
      'display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;border-radius:3px;' +
      'background:#f4f4f5;color:#909399;font-size:12px;white-space:nowrap;';
    span.innerHTML = label + ': <b>' + count + '</b>';
    return span;
  }

  function buildReportTable(stats) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:10px 14px;overflow-x:auto;';

    const tbl = document.createElement('table');
    tbl.style.cssText =
      'border-collapse:collapse;font-size:13px;min-width:760px;width:100%;';
    const thead = document.createElement('thead');
    thead.innerHTML =
      '<tr>' +
      ['分组', '端口总数', '套餐分布', '发送总数&gt;' + over500Threshold, '状态分布']
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
      tdName.style.cssText = 'border:1px solid #ebeef5;padding:8px 12px;font-weight:600;';
      tdName.textContent = s.name;
      const tdTotal = document.createElement('td');
      tdTotal.style.cssText = 'border:1px solid #ebeef5;padding:8px 12px;';
      tdTotal.textContent = s.total;

      // 套餐分布（按数量降序）
      const pkgTd = document.createElement('td');
      pkgTd.style.cssText = 'border:1px solid #ebeef5;padding:8px 12px;';
      const pkgEntries = Object.entries(s.pkgMap).sort((a, b) => b[1] - a[1]);
      if (!pkgEntries.length) {
        const none = document.createElement('span');
        none.style.cssText = 'color:#c0c4cc';
        none.textContent = '无套餐';
        pkgTd.appendChild(none);
      } else {
        for (const [label, count] of pkgEntries) {
          pkgTd.appendChild(makePkgChip(label, count));
        }
      }

      const tdOver = document.createElement('td');
      tdOver.style.cssText =
        'border:1px solid #ebeef5;padding:8px 12px;' +
        (s.over500 > 0 ? 'color:#f56c6c;font-weight:600;' : 'color:#909399;');
      tdOver.textContent = s.over500;

      tr.appendChild(tdName);
      tr.appendChild(tdTotal);
      tr.appendChild(pkgTd);
      tr.appendChild(tdOver);
      tr.appendChild(statusTd);

      // 悬浮提示展示组内设备清单
      tr.title = s.name + ' 设备: ' + s.devices.join(', ');
      tbody.appendChild(tr);
    }

    // 状态汇总行：跨组合计每个状态的总数
    if (stats.length) {
      const sumMap = {};
      let sumTotal = 0;
      let sumOver500 = 0;
      const sumPkgMap = {};
      for (const s of stats) {
        sumTotal += s.total;
        sumOver500 += s.over500;
        for (const [label, count] of Object.entries(s.statusMap)) {
          sumMap[label] = (sumMap[label] || 0) + count;
        }
        for (const [label, count] of Object.entries(s.pkgMap)) {
          sumPkgMap[label] = (sumPkgMap[label] || 0) + count;
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

      // 套餐汇总（跨组合计）
      const pkgTd = document.createElement('td');
      pkgTd.style.cssText =
        'border:1px solid #ebeef5;padding:8px 12px;background:#fafafa;';
      const sumPkgEntries = Object.entries(sumPkgMap).sort((a, b) => b[1] - a[1]);
      if (!sumPkgEntries.length) {
        const none = document.createElement('span');
        none.style.cssText = 'color:#c0c4cc';
        none.textContent = '无套餐';
        pkgTd.appendChild(none);
      } else {
        for (const [label, count] of sumPkgEntries) {
          pkgTd.appendChild(makePkgChip(label, count));
        }
      }

      const tdOver = document.createElement('td');
      tdOver.style.cssText =
        'border:1px solid #ebeef5;padding:8px 12px;font-weight:700;background:#fafafa;' +
        (sumOver500 > 0 ? 'color:#f56c6c;' : 'color:#909399;');
      tdOver.textContent = sumOver500;
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
      sumTr.appendChild(pkgTd);
      sumTr.appendChild(tdOver);
      sumTr.appendChild(statusTd);
      tbody.appendChild(sumTr);
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);

    const foot = document.createElement('div');
    foot.style.cssText = 'margin-top:8px;font-size:12px;color:#909399;';
    foot.textContent =
      '统计范围: 全部端口数据（设备归属按业务配置 ' + CONFIG_KEY + ' 划分）；点击状态标签可反向筛选列表，点「刷新报表」更新数据';
    wrap.appendChild(foot);
    return wrap;
  }

  // 阈值调整后用本地已拉取的数据即时重渲染（不重新发请求）
  function rebuildReportTable() {
    const body = document.getElementById(REPORT_ID + '-body');
    if (!body || !lastRows.length) return; // 数据还没拉到时等首次加载
    body.innerHTML = '';
    body.appendChild(buildReportTable(buildStats(lastRows)));
  }

  async function refreshReport(force) {
    const body = document.getElementById(REPORT_ID + '-body');
    const tip = document.getElementById(REPORT_ID + '-tip');
    if (!body) return;
    try {
      tip.textContent = '加载中…';
      tip.style.display = 'block';
      if (!Object.keys(statusDict).length) await loadStatusDict();
      const rows = await fetchAllPorts(force);
      lastRows = rows;
      const stats = buildStats(rows);
      body.innerHTML = '';
      body.appendChild(buildReportTable(stats));
      tip.style.display = 'none';
      log('✅ L 组报表已刷新（共 ' + rows.length + ' 条端口数据）');
    } catch (e) {
      tip.textContent = '报表加载失败: ' + (e && e.message);
      log('报表加载失败:', e);
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
      '📊 L 组数据报表（发送总数>' + over500Threshold + ' / 状态分布）';
    title.textContent = titleText();

    const ops = document.createElement('div');
    ops.style.cssText = 'display:flex;align-items:center;gap:8px;';

    // 阈值输入：调整"发送总数>N"的 N，改动后用本地数据即时重算（不发请求）
    const thLabel = document.createElement('span');
    thLabel.style.cssText = 'font-size:12px;color:#909399;';
    thLabel.textContent = '发送总数＞';
    const thInput = document.createElement('input');
    thInput.type = 'number';
    thInput.min = '0';
    thInput.step = '1';
    thInput.value = over500Threshold;
    thInput.title = '调整阈值后立即重新统计';
    thInput.style.cssText =
      'width:76px;padding:3px 6px;font-size:12px;border:1px solid #dcdfe6;' +
      'border-radius:4px;color:#606266;outline:none;';
    const applyThreshold = () => {
      const v = parseInt(thInput.value, 10);
      if (isNaN(v) || v < 0) { thInput.value = over500Threshold; return; }
      if (v === over500Threshold) return;
      over500Threshold = v;
      title.textContent = titleText();
      rebuildReportTable(); // 用已拉取的数据重算，无需重新请求
      log('阈值已调整为 发送总数>' + over500Threshold + '，报表已重新统计');
    };
    thInput.addEventListener('change', applyThreshold);
    thInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') thInput.blur(); // 回车确认
    });
    thInput.addEventListener('click', (e) => e.stopPropagation()); // 不触发折叠
    ops.appendChild(thLabel);
    ops.appendChild(thInput);

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
      if (devices !== undefined) {
        const wantFn = devices
          ? (t) => matchDevice(t, devices)
          : () => false; // 清空：取消所有已选设备
        ok =
          (await syncDropdown('设备', wantFn, devices ? undefined : () => true)) &&
          ok;
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
  const BATCH_SEND_TOTAL = 500;          // 批量流程使用的发送总数阈值
  const BATCH_RULE = '>';                // 发送总数规则（页面默认是"<"，需切为">"）
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

  // 切换"发送总数"的规则下拉（< / > / = ...）
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

    batchRunning = true;
    busy = true; // 批量期间禁用其他快选操作
    batchStopFlag = false;
    const prog = batchProgress();
    try {
      log('🚀 开始批量' + menuItem + '推送：L ' + groupName + '（' +
        devices.length + ' 台设备，发送总数>' + BATCH_SEND_TOTAL + '）');
      for (let i = 0; i < devices.length; i++) {
        if (batchStopFlag) {
          log('🛑 批量任务已终止，剩余 ' + (devices.length - i) + ' 台设备未处理');
          break;
        }
        const dev = devices[i];
        prog('📋 批量' + menuItem + '（' + groupName + '）' +
          (i + 1) + '/' + devices.length + ' — 设备 ' + dev + '：设置筛选…');

        // 1) 设备筛选 = 仅这台设备
        const okDev = await syncDropdown('设备', (t) => t === dev);
        if (!okDev) { log('⚠️ 设备 ' + dev + ' 筛选设置失败，跳过'); continue; }

        // 2) 发送总数 = 500，规则切为 >
        const c = findSendTotalControls();
        if (c && c.input) setInputValue(c.input, String(BATCH_SEND_TOTAL));
        else log('⚠️ 未找到发送总数输入框');
        const okRule = await setSendTotalRule(BATCH_RULE);
        if (!okRule) log('⚠️ 发送总数规则切换失败，结果可能不含 >' + BATCH_SEND_TOTAL + ' 条件');

        // 3) 查询
        clickSearchButton();
        await sleep(2000); // 等列表刷新
        if (batchStopFlag) {
          log('🛑 批量任务已终止（设备 ' + dev + ' 未推送）');
          break;
        }

        // 3.5) 自动勾选查询结果（推送按钮要求先选中行）
        const selected = await selectAllQueryRows();
        if (!selected) {
          log('ℹ️ 设备 ' + dev + ': 没有可勾选的查询结果（发送总数>' +
            BATCH_SEND_TOTAL + ' 无数据），跳过');
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
      mi.title = '逐台设备: 筛选设备 + 发送总数>' + BATCH_SEND_TOTAL + ' → 查询 → 推送（' + (MENU_PUSH_TYPE[item] || item) + '）→ 等人工确认';
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

  log('v1.8.4 已加载，设备分组来源：业务配置 ' + CONFIG_KEY + '（拉取失败时用内置兜底）');
})();
