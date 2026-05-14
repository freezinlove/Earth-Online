<p align="center">
  <img src="./hero.png" alt="Earth Online travel archive hero artwork" width="100%" />
</p>

<p align="center">
  <a href="../README.md">English</a>
</p>

<h1 align="center">献给热爱旅行的你</h1>

<p align="center">
  一座由 AI 驱动的自动化私人旅行星球。
</p>

<p align="center">
  Earth_Online 会自动理解你的照片、辨认旅途中的地点、整理时间与路线，把散落在相册里的回忆重新点亮在 3D 地球、时间线和旅行档案里。
</p>

<br />

## 推荐使用方式：桌面版

普通用户建议使用桌面安装包，不需要手动启动前端和后端服务。

从右侧 Releases 中获取安装包，直接进行安装：

```text
Earth Online Setup 0.1.1.exe
```

## 使用建议

- 尽量导入带有 GPS 信息的照片。
- 无 GPS 照片可以通过前后照片上下文进行二次判断。
- Embedding 是可选项，不启用也可以正常浏览和整理照片。
- 可以多试试点击时间线，非常好用。
- 照片导入速度主要受本地网络速度和云端模型供应商处理速度影响，会有明显慢尾效应。
- 单批次导入上限为 1000 张。个人建议单次导入 400 张及以下比较稳妥，因为我没测过 400 张往上的批次。

## 面向开发者的简要说明

开发或本地调试需要 Node.js `24+` 和 npm `11+`。

```powershell
winget install OpenJS.NodeJS
```

macOS / Linux 可通过 Node.js 官网或 nvm 安装 Node.js `24+`。

安装依赖：

```bash
npm ci
```

启动桌面开发版：

```bash
npm run electron:dev
```

启动 Web 开发版：

```bash
npm run dev
```

Web 开发版会打开 `http://localhost:5173/`，但浏览器里不能直接选择系统数据目录。需要改数据目录时，请在启动前设置 `EARTH_ONLINE_DATA_DIR`。

完整开发、打包、测试和数据目录说明见 [README.dev.md](./README.dev.md)。
