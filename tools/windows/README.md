# Windows 本机 SteamCMD 管理程序

当前版本：`1.0.6`。压缩包文件名：`steamcmd-manager-v1.0.6.zip`。

此方案由 `game-gallery` 网页直接调用**同一台 Windows 机器**的 `127.0.0.1:17864`。网站后端无需部署新接口。只能在安装 SteamCMD 的 Windows 服务器的浏览器中使用下载和更新功能。

1. 将 `steamcmd-manager.ps1` 和 `start-steamcmd-manager.bat` 复制到 Windows 服务器的同一目录。
2. 双击 `start-steamcmd-manager.bat`。首次运行会创建 `steamcmd-manager.json`，并在窗口中显示配对密钥。保持该窗口运行。
3. 在**这台 Windows 服务器**的浏览器打开 `https://degenerates.site/game-gallery/server-manager`，输入配对密钥。如果浏览器提示访问本地网络，请允许。
4. 程序会自动探测常见的 SteamCMD 和 `steamapps\common` 目录；也可以在网页中点击“浏览”使用 Windows 原生文件/文件夹选择器。
5. 添加游戏服务器时只需填写专用服务器 App ID。游戏名称和安装文件夹可以留空，首次下载完成后会从 Steam 的 `appmanifest_<AppID>.acf` 自动识别并回写；已有存档也可以手动填写原有文件夹名。

默认路径：

```text
C:\Users\Administrator\Downloads\steamcmd\steamcmd.exe
C:\Users\Administrator\Downloads\steamcmd\steamapps\common
```

更新前先正常关闭对应的游戏服务器。程序会检查安装文件夹中是否有运行中的程序。本工具不会主动删除安装目录或存档。建议在游戏大版本更新前自行备份存档。

配对密钥和设置保存在 Windows 服务器上的 `steamcmd-manager.json`；网页只在当前浏览器的 localStorage 保存密钥。请勿公开此文件或将它提交到 Git。管理程序仅监听 `127.0.0.1`，只接受来自 `https://degenerates.site` 的网页请求，并要求配对密钥。该实现支持匿名登录 SteamCMD 的专用服务器应用；需要 Steam 账号登录的应用会显示失败。

如果网站使用其他域名，可用 PowerShell 运行并指定该域名的 Origin：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\steamcmd-manager.ps1 -AllowedOrigin https://your-domain.example
```

关闭管理程序窗口会中断网页连接，但已经启动的 SteamCMD 进程可能继续运行。重新启动程序后，在该任务退出之前不能再启动新的更新；进程结束时会将任务标记为“失败／无法确认结果”，可以查看日志后再重新更新。日志保存在 `steamcmd-manager-logs`。
