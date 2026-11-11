#Requires -Version 5.1
<#
  One-click launcher for the MCP Tunnel account console (http://127.0.0.1:17642).

  - If the console is already running, just opens the web page.
  - If it is not running, starts it hidden, waits until /api/auth/state responds,
    then opens the web page.
  - Does NOT start or stop tunnels; tunnels are managed inside the console UI.

  Exit codes: 0 ok, 1 console could not start.
#>
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$bundle = 'D:\MCP'
$consoleUrl = 'http://127.0.0.1:17642'
$dataDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'McpTunnelAccountManager'
$logDir = Join-Path $dataDir 'logs'
$null = New-Item -ItemType Directory -Path $logDir -Force
$logPath = Join-Path $logDir 'oneclick-console.log'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

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

try {
    Write-Log ('console one-click invoked; dryRun=' + [bool]$DryRun)

    if (Test-ConsoleReady) {
        Write-Log 'console already ready on 127.0.0.1:17642'
    } else {
        Write-Log 'console not ready; starting console'
        if (-not $DryRun) {
            Start-Process -FilePath $psExe -WindowStyle Hidden `
                -ArgumentList @(
                    '-NoLogo', '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
                    '-File', ('"' + (Join-Path $bundle 'Start-Console.ps1') + '"'), '-NoBrowser'
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

    if (-not $DryRun) {
        Start-Process $consoleUrl
        Write-Log 'opened console page'
    } else {
        Write-Log 'dry run finished'
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
}
