param([Parameter(Mandatory = $true)][string] $Executable)
$ErrorActionPreference = 'Stop'
# CI-only smoke test against the actual Windows executable, not mocked IPC.
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This test runs only in the isolated GitHub Actions runner.' }
$taskExe = (Resolve-Path -LiteralPath $Executable).Path
# This is the GUI under test in the disposable runner, not a local background helper.
# It must create a visible window so the test can prove closing transitions it to hidden.
$taskApp = Start-Process -FilePath $taskExe -PassThru
try {
    $taskDeadline = (Get-Date).AddSeconds(45)
    do {
        Start-Sleep -Milliseconds 300
        $taskApp.Refresh()
        if ($taskApp.HasExited) { throw "App exited during startup: $($taskApp.ExitCode)" }
    } while ($taskApp.MainWindowHandle -eq [IntPtr]::Zero -and (Get-Date) -lt $taskDeadline)
    if ($taskApp.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Main application window did not appear.' }
    if (-not $taskApp.CloseMainWindow()) { throw 'Windows could not send the close request.' }
    $taskDeadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 300
        $taskApp.Refresh()
        if ($taskApp.HasExited) { throw 'Closing the window terminated the application instead of keeping it in the tray.' }
    } while ($taskApp.MainWindowHandle -ne [IntPtr]::Zero -and (Get-Date) -lt $taskDeadline)
    if ($taskApp.MainWindowHandle -ne [IntPtr]::Zero) { throw 'Main window remained visible after the close request.' }
    Write-Output 'PASS: native Windows close request hides the main window and preserves the app process.'
} finally {
    $taskApp.Refresh()
    if (-not $taskApp.HasExited) { Stop-Process -Id $taskApp.Id -Force }
}
