param(
    [Parameter(Mandatory)][string]$Manifest,
    [Parameter(Mandatory)][string]$PreviousZip,
    [string]$SspRoot,
    [string]$YayaMaster
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$manifestPath = (Resolve-Path -LiteralPath $Manifest).Path
$previousPath = (Resolve-Path -LiteralPath $PreviousZip).Path
$releaseDir = Split-Path -Parent $manifestPath
$files = (Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).files
$portable = $files | Where-Object { $_.path -match '^TIARA-portable-\d+\.\d+\.\d+\.zip$' }
$ssp = $files | Where-Object { $_.path -match '^TIARA-ssp-\d+\.\d+\.\d+\.zip$' }
if (@($files).Count -ne 2 -or @($portable).Count -ne 1 -or @($ssp).Count -ne 1) {
    throw 'The release manifest must contain one portable and one public SSP archive.'
}
if ([bool]$SspRoot -ne [bool]$YayaMaster) { throw 'Provide both SspRoot and YayaMaster for the SSP runtime check.' }
foreach ($entry in $files) {
    $file = Join-Path $releaseDir $entry.path
    if ((Get-Item -LiteralPath $file).Length -ne $entry.size -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $entry.sha256) {
        throw "ZIP integrity check failed: $($entry.path)"
    }
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('tiara-release-check-' + [guid]::NewGuid().ToString('N'))
$old = Join-Path $work 'previous'
$current = Join-Path $work 'current'
$sspInstall = Join-Path $work 'ssp'
New-Item -Path $work -ItemType Directory | Out-Null
[IO.Compression.ZipFile]::ExtractToDirectory($previousPath, $old)
[IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $releaseDir $portable.path), $current)
$oldVersion = (Get-Content -LiteralPath (Join-Path $old 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$version = (Get-Content -LiteralPath (Join-Path $current 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($oldVersion -eq $version) { throw 'The migration test requires an older release.' }
Write-Output "Release check workspace: $work"

function Start-IsolatedPet($root, $expected, [scriptblock]$check) {
    $exe = Join-Path $root 'pet/Pet.exe'
    $pet = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru
    try {
        $origin = $null
        $portFile = Join-Path $root 'cache/panel_port.txt'
        for ($attempt = 0; $attempt -lt 50; $attempt++) {
            if ($pet.HasExited) { throw "Pet $expected stopped before startup." }
            try {
                $port = [int](Get-Content -LiteralPath $portFile)
                $candidate = "http://127.0.0.1:$port"
                $health = Invoke-RestMethod "$candidate/api/health" -TimeoutSec 1
                if ($health.app -eq 'tiara' -and $health.version -eq $expected) { $origin = $candidate; break }
            } catch {}
            Start-Sleep -Milliseconds 250
        }
        if (!$origin) { throw "No bundled web service for $expected." }
        if ((Invoke-WebRequest $origin -UseBasicParsing).StatusCode -ne 200) { throw 'Panel failed to load.' }
        & $check $origin
    } finally {
        if (!$pet.HasExited) {
            Start-Process -FilePath $exe -WorkingDirectory $root -ArgumentList '--quit' -WindowStyle Hidden -Wait
            if (!$pet.WaitForExit(5000)) {
                Stop-Process -Id $pet.Id -ErrorAction SilentlyContinue
                throw "Pet $expected did not exit cleanly."
            }
        }
    }
}

function Post-Json($origin, $route, $value) {
    $body = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Depth 90 -Compress))
    Invoke-RestMethod ($origin + $route) -Method Post -Headers @{ Origin = $origin } -ContentType 'application/json; charset=utf-8' -Body $body
}

function Assert-EmptySnapshot($file) {
    $snapshot = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($key in 'today', 'all_shows', 'behind', 'catchup', 'reminders') {
        if (@($snapshot.$key | Where-Object { $_ }).Count -gt 0) { throw "Public snapshot has unexpected data in $key." }
    }
}

$publicData = Get-ChildItem -LiteralPath (Join-Path $current 'data') -File -Recurse | ForEach-Object { $_.Name }
if (@(Compare-Object @('library.json','settings.json','talks.json','today.json') $publicData).Count -gt 0) {
    throw 'Unexpected files in public portable data.'
}
Assert-EmptySnapshot (Join-Path $current 'data/today.json')
$ghostRoot = Join-Path $sspInstall 'ghost/tiara-yaya'
New-Item -Path (Split-Path -Parent $ghostRoot) -ItemType Directory -Force | Out-Null
[IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $releaseDir $ssp.path), $ghostRoot)
Assert-EmptySnapshot (Join-Path $ghostRoot 'ghost/master/today.json')
if (!(Test-Path -LiteralPath (Join-Path $ghostRoot 'install.txt'))) { throw 'Public SSP install metadata is missing.' }
if (Get-ChildItem -LiteralPath $ghostRoot -Recurse -File | Where-Object { $_.Name -match 'bgm\.json|state\.json|history|\.bak' }) {
    throw 'Unexpected private files in public SSP.'
}

$savedPath = $env:Path
$savedBase = $env:BGM_BASE
$savedProxy = $env:BGM_PROXY
$env:Path = "$env:SystemRoot\System32;$env:SystemRoot"
$env:BGM_BASE = 'http://127.0.0.1:1'
$env:BGM_PROXY = ''
$token = 'tiara-release-check-token'
Set-Content -LiteralPath (Join-Path $old 'data/bgm.json') -Value ('{"token":"' + $token + '"}') -Encoding UTF8
try {
    if (Get-Command node.exe -ErrorAction SilentlyContinue) { throw 'The runtime isolation PATH still exposes node.exe.' }
    $export = Start-IsolatedPet $old $oldVersion {
        param($origin)
        $created = Post-Json $origin '/api/watch/detail' @{ name = 'Release fixture'; ep_status = 0; eps = 12; watch_mode = 'catchup' }
        if (!$created.detail.id) { throw 'Old version could not add an offline title.' }
        $null = Post-Json $origin '/api/progress' @{ id = $created.detail.id; delta = 1 }
        (Invoke-RestMethod "$origin/api/migration").migration
    }
    if (!$export.library.watching -or ($export | ConvertTo-Json -Depth 90 -Compress).Contains($token)) {
        throw 'The old exported fixture is missing data or contains credentials.'
    }
    $target = ($export.library.watching | Where-Object { $_.name_cn -eq 'Release fixture' }).id
    Start-IsolatedPet $current $version {
        param($origin)
        $preview = Post-Json $origin '/api/migration' @{ migration = $export; preview = $true }
        if (!$preview.ok -or $preview.incoming.history -lt 1) { throw 'Migration preview lost viewing history.' }
        $restored = Post-Json $origin '/api/migration' @{ migration = $export; source = $preview.source; target = $preview.target }
        if (!$restored.ok) { throw 'Old backup could not be restored.' }
        $detail = Invoke-RestMethod "$origin/api/watch/detail?id=$target"
        if ($detail.detail.ep_status -ne 1) { throw 'Old progress was lost.' }
        $null = Post-Json $origin '/api/progress' @{ id = $target; delta = 1 }
    }
    Start-IsolatedPet $current $version {
        param($origin)
        $detail = Invoke-RestMethod "$origin/api/watch/detail?id=$target"
        if ($detail.detail.ep_status -ne 2) { throw 'New progress did not persist after restart.' }
    }
    Write-Output "Portable: $oldVersion to $version migration, bundled runtime, progress and restart passed."
} finally {
    $env:Path = $savedPath
    $env:BGM_BASE = $savedBase
    $env:BGM_PROXY = $savedProxy
}

if (!$SspRoot) {
    Write-Output 'SSP: public archive structure and empty snapshot passed. Runtime check requires SspRoot and YayaMaster.'
    exit 0
}

$base = (Resolve-Path -LiteralPath $SspRoot).Path
$yaya = (Resolve-Path -LiteralPath $YayaMaster).Path
foreach ($item in 'ssp.exe', 'data', 'balloon') {
    Copy-Item -LiteralPath (Join-Path $base $item) -Destination $sspInstall -Recurse
}
$master = Join-Path $ghostRoot 'ghost/master'
foreach ($item in 'yaya.dll', 'yaya_base') {
    Copy-Item -LiteralPath (Join-Path $yaya $item) -Destination $master -Recurse
}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$exe = Join-Path $sspInstall 'ssp.exe'
$hostProcess = Start-Process -FilePath $exe -WorkingDirectory $sspInstall -ArgumentList '--ghost tiara-yaya --option readonly --sstp-listen none' -PassThru
try {
    $nameProperty = [Windows.Automation.AutomationElement]::NameProperty
    $processProperty = [Windows.Automation.AutomationElement]::ProcessIdProperty
    $byProcess = [Windows.Automation.PropertyCondition]::new($processProperty, [int]$hostProcess.Id)
    $ghost = $null
    for ($attempt = 0; $attempt -lt 32; $attempt++) {
        if ($hostProcess.HasExited) { throw 'SSP quit before loading the ghost.' }
        $ghost = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $byProcess) |
            Where-Object { $_.GetCurrentPropertyValue($nameProperty) -match 'YAYA' } | Select-Object -First 1
        if ($ghost) { break }
        Start-Sleep -Milliseconds 250
    }
    if (!$ghost) { throw 'TIARA did not expose a YAYA ghost window during SSP startup.' }
    Write-Output 'SSP: installed public ZIP, loaded TIARA/YAYA on the desktop.'
} finally {
    if (!$hostProcess.HasExited) {
        $null = $hostProcess.CloseMainWindow()
        if (!$hostProcess.WaitForExit(2500)) { Stop-Process -Id $hostProcess.Id -ErrorAction SilentlyContinue }
    }
}
