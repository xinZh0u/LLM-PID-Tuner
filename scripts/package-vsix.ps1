# 打包 .vsix（不需要 npm / vsce，用 VS Code 自带的 Electron 当 Node 用）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$code = @(
  "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe",
  "$env:ProgramFiles\Microsoft VS Code\Code.exe",
  "${env:ProgramFiles(x86)}\Microsoft VS Code\Code.exe",
  "$env:LOCALAPPDATA\Programs\cursor\Cursor.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $code) {
  throw "没有找到 VS Code（Code.exe），请手动执行: `$env:ELECTRON_RUN_AS_NODE=1; node scripts/package-vsix.js"
}

Write-Host "使用 Node 运行时: $code"
$env:ELECTRON_RUN_AS_NODE = '1'
& $code (Join-Path $root 'scripts\package-vsix.js')

$vsix = Join-Path $root 'llm-tuner-0.1.0.vsix'
if (Test-Path $vsix) {
  $kb = [math]::Round((Get-Item $vsix).Length / 1KB, 1)
  Write-Host "`n生成: $vsix ($kb KB)" -ForegroundColor Green
  Write-Host "安装: code --install-extension `"$vsix`""
} else {
  throw '打包失败'
}
