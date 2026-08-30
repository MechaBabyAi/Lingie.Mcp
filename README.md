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

## 接入 AI Agent

### ZCode / Claude Desktop / Cursor（通用 mcpServers 格式）

```json
{
  "mcpServers": {
    "lingie": {
      "command": "node",
      "args": ["F:\\MechBabyCodes\\TeleClawWorkspace\\Lingie.Mcp\\server.mjs"]
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
| `lingie_health` | 检查灵姬本地 API 与本地 ComfyUI 引擎是否在线 |
| `lingie_list_workflows` | 列出可用工作流（图片/视频/音频生成等） |
| `lingie_workflow_capabilities` | 查看某工作流的参数模式（类型/必填/默认值/可选值/提交方式） |
| `lingie_run_workflow` | 执行工作流并等待完成，输出文件下载后以**本地绝对路径**返回；`wait=false` 可异步提交 |
| `lingie_run_status` | 查询任务状态与进度（不下载输出） |
| `lingie_cancel_run` | 取消任务（注意：会中断本地引擎当前正在执行的任务） |
| `lingie_upload_file` | 上传本地文件到 ComfyUI 输入目录（供图生图/参考图/首帧等参数使用） |

当网关凭证可用时（二选一），额外暴露「AI 应用网关」（`:58100`）工具，覆盖本地/云端 ComfyUI 与第三方模型（DALL·E、Midjourney、Seedream、Kling、Vidu、Wan 等，按灵力值计费）：

1. **灵姬内开启（推荐）**：灵姬 设置 → 本地 API → 打开「Agent (MCP) 网关接入」，灵姬会自动把凭证写入 `%LOCALAPPDATA%\Lingie\mcp-credentials.json`，本服务器自动发现（约 10 秒内生效，无需重启）；
2. **环境变量**：设置 `LINGIE_GATEWAY_APP_KEY` + `LINGIE_GATEWAY_USER_TOKEN`。

| 工具 | 说明 |
|---|---|
| `lingie_list_models` | 列出网关可用模型（model_code） |
| `lingie_generate_image` / `lingie_generate_video` | 一键调用模型生成图片/视频 |
| `lingie_task_status` / `lingie_cancel_task` | 网关任务状态/取消 |
| `lingie_estimate_cost` / `lingie_spirit_balance` | 灵力值估价/余额 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LINGIE_API_PORT` | settings.json 的 `LocalApiPort`（默认 17856） | 工作流 API 端口 |
| `LINGIE_API_TOKEN` | settings.json 的 `LocalApiBearerToken` | 工作流 API Bearer Token |
| `LINGIE_MCP_OUTPUT_DIR` | `%LOCALAPPDATA%\Lingie\mcp-outputs` | 输出文件下载目录 |
| `LINGIE_GATEWAY_APP_KEY` | 灵姬签发的 `mcp-credentials.json` | 网关 AppKey（与 `LINGIE_GATEWAY_USER_TOKEN` 一起设置后启用网关工具） |
| `LINGIE_GATEWAY_USER_TOKEN` | 无 | 网关 Bearer 用户令牌 |
| `LINGIE_GATEWAY_PORT` / `LINGIE_GATEWAY_URL` | `%LOCALAPPDATA%\Lingie\api_server.json` 的 `api_port`（默认 58100） | 网关地址 |

## Agent 典型调用流程

```
1. lingie_health                          → 确认灵姬在线
2. lingie_list_workflows                  → 找到想用的工作流（如"文生图"）
3. lingie_workflow_capabilities           → 了解参数怎么填
4. （可选）lingie_upload_file              → 图生图先上传参考图
5. lingie_run_workflow { params }         → 等待生成，拿到输出文件本地路径
6. Agent 直接 Read / 处理该路径下的图片或视频
```

## 已知限制

- **工作流 API 只走本地 ComfyUI 引擎**：云端 ComfyUI / 第三方模型（Kling 等计费模型）需走网关工具。网关凭证在灵姬 设置 → 本地 API → 「Agent (MCP) 网关接入」一键签发（写入 `mcp-credentials.json`），或由管理员通过环境变量提供。
- **`lingie_cancel_run` 是全局中断**：本地 ComfyUI 一次只执行一个任务，取消会中断当前正在执行的任务（灵姬 `LocalApiService` 的行为，MCP 侧已在工具描述中向 Agent 说明）。
- **工作流与授权**：非免费工作流需要灵姬内有效的授权（`IsFree` / 许可校验），由灵姬自行处理。
- 生成的输出文件默认保存在 `%LOCALAPPDATA%\Lingie\mcp-outputs\{run_id}\`，灵姬侧 ComfyUI 原始输出仍在 `Comfy_User/Comfy_Output`。
