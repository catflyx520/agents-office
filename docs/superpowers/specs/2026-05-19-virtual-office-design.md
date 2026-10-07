# Virtual Office — Design Spec
Date: 2026-05-19

## 概述

一个本地运行的像素风 RPG 游戏，把 AI coding agent 实体化为办公室角色。用户控制自己的人物在地图上走动，走近某个 agent 角色的桌子即可与之对话并分配任务。PM agent 负责理解需求、拆解任务、并在地图上走过去逐一指派给对应的 agent。所有 agent 都是独立的 `claude` CLI 子进程，使用用户现有的 Claude 订阅，无需额外 API key。

---

## 技术栈

| 层 | 技术 |
|----|------|
| 游戏画面 | Phaser.js（像素风 2D RPG，俯视角） |
| 本地服务器 | Node.js + Express + ws（WebSocket） |
| Agent 执行 | `claude` CLI 子进程（`--output-format stream-json`） |
| Agent 配置存储 | Markdown 文件（`~/.virtual-office/agents/`） |

---

## 整体架构

```
┌─────────────────────────────────────────────────┐
│  浏览器（Phaser.js 游戏）                          │
│  · 像素地图 + 角色走动 + 碰撞检测                  │
│  · 对话气泡 / 聊天框                              │
│  · 添加 agent 面板                               │
│  · 控制模式切换（全自动 / 先确认）                  │
└──────────────┬──────────────────────────────────┘
               │ WebSocket
┌──────────────▼──────────────────────────────────┐
│  Node.js 服务器（localhost:3000）                  │
│  · 读写 agent .md 配置文件                        │
│  · 启动 / 停止 claude 子进程                       │
│  · 解析 PM 返回的 JSON 任务计划                    │
│  · 向游戏推送动画指令（角色移动、气泡）              │
└──────┬───────────────────┬───────────────────────┘
       │                   │
  PM claude 进程      子 agent claude 进程（每个 agent 一个）
```

---

## Agent 配置文件格式

路径：`~/.virtual-office/agents/<agent-id>.md`

```markdown
# Agent: Frontend Dev
id: frontend-dev
name: 小前                        # 用户自定义昵称，显示在头顶和对话框标题
emoji: 🧑‍🎨
role: Frontend Developer
avatar: null                      # 未来：动漫形象图片路径（如 avatars/xiaoquan.png）
workDir: ~/Projects/frontend-app
tools: Edit, Read, Bash
systemPrompt: |
  你是一个前端开发工程师，负责 frontend-app 这个 Next.js 项目。
  你擅长 TypeScript、Tailwind CSS、Next.js。
  收到任务后先读相关文件再动手，完成后简短汇报做了什么。
created: 2026-05-19
```

- 添加新 agent → 写入新 `.md` 文件 → 地图生成新角色
- 删除 agent → 删除 `.md` 文件 → 角色从地图消失
- Node.js 启动时扫描所有 `.md` 文件加载 agent 列表

---

## 地图与角色

- 俯视角像素地图，每个 agent 有固定"桌子"位置
- 用户角色（玩家）用键盘（WASD 或方向键）控制移动
- 走近 agent 桌子（碰撞区域）→ 弹出对话框
- Agent 头顶显示状态：空闲 / ⚙ working... / ✅ 完成
- 新增 agent 时自动在地图上找空位放桌子

---

## 添加 Agent 功能

触发方式：点击地图角落的 `+ Add Agent` 按钮

填写表单：
- **昵称**（如 "小前"、"阿强"，显示在角色头顶和聊天框）
- **角色类型**（如 "Frontend Developer"，用于生成 system prompt）
- **Emoji**（当前阶段的外观，未来替换为动漫形象）
- **工作目录**（绑定到哪个项目文件夹）
- **可用工具**（Edit / Read / Bash，多选）

提交后：
1. Node.js 写入 `~/.virtual-office/agents/<id>.md`
2. WebSocket 通知游戏
3. 地图上出现新角色，PM 自动认识此 agent

---

## PM 工作流程（方案 A）

### PM 的 System Prompt（动态生成）

