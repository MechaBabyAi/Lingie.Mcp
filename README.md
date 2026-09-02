---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'e3479609-3a7f-4da5-910c-3d6772bafbbb'
  PropagateID: 'e3479609-3a7f-4da5-910c-3d6772bafbbb'
  ReservedCode1: 'd5b9ea48-a52b-478e-a3ea-b3564fe91671'
  ReservedCode2: 'd5b9ea48-a52b-478e-a3ea-b3564fe91671'
---

# Lingie.Mcp — 灵姬 MCP 服务器

把灵姬客户端（`Lingie.BlazorHybrid`）的生成能力封装成 [MCP](https://modelcontextprotocol.io)（Model Context Protocol）工具，让任何支持 MCP 的 AI Agent（ZCode、Claude Desktop、Cursor 等）可以直接调用灵姬**生成图片、视频、音频**。

- **零第三方依赖**：纯 Node.js（≥ 18）单文件实现，无需 `npm install`
- **stdio 传输**：换行分隔 JSON-RPC 2.0，符合 MCP 标准规范
- **零改动接入**：直接复用灵姬内置的本地 HTTP API，不需要修改灵姬代码

```
AI Agent ──(MCP stdio)──> Lingie.Mcp/server.mjs ──(HTTP 127.0.0.1)──> 灵姬客户端
                                                │                       │
                                                │            ┌──────────┴──────────┐
                                                │   外部工作流 API :17856      AI应用网关 :58100
                                                │   （本地 ComfyUI 引擎）      （本地/云端/三方模型）
                                                └── 输出文件下载到本地，绝对路径返回给 Agent
```

## 前置条件

1. 灵姬客户端正在运行。
2. 在灵姬 **设置 → 本地 API** 中开启「外部工作流 API」（对应 `%LOCALAPPDATA%\Lingie\settings.json` 的 `LocalApiEnabled`，端口 `LocalApiPort` 默认 `17856`）。
3. 若设置了 `LocalApiBearerToken`，MCP 服务器会自动读取；也可用环境变量 `LINGIE_API_TOKEN` 显式覆盖。
4. **无需手动启动 ComfyUI 引擎**：提交工作流时若引擎未运行，灵姬会自动拉起（首次约 30-120 秒）。

## 接入 AI Agent

把本仓库克隆到任意目录（下例假设克隆到 `C:\MCP\Lingie.Mcp`，请替换为你的实际路径）：

```bash
git clone https://github.com/MechaBabyAi/Lingie.Mcp.git C:\MCP\Lingie.Mcp
```

### ZCode / Claude Desktop / Cursor（通用 mcpServers 格式）

```json
{
  "mcpServers": {
    "lingie": {
      "command": "node",
      "args": ["C:\\MCP\\Lingie.Mcp\\server.mjs"]
    }
  }
}
```

> 环境变量需要时放进同一个节点，例如：
> ```json
> "env": { "LINGIE_API_PORT": "17856", "LINGIE_API_TOKEN": "..." }
> ```

### 手动冒烟测试

```bash
node Lingie.Mcp/server.mjs
# 再输入一行 MCP 初始化消息（或直接在 Agent 中配置后查看工具列表）
```

启动日志输出在 stderr：会打印工作流 API 地址、Token 状态、网关状态与输出目录。

## 工具清单

默认暴露「工作流 API」工具（本地 ComfyUI 引擎，免费）：

| 工具 | 说明 |
|---|---|
| `lingie_health` | 检查灵姬本地 API 与本地 ComfyUI 引擎是否在线（未运行时提交会自动拉起） |
| `lingie_list_workflows` | 列出可用工作流（图片/视频/音频生成等） |
| `lingie_workflow_capabilities` | 查看某工作流的参数模式（类型/必填/默认值/可选值/提交方式） |
| `lingie_run_workflow` | 执行工作流：引擎未运行时自动拉起（首次约 30-120 秒）；约 20 秒内完成则直接返回输出文件**本地绝对路径**，否则自动降级返回 `run_id`（任务后台继续）；`wait=false` 可立即异步提交 |
| `lingie_run_result` | 轮询 `run_id` 并取回结果：完成时下载输出并以本地路径返回（配合降级流程使用） |
| `lingie_run_status` | 查询任务状态与进度（不下载输出） |
| `lingie_cancel_run` | 取消任务（注意：会中断本地引擎当前正在执行的任务） |
| `lingie_upload_file` | 上传本地文件到 ComfyUI 输入目录（供图生图/参考图/首帧等参数使用） |

当网关凭证可用时（二选一），额外暴露「AI 应用网关」（`:58100`）工具，覆盖本地/云端 ComfyUI 与第三方模型（DALL·E、Midjourney、Seedream、Kling、Vidu、Wan 等，按灵力值计费）：

1. **灵姬内开启（推荐）**：灵姬 设置 → 本地 API → 打开「Agent (MCP) 网关接入」，灵姬会自动把凭证写入 `%LOCALAPPDATA%\Lingie\mcp-credentials.json`，本服务器自动发现（约 10 秒内生效，无需重启）；
2. **环境变量**：设置 `LINGIE_GATEWAY_APP_KEY` + `LINGIE_GATEWAY_USER_TOKEN`。

| 工具 | 说明 |
|---|---|
| `lingie_list_models` | 列出网关可用模型（model_code） |
| `lingie_generate_image` / `lingie_generate_video` | 一键调用模型生成图片/视频（约 20 秒未完成自动降级返回 `task_id`，用 `lingie_task_status` 轮询） |
| `lingie_task_status` / `lingie_cancel_task` | 网关任务状态/取消 |
| `lingie_estimate_cost` / `lingie_spirit_balance` | 灵力值估价/余额 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LINGIE_API_PORT` | settings.json 的 `LocalApiPort`（默认 17856） | 工作流 API 端口 |
| `LINGIE_API_TOKEN` | settings.json 的 `LocalApiBearerToken` | 工作流 API Bearer Token |
| `LINGIE_MCP_OUTPUT_DIR` | `%LOCALAPPDATA%\Lingie\mcp-outputs` | 输出文件下载目录 |
| `LINGIE_MCP_MAX_BLOCK_MS` | `20000` | 阻塞等待的安全窗口（毫秒）：超过仍未完成就提前降级返回 `run_id`/`task_id`，避免被宿主约 30 秒的单次调用超时掐断丢结果；设 `0` 关闭限制 |
| `LINGIE_MCP_LOG` | `%LOCALAPPDATA%\Lingie\mcp-server.log` | 本地文件日志路径，设为 `off` 关闭；超 5MB 自动轮转为 `.old` |
| `LINGIE_GATEWAY_APP_KEY` | 灵姬签发的 `mcp-credentials.json` | 网关 AppKey（与 `LINGIE_GATEWAY_USER_TOKEN` 一起设置后启用网关工具） |
| `LINGIE_GATEWAY_USER_TOKEN` | 无 | 网关 Bearer 用户令牌 |
| `LINGIE_GATEWAY_PORT` / `LINGIE_GATEWAY_URL` | `%LOCALAPPDATA%\Lingie\api_server.json` 的 `api_port`（默认 58100） | 网关地址 |

## Agent 典型调用流程

```
1. lingie_health                          → 确认灵姬在线（引擎未运行也可提交，会自拉起）
2. lingie_list_workflows                  → 找到想用的工作流（如"文生图"）
3. lingie_workflow_capabilities           → 了解参数怎么填
4. （可选）lingie_upload_file              → 图生图先上传参考图
5. lingie_run_workflow { params }         → 提交生成：
   ├─ 约 20 秒内完成 → 直接拿到输出文件本地路径，结束
   └─ 超过约 20 秒   → 拿到 run_id（降级返回，任务后台继续）
      5a. 循环 lingie_run_result { run_id }  → 进行中则稍后再查；
          完成时返回输出文件本地路径
6. Agent 直接 Read / 处理该路径下的图片或视频
```

> 为什么会"降级"？多数 MCP 宿主（ZCode、Claude Desktop 等）对单次工具调用有 ~30 秒超时，
> 超时后客户端会掐断调用并丢弃返回值，但任务在灵姬后台仍在继续。与其被掐断，
> 不如主动提前返回任务 id 让 Agent 轮询。视频生成等长任务几乎总会走降级路径，属正常现象。

## 已知限制

- **工作流 API 只走本地 ComfyUI 引擎**：云端 ComfyUI / 第三方模型（Kling 等计费模型）需走网关工具。网关凭证在灵姬 设置 → 本地 API → 「Agent (MCP) 网关接入」一键签发（写入 `mcp-credentials.json`），或由管理员通过环境变量提供。
- **引擎自动拉起**：通过 MCP 提交工作流时，若本地 ComfyUI 引擎未运行，灵姬会自动拉起（`ComfyUIService.EnsureRunningAsync`）。首次启动约 30-120 秒（加载 custom nodes），后续提交无需等待。如果文件指纹校验失败（`FingerprintBlocked`），自拉起会中止并返回错误，需在灵姬 UI 中修复 ComfyUI 路径配置。
- **启动参数与脱敏补丁不可通过外部修改**：ComfyUI 进程的启动参数（`--port`、`--disable-metadata`、`--preview-method none` 等）由灵姬 C# 端 `BuildComfyUIArguments` 硬编码构建，外部 API 调用者只能提交工作流节点参数（提示词、图片、尺寸等），不接触进程启动参数。安全补丁（`server.py` / `prompt_pipe_server.py`）和 Named Pipe 提交通道也由灵姬内部管理，外部无法篡改。
- **`lingie_cancel_run` 是全局中断**：本地 ComfyUI 一次只执行一个任务，取消会中断当前正在执行的任务（灵姬 `LocalApiService` 的行为，MCP 侧已在工具描述中向 Agent 说明）。
- **工作流与授权**：非免费工作流需要灵姬内有效的授权（`IsFree` / 许可校验），由灵姬自行处理。
- 生成的输出文件默认保存在 `%LOCALAPPDATA%\Lingie\mcp-outputs\{run_id}\`，灵姬侧 ComfyUI 原始输出仍在 `Comfy_User/Comfy_Output`。

## 日志

MCP 服务器被 Agent 拉起后 stderr 不可见，因此所有工具调用都会追加写入本地日志文件（默认 `%LOCALAPPDATA%\Lingie\mcp-server.log`），每次调用记录三行信息：

```
2026-08-30T12:00:00.000Z [12345] 调用开始 tool=lingie_run_workflow 参数={"workflow_id":"WF-..."}
2026-08-30T12:03:21.000Z [12345] 调用完成 tool=lingie_run_workflow 耗时=201000ms
```

失败时记录 `调用失败 ... 错误=<原因>`。日志仅存本机，注意其中可能包含提示词等创作内容；用 `LINGIE_MCP_LOG=off` 可关闭。灵姬侧 58100 网关任务会出现在灵姬任务列表（来源 `lingie-mcp`），17856 工作流任务只体现在 ComfyUI 队列与输出目录。