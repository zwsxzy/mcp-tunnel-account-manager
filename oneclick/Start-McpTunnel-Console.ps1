#Requires -Version 5.1
<#
  One-click launcher for the MCP Tunnel account console (http://127.0.0.1:17642).

  - If the console is already running, it just opens the web page.
  - If not, it starts the console hidden, waits until /api/auth/state responds,
    then opens the page.
  - It does NOT start or stop MCP tunnels; tunnels are managed inside the console.

  Usage (from a desktop shortcut created by Install-Desktop-Shortcut.ps1):
    powershell -File Start-McpTunnel-Console.ps1 -BundleRoot "D:\MCP"

  Exit codes: 0 ok, 1 console could not start.
#>
param(
    [string]$BundleRoot = '',
    [ValidateRange(1, 65535)][int]$Port = 17642,
    [switch]$NoBrowser,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$consoleUrl = 'http://127.0.0.1:' + $Port
$dataDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'McpTunnelAccountManager'
$logDir = Join-Path $dataDir 'logs'
$null = New-Item -ItemType Directory -Path $logDir -Force
$logPath = Join-Path $logDir 'oneclick-console.log'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Resolve-BundleRoot {
    if ($BundleRoot) {
        return (Resolve-Path -LiteralPath $BundleRoot -ErrorAction Stop).Path
    }
    $dir = $PSScriptRoot
    for ($i = 0; $i -lt 5 -and $dir; $i++) {
        if (Test-Path -LiteralPath (Join-Path $dir 'Start-Console.ps1') -PathType Leaf) {
            return (Resolve-Path -LiteralPath $dir).Path
        }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    throw 'BUNDLE_ROOT_REQUIRED: pass -BundleRoot pointing at the extracted deployment kit root.'
}

function Write-Log {
    param([string]$Message)
    $line = ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) + "`r`n"
    for ($i = 0; $i -lt 10; $i++) {
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($line)
            $stream = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
            try {
                $stream.Write($bytes, 0, $bytes.Length)
            } finally {
                $stream.Close()
            }
            return
        } catch {
            Start-Sleep -Milliseconds 100
        }
    }
}

function Test-ConsoleReady {
    try {
        $reply = Invoke-RestMethod -Uri ($consoleUrl + '/api/auth/state') -TimeoutSec 2 -UseBasicParsing
        return ($null -ne $reply -and $null -ne $reply.configured)
    } catch {
        return $false
    }
}

# Single-instance synchronization to prevent rapid double-click race conditions
$launcherMutex = $null
$ownsMutex = $false
try {
    $launcherMutex = New-Object System.Threading.Mutex($true, 'McpTunnelAccountManagerLauncherMutex', [ref]$ownsMutex)
    if (-not $ownsMutex) {
        # Another launcher instance is currently running (e.g. quick double-click). Wait up to 5s.
        try {
            $ownsMutex = $launcherMutex.WaitOne(5000)
        } catch [System.Threading.AbandonedMutexException] {
            $ownsMutex = $true
        }
        if ($ownsMutex) {
            if (Test-ConsoleReady) {
                Write-Log 'console already ready (after waiting for sibling launcher); opening browser and exiting'
                if (-not $NoBrowser -and -not $DryRun) {
                    Start-Process $consoleUrl
                }
                try { $launcherMutex.ReleaseMutex(); $ownsMutex = $false } catch { }
                exit 0
            }
        }
    }
} catch {
    # If mutex fails for any reason, continue execution safely
}

try {
    $bundle = Resolve-BundleRoot
    $starter = Join-Path $bundle 'Start-Console.ps1'
    if (-not (Test-Path -LiteralPath $starter -PathType Leaf)) {
        throw ('Start-Console.ps1 not found under: ' + $bundle)
    }

    Write-Log ('one-click console start; bundle=' + $bundle + '; port=' + $Port + '; dryRun=' + [bool]$DryRun)

    if (Test-ConsoleReady) {
        Write-Log 'console already ready'
    } else {
        Write-Log 'console not ready; starting console'
        if (-not $DryRun) {
            # Clean duplicate case-variant environment variables (e.g. NO_PROXY and no_proxy)
            # which cause .NET Framework ProcessStartInfo to throw ArgumentException
            try {
                $envVars = [System.Environment]::GetEnvironmentVariables('Process')
                $seenKeys = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
                foreach ($k in $envVars.Keys) {
                    if (-not $seenKeys.Add($k)) {
                        [System.Environment]::SetEnvironmentVariable($k, $null, 'Process')
                    }
                }
            } catch { }

            Start-Process -FilePath $psExe -WindowStyle Hidden `
                -ArgumentList @(
                    '-NoLogo', '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
                    '-File', ('"' + $starter + '"'), '-NoBrowser'
                ) `
                -RedirectStandardOutput (Join-Path $logDir 'console-start.out.log') `
                -RedirectStandardError (Join-Path $logDir 'console-start.err.log') | Out-Null
            Write-Log 'console start command issued'
        } else {
            Write-Log 'DRYRUN start console'
        }
        $deadline = (Get-Date).AddSeconds(60)
        while (-not (Test-ConsoleReady) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
        if (-not (Test-ConsoleReady)) {
            Write-Log 'ERROR console did not become ready within 60s'
            try {
                Add-Type -AssemblyName System.Windows.Forms
                [System.Windows.Forms.MessageBox]::Show(
                    ('Console did not start. See log: ' + $logPath), 'MCP Tunnel', 'OK', 'Error') | Out-Null
            } catch { }
            exit 1
        }
        Write-Log 'console is ready'
    }

    if (-not $NoBrowser -and -not $DryRun) {
        Start-Process $consoleUrl
        Write-Log 'opened console page'
    }
    exit 0
} catch {
    Write-Log ('ERROR ' + $_.Exception.Message)
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show(
            ('One-click start failed: ' + $_.Exception.Message + [Environment]::NewLine + 'Log: ' + $logPath),
            'MCP Tunnel', 'OK', 'Error') | Out-Null
    } catch { }
    exit 1
} finally {
    if ($null -ne $launcherMutex -and $ownsMutex) {
        try { $launcherMutex.ReleaseMutex() } catch { }
        try { $launcherMutex.Dispose() } catch { }
    }
}