// 只读验证：把合并进 lbuttons 的「补发弹窗汇总」在真实页面跑一遍
// 用法：node sms62/tools/verify-merged.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('/Users/gavin/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(__dirname, '../..');
const PROFILE = path.join(ROOT, '.pw-profile');
const SCRIPT = path.join(ROOT, 'sms62/sms62-port-lbuttons.user.js');
const OUT = path.join(__dirname, 'inspect-out');
fs.mkdirSync(OUT, { recursive: true });

const say = (...a) => console.log('[verify]', ...a);

(async () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    executablePath: CHROME,
    viewport: { width: 1500, height: 950 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  // 收集 script 报错，确认合并没引入运行时错误
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));

  await page.goto('http://web.sms62.com/mkt/send-task', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  say('URL:', page.url());

  const logged = await page.evaluate(
    () => !location.pathname.includes('/login') && !!document.querySelector('.el-table')
  );
  say('已登录且有表格:', logged);
  if (!logged) {
    say('未登录，跳过弹窗验证（profile 登录态已失效）');
    await ctx.close();
    return;
  }

  // 注入合并后的脚本（等同油猴加载）
  await page.evaluate(src);
  await page.waitForTimeout(1200);
  const injectState = await page.evaluate(() => ({
    hasLbar: !!document.getElementById('gavin-lbar'),
    hasLreport: !!document.getElementById('gavin-lreport'),
    hasResendBar: !!document.getElementById('gavin-resend-summary'),
  }));
  say('注入后状态:', JSON.stringify(injectState));

  // 勾选前 3 行 → 打开「批量补发失败」弹窗
  const opened = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const th = document.querySelector('.el-table__header-wrapper .el-checkbox input');
    const cur = document.querySelectorAll('.el-table__body-wrapper .el-checkbox__input.is-checked').length;
    if (cur > 0 && th) { th.click(); await wait(600); }
    const trs = [...document.querySelectorAll('.el-table__body-wrapper tbody tr')].slice(0, 3);
    for (const tr of trs) {
      const inp = tr.querySelector('.el-checkbox input');
      if (inp) { inp.click(); await wait(260); }
    }
    await wait(400);
    const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '批量补发失败');
    if (!btn) return { ok: false, reason: '找不到「批量补发失败」按钮' };
    btn.click();
    await wait(2200);
    const dlg = [...document.querySelectorAll('.el-dialog')].find(
      (d) =>
        d.getBoundingClientRect().width > 0 &&
        ((d.querySelector('.el-dialog__title') || {}).textContent || '').includes('批量创建失败补发任务')
    );
    if (!dlg) return { ok: false, reason: '弹窗未出现' };
    const table = dlg.querySelector('.el-table');
    const heads = [...table.querySelectorAll('.el-table__header-wrapper thead th')].map((t) => t.innerText.trim());
    const iSend = heads.indexOf('发送失败');
    const iSub = heads.indexOf('提交失败');
    const num = (s) => { const v = Number(String(s || '').replace(/[^\d.\-]/g, '')); return Number.isFinite(v) ? v : 0; };
    let send = 0, sub = 0, rows = 0;
    for (const tr of table.querySelectorAll('.el-table__body-wrapper tbody tr')) {
      const tds = tr.querySelectorAll('td');
      if (!tds.length) continue;
      send += num(tds[iSend] && tds[iSend].innerText);
      sub += num(tds[iSub] && tds[iSub].innerText);
      rows++;
    }
    const bar = document.getElementById('gavin-resend-summary');
    return {
      ok: true,
      rows,
      send,
      sub,
      barText: bar ? bar.innerText.replace(/\n/g, ' ') : null,
      barVisible: bar ? bar.getBoundingClientRect().width > 0 : false,
      barBelowTable: bar ? bar.previousElementSibling === table : false,
    };
  });
  say('弹窗验证:', JSON.stringify(opened, null, 1));
  if (opened.ok) {
    const fmt = (n) => n.toLocaleString('en-US');
    const match = !!opened.barText && opened.barText.includes(fmt(opened.send)) && opened.barText.includes(fmt(opened.rows));
    say('汇总与表格数据一致:', match);
  }

  await page.screenshot({ path: path.join(OUT, 'merged-shot.png') });

  // 复原：关闭弹窗 + 取消勾选，不点「确认创建」
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const dlg = [...document.querySelectorAll('.el-dialog')].find(
      (d) =>
        d.getBoundingClientRect().width > 0 &&
        ((d.querySelector('.el-dialog__title') || {}).textContent || '').includes('批量创建失败补发任务')
    );
    if (dlg) {
      const b = [...dlg.querySelector('.el-dialog__footer').querySelectorAll('button')].find(
        (x) => x.innerText.trim() === '关闭'
      );
      if (b) b.click();
      await wait(900);
    }
    const th = document.querySelector('.el-table__header-wrapper .el-checkbox input');
    for (let i = 0; i < 3; i++) {
      const cur = document.querySelectorAll('.el-table__body-wrapper .el-checkbox__input.is-checked').length;
      if (cur === 0) break;
      if (th) th.click();
      await wait(700);
    }
    const bar = document.getElementById('gavin-resend-summary');
    if (bar) bar.remove();
  });

  say('页面脚本错误:', errors.length ? errors.slice(0, 5) : '无');
  await ctx.close();
  say('完成（已关闭浏览器，未点「确认创建」）');
})().catch((e) => {
  console.error('[verify] ERR', e && e.stack ? e.stack : e);
  process.exit(1);
});
