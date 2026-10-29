// 离线验证：用 mock 页面复现「批量创建失败补发任务」弹窗结构，
// 注入合并后的 lbuttons 脚本，确认汇总条自动出现且数字正确（不碰线上账号）
const fs = require('fs');
const path = require('path');
const { chromium } = require('/Users/gavin/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'sms62/sms62-port-lbuttons.user.js');

const MOCK = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>send-task mock</title>
<style>.el-dialog__body{padding:12px}.el-table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ddd;padding:6px 8px;font-size:13px}</style></head>
<body>
<div class="el-dialog" style="width:820px;display:block">
  <div class="el-dialog__title">批量创建失败补发任务</div>
  <div class="el-dialog__body">
    <div class="resend-panel">
      <div class="el-alert">提示：仅对勾选任务创建补发</div>
      <form class="dialog-form"><label>执行时间</label><input value="立即" /></form>
      <div class="tbl-wrap">
        <div class="el-table">
          <div class="el-table__header-wrapper"><table><thead><tr>
            <th>原任务编号</th><th>客户</th><th>提交失败</th><th>发送失败</th><th>补发编号</th>
          </tr></thead></table></div>
          <div class="el-table__body-wrapper"><table><tbody>
            <tr><td>T1</td><td>甲</td><td>0</td><td>8</td><td>-</td></tr>
            <tr><td>T2</td><td>乙</td><td>2</td><td>1,016</td><td>-</td></tr>
            <tr><td>T3</td><td>丙</td><td>0</td><td>16</td><td>-</td></tr>
          </tbody></table></div>
        </div>
      </div>
    </div>
  </div>
  <div class="el-dialog__footer"><button>关闭</button><button>确认创建</button></div>
</div>
</body></html>`;

(async () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));

  // 拦住页面请求，返回 mock（保持路径 /mkt/send-task，满足脚本的页面判断）
  await page.route('**/mkt/send-task*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: MOCK })
  );
  await page.route('**/prod-api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"code":200,"data":[]}' }));

  await page.goto('http://web.sms62.com/mkt/send-task', { waitUntil: 'domcontentloaded' });
  await page.evaluate(src);
  await page.waitForTimeout(1200); // 等 MutationObserver 注入

  const res = await page.evaluate(() => {
    const table = document.querySelector('.el-dialog .el-table');
    const bar = document.getElementById('gavin-resend-summary');
    return {
      barExists: !!bar,
      barVisible: bar ? bar.getBoundingClientRect().width > 0 : false,
      belowTable: bar ? bar.previousElementSibling === table : false,
      text: bar ? bar.innerText.replace(/\n/g, ' ') : null,
      hasLbar: !!document.getElementById('gavin-lbar'),   // port 页元素不应出现在这里
      hasLreport: !!document.getElementById('gavin-lreport'),
    };
  });

  const expect = '合计 3 个任务提交失败 2发送失败 1,040';
  const flat = (res.text || '').replace(/\s/g, '');
  const ok =
    res.barExists &&
    res.belowTable &&
    flat.includes('合计3个任务') &&
    flat.includes('提交失败2') &&
    flat.includes('发送失败1,040') &&
    !res.hasLbar &&
    !res.hasLreport;

  console.log(JSON.stringify(res, null, 1));
  console.log('期望:', expect);
  console.log('页面脚本错误:', errors.length ? errors.slice(0, 3) : '无');
  console.log(ok ? 'ALL PASS' : 'FAIL');

  await browser.close();
  process.exit(ok && !errors.length ? 0 : 1);
})().catch((e) => {
  console.error('ERR', e && e.stack ? e.stack : e);
  process.exit(1);
});
