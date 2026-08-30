#!/usr/bin/env node
/**
 * Lingie MCP Server — 把灵姬客户端的本地生成能力以 MCP 工具暴露给 AI Agent。
 *
 * 零第三方依赖（Node.js >= 18），stdio 传输（换行分隔 JSON-RPC 2.0）。
 *
 * 后端一：workflow（默认，零改动可用）
 *   灵姬「外部工作流 API」 http://127.0.0.1:{port}（LocalApiService）
 *   端口 / Bearer Token 自动读取 %LOCALAPPDATA%\Lingie\settings.json
 *   需要在灵姬 设置 中开启「本地 API / 外部工作流 API」。
 *   仅使用本地 ComfyUI 引擎，图片/视频/音频输出会下载为本地文件路径返回。
 *
 * 后端二：gateway（可选，需 AppKey 通道后启用）
 *   灵姬「AI 应用通信网关」 http://127.0.0.1:{api_port}（LingieLocalApiServer）
 *   端口自动读取 %LOCALAPPDATA%\Lingie\api_server.json
 *   仅当同时设置 LINGIE_GATEWAY_APP_KEY 与 LINGIE_GATEWAY_USER_TOKEN 时暴露对应工具，
 *   覆盖全部三引擎（本地 / 云端 ComfyUI / 第三方模型 API）。
 *
 * 所有诊断日志输出到 stderr；stdout 仅用于 MCP 协议消息。
 */

import { createInterface } from 'node:readline';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SERVER_NAME = 'lingie-mcp';
const SERVER_VERSION = '0.1.0';
const KNOWN_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const LATEST_PROTOCOL_VERSION = '2025-06-18';

// ────────────────────────────── 配置 ──────────────────────────────

const ENV = (k, d = '') => (process.env[k] ?? d).trim();

const lingieDir = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Lingie',
);

let settingsCache = { at: 0, data: null };

async function loadLingieSettings() {
  const now = Date.now();
  if (now - settingsCache.at < 10_000) return settingsCache.data;
  let data = null;
  try {
    const raw = await fsp.readFile(path.join(lingieDir, 'settings.json'), 'utf8');
    data = JSON.parse(raw);
  } catch {
    data = null; // 灵姬未安装/未运行过 → 走默认值
  }
  settingsCache = { at: now, data };
  return data;
}

// 灵姬设置页「Agent (MCP) 网关接入」签发的凭证: { app_key, user_token, api_port, updated_at }
let credsCache = { at: 0, data: null };

async function loadMcpCredentials() {
  const now = Date.now();
  if (now - credsCache.at < 10_000) return credsCache.data;
  let data = null;
  try {
    const raw = await fsp.readFile(path.join(lingieDir, 'mcp-credentials.json'), 'utf8');
    data = JSON.parse(raw);
    if (!data?.app_key || !data?.user_token) data = null;
  } catch {
    data = null;
  }
  credsCache = { at: now, data };
  return data;
}

async function workflowConfig() {
  const s = (await loadLingieSettings()) || {};
  const port = Number(ENV('LINGIE_API_PORT', String(s.LocalApiPort || 17856)));
  const token = ENV('LINGIE_API_TOKEN', s.LocalApiBearerToken || '');
  const enabled = s.LocalApiEnabled !== undefined ? !!s.LocalApiEnabled : null;
  return { port, token, enabled, base: `http://127.0.0.1:${port}` };
}

