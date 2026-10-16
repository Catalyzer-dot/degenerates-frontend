param(
    [string]$AllowedOrigin = 'https://degenerates.site',
    [int]$Port = 17864
)

$ErrorActionPreference = 'Stop'
$ManagerVersion = '1.0.8'
$configPath = Join-Path $PSScriptRoot 'steamcmd-manager.json'
$logDir = Join-Path $PSScriptRoot 'steamcmd-manager-logs'
$script:steamProcess = $null
$script:serverProcesses = @{}

function Find-DefaultSteamCmd {
    $candidates = @(
        (Join-Path $PSScriptRoot 'steamcmd.exe'),
        (Join-Path $PSScriptRoot 'steamcmd\steamcmd.exe'),
        (Join-Path $env:USERPROFILE 'Downloads\steamcmd\steamcmd.exe'),
        (Join-Path $env:ProgramFiles 'SteamCMD\steamcmd.exe')
    )
    return $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function Find-DefaultInstallRoot([string]$steamCmdPath) {
    if ($steamCmdPath) {
        $steamRoot = Split-Path $steamCmdPath -Parent
        $common = Join-Path $steamRoot 'steamapps\common'
        if (Test-Path -LiteralPath $common -PathType Container) { return $common }
    }
    $candidates = @(
        (Join-Path $PSScriptRoot 'steamapps\common'),
        (Join-Path $env:USERPROFILE 'Downloads\steamcmd\steamapps\common'),
        (Join-Path $env:ProgramFiles 'SteamCMD\steamapps\common')
    )
    return $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
}

function Save-Config {
    $json = $script:config | ConvertTo-Json -Depth 8
    $tmp = "$configPath.tmp"
    [IO.File]::WriteAllText($tmp, $json, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $configPath) {
        Move-Item -LiteralPath $tmp -Destination $configPath -Force
    } else {
        Move-Item -LiteralPath $tmp -Destination $configPath
    }
}

if (Test-Path -LiteralPath $configPath) {
    $script:config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $config.token) { throw 'Configuration has no pairing token.' }
} else {
    $randomBytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
    $token = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $detectedSteamCmd = Find-DefaultSteamCmd
    $detectedInstallRoot = Find-DefaultInstallRoot $detectedSteamCmd
    if (-not $detectedSteamCmd) { $detectedSteamCmd = '' }
    if (-not $detectedInstallRoot) { $detectedInstallRoot = '' }
    $script:config = [pscustomobject]@{
        token = $token
        steamCmdPath = $detectedSteamCmd
        installRoot = $detectedInstallRoot
        apps = @()
        job = $null
    }
    Save-Config
}

function Read-Log([string]$path) {
    if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return '' }
    try { return (Get-Content -LiteralPath $path -Tail 120 -ErrorAction Stop) -join "`n" }
    catch { return '' }
}

function Refresh-Job {
    $job = $script:config.job
    if ($null -eq $job -or $job.status -ne 'running') { return }

    $stdout = Read-Log $job.stdoutPath
    $stderr = Read-Log $job.stderrPath
    $job.output = ($stdout + "`n" + $stderr).Trim()

    if ($null -ne $script:steamProcess) {
        $script:steamProcess.Refresh()
        if (-not $script:steamProcess.HasExited) { return }
        $exitCode = $script:steamProcess.ExitCode
        $script:steamProcess.Dispose()
        $script:steamProcess = $null
        $successfulUpdate = $job.output -match "(?im)^\s*Success! App '$($job.appId)' (fully installed|already up to date)\.\s*$"
        if (($null -eq $exitCode -or $exitCode -eq 0) -and $successfulUpdate) {
            $job.status = 'succeeded'
            if ($job.autoFolder) {
                $app = @($script:config.apps | Where-Object { $_.appId -eq $job.appId }) | Select-Object -First 1
                $resolved = Resolve-AppInstall $job.appId ''
                if ($app -and $resolved.manifest) {
                    $app.folder = $resolved.manifest.folder
                    if ([string]::IsNullOrWhiteSpace([string]$app.name) -and $resolved.manifest.name) { $app.name = $resolved.manifest.name }
                }
            }
        } else {
            $job.status = 'failed'
            if ($null -ne $exitCode) { $job.output += "`nSteamCMD exit code: $exitCode" }
        }
    } else {
        $old = Get-Process -Id $job.pid -ErrorAction SilentlyContinue
        if ($old -and $old.ProcessName -eq 'steamcmd') { return }
        $job.status = 'failed'
        $job.output += "`nManager restarted during this job; SteamCMD exit status could not be verified."
    }
    $job.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    Save-Config
}

