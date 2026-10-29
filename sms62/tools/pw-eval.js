// 只读调试工具：通过 CDP 连接已启动的调试 Chrome，在页面里执行一段 JS，可选截图
// 用法：node pw-eval.js <code.js 路径> [shot]
const fs = require('fs');
const path = require('path');
const PW = '/Users/gavin/.workbuddy/binaries/node/workspace/node_modules/playwright-core';
const { chromium } = require(PW);

const OUT = path.join(__dirname, 'inspect-out');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const codeFile = process.argv[2];
  const mode = process.argv[3] || '';
  const wantShot = mode === 'shot' || mode === 'tag+shot';
  const asScript = mode.startsWith('tag');
  if (!codeFile) throw new Error('缺少参数：code.js 路径');
  const code = fs.readFileSync(codeFile, 'utf8');

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page = pages.find((p) => p.url().includes('/mkt/send-task')) || pages[0];
  if (!page) throw new Error('没有可用页面');

  if (asScript) {
    await page.addScriptTag({ content: code });
    console.log('SCRIPT_INJECTED');
  } else {
    const result = await page.evaluate(code);
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 1));
  }

  if (wantShot) {
    const file = path.join(OUT, 'shot.png');
    await page.screenshot({ path: file });
    console.log('SHOT: ' + file);
  }
  // 直接退出：避免 browser.close() 把调试用的浏览器也关掉
  process.exit(0);
})().catch((e) => {
  console.error('ERR: ' + e.message);
  process.exit(1);
});