async function gatewayConfig() {
  // 凭证优先级: 环境变量 > 灵姬签发的 mcp-credentials.json > 未启用
  const creds = await loadMcpCredentials();
  const appKey = ENV('LINGIE_GATEWAY_APP_KEY') || creds?.app_key || '';
  const userToken = ENV('LINGIE_GATEWAY_USER_TOKEN') || creds?.user_token || '';
  let port = Number(ENV('LINGIE_GATEWAY_PORT', '0')) || 0;
  if (!port) port = Number(creds?.api_port) || 0;
  if (!port) {
    try {
      const raw = await fsp.readFile(path.join(lingieDir, 'api_server.json'), 'utf8');
      port = Number(JSON.parse(raw).api_port) || 58100;
    } catch {
      port = 58100;
    }
  }
  return {
    enabled: !!(appKey && userToken),
    fromCredentialsFile: !ENV('LINGIE_GATEWAY_APP_KEY') && !!creds,
    appKey,
    userToken,
    port,
    base: ENV('LINGIE_GATEWAY_URL', `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
  };
}

const OUTPUT_DIR = ENV('LINGIE_MCP_OUTPUT_DIR', path.join(lingieDir, 'mcp-outputs'));

// ────────────────────────────── 文件日志 ──────────────────────────────
// 默认 %LOCALAPPDATA%\Lingie\mcp-server.log；LINGIE_MCP_LOG 指定其他路径，"off" 关闭。
// 记录每次工具调用的开始/完成/失败，供本机审计与排障（注意: 参数里可能包含提示词等本地内容）。

const LOG_FILE = ENV('LINGIE_MCP_LOG', path.join(lingieDir, 'mcp-server.log'));
const LOG_DISABLED = LOG_FILE === 'off' || LOG_FILE === '0';
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 超过后轮转为 .old

function truncForLog(s, n = 400) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + `…(共${s.length}字符)` : s;
}

function fileLog(line) {
  if (LOG_DISABLED) return;
  const text = `${new Date().toISOString()} [${process.pid}] ${line}\n`;
  (async () => {
    try {
      const st = await fsp.stat(LOG_FILE).catch(() => null);
      if (st && st.size > LOG_MAX_BYTES) {
        await fsp.rename(LOG_FILE, LOG_FILE + '.old').catch(() => {});
      }
      await fsp.mkdir(path.dirname(LOG_FILE), { recursive: true });
      await fsp.appendFile(LOG_FILE, text);
    } catch { /* 日志失败不影响服务 */ }
  })();
}

// ────────────────────────────── HTTP 基础 ──────────────────────────────

class LingieError extends Error {
  constructor(message, { hint = '', status = 0, payload = null } = {}) {
    super(message);
    this.hint = hint;
    this.status = status;
    this.payload = payload;
  }
}

function authHeaders(token) {
  const h = { Accept: 'application/json' };
  if (token) {
    h['Authorization'] = `Bearer ${token}`;
    h['X-API-Key'] = token; // 灵姬本地 API 两种头都认
  }
  return h;
}

async function apiRequest(base, urlPath, { method = 'GET', body = null, headers = {}, timeoutMs = 60_000, signal } = {}) {
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(base + urlPath, {
      method,
      headers: { ...headers, ...(body !== null ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== null ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, text };
  } catch (err) {
    if (signal?.aborted) throw err; // 调用方主动取消 → 原样抛出，由轮询逻辑处理
    if (err?.name === 'AbortError') {
      throw new LingieError(`请求灵姬超时（${timeoutMs}ms）: ${method} ${urlPath}`, {
        hint: '灵姬可能正忙，稍后重试，或加大超时参数。',
      });
    }
    throw new LingieError(`无法连接灵姬本地服务: ${method} ${base}${urlPath}`, {
      hint: '请确认灵姬客户端正在运行；工作流 API 还需在灵姬「设置」中开启本地 API（端口见 settings.json 的 LocalApiPort，默认 17856）。',
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

function assertApiOk(res, what) {
  if (res.ok && res.json && res.json.error) {
    throw new LingieError(`${what}失败: ${res.json.error}`, { status: res.status, payload: res.json });
  }
  if (res.status === 401) {
    throw new LingieError(`${what}失败: 认证被拒绝（401）`, {
      hint: '灵姬本地 API 已启用 Token 校验。请把 settings.json 中 LocalApiBearerToken 的值设为环境变量 LINGIE_API_TOKEN，或在灵姬设置中清空 Token。',
      status: 401,
    });
  }
  if (res.status === 503) {
    throw new LingieError(`${what}失败: 灵姬本地 API 未启用（503）`, {
      hint: '请打开灵姬客户端 → 设置 → 开启「本地 API / 外部工作流 API」。',
      status: 503,
    });
  }
  if (!res.ok || !res.json) {
    throw new LingieError(`${what}失败: HTTP ${res.status} ${res.text.slice(0, 200)}`, { status: res.status });
  }
  return res.json;
}

// ────────────────────────────── 输出下载 ──────────────────────────────

function safeName(s) {
  return String(s || 'file').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
}

/** 兼容取值：灵姬部分端点返回 PascalCase（默认序列化），部分返回 snake_case（显式命名） */
function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined) return v;
  }
  return undefined;
}

async function downloadOutput(base, headers, runId, out, destDir) {
  const url = base + out.download_url;
  const dest = path.join(destDir, `${out.index}_${safeName(out.filename)}`);
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) {
    throw new LingieError(`下载输出失败 (index=${out.index}): HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  return dest;
}

// ────────────────────────────── 轮询 ──────────────────────────────

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const POLL_INTERVAL_MS = 2_000;

async function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
  });
}

