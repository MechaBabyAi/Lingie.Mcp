#!/usr/bin/env node
// Lingie.Mcp 冒烟测试：模拟 MCP 客户端做握手、tools/list，并对真实灵姬 API 调只读工具。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn('node', [path.join(here, 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch (e) {
      console.error('!! 无法解析输出行:', line.slice(0, 200));
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
child.on('exit', (c) => console.log(`[server 退出, code=${c}]`));

function request(method, params, timeoutMs = 20_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(t);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const summarize = (label, msg) => {
  if (msg.error) {
    console.log(`\n== ${label}: ERROR ${JSON.stringify(msg.error)}`);
    return null;
  }
  console.log(`\n== ${label}: OK`);
  return msg.result;
};

// 1. initialize
const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke-test', version: '0.0.1' },
});
console.log('== initialize:', JSON.stringify(init.result?.serverInfo), 'protocol=' + init.result?.protocolVersion);
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

// 2. tools/list
const list = summarize('tools/list', await request('tools/list'));
const tools = list?.tools?.map((t) => t.name) ?? [];
console.log('   工具:', tools.join(', '));

// 3. 真实只读调用: health + list_workflows
async function callTool(name, args) {
  const msg = await request('tools/call', { name, arguments: args }, 60_000);
  const r = msg.result;
  if (!r) return console.log(`\n== ${name}: 无 result`, JSON.stringify(msg).slice(0, 300));
  const text = r.content?.[0]?.text ?? '';
  console.log(`\n== ${name} ${r.isError ? '(isError)' : '(ok)'}\n${text.split('\n').slice(0, 14).join('\n')}`);
}

await callTool('lingie_health', {});
await callTool('lingie_list_workflows', {});
await callTool('lingie_workflow_capabilities', { workflow_id: 'WF-FCD7EEC53573' });

child.kill();
process.exit(0);
