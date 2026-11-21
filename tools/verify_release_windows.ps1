param(
    [Parameter(Mandatory)][string]$Manifest,
    [Parameter(Mandatory)][string]$PreviousZip,
    [string]$SspRoot,
    [string]$YayaMaster,
    [switch]$PortableOnly,
    [string]$SourceData
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$manifestPath = (Resolve-Path -LiteralPath $Manifest).Path
$previousPath = (Resolve-Path -LiteralPath $PreviousZip).Path
$releaseDir = Split-Path -Parent $manifestPath
$files = (Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).files
$portable = $files | Where-Object { $_.path -match '^TIARA-portable-\d+\.\d+\.\d+\.zip$' }
$ssp = $files | Where-Object { $_.path -match '^TIARA-ssp-\d+\.\d+\.\d+\.zip$' }
if ($PortableOnly) {
    if (@($files).Count -ne 1 -or @($portable).Count -ne 1) { throw 'Expected a portable-only release manifest.' }
    if ($SspRoot -or $YayaMaster) { throw 'SSP arguments are unavailable in portable-only mode.' }
} elseif (@($files).Count -ne 2 -or @($portable).Count -ne 1 -or @($ssp).Count -ne 1) {
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

$tempRoot = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path.TrimEnd('\')
$work = Join-Path $tempRoot ('tiara-release-check-' + [guid]::NewGuid().ToString('N'))
$old = Join-Path $work 'previous'
$current = Join-Path $work 'current'
$sspInstall = Join-Path $work 'ssp'
New-Item -Path $work -ItemType Directory | Out-Null
[IO.Compression.ZipFile]::ExtractToDirectory($previousPath, $old)
[IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $releaseDir $portable.path), $current)
$oldVersion = (Get-Content -LiteralPath (Join-Path $old 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$version = (Get-Content -LiteralPath (Join-Path $current 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ([version]$oldVersion -ge [version]$version) { throw 'The migration test requires an older release.' }
Write-Output "Release check workspace: $work"

function Start-IsolatedPet($root, $expected, [scriptblock]$check) {
    $exe = Join-Path $root 'pet/Pet.exe'
    $normalized = (Resolve-Path -LiteralPath $root).Path.Replace('\', '/').TrimEnd('/').ToLowerInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $instance = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
    $pet = Start-Process -FilePath $exe -WorkingDirectory $root -WindowStyle Hidden -PassThru
    try {
        $origin = $null
        $portFile = Join-Path $root 'cache/panel_port.txt'
        for ($attempt = 0; $attempt -lt 50; $attempt++) {
            if ($pet.HasExited) { throw "Pet $expected stopped before startup." }
            try {
                $port = [int](Get-Content -LiteralPath $portFile)
                $candidate = "http://127.0.0.1:$port"
                $health = Invoke-RestMethod "$candidate/api/health" -TimeoutSec 1
                if ($health.app -eq 'tiara' -and $health.version -eq $expected -and $health.instance -eq $instance) {
                    $origin = $candidate
                    break
                }
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

function Assert-MigratedData($expected, $actual) {
    foreach ($section in 'settings', 'history') {
        $before = ConvertTo-Json -InputObject $expected.$section -Depth 90 -Compress
        $after = ConvertTo-Json -InputObject $actual.$section -Depth 90 -Compress
        if ($before -cne $after) { throw "Migration changed $section." }
    }
    # Restoring intentionally invalidates previously scheduled reminder snoozes.
    $libraries = foreach ($library in $expected.library, $actual.library) {
        $copy = ConvertTo-Json -InputObject $library -Depth 90 -Compress | ConvertFrom-Json
        foreach ($state in 'watching', 'paused', 'archived', 'planned', 'dropped', 'removed') {
            foreach ($row in $copy.$state) { $row.PSObject.Properties.Remove('reminder_epoch') }
        }
        ConvertTo-Json -InputObject $copy -Depth 90 -Compress
    }
    if ($libraries[0] -cne $libraries[1]) { throw 'Migration changed the library.' }
}

$publicData = Get-ChildItem -LiteralPath (Join-Path $current 'data') -File -Recurse | ForEach-Object { $_.Name }
if (@(Compare-Object @('library.json','settings.json','talks.json','today.json') $publicData).Count -gt 0) {
    throw 'Unexpected files in public portable data.'
}
Assert-EmptySnapshot (Join-Path $current 'data/today.json')
if (!$PortableOnly) {
    $ghostRoot = Join-Path $sspInstall 'ghost/tiara-yaya'
    New-Item -Path (Split-Path -Parent $ghostRoot) -ItemType Directory -Force | Out-Null
    [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $releaseDir $ssp.path), $ghostRoot)
    Assert-EmptySnapshot (Join-Path $ghostRoot 'ghost/master/today.json')
    if (!(Test-Path -LiteralPath (Join-Path $ghostRoot 'install.txt'))) { throw 'Public SSP install metadata is missing.' }
    foreach ($name in 'install.txt', 'ghost/master/descript.txt', 'shell/master/descript.txt') {
        $text = [IO.File]::ReadAllText((Join-Path $ghostRoot $name))
        if (!$text.Contains("`r`n") -or $text -match '(?<!\r)\n|\r(?!\n)') {
            throw "SSP metadata must use CRLF: $name"
        }
    }
    if (Get-ChildItem -LiteralPath $ghostRoot -Recurse -File | Where-Object { $_.Name -match 'bgm\.json|state\.json|history|\.bak' }) {
        throw 'Unexpected private files in public SSP.'
    }
}

$sourceHashes = @{}
$savedPath = $env:Path
$savedBase = $env:BGM_BASE
$savedBroadcast = $env:BGM_BROADCAST_URL
$savedProxy = $env:BGM_PROXY
$env:Path = "$env:SystemRoot\System32;$env:SystemRoot"
$env:BGM_BASE = 'http://127.0.0.1:1'
$env:BGM_BROADCAST_URL = 'http://127.0.0.1:1'
$env:BGM_PROXY = ''
$token = 'tiara-release-check-token'
$portableChecksPassed = $false
function Remove-SourceFixture {
    $resolved = (Resolve-Path -LiteralPath $work).Path
    if ($resolved -ne $work -or (Split-Path -Parent $resolved) -ne $tempRoot) { throw 'Unexpected test workspace path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
try {
    if ($SourceData) {
        $sourceDir = (Resolve-Path -LiteralPath $SourceData).Path
        foreach ($name in 'library.json', 'settings.json') {
            if (!(Test-Path -LiteralPath (Join-Path $sourceDir $name) -PathType Leaf)) { throw "Source data is missing $name." }
        }
        foreach ($file in Get-ChildItem -LiteralPath $sourceDir -File) {
            if ($file.Name -notmatch '^(?:library\.json|settings\.json|history(?:-\d{4})?\.jsonl)$') { continue }
            $fileHash = (Get-FileHash -LiteralPath $file.FullName).Hash
            $copy = Join-Path (Join-Path $old 'data') $file.Name
            Copy-Item -LiteralPath $file.FullName -Destination $copy
            if ((Get-FileHash -LiteralPath $copy).Hash -ne $fileHash) { throw 'Source data changed while making the test copy.' }
            $sourceHashes[$file.FullName] = $fileHash
        }
    }
    Set-Content -LiteralPath (Join-Path $old 'data/bgm.json') -Value ('{"token":"' + $token + '"}') -Encoding UTF8
    if (Get-Command node.exe -ErrorAction SilentlyContinue) { throw 'The runtime isolation PATH still exposes node.exe.' }
    $export = Start-IsolatedPet $old $oldVersion {
        param($origin)
        if (!$SourceData) {
            $created = Post-Json $origin '/api/watch/detail' @{ name = 'Release fixture'; ep_status = 0; eps = 12; watch_mode = 'catchup' }
            if (!$created.detail.id) { throw 'Old version could not add an offline title.' }
            $null = Post-Json $origin '/api/progress' @{ id = $created.detail.id; delta = 1 }
        }
        (Invoke-RestMethod "$origin/api/migration").migration
    }
    if (!$export.library.watching -or ($export | ConvertTo-Json -Depth 90 -Compress).Contains($token)) {
        throw 'The old exported fixture is missing data or contains credentials.'
    }
    Start-IsolatedPet $current $version {
        param($origin)
        $before = (Invoke-RestMethod "$origin/api/migration").migration
        foreach ($state in 'watching', 'paused', 'archived', 'planned', 'dropped', 'removed') {
            if (@($before.library.$state | Where-Object { $_ }).Count) { throw 'Public portable library is not empty.' }
        }
        if ([version]$version -ge [version]'0.60.0') {
            $dir = Join-Path $current 'assets/season-catalog'
            $catalog = Get-Content -LiteralPath (Join-Path $dir 'index.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            $seasons = Invoke-RestMethod "$origin/api/season?list=1"
            $firstQuarter = if ([version]$version -ge [version]'0.67.0') { '2019Q1' } else { '2019Q4' }
            if ($seasons.seasons -notcontains $seasons.current -or $seasons.seasons -notcontains $firstQuarter) {
                throw 'The portable catalog is missing the first or current quarter.'
            }
            $bundledQuarters = @($catalog.seasons.PSObject.Properties.Name)
            foreach ($q in $bundledQuarters) {
                $table = Invoke-RestMethod "$origin/api/season?q=$q"
                if ($table.source -ne 'builtin' -or $table.total -ne $catalog.seasons.$q -or $table.items.Count -ne $table.total) {
                    throw "Offline catalog or original schedule does not match the portable snapshot for $q."
                }
                if ($q -in '2019Q4', $seasons.current -and !$table.airings.PSObject.Properties.Count) {
                    throw "The portable snapshot does not expose original airings for $q."
                }
                $sample = $table.items | Where-Object {
                    $_.id -match '^\d{1,10}$' -and (Test-Path -LiteralPath (Join-Path $dir "covers/$($_.id).jpg") -PathType Leaf)
                } | Select-Object -First 1
                if (!$sample) { throw "No bundled cover for $q." }
                $cover = Invoke-WebRequest "$origin/cover/$($sample.id).jpg?local=1" -UseBasicParsing
                if ($cover.Headers.'Content-Type' -notcontains 'image/jpeg' -or $cover.RawContentLength -lt 100) {
                    throw "A bundled cover could not be read offline for $q."
                }
            }
            Write-Output "Offline catalog: all $($bundledQuarters.Count) bundled seasons and one JPEG per season passed."
        }
        $preview = Post-Json $origin '/api/migration' @{ migration = $export; preview = $true }
        if (!$preview.ok) { throw 'Migration preview failed.' }
        Assert-MigratedData $before (Invoke-RestMethod "$origin/api/migration").migration
        $restored = Post-Json $origin '/api/migration' @{ migration = $export; source = $preview.source; target = $preview.target }
        if (!$restored.ok) { throw 'Old backup could not be restored.' }
        if ($restored.backup -notmatch '^migration-[\w-]+\.json$' -or
            !(Test-Path -LiteralPath (Join-Path $current ('data/backups/' + $restored.backup)) -PathType Leaf)) {
            throw 'The pre-import backup is missing.'
        }
        Assert-MigratedData $export (Invoke-RestMethod "$origin/api/migration").migration
        $titles = 0
        foreach ($state in 'watching', 'paused', 'archived', 'planned', 'dropped', 'removed') {
            $titles += @($export.library.$state | Where-Object { $_ }).Count
        }
        $settingKeys = @($export.settings.PSObject.Properties.Name)
        Write-Output "Migrated: $titles titles, $($preview.incoming.history) history records, settings $($settingKeys -join ', ')."
    }
    $target = Start-IsolatedPet $current $version {
        param($origin)
        Assert-MigratedData $export (Invoke-RestMethod "$origin/api/migration").migration
        if ($SourceData) {
            $created = Post-Json $origin '/api/watch/detail' @{ name = 'Release fixture'; ep_status = 0; eps = 12; watch_mode = 'catchup' }
            if (!$created.detail.id) { throw 'New version could not add an offline title.' }
            $id = $created.detail.id
        } else {
            $id = ($export.library.watching | Where-Object { $_.name_cn -eq 'Release fixture' }).id
        }
        $null = Post-Json $origin '/api/progress' @{ id = $id; delta = 1 }
        $id
    }
    Start-IsolatedPet $current $version {
        param($origin)
        $detail = Invoke-RestMethod "$origin/api/watch/detail?id=$target"
        $expectedProgress = if ($SourceData) { 1 } else { 2 }
        if ($detail.detail.ep_status -ne $expectedProgress) { throw 'New progress did not persist after restart.' }
    }
    foreach ($file in $sourceHashes.Keys) {
        if ((Get-FileHash -LiteralPath $file).Hash -ne $sourceHashes[$file]) { throw 'An original source file changed.' }
    }
    Write-Output "Portable: $oldVersion to $version migration, bundled runtime, progress and restart passed."
    $portableChecksPassed = $true
} finally {
    $env:Path = $savedPath
    $env:BGM_BASE = $savedBase
    $env:BGM_BROADCAST_URL = $savedBroadcast
    $env:BGM_PROXY = $savedProxy
    if ($SourceData -and (!$portableChecksPassed -or $PortableOnly -or !$SspRoot)) { Remove-SourceFixture }
}

if ($PortableOnly) { return }
if (!$SspRoot) {
    Write-Output 'SSP: public archive structure and empty snapshot passed. Runtime check requires SspRoot and YayaMaster.'
    exit 0
}

$base = (Resolve-Path -LiteralPath $SspRoot).Path
$yaya = (Resolve-Path -LiteralPath $YayaMaster).Path
# SSP asks for interactive confirmation if its executable is under the system temp folder.
$localAppData = (Resolve-Path -LiteralPath ([Environment]::GetFolderPath('LocalApplicationData'))).Path
$runName = 'tiara-ssp-release-check-' + [guid]::NewGuid().ToString('N')
$sspRun = Join-Path $localAppData $runName
$hostProcess = $null
try {
    Copy-Item -LiteralPath $sspInstall -Destination $sspRun -Recurse
    foreach ($item in 'ssp.exe', 'data', 'balloon') {
        Copy-Item -LiteralPath (Join-Path $base $item) -Destination $sspRun -Recurse
    }
    $master = Join-Path $sspRun 'ghost/tiara-yaya/ghost/master'
    foreach ($item in 'yaya.dll', 'yaya_base') {
        Copy-Item -LiteralPath (Join-Path $yaya $item) -Destination $master -Recurse
    }
    $windowNames = @([IO.File]::ReadAllLines((Join-Path $master 'descript.txt'), [Text.Encoding]::UTF8) |
        ForEach-Object { if ($_ -match '^(?:sakura\.name|name),(.+)$') { $Matches[1].Trim() } })
    if (!$windowNames.Count) { throw 'The packaged SSP ghost has no display name.' }
    $expectedYaya = Join-Path $master 'yaya.dll'
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $exe = Join-Path $sspRun 'ssp.exe'
    $hostProcess = Start-Process -FilePath $exe -WorkingDirectory $sspRun -ArgumentList '--ghost tiara-yaya --option readonly --sstp-listen none' -WindowStyle Hidden -PassThru
    $nameProperty = [Windows.Automation.AutomationElement]::NameProperty
    $processProperty = [Windows.Automation.AutomationElement]::ProcessIdProperty
    $byProcess = [Windows.Automation.PropertyCondition]::new($processProperty, [int]$hostProcess.Id)
    $loadedGhost = $false
    for ($attempt = 0; $attempt -lt 32; $attempt++) {
        if ($hostProcess.HasExited) { throw 'SSP quit before loading the ghost.' }
        $ghost = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $byProcess) |
            Where-Object { $windowNames -contains $_.GetCurrentPropertyValue($nameProperty) } | Select-Object -First 1
        $hostProcess.Refresh()
        $yayaModule = $hostProcess.Modules | Where-Object FileName -EQ $expectedYaya | Select-Object -First 1
        if ($ghost -and $yayaModule) { $loadedGhost = $true; break }
        Start-Sleep -Milliseconds 250
    }
    if (!$loadedGhost) { throw 'SSP did not load both the packaged TIARA window and its YAYA module.' }
    Write-Output 'SSP: installed public ZIP, loaded TIARA/YAYA on the desktop.'
} finally {
    if ($hostProcess -and !$hostProcess.HasExited) {
        $null = $hostProcess.CloseMainWindow()
        if (!$hostProcess.WaitForExit(2500)) {
            Stop-Process -Id $hostProcess.Id -ErrorAction SilentlyContinue
            $null = $hostProcess.WaitForExit(2500)
        }
    }
    $resolved = Resolve-Path -LiteralPath $sspRun -ErrorAction SilentlyContinue
    if ($resolved -and (Split-Path -Parent $resolved.Path) -eq $localAppData -and
        (Split-Path -Leaf $resolved.Path) -eq $runName) {
        Remove-Item -LiteralPath $resolved.Path -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($SourceData) { Remove-SourceFixture }
}