/**
 * 轮询直到任务进入终态或超时。前 10 秒容忍 "Run not found"（提交后短暂不可见）。
 */
async function pollUntilDone(fetchStatus, { timeoutS = 1200, progress, signal, notFoundGraceMs = 10_000 }) {
  const deadline = Date.now() + timeoutS * 1000;
  const started = Date.now();
  let last = null;
  for (;;) {
    if (signal?.aborted) throw new LingieError('任务查询已被调用方取消。');
    last = await fetchStatus();
    const notFound = last && last.error && !last.status;
    if (notFound && Date.now() - started < notFoundGraceMs) {
      // 提交后短暂不可见，继续等
    } else if (notFound) {
      throw new LingieError(`任务不存在: ${last.error}`, { hint: 'run_id 可能不正确，或灵姬已重启导致内存任务丢失。' });
    } else if (last && TERMINAL_STATUSES.has(last.status)) {
      return last;
    } else if (last?.status) {
      const pct = Math.max(0, Math.min(100, Math.round((Number(last.progress) || 0) * 100)));
      await progress?.(pct, 100, `生成中 ${pct}%（状态: ${last.status}）`);
    }
    if (Date.now() >= deadline) {
      throw new LingieError(`等待生成完成超时（${timeoutS}s）。`, {
        hint: last?.run_id || last?.task_id
          ? `任务仍在进行中，可用 lingie_run_status / lingie_task_status 查询 ${last.run_id || last.task_id}，或用 lingie_run_workflow(wait=false) 方式改用手动轮询。`
          : '任务可能仍在进行中，稍后用状态查询工具确认。',
      });
    }
    await sleep(POLL_INTERVAL_MS, signal);
  }
}

// ────────────────────────────── 工具定义 ──────────────────────────────

