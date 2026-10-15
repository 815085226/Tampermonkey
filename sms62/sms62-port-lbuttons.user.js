// ==UserScript==
// @name         sms62 端口页 L1-L5 设备快选按钮
// @namespace    gavin.sms62
// @version      1.6.3
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
      // 只保留统计需要的 3 个字段，避免超出 sessionStorage 容量
      const slim = rows.map((r) => ({
        d: String(r.deviceName ?? ''), // 设备名
        t: Number(r.totalSend) || 0,   // 发送总数
        s: r.status,                   // 状态
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
      for (const r of groupRows) {
        const k = statusLabel(r.s ?? r.status);
        statusMap[k] = (statusMap[k] || 0) + 1;
      }
      stats.push({
        name,
        devices,
        total: groupRows.length,
        over500,
        statusMap,
      });
    }
    return stats;
  }

  function buildReportTable(stats) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:10px 14px;overflow-x:auto;';

    const tbl = document.createElement('table');
    tbl.style.cssText =
      'border-collapse:collapse;font-size:13px;min-width:640px;width:100%;';
    const thead = document.createElement('thead');
    thead.innerHTML =
      '<tr>' +
      ['分组', '端口总数', '发送总数&gt;' + over500Threshold, '状态分布']
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
      // 状态分布：按数量降序的彩色标签
      const chips = Object.entries(s.statusMap)
        .sort((a, b) => b[1] - a[1])
        .map(
          ([label, count]) =>
            '<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;' +
            'border-radius:3px;background:#ecf5ff;color:#409eff;font-size:12px;">' +
            label + ': <b>' + count + '</b></span>'
        )
        .join(' ') || '<span style="color:#c0c4cc">无数据</span>';

      tr.innerHTML =
        '<td style="border:1px solid #ebeef5;padding:8px 12px;font-weight:600;">' + s.name + '</td>' +
        '<td style="border:1px solid #ebeef5;padding:8px 12px;">' + s.total + '</td>' +
        '<td style="border:1px solid #ebeef5;padding:8px 12px;' +
        (s.over500 > 0 ? 'color:#f56c6c;font-weight:600;' : 'color:#909399;') +
        '">' + s.over500 + '</td>' +
        '<td style="border:1px solid #ebeef5;padding:8px 12px;">' + chips + '</td>';

      // 悬浮提示展示组内设备清单
      tr.title = s.name + ' 设备: ' + s.devices.join(', ');
      tbody.appendChild(tr);
    }

    // 状态汇总行：跨组合计每个状态的总数
    if (stats.length) {
      const sumMap = {};
      let sumTotal = 0;
      let sumOver500 = 0;
      for (const s of stats) {
        sumTotal += s.total;
        sumOver500 += s.over500;
        for (const [label, count] of Object.entries(s.statusMap)) {
          sumMap[label] = (sumMap[label] || 0) + count;
        }
      }
      const sumChips =
        Object.entries(sumMap)
          .sort((a, b) => b[1] - a[1])
          .map(
            ([label, count]) =>
              '<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;' +
              'border-radius:3px;background:#f0f9eb;color:#67c23a;font-size:12px;">' +
              label + ': <b>' + count + '</b></span>'
          )
          .join(' ') || '<span style="color:#c0c4cc">无数据</span>';

      const sumTr = document.createElement('tr');
      sumTr.innerHTML =
        '<td style="border:1px solid #ebeef5;padding:8px 12px;font-weight:700;color:#303133;background:#fafafa;">汇总</td>' +
        '<td style="border:1px solid #ebeef5;padding:8px 12px;font-weight:700;background:#fafafa;">' + sumTotal + '</td>' +
        '<td style="border:1px solid #ebeef5;padding:8px 12px;font-weight:700;background:#fafafa;' +
        (sumOver500 > 0 ? 'color:#f56c6c;' : 'color:#909399;') +
        '">' + sumOver500 + '</td>' +
        '<td style="border:1px solid #ebeef5;padding:8px 12px;background:#fafafa;">' + sumChips + '</td>';
      tbody.appendChild(sumTr);
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);

    const foot = document.createElement('div');
    foot.style.cssText = 'margin-top:8px;font-size:12px;color:#909399;';
    foot.textContent =
      '统计范围: 全部端口数据（设备归属按业务配置 ' + CONFIG_KEY + ' 划分），点击右上角「刷新报表」更新';
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
    if (!onTargetPage()) return;
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

  // 找"已打开且包含目标设备"的下拉浮层（浮层 teleport 到 body）
  function findDeviceDropdown(devices) {
    for (const dd of document.querySelectorAll('.el-select-dropdown')) {
      if (dd.offsetParent === null) continue; // 不可见
      const items = [...dd.querySelectorAll('.el-select-dropdown__item')];
      if (items.some((it) => matchDevice(it.textContent.trim(), devices))) return dd;
    }
    return null;
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

  // 同步多选下拉的选中项：选上目标设备、取消多余已选项
  async function syncSelection(dd, devices) {
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      const items = [...dd.querySelectorAll('.el-select-dropdown__item')];
      for (const it of items) {
        const text = it.textContent.trim();
        const isSel = it.classList.contains('is-selected');
        const want = matchDevice(text, devices);
        if (want && !isSel) {
          fireClick(it);
          changed = true;
          await sleep(150);
        } else if (!want && isSel) {
          fireClick(it); // 取消不在目标组里的已选设备
          changed = true;
          await sleep(150);
        }
      }
      if (!changed) return true; // 无变化 = 选择已精确同步
    }
    return false;
  }

  let busy = false;

  async function applyGroup(devices, name) {
    if (busy) return;
    busy = true;
    try {
      const sel = findSelectAfter('设备');
      if (!sel) { log('未找到「设备」下拉框'); return; }
      const wrapper =
        sel.querySelector('.el-select__wrapper') || sel;
      if (!wrapper) { log('未找到设备下拉框'); return; }

      // 先确保下拉是关闭状态，再重新打开，避免 toggle 关掉
      document.body.click();
      await sleep(250);
      fireClick(wrapper);
      await sleep(400);

      const dd = findDeviceDropdown(devices);
      if (!dd) {
        document.body.click();
        log('未找到包含目标设备的下拉浮层');
        return;
      }

      const ok = await syncSelection(dd, devices);
      await sleep(200);
      document.body.click(); // 收起下拉
      await sleep(300);

      if (ok) {
        log('✅ 已将设备筛选设为 ' + name + '（' + devices.join(', ') + '）');
        if (AUTO_SEARCH) clickSearchButton();
      } else {
        log('⚠️ ' + name + ' 同步后未能完全确认，请核对下拉框选中项');
      }
    } finally {
      busy = false;
    }
  }

  function makeBtn(name, devices) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = name;
    b.title = '设备筛选: ' + devices.join(', ');
    b.style.cssText =
      'padding:5px 16px;font-size:13px;border:1px solid #dcdfe6;border-radius:4px;' +
      'background:#fff;color:#606266;cursor:pointer;transition:all .15s;';
    b.addEventListener('mouseenter', () => {
      b.style.color = '#409eff';
      b.style.borderColor = '#c6e2ff';
      b.style.background = '#ecf5ff';
    });
    b.addEventListener('mouseleave', () => {
      b.style.color = '#606266';
      b.style.borderColor = '#dcdfe6';
      b.style.background = '#fff';
    });
    b.addEventListener('click', () => applyGroup(devices, name));
    return b;
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
    if (onTargetPage()) {
      fetchAllPorts().catch(() => {}); // 提前预取端口数据，与页面渲染并行
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  log('v1.6.3 已加载，设备分组来源：业务配置 ' + CONFIG_KEY + '（拉取失败时用内置兜底）');
})();
