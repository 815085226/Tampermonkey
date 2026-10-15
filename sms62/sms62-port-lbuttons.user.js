// ==UserScript==
// @name         sms62 端口页 L1-L5 设备快选按钮
// @namespace    gavin.sms62
// @version      1.5.0
// @description  在 http://web.sms62.com/mkt/port 的"合伙人"后面增加 L 设备组按钮（L1~L5，组名从业务配置 LOCATION:DEVICES:CONFIG 动态获取，新增组自动出现），一键把"设备"筛选条件设为对应设备组
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

  // ===== 页面交互辅助 =====
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

  // run-at document-start 时 body 可能还不存在，就绪后再挂观察器
  function start() {
    new MutationObserver(() => tryInsert()).observe(document.body, {
      childList: true,
      subtree: true,
    });
    tryInsert();
    loadConfig(); // 异步拉取业务配置，成功后自动刷新按钮
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  log('v1.5 已加载，设备分组来源：业务配置 ' + CONFIG_KEY + '（拉取失败时用内置兜底）');
})();
