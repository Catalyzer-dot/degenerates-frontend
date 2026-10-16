param(
    [string]$AllowedOrigin = 'https://degenerates.site',
    [int]$Port = 17864
)

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $PSScriptRoot 'steamcmd-manager.json'
$logDir = Join-Path $PSScriptRoot 'steamcmd-manager-logs'
$script:steamProcess = $null

function Save-Config {
    $json = $script:config | ConvertTo-Json -Depth 8
    $tmp = "$configPath.tmp"
    [IO.File]::WriteAllText($tmp, $json, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $configPath) {
        [IO.File]::Replace($tmp, $configPath, $null)
    } else {
        [IO.File]::Move($tmp, $configPath)
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
    $script:config = [pscustomobject]@{
        token = $token
        steamCmdPath = 'C:\Users\Administrator\Downloads\steamcmd\steamcmd.exe'
        installRoot = 'C:\Users\Administrator\Downloads\steamcmd\steamapps\common'
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
        $marker = "Success! App '$($job.appId)' fully installed."
        if ($exitCode -eq 0 -and $job.output.Contains($marker)) {
            $job.status = 'succeeded'
        } else {
            $job.status = 'failed'
            $job.output += "`nSteamCMD exit code: $exitCode"
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
        steamCmdPath = $script:config.steamCmdPath
        installRoot = $script:config.installRoot
        apps = @($script:config.apps)
        job = $job
    }
}

function Send-Json($context, [int]$status, $value) {
    $response = $context.Response
    $response.StatusCode = $status
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
    if ($request.ContentLength64 -gt 4096) { throw 'Request body is too large.' }
    $reader = New-Object IO.StreamReader($request.InputStream, [Text.Encoding]::UTF8)
    $body = $reader.ReadToEnd()
    if ($body.Length -gt 4096) { throw 'Request body is too large.' }
    if ([string]::IsNullOrWhiteSpace($body)) { throw 'Request body is empty.' }
    return $body | ConvertFrom-Json
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

function Start-Update([int]$appId) {
    Refresh-Job
    if ($script:config.job -and $script:config.job.status -eq 'running') {
        throw 'A SteamCMD job is already running.'
    }
    $app = @($script:config.apps | Where-Object { $_.appId -eq $appId }) | Select-Object -First 1
    if ($null -eq $app) { throw 'App ID is not configured.' }
    Check-Settings $script:config.steamCmdPath $script:config.installRoot
    Check-Folder $app.folder

    $root = [IO.Path]::GetFullPath($script:config.installRoot).TrimEnd('\')
    $target = [IO.Path]::GetFullPath((Join-Path $root $app.folder))
    if (-not $target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
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
    $args = "+force_install_dir `"$target`" +login anonymous +app_update $appId +quit"
    $script:steamProcess = Start-Process -FilePath $script:config.steamCmdPath -ArgumentList $args `
        -WorkingDirectory (Split-Path $script:config.steamCmdPath) -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
    $script:config.job = [pscustomobject]@{
        id = $jobId; appId = $appId; status = 'running'
        startedAt = (Get-Date).ToUniversalTime().ToString('o')
        finishedAt = $null; output = ''; pid = $script:steamProcess.Id
        stdoutPath = $out; stderrPath = $err
    }
    Save-Config
}

$listener = New-Object Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "SteamCMD manager listening on http://127.0.0.1:$Port/"
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
                $appName = [string]$body.name
                $folder = [string]$body.folder
                if ([string]::IsNullOrWhiteSpace($appName) -or $appName.Length -gt 100) { throw 'Invalid game name.' }
                Check-Folder $folder
                $other = @($script:config.apps | Where-Object { $_.folder -ieq $folder -and $_.appId -ne [int]$id })
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