/** @returns {Array<{name:string, description:string, inputSchema:object, backend:string, handler:Function}>} */
async function buildTools() {
  const wf = await workflowConfig();
  const gw = await gatewayConfig();
  const wfHeaders = authHeaders(wf.token);
  const gwHeaders = gw.enabled
    ? { 'X-App-Key': gw.appKey, Authorization: `Bearer ${gw.userToken}`, Accept: 'application/json' }
    : null;

  const notEnabledHint = () =>
    new LingieError('灵姬本地 API 未开启或未配置。', {
      hint: '打开灵姬客户端 → 设置 → 开启「本地 API」。端口与 Token 见 %LOCALAPPDATA%\\Lingie\\settings.json（LocalApiPort / LocalApiBearerToken）。',
    });

  const tools = [];

  // ── 工作流后端（默认暴露） ──

  tools.push({
    name: 'lingie_health',
    backend: 'workflow',
    description:
      '检查灵姬客户端本地 API 的可用性：服务是否在线、本地 ComfyUI 引擎是否运行、是否需要认证。开始生成前建议先调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const cfg = await workflowConfig();
      const res = await apiRequest(cfg.base, '/health', { headers: wfHeaders, timeoutMs: 10_000 });
      const data = assertApiOk(res, '健康检查');
      return {
        text:
          `灵姬本地 API 在线（端口 ${cfg.port}）。\n` +
          `- 本地 ComfyUI 引擎: ${data.comfyui_running ? '运行中' : '未运行（生成时会自动启动，首次可能较慢）'}\n` +
          `- Token 认证: ${data.auth_required ? '已启用' : '未启用'}`,
        data,
      };
    },
  });

  tools.push({
    name: 'lingie_list_workflows',
    backend: 'workflow',
    description:
      '列出灵姬中可用的工作流（图片生成/视频生成/音频等）。返回 id、名称、类别、是否免费。生成分两步：先用 lingie_workflow_capabilities 查看参数，再用 lingie_run_workflow 提交。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const cfg = await workflowConfig();
      const res = await apiRequest(cfg.base, '/v1/workflows', { headers: wfHeaders });
      const list = assertApiOk(res, '获取工作流列表');
      const lines = (Array.isArray(list) ? list : []).map((w) => {
        const id = pick(w, 'Id', 'id');
        const name = pick(w, 'Name', 'name');
        const cat = pick(w, 'Category', 'category') ?? '?';
        const desc = pick(w, 'Description', 'description') ?? '';
        const free = pick(w, 'IsFree', 'isFree', 'is_free');
        return `- [${cat}] ${name}（id=${id}${free ? ', 免费' : ', 需授权'}）${desc ? ` — ${desc}` : ''}`;
      });
      return {
        text: lines.length ? `共 ${lines.length} 个工作流：\n${lines.join('\n')}` : '当前没有可用工作流。',
        data: list,
      };
    },
  });

  tools.push({
    name: 'lingie_workflow_capabilities',
    backend: 'workflow',
    description:
      '查看指定工作流的参数模式（每个参数的名称、类型、是否必填、默认值、可选值与提交方式）。提交 lingie_run_workflow 前务必先调用本工具了解如何填 params。',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: '工作流 id，来自 lingie_list_workflows' },
      },
      required: ['workflow_id'],
      additionalProperties: false,
    },
    async handler({ workflow_id }) {
      const cfg = await workflowConfig();
      const res = await apiRequest(cfg.base, `/v1/workflows/${encodeURIComponent(workflow_id)}/capabilities`, {
        headers: wfHeaders,
        timeoutMs: 120_000, // 可能触发工作流下载解密
      });
      const data = assertApiOk(res, '获取工作流参数');
      const params = pick(data, 'Parameters', 'parameters') ?? [];
      const wfName = pick(data, 'Name', 'name') ?? workflow_id;
      const lines = params.map((p) => {
        const req = p.required ? '必填' : '可选';
        const def = p.default !== undefined && p.default !== null && p.default !== '' ? `，默认 ${JSON.stringify(p.default)}` : '';
        const opts = Array.isArray(p.options) && p.options.length ? `，可选值: ${JSON.stringify(p.options)}` : '';
        return `- ${p.name}（${p.type}，${req}${def}${opts}）${p.label ? `【${p.label}】` : ''}${p.description ? ` ${p.description}` : ''}`;
      });
      return {
        text: `工作流「${wfName}」（${workflow_id}）参数：\n${lines.join('\n') || '（无参数）'}\n\n完整参数 schema（含特殊类型提交方式 submission_hint）见 JSON。`,
        data,
      };
    },
  });

  tools.push({
    name: 'lingie_run_workflow',
    backend: 'workflow',
    description:
      '在灵姬中执行一个工作流（本地 ComfyUI 引擎）并等待完成，返回输出文件（图片/视频/音频）的本地路径。默认阻塞等待最多 20 分钟；设 wait=false 可立即返回 run_id，之后用 lingie_run_status 查询。取消请用 lingie_cancel_run（注意：会中断本地引擎当前正在执行的任务）。',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: '工作流 id，来自 lingie_list_workflows' },
        params: {
          type: 'object',
          description:
            '工作流参数，键为 lingie_workflow_capabilities 返回的参数名（特殊类型按其 submission_hint 提交，如 "节点ID.字段" 形式）。',
          additionalProperties: true,
        },
        wait: { type: 'boolean', description: '是否阻塞等待完成，默认 true' },
        timeout_seconds: { type: 'integer', description: 'wait=true 时的最长等待秒数，默认 1200，最大 3600' },
      },
      required: ['workflow_id'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const cfg = await workflowConfig();
      const { workflow_id, params = {}, wait = true, timeout_seconds = 1200 } = args;
      const timeoutS = Math.max(10, Math.min(3600, Number(timeout_seconds) || 1200));

      const submitRes = await apiRequest(cfg.base, `/v1/workflows/${encodeURIComponent(workflow_id)}/runs`, {
        method: 'POST',
        headers: wfHeaders,
        // 本地 API 约定请求体为 { parameters: {...} }, 裸 params 会被判为"已收到: 无"
        body: { parameters: params },
        timeoutMs: 120_000,
      });
      const submitted = assertApiOk(submitRes, '提交生成任务');
      const runId = submitted.run_id;
      if (!runId) throw new LingieError('提交成功但未返回 run_id。', { payload: submitted });

      if (!wait) {
        return {
          text: `已提交灵姬生成任务：run_id=${runId}（状态 ${submitted.status}）。\n用 lingie_run_status(run_id="${runId}") 查询进度，lingie_cancel_run 取消。`,
          data: submitted,
        };
      }

      await ctx.progress?.(0, 100, '任务已提交，等待灵姬生成…');
      const final = await pollUntilDone(
        async () => {
          const r = await apiRequest(cfg.base, `/v1/runs/${encodeURIComponent(runId)}`, {
            headers: wfHeaders,
            timeoutMs: 30_000,
          });
          return r.json;
        },
        { timeoutS, progress: ctx.progress, signal: ctx.signal },
      );

      if (final.status !== 'completed') {
        throw new LingieError(`生成${final.status === 'failed' ? '失败' : '被取消'}: ${final.error || final.status}`, {
          payload: final,
        });
      }

      // 下载输出到本地
      const destDir = path.join(OUTPUT_DIR, safeName(runId));
      await fsp.mkdir(destDir, { recursive: true });
      const files = [];
      for (const out of final.outputs || []) {
        const p = await downloadOutput(cfg.base, wfHeaders, runId, out, destDir);
        files.push({ index: out.index, kind: out.kind, filename: out.filename, path: p });
      }
      await ctx.progress?.(100, 100, `完成，共 ${files.length} 个输出文件`);

      const lines = files.map((f) => `- [${f.kind}] ${f.filename} → ${f.path}`);
      return {
        text: `生成完成，输出已保存到 ${destDir}：\n${lines.join('\n') || '（工作流未返回输出文件）'}`,
        data: { run_id: runId, outputs_dir: destDir, files },
      };
    },
  });

  tools.push({
    name: 'lingie_run_status',
    backend: 'workflow',
    description: '查询灵姬生成任务（run_id）的当前状态、进度与输出清单（只查询，不下载输出文件）。',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: 'lingie_run_workflow 返回的 run_id' } },
      required: ['run_id'],
      additionalProperties: false,
    },
    async handler({ run_id }) {
      const cfg = await workflowConfig();
      const res = await apiRequest(cfg.base, `/v1/runs/${encodeURIComponent(run_id)}`, { headers: wfHeaders });
      const data = assertApiOk(res, '查询任务状态');
      const outs = (data.outputs || []).map((o) => `- [${o.kind}] ${o.filename}（${o.download_url}）`);
      return {
        text: `任务 ${run_id}：状态=${data.status}，进度=${Math.round((Number(data.progress) || 0) * 100)}%${data.error ? `，错误=${data.error}` : ''}${outs.length ? `\n输出：\n${outs.join('\n')}` : ''}`,
        data,
      };
    },
  });

  tools.push({
    name: 'lingie_cancel_run',
    backend: 'workflow',
    description:
      '取消一个灵姬生成任务。注意：本地 ComfyUI 引擎一次只执行一个任务，取消操作会中断当前正在执行的任务（不一定是该 run_id 对应的任务）。请确认后再调用。',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: '要取消的 run_id' } },
      required: ['run_id'],
      additionalProperties: false,
    },
    async handler({ run_id }) {
      const cfg = await workflowConfig();
      const res = await apiRequest(cfg.base, `/v1/runs/${encodeURIComponent(run_id)}/cancel`, {
        method: 'POST',
        headers: wfHeaders,
      });
      const data = assertApiOk(res, '取消任务');
      return { text: `已请求取消任务 ${run_id}（状态: ${data.status}）。`, data };
    },
  });

  tools.push({
    name: 'lingie_upload_file',
    backend: 'workflow',
    description:
      '把本地文件（图片/视频/音频）上传到灵姬的 ComfyUI 输入目录，供图生图、参考图、首帧等参数使用。返回的 filename 填入相应参数即可。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '要上传的本地文件绝对路径' },
        filename: { type: 'string', description: '可选：上传后使用的文件名（默认用原文件名）' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    async handler({ file_path, filename }) {
      const cfg = await workflowConfig();
      const buf = await fsp.readFile(file_path);
      const name = filename || path.basename(file_path);
      const res = await apiRequest(cfg.base, '/v1/upload', {
        method: 'POST',
        headers: wfHeaders,
        body: { filename: name, data: buf.toString('base64') },
        timeoutMs: 300_000,
      });
      const data = assertApiOk(res, '上传文件');
      return {
        text: `已上传 → ComfyUI 输入目录中的文件名: ${data.filename}（把该文件名填入工作流的图片/音频参数）`,
        data,
      };
    },
  });

  // ── 网关后端（配置了 AppKey 后暴露） ──

  if (gw.enabled) {
    tools.push(
      {
        name: 'lingie_list_models',
        backend: 'gateway',
        description: '列出灵姬网关可用的第三方模型（图片/视频等，含 DALL·E、Midjourney、Seedream、Kling、Vidu、Wan 等），返回 model_code 供 lingie_generate_image / lingie_generate_video 使用。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        async handler() {
          const res = await apiRequest(gw.base, '/api/v1/models', { headers: gwHeaders });
          const data = assertApiOk(res, '获取模型列表');
          const lines = (data.models || []).map((m) => `- [${m.type}] ${m.name}（model_code=${m.model_code}）`);
          return { text: lines.length ? `共 ${lines.length} 个模型：\n${lines.join('\n')}` : '暂无可用模型。', data };
        },
      },
      {
        name: 'lingie_generate_image',
        backend: 'gateway',
        description:
          '通过灵姬网关调用第三方图片模型生成图片（按灵力值计费）。先用 lingie_list_models 选择 model_code，用 lingie_estimate_cost 估价。默认阻塞等待完成并返回本地文件路径；wait=false 立即返回 task_id。',
        inputSchema: {
          type: 'object',
          properties: {
            model_code: { type: 'string', description: '模型代码，来自 lingie_list_models' },
            params: { type: 'object', description: '模型参数（如提示词 prompt、尺寸等），按模型能力填写', additionalProperties: true },
            wait: { type: 'boolean', description: '是否阻塞等待完成，默认 true' },
            timeout_seconds: { type: 'integer', description: '最长等待秒数，默认 1200，最大 3600' },
          },
          required: ['model_code'],
          additionalProperties: false,
        },
        async handler(args, ctx) {
          return runGatewayGenerate(gw, gwHeaders, 'third_party_api', args, ctx);
        },
      },
      {
        name: 'lingie_generate_video',
        backend: 'gateway',
        description:
          '通过灵姬网关调用第三方视频模型生成视频（按灵力值计费，耗时较长，建议 timeout_seconds ≥ 1800 不可超过 3600）。先用 lingie_list_models 选择 model_code。',
        inputSchema: {
          type: 'object',
          properties: {
            model_code: { type: 'string', description: '模型代码，来自 lingie_list_models' },
            params: { type: 'object', description: '模型参数（如提示词 prompt、时长、分辨率等）', additionalProperties: true },
            wait: { type: 'boolean', description: '是否阻塞等待完成，默认 true' },
            timeout_seconds: { type: 'integer', description: '最长等待秒数，默认 1800，最大 3600' },
          },
          required: ['model_code'],
          additionalProperties: false,
        },
        async handler(args, ctx) {
          const timeout = { default: 1800 };
          return runGatewayGenerate(gw, gwHeaders, 'third_party_api', args, ctx, timeout);
        },
      },
      {
        name: 'lingie_task_status',
        backend: 'gateway',
        description: '查询灵姬网关任务（task_id）的状态、进度与输出（输出为本地文件路径）。',
        inputSchema: {
          type: 'object',
          properties: { task_id: { type: 'string', description: 'lingie_generate_* 返回的 task_id' } },
          required: ['task_id'],
          additionalProperties: false,
        },
        async handler({ task_id }) {
          const res = await apiRequest(gw.base, `/api/v1/tasks/${encodeURIComponent(task_id)}`, { headers: gwHeaders });
          const data = assertApiOk(res, '查询网关任务');
          return { text: `任务 ${task_id}：状态=${data.status}，进度=${data.progress ?? '?'}%${(data.outputs || []).length ? `\n输出:\n${(data.outputs || []).map((p) => `- ${p}`).join('\n')}` : ''}`, data };
        },
      },
      {
        name: 'lingie_cancel_task',
        backend: 'gateway',
        description: '取消灵姬网关任务（task_id）。',
        inputSchema: {
          type: 'object',
          properties: { task_id: { type: 'string' } },
          required: ['task_id'],
          additionalProperties: false,
        },
        async handler({ task_id }) {
          const res = await apiRequest(gw.base, `/api/v1/tasks/${encodeURIComponent(task_id)}/cancel`, {
            method: 'POST',
            headers: gwHeaders,
          });
          const data = assertApiOk(res, '取消网关任务');
          return { text: `已取消任务 ${task_id}。`, data };
        },
      },
      {
        name: 'lingie_estimate_cost',
        backend: 'gateway',
        description: '预估通过灵姬网关调用某模型一次的灵力值消耗（不实际生成）。',
        inputSchema: {
          type: 'object',
          properties: {
            model_code: { type: 'string' },
            params: { type: 'object', additionalProperties: true },
          },
          required: ['model_code'],
          additionalProperties: false,
        },
        async handler({ model_code, params = {} }) {
          const res = await apiRequest(gw.base, '/api/v1/spirit-points/estimate', {
            method: 'POST',
            headers: gwHeaders,
            body: { model_code, params },
          });
          const data = assertApiOk(res, '灵力值估价');
          return { text: `模型 ${model_code} 预估消耗灵力值: ${JSON.stringify(data)}`, data };
        },
      },
      {
        name: 'lingie_spirit_balance',
        backend: 'gateway',
        description: '查询灵姬账户灵力值余额（可用 = 余额 − 冻结）。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        async handler() {
          const res = await apiRequest(gw.base, '/api/v1/spirit-points/balance', { headers: gwHeaders });
          const data = assertApiOk(res, '查询灵力值');
          return {
            text: `灵力值：余额 ${data.balance}，冻结 ${data.frozen}，可用 ${data.available}`,
            data,
          };
        },
      },
    );
  }

  if (!tools.some((t) => t.backend === 'workflow')) {
    throw notEnabledHint();
  }
  return tools;
}

