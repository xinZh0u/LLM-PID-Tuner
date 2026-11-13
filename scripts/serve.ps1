# 极简静态服务器（不依赖 node/python），仅监听本机回环地址。
# 用法:  powershell -ExecutionPolicy Bypass -File .\scripts\serve.ps1 [-Port 5173]
param([int]$Port = 5173)

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "LLM Tuner Console  ->  http://localhost:$Port" -ForegroundColor Green
Write-Host "按 Ctrl+C 停止"

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 4096, $true)
    $requestLine = $reader.ReadLine()
    if ([string]::IsNullOrWhiteSpace($requestLine)) { $client.Close(); continue }
    while ($true) {
      $h = $reader.ReadLine()
      if ([string]::IsNullOrEmpty($h)) { break }
    }

    $target = $requestLine.Split(' ')[1]
    $target = $target.Split('?')[0]
    $target = [uri]::UnescapeDataString($target)
    if ($target -eq '/' -or $target -eq '') { $target = '/index.html' }

    $rel = $target.TrimStart('/', '\') -replace '/', '\'
    $file = [System.IO.Path]::GetFullPath((Join-Path $root $rel))

    $status = '200 OK'
    $body = $null
    $ctype = 'application/octet-stream'
    if ($file.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $file -PathType Leaf)) {
      $body = [System.IO.File]::ReadAllBytes($file)
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      if ($mime.ContainsKey($ext)) { $ctype = $mime[$ext] }
    } else {
      $status = '404 Not Found'
      $body = [System.Text.Encoding]::UTF8.GetBytes('404 ' + $target)
      $ctype = 'text/plain; charset=utf-8'
    }

    $head = "HTTP/1.1 $status`r`nContent-Type: $ctype`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
    $stream.Write($hb, 0, $hb.Length)
    $stream.Write($body, 0, $body.Length)
    $stream.Flush()
  } catch {
    Write-Host "request error: $($_.Exception.Message)" -ForegroundColor DarkYellow
  } finally {
    $client.Close()
  }
}
