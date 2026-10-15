// ==UserScript==
// @name         sms62 端口页自动 200/page
// @namespace    gavin.sms62
// @version      1.1.0
// @description  自动将 http://web.sms62.com/mkt/port 列表分页大小切换为 200/page（已是 200 时不动作）
// @author       Gavin
// @match        http://web.sms62.com/*
// @match        https://web.sms62.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const TARGET = 200;               // 目标每页条数
  const PATH_KEYWORD = '/mkt/port'; // 仅在此页面生效
  const MAX_TOTAL_ATTEMPTS = 8;     // 整个页面生命周期内总尝试上限，防止死循环
  const RETRY_DELAY = 800;          // 重试间隔 ms

  const log = (...a) =>
    console.log('%c[200/page]', 'color:#009688;font-weight:bold', ...a);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 兼容 history 路由和 hash 路由
  function onTargetPage() {
    return (
      location.pathname.includes(PATH_KEYWORD) ||
      location.hash.includes(PATH_KEYWORD)
    );
  }

  // 派发完整的鼠标事件序列（Vue 组件对合成 click 也响应）
  function fireClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  // 读取当前选中的每页条数。
  // v1.0 从 .el-select__selected-item 取值，部分 Element Plus 版本拿不到文本导致
  // "已是 200 仍反复点击"。v1.1 改为直接读整个 sizes 选择器的文本（下拉浮层是
  // teleport 到 body 的，不会混入选项文本），更可靠。
  function currentSize() {
    const wrapper = document.querySelector(
      '.el-pagination .el-pagination__sizes, .el-pagination .el-select'
    );
    if (!wrapper) return null;
    const m = (wrapper.textContent || '').match(/(\d+)\s*\/\s*page/i);
    return m ? parseInt(m[1], 10) : null;
  }

  // 打开分页栏里的"条数"下拉
  function openSizeDropdown() {
    const wrapper =
      document.querySelector('.el-pagination .el-pagination__sizes .el-select__wrapper') ||
      document.querySelector('.el-pagination .el-select__wrapper') ||
      document.querySelector('.el-pagination .el-select');
    if (!wrapper) return false;
    fireClick(wrapper);
    return true;
  }

  // 在已打开的下拉浮层里找 "200/page" 选项（浮层 teleport 到 body）
  function findOption() {
    const items = document.querySelectorAll('.el-select-dropdown__item');
    for (const it of items) {
      if (it.offsetParent === null) continue; // 不可见的跳过
      const re = new RegExp('^\\s*' + TARGET + '\\s*(条)?\\s*/\\s*page\\s*$', 'i');
      if (re.test(it.textContent)) return it;
    }
    return null;
  }

  async function clickTargetOption() {
    if (!openSizeDropdown()) {
      log('未找到分页条数选择器');
      return 'no-selector';
    }
    await sleep(350); // 等下拉浮层渲染（popper 动画）
    const opt = findOption();
    if (!opt) {
      document.body.click(); // 收起下拉
      return 'no-option';
    }
    fireClick(opt);
    await sleep(600);
    return 'clicked';
  }

  let attempts = 0;      // 总尝试次数（含读取失败的情况）
  let settled = false;   // 已确认为 200/page，之后不再动作
  let inFlight = false;

  async function tryRun() {
    if (inFlight || settled || !onTargetPage()) return;
    if (!document.querySelector('.el-pagination')) return; // 分页还没渲染
    if (attempts >= MAX_TOTAL_ATTEMPTS) return;

    const cur = currentSize();
    if (cur === TARGET) {
      if (attempts > 0) log('✅ 确认已是 ' + TARGET + '/page，后续不再动作');
      settled = true;
      return;
    }

    inFlight = true;
    attempts++;
    log('第 ' + attempts + ' 次尝试，当前读到的条数: ' + (cur === null ? '无法解析' : cur));

    const result = await clickTargetOption();

    if (result === 'no-selector') {
      settled = true; // 结构对不上，别刷屏重试
      log('❌ 找不到 sizes 选择器，脚本停止（可能站点改版，请反馈）');
    } else if (result === 'no-option') {
      if (attempts >= MAX_TOTAL_ATTEMPTS) {
        settled = true;
        log('❌ 多次未找到 ' + TARGET + '/page 选项，脚本停止（可能站点改版，请反馈）');
      }
    } else {
      const after = currentSize();
      if (after === TARGET) {
        settled = true;
        log('✅ 已切换为 ' + TARGET + '/page');
      } else if (attempts >= MAX_TOTAL_ATTEMPTS) {
        settled = true;
        log('❌ 切换后读到的值: ' + (after === null ? '无法解析' : after) + '，达到重试上限，脚本停止');
      }
    }
    inFlight = false;
  }

  // SPA 首次加载 / 登录后跳转 / 路由切换，统一用轮询兜底
  setInterval(tryRun, 1500);

  // DOM 变化（表格数据加载完成）时立即尝试一次，反应更快
  new MutationObserver(() => tryRun()).observe(document.body, {
    childList: true,
    subtree: true,
  });

  log('v1.1 已加载，等待分页组件出现…');
})();