async function runGatewayGenerate(gw, headers, engine, args, ctx, { default: defaultTimeout = 1200 } = {}) {
  const { model_code, params = {}, wait = true, timeout_seconds = defaultTimeout } = args;
  const timeoutS = Math.max(10, Math.min(3600, Number(timeout_seconds) || defaultTimeout));

  const submitRes = await apiRequest(gw.base, '/api/v1/generate', {
    method: 'POST',
    headers,
    body: { model_code, engine, params },
    timeoutMs: 120_000,
  });
  const submitted = assertApiOk(submitRes, '提交生成任务');
  const taskId = submitted.task_id;
  if (!taskId) throw new LingieError('提交成功但未返回 task_id。', { payload: submitted });

  if (!wait) {
    return {
      text: `已提交灵姬生成任务：task_id=${taskId}（预估消耗 ${submitted.estimated_cost ?? '?'} 灵力值）。\n用 lingie_task_status(task_id="${taskId}") 查询。`,
      data: submitted,
    };
  }

  await ctx.progress?.(0, 100, '任务已提交，等待灵姬生成…');
  const final = await pollUntilDone(
    async () => {
      const r = await apiRequest(gw.base, `/api/v1/tasks/${encodeURIComponent(taskId)}`, {
        headers,
        timeoutMs: 30_000,
      });
      const j = r.json;
      if (j && j.status) {
        // 网关返回 progress 为 0-100 整数，统一归一为 0-1
        j.progress = (Number(j.progress) || 0) / 100;
      }
      return j;
    },
    { timeoutS, progress: ctx.progress, signal: ctx.signal },
  );

  if (final.status !== 'completed') {
    throw new LingieError(`生成${final.status === 'failed' ? '失败' : '被取消'}: ${final.error || final.status}`, {
      payload: final,
    });
  }

  const outs = (final.outputs || []).map((p) => `- ${p}`);
  return {
    text: `生成完成（实际消耗 ${final.actual_cost ?? '?'} 灵力值）：\n${outs.join('\n') || '（无输出文件）'}`,
    data: final,
  };
}

