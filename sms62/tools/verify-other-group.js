// 验证 buildStats 的「其他」归集：未分组的 E1 要单独成行，且各组 + 其他 = 全量
const fs = require('fs');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '../../sms62/sms62-port-lbuttons.user.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

function extractFn(sig) {
  const start = src.indexOf(sig);
  if (start < 0) throw new Error('未找到: ' + sig);
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

const pieces = [
  extractFn('function statOf'),
  extractFn('function buildStats'),
  extractFn('function matchDevice'),
  extractFn('function isCantSend'),
  extractFn('function cantSendHit'),
];

const code = `
  const SEND_TOTAL_THRESHOLD = 500;
  const CANT_SEND_MIN_TOPUP = 1;
  const PACKAGE_UNIT = 1500;
  const OTHER_GROUP_NAME = '其他';
  let pkgThreshold = 1000;
  const statusDict = { '1': '在线', '3': '套餐用尽', '5': '疑似封卡', '7': '新插卡' };
  const GROUPS_CURRENT = {
    L1: ['D1', 'D2'],
    L2: ['D11'],
    L5: ['D8'],
  };
  // 原脚本里的两个箭头函数（无花括号，单独抽容易取错，这里等价重写）
  const statusLabel = (v) => statusDict[String(v)] || String(v ?? '未知');
  const rowDeviceName = (r) => String(r.d ?? r.deviceName ?? '').trim();
  ${pieces.join('\n')}

  // 造数据：分组内 + 未分组的 E1 + 设备名为空的脏数据
  const rows = [
    { d: 'D1', t: 700, s: '1', p: 800, n: 0, f: 0 },
    { d: 'D2', t: 400, s: '3', p: 1500, n: 1, f: 0 },
    { d: 'D11', t: 900, s: '5', p: 300, n: 2, f: 2000 },
    { d: 'D11', t: 3200, s: '5', p: 300, n: 2, f: 1800 },
    { d: 'D8', t: 600, s: '1', p: 400, n: 0, f: 0 },
    { d: 'E1', t: 800, s: '3', p: 500, n: 1, f: 0 },
    { d: 'E1', t: 100, s: '1', p: 1200, n: 0, f: 0 },
    { d: 'E2', t: 200, s: '7', p: 900, n: 0, f: 0 },
    { d: '', t: 50, s: '1', p: 10, n: 0, f: 0 },
  ];
  return buildStats(rows);
`;

const stats = new Function(code)();

let ok = true;
const check = (cond, msg) => { console.log((cond ? '✅ ' : '❌ ') + msg); if (!cond) ok = false; };

console.log(JSON.stringify(stats.map((s) => ({
  name: s.name, devices: s.devices, total: s.total,
  overSend: s.overSend, lowPkg: s.lowPkg, cantSend: s.cantSend, pkgSum: s.pkgSum,
})), null, 1));

const other = stats.find((s) => s.name === '其他');
check(!!other, '存在「其他」行');
check(other && other.devices.join(',') === 'E1,E2', '「其他」包含 E1、E2（设备名为空的行不计入）');
check(other && other.total === 3, '「其他」端口总数 = 3（E1×2 + E2×1）');
check(stats.find((s) => s.name === 'L1').total === 2, 'L1 总数 = 2');
check(stats.find((s) => s.name === 'L2').total === 2, 'L2 总数 = 2');
check(stats.find((s) => s.name === 'L5').total === 1, 'L5 总数 = 1');
const sum = stats.reduce((a, s) => a + s.total, 0);
check(sum === 8, '各分组 + 其他 = 8（不含设备名未知的那条，原数据 9 条）');
check(other && other.lowPkg === 2, '「其他」套餐<1000 = 2（500、900）');
check(other && other.overSend === 1, '「其他」发送总数>500 = 1（800）');
check(stats.find((s) => s.name === 'L2').cantSend === 1, 'L2 发不出去 = 1（封卡+充值2次+失败2000≥有效数）');

console.log(ok ? 'ALL PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
