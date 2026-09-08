param([Parameter(Mandatory = $true)][string] $Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This test runs only in the isolated GitHub Actions runner.' }

function Show-ZhijiProcesses {
    param([string] $Label)
    $procs = @(Get-Process -Name zhiji -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) { Write-Output "Diagnostics: no zhiji process ($Label)"; return }
    foreach ($p in $procs) {
        Write-Output "Diagnostics: zhiji process ($Label) id=$($p.Id) title='$($p.MainWindowTitle)' handle=$($p.MainWindowHandle) ws=$($p.WorkingSet64)"
    }
}

function Show-WebView2Runtime {
    $paths = @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    )
    foreach ($p in $paths) {
        if (Test-Path -LiteralPath $p) {
            $item = Get-ItemProperty -LiteralPath $p -ErrorAction SilentlyContinue
            Write-Output "Diagnostics: WebView2 runtime $p version=$($item.pv)"
        } else {
            Write-Output "Diagnostics: WebView2 runtime missing at $p"
        }
    }
    $webviewProcs = @(Get-Process -Name msedgewebview2 -ErrorAction SilentlyContinue)
    Write-Output "Diagnostics: msedgewebview2 process count = $($webviewProcs.Count)"
}

function Show-TraceLogs {
    param([string] $InstallDir)
    $traces = @(Get-ChildItem -LiteralPath $InstallDir -Filter 'zhiji-close-trace-*.log' -File -ErrorAction SilentlyContinue | Sort-Object Name)
    if ($traces.Count -eq 0) {
        Write-Output 'Diagnostics: no zhiji-close-trace log was written (app never reached setup)'
        return
    }
    foreach ($trace in $traces) {
        Write-Output "Diagnostics: $($trace.Name) ($($trace.Length) bytes)"
        Get-Content -LiteralPath $trace.FullName -ErrorAction SilentlyContinue
    }
}

$taskInstaller = (Resolve-Path -LiteralPath $Installer).Path
$taskLogs = Join-Path $PWD '.tmp/native-window'
New-Item -ItemType Directory -Force -Path $taskLogs | Out-Null
$taskInstallDir = Join-Path $env:RUNNER_TEMP "zhiji-smoke-$([Guid]::NewGuid().ToString('N'))"
# Exercise the delivered installer, including its WebView2 prerequisite setup.
# NSIS requires /D last and handles the remaining path as one argument.
$taskSetup = Start-Process -FilePath $taskInstaller -ArgumentList @('/S', "/D=$taskInstallDir") -WindowStyle Hidden -PassThru
if (-not $taskSetup.WaitForExit(180000)) {
    Stop-Process -Id $taskSetup.Id -Force
    throw 'Candidate installation timed out.'
}
if ($taskSetup.ExitCode -notin @(0, 3010)) { throw "Candidate installation failed: $($taskSetup.ExitCode)" }
$taskExe = (Resolve-Path -LiteralPath (Join-Path $taskInstallDir 'zhiji.exe')).Path
Write-Output "PASS: candidate installed successfully at $taskExe"

# A silent NSIS run may leave an auto-launched instance behind; it would own the
# window the close test is about to hit, so report and remove it first.
Show-ZhijiProcesses -Label 'before start'
Get-Process -Name zhiji -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Output "Removing pre-existing zhiji process $($_.Id)"
    Stop-Process -Id $_.Id -Force
}
Start-Sleep -Seconds 1

# The GUI under test must be visible in the disposable Windows runner.
$taskApp = Start-Process -FilePath $taskExe -WorkingDirectory $taskInstallDir -PassThru `
    -RedirectStandardOutput (Join-Path $taskLogs 'stdout.log') `
    -RedirectStandardError (Join-Path $taskLogs 'stderr.log')
