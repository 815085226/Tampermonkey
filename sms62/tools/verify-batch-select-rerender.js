// 回归验证：模拟「每次点击后表格整表重渲染（节点全部失效）」，确认仍能把所有符合条件的行勾上
// 这是线上「只勾上前几行」的根因场景
const fs = require('fs');
const path = require('path');
const { chromium } = require('/Users/gavin/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'sms62/sms62-port-lbuttons.user.js');

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
  throw new Error('函数体未闭合: ' + sig);
}

const ROWS = [
  { st: '套餐用尽', pkg: '500' },
  { st: '套餐用尽', pkg: '1500' },
  { st: '新插卡', pkg: '300' },
  { st: '套餐用尽', pkg: '999' },
  { st: '疑似封卡', pkg: '800' },
  { st: '套餐用尽', pkg: '0' },
  { st: '套餐用尽', pkg: '120' },
  { st: '套餐用尽', pkg: '999.5' },
];

const MOCK = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div class="el-table">
  <div class="el-table__header-wrapper"><table><thead><tr>
    <th class="el-table__cell"><label class="el-checkbox"><span class="el-checkbox__input"><input type="checkbox"></span></label></th>
    <th>设备</th><th>卡号</th><th>状态</th><th>套餐</th>
  </tr></thead></table></div>
  <div class="el-table__body-wrapper"><table><tbody></tbody></table></div>
</div>
<div class="el-pagination__total">共 ${ROWS.length} 条</div>
</body></html>`;

(async () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const fnTick = extractFn(src, 'async function tickRowsByIndex(targets)');
  const fnPkg = extractFn(src, 'async function selectRowsByPkg(limit, statusMust)');

  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setContent(MOCK);

  const harness = `
    const ROWS = ${JSON.stringify(ROWS)};
    const model = ROWS.map((r) => ({ ...r, checked: false }));
    window.__staleClicks = 0;

    // 按模型整表重渲染 —— 每次点击后都调用，模拟 Vue 把 tbody 节点全部替换
    function render() {
      const tbody = document.querySelector('.el-table__body-wrapper tbody');
      tbody.innerHTML = model.map((r, i) =>
        '<tr class="el-table__row" data-idx="' + i + '">' +
          '<td><label class="el-checkbox"><span class="el-checkbox__input' + (r.checked ? ' is-checked' : '') + '">' +
            '<input type="checkbox" data-idx="' + i + '"' + (r.checked ? ' checked' : '') + '></span></label></td>' +
          '<td>D1</td><td>1380000000' + i + '</td><td>' + r.st + '</td><td>' + r.pkg + '</td>' +
        '</tr>'
      ).join('');
    }
    render();

    const logs = [];
    const log = (...a) => logs.push(a.join(' '));
    const sleep = () => Promise.resolve();

    // 真实行为：点在已脱离文档的节点上，事件不会冒泡到框架，等于没点
    const fireClick = (el) => {
      if (!el) return;
      const inp = el.tagName === 'INPUT' ? el : (el.querySelector && el.querySelector('input'));
      if (!inp || !inp.isConnected) { window.__staleClicks++; return; }
      const i = Number(inp.dataset.idx);
      if (!Number.isFinite(i)) return;
      model[i].checked = !model[i].checked;
      render(); // 点击 → 重渲染（正是线上漏勾的原因）
    };

    const currentQueryRows = () => [...document.querySelectorAll('.el-table__body-wrapper tbody tr.el-table__row')];
    const findColumnIndex = (names) => {
      const texts = [...document.querySelectorAll('.el-table__header-wrapper thead th')]
        .map((th) => (th.innerText || '').replace(/\\s+/g, ''));
      let i = texts.findIndex((t) => names.includes(t));
      if (i >= 0) return i;
      return texts.findIndex((t) => names.some((n) => t.includes(n)));
    };
    const findPkgColumnIndex = () => findColumnIndex(['套餐']);
    const clearRowSelection = async () => {
      model.forEach((r) => (r.checked = false));
      render();
    };
    const selectAllQueryRows = async () => { throw new Error('不应走到全选兜底'); };

    ${fnTick}
    ${fnPkg}

    // 旧实现（缓存 tr 节点）——用于对照，证明这个用例能复现线上漏勾
    async function selectRowsByPkgLegacy(limit, statusMust) {
      const rows = currentQueryRows();
      const idx = findPkgColumnIndex();
      const idxStatus = findColumnIndex(['状态']);
      await clearRowSelection();
      for (const tr of rows) {
        const cells = tr.querySelectorAll('td');
        const st = (cells[idxStatus] ? cells[idxStatus].innerText : '').trim();
        if (statusMust && !st.includes(statusMust)) continue;
        const txt = (cells[idx].innerText || '').replace(/[^\\d.\\-]/g, '');
        const v = txt === '' ? NaN : Number(txt);
        if (!(Number.isFinite(v) && v < limit)) continue;
        const cbInput = tr.querySelector('.el-checkbox__input');
        if (!cbInput || cbInput.classList.contains('is-checked')) continue;
        const cb = tr.querySelector('.el-checkbox') || cbInput;
        fireClick(cb.querySelector('input') || cb);
      }
      return model.map((r, i) => (r.checked ? i + 1 : 0)).filter(Boolean);
    }

    window.__runLegacy = async () => {
      window.__staleClicks = 0;
      const picked = await selectRowsByPkgLegacy(1000, '套餐用尽');
      return { picked, staleClicks: window.__staleClicks };
    };

    window.__reset = () => { model.forEach((r) => (r.checked = false)); render(); };

    window.__run = async () => {
      window.__reset();
      const n = await selectRowsByPkg(1000, '套餐用尽');
      return {
        returned: n,
        checkedIdx: model.map((r, i) => (r.checked ? i + 1 : 0)).filter(Boolean),
        staleClicks: window.__staleClicks,
        logs,
      };
    };
  `;
  await page.addScriptTag({ content: harness });
  const legacy = await page.evaluate(() => window.__runLegacy());
  const res = await page.evaluate(() => window.__run());

  const expect = ROWS.map((r, i) => (r.st === '套餐用尽' && Number(r.pkg) < 1000 ? i + 1 : 0)).filter(Boolean);
  const ok =
    JSON.stringify(res.checkedIdx) === JSON.stringify(expect) &&
    res.returned === expect.length;

  console.log('期望勾选:', JSON.stringify(expect));
  console.log('旧实现（缓存节点）:', JSON.stringify(legacy.picked), '← 漏勾 ' +
    (expect.length - legacy.picked.length) + ' 行，点在游离节点 ' + legacy.staleClicks + ' 次（复现线上问题）');
  console.log('新实现（按索引重取）:', JSON.stringify(res.checkedIdx), '返回', res.returned);
  console.log('日志:', res.logs.join(' | '));
  console.log(ok ? 'ALL PASS（重渲染下仍全勾）' : 'FAIL');
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('ERR', e && e.stack ? e.stack : e);
  process.exit(1);
});
