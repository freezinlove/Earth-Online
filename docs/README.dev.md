# Earth_Online 开发者指南

<p align="center">
  <a href="./README.dev.en.md">English</a>
</p>

Earth_Online 是一个本地优先、AI 驱动的旅行照片档案工具。它会导入个人旅行照片，读取 EXIF 元数据，按需调用 AI 模型理解地点和画面内容，将照片归档成旅程，补全缺失的位置上下文，并把结果投射到 3D 地球时间线上。

本文档面向开发者。面向普通用户的中文说明见 [README.zh.md](./README.zh.md)。

## 运行环境

- Node.js `>=24.0.0`
- npm `>=11.0.0`
- Windows 是当前主要桌面打包目标。
- Web 开发模式需要现代 Chromium 系浏览器。

后端依赖较新的 Node 运行时能力。除非你在专门测试兼容性，否则请使用 Node 24+。

Windows 安装 Node.js：

```powershell
winget install OpenJS.NodeJS
```

确认版本：

```bash
node --version
npm --version
```

安装依赖：

```bash
npm ci
```

## 开发模式

### 桌面端开发，推荐用于产品行为测试

```bash
npm run electron:dev
```

该命令会启动：

- Vite 前端：`http://127.0.0.1:5173/`
- Electron 桌面壳
- 由 Electron 主进程启动的本地 API

需要验证面向普通用户的行为时，优先使用这个模式，包括：

- 原生目录选择器
- 首次启动的数据存储位置选择
- 桌面端开屏引导持久化
- 本地 API token 保护
- 打包应用的导航行为

如果希望桌面开发版和已安装的正式桌面版隔离配置，启动前指定单独的 Electron 配置目录：

```powershell
$env:EARTH_ONLINE_USER_DATA_DIR="X:\Earth_Online_Dev_Config"
npm run electron:dev
```

然后在应用内选择真正的数据目录，例如：

```text
X:\Earth_Online_Dev_Data
```

### Web 开发

```bash
npm run dev
```

该命令会启动：

- Vite 前端：`http://localhost:5173/`
- 本地 API：`http://127.0.0.1:8787/`

Vite 开发服务器会把 `/api` 和 `/data` 代理到本地 API。

Web 开发版不能打开系统原生目录选择器。它可以显示当前数据目录，但不能从界面修改数据目录。如需修改 Web 开发版的数据目录，启动前设置 `EARTH_ONLINE_DATA_DIR`：

```powershell
$env:EARTH_ONLINE_DATA_DIR="X:\Earth_Online_Web_Data"
npm run dev
```

如果 `http://localhost:5173/` 能打开，但存储位置或设置页加载失败，先检查 API 是否也在运行：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/settings/storage
```

### 前后端分开启动

```bash
npm run backend
npm run frontend
```

只有在需要单独调试前端或后端时使用。普通开发优先使用 `npm run dev` 或 `npm run electron:dev`。

## 桌面端打包

构建 Windows 安装包和解压版桌面应用：

```bash
npm run electron:dist
```

输出位置：

```text
release/win-unpacked/Earth Online.exe
release/Earth Online Setup 0.1.0.exe
```

只构建解压版应用：

```bash
npm run electron:pack
```

测试打包后的桌面应用：

```bash
npm run electron:smoke
```

smoke 测试会检查打包版启动、本地 API 访问、桌面端 token 保护、资源加载、基础导入、开屏引导持久化，以及数据存储配置行为。

## 数据存储

Earth_Online 有两个不同的存储概念。

### 真正的应用数据目录

该目录保存用户数据：

```text
db.json
photos/
thumbnails/
vector-index.json
import-jobs/
secrets/local-ai.json
earth-online-data.json
```

这里包含个人照片、生成的缩略图、本地应用状态、向量检索数据、导入任务状态，以及本地保存的 AI 凭据。

Web 开发版默认目录：

```text
data/
```

Web 开发版指定目录：

```powershell
$env:EARTH_ONLINE_DATA_DIR="X:\Earth_Online_Web_Data"
npm run dev
```

Electron 桌面端行为：

- 首次桌面端启动时，应用会要求用户选择数据目录。
- 选中的路径会保存到 Electron preferences。
- 在设置页切换数据目录需要重启应用。
- 当前版本不会自动迁移已有数据。
- 如果设置了 `EARTH_ONLINE_DATA_DIR`，它会覆盖界面选择，并禁用目录选择器。

### Electron 配置目录

Electron 还会维护一个较小的配置和缓存目录。Windows 打包版默认通常是：

```text
C:\Users\<User>\AppData\Roaming\earth-online
```

这里保存 Electron preferences、缓存、开屏引导完成状态，以及指向真实应用数据目录的路径。该目录应该保持很小。除非用户明确选择默认数据目录，否则不要把大量导入照片放在这里。

开发版隔离配置：

```powershell
$env:EARTH_ONLINE_USER_DATA_DIR="X:\Earth_Online_Dev_Config"
npm run electron:dev
```

## 项目结构

```text
src/                    React 应用、UI 状态、i18n、功能界面
electron/               Electron main/preload/dev launcher
server/                 本地 Node API、持久化、导入流水线、AI 网关
scripts/                数据生成、备份/重置、打包检查
public/assets/          已提交的地球视觉资源
public/data/globe/      已提交的二进制地球几何/线条资源
external/geodata/       已提交的 GeoNames SQLite 数据库和刷新脚本
data/                   Web 开发版默认本地数据目录，Git 忽略
docs/                   README 图片和项目文档资源
release/                生成的桌面端产物，Git 忽略
output/                 日志、smoke 测试数据、临时输出，Git 忽略
```

主要运行面：

- 前端：React 18、Vite、Zustand、Three.js、React Three Fiber、`three-globe`。
- 后端：Node HTTP server、本地文件存储、AI provider registry、地理编码、导入服务。
- 桌面端：Electron 主进程、原生目录选择器、桌面端 preferences、打包版 API 启动。

后端不是远程服务。它运行在用户本机，在 Web 开发模式下跟前端并行运行，在桌面端中由 Electron 管理。

## 请求流

Web 开发版：

```text
Browser UI
  -> Vite dev proxy
  -> server/http/router.mjs
  -> application service
  -> repository + local files + optional AI/geodata
