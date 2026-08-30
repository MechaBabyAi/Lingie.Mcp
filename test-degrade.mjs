#!/usr/bin/env node
// Lingie.Mcp 降级行为实测：用极短的阻塞窗口跑一个真实工作流，验证
// 1) lingie_run_workflow 超窗后自动降级返回 run_id（而非挂到被宿主掐断）
// 2) lingie_run_result 轮询到完成后下载输出并返回本地路径
// 需要灵姬客户端在运行且已开启本地 API（会真实消耗一次本地生成）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn('node', [path.join(here, 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, LINGIE_MCP_MAX_BLOCK_MS: '3000', LINGIE_MCP_LOG: 'off' },
});

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
    } catch {
      console.error('!! 无法解析输出行:', line.slice(0, 200));
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
child.on('exit', (c) => console.log(`[server 退出, code=${c}]`));

function request(method, params, timeoutMs = 30_000) {
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

const textOf = (msg) => msg.result?.content?.[0]?.text ?? JSON.stringify(msg);
const dataOf = (msg) => {
  const m = textOf(msg).match(/```json\n([\s\S]*?)\n```/);
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
};

function assert(cond, label) {
  if (!cond) {
    console.error(`✗ ${label}`);
    child.kill();
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

// 1. 握手 + 工具清单应包含新增的 lingie_run_result
await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'degrade-test', version: '0.0.1' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const list = await request('tools/list');
const names = (list.result?.tools ?? []).map((t) => t.name);
assert(names.includes('lingie_run_workflow'), 'tools/list 包含 lingie_run_workflow');
assert(names.includes('lingie_run_result'), 'tools/list 包含新增的 lingie_run_result');

// 2. 提交一个真实免费工作流（ZiT 文生图低配版，速度较快），阻塞窗口仅 3s → 应降级
const t0 = Date.now();
const run = await request(
  'tools/call',
  {
    name: 'lingie_run_workflow',
    arguments: {
      workflow_id: 'WF-1007B7D3A7D0', // ZiT文生图
      params: { param_prompt: 'a cute orange cat sitting on a windowsill, sunny day' },
    },
  },
  60_000,
);
const elapsed = Date.now() - t0;
assert(!run.result?.isError, `lingie_run_workflow 未报错（耗时 ${elapsed}ms）`);
const runData = dataOf(run);
assert(runData?.run_id && runData?.degraded === true, `超窗降级返回 run_id=${runData?.run_id}（耗时 ${elapsed}ms < 被宿主掐断的 30s）`);
console.log('   返回文本:', textOf(run).split('\n')[0]);

// 3. 轮询 lingie_run_result 直到完成，应返回本地文件路径
let files = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const res = await request('tools/call', { name: 'lingie_run_result', arguments: { run_id: runData.run_id } }, 60_000);
  const d = dataOf(res);
  if (d?.files) {
    files = d.files;
    break;
  }
  console.log(`   轮询 #${i + 1}: ${d?.status ?? res.result?.content?.[0]?.text?.slice(0, 60)}`);
  if (res.result?.isError) {
    console.error('✗ lingie_run_result 返回错误:', textOf(res));
    child.kill();
    process.exit(1);
  }
}
assert(Array.isArray(files) && files.length > 0, 'lingie_run_result 轮询到完成并返回输出文件');
for (const f of files) {
  assert(fs.existsSync(f.path), `输出文件已下载到本地: ${f.path}`);
}

child.kill();
console.log(`\n全部通过 ✅（降级返回 ${elapsed}ms，整个流程未被 30s 宿主超时影响）`);
process.exit(0);
