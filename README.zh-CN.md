<a name="readme-top"></a>

<div align="center">
  简体中文 | <a href="./README.md">English</a>
</div>

<div align="center">
  <img src="https://assets.openhands.dev/logo-whitebackground.png" alt="OpenHands logo" width="340">
  <h1 align="center" style="border-bottom: none">Agent Canvas</h1>
  <p align="center">
    <strong>面向编码智能体与自动化的自托管开发者控制中心。</strong>
  </p>
  <p align="center">
  在本地、远程和云端后端上运行 OpenHands、Claude Code、Codex、Gemini、Pi、OpenCode 或任何兼容 ACP 的智能体。
  </p>
</div>
<div align="center">
  <a href="https://github.com/OpenHands/OpenHands/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/OpenHands/OpenHands/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/@openhands/agent-canvas"><img src="https://img.shields.io/npm/v/%40openhands%2Fagent-canvas?style=for-the-badge&logo=npm" alt="npm version"></a>
  <a href="https://docs.openhands.dev/openhands/usage/agent-canvas/backends"><img src="https://img.shields.io/badge/Documentation-000?logo=googledocs&logoColor=FFE165&style=for-the-badge" alt="Documentation"></a>
  <a href="https://go.openhands.dev/slack"><img src="https://img.shields.io/badge/Slack-Join%20the%20community-611f69?logo=slack&logoColor=white&style=for-the-badge" alt="Join us on Slack"></a>
</div>
<div align="center">
  <a href="#快速开始">快速开始</a> |
  <a href="./docs/README.md">文档</a> |
  <a href="./docs/SELF_HOSTING.md">自托管</a> |
  <a href="https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents">ACP 智能体</a> |
  <a href="https://docs.openhands.dev/openhands/usage/agent-canvas/prebuilt-automations">自动化</a> |
  <a href="https://go.openhands.dev/slack">Slack</a>
</div>
<p align="center">
  <img src="https://assets.openhands.dev/screenshot/automation-preview.png" alt="Agent Canvas automation preview" width="100%">
</p>
<hr>

OpenHands Agent Canvas 将你的编码智能体变成一支自托管、全天候在线的工程团队。它是一个开发者控制中心，可用于发起对话和自动化日常任务——例如生成报告并发布到 Slack，或自动将 GitHub issue 拆解为任务。

它默认在本地运行，但也可以连接多个「智能体后端」（agent backend），例如在 Docker 容器、虚拟机或公司内部基础设施中运行智能体。你也可以选择在 OpenHands Cloud 或 OpenHands Enterprise 基础设施上运行智能体。

Agent Canvas 开箱即用即可运行开源的 OpenHands 智能体，也支持 Claude Code、Codex、Gemini CLI、Pi、OpenCode 等第三方智能体。

