// ==UserScript==
// @name         linsms 通道模板-通道下拉模糊搜索
// @namespace    https://github.com/815085226/Tampermonkey
// @version      0.1.0
// @description  adm.linsms.com/channel-templates 页面「通道」筛选下拉框支持输入模糊搜索：下拉框上叠加搜索输入框，输入即筛选选项，选中后同步回原生 select 并触发 change（Vue 照常响应）
// @match        http://adm.linsms.com/*
// @match        https://adm.linsms.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const MARK = 'linsmsFuzzyEnhanced';
  const log = (...a) => console.log('%c[通道搜索]', 'color:#e91e63;font-weight:bold', ...a);

  // 目标：含「请选择通道」占位项的原生 select
  function isTargetSelect(sel) {
    if (sel.tagName !== 'SELECT') return false;
    for (const o of sel.options) {
      if ((o.textContent || '').includes('请选择通道')) return true;
    }
    return false;
  }

  function enhance(sel) {
    sel.dataset[MARK] = '1';
    log('增强通道下拉框');

    // 包一层便于绝对定位（输入框覆盖 select、列表挂在下方）
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;display:inline-block;';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    const cs = getComputedStyle(sel);

    // 覆盖在 select 上的搜索输入框（不透明背景盖住原生框）
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '请选择通道（可输入搜索）';
    input.style.cssText = [
      'position:absolute', 'left:0', 'top:0',
      `width:${sel.offsetWidth}px`, `height:${sel.offsetHeight}px`,
      `border:${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
      `border-radius:${cs.borderTopLeftRadius}`,
      `font:${cs.font}`,
      'padding:0 10px', 'background:#fff', 'outline:none',
      'box-sizing:border-box', 'color:#606266', 'cursor:text',
    ].join(';');
    const syncInput = () => {
      const cur = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
      input.value = cur ? (cur.textContent || '').trim() : '';
    };
    syncInput();

    // 自定义下拉列表
    const list = document.createElement('div');
    list.style.cssText = 'position:absolute;left:0;top:100%;margin-top:4px;min-width:100%;'
      + 'background:#fff;border:1px solid #e4e7ed;border-radius:6px;'
      + 'box-shadow:0 4px 12px rgba(0,0,0,.12);max-height:260px;overflow-y:auto;'
      + 'z-index:9999;display:none;box-sizing:border-box;';

    wrap.appendChild(input);
    wrap.appendChild(list);

    function select(opt) {
      sel.value = opt.value;
      // change + input 双事件兜底，原生监听和 Vue v-model 都能收到
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      input.value = (opt.textContent || '').trim();
      closeList();
    }

    function buildList(q) {
      const query = (q || '').trim().toLowerCase();
      list.innerHTML = '';
      let shown = 0;
      const frag = document.createDocumentFragment();
      for (const opt of sel.options) {
        const text = (opt.textContent || '').trim();
        const isPlaceholder = text.includes('请选择通道');
        // 模糊匹配：大小写不敏感的包含匹配（占位项始终保留）
        if (query && !isPlaceholder && !text.toLowerCase().includes(query)) continue;
        const item = document.createElement('div');
        item.textContent = text;
        item.dataset.value = opt.value;
        const selected = opt.value === sel.value;
        item.style.cssText = `padding:7px 12px;font-size:${cs.fontSize};white-space:nowrap;cursor:pointer;`
          + (selected ? 'background:#f5f7fa;color:#e6a23c;font-weight:600;' : 'color:#606266;');
        item.addEventListener('mouseenter', () => { item.style.background = '#f5f7fa'; });
        item.addEventListener('mouseleave', () => { if (!selected) item.style.background = ''; });
        // mousedown 在 blur 之前触发，保证选择不被输入框失焦打断
        item.addEventListener('mousedown', (e) => { e.preventDefault(); select(opt); });
        frag.appendChild(item);
        shown++;
      }
      if (!shown) {
        const empty = document.createElement('div');
        empty.textContent = '无匹配通道';
        empty.style.cssText = 'padding:10px 12px;color:#909399;font-size:13px;';
        list.appendChild(empty);
      }
      list.appendChild(frag);
      list.style.display = 'block';
    }

    function closeList() { list.style.display = 'none'; }

    input.addEventListener('focus', () => buildList(input.value));
    input.addEventListener('input', () => buildList(input.value));
    input.addEventListener('blur', () => setTimeout(closeList, 120));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { syncInput(); closeList(); }
      if (e.key === 'Enter') {
        const first = list.querySelector('[data-value]');
        if (first) {
          const opt = [...sel.options].find((o) => o.value === first.dataset.value);
          if (opt) select(opt);
        }
      }
    });

    // 选项异步加载/表单重置 → 同步输入框显示与列表
    new MutationObserver(() => {
      syncInput();
      if (list.style.display === 'block') buildList(input.value);
    }).observe(sel, { childList: true, attributes: true, subtree: true });
  }

  function scan() {
    if (!/channel-templates/i.test(location.pathname)) return;
    for (const sel of document.querySelectorAll('select')) {
      if (!sel.dataset[MARK] && isTargetSelect(sel)) enhance(sel);
    }
  }

  // SPA 重渲染兜底：DOM 变化即扫描 + 定时扫描（包装节点被框架重建时自动恢复增强）
  function boot() {
    scan();
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    setInterval(scan, 2000);
    log('v0.1.0 启动', location.href);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
