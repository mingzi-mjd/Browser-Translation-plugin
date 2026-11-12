param(
    [string]$Model = 'Systran/faster-whisper-small',
    [string]$ModelId = '',
    [ValidateSet('cpu', 'cuda')][string]$Device = 'cpu',
    [string]$ComputeType = 'int8',
    [ValidateRange(1, 65535)][int]$Port = 8000,
    [ValidateRange(1, 128)][int]$Threads = 4
)
$ErrorActionPreference = 'Stop'
$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host 'Run install.cmd or install.ps1 first.' -ForegroundColor Red
    exit 1
}
$serverArgs = @((Join-Path $PSScriptRoot 'server.py'), '--model', $Model, '--device', $Device, '--compute-type', $ComputeType, '--port', $Port, '--threads', $Threads)
if ($ModelId) { $serverArgs += @('--model-id', $ModelId) }
& $venvPython @serverArgs
exit $LASTEXITCODE
