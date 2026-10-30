// 离线验证：直接抽取脚本里的 selectRowsByPkg 源码，在 mock 表格上跑，
// 确认「状态=套餐用尽 + 套餐<N」双条件勾选正确（不碰线上页面）
const fs = require('fs');
const path = require('path');
const { chromium } = require('/Users/gavin/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'sms62/sms62-port-lbuttons.user.js');

// 从源码中按大括号配对取出函数体
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
  { st: '套餐用尽', pkg: '500',  want: true,  why: '用尽 + 套餐<1000' },
  { st: '套餐用尽', pkg: '1500', want: false, why: '套餐超阈值' },
  { st: '新插卡',   pkg: '300',  want: false, why: '状态不符' },
  { st: '套餐用尽', pkg: '999',  want: true,  why: '用尽 + 套餐<1000' },
  { st: '疑似封卡', pkg: '800',  want: false, why: '状态不符' },
  { st: '套餐用尽', pkg: '0',    want: true,  why: '用尽 + 套餐=0' },
];

const makeRows = () =>
  ROWS.map(
    (r) =>
      `<tr class="el-table__row"><td><label class="el-checkbox"><span class="el-checkbox__input"><input type="checkbox"></span></label></td>` +
      `<td>D1</td><td>13800000000</td><td>${r.st}</td><td>${r.pkg}</td><td>x</td></tr>`
  ).join('');

const MOCK = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div class="el-table">
  <div class="el-table__header-wrapper"><table><thead><tr>
    <th class="el-table__cell"><label class="el-checkbox"><span class="el-checkbox__input"><input type="checkbox"></span></label></th>
    <th>设备</th><th>卡号</th><th>状态</th><th>套餐</th><th>备注</th>
  </tr></thead></table></div>
  <div class="el-table__body-wrapper"><table><tbody>${makeRows()}</tbody></table></div>
</div>
<div class="el-pagination__total">共 6 条</div>
</body></html>`;

(async () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const fnSrc = extractFn(src, 'async function selectRowsByPkg(limit, statusMust)');
  if (!fnSrc.includes('statusMust')) throw new Error('取到的函数里没有 statusMust 参数');

  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setContent(MOCK);

  // 在页面里重建运行环境（stub 出脚本里的依赖），再跑真实函数源码
  const harness = `
    const logs = [];
    const log = (...a) => logs.push(a.join(' '));
    const sleep = (ms) => Promise.resolve();
    const fireClick = (el) => {
      const inp = el && el.tagName === 'INPUT' ? el : (el && el.querySelector && el.querySelector('input'));
      if (!inp) return;
      // 模拟 el-checkbox 的切换：勾选状态记在 .el-checkbox__input 的 class 上
      const box = inp.closest('.el-checkbox__input');
      inp.checked = !inp.checked;
      if (box) box.classList.toggle('is-checked', inp.checked);
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
    let clearCalls = 0;
    const clearRowSelection = async () => {
      clearCalls++;
      document.querySelectorAll('.el-checkbox__input.is-checked')
        .forEach((b) => { b.classList.remove('is-checked'); const i = b.querySelector('input'); if (i) i.checked = false; });
    };
    const selectAllQueryRows = async () => { throw new Error('不应走到全选兜底'); };

    ${fnSrc}

    window.__run = async () => {
      const checked = await selectRowsByPkg(1000, '套餐用尽');
      const picked = [...document.querySelectorAll('.el-table__body-wrapper tbody tr')]
        .map((tr, i) => ({
          i: i + 1,
          状态: tr.children[3].innerText,
          套餐: tr.children[4].innerText,
          checked: tr.querySelector('.el-checkbox__input').classList.contains('is-checked'),
        })).filter((x) => x.checked).map((x) => x.i);
      return { checked, picked, logs, clearCalls };
    };
  `;
  await page.addScriptTag({ content: harness });
  const res = await page.evaluate(() => window.__run());

  const expectPicked = ROWS.map((r, i) => (r.want ? i + 1 : 0)).filter(Boolean);
  const ok =
    res.checked === expectPicked.length &&
    JSON.stringify(res.picked) === JSON.stringify(expectPicked) &&
    res.logs.some((l) => l.includes('状态不符已跳过'));

  console.log('勾选行号:', JSON.stringify(res.picked), '期望:', JSON.stringify(expectPicked));
  console.log('日志:', res.logs.join(' | '));
  console.log(ok ? 'ALL PASS' : 'FAIL');
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('ERR', e && e.stack ? e.stack : e);
  process.exit(1);
});
