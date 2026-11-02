// 线上只读验证：expandPageSizeIfNeeded + 勾选，在真实端口页跑
// 场景：只按设备 D11 查询（64 条 > 50/页），确认自动把每页调到 200 并把符合条件的一次勾全
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
  const parts = [
    extractFn(src, 'function currentQueryRows()'),
    extractFn(src, 'function readPageTotal()'),
    extractFn(src, 'async function expandPageSizeIfNeeded()'),
    extractFn(src, 'async function tickRowsByIndex(targets)'),
    extractFn(src, 'async function selectRowsByPkg(limit, statusMust)'),
  ];

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('/mkt/port')) || ctx.pages()[0];
  console.log('[live] 页面:', page.url());

  const harness = `
    window.__H = (() => {
      const logs = [];
      const log = (...a) => { const s = a.join(' '); logs.push(s); console.log('[script] ' + s); };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const fireClick = (el) => {
        if (!el) return;
        const o = { bubbles: true, cancelable: true, view: window };
        el.dispatchEvent(new MouseEvent('mousedown', o));
        el.dispatchEvent(new MouseEvent('mouseup', o));
        el.dispatchEvent(new MouseEvent('click', o));
      };
      const findColumnIndex = (names) => {
        const texts = [...document.querySelectorAll('.el-table__header-wrapper thead th')]
          .map((th) => (th.innerText || '').replace(/\\s+/g, ''));
        let i = texts.findIndex((t) => names.includes(t));
        if (i >= 0) return i;
        return texts.findIndex((t) => names.some((n) => t.includes(n)));
      };
      const findPkgColumnIndex = () => findColumnIndex(['套餐']);
      const selectAllQueryRows = async () => true;
      const clearRowSelection = async () => {
        for (let i = 0; i < 6; i++) {
          const n = document.querySelectorAll('.el-table__body-wrapper .el-checkbox__input.is-checked').length;
          if (!n) return;
          const h = document.querySelector('.el-table__header-wrapper .el-table__cell .el-checkbox');
          if (!h) return;
          const inp = h.querySelector('input');
          const hc = h.querySelector('.el-checkbox__input')?.classList.contains('is-checked');
          if (!hc) { fireClick(inp || h); await sleep(350); }
          fireClick(inp || h);
          await sleep(350);
        }
      };
      ${parts.join('\n')}

      const findLabel = (t) => [...document.querySelectorAll('span.query-label')].find((e) => e.textContent.trim() === t);
      const selAfter = (t) => {
        const lb = findLabel(t);
        let s = lb && lb.nextElementSibling;
        for (let i = 0; i < 3 && s; i++) { if (s.classList.contains('el-select')) return s; s = s.nextElementSibling; }
        return null;
      };
      const visDd = () => {
        for (const d of document.querySelectorAll('.el-select-dropdown')) {
          if (d.offsetParent === null) continue;
          if (d.querySelector('.el-select-dropdown__item')) return d;
        }
        return null;
      };
      async function pick(label, wanted) {
        const sel = selAfter(label); if (!sel) return '无下拉';
        const w = sel.querySelector('.el-select__wrapper') || sel;
        document.body.click(); await sleep(220);
        fireClick(w); await sleep(450);
        let dd = visDd();
        if (!dd) { document.body.click(); return '浮层未出现'; }
        for (let g = 0; g < 200; g++) {
          dd = dd.isConnected ? dd : visDd();
          if (!dd) return '下拉消失';
          const bad = [...dd.querySelectorAll('.el-select-dropdown__item')].find((it) => {
            const t = it.textContent.trim(); const s = it.classList.contains('is-selected');
            return (wanted.includes(t) && !s) || (!wanted.includes(t) && s);
          });
          if (!bad) break;
          fireClick(bad); await sleep(150);
        }
        document.body.click(); await sleep(250);
        return (w.innerText || '').replace(/\\s+/g, ' ').trim();
      }
      const reset = async () => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.replace(/\\s/g, '') === '重置'); if (b) { fireClick(b); await sleep(900); } };
      const search = async () => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '查询'); if (b) { fireClick(b); await sleep(2600); } };

      return { logs, log, sleep, fireClick, clearRowSelection, reset, search, pick,
        currentQueryRows, readPageTotal, expandPageSizeIfNeeded, selectRowsByPkg, findColumnIndex };
    })();
  `;
  await page.addScriptTag({ content: harness });

  const res = await page.evaluate(async () => {
    const H = window.__H;
    H.logs.length = 0;
    await H.reset();
    const devText = await H.pick('设备', ['D11']);
    await H.search();

    const before = { total: H.readPageTotal(), rows: H.currentQueryRows().length };

    const exp = await H.expandPageSizeIfNeeded();
    const afterRows = H.currentQueryRows().length;

    // 勾选「套餐 < 1000」（不带状态条件，故意让结果超过一页）
    const n = await H.selectRowsByPkg(1000, '');
    const rows = H.currentQueryRows();
    const iPkg = H.findColumnIndex(['套餐']);
    const should = [];
    const got = [];
    rows.forEach((tr, i) => {
      const tds = tr.querySelectorAll('td');
      const v = Number(String(tds[iPkg] ? tds[iPkg].innerText : '').replace(/[^\d.\-]/g, ''));
      if (Number.isFinite(v) && v < 1000) should.push(i + 1);
      if (Number.isFinite(v) && v < 1000 && tr.querySelector('.el-checkbox__input').classList.contains('is-checked')) got.push(i + 1);
    });
    return {
      设备筛选: devText,
      调整前: before,
      调整结果: exp,
      调整后行数: afterRows,
      应勾: should.length,
      实勾: got.length,
      漏勾: should.filter((x) => !got.includes(x)),
      本次已选: n,
      日志: H.logs,
    };
  });
  console.log('[live]', JSON.stringify(res, null, 1));
  await page.screenshot({ path: path.join(OUT, 'live-expand.png') });

  // 复原
  const restore = await page.evaluate(async () => {
    const H = window.__H;
    await H.clearRowSelection();
    await H.reset();
    await H.search();
    return { 勾选: document.querySelectorAll('.el-table__body-wrapper .el-checkbox__input.is-checked').length,
      总条数: H.readPageTotal(), 行数: H.currentQueryRows().length };
  });
  console.log('[live] 复原:', JSON.stringify(restore));
  process.exit(0);
})().catch((e) => {
  console.error('[live] ERR', e && e.stack ? e.stack : e);
  process.exit(1);
});