function Public-State {
    Refresh-Job
    $job = $null
    if ($script:config.job) {
        $j = $script:config.job
        $job = @{
            id = $j.id; appId = $j.appId; status = $j.status
            startedAt = $j.startedAt; finishedAt = $j.finishedAt; output = $j.output
        }
    }
    return @{
        managerVersion = $ManagerVersion
        steamCmdPath = $script:config.steamCmdPath
        installRoot = $script:config.installRoot
        apps = @($script:config.apps | ForEach-Object {
            $process = $null
            if ($script:serverProcesses.ContainsKey([int]$_.appId)) { $process = Get-Process -Id $script:serverProcesses[[int]$_.appId] -ErrorAction SilentlyContinue }
            $executable = $null
            if ($process) { $executable = $process.Path }
            [pscustomobject]@{ appId = $_.appId; name = $_.name; folder = $_.folder; running = ($null -ne $process); executable = $executable; configFile = $_.configFile }
        })
        job = $job
    }
}

function Send-Json($context, [int]$status, $value) {
    $response = $context.Response
    $response.StatusCode = $status
    $response.KeepAlive = $false
    $response.ContentType = 'application/json; charset=utf-8'
    $response.Headers['Cache-Control'] = 'no-store'
    $response.Headers['Vary'] = 'Origin'
    if ($context.Request.Headers['Origin'] -eq $AllowedOrigin) {
        $response.Headers['Access-Control-Allow-Origin'] = $AllowedOrigin
        $response.Headers['Access-Control-Allow-Private-Network'] = 'true'
    }
    $json = $value | ConvertTo-Json -Depth 8 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $response.ContentLength64 = $bytes.Length
    try { $response.OutputStream.Write($bytes, 0, $bytes.Length) }
    finally { $response.Close() }
}

function Read-Body($request) {
    if ($request.ContentLength64 -gt 1048576) { throw 'Request body is too large.' }
    $reader = New-Object IO.StreamReader($request.InputStream, [Text.Encoding]::UTF8)
    $body = $reader.ReadToEnd()
    if ($body.Length -gt 1048576) { throw 'Request body is too large.' }
    if ([string]::IsNullOrWhiteSpace($body)) { throw 'Request body is empty.' }
    return $body | ConvertFrom-Json
}

function Browse-Path([string]$kind) {
    Add-Type -AssemblyName System.Windows.Forms
    if ($kind -eq 'steamcmd') {
        $dialog = New-Object Windows.Forms.OpenFileDialog
        $dialog.Filter = 'SteamCMD (steamcmd.exe)|steamcmd.exe|Executable (*.exe)|*.exe'
        $dialog.Title = '选择 steamcmd.exe'
        if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { return $dialog.FileName }
        return $null
    }
    $dialog = New-Object Windows.Forms.FolderBrowserDialog
    $dialog.Description = '选择游戏安装根目录（通常是 steamapps\common）'
    $dialog.ShowNewFolderButton = $true
    if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { return $dialog.SelectedPath }
    return $null
}

function Check-Folder([string]$folder) {
    if ($folder -notmatch '^[A-Za-z0-9 _.-]{1,64}$' -or $folder -in @('.', '..') -or
        $folder.EndsWith('.') -or $folder.EndsWith(' ') -or
        $folder -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
        throw 'Folder name must be a single Windows folder without special characters.'
    }
}

function Check-Settings([string]$steamCmdPath, [string]$installRoot) {
    if (-not (Test-Path -LiteralPath $steamCmdPath -PathType Leaf) -or
        [IO.Path]::GetFileName($steamCmdPath) -ine 'steamcmd.exe') {
        throw 'SteamCMD path must point to an existing steamcmd.exe.'
    }
    if (-not (Test-Path -LiteralPath $installRoot -PathType Container)) {
        throw 'Install root does not exist.'
    }
}

function Read-AppManifest([string]$appManifestPath) {
    if (-not (Test-Path -LiteralPath $appManifestPath -PathType Leaf)) { return $null }
    $text = Get-Content -LiteralPath $appManifestPath -Raw -Encoding UTF8
    $nameMatch = [regex]::Match($text, '(?m)^\s*"name"\s+"([^"]+)"')
    $installdirMatch = [regex]::Match($text, '(?m)^\s*"installdir"\s+"([^"]+)"')
    if (-not $installdirMatch.Success) { return $null }
    $name = ''
    if ($nameMatch.Success) { $name = $nameMatch.Groups[1].Value }
    return @{ name = $name; folder = $installdirMatch.Groups[1].Value }
}

