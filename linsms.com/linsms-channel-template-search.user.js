// ==UserScript==
// @name         linsms 通道模板-通道下拉模糊搜索
// @namespace    https://github.com/815085226/Tampermonkey
// @version      0.3.3
// @description  adm.linsms.com 多页面筛选下拉框支持输入模糊搜索（channel-templates、channel-test、monitoring-reports、messages、submit-failures、send-progress、data-export、ban-terminations）：企业/企业用户/用户/产品/通道 下拉框上叠加搜索输入框，输入即筛选，选中后同步回原生 select 并触发 change（Vue 照常响应）
// @match        http://adm.linsms.com/*
// @match        https://adm.linsms.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const MARK = 'linsmsFuzzyEnhanced';
  const log = (...a) => console.log('%c[通道搜索]', 'color:#e91e63;font-weight:bold', ...a);

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

  // 目标识别：
  // - channel-templates / channel-test：含「请选择通道」占位的 select
  // - monitoring-reports / messages：按占位文案或紧邻 label 识别（企业用户/企业/产品/通道）
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

  // 取元素实际不透明背景色（自身透明时沿祖先链向上找），避免底下原生控件透出造成重影
  function resolveBg(el) {
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(bg)) return bg;
      node = node.parentElement;
    }
    return '#ffffff';
  }

  function enhance(sel) {
    sel.dataset[MARK] = '1';
    log('增强通道下拉框');

    const cs = getComputedStyle(sel);

    // 包一层便于绝对定位（输入框覆盖 select、列表挂在下方）。
    // 关键：wrapper 必须完整继承 select 的布局角色（宽度/margin/flex 等），
    // 否则 select 脱离父级拉伸上下文会导致筛选栏排版变形
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;box-sizing:border-box;'
      + `display:${cs.display === 'inline' ? 'inline-block' : cs.display};`
      + `width:${cs.width};`
      + `height:${cs.height};`
      + `margin:${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft};`;
    if (cs.flexGrow && cs.flexGrow !== '0') {
      wrap.style.flex = `${cs.flexGrow} ${cs.flexShrink} ${cs.flexBasis}`;
    }
    if (cs.alignSelf && cs.alignSelf !== 'auto') wrap.style.alignSelf = cs.alignSelf;
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.style.width = '100%';
    // 原生控件不再渲染（保留占位尺寸），避免其文字与箭头从输入框底下透出
    sel.style.visibility = 'hidden';

    const firstText = sel.options[0] ? (sel.options[0].textContent || '').trim() : '';
    const isAllPlaceholder = /^(全部|请选择)/.test(firstText);

    // 覆盖在 select 上的搜索输入框：完整复制 select 计算样式（背景/边框/圆角/阴影/内边距/字体），
    // 视觉上与原生控件保持一致，另补一个同风格 ⇕ 箭头
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = firstText ? `${firstText}（可输入搜索）` : '可输入搜索';
    const padRight = Math.max(parseFloat(cs.paddingRight) || 0, 26);
    input.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%',
      'appearance:none', '-webkit-appearance:none',
      `background-color:${resolveBg(sel)}`,
      `border:${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
      `border-radius:${cs.borderTopLeftRadius}`,
      `box-shadow:${cs.boxShadow}`,
      `padding:${cs.paddingTop} ${padRight}px ${cs.paddingBottom} ${cs.paddingLeft}`,
      `font:${cs.font}`, `letter-spacing:${cs.letterSpacing}`, `color:${cs.color}`,
      'outline:none', 'box-sizing:border-box', 'cursor:text', 'text-align:left',
    ].join(';');
    // 模拟原生 select 的 ⇕ 箭头（灰色双箭头 SVG）
    input.style.backgroundImage = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='14' viewBox='0 0 10 14'%3E%3Cpath d='M1.5 4.5L5 1l3.5 3.5M1.5 9.5L5 13l3.5-3.5' fill='none' stroke='%23999' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";
    input.style.backgroundRepeat = 'no-repeat';
    input.style.backgroundPosition = `right ${Math.max(padRight - 20, 8)}px center`;
    const syncInput = () => {
      const ft = sel.options[0] ? (sel.options[0].textContent || '').trim() : '';
      const allPh = /^(全部|请选择)/.test(ft);
      const cur = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
      const curText = cur ? (cur.textContent || '').trim() : '';
      if (allPh && sel.selectedIndex <= 0) {
        // 未选中具体项：显示为灰色占位，不用手动删字
        input.value = '';
        input.placeholder = ft ? `${ft}（可输入搜索）` : '可输入搜索';
      } else {
        input.value = curText;
      }
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
      syncInput();
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
    if (!/channel-templates|channel-test|monitoring-reports|\/messages|submit-failures|send-progress|data-export|ban-terminations/i.test(location.pathname)) return;
    for (const sel of document.querySelectorAll('select')) {
      if (!sel.dataset[MARK] && isTargetSelect(sel)) enhance(sel);
    }
  }

  // SPA 重渲染兜底：DOM 变化即扫描 + 定时扫描（包装节点被框架重建时自动恢复增强）
  function boot() {
    scan();
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    setInterval(scan, 2000);
    log('v0.3.3 启动', location.href);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
