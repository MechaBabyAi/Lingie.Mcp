// 真实网关验证: 用灵姬签发的凭证调用只读工具 (list_models / spirit_balance)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn('node', [path.join(here, 'server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = ''; const pending = new Map(); let nextId = 1;
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
const request = (method, params, timeoutMs = 30000) => new Promise((res, rej) => {
  const id = nextId++;
  const t = setTimeout(() => rej(new Error(method + ' 超时')), timeoutMs);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

for (const name of ['lingie_list_models', 'lingie_spirit_balance']) {
  const r = await request('tools/call', { name, arguments: {} });
  console.log(`\n== ${name} ${r.result?.isError ? '(isError)' : '(ok)'}`);
  console.log((r.result?.content?.[0]?.text ?? '').split('\n').slice(0, 12).join('\n'));
}
child.kill();
