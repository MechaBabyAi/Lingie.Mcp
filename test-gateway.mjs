// 网关模式测试: 凭证文件动态发现 → 网关工具出现 → 真实网关认证(预期 401)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn('node', [path.join(here, 'server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
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
const request = (method, params, timeoutMs = 20000) => new Promise((res, rej) => {
  const id = nextId++;
  const t = setTimeout(() => rej(new Error(method + ' 超时')), timeoutMs);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const list1 = await request('tools/list', {});
console.log('凭证文件存在时工具数:', list1.result.tools.length, '→', list1.result.tools.map(t => t.name).join(', '));

const call = await request('tools/call', { name: 'lingie_list_models', arguments: {} });
const text = call.result?.content?.[0]?.text ?? '';
console.log('\nlingie_list_models 结果 (预期认证被真实网关拒绝):');
console.log(text.slice(0, 300));
console.log('\nisError:', call.result?.isError);
child.kill();
