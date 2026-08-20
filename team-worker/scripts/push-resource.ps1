#requires -Version 5.1
<#
.SYNOPSIS
  在住宅 IP 机器上抓取上游订阅并推送给团队 Worker。
  当上游机场的 WAF 拦截 Cloudflare 机房出口（Worker 直连 403）时使用本脚本。

.EXAMPLE
  powershell -File push-resource.ps1
  默认读取同目录下的 push-resource.config.json（已被 git 忽略）。
#>
param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot 'push-resource.config.json')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "找不到配置文件：$ConfigPath。请复制 push-resource.config.example.json 并填写。"
}
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
foreach ($key in @('subscription_url', 'worker_base_url', 'admin_token')) {
  if (-not $config.PSObject.Properties[$key] -or -not $config.$key) {
    throw "配置文件缺少字段：$key"
  }
}

$tmp = New-TemporaryFile
try {
  # 部分机场面板只对认识的 Clash 客户端 UA 返回配置
  $upstream = Invoke-WebRequest -Uri $config.subscription_url `
    -UserAgent 'clash-verge/v2.4.3' -OutFile $tmp -PassThru -UseBasicParsing

  $headers = @{
    'Authorization' = "Bearer $($config.admin_token)"
  }
  if ($upstream.Headers['subscription-userinfo']) {
    $headers['x-subscription-userinfo'] = $upstream.Headers['subscription-userinfo']
  }
  if ($upstream.Headers['content-disposition']) {
    $headers['x-content-disposition'] = $upstream.Headers['content-disposition']
  }

  $workerUrl = "$($config.worker_base_url.TrimEnd('/'))/v1/admin/resource"
  $result = Invoke-RestMethod -Method Put -Uri $workerUrl -Headers $headers `
    -InFile $tmp -ContentType 'application/yaml' -UseBasicParsing
  Write-Host "pushed $($result.bytes) bytes, etag $($result.etag)"
} finally {
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}