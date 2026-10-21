// ==UserScript==
// @name         linsms 下拉框模糊搜索
// @namespace    https://github.com/815085226/Tampermonkey
// @version      0.4.0
// @description  adm.linsms.com 多页面筛选下拉框支持输入模糊搜索（channel-templates、channel-test、monitoring-reports、messages、submit-failures、send-progress、data-export、ban-terminations）：点击 企业/企业用户/用户/产品/通道 下拉框弹出可输入搜索的选项面板，选中后同步回原生 select 并触发 change（Vue 照常响应）。不覆盖、不隐藏原生控件，页面排版零改动
// @match        http://adm.linsms.com/*
// @match        https://adm.linsms.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const MARK = 'linsmsFuzzyEnhanced';
  const log = (...a) => console.log('%c[下拉搜索]', 'color:#e91e63;font-weight:bold', ...a);

  // 取 select 紧邻的筛选项 label 文本（沿祖先链向上找前面的兄弟，取短文本）
  function labelOf(sel) {
    let node = sel;
    for (let depth = 0; depth < 4 && node && node !== document.body; depth++) {
      let prev = node.previousElementSibling;
      for (let guard = 0; prev && guard < 3; guard++) {
        const t = (prev.textContent || '').trim();
        if (t && t.length <= 10) return t;
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }
    return '';
  }

  const isPlaceholderText = (t) => /^(全部|请选择|--|—)/.test(t || '');

  // 目标识别：
  // - channel-templates / channel-test：含「请选择通道」占位的 select
  // - 其余页面：占位文案为 全部XX/请选择XX，或紧邻 label 为 企业/企业用户/用户/产品/通道
  function isTargetSelect(sel) {
    const first = sel.options[0] ? (sel.options[0].textContent || '').trim() : '';
    if (/channel-templates|channel-test/i.test(location.pathname)) {
      return first.includes('请选择通道');
    }
    if (/monitoring-reports|\/messages|submit-failures|send-progress|data-export|ban-terminations/i.test(location.pathname)) {
      if (/^(全部用户|全部企业|全部产品|全部通道|请选择通道)/.test(first)) return true;
      return /^(企业用户|企业|用户|产品|通道)$/.test(labelOf(sel));
    }
    return false;
  }

  /* ---------------- 单例搜索面板 ---------------- */
  let panel = null;
  let inputEl = null;
  let listEl = null;
  let activeSel = null;
  let items = [];       // [{ opt, el }]
  let activeIdx = -1;

  function ensurePanel() {
    if (panel) return;

    panel = document.createElement('div');
    panel.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'z-index:2147483000', 'display:none',
      'background:#fff', 'border:1px solid #e4e7ed', 'border-radius:6px',
      'box-shadow:0 6px 18px rgba(0,0,0,.14)', 'box-sizing:border-box',
      'overflow:hidden', 'font-size:13px', 'color:#606266',
    ].join(';');

    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.autocomplete = 'off';
    inputEl.style.cssText = [
      'display:block', 'width:100%', 'height:32px', 'box-sizing:border-box',
      'border:none', 'border-bottom:1px solid #ebeef5', 'outline:none',
      'padding:0 10px', 'font-size:13px', 'color:#303133', 'background:#fff',
    ].join(';');

    listEl = document.createElement('div');
    listEl.style.cssText = 'max-height:260px;overflow-y:auto;';

    panel.appendChild(inputEl);
    panel.appendChild(listEl);
    document.body.appendChild(panel);

    inputEl.addEventListener('input', () => render(inputEl.value));
    inputEl.addEventListener('keydown', onKeyDown);
    // 面板内点击不触发关闭
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    document.addEventListener('mousedown', (e) => {
      if (activeSel && !panel.contains(e.target) && e.target !== activeSel) close();
    }, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', (e) => {
      if (panel && !panel.contains(e.target)) close();
    }, true);
  }

  function buildItems(query) {
    const q = (query || '').trim().toLowerCase();
    const out = [];
    for (const opt of activeSel.options) {
      const text = (opt.textContent || '').trim();
      if (q && !text.toLowerCase().includes(q)) continue;
      out.push({ opt, text });
    }
    return out;
  }

  function render(query) {
    if (!activeSel) return;
    const shown = buildItems(query);
    items = [];
    activeIdx = -1;
    listEl.innerHTML = '';

    if (!shown.length) {
      const empty = document.createElement('div');
      empty.textContent = '无匹配项';
      empty.style.cssText = 'padding:10px 12px;color:#909399;font-size:13px;';
      listEl.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    shown.forEach((it) => {
      const el = document.createElement('div');
      el.textContent = it.text;
      const selected = it.opt.value === activeSel.value;
      el.style.cssText = 'padding:7px 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;'
        + (selected ? 'background:#f5f7fa;color:#e6a23c;font-weight:600;' : '');
      el.addEventListener('mouseenter', () => { setActive(items.findIndex((x) => x.el === el)); });
      // mousedown 早于 blur，避免选择动作被失焦打断
      el.addEventListener('mousedown', (e) => { e.preventDefault(); choose(it.opt); });
      frag.appendChild(el);
      items.push({ opt: it.opt, el });
    });
    listEl.appendChild(frag);
  }

  function setActive(idx) {
    if (!items.length) return;
    if (activeIdx >= 0 && items[activeIdx]) items[activeIdx].el.style.background = '';
    activeIdx = Math.max(0, Math.min(idx, items.length - 1));
    const it = items[activeIdx];
    it.el.style.background = '#f5f7fa';
    const top = it.el.offsetTop - listEl.offsetTop;
    const bottom = top + it.el.offsetHeight;
    if (top < listEl.scrollTop) listEl.scrollTop = top;
    else if (bottom > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = bottom - listEl.clientHeight;
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIdx - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && items[activeIdx]) choose(items[activeIdx].opt);
      else if (items.length) choose(items[0].opt);
    } else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  function choose(opt) {
    if (!activeSel || !opt) return;
    const sel = activeSel;
    sel.value = opt.value;
    // change + input 双事件兜底，原生监听和 Vue v-model 都能收到
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    close();
  }

  function open(sel) {
    ensurePanel();
    activeSel = sel;

    const r = sel.getBoundingClientRect();
    const width = Math.max(r.width, 200);
    panel.style.width = `${width}px`;
    panel.style.display = 'block';

    const cur = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
    const curText = cur ? (cur.textContent || '').trim() : '';
    inputEl.placeholder = curText ? `搜索…（当前：${curText}）` : '输入关键字搜索…';
    inputEl.value = isPlaceholderText(curText) ? '' : curText;
    render(inputEl.value);

    // 弹在下方，空间不足则向上弹
    const panelH = panel.offsetHeight;
    const spaceBelow = window.innerHeight - r.bottom;
    let top = r.bottom + 4;
    if (spaceBelow < panelH + 12 && r.top > panelH + 12) top = r.top - 4 - panelH;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    panel.style.left = `${left}px`;
    panel.style.top = `${Math.max(8, top)}px`;

    inputEl.focus();
    inputEl.select();
  }

  function close() {
    if (!panel) return;
    panel.style.display = 'none';
    activeSel = null;
    items = [];
    activeIdx = -1;
  }

  /* ---------------- 绑定：点击原生下拉 → 弹出搜索面板 ---------------- */
  function enhance(sel) {
    sel.dataset[MARK] = '1';
    log('增强下拉框:', labelOf(sel) || (sel.options[0] ? sel.options[0].textContent.trim() : ''));

    const trigger = (e) => {
      // 阻止原生下拉弹出（以及页面自身的点击处理），改用可搜索面板
      e.preventDefault();
      e.stopPropagation();
      if (activeSel === sel && panel && panel.style.display === 'block') { close(); return; }
      open(sel);
    };

    sel.addEventListener('mousedown', trigger, true);
    sel.addEventListener('touchstart', (e) => { trigger(e); }, { capture: true, passive: false });

    // 部分页面的 select 被不透明容器包着，实际点到的是外层：一并拦截
    const box = sel.parentElement;
    if (box && box.querySelectorAll('input,select,textarea,button,a').length === 1) {
      box.style.cursor = 'pointer';
      box.addEventListener('mousedown', trigger, true);
      box.addEventListener('touchstart', (e) => { trigger(e); }, { capture: true, passive: false });
    }
  }

  function scan() {
    if (!/channel-templates|channel-test|monitoring-reports|\/messages|submit-failures|send-progress|data-export|ban-terminations/i.test(location.pathname)) return;
    for (const sel of document.querySelectorAll('select')) {
      if (!sel.dataset[MARK] && isTargetSelect(sel)) enhance(sel);
    }
  }

  // SPA 重渲染兜底：DOM 变化即扫描 + 定时扫描
  function boot() {
    scan();
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    setInterval(scan, 2000);
    log('v0.4.0 启动', location.href);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
