// ==UserScript==
// @name         sms62 端口页自动 200/page
// @namespace    gavin.sms62
// @version      1.2.0
// @description  自动将 http://web.sms62.com/mkt/port 列表分页大小切换为 200/page；并在 L 按钮条后加「买套餐」按钮（筛选状态=新插卡→全选→修改状态→选套餐用尽→等人工确认）
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
  new MutationObserver(() => {
    tryRun();
    tryInsertBuyBtn();
  }).observe(document.body, {
    childList: true,
    subtree: true,
  });

  // ===== 买套餐：L 按钮条后面的按钮，一键「新插卡→全选→修改状态→套餐用尽」 =====
  const BUY_STATUS_FILTER = '新插卡';   // 筛选状态
  const BUY_NEW_STATUS = '套餐用尽';    // 弹窗里要选择的新状态
  const BUY_BTN_ID = 'gavin-buy-pkg-btn';
  const LBAR_ID = 'gavin-lbar';         // lbuttons 脚本的按钮条

  // SPA 路由切换兜底轮询（与分页逻辑共用节奏）
  setInterval(tryInsertBuyBtn, 1500);

  // 交互辅助（与 lbuttons 脚本同机制；sleep 复用文件顶部已有定义）

  function fireClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findQueryLabel(labelText) {
    for (const lb of document.querySelectorAll('span.query-label')) {
      if (lb.textContent.trim() === labelText && isVisible(lb)) return lb;
    }
    return null;
  }

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

  function clickSearchButton() {
    for (const b of document.querySelectorAll('button')) {
      const t = b.textContent.trim();
      if (t === '查询' || t === '搜索') { b.click(); return true; }
    }
    log('未找到查询按钮');
    return false;
  }

  // 打开某 label 的下拉、按 wantFn 同步选中项、收起
  async function syncDropdown(labelText, wantFn, ddMatcher) {
    const sel = findSelectAfter(labelText);
    if (!sel) { log('未找到「' + labelText + '」下拉框'); return false; }
    const wrapper = sel.querySelector('.el-select__wrapper') || sel;

    document.body.click();
    await sleep(250);
    fireClick(wrapper);
    await sleep(400);

    const matchDd = ddMatcher || ((items) => items.some((it) => wantFn(it.textContent.trim())));
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

    // 同步选中项（最多 3 轮直到无变化）
    let ok = false;
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const it of dd.querySelectorAll('.el-select-dropdown__item')) {
        const text = it.textContent.trim();
        const isSel = it.classList.contains('is-selected');
        const want = wantFn(text);
        if ((want && !isSel) || (!want && isSel)) {
          fireClick(it);
          changed = true;
          await sleep(150);
        }
      }
      if (!changed) { ok = true; break; }
    }
    await sleep(200);
    document.body.click();
    await sleep(300);
    if (!ok) log('⚠️ 「' + labelText + '」同步后未能完全确认，请核对');
    return ok;
  }

  // 全选当前查询结果（点击表头复选框）
  async function selectAllQueryRows() {
    if (document.querySelector('.el-table__body-wrapper .el-checkbox__input.is-checked')) {
      return true;
    }
    const headerCb = document.querySelector(
      '.el-table__header-wrapper .el-table__cell .el-checkbox'
    );
    if (!headerCb) { log('未找到表头全选复选框'); return false; }
    fireClick(headerCb.querySelector('input') || headerCb);
    await sleep(500);
    const ok = !!document.querySelector(
      '.el-table__body-wrapper .el-checkbox__input.is-checked'
    );
    if (!ok) log('全选后未检测到选中行（可能查询结果为空）');
    return ok;
  }

  // 找「修改状态」弹窗（可见的）
  function findStatusDialog() {
    for (const dlg of document.querySelectorAll('.el-dialog')) {
      const t = dlg.querySelector('.el-dialog__title');
      if (t && t.textContent.includes('修改状态') && isVisible(dlg)) return dlg;
    }
    return null;
  }

  async function waitForStatusDialog(timeoutMs) {
    const end = Date.now() + (timeoutMs || 8000);
    while (Date.now() < end) {
      const dlg = findStatusDialog();
      if (dlg) return dlg;
      await sleep(400);
    }
    return null;
  }

  // 弹窗内把「状态」下拉选为目标状态
  async function setNewStatusInDialog(dlg, statusName) {
    const selWrap =
      dlg.querySelector('.el-dialog__body .el-select__wrapper') ||
      dlg.querySelector('.el-dialog__body .el-select');
    if (!selWrap) { log('修改状态弹窗中未找到状态下拉'); return false; }
    fireClick(selWrap);
    await sleep(400);
    let item = null;
    for (const d of document.querySelectorAll('.el-select-dropdown')) {
      if (d.offsetParent === null) continue;
      for (const it of d.querySelectorAll('.el-select-dropdown__item')) {
        if (it.textContent.trim() === statusName) { item = it; break; }
      }
      if (item) break;
    }
    if (!item) {
      document.body.click();
      log('未找到状态选项「' + statusName + '」');
      return false;
    }
    fireClick(item);
    await sleep(250);
    fireClick(selWrap); // 再点一下收起下拉
    await sleep(300);
    log('新状态已选「' + statusName + '」，等待人工点确定/取消');
    return true;
  }

  let buyBusy = false;

  async function runBuyPackage() {
    if (buyBusy) return;
    buyBusy = true;
    const btn = document.getElementById(BUY_BTN_ID);
    const setBtn = (t, dis) => {
      if (btn) { btn.textContent = t; btn.disabled = !!dis; }
    };
    try {
      setBtn('执行中…', true);
      log('🚀 买套餐流程开始：状态=' + BUY_STATUS_FILTER + ' → 全选 → 修改状态 → ' + BUY_NEW_STATUS);

      // 1) 清空设备筛选（避免残留设备条件导致结果不全）
      const cleared = await syncDropdown('设备', () => false, () => true);
      if (!cleared) log('⚠️ 设备筛选未能清空，继续执行（请自行确认设备栏为空）');

      // 2) 状态筛选 = 新插卡
      const okStatus = await syncDropdown('状态', (t) => t === BUY_STATUS_FILTER);
      if (!okStatus) { log('❌ 状态筛选设置失败，流程终止'); return; }

      // 3) 查询
      clickSearchButton();
      await sleep(2500);

      // 4) 全选查询结果
      const okSel = await selectAllQueryRows();
      if (!okSel) { log('❌ 未能勾选任何数据（可能无' + BUY_STATUS_FILTER + '端口），流程终止'); return; }

      // 5) 点「修改状态」按钮
      let modifyBtn = null;
      for (const b of document.querySelectorAll('button')) {
        if (b.textContent.trim() === '修改状态' && isVisible(b) && !b.disabled) { modifyBtn = b; break; }
      }
      if (!modifyBtn) { log('❌ 未找到可用的「修改状态」按钮（按钮可能被禁用），流程终止'); return; }
      modifyBtn.click();

      // 6) 等弹窗出现并选择新状态
      const dlg = await waitForStatusDialog(8000);
      if (!dlg) { log('❌ 「修改状态」弹窗未出现，流程终止'); return; }
      const okSet = await setNewStatusInDialog(dlg, BUY_NEW_STATUS);
      if (!okSet) return;

      // 7) 等人工点「确定」或「取消」（弹窗消失即结束）
      const end = Date.now() + 10 * 60 * 1000; // 最多等 10 分钟
      while (findStatusDialog() && Date.now() < end) await sleep(500);
      log(findStatusDialog() ? '⏱️ 等待超时，流程结束（弹窗仍开着，请人工处理）' : '✅ 弹窗已关闭，买套餐流程结束');
    } finally {
      setBtn('买套餐', false);
      buyBusy = false;
    }
  }

  // 在 L 按钮条（lbuttons 脚本插入的 #gavin-lbar）后面插「买套餐」按钮
  function tryInsertBuyBtn() {
    if (!onTargetPage()) return;
    if (document.getElementById(BUY_BTN_ID)) return;
    const bar = document.getElementById(LBAR_ID);
    if (!bar || !bar.parentNode) return; // lbuttons 按钮条还没出现

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = BUY_BTN_ID;
    btn.textContent = '买套餐';
    btn.title =
      '一键流程：状态筛选=' + BUY_STATUS_FILTER + ' → 查询 → 全选 → 修改状态 → 选「' +
      BUY_NEW_STATUS + '」→ 等人工确认';
    btn.style.cssText =
      'padding:5px 16px;font-size:13px;border:1px solid #dcdfe6;border-radius:4px;' +
      'background:#fff;color:#606266;cursor:pointer;transition:all .15s;margin-left:2px;';
    btn.addEventListener('mouseenter', () => {
      btn.style.color = '#e6a23c';
      btn.style.borderColor = '#f3d19e';
      btn.style.background = '#fdf6ec';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.color = '#606266';
      btn.style.borderColor = '#dcdfe6';
      btn.style.background = '#fff';
    });
    btn.addEventListener('click', runBuyPackage);

    // 作为 #gavin-lbar 的兄弟节点插入（不放进条内，避免 lbuttons 重建按钮条时被清掉）
    bar.insertAdjacentElement('afterend', btn);
    log('✅ 「买套餐」按钮已插入 L 按钮条后面');
  }

  log('v1.2 已加载，等待分页组件与 L 按钮条出现…');
})();
