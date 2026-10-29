// 只读调试：连接/启动 Chrome，抓取「批量创建失败补发任务」弹窗结构
// 用法：node inspect-dialog.js  （后台常驻，用户在该窗口登录并点开弹窗）
const fs = require('fs');
const path = require('path');
const PW = '/Users/gavin/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const { chromium } = require(PW);

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = '/Users/gavin/Gavin/Tampermonkey/.pw-profile';
const OUT = '/Users/gavin/Gavin/Tampermonkey/sms62/tools/inspect-out';
const LOG = path.join(OUT, 'inspect.log');
const CMD = '/tmp/pw-cmd.js';
const CMDOUT = '/tmp/pw-out.txt';
fs.mkdirSync(OUT, { recursive: true });

const ts = () => new Date().toTimeString().slice(0, 8);
function log(...a) {
  const line = '[' + ts() + '] ' + a.join(' ');
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    executablePath: CHROME,
    viewport: null,
    args: ['--no-first-run', '--no-default-browser-check', '--remote-debugging-port=9333'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  // 远程指令：写 /tmp/pw-cmd.js（页面上下文 JS 表达式），结果写 /tmp/pw-out.txt
  setInterval(async () => {
    if (!fs.existsSync(CMD)) return;
    const code = fs.readFileSync(CMD, 'utf8');
    try { fs.unlinkSync(CMD); } catch (e) { /* ignore */ }
    try {
      const r = await page.evaluate(code);
      fs.writeFileSync(CMDOUT, 'OK\n' + (typeof r === 'string' ? r : JSON.stringify(r, null, 2)));
    } catch (e) {
      fs.writeFileSync(CMDOUT, 'ERR\n' + e.message);
    }
  }, 700);

  // 记录接口响应（找补发弹窗数据来源与字段名）
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!/\/prod-api\//.test(url)) return;
      const ct = res.headers()['content-type'] || '';
      if (!/json/.test(ct)) return;
      const body = await res.text();
      if (body.length > 200000) return;
      fs.appendFileSync(
        path.join(OUT, 'api.log'),
        '[' + ts() + '] ' + res.status() + ' ' + url + '\n' + body.slice(0, 4000) + '\n\n'
      );
    } catch (e) { /* ignore */ }
  });

  await page.goto('http://web.sms62.com/mkt/send-task', { waitUntil: 'domcontentloaded' }).catch(() => {});
  log('已打开页面，等待登录 / 弹窗…');

  let lastSig = '';
  let lastUrl = '';

  const dump = async () => {
    const data = await page.evaluate(() => {
      const vis = (el) => !!(el && el.getBoundingClientRect().width > 0);
      const dlgs = [...document.querySelectorAll('.el-dialog')].filter(vis);
      const d = dlgs.find((x) =>
        ((x.querySelector('.el-dialog__title') || {}).textContent || '').includes('批量创建失败补发任务')
      );
      if (!d) return null;
      const table = d.querySelector('.el-table');
      const headers = table
        ? [...table.querySelectorAll('.el-table__header-wrapper th')].map((th) => th.innerText.trim())
        : [];
      const rows = table
        ? [...table.querySelectorAll('.el-table__body-wrapper tbody tr')].map((tr) =>
            [...tr.querySelectorAll('td')].map((td) => td.innerText.trim())
          )
        : [];
      const footers = table
        ? [...table.querySelectorAll('.el-table__footer-wrapper tbody tr')].map((tr) =>
            [...tr.querySelectorAll('td')].map((td) => td.innerText.trim())
          )
        : [];
      // 表格外层容器类名（判断是 el-table 还是原生 table）
      const tableTag = table ? table.tagName : (d.querySelector('table') || {}).tagName || null;
      const classes = table ? table.className : null;
      return {
        title: (d.querySelector('.el-dialog__title') || {}).textContent || '',
        dialogClass: d.className,
        width: d.style.width || '',
        tableTag,
        classes,
        headers,
        rowCount: rows.length,
        rowsFirst5: rows.slice(0, 5),
        footers,
        html: d.outerHTML,
      };
    });
    if (!data) return;
    const sig = data.rowCount + '|' + data.headers.join(',') + '|' + JSON.stringify(data.rowsFirst5);
    if (sig === lastSig) return;
    lastSig = sig;
    fs.writeFileSync(path.join(OUT, 'dialog.json'), JSON.stringify(data, null, 2));
    fs.writeFileSync(path.join(OUT, 'dialog.html'), data.html);
    log('弹窗已抓取：列=' + data.headers.join(' / ') + ' 行数=' + data.rowCount +
      ' tableTag=' + data.tableTag + ' classes=' + data.classes);
    log('首行数据：' + JSON.stringify(data.rowsFirst5[0] || null));
  };

  while (true) {
    try {
      const st = await page.evaluate(() => ({
        url: location.href,
        needLogin: /\/login|\/user\/login/i.test(location.href),
        bodyHead: document.body.innerText.slice(0, 40).replace(/\s+/g, ' '),
        hasDialog: [...document.querySelectorAll('.el-dialog')].some(
          (d) =>
            d.getBoundingClientRect().width > 0 &&
            ((d.querySelector('.el-dialog__title') || {}).textContent || '').includes('批量创建失败补发任务')
        ),
      }));
      if (st.url !== lastUrl) {
        lastUrl = st.url;
        log('当前页面：' + st.url);
      }
      if (st.hasDialog) await dump();
    } catch (e) {
      log('轮询出错：' + e.message);
    }
    await page.waitForTimeout(2000);
  }
})().catch((e) => {
  log('启动失败：' + e.message);
  process.exit(1);
});