// ────────────────────────────── MCP 协议层 ──────────────────────────────

let OUT_BUF = '';
function send(obj) {
  OUT_BUF += JSON.stringify(obj) + '\n';
  // 每次工具调用返回后才 flush 一次由调用方控制；此处直接写
  process.stdout.write(OUT_BUF, (err) => {
    if (err) process.exit(0); // EPIPE 等场景
  });
  OUT_BUF = '';
}

function rpcResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function rpcError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}
function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function toolResult(text, { isError = false, data } = {}) {
  const payload = data === undefined ? text : `${text}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  return { content: [{ type: 'text', text: payload }], ...(isError ? { isError: true } : {}) };
}

function toolErrorMessage(err) {
  const parts = [`错误: ${err?.message ?? String(err)}`];
  if (err?.hint) parts.push(`建议: ${err.hint}`);
  const payload = err?.payload ? `\n\n\`\`\`json\n${JSON.stringify(err.payload, null, 2)}\n\`\`\`` : '';
  return toolResult(parts.join('\n') + payload, { isError: true });
}

async function main() {
  const tools = await buildTools();
  const wfCfg = await workflowConfig();
  const gwCfg = await gatewayConfig();

  log(`Lingie MCP v${SERVER_VERSION} 启动: ${tools.length} 个工具`);
  log(`  工作流 API: ${wfCfg.base}（Token ${wfCfg.token ? '已配置' : '未配置'}，settings.LocalApiEnabled=${wfCfg.enabled}）`);
  log(`  网关 API:   ${gwCfg.base}（${gwCfg.enabled ? `已启用，凭证来源: ${gwCfg.fromCredentialsFile ? '灵姬签发的 mcp-credentials.json' : '环境变量'}` : '未启用 —— 在灵姬 设置 → 本地 API 打开「Agent (MCP) 网关接入」，或设置 LINGIE_GATEWAY_APP_KEY/LINGIE_GATEWAY_USER_TOKEN'}）`);
  log(`  输出目录:   ${OUTPUT_DIR}`);
  fileLog(`启动 v${SERVER_VERSION} pid=${process.pid} 工具=${tools.length} 工作流API=${wfCfg.base} 网关=${gwCfg.enabled ? '已启用' : '未启用'} 输出目录=${OUTPUT_DIR}${LOG_DISABLED ? ' 文件日志=已关闭' : ''}`);

  /** @type {Map<number, AbortController>} */
  const inflight = new Map();

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch {
      log(`忽略无法解析的输入行: ${s.slice(0, 120)}`);
      return;
    }
    handleMessage(msg).catch((e) => log(`处理消息异常: ${e?.stack || e}`));
  });
  rl.on('close', () => process.exit(0));
  process.stdout.on('error', () => process.exit(0)); // EPIPE

  async function handleMessage(msg) {
    const messages = Array.isArray(msg) ? msg : [msg];
    for (const m of messages) await dispatch(m);
  }

  async function dispatch(m) {
    if (!m || typeof m !== 'object') return;
    const { id, method, params } = m;
    const isNotification = id === undefined || id === null;

    try {
      if (method === 'initialize') {
        const requested = params?.protocolVersion;
        const version = KNOWN_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
        rpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;
      }
      if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
        if (method === 'notifications/cancelled' && params?.requestId && inflight.has(params.requestId)) {
          inflight.get(params.requestId).abort(new LingieError('调用方已取消该请求。'));
          inflight.delete(params.requestId);
        }
        return; // 通知不回包
      }
      if (method === 'ping') {
        rpcResult(id, {});
        return;
      }
      if (method === 'tools/list') {
        // 每次列表都重建工具集：灵姬里开启/关闭 MCP 网关接入后无需重启本服务器
        const current = await buildTools();
        rpcResult(id, {
          tools: current.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
        return;
      }
      if (method === 'tools/call') {
        if (isNotification) return;
        const name = params?.name;
        const args = params?.arguments ?? {};
        const tool = (await buildTools()).find((t) => t.name === name);
        if (!tool) {
          rpcError(id, -32602, `未知工具: ${name}。可用工具: ${(await buildTools()).map((t) => t.name).join(', ')}`);
          return;
        }
        const token = Symbol('ctx');
        const ctl = new AbortController();
        inflight.set(id, ctl);
        const progressToken = params?._meta?.progressToken;
        const ctx = {
          signal: ctl.signal,
          progress: progressToken
            ? (p, total, message) => {
                try {
                  notify('notifications/progress', { progressToken, progress: p, total, ...(message ? { message } : {}) });
                } catch {}
              }
            : null,
        };
        const callStart = Date.now();
        fileLog(`调用开始 tool=${name} 参数=${truncForLog(JSON.stringify(args))}`);
        try {
          const r = await tool.handler(args, ctx);
          fileLog(`调用完成 tool=${name} 耗时=${Date.now() - callStart}ms`);
          rpcResult(id, toolResult(r.text, { data: r.data }));
        } catch (err) {
          fileLog(`调用失败 tool=${name} 耗时=${Date.now() - callStart}ms 错误=${err?.message ?? err}`);
          log(`工具 ${name} 执行失败: ${err?.stack || err}`);
          rpcResult(id, toolErrorMessage(err));
        } finally {
          inflight.delete(id);
        }
        return;
      }
      if (method === 'resources/list') {
        rpcResult(id, { resources: [] });
        return;
      }
      if (method === 'prompts/list') {
        rpcResult(id, { prompts: [] });
        return;
      }
      if (!isNotification) {
        rpcError(id, -32601, `方法不存在: ${method}`);
      }
    } catch (err) {
      log(`dispatch 异常: ${err?.stack || err}`);
      if (!isNotification) rpcError(id, -32603, '内部错误', String(err?.message || err));
    }
  }
}

function log(...args) {
  process.stderr.write(`[lingie-mcp] ${args.join(' ')}\n`);
}

main().catch((e) => {
  log(`启动失败: ${e?.stack || e}`);
  if (e?.hint) log(`提示: ${e.hint}`);
  process.exit(1);
});
