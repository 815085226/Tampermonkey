// 启动带 CDP(9333) 的调试 Chrome，常驻不退出；配合 pw-eval.js 做只读调试
// 用法：node launch-debug.js [url]
const path = require('path');
const fs = require('fs');
const { chromium } = require('/Users/gavin/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(__dirname, '../..');
const PROFILE = path.join(ROOT, '.pw-profile');
const OUT = path.join(__dirname, 'inspect-out');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'launch.log');
const say = (...a) => {
  const line = '[launch] ' + a.join(' ');
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
};

const URL = process.argv[2] || 'http://web.sms62.com/mkt/port';

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    executablePath: CHROME,
    viewport: { width: 1500, height: 950 },
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=9333',
    ],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const state = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    logged: !location.pathname.includes('/login'),
  }));
  say('状态', JSON.stringify(state));
  if (!state.logged) say('⚠️ 需要登录：请在这个 Chrome 窗口里登录，登录后我会继续');
  else say('已登录，可以继续调试');

  // 常驻，不关闭浏览器
  setInterval(() => {}, 60000);
})().catch((e) => {
  say('ERR', e && e.message);
  process.exit(1);
});