try {
    Write-Output "Started zhiji with PID $($taskApp.Id)"
    $taskDeadline = (Get-Date).AddSeconds(60)
    $taskLastTitle = ''
    do {
        Start-Sleep -Milliseconds 300
        $taskApp.Refresh()
        if ($taskApp.HasExited) { throw "App exited during startup: $($taskApp.ExitCode)" }
        if ($taskApp.MainWindowTitle -ne $taskLastTitle) {
            $taskLastTitle = $taskApp.MainWindowTitle
            Write-Output "Observed window: $taskLastTitle"
        }
    } while (($taskApp.MainWindowHandle -eq [IntPtr]::Zero -or $taskApp.MainWindowTitle -ne '知记 - 个人工作台') -and (Get-Date) -lt $taskDeadline)
    if ($taskApp.MainWindowTitle -ne '知记 - 个人工作台') {
        throw "Expected workbench window did not appear; observed: $($taskApp.MainWindowTitle)"
    }

    # The close handler lives in the frontend, so the close request is only
    # meaningful once the webview has mounted and registered its listener.
    $taskReady = $false
    $taskReadyDeadline = (Get-Date).AddSeconds(60)
    while (-not $taskReady -and (Get-Date) -lt $taskReadyDeadline) {
        foreach ($taskTrace in @(Get-ChildItem -LiteralPath $taskInstallDir -Filter 'zhiji-close-trace-*.log' -File -ErrorAction SilentlyContinue)) {
            if ((Get-Content -LiteralPath $taskTrace.FullName -ErrorAction SilentlyContinue) -match 'JS close listener registered') {
                $taskReady = $true
                break
            }
        }
        if (-not $taskReady) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $taskReady) {
        Show-ZhijiProcesses -Label 'frontend not ready'
        Show-WebView2Runtime
        Show-TraceLogs -InstallDir $taskInstallDir
        throw 'Frontend never registered the close listener; the webview did not run the app shell.'
    }
    Write-Output 'PASS: frontend registered the close listener'

    Start-Sleep -Seconds 2
    $taskApp.Refresh()
    if ($taskApp.HasExited) { throw "App exited before the close test: $($taskApp.ExitCode)" }
    Show-ZhijiProcesses -Label 'before close'
    Write-Output "Closing actual workbench: PID $($taskApp.Id), HWND $($taskApp.MainWindowHandle)"
    if (-not $taskApp.CloseMainWindow()) { throw 'Windows could not send the close request.' }
    $taskDeadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 300
        $taskApp.Refresh()
        if ($taskApp.HasExited) { throw "Closing the window terminated the app: $($taskApp.ExitCode)" }
    } while ($taskApp.MainWindowHandle -ne [IntPtr]::Zero -and (Get-Date) -lt $taskDeadline)
    if ($taskApp.MainWindowHandle -ne [IntPtr]::Zero) { throw 'Main window remained visible after the close request.' }
    Write-Output "Window hidden; observing background survival for 3s (handle=$($taskApp.MainWindowHandle))"
    Start-Sleep -Seconds 3
    $taskApp.Refresh()
    if ($taskApp.HasExited) { throw "App exited after hiding: $($taskApp.ExitCode)" }
    Write-Output 'PASS: installed app hides its main window and continues running after native close.'
} finally {
    # Cleanup must never throw: a failing Stop-Process used to abort the finally
    # block before the trace logs were dumped, hiding the real failure reason.
    try {
        $taskApp.Refresh()
        if (-not $taskApp.HasExited) { Stop-Process -Id $taskApp.Id -Force -ErrorAction SilentlyContinue }
    } catch { }
    Get-Process -Name zhiji -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    # Deep diagnostics: the redirected app logs explain which close path ran.
    Get-ChildItem -LiteralPath $taskLogs -File -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Output "Diagnostics: $($_.Name) ($($_.Length) bytes)"
        Get-Content -LiteralPath $_.FullName -ErrorAction SilentlyContinue
    }
    # The Rust close-trace file lives next to the installed exe (GUI subsystem
    # stderr does not reach the redirected log files on the runner).
    Show-TraceLogs -InstallDir $taskInstallDir
    Show-ZhijiProcesses -Label 'after cleanup'
}
