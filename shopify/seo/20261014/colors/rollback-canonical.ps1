param([Parameter(Mandatory=$true)][string]$ThemeId)
$ErrorActionPreference = 'Stop'
if ($ThemeId -notmatch '^\d+$') { throw 'Invalid theme ID' }
$rollbackDir = Join-Path ([System.IO.Path]::GetTempPath()) ('toptik-canonical-rollback-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $rollbackDir | Out-Null
& shopify theme pull --store toptikcoil.myshopify.com --theme $ThemeId --path $rollbackDir --only layout/theme.liquid
if ($LASTEXITCODE -ne 0) { throw 'Theme pull failed; nothing uploaded' }
$layoutPath = Join-Path $rollbackDir 'layout/theme.liquid'
$text = [System.IO.File]::ReadAllText($layoutPath)
$marker = '  {% comment %}Only direct product pages; preserve collection-path, tag and explicit variant alternates.{% endcomment %}'
$ending = '  <link rel="canonical" href="{{ tt_effective_canonical_url }}">'
$start = $text.IndexOf($marker)
if ($start -lt 0 -or $text.IndexOf($marker, $start + 1) -ge 0) { throw 'Expected exactly one reviewed canonical block; nothing uploaded' }
$end = $text.IndexOf($ending, $start)
if ($end -lt 0) { throw 'Canonical boundary not found; nothing uploaded' }
$block = $text.Substring($start, $end - $start).Replace("`r`n", "`n")
$expectedPath = Join-Path $PSScriptRoot 'canonical-block.txt'
$expected = [System.IO.File]::ReadAllText($expectedPath).Replace("`r`n", "`n")
if ($block -cne $expected) { throw 'Canonical block changed since review; nothing uploaded' }
[System.IO.File]::WriteAllText($layoutPath, $text.Remove($start, $end - $start), (New-Object System.Text.UTF8Encoding($false)))
& shopify theme push --store toptikcoil.myshopify.com --theme $ThemeId --path $rollbackDir --only layout/theme.liquid --allow-live
if ($LASTEXITCODE -ne 0) { throw 'Upload failed; inspect Shopify before retrying' }
Write-Output 'Canonical override removed. Verify live canonical tags. Other changes preserved.'
