// 线上只读验证（连 CDP 9333）：在真实端口页跑「设备=D11 + 状态=套餐用尽」查询，
// 然后分别用旧实现（缓存节点）和新实现（按索引重取）勾选，对比结果。
// 不会点「推送」，不产生任何写操作。
const fs = require('fs');
const path = require('path');
const { chromium } = require('/Users/gavin/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'sms62/sms62-port-lbuttons.user.js');
const OUT = path.join(__dirname, 'inspect-out');

function extractFn(src, sig) {
  const start = src.indexOf(sig);
  if (start < 0) throw new Error('未找到函数: ' + sig);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error('未闭合: ' + sig);
}

(async () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const fnTick = extractFn(src, 'async function tickRowsByIndex(targets)');
  const fnPkg = extractFn(src, 'async function selectRowsByPkg(limit, statusMust)');
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('/mkt/port')) || ctx.pages()[0];
  if (!page) throw new Error('没有端口页');
  console.log('[live] 页面:', page.url());

  const harness = `
    window.__G = (() => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const fireClick = (el) => {
        if (!el) return;
        const o = { bubbles: true, cancelable: true, view: window };
        el.dispatchEvent(new MouseEvent('mousedown', o));
        el.dispatchEvent(new MouseEvent('mouseup', o));
        el.dispatchEvent(new MouseEvent('click', o));
      };
      const logs = [];
      const log = (...a) => { const s = a.join(' '); logs.push(s); console.log('[script] ' + s); };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const currentQueryRows = () => [...document.querySelectorAll('.el-table__body-wrapper tbody tr.el-table__row')];
      const findColumnIndex = (names) => {
        const texts = [...document.querySelectorAll('.el-table__header-wrapper thead th')]
          .map((th) => (th.innerText || '').replace(/\\s+/g, ''));
        let i = texts.findIndex((t) => names.includes(t));
        if (i >= 0) return i;
        return texts.findIndex((t) => names.some((n) => t.includes(n)));
      };
      const findPkgColumnIndex = () => findColumnIndex(['套餐']);
      const selectAllQueryRows = async () => { throw new Error('不应走到全选兜底'); };
      const clearRowSelection = async () => {
        for (let i = 0; i < 6; i++) {
          const n = document.querySelectorAll('.el-table__body-wrapper .el-checkbox__input.is-checked').length;
          if (!n) return;
          const headerCb = document.querySelector('.el-table__header-wrapper .el-table__cell .el-checkbox');
          if (!headerCb) return;
          const input = headerCb.querySelector('input');
          const hc = headerCb.querySelector('.el-checkbox__input')?.classList.contains('is-checked');
          if (!hc) { fireClick(input || headerCb); await sleep(350); }
          fireClick(input || headerCb);
          await sleep(350);
        }
      };
      ${fnTick}
      ${fnPkg}

      // 旧实现（缓存节点）—— 复现线上漏勾
      async function selectRowsByPkgLegacy(limit, statusMust) {
        const rows = currentQueryRows();
        const idx = findPkgColumnIndex();
        const idxStatus = statusMust ? findColumnIndex(['状态']) : -1;
        await clearRowSelection();
        for (const tr of rows) {
          const cells = tr.querySelectorAll('td');
          if (statusMust && idxStatus >= 0) {
            const st = (cells[idxStatus] ? cells[idxStatus].innerText : '').trim();
            if (!st.includes(statusMust)) continue;
          }
          const txt = (cells[idx].innerText || '').replace(/[^\\d.\\-]/g, '');
          const v = txt === '' ? NaN : Number(txt);
          if (!Number.isFinite(v) || v >= limit) continue;
          const cbInput = tr.querySelector('.el-checkbox__input');
          if (!cbInput || cbInput.classList.contains('is-checked')) continue;
          const cb = tr.querySelector('.el-checkbox') || cbInput;
          fireClick(cb.querySelector('input') || cb);
          await sleep(90);
        }
        return document.querySelectorAll('.el-table__body-wrapper .el-checkbox__input.is-checked').length;
      }

      const findLabel = (t) => [...document.querySelectorAll('span.query-label')].find((e) => e.textContent.trim() === t);
      const selAfter = (t) => {
        const lb = findLabel(t);
        let s = lb && lb.nextElementSibling;
        for (let i = 0; i < 3 && s; i++) {
          if (s.classList.contains('el-select')) return s;
          s = s.nextElementSibling;
        }
        return null;
      };
      const visibleDd = () => {
        for (const d of document.querySelectorAll('.el-select-dropdown')) {
          if (d.offsetParent === null) continue;
          if (d.querySelector('.el-select-dropdown__item')) return d;
        }
        return null;
      };

      // 与脚本 syncSelectionBy 同思路：每点一次重新查节点
      async function selectOptions(labelText, wanted) {
        const sel = selAfter(labelText);
        if (!sel) return { ok: false, why: '无下拉' };
        const w = sel.querySelector('.el-select__wrapper') || sel;
        document.body.click(); await wait(250);
        fireClick(w); await wait(500);
        let dd = visibleDd();
        if (!dd) { document.body.click(); return { ok: false, why: '浮层未出现' }; }
        for (let guard = 0; guard < 200; guard++) {
          dd = dd.isConnected ? dd : visibleDd();
          if (!dd) return { ok: false, why: '下拉消失' };
          const items = [...dd.querySelectorAll('.el-select-dropdown__item')];
          const bad = items.find((it) => {
            const t = it.textContent.trim();
            const isSel = it.classList.contains('is-selected');
            return (wanted.includes(t) && !isSel) || (!wanted.includes(t) && isSel);
          });
          if (!bad) break;
          fireClick(bad);
          await wait(160);
        }
        document.body.click(); await wait(300);
        const txt = (w.innerText || '').replace(/\\s+/g, ' ').trim();
        return { ok: true, text: txt };
      }

      async function reset() {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.replace(/\\s/g, '') === '重置');
        if (b) { fireClick(b); await wait(900); }
        return !!b;
      }
      async function search() {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '查询');
        if (b) { fireClick(b); await wait(2600); }
        return !!b;
      }
      const checkedCount = () => document.querySelectorAll('.el-table__body-wrapper .el-checkbox__input.is-checked').length;

      return { wait, fireClick, logs, log, sleep, currentQueryRows, findColumnIndex,
        clearRowSelection, selectRowsByPkg, selectRowsByPkgLegacy, selectOptions, reset, search,
        checkedCount, selAfter, visibleDd };
    })();
  `;

  await page.addScriptTag({ content: harness });

  // 1) 设置筛选：设备=D11、状态=套餐用尽
  const setup = await page.evaluate(async () => {
    const G = window.__G;
    G.logs.length = 0;
    const out = {};
    out.reset = await G.reset();
    out.dev = await G.selectOptions('设备', ['D11']);
    out.status = await G.selectOptions('状态', ['套餐用尽']);
    out.search = await G.search();
    const rows = G.currentQueryRows();
    const iSt = G.findColumnIndex(['状态']);
    const iPkg = G.findColumnIndex(['套餐']);
    out.列 = { 状态: iSt, 套餐: iPkg };
    out.行数 = rows.length;
    out.总条数 = (document.querySelector('.el-pagination__total') || {}).innerText || '';
    const targets = [];
    const dist = {};
    rows.forEach((tr, i) => {
      const tds = tr.querySelectorAll('td');
      const st = (tds[iSt] ? tds[iSt].innerText : '').trim();
      dist[st] = (dist[st] || 0) + 1;
      const v = Number(String(tds[iPkg] ? tds[iPkg].innerText : '').replace(/[^\d.\-]/g, ''));
      if (st.includes('套餐用尽') && Number.isFinite(v) && v < 1000) targets.push(i);
    });
    out.状态分布 = dist;
    out.目标行数 = targets.length;
    return out;
  });
  console.log('[live] 筛选结果:', JSON.stringify(setup, null, 1));

  // 2) 旧实现对照
  const legacy = await page.evaluate(async () => {
    const G = window.__G;
    const n = await G.selectRowsByPkgLegacy(1000, '套餐用尽');
    const rows = G.currentQueryRows();
    const iSt = G.findColumnIndex(['状态']);
    const iPkg = G.findColumnIndex(['套餐']);
    const should = [];
    const got = [];
    rows.forEach((tr, i) => {
      const tds = tr.querySelectorAll('td');
      const st = (tds[iSt] ? tds[iSt].innerText : '').trim();
      const v = Number(String(tds[iPkg] ? tds[iPkg].innerText : '').replace(/[^\d.\-]/g, ''));
      const hit = st.includes('套餐用尽') && Number.isFinite(v) && v < 1000;
      if (hit) should.push(i + 1);
      if (hit && tr.querySelector('.el-checkbox__input').classList.contains('is-checked')) got.push(i + 1);
    });
    return { checked: n, should: should.length, got: got.length, 漏勾行: should.filter((x) => !got.includes(x)) };
  });
  console.log('[live] 旧实现（缓存节点）:', JSON.stringify(legacy));

  // 3) 新实现
  const fresh = await page.evaluate(async () => {
    const G = window.__G;
    await G.clearRowSelection();
    const n = await G.selectRowsByPkg(1000, '套餐用尽');
    const rows = G.currentQueryRows();
    const iSt = G.findColumnIndex(['状态']);
    const iPkg = G.findColumnIndex(['套餐']);
    const should = [];
    const got = [];
    rows.forEach((tr, i) => {
      const tds = tr.querySelectorAll('td');
      const st = (tds[iSt] ? tds[iSt].innerText : '').trim();
      const v = Number(String(tds[iPkg] ? tds[iPkg].innerText : '').replace(/[^\d.\-]/g, ''));
      const hit = st.includes('套餐用尽') && Number.isFinite(v) && v < 1000;
      if (hit) should.push(i + 1);
      if (hit && tr.querySelector('.el-checkbox__input').classList.contains('is-checked')) got.push(i + 1);
    });
    return { 返回: n, 应勾: should.length, 实勾: got.length,
      漏勾行: should.filter((x) => !got.includes(x)), 日志: G.logs.slice(-6) };
  });
  console.log('[live] 新实现（按索引重取）:', JSON.stringify(fresh, null, 1));

  await page.screenshot({ path: path.join(OUT, 'live-batch.png') });

  // 4) 复原：清空勾选 + 重置 + 查询
  const restore = await page.evaluate(async () => {
    const G = window.__G;
    await G.clearRowSelection();
    await G.reset();
    await G.search();
    return { checked: G.checkedCount(), 设备: (G.selAfter('设备') || {}).innerText };
  });
  console.log('[live] 复原:', JSON.stringify(restore));

  process.exit(0);
})().catch((e) => {
  console.error('[live] ERR', e && e.stack ? e.stack : e);
  process.exit(1);
});
