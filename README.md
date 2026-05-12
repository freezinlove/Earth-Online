# Earth Online

Earth Online 是一个本地优先的旅行照片地球档案应用：导入照片后，应用会读取 EXIF、按旅程整理时间线，并把地点、路线和待确认信息投射到 3D 地球界面上。AI 识图和向量检索是可选能力，密钥和个人照片默认只保存在本机。

## 功能概览

- 照片导入、缩略图生成、重复检测和导入回滚
- 基于 EXIF / 离线地理数据 / AI 候选地点的旅行地点整理
- 3D 地球、旅程时间线、地点详情和搜索
- 本地 AI Provider 配置，支持 Qwen、OpenAI、OpenRouter、SiliconFlow、Voyage 等兼容接口
- 本地 SQLite 数据库和本地照片目录，适合作为私人旅行档案

## 运行要求

- Node.js 24 或更新版本
- npm 11 或更新版本

项目后端使用 `node:sqlite`，低版本 Node 可能无法启动。

## 快速开始

```bash
npm ci
npm run dev
```

Windows PowerShell 可以用：

```powershell
npm ci
npm run dev
```

启动后访问：

```txt
http://localhost:5173/
```

前端 Vite 服务默认在 `5173`，本地 API 默认在 `8787`。

## AI 配置

不需要提前创建 `.env`。启动应用后，可以在引导页或设置页填写 AI Provider 密钥；这些配置会保存到本机 `data/` 目录，不会提交到 Git。

如果不配置云端 AI 密钥，应用仍可使用本地导入、EXIF、手动编辑和基础浏览能力。

## 离线地理数据

仓库随附 `external/geodata/geonames.sqlite`，用于把 GPS 坐标离线反查成城市/地点名。首次 clone 后不需要额外构建这份数据。

如果需要基于 GeoNames 最新导出重新生成数据库，可以运行：

```bash
npm run geodata:setup
```

生成的数据位于 `external/geodata/geonames.sqlite`。下载缓存位于 `external/geodata/downloads/`，不会提交到 Git。

## 常用脚本

```bash
npm run dev          # 同时启动前端和本地 API
npm run frontend     # 只启动 Vite 前端
npm run backend      # 只启动本地 API
npm run lint         # ESLint
npm run test:backend # 后端投影和领域逻辑检查
npm run build        # TypeScript + Vite production build
```

`npm run test:mvp` 是本机验收脚本，依赖未提交的 `DESIGN_SPECS/photo test` 照片夹和测试路由；它不适合作为公开 CI 的默认步骤。

## 不应提交的内容

这些内容已经被 `.gitignore` 覆盖，公开前仍建议用 `git status --ignored` 复查：

- `.env`、`.env.local` 和任何真实 API key
- `data/` 下的照片、缩略图、SQLite 数据库、向量索引、备份、导出
- `DESIGN_SPECS/` 设计草稿和本地测试照片/视频
- `node_modules/`、`dist/`、`output/`、`test-results/`
- `external/geodata/downloads/` 和 `external/geodata/*.sqlite-*`

## CI

仓库包含 GitHub Actions 工作流：`.github/workflows/ci.yml`。它会在 Node 24 上运行：

```bash
npm ci
npm run lint
npm run test:backend
npm run build
```

## 第三方素材和数据

已提交的地球贴图、预生成 globe 数据、GeoNames 数据库和第三方依赖来源记录在 `THIRD_PARTY_NOTICES.md`。如果替换素材或刷新数据，记得同步更新来源和许可说明。

## License

项目代码目前还没有选择开源许可证。公开到 GitHub 前，如果希望别人可以复用代码，请添加一个明确的 `LICENSE` 文件；如果只是公开展示源码，也建议在仓库说明中写清楚使用边界。