|                                                                                                                      |                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [**按你的方式自托管**](https://docs.openhands.dev/openhands/usage/agent-canvas/backend-setup/vm)                     | 在本地、Docker、虚拟机或任何能运行智能体服务后端的地方运行智能体                                                                           |
| [**在不同后端之间切换**](https://docs.openhands.dev/openhands/usage/agent-canvas/backends)                           | 在本地、远程和云端智能体之间自由切换，不丢失上下文                                                                                         |
| [**创建自动化**](https://docs.openhands.dev/openhands/usage/agent-canvas/prebuilt-automations)                       | 创建与 Slack、GitHub、Linear 等集成的自动化与工作流，可按计划运行，也可由 webhook 事件触发                                                 |
| [**与你使用的工具集成**](https://docs.openhands.dev/openhands/usage/agent-canvas/prebuilt-automations)               | 将自动化接入 Slack、GitHub、Notion 等第三方服务，实现工作流自动化                                                                           |
| [**自带模型**](https://docs.openhands.dev/openhands/usage/settings/llm-settings#llm-profiles)                        | 可搭配任何 LLM 使用                                                                                                                        |
| [**搭配任意智能体**](https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents)                             | 支持 OpenHands、Claude Code、Codex、Gemini、Pi、OpenCode，或任何符合 Agent-Client Protocol（ACP）的智能体。                                  |

如有疑问或反馈，请提交 GitHub issue，或加入 [Slack 的 #proj-agent-canvas 频道](https://openhands.dev/joinslack)。

## 快速开始

你可以在任何机器上安装 OpenHands 来运行智能体：笔记本、Mac Mini 这类专用电脑，或云服务器。

最强大的运行方式是在云服务器上运行 OpenHands。这样即使你的笔记本合上盖子，智能体也能继续运行，并且更容易通过 Slack、GitHub、Datadog 等第三方服务触发你的智能体。详情见 [SELF_HOSTING.md](docs/SELF_HOSTING.md)，尤其要注意安全加固部分。

值得注意的是，你可以在_多种不同的环境_中运行后端，并在同一个 Agent Canvas 前端中切换它们。例如，你可以与团队共享一个 Agent Server 用于代码评审和依赖更新，同时让个人智能体跑在你自己的笔记本上。

### 方式一：无沙箱（直接运行）

> [!WARNING]
> 这种方式会在你安装的机器上直接运行 agent-server——智能体将拥有你文件系统的完整访问权限！

**前置要求**：[Node.js](https://nodejs.org/) 24 或更高版本，`uv`

```sh
npm install -g @openhands/agent-canvas
agent-canvas
```

`agent-canvas` 命令默认启动完整的本地技术栈。如果想分开运行各个部分，也可以拆分启动：

```sh
agent-canvas --frontend-only  # 仅静态前端 + ingress
agent-canvas --backend-only   # 仅 agent server + 自动化后端 + ingress
```

### 方式二：Docker 沙箱

**前置要求**：

- Docker：macOS/Windows 上的 Docker Desktop，或 Linux 上的 Docker Engine/Docker Desktop。
- 一个用于 `PROJECTS_PATH` 的宿主机目录，其中存放你希望智能体访问的项目文件夹。请在启动容器前先创建好。

**macOS / Linux：**

```sh
export PROJECTS_PATH="$HOME/projects"  # 存放项目文件夹的目录
mkdir -p "$PROJECTS_PATH" "$HOME/.openhands"

docker run -it --rm \
  -p 127.0.0.1:8000:8000 \
  -e AGENT_CANVAS_ALLOW_LAN_SESSION_KEY=true \
  -v "$HOME/.openhands:/home/openhands/.openhands" \
  -v "${PROJECTS_PATH}:/projects" \
  ghcr.io/openhands/agent-canvas:1.34.0 # x-release-please-version
```

**Windows（PowerShell / Windows Terminal）：** 等效命令见 [README.windows.md](./README.windows.md)。

智能体将能够访问 `PROJECTS_PATH` 下的所有项目。

### 方式三：多 Docker 沙箱

让每个新对话都运行在各自独立的 Docker 容器中，拥有独立的 Agent Server 和工具。这适合同时运行多个智能体。Canvas 和外层 Agent Server 运行在宿主机上，并将对话请求路由到各个容器。

**前置要求**：Node.js 24 或更高版本、`uv`，以及正在运行的 Docker Desktop（macOS）或 Docker Engine/Desktop（Linux）。启动 Canvas 的用户必须能执行 `docker` 命令。

**macOS / Linux：**

```sh
npm install -g @openhands/agent-canvas
OH_CONVERSATION_RUNTIME=docker agent-canvas
```

打开 [http://localhost:8000](http://localhost:8000) 并开始一个新对话。已有的本地对话不会被迁移。每个容器都会挂载其对话的工作区和持久化状态，因此工作区文件和对话历史在容器重建后依然保留。使用同一宿主机工作区的对话仍然共享这些文件；请使用不同目录或 worktree，以避免编辑冲突。

此设置只隔离对话的执行环境，并不会把整个 Canvas 或自动化服务放入沙箱。Windows 用户请参考 [README.windows.md](./README.windows.md#option-3-with-multiple-docker-sandboxes-wsl-2)。

### 方式四：从源码运行

> [!WARNING]
> 这种方式会在你安装的机器上直接运行 agent-server——智能体将拥有你文件系统的完整访问权限！

**前置要求**：[Node.js](https://nodejs.org/) 24 或更高版本、npm 11.12.1（仓库锁定的版本）、`uv`（用于通过 `uvx` 运行 agent server）

在解析依赖之前请先检查 `npm --version`。七天发布时限过滤
（`npm install --min-release-age=7`）要求 npm >=11.10，更旧的版本
不会执行该限制。请使用 `npm ci` 按已提交的 lockfile 安装。该 npm
版本要求仅针对贡献者的依赖解析，与安装已发布的 Canvas 包无关。

```sh
git clone https://github.com/OpenHands/OpenHands.git
cd OpenHands
npm ci
npm run dev
```

---

通过 npm/源码方式启动时，访问 [http://localhost:8000](http://localhost:8000)；使用 Docker 镜像时，访问 [http://localhost:8000/canvas](http://localhost:8000/canvas)。你可以直接在 UI 中添加更多后端。

本地（`npx` / `npm run dev`）监听**仅绑定环回地址**（`127.0.0.1`），因此自动注入的 session key 不会被同一网络中的其他机器访问到。若要监听所有网络接口，请传入 `--host 0.0.0.0`（或设置 `OH_BIND_HOST`）；此时 session key **不会**被注入，UI 将使用与 `--public` 相同的 API-key 输入界面。

Docker 会监听容器的所有接口以便端口发布生效，但默认不会将 session key 注入 HTML。上面的快速开始命令显式启用了注入，同时宿主机端口只发布在 `127.0.0.1` 上。如果你将 Docker 发布在局域网或公网接口上，请去掉 `AGENT_CANVAS_ALLOW_LAN_SESSION_KEY`，并在 UI 中输入 API key。请将 `LOCAL_BACKEND_API_KEY` 设置为一个强随机值，或通过 `docker exec <container> sh -c 'cat "$STATE_DIR/api-key.txt"'` 获取生成的值。面向互联网的部署请遵循[自托管指南](./docs/SELF_HOSTING.md)。

# 架构

Agent Canvas 由 [OpenHands Agent Server](https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-agent-server/openhands/agent_server) 驱动，这是一个用于在一台机器上运行多个智能体的 REST API。每个 Agent Server 运行在单一主机/端口上；Agent Canvas 可以连接多个 Agent Server，并能在它们之间轻松切换。

你可以在任何地方运行 Agent Server：

- 直接在你的笔记本上（请谨慎！）
- 在 Mac Mini 这类专用机器上
- 在云上的虚拟机中
- 在 OpenHands Cloud（我们的商业版本）中

Agent Server 通常与 [Automation Server](https://github.com/OpenHands/automation) 配合使用，后者让你可以设置按计划运行或响应事件而运行的智能体。

<img width="1456" height="1258" alt="image" src="https://github.com/user-attachments/assets/cb6de6f5-ac30-4d04-a76a-b5c259f0c163" />

### 仓库边界

Agent Canvas 是 OpenHands 多仓库系统的一部分。改动应提交到拥有对应行为的仓库：

| 仓库                                                                              | 职责                                                                                                       |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`OpenHands/OpenHands`](https://github.com/OpenHands/OpenHands)                   | Agent Canvas 前端、面向用户的控制中心、后端选择、本地技术栈编排。                                            |
| [`OpenHands/software-agent-sdk`](https://github.com/OpenHands/software-agent-sdk) | Python SDK、Agent Server、智能体、工具、对话、工作区、事件以及规范的服务端 API。                              |
| [`OpenHands/typescript-client`](https://github.com/OpenHands/typescript-client)   | 面向浏览器的 Agent Server API TypeScript 客户端。                                                            |
| [`OpenHands/automation`](https://github.com/OpenHands/automation)                 | 自动化定义、调度、webhook、运行历史与分发。                                                                  |

Agent Server API 由 SDK 实现，Agent Canvas 通过 TypeScript 客户端消费。自动化服务决定任务何时运行，并将对话分发给 Agent Server/SDK，由后者决定运行什么。贡献者相关的边界与必需的自定义代码评审指南见 [`AGENTS.md`](./AGENTS.md)。

## 更多文档

- [文档索引](./docs/README.md)
- [架构总览](./docs/architecture.md)
- [开发指南](./docs/DEVELOPMENT.md)，包括[在宿主应用中嵌入 Canvas 组件](./docs/DEVELOPMENT.md#css-isolation-and-host-app-customization)（在组件导入旁边加载一次 `@openhands/agent-canvas/styles.css`）
- [自托管指南](./docs/SELF_HOSTING.md)
