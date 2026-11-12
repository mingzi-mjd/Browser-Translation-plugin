param(
    [string]$BinaryUrl = 'https://github.com/jiang1997/whisper.cpp-release/releases/download/v1.8.4.1/whisper-1.8.4-windows-x64.zip',
    [string]$BinarySha256 = '4B1B36343FEB55EC3DEACE6A7DD18CC217F43A55E4ECCE76CCD4EE3595C0B642',
    [string]$ModelName = 'ggml-small.bin',
    [string]$ModelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    [string]$ModelSha256 = '1BE3A9B2063867B937E64E2EC7483364A79917E157FA98C5D94B5C1FFFEA987B',
    [switch]$SkipModel
)
$ErrorActionPreference = 'Stop'
$binRoot = Join-Path $PSScriptRoot 'whispercpp'
$modelRoot = Join-Path $PSScriptRoot 'models'
New-Item -ItemType Directory -Force -Path $binRoot, $modelRoot | Out-Null

function Get-File([string]$Url, [string]$Path) {
    if (Test-Path -LiteralPath $Path) { return }
    Write-Host "Downloading $Url"
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        & curl.exe -L --fail --retry 3 --connect-timeout 30 -o $Path $Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    } else {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path
    }
}

$zip = Join-Path $binRoot 'whisper-1.8.4-windows-x64.zip'
Get-File $BinaryUrl $zip
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash
if ($actual -ne $BinarySha256) {
    throw "whisper.cpp package SHA256 mismatch. Expected $BinarySha256, got $actual. Delete $zip after verifying the source."
}
$extract = Join-Path $binRoot 'v1.8.4'
$server = Join-Path $extract 'whisper-1.8.4-windows-x64\whisper-server.exe'
if (-not (Test-Path -LiteralPath $server)) {
    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
}

if (-not $SkipModel) {
    $model = Join-Path $modelRoot $ModelName
    Get-File $ModelUrl $model
    $modelHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $model).Hash
    if ($modelHash -ne $ModelSha256) {
        throw "Model SHA256 mismatch. Expected $ModelSha256, got $modelHash. Delete $model after verifying the source."
    }
}

Write-Host 'whisper.cpp Vulkan files are ready.' -ForegroundColor Green
Write-Host 'The package is an unsigned third-party build; review its source and hash before use.'
Write-Host 'Run start-whispercpp.cmd, then configure the extension with http://127.0.0.1:8000/v1.'