```

桌面端：

```text
Electron renderer
  -> preload desktop bridge
  -> local API with desktop token
  -> server/http/router.mjs
  -> application service
  -> selected data directory + optional AI/geodata
```

重要 API：

- `/api/state`：完整应用投影视图
- `/api/import/jobs`：创建和轮询照片导入任务
- `/api/import/jobs/:id/events`：导入进度 SSE
- `/api/settings/ai`：provider 凭据和模型配置
- `/api/settings/storage`：当前存储路径
- `/api/geocode/reverse`：本地反向地理编码
- `/data/photos/*` 和 `/data/thumbs/*`：本地媒体资源

## 数据模型

持久化状态存放在当前应用数据目录下。当前后端路径包括：

- `db.json`：本地应用状态
- `photos/`：导入的原始照片
- `thumbnails/`：生成的缩略图
- `vector-index.json`：本地搜索/向量索引
- `secrets/local-ai.json`：本地保存的 AI 凭据和模型设置
- `import-jobs/`：导入任务过程状态和输出

默认 `data/` 目录中的用户数据由 Git 忽略，例外是 `data/.gitkeep` 和 `data/README.md`。

## AI 系统

AI 是可选项，但它是预期产品体验的核心部分。

Provider 设置在应用内管理，并保存到当前数据目录：

```text
secrets/local-ai.json
```

普通用户不需要 `.env`。

当前支持的 provider family：

- Aliyun / Qwen
- OpenAI
- OpenRouter
- SiliconFlow
- Voyage
- OpenAI-compatible providers

主要后端模块：

```text
server/ai/model-catalog.mjs
server/ai/provider-registry.mjs
server/ai/ai-config.mjs
server/ai/ai-gateway.mjs
server/ai/providers/*.mjs
server/ai/prompts/*.md
```

主要 AI 任务：

- 导入照片的图像理解
- 缺失位置和上下文推断
- 用于搜索的跨模态或文本 embedding
- 失败 embedding 的重试和重建

凭据解析顺序：

```text
profile-specific local credential
  -> global local credential
  -> environment variable / .env fallback
```

环境变量仍然作为开发、自动化或高级部署的覆盖入口，但产品路径是应用内配置。

## 导入流水线

照片导入由 `server/application/import-service.mjs` 编排。

高层流程：

```text
read/upload files
  -> hash and duplicate detection
  -> EXIF parse
  -> thumbnail generation
  -> optional AI image analysis
  -> optional embeddings
  -> trip grouping
  -> location resolution
  -> pending item creation
  -> projected state response
```

导入进度会写入任务事件并通过 SSE 发出，所以 UI 可以在刷新或重新连接后恢复进度。

重要默认值：

```text
EARTH_ONLINE_IMPORT_METADATA_CONCURRENCY=16
EARTH_ONLINE_IMPORT_STORAGE_WRITE_CONCURRENCY=16
EARTH_ONLINE_IMPORT_AI_CONCURRENCY=200
EARTH_ONLINE_IMPORT_EMBEDDING_CONCURRENCY=600
EARTH_ONLINE_MISSING_INFERENCE_CONCURRENCY=200
EARTH_ONLINE_AI_IMAGE_MAX_DIMENSION=1200
EARTH_ONLINE_AI_IMAGE_JPEG_QUALITY=82
```

这些参数不写在面向普通用户的 README 中。把它们当作开发者调优项。

## Geodata

仓库包含：

```text
external/geodata/geonames.sqlite
```

这是转换后的 GeoNames 数据集，用于离线正向和反向地理编码。它被提交到仓库中，因此 fresh clone 不需要跑重型初始化步骤也能获得本地地理编码能力。

刷新数据：

```bash
npm run geodata:setup
```

该命令会把 GeoNames dump 下载到 `external/geodata/downloads/`，并重建 `external/geodata/geonames.sqlite`。

被忽略的 geodata 副产物：

```text
external/geodata/downloads/
external/geodata/*.sqlite-shm
external/geodata/*.sqlite-wal
```

如果数据库缺失，应用仍可运行，但地理编码质量会下降。

## 地球资源

已提交的地球运行时资源：

```text
public/assets/earth_atmos_2048.jpg
public/assets/earth_bmng_topography_5400.jpg
public/data/globe/*.bin
```

重新生成二进制地球线条/陆地资源：

```bash
npm run generate:globe
```

`three-globe` 作为 npm dependency 使用。本地 `external/three-globe/` 只作为参考和调试副本，并保持 Git 忽略。

## 脚本

```bash
npm run dev              # 启动 Web 开发版前端和 API
npm run electron:dev     # 启动 Electron 桌面开发版
npm run electron:pack    # 构建解压版桌面应用
npm run electron:dist    # 构建解压版桌面应用和 Windows 安装包
npm run electron:smoke   # 测试打包后的桌面应用
npm run frontend         # 只启动 Vite
npm run backend          # 只启动本地 API
npm run build            # TypeScript build + Vite production build
npm run preview          # 预览 production 前端
npm run lint             # ESLint
npm run test:backend     # 可复现的后端/domain 检查
npm run test:mvp         # 本地验收脚本，依赖私有 fixtures
npm run seed:demo        # 写入 demo 状态
npm run data:backup      # 备份本地用户数据
npm run data:reset       # 重置本地用户数据
npm run data:rebuild     # 从已有本地照片重建状态
npm run geodata:setup    # 下载并构建 GeoNames SQLite
npm run generate:globe   # 生成已提交的地球二进制资源
```

## 质量门禁

发布或开 PR 前运行：

```bash
npm run lint
npm run test:backend
npm run build
npm run electron:smoke
npm audit --audit-level=moderate
```

如果打包产物需要反映当前源码，先运行 `npm run electron:dist`，再运行 `npm run electron:smoke`。

当前已知非阻断 warning：

- ESLint 会报告一些 React Fast Refresh warning，因为少数文件同时导出 component 和 helper。
- ESLint 会报告 `EarthStage.tsx` 中少量 hook dependency warning。
- Vite 会提示部分 production chunks 超过 500 kB，因为前端包含较重的 3D/AI UI。

这些 warning 值得后续改进，但目前不阻断 build 或 packaging。

## 测试说明

`npm run test:backend` 是公开、CI 安全的测试路径。它不依赖私有照片 fixtures，验证核心后端投影和解析行为。

`npm run electron:smoke` 会测试 `release/win-unpacked/` 下生成的桌面应用。运行前需要先存在打包产物。

`npm run test:mvp` 是本地验收脚本。它期望私有 fixture 媒体位于：

```text
DESIGN_SPECS/photo test/
```

它还会启用私有测试路由：

```text
EARTH_ONLINE_ENABLE_TEST_ROUTES=1
```

除非 fixtures 被替换成可再分发的测试素材，否则不要把 `test:mvp` 加入公开 CI。

## 环境变量

普通用户应在应用内配置 AI provider 和桌面端数据存储。这些变量用于开发、自动化或高级部署。

运行时路径：

```text
EARTH_ONLINE_PORT
EARTH_ONLINE_DATA_DIR
EARTH_ONLINE_USER_DATA_DIR
EARTH_ONLINE_GEODATA_PATH
ELECTRON_DEV_SERVER_URL
```

桌面端/运行时安全：

```text
EARTH_ONLINE_DESKTOP
EARTH_ONLINE_DESKTOP_TOKEN
```

AI 凭据：

```text
ALIYUN_API_KEY
BAILIAN_API_KEY
QWEN_API_KEY
QWEN_CHAT_API_KEY
QWEN_EMBEDDING_API_KEY
OPENAI_API_KEY
OPENROUTER_API_KEY
SILICONFLOW_API_KEY
VOYAGE_API_KEY
```

AI 模型和运行时调优：

```text
QWEN_CHAT_MODEL
QWEN_REQUEST_TIMEOUT_MS
QWEN_VISION_EMBEDDING_MODEL
EARTH_ONLINE_AI_IMAGE_MAX_DIMENSION
EARTH_ONLINE_AI_IMAGE_JPEG_QUALITY
EARTH_ONLINE_MISSING_INFERENCE_CONCURRENCY
```

导入调优：

```text
EARTH_ONLINE_IMPORT_METADATA_CONCURRENCY
EARTH_ONLINE_IMPORT_STORAGE_WRITE_CONCURRENCY
EARTH_ONLINE_IMPORT_AI_CONCURRENCY
EARTH_ONLINE_IMPORT_EMBEDDING_CONCURRENCY
EARTH_ONLINE_FAILED_IMPORT_JOB_RETENTION_MS
```

仅测试使用：

```text
EARTH_ONLINE_BASE_URL
EARTH_ONLINE_ENABLE_TEST_ROUTES
EARTH_ONLINE_TEST_CLOUD_AI
EARTH_ONLINE_SMOKE_DATA_DIR
EARTH_ONLINE_SMOKE_RENDERER_REPORT
EARTH_ONLINE_SMOKE_MARK_ONBOARDING_COMPLETE
EARTH_ONLINE_SMOKE_INITIAL_STORAGE_FLOW
```

## Git 卫生

不要提交：

```text
.env
data/
DESIGN_SPECS/
dist/
node_modules/
output/
release/
test-results/
external/geodata/downloads/
external/geodata/*.sqlite-*
external/three-globe/
```

预期提交的二进制/数据文件：

```text
external/geodata/geonames.sqlite
public/assets/*.jpg
public/data/globe/*.bin
docs/gugugaga.png
docs/gugugaga.ico
```

发布前检查：

```bash
git status --short --ignored
git diff --check
git ls-files | sort
```

## 发布检查表

1. 确认 [README.md](../README.md) 仍是默认英文用户文档，[README.zh.md](./README.zh.md) 仍是中文用户文档，本文件仍是技术文档。
2. 运行质量门禁。
3. 运行 `npm run electron:dist`。
4. 运行 `npm run electron:smoke`。
5. 验证 `external/geodata/geonames.sqlite` 通过 `PRAGMA integrity_check`。
6. 确认 `git status --short --ignored` 中没有个人数据。
7. 确认 `THIRD_PARTY_NOTICES.md` 中的第三方归因。
8. 发布为开源前决定是否增加根目录 `LICENSE`。

SQLite 完整性检查：

```bash
sqlite3 external/geodata/geonames.sqlite "PRAGMA integrity_check;"
```

## 常见问题

### Web dev 页面能打开，但存储/设置加载失败

检查 API 是否运行：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/settings/storage
```

如果只有 `5173` 端口在监听，停止残留前端进程，然后重新运行 `npm run dev`。

### 桌面开发版读到了打包版的数据

使用单独的 Electron 配置目录：

```powershell
$env:EARTH_ONLINE_USER_DATA_DIR="X:\Earth_Online_Dev_Config"
npm run electron:dev
```

### 界面的目录选择器被禁用

检查是否设置了 `EARTH_ONLINE_DATA_DIR`。在 Electron 中，该环境变量会有意覆盖 UI 选择的数据目录，并禁用目录选择器。

### 打包版界面还是旧的

重新打包桌面端：

```bash
npm run electron:dist
```

然后启动：

```text
release/win-unpacked/Earth Online.exe
```

## 第三方声明

资源、数据和依赖归因见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。刷新 GeoNames 数据、替换地球图像或更改显式第三方运行时依赖时，需要同步更新该文件。
