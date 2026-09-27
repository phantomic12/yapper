# Kill any Chrome process using a yapper e2e temp profile and clean up profiles.
# Safe: matches only processes whose command line names a yapper-e2e-profile dir.
$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*yapper-e2e-profile*' }
Write-Output ("matches: " + @($procs).Count)
foreach ($p in $procs) {
  Write-Output ("killing " + $p.ProcessId + " " + $p.Name)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3
Get-ChildItem "$env:TEMP" -Directory -Filter 'yapper-e2e-profile.*' -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
    Write-Output ("removed " + $_.Name)
  } catch {
    Write-Output ("still locked: " + $_.Name)
  }
}
