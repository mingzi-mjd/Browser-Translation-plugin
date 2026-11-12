param(
    [string]$Model = (Join-Path $PSScriptRoot 'models\ggml-small.bin'),
    [string]$ModelId = 'whisper-small',
    [ValidateRange(1, 65535)][int]$Port = 8000,
    [ValidateRange(1, 65535)][int]$UpstreamPort = 8080,
    [ValidateRange(1, 128)][int]$Threads = 4,
    [string]$Language = 'auto',
    [string]$Prompt = '',
    [string]$Python = '',
    [string]$Binary = ''
)
$ErrorActionPreference = 'Stop'
if (-not $Python) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python310\python.exe'),
        'C:\Python311\python.exe',
        'C:\Python312\python.exe',
        'C:\Python310\python.exe'
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            $Python = $candidate
            break
        }
    }
}
if (-not $Python) {
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) {
        $candidate = & $launcher.Source -3.11 -c "import sys; print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $candidate) {
            $Python = [string](@($candidate)[-1])
        }
    }
}
if (-not $Python) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand -and (Test-Path -LiteralPath $pythonCommand.Source)) {
        $pythonFile = Get-Item -LiteralPath $pythonCommand.Source
        if ($pythonFile.Length -gt 0) { $Python = $pythonCommand.Source }
    }
}
if (-not $Python -or -not (Test-Path -LiteralPath $Python)) {
    Write-Host 'Python 3.10-3.12 not found. Install 64-bit Python 3.11 first.' -ForegroundColor Red
    exit 1
}
if (-not $Binary) {
    $Binary = Get-ChildItem (Join-Path $PSScriptRoot 'whispercpp') -Filter 'whisper-server.exe' -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Binary -or -not (Test-Path -LiteralPath $Binary)) {
    Write-Host 'whisper-server.exe not found under local-asr\whispercpp.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $Model)) {
    Write-Host "Model not found: $Model" -ForegroundColor Red
    exit 1
}
$proxy = Join-Path $PSScriptRoot 'whispercpp_proxy.py'
$proxyArgs = @($proxy, '--binary', $Binary, '--model', $Model, '--model-id', $ModelId,
    '--port', $Port, '--upstream-port', $UpstreamPort, '--threads', $Threads, '--language', $Language)
if ($Prompt) { $proxyArgs += @('--prompt', $Prompt) }
& $Python @proxyArgs
exit $LASTEXITCODE
