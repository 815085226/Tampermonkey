// ==UserScript==
// @name         sms62 端口页自动 200/page
// @namespace    gavin.sms62
// @version      1.4.0
// @description  自动将 http://web.sms62.com/mkt/port 列表分页大小切换为 200/page（中英文兼容、被重置后自动修回）；并在 L 按钮条后加「买套餐」按钮（重置条件→筛选状态=新插卡→全选→修改状态→选套餐用尽→等人工确认）
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
  const CHECK_INTERVAL = 2000;      // 定时巡检间隔：发现被重置就自动修回
  const MAX_BACKOFF = 8000;         // 连续失败时的最大退避（无限重试，不放弃）

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

  // ===== 每页条数：解析 / 切换 / 自愈 =====
  // v1.4 起兼容中英文 locale（"200/page" 与 "200条/页"），并去掉"终身只试 8 次"
  // 的限制：只要发现当前值不是 200 就再修一次（带退避，避免与页面自身重置打架）。

  function parseSizeText(txt) {
    if (txt == null) return null;
    const s = String(txt).trim();
    if (!s) return null;
    // 200/page、200条/页、200 / page、200条
    const m1 = s.match(/(\d+)\s*条?\s*\/\s*(?:page|页)/i);
    if (m1) return parseInt(m1[1], 10);
    const m2 = s.match(/^\s*(\d+)\s*条?\s*$/);
    if (m2) return parseInt(m2[1], 10);
    return null;
  }

  // 优先取可见的分页组件（页面可能存在隐藏副本）
  function visiblePager() {
    for (const p of document.querySelectorAll('.el-pagination')) {
      if (isVisible(p)) return p;
    }
    return document.querySelector('.el-pagination');
  }

  // 读取当前每页条数
  function currentSize() {
    const pager = visiblePager();
    if (!pager) return null;
    const scopes = [
      pager.querySelector('.el-pagination__sizes'),
      pager.querySelector('.el-select'),
      pager,
    ].filter(Boolean);
    for (const sc of scopes) {
      // 先读输入框/选中项，再退回整块文本
      for (const n of sc.querySelectorAll('.el-select__selected-item, .el-select__placeholder, input')) {
        const raw = n.value != null && n.value !== '' ? n.value : n.textContent;
        const v = parseSizeText(raw);
        if (v != null) return v;
      }
      const v2 = parseSizeText(sc.textContent);
      if (v2 != null) return v2;
    }
    return null;
  }

  // 打开分页栏里的「条数」下拉
  async function openSizeDropdown() {
    document.body.click(); // 先收起筛选区的其它浮层
    await sleep(200);
    const pager = visiblePager();
    if (!pager) return false;
    const target =
      pager.querySelector('.el-pagination__sizes .el-select__wrapper') ||
      pager.querySelector('.el-pagination__sizes .el-select') ||
      pager.querySelector('.el-select__wrapper') ||
      pager.querySelector('.el-select');
    if (!target) return false;
    fireClick(target);
    return true;
  }

  // 在可见浮层里找目标条数选项（不依赖具体类名与语言）
  function findSizeOption() {
    for (const dd of document.querySelectorAll('.el-select-dropdown, .el-popper')) {
      if (!isVisible(dd)) continue;
      for (const it of dd.querySelectorAll('.el-select-dropdown__item, li')) {
        if (!isVisible(it)) continue;
        const m = (it.textContent || '').match(/(\d+)/);
        if (m && parseInt(m[1], 10) === TARGET) return it;
      }
    }
    return null;
  }

  async function waitFor(fn, timeout, step) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const v = fn();
        if (v) return v;
      } catch (e) { /* ignore */ }
      await sleep(step || 150);
    }
    return null;
  }

  // 执行一次切换，返回 'ok' | 'no-selector' | 'no-option' | 'unconfirmed'
  async function switchToTarget() {
    if (!(await openSizeDropdown())) return 'no-selector';
    const opt = await waitFor(findSizeOption, 1800, 120); // 等浮层渲染完成
    if (!opt) {
      document.body.click(); // 收起下拉
      return 'no-option';
    }
    fireClick(opt);
    const ok = await waitFor(() => currentSize() === TARGET, 3000, 150); // 等列表重载完再确认
    return ok ? 'ok' : 'unconfirmed';
  }

  let busy = false;         // 正在切换
  let failStreak = 0;       // 连续失败次数（成功后清零）
  let nextAllowedAt = 0;    // 退避到期时间
  let disabled = false;     // 彻底停手（结构异常时防止无限弹下拉干扰操作）

  async function tryRun() {
    if (disabled || busy || !onTargetPage()) return;
    if (!document.querySelector('.el-pagination')) return; // 分页还没渲染

    const cur = currentSize();
    if (cur === TARGET) {
      if (failStreak !== 0) log('✅ 当前已是 ' + TARGET + '/page');
      failStreak = 0;
      nextAllowedAt = 0;
      return;
    }
    if (Date.now() < nextAllowedAt) return;

    busy = true;
    const r = await switchToTarget();
    busy = false;

    if (r === 'ok') {
      log('✅ 已切换为 ' + TARGET + '/page');
      failStreak = 0;
      nextAllowedAt = 0;
      return;
    }

    failStreak++;
    // 安全阀：读数始终解析不出来，或切换一直不生效，就停手并提示，不反复弹下拉
    if ((cur === null && failStreak >= 5) || failStreak >= 12) {
      disabled = true;
      log(
        '❌ 自动调整已停止（原因: ' + r + '，当前读到: ' +
        (cur === null ? '无法解析' : cur) + '）。页面结构可能改版，请反馈控制台日志'
      );
      return;
    }
    nextAllowedAt = Date.now() + Math.min(MAX_BACKOFF, 1500 * failStreak);
    log(
      '第 ' + failStreak + ' 次未成功（' + r + '，当前读到: ' +
      (cur === null ? '无法解析' : cur) + '），' +
      Math.round((nextAllowedAt - Date.now()) / 1000) + 's 后重试'
    );
  }

  // SPA 首次加载 / 登录后跳转 / 路由切换，统一用轮询兜底；
  // 不再"成功一次就永久停顿"——查询后分页常被页面重置回 20，这里会再修回来
  setInterval(tryRun, CHECK_INTERVAL);

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

  // 交互辅助（与 lbuttons 脚本同机制；fireClick / sleep 复用文件顶部定义）

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

  // 点击筛选栏「重置」按钮，清空所有历史查询条件（设备/状态/卡号/发送总数等）
  async function clickResetButton() {
    const lb = document.querySelector('span.query-label');
    const formScope = lb && (lb.closest('form') || lb.closest('.el-form'));
    const roots = formScope ? [formScope, document] : [document];
    for (const root of roots) {
      for (const b of root.querySelectorAll('button')) {
        if (!isVisible(b)) continue;
        if (b.closest('.el-dialog')) continue; // 跳过弹窗内的按钮
        const t = b.textContent.replace(/\s/g, '');
        if (t === '重置' || t === '重置条件' || t === '清空' || t.toLowerCase() === 'reset') {
          fireClick(b);
          log('已点击「' + b.textContent.trim() + '」清空查询条件');
          await sleep(700);
          return true;
        }
      }
    }
    log('未找到「重置」按钮，按当前条件继续');
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

      // 1) 先点「重置」清空历史查询条件（残留的设备/卡号/发送总数会污染结果）
      const resetOk = await clickResetButton();

      // 2) 清空设备筛选（重置已清空则跳过）
      if (!resetOk) {
        const cleared = await syncDropdown('设备', () => false, () => true);
        if (!cleared) log('⚠️ 设备筛选未能清空，继续执行（请自行确认设备栏为空）');
      }

      // 3) 状态筛选 = 新插卡
      const okStatus = await syncDropdown('状态', (t) => t === BUY_STATUS_FILTER);
      if (!okStatus) { log('❌ 状态筛选设置失败，流程终止'); return; }

      // 4) 查询
      clickSearchButton();
      await sleep(2500);

      // 5) 全选查询结果
      const okSel = await selectAllQueryRows();
      if (!okSel) { log('❌ 未能勾选任何数据（可能无' + BUY_STATUS_FILTER + '端口），流程终止'); return; }

      // 6) 点「修改状态」按钮
      let modifyBtn = null;
      for (const b of document.querySelectorAll('button')) {
        if (b.textContent.trim() === '修改状态' && isVisible(b) && !b.disabled) { modifyBtn = b; break; }
      }
      if (!modifyBtn) { log('❌ 未找到可用的「修改状态」按钮（按钮可能被禁用），流程终止'); return; }
      modifyBtn.click();

      // 7) 等弹窗出现并选择新状态
      const dlg = await waitForStatusDialog(8000);
      if (!dlg) { log('❌ 「修改状态」弹窗未出现，流程终止'); return; }
      const okSet = await setNewStatusInDialog(dlg, BUY_NEW_STATUS);
      if (!okSet) return;

      // 8) 等人工点「确定」或「取消」（弹窗消失即结束）
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

  log('v1.4.0 已加载：分页条数自动维持 200/page（被重置会自动修回），等待分页组件与 L 按钮条出现…');
})();