function Resolve-AppInstall([int]$appId, [string]$folder) {
    if ($folder) { return @{ folder = $folder; manifest = $null } }
    $steamApps = Split-Path $script:config.installRoot -Parent
    $manifest = Read-AppManifest (Join-Path $steamApps "appmanifest_$appId.acf")
    if ($manifest) { return @{ folder = $manifest.folder; manifest = $manifest } }
    return @{ folder = ''; manifest = $null }
}

function Find-ServerExecutable([string]$target) {
    $files = @(Get-ChildItem -LiteralPath $target -Filter '*.exe' -File -Recurse -ErrorAction SilentlyContinue)
    $preferred = $files | Where-Object { $_.Name -match '(?i)(server|dedicated|headless)' -and $_.Name -notmatch '(?i)(steamcmd|unins|crash|redist)' } | Select-Object -First 1
    if ($preferred) { return $preferred.FullName }
    if ($files.Count -eq 1) { return $files[0].FullName }
    return $null
}

function Get-AppTarget([int]$appId) {
    $app = @($script:config.apps | Where-Object { $_.appId -eq $appId }) | Select-Object -First 1
    if (-not $app) { throw 'App ID is not configured.' }
    Check-Settings $script:config.steamCmdPath $script:config.installRoot
    $resolved = Resolve-AppInstall $appId ([string]$app.folder)
    if (-not $resolved.folder) { throw '请先下载一次服务器，让管理程序识别安装文件夹。' }
    Check-Folder $resolved.folder
    $root = [IO.Path]::GetFullPath($script:config.installRoot).TrimEnd('\')
    $target = [IO.Path]::GetFullPath((Join-Path $root $resolved.folder))
    if (-not $target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Install folder is outside the configured root.' }
    if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw 'Install folder does not exist. Download the server first.' }
    return @{ app = $app; target = $target }
}

function Get-ConfigPath([int]$appId) {
    $resolved = Get-AppTarget $appId
    $app = $resolved.app
    if (-not $app.configFile) { throw '请先选择服务器配置文件。' }
    $path = [IO.Path]::GetFullPath((Join-Path $resolved.target $app.configFile))
    if (-not $path.StartsWith($resolved.target + '\', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { throw '配置文件必须位于服务器安装目录内。' }
    return @{ app = $app; target = $resolved.target; path = $path }
}

function Browse-Config([int]$appId) {
    $resolved = Get-AppTarget $appId
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object Windows.Forms.OpenFileDialog
    $dialog.InitialDirectory = $resolved.target
    $dialog.Filter = '配置文件|config;*.config;*.ini;*.cfg;*.json;*.xml;*.yaml;*.yml;*.toml;*.txt|所有文件|*.*'
    if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return $null }
    $path = [IO.Path]::GetFullPath($dialog.FileName)
    if (-not $path.StartsWith($resolved.target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '配置文件必须位于服务器安装目录内。' }
    $resolved.app.configFile = $path.Substring($resolved.target.Length + 1)
    Save-Config
    return $resolved.app.configFile
}

function Start-Server([int]$appId) {
    $resolved = Get-AppTarget $appId
    $existing = $null
    if ($script:serverProcesses.ContainsKey($appId)) { $existing = Get-Process -Id $script:serverProcesses[$appId] -ErrorAction SilentlyContinue }
    if ($existing) { throw 'Server is already running.' }
    $exe = Find-ServerExecutable $resolved.target
    if (-not $exe) { throw '找不到服务器可执行文件。请在安装目录中放置包含 server 或 dedicated 的 exe。' }
    $process = Start-Process -FilePath $exe -WorkingDirectory $resolved.target -PassThru
    $script:serverProcesses[$appId] = $process.Id
    Save-Config
}

function Stop-Server([int]$appId) {
    $resolved = Get-AppTarget $appId
    $process = $null
    if ($script:serverProcesses.ContainsKey($appId)) { $process = Get-Process -Id $script:serverProcesses[$appId] -ErrorAction SilentlyContinue }
    if (-not $process) {
        $process = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($resolved.target + '\', [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    }
    if ($process) { Stop-Process -Id $process.Id -Force }
    $script:serverProcesses.Remove($appId)
}

function Start-Update([int]$appId) {
    Refresh-Job
    if ($script:config.job -and $script:config.job.status -eq 'running') {
        throw 'A SteamCMD job is already running.'
    }
    $app = @($script:config.apps | Where-Object { $_.appId -eq $appId }) | Select-Object -First 1
    if ($null -eq $app) { throw 'App ID is not configured.' }
    Check-Settings $script:config.steamCmdPath $script:config.installRoot
    $resolved = Resolve-AppInstall $appId ([string]$app.folder)
    if ($resolved.folder) { Check-Folder $resolved.folder }

    $root = [IO.Path]::GetFullPath($script:config.installRoot).TrimEnd('\')
    $target = [IO.Path]::GetFullPath($script:config.installRoot)
    if ($resolved.folder) { $target = [IO.Path]::GetFullPath((Join-Path $root $resolved.folder)) }
    if ($target -ne $root -and -not $target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Install folder is outside the configured root.'
    }
    if (Test-Path -LiteralPath $target) {
        $item = Get-Item -LiteralPath $target -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Install folder is a link or junction.'
        }
    }
    $running = Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1
    if ($running) { throw 'A game server in this folder is running. Stop it before updating.' }

    New-Item -ItemType Directory -Path $target -Force | Out-Null
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $jobId = [guid]::NewGuid().ToString('N')
    $out = Join-Path $logDir "$jobId.out.log"
    $err = Join-Path $logDir "$jobId.err.log"
    $args = "+login anonymous +app_update $appId +quit"
    if ($resolved.folder) { $args = "+force_install_dir `"$target`" +login anonymous +app_update $appId +quit" }
    $script:steamProcess = Start-Process -FilePath $script:config.steamCmdPath -ArgumentList $args `
        -WorkingDirectory (Split-Path $script:config.steamCmdPath) -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
    # Keep a process handle so Windows can report ExitCode after it exits.
    $null = $script:steamProcess.Handle
    $script:config.job = [pscustomobject]@{
        id = $jobId; appId = $appId; status = 'running'
        startedAt = (Get-Date).ToUniversalTime().ToString('o')
        finishedAt = $null; output = ''; pid = $script:steamProcess.Id
        stdoutPath = $out; stderrPath = $err; autoFolder = [string]::IsNullOrWhiteSpace([string]$app.folder)
    }
    Save-Config
}

$listener = New-Object Net.HttpListener
$listener.IgnoreWriteExceptions = $true
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "SteamCMD manager listening on http://127.0.0.1:$Port/"
Write-Host "SteamCMD manager version: $ManagerVersion"
Write-Host "Open $AllowedOrigin/game-gallery/server-manager on this Windows machine."
Write-Host "Pairing key: $($script:config.token)"

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        try {
            $request = $context.Request
            $origin = $request.Headers['Origin']
            if ($request.Url.Host -ne '127.0.0.1' -or
                ($origin -and $origin -ne $AllowedOrigin)) {
                Send-Json $context 403 @{ error = 'Origin is not allowed.' }
                continue
            }
            if ($request.HttpMethod -eq 'OPTIONS') {
                if ($origin -ne $AllowedOrigin) {
                    Send-Json $context 403 @{ error = 'Origin is not allowed.' }
                    continue
                }
                $context.Response.Headers['Access-Control-Allow-Origin'] = $AllowedOrigin
                $context.Response.Headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
                $context.Response.Headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Manager-Token'
                $context.Response.Headers['Access-Control-Allow-Private-Network'] = 'true'
                $context.Response.StatusCode = 204
                $context.Response.Close()
                continue
            }
            if ($request.Headers['X-Manager-Token'] -cne $script:config.token) {
                Send-Json $context 401 @{ error = 'Incorrect pairing key.' }
                continue
            }

            $path = $request.Url.AbsolutePath.TrimEnd('/')
            if ($request.HttpMethod -eq 'GET' -and $path -eq '/api/state') {
                Send-Json $context 200 (Public-State)
            } elseif ($request.HttpMethod -eq 'GET' -and $path -eq '/api/browse') {
                $kind = [string]$context.Request.QueryString['kind']
                if ($kind -notin @('folder', 'steamcmd')) { throw 'Invalid browse kind.' }
                $selected = Browse-Path $kind
                Send-Json $context 200 @{ path = $selected }
            } elseif ($request.HttpMethod -eq 'PUT' -and $path -eq '/api/settings') {
                Refresh-Job
                if ($script:config.job -and $script:config.job.status -eq 'running') { throw 'Cannot change folders during an update.' }
                $body = Read-Body $request
                Check-Settings ([string]$body.steamCmdPath) ([string]$body.installRoot)
                $script:config.steamCmdPath = [IO.Path]::GetFullPath([string]$body.steamCmdPath)
                $script:config.installRoot = [IO.Path]::GetFullPath([string]$body.installRoot)
                Save-Config
                Send-Json $context 200 (Public-State)
            } elseif ($request.HttpMethod -eq 'POST' -and $path -eq '/api/apps') {
                $body = Read-Body $request
                $id = [string]$body.appId
                if ($id -notmatch '^[1-9][0-9]{0,9}$' -or [long]$id -gt [int]::MaxValue) { throw 'Invalid App ID.' }
                $appName = ([string]$body.name).Trim()
                $folder = ([string]$body.folder).Trim()
                if ($appName.Length -gt 100) { throw 'Invalid game name.' }
                if ($folder) { Check-Folder $folder }
                $other = @($script:config.apps | Where-Object { $folder -and $_.folder -ieq $folder -and $_.appId -ne [int]$id })
                if ($other.Count -gt 0) { throw 'This folder is already assigned to another App ID.' }
                $script:config.apps = @($script:config.apps | Where-Object { $_.appId -ne [int]$id }) + @([pscustomobject]@{ appId = [int]$id; name = $appName.Trim(); folder = $folder })
                Save-Config
                Send-Json $context 200 (Public-State)
            } elseif ($path -match '^/api/apps/([1-9][0-9]*)$' -and $request.HttpMethod -eq 'DELETE') {
                $id = [int]$Matches[1]
                Refresh-Job
                if ($script:config.job -and $script:config.job.status -eq 'running') { throw 'Cannot delete a configuration during an update.' }
                $script:config.apps = @($script:config.apps | Where-Object { $_.appId -ne $id })
                Save-Config
                Send-Json $context 200 (Public-State)
            } elseif ($path -match '^/api/apps/([1-9][0-9]*)/update$' -and $request.HttpMethod -eq 'POST') {
                Start-Update ([int]$Matches[1])
                Send-Json $context 200 (Public-State)
            } elseif ($path -match '^/api/apps/([1-9][0-9]*)/start$' -and $request.HttpMethod -eq 'POST') {
                Start-Server ([int]$Matches[1])
                Send-Json $context 200 (Public-State)
            } elseif ($path -match '^/api/apps/([1-9][0-9]*)/stop$' -and $request.HttpMethod -eq 'POST') {
                Stop-Server ([int]$Matches[1])
                Send-Json $context 200 (Public-State)
            } elseif ($path -match '^/api/apps/([1-9][0-9]*)/restart$' -and $request.HttpMethod -eq 'POST') {
                Stop-Server ([int]$Matches[1])
                Start-Server ([int]$Matches[1])
                Send-Json $context 200 (Public-State)
            } elseif ($path -match '^/api/apps/([1-9][0-9]*)/config/browse$' -and $request.HttpMethod -eq 'GET') {
                Send-Json $context 200 @{ path = Browse-Config ([int]$Matches[1]) }
            } elseif ($path -match '^/api/apps/([1-9][0-9]*)/config$' -and $request.HttpMethod -eq 'GET') {
                $config = Get-ConfigPath ([int]$Matches[1])
                Send-Json $context 200 @{ file = $config.app.configFile; content = [IO.File]::ReadAllText($config.path, [Text.Encoding]::UTF8) }
            } elseif ($path -match '^/api/apps/([1-9][0-9]*)/config$' -and $request.HttpMethod -eq 'PUT') {
                $config = Get-ConfigPath ([int]$Matches[1])
                $body = Read-Body $request
                if ([string]$body.content -and ([string]$body.content).Length -gt 1048576) { throw 'Configuration file is too large.' }
                [IO.File]::WriteAllText($config.path, [string]$body.content, [Text.UTF8Encoding]::new($false))
                Send-Json $context 200 (Public-State)
            } else {
                Send-Json $context 404 @{ error = 'Unknown endpoint.' }
            }
        } catch {
            Write-Warning $_.Exception.Message
            try { Send-Json $context 400 @{ error = $_.Exception.Message } } catch { }
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
