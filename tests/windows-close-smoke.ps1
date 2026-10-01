param([Parameter(Mandatory = $true)][string] $Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This test runs only in the isolated GitHub Actions runner.' }
# The app only writes its close-trace log when this is set, so the frontend
# readiness gate below has something to read without polluting normal installs.
$env:ZHIJI_CLOSE_TRACE = '1'

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

# Process.MainWindowHandle memoises the first handle it resolves and Refresh()
# does not clear that cache, so it keeps reporting the pre-close handle even
# after the app hides the window. Ask Win32 directly instead.
$script:ZhijiUser32 = $null
try {
    $script:ZhijiUser32 = Add-Type -Namespace ZhijiSmoke -Name User32 -PassThru -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr hWnd, int index);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsZoomed(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr hWnd, uint message, System.IntPtr wParam, System.IntPtr lParam);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out Rect rect);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr after, int x, int y, int width, int height, uint flags);
'@ | Where-Object FullName -eq 'ZhijiSmoke.User32'
} catch {
    Write-Output "Diagnostics: user32 P/Invoke unavailable ($_); falling back to Process.MainWindowHandle"
}

function Test-ZhijiWindowVisible {
    param([IntPtr] $Handle, [int] $ProcessId)
    if ($script:ZhijiUser32) { return $script:ZhijiUser32::IsWindowVisible($Handle) }
    $fresh = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    return [bool]($fresh -and $fresh.MainWindowHandle -ne [IntPtr]::Zero)
}

function Test-ZhijiWindowExists {
    param([IntPtr] $Handle)
    if ($script:ZhijiUser32) { return $script:ZhijiUser32::IsWindow($Handle) }
    return $true
}

function Wait-ZhijiWindowState {
    param([IntPtr] $Handle, [ValidateSet('maximized', 'minimized', 'restored')][string] $State)
    $deadline = (Get-Date).AddSeconds(10)
    do {
        $maximized = $script:ZhijiUser32::IsZoomed($Handle)
        $minimized = $script:ZhijiUser32::IsIconic($Handle)
        $matches = switch ($State) {
            'maximized' { $maximized -and -not $minimized }
            'minimized' { $minimized }
            'restored' { -not $maximized -and -not $minimized }
        }
        if ($matches -and $script:ZhijiUser32::IsWindowVisible($Handle)) { return }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    throw "Window did not enter the expected $State state."
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
    # Capture the native handle once: Process.MainWindowHandle memoises the first
    # value it resolves and Refresh() does not clear it, so it keeps reporting the
    # pre-close handle even after the app hides the window.
    $taskHwnd = $taskApp.MainWindowHandle
    if (-not $script:ZhijiUser32) { throw 'Win32 inspection is required to verify standard window controls.' }
    $taskStyle = $script:ZhijiUser32::GetWindowLong($taskHwnd, -16)
    # WS_CAPTION, WS_SYSMENU, WS_THICKFRAME, WS_MINIMIZEBOX, WS_MAXIMIZEBOX.
    foreach ($taskFlag in @(0x00C00000, 0x00080000, 0x00040000, 0x00020000, 0x00010000)) {
        if (($taskStyle -band $taskFlag) -ne $taskFlag) { throw "Standard window style missing: $taskFlag (style $taskStyle)." }
    }
    # WM_SYSCOMMAND drives the same native operations as the caption controls.
    foreach ($taskTransition in @(@{ Command = 0xF030; State = 'maximized' }, @{ Command = 0xF120; State = 'restored' }, @{ Command = 0xF020; State = 'minimized' }, @{ Command = 0xF120; State = 'restored' })) {
        if (-not $script:ZhijiUser32::PostMessage($taskHwnd, 0x0112, [IntPtr]$taskTransition.Command, [IntPtr]::Zero)) { throw 'Could not send system window command.' }
        Wait-ZhijiWindowState -Handle $taskHwnd -State $taskTransition.State
    }
    $taskRect = New-Object 'ZhijiSmoke.User32+Rect'
    if (-not $script:ZhijiUser32::GetWindowRect($taskHwnd, [ref]$taskRect)) { throw 'Cannot read original window size.' }
    $taskOriginalWidth = $taskRect.Right - $taskRect.Left
    $taskOriginalHeight = $taskRect.Bottom - $taskRect.Top
    if (-not $script:ZhijiUser32::SetWindowPos($taskHwnd, [IntPtr]::Zero, 0, 0, 1000, 650, 0x0016)) { throw 'Cannot resize window.' }
    Start-Sleep -Milliseconds 500
    if (-not $script:ZhijiUser32::GetWindowRect($taskHwnd, [ref]$taskRect)) { throw 'Cannot read resized window.' }
    if (($taskRect.Right - $taskRect.Left) -ne 1000 -or ($taskRect.Bottom - $taskRect.Top) -ne 650) { throw 'Window did not accept the requested size.' }
    if (-not $script:ZhijiUser32::SetWindowPos($taskHwnd, [IntPtr]::Zero, 0, 0, $taskOriginalWidth, $taskOriginalHeight, 0x0016)) { throw 'Cannot restore original window size.' }
    Write-Output 'PASS: native caption, system menu, maximize/restore, minimize/restore and resizing.'
    Write-Output "Closing actual workbench: PID $($taskApp.Id), HWND $taskHwnd"
    if (-not $taskApp.CloseMainWindow()) { throw 'Windows could not send the close request.' }
    $taskHidden = $false
    $taskDeadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 300
        $taskApp.Refresh()
        if ($taskApp.HasExited) { throw "Closing the window terminated the app: $($taskApp.ExitCode)" }
        $taskHidden = -not (Test-ZhijiWindowVisible -Handle $taskHwnd -ProcessId $taskApp.Id)
    } while (-not $taskHidden -and (Get-Date) -lt $taskDeadline)
    if (-not $taskHidden) {
        Write-Output "Diagnostics: stale Process.MainWindowHandle = $($taskApp.MainWindowHandle)"
        throw "Main window remained visible after the close request (HWND $taskHwnd)."
    }
    # Hidden is not the same as destroyed: the window must still exist so it can
    # be restored from the tray or with the global shortcut.
    if (-not (Test-ZhijiWindowExists -Handle $taskHwnd)) {
        throw "Main window was destroyed instead of hidden (HWND $taskHwnd)."
    }
    Write-Output "Window hidden (HWND $taskHwnd still alive); observing background survival for 3s"
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
