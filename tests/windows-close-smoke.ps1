param([Parameter(Mandatory = $true)][string] $Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This test runs only in the isolated GitHub Actions runner.' }
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
# The GUI under test must be visible in the disposable Windows runner.
$taskApp = Start-Process -FilePath $taskExe -WorkingDirectory $taskInstallDir -PassThru `
    -RedirectStandardOutput (Join-Path $taskLogs 'stdout.log') `
    -RedirectStandardError (Join-Path $taskLogs 'stderr.log')
try {
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
    Start-Sleep -Seconds 2
    $taskApp.Refresh()
    if ($taskApp.HasExited) { throw "App exited before the close test: $($taskApp.ExitCode)" }
    Write-Output "Closing actual workbench: PID $($taskApp.Id), HWND $($taskApp.MainWindowHandle)"
    if (-not $taskApp.CloseMainWindow()) { throw 'Windows could not send the close request.' }
    $taskDeadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 300
        $taskApp.Refresh()
        if ($taskApp.HasExited) { throw "Closing the window terminated the app: $($taskApp.ExitCode)" }
    } while ($taskApp.MainWindowHandle -ne [IntPtr]::Zero -and (Get-Date) -lt $taskDeadline)    if ($taskApp.MainWindowHandle -ne [IntPtr]::Zero) { throw 'Main window remained visible after the close request.' }
    Start-Sleep -Seconds 3
    $taskApp.Refresh()
    if ($taskApp.HasExited) { throw "App exited after hiding: $($taskApp.ExitCode)" }
    Write-Output 'PASS: installed app hides its main window and continues running after native close.'
} finally {
    $taskApp.Refresh()
    if (-not $taskApp.HasExited) { Stop-Process -Id $taskApp.Id -Force }
    # Deep diagnostics: the redirected app logs explain which close path ran.
    Get-ChildItem -LiteralPath $taskLogs -File | ForEach-Object {
        Write-Output "Diagnostics: $($_.Name) ($($_.Length) bytes)"
        Get-Content -LiteralPath $_.FullName -ErrorAction SilentlyContinue
    }
}
