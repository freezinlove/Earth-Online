# Earth_Online 本地启动说明

## 推荐启动方式

在 PowerShell 中进入项目目录：

```powershell
cd <repo-path>
```

启动开发服务：

```powershell
npm run dev
```

启动成功后访问：

```text
http://localhost:5173/
```

API 服务会同时启动在：

```text
http://127.0.0.1:8787
```

`npm run dev` 对应的脚本是：

```json
"dev": "node server/dev.mjs --host 0.0.0.0"
```

也就是说，它会同时启动前端 Vite 服务和本地 API 服务。

## 备用启动方式

如果 `npm run dev` 在某些 Windows 后台场景下没有正常留下进程，可以直接运行同一个脚本：

```powershell
node server/dev.mjs --host 0.0.0.0
```

## 后台隐藏窗口启动

如果想让服务在后台运行，可以用：

```powershell
$repo = (Get-Location).Path
$logDir = Join-Path $repo 'output'
New-Item -ItemType Directory -Force $logDir | Out-Null
$out = Join-Path $logDir 'earth-online-dev.out.log'
$err = Join-Path $logDir 'earth-online-dev.err.log'
Start-Process -FilePath "node" `
  -ArgumentList "server/dev.mjs --host 0.0.0.0" `
  -WorkingDirectory $repo `
  -RedirectStandardOutput $out `
  -RedirectStandardError $err `
  -WindowStyle Hidden
```

查看日志：

```powershell
Get-Content .\output\earth-online-dev.out.log -Tail 40
Get-Content .\output\earth-online-dev.err.log -Tail 40
```

## 检查是否启动成功

检查前端：

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:5173/
```

检查占用的 Node 进程：

```powershell
Get-Process | Where-Object { $_.ProcessName -match 'node|npm' }
```

## 停止服务

如果是前台启动，按 `Ctrl + C`。

如果是后台启动，可以先查看 Node 进程，再结束对应进程：

```powershell
Get-Process | Where-Object { $_.ProcessName -match 'node|npm' }
Stop-Process -Id <进程ID>
```