```
你是项目经理，负责把用户需求拆解并分配给团队成员。

当前团队：
- frontend-dev（🧑‍🎨 Frontend Dev）：负责 frontend-app Next.js 项目
- app-dev（📱 App Dev）：负责 Flutter app
- backend-dev（💻 Backend Dev）：负责 backend-api .NET 项目

收到需求后，返回如下 JSON 格式（只返回 JSON，不要其他文字）：
{
  "plan": "整体思路简述",
  "tasks": [
    {
      "agent": "agent-id",
      "task": "具体要做什么",
      "waitFor": "agent-id 或 null"  // null 表示可以立即开始
    }
  ]
}
```

### 执行流程

1. 玩家走近 PM 桌子 → 聊天框打开，顶部显示控制模式切换开关
2. 玩家输入需求
3. Node.js 发给 PM claude 进程
4. PM 返回 JSON 任务计划
5. **全自动模式**：直接进入步骤 6
   **先确认模式**：在聊天框显示计划，等玩家点"确认执行"
6. Node.js 解析任务列表，按 `waitFor` 依赖顺序执行：
   - 推送动画指令：PM 角色走到目标 agent 桌子旁
   - 气泡显示任务内容
   - 启动对应 claude 子进程执行任务
7. 子 agent 执行完毕 → 头顶显示 ✅ → 结果推回玩家屏幕
8. 所有任务完成 → PM 回到自己桌子

---

## 控制模式

聊天框右上角的切换开关，每次对话前可自由切换：

- **全自动**：PM 返回计划后立即执行，不打扰玩家
- **先确认**：显示计划，玩家点"确认"才开始，可点"修改"重新描述

---

## 任务依赖（waitFor）

支持简单的顺序依赖：
```json
{ "agent": "qa-engineer", "task": "写测试", "waitFor": "frontend-dev" }
```
- `waitFor: null` → 立即并行启动
- `waitFor: "agent-id"` → 等该 agent 完成后再启动

不支持复杂的多依赖或循环依赖（留给未来版本）。

---

## 可扩展性

未来可以无缝添加的 agent 类型（只需新建 `.md` 文件）：
- `QA Engineer` — 写和执行测试
- `DevOps Agent` — CI/CD、部署
- `Code Reviewer` — PR review
- `Database Agent` — migration、查询优化

**未来：动漫形象**
每个 agent 支持自定义动漫/游戏 NPC 风格形象：
- 配置文件中 `avatar` 字段指向图片路径（`~/.virtual-office/avatars/<id>.png`）
- 游戏地图上用 sprite sheet 替换 emoji 占位符
- 对话框左侧显示立绘（半身像），像 VN 游戏对话框风格
- MVP 阶段用 emoji + 彩色像素块占位，形象系统预留接口

未来可升级到方案 B：给 PM 加 `call_agent` 工具，支持 PM 主动与其他 agent 多轮协商。

---

## 项目目录结构

```
virtual-office/
├── client/               # Phaser.js 游戏前端
│   ├── src/
│   │   ├── scenes/
│   │   │   ├── GameScene.js    # 主地图场景
│   │   │   └── UIScene.js      # 对话框、添加 agent 面板
│   │   ├── entities/
│   │   │   ├── Player.js       # 玩家角色
│   │   │   └── AgentNPC.js     # Agent 角色
│   │   └── main.js
│   └── index.html
├── server/               # Node.js 服务器
│   ├── agentManager.js   # 读写 .md 配置、管理 claude 进程
│   ├── pmOrchestrator.js # 解析 PM JSON、调度任务
│   ├── wsHandler.js      # WebSocket 消息处理
│   └── index.js
└── package.json

~/.virtual-office/
└── agents/               # Agent 配置文件
    ├── pm.md
    ├── frontend-dev.md
    ├── app-dev.md
    └── backend-dev.md
```

---

## 最小可运行版本（MVP）

1. 一张简单地图 + 玩家可以走动
2. 3 个固定 agent（PM、Frontend Dev、App Dev）
3. 走近 → 打开聊天框 → 发消息 → 收到回复
4. PM 能解析 JSON 并启动子 agent
5. 地图上能看到 PM 走动 + 气泡

后续迭代：
- Add Agent 面板
- waitFor 任务依赖
- 像素精灵动画
- 任务历史记录
