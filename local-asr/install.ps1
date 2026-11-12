param([string]$Python = "")
$ErrorActionPreference = "Stop"
try {
    $serviceRoot = $PSScriptRoot
    $venvPython = Join-Path $serviceRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPython)) {
        $candidates = @()
        if ($Python) {
            $candidates += @{ Command = $Python; Arguments = @() }
        } else {
            foreach ($version in @('-3.11', '-3.12', '-3.10')) {
                if (Get-Command py -ErrorAction SilentlyContinue) {
                    $candidates += @{ Command = 'py'; Arguments = @($version) }
                }
            }
            if (Get-Command python -ErrorAction SilentlyContinue) {
                $candidates += @{ Command = 'python'; Arguments = @() }
            }
        }
        $pythonCommand = $null
        foreach ($candidate in $candidates) {
            $candidateArgs = $candidate.Arguments
            try {
                $result = & $candidate.Command @candidateArgs -c "import sys,struct; assert (3,10) <= sys.version_info[:2] <= (3,12) and struct.calcsize('P') == 8; print(sys.executable)" 2>$null
                if ($LASTEXITCODE -eq 0 -and $result) {
                    $pythonCommand = [string](@($result)[-1])
                    break
                }
            } catch { continue }
        }
        if (-not $pythonCommand) { throw 'No compatible Python found. Install Python 3.11 x64, or pass -Python with a Python 3.10-3.12 executable path.' }
        Write-Host "Using Python: $pythonCommand"
        & $pythonCommand -m venv (Join-Path $serviceRoot '.venv')
        if ($LASTEXITCODE -ne 0) { throw 'Failed to create virtual environment.' }
    }
    & $venvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw 'Failed to update pip. Check the network and retry.' }
    & $venvPython -m pip install -r (Join-Path $serviceRoot 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check the error above and retry.' }
    Write-Host 'Installed. Run start.cmd (or start.ps1). The model downloads on first start.'
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
