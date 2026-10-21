# BlendGuard - HTTPS certificate for the plant network.
#
# Run once on the SERVER PC, in PowerShell, from the BlendGuard folder:
#     powershell -ExecutionPolicy Bypass -File scripts\make-certificate.ps1
#
# It makes a certificate for this PC's name (and its LAN addresses), saves it in
# data\tls, and switches BlendGuard to HTTPS in .env. Then:
#   - every station PC must trust it once:  run INSTALL-CERTIFICATE.bat there
#     (copy data\tls\blendguard.cer next to it), as administrator;
#   - stations open https://<this-pc-name>:4300  (set SERVER in START-STATION.bat).
# Fingerprint / face sign-in needs the NAME, not the IP address.
# If the plant has its own certificate authority, use a certificate from it
# instead: put its .pfx in data\tls and set TLS_PFX / TLS_PFX_PASSWORD in .env.

param(
  [string[]]$Names = @(),
  [int]$Years = 5
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tls = Join-Path $root 'data\tls'
New-Item -ItemType Directory -Force $tls | Out-Null

$host_ = $env:COMPUTERNAME.ToLower()
$fqdn = try { [System.Net.Dns]::GetHostEntry('').HostName.ToLower() } catch { $host_ }
$dns = @($host_, $fqdn, 'localhost') + $Names | Where-Object { $_ } | Select-Object -Unique
$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress
$san = (($dns | ForEach-Object { "DNS=$_" }) + ($ips | ForEach-Object { "IPAddress=$_" })) -join '&'

Write-Host "`n  Making a certificate for: $($dns -join ', ') $($ips -join ', ')`n"
$cert = New-SelfSignedCertificate -Subject "CN=$host_ BlendGuard" -FriendlyName 'BlendGuard' `
  -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears($Years) `
  -TextExtension @("2.5.29.17={text}$san", '2.5.29.37={text}1.3.6.1.5.5.7.3.1', '2.5.29.19={text}CA=false')

$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = [Convert]::ToBase64String($bytes) -replace '[+/=]', ''
$secure = ConvertTo-SecureString $password -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath (Join-Path $tls 'blendguard.pfx') -Password $secure | Out-Null
Export-Certificate -Cert $cert -FilePath (Join-Path $tls 'blendguard.cer') | Out-Null
Remove-Item -Path "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey

# Switch BlendGuard to HTTPS (.env keeps everything else as it was).
$envFile = Join-Path $root '.env'
$port = 4300
$lines = if (Test-Path $envFile) { Get-Content $envFile } else { @() }
$m = $lines | Select-String '^PORT=(\d+)' | Select-Object -First 1
if ($m) { $port = $m.Matches[0].Groups[1].Value }
$set = [ordered]@{
  'TLS_PFX'          = 'data/tls/blendguard.pfx'
  'TLS_PFX_PASSWORD' = $password
  'WEBAUTHN_RP_ID'   = $host_
  'WEBAUTHN_ORIGINS' = "https://${host_}:$port,https://${fqdn}:$port,https://localhost:$port"
}
foreach ($k in $set.Keys) {
  $lines = @($lines | Where-Object { $_ -notmatch "^#?\s*$k=" })
  $lines += "$k=$($set[$k])"
}
Set-Content -Path $envFile -Value $lines -Encoding UTF8

# This PC trusts it too (Windows asks for confirmation).
Import-Certificate -FilePath (Join-Path $tls 'blendguard.cer') -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null

Write-Host "  Done. Restart BlendGuard; it now runs on https://${host_}:$port"
Write-Host "  On each station PC: copy data\tls\blendguard.cer and INSTALL-CERTIFICATE.bat, run it as administrator,"
Write-Host "  and set SERVER=https://${host_}:$port in START-STATION.bat.`n"
