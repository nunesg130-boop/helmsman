#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$SourcePath,
    [string]$RepositoryPath,
    [string]$DeploymentHost,
    [string]$DeploymentUser,
    [string]$DeploymentRoot,
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ExpectedRepository = 'nunesg130-boop/helmsman'
$script:ExpectedGitHubLogin = 'nunesg130-boop'
$script:ExpectedCloneUrl = 'https://github.com/nunesg130-boop/helmsman.git'
$script:MinimumGitHubCliVersion = [version]'2.57.0'
$script:ExpectedPublisherSha256 = 'c7c8f7be7570b7c74bf2775231bf95f58786313bdf4cbd36139e09d84662b3fb'
$script:MaximumRecoveryClones = 20

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)

    Write-Host ''
    Write-Host ('=> ' + $Message) -ForegroundColor Cyan
}

function Get-ApplicationPath {
    param([Parameter(Mandatory = $true)][string]$Name)

    $command = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $command) { return $null }
    return $command.Source
}

function Invoke-NativeProbe {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )

    $stdoutPath = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
    $stderrPath = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
    $exitCode = -1
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $FilePath @ArgumentList 1> $stdoutPath 2> $stderrPath
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    try {
        $stdout = if (Test-Path -LiteralPath $stdoutPath) {
            ([IO.File]::ReadAllText($stdoutPath)).Trim()
        }
        else { '' }
        $stderr = if (Test-Path -LiteralPath $stderrPath) {
            ([IO.File]::ReadAllText($stderrPath)).Trim()
        }
        else { '' }
        $combined = (@($stdout, $stderr) |
            Where-Object { ![string]::IsNullOrWhiteSpace($_) }) -join "`n"
        return [PSCustomObject]@{
            ExitCode = $exitCode
            StdOut = $stdout
            StdErr = $stderr
            Text = $combined
        }
    }
    finally {
        if ([IO.File]::Exists($stdoutPath)) { [IO.File]::Delete($stdoutPath) }
        if ([IO.File]::Exists($stderrPath)) { [IO.File]::Delete($stderrPath) }
    }
}

function Invoke-NativeText {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    $result = Invoke-NativeProbe -FilePath $FilePath -ArgumentList $ArgumentList
    if ($result.ExitCode -ne 0) {
        $detail = if ([string]::IsNullOrWhiteSpace($result.Text)) { '' } else { "`n$($result.Text)" }
        throw "$FailureMessage (exit code $($result.ExitCode)).$detail"
    }
    return $result.StdOut
}

function Invoke-NativeLive {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    $exitCode = -1
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $FilePath @ArgumentList 2>&1 | ForEach-Object { Write-Host ($_.ToString()) }
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
        throw "$FailureMessage (exit code $exitCode)."
    }
}

function Update-ProcessPath {
    $processPath = [Environment]::GetEnvironmentVariable('Path', 'Process')
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $separator = [IO.Path]::PathSeparator
    $seen = @{}
    $merged = @()
    foreach ($pathValue in @($processPath, $machinePath, $userPath)) {
        if ([string]::IsNullOrWhiteSpace($pathValue)) { continue }
        foreach ($part in @($pathValue.Split($separator))) {
            if ([string]::IsNullOrWhiteSpace($part)) { continue }
            $key = $part.Trim().TrimEnd([char[]]@('\', '/')).ToLowerInvariant()
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            $merged += $part
        }
    }
    $env:Path = $merged -join $separator
}

function Install-RequiredApplication {
    param(
        [Parameter(Mandatory = $true)][string]$CommandName,
        [Parameter(Mandatory = $true)][string]$PackageId,
        [Parameter(Mandatory = $true)][string]$DisplayName
    )

    $application = Get-ApplicationPath -Name $CommandName
    if ($null -ne $application) { return $application }

    $winget = Get-ApplicationPath -Name 'winget.exe'
    if ($null -eq $winget) {
        throw "$DisplayName is not installed and winget.exe is unavailable. Install App Installer from Microsoft, then run this launcher again."
    }

    Write-Step "Installing $DisplayName with winget"
    Invoke-NativeLive -FilePath $winget -ArgumentList @(
        'install', '--id', $PackageId, '--exact', '--source', 'winget',
        '--accept-source-agreements', '--accept-package-agreements',
        '--disable-interactivity'
    ) -FailureMessage "$DisplayName installation"

    Update-ProcessPath
    $application = Get-ApplicationPath -Name $CommandName
    if ($null -eq $application) {
        throw "$DisplayName was installed, but '$CommandName' is not available in this process. Close this window and run the launcher again."
    }
    return $application
}

function ConvertFrom-GitHubCliVersionOutput {
    param([Parameter(Mandatory = $true)][string]$VersionOutput)

    $match = [regex]::Match(
        $VersionOutput,
        '(?m)^gh version (?<version>[0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)'
    )
    if (!$match.Success) {
        throw 'GitHub CLI returned an unrecognized version string.'
    }
    try {
        return [version]$match.Groups['version'].Value
    }
    catch {
        throw 'GitHub CLI returned an invalid version number.'
    }
}

function Assert-SupportedGitHubCli {
    param([Parameter(Mandatory = $true)][string]$GitHubPath)

    $versionOutput = Invoke-NativeText `
        -FilePath $GitHubPath `
        -ArgumentList @('--version') `
        -FailureMessage 'GitHub CLI version check'
    $version = ConvertFrom-GitHubCliVersionOutput -VersionOutput $versionOutput
    if ($version -lt $script:MinimumGitHubCliVersion) {
        throw "GitHub CLI $script:MinimumGitHubCliVersion or newer is required for unambiguous active-account verification; found $version. Update it with 'winget upgrade --id GitHub.cli --exact', then retry."
    }
}

function Get-RequiredTools {
    Update-ProcessPath
    $git = Install-RequiredApplication -CommandName 'git.exe' -PackageId 'Git.Git' -DisplayName 'Git for Windows'
    $github = Install-RequiredApplication -CommandName 'gh.exe' -PackageId 'GitHub.cli' -DisplayName 'GitHub CLI'
    Assert-SupportedGitHubCli -GitHubPath $github
    return [PSCustomObject]@{
        Git = $git
        GitHub = $github
    }
}

function Get-NormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [IO.Path]::GetFullPath($Path).Replace('/', '\').TrimEnd('\').ToLowerInvariant()
}

function Enter-GitHooksIsolation {
    $variableNames = @(
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
        'GIT_CONFIG_PARAMETERS',
        'GIT_TERMINAL_PROMPT',
        'GCM_INTERACTIVE'
    )
    $previousValues = @{}
    foreach ($name in $variableNames) {
        $previousValues[$name] = [PSCustomObject]@{
            Exists = Test-Path -LiteralPath ("Env:" + $name)
            Value = [Environment]::GetEnvironmentVariable($name, 'Process')
        }
    }

    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char[]]@('\', '/'))
    $hooksPath = Join-Path $temporaryRoot ('helmsman-empty-hooks-' + [guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $hooksPath) {
        throw 'The unique empty Git-hooks directory unexpectedly already exists.'
    }

    $created = $false
    try {
        $null = New-Item -ItemType Directory -Path $hooksPath -ErrorAction Stop
        $created = $true
        $hooksItem = Get-Item -LiteralPath $hooksPath -Force
        $hooksFull = [IO.Path]::GetFullPath($hooksItem.FullName).TrimEnd([char[]]@('\', '/'))
        $temporaryPrefix = $temporaryRoot + [IO.Path]::DirectorySeparatorChar
        if (!$hooksFull.StartsWith($temporaryPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            ($hooksItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [IO.Directory]::GetFileSystemEntries($hooksFull).Count -ne 0) {
            throw 'The empty Git-hooks directory failed validation.'
        }

        [Environment]::SetEnvironmentVariable('GIT_CONFIG_PARAMETERS', $null, 'Process')
        [Environment]::SetEnvironmentVariable('GIT_CONFIG_COUNT', '1', 'Process')
        [Environment]::SetEnvironmentVariable('GIT_CONFIG_KEY_0', 'core.hooksPath', 'Process')
        [Environment]::SetEnvironmentVariable('GIT_CONFIG_VALUE_0', $hooksFull, 'Process')
        [Environment]::SetEnvironmentVariable('GIT_TERMINAL_PROMPT', '0', 'Process')
        [Environment]::SetEnvironmentVariable('GCM_INTERACTIVE', 'Never', 'Process')

        return [PSCustomObject]@{
            HooksPath = $hooksFull
            TemporaryRoot = $temporaryRoot
            PreviousValues = $previousValues
        }
    }
    catch {
        foreach ($name in $variableNames) {
            $saved = $previousValues[$name]
            $restoreValue = if ($saved.Exists) { $saved.Value } else { $null }
            [Environment]::SetEnvironmentVariable($name, $restoreValue, 'Process')
        }
        if ($created -and (Test-Path -LiteralPath $hooksPath -PathType Container)) {
            $cleanupItem = Get-Item -LiteralPath $hooksPath -Force
            if (($cleanupItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and
                [IO.Directory]::GetFileSystemEntries($cleanupItem.FullName).Count -eq 0) {
                [IO.Directory]::Delete($cleanupItem.FullName, $false)
            }
        }
        throw
    }
}

function Exit-GitHooksIsolation {
    param([Parameter(Mandatory = $true)]$Scope)

    foreach ($name in @(
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
        'GIT_CONFIG_PARAMETERS',
        'GIT_TERMINAL_PROMPT',
        'GCM_INTERACTIVE'
    )) {
        $saved = $Scope.PreviousValues[$name]
        $restoreValue = if ($saved.Exists) { $saved.Value } else { $null }
        [Environment]::SetEnvironmentVariable($name, $restoreValue, 'Process')
    }

    $hooksFull = [IO.Path]::GetFullPath([string]$Scope.HooksPath).TrimEnd([char[]]@('\', '/'))
    $temporaryRoot = [IO.Path]::GetFullPath([string]$Scope.TemporaryRoot).TrimEnd([char[]]@('\', '/'))
    $temporaryPrefix = $temporaryRoot + [IO.Path]::DirectorySeparatorChar
    if (!$hooksFull.StartsWith($temporaryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to remove a Git-hooks directory outside the validated temporary root.'
    }
    if (!(Test-Path -LiteralPath $hooksFull)) { return }
    $hooksItem = Get-Item -LiteralPath $hooksFull -Force
    if (!$hooksItem.PSIsContainer -or
        ($hooksItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [IO.Directory]::GetFileSystemEntries($hooksFull).Count -ne 0) {
        throw 'The temporary Git-hooks directory changed unexpectedly and was not removed.'
    }
    [IO.Directory]::Delete($hooksFull, $false)
}

function Assert-RegularDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if (!(Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Description is not a directory: $Path"
    }
    # Git for Windows normally marks .git as hidden. -Force is required for
    # Windows PowerShell 5.1 to inspect that directory after a fresh clone.
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Description cannot be a symlink, cloud placeholder, or reparse point. If it is stored in OneDrive, extract the release to a local folder such as C:\Helmsman-Releases and try again: $Path"
    }
}

function Test-ReleaseRoot {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (!(Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    if (Test-Path -LiteralPath (Join-Path $Path '.git')) { return $false }
    return (
        (Test-Path -LiteralPath (Join-Path $Path 'package.json') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Path 'compose.yaml') -PathType Leaf)
    )
}

function Resolve-ReleaseRoot {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).ProviderPath
    if ($resolved -match '[\x00-\x1f\x7f]') {
        throw 'The release source path cannot contain control characters.'
    }
    Assert-RegularDirectory -Path $resolved -Description 'The release source'

    if (Test-ReleaseRoot -Path $resolved) {
        $releaseRoot = $resolved
    }
    else {
        $nested = Join-Path $resolved 'helmsman'
        if (!(Test-ReleaseRoot -Path $nested)) {
            throw 'The selected directory is not a Helmsman source root and does not contain a helmsman source directory.'
        }
        $releaseRoot = (Resolve-Path -LiteralPath $nested).ProviderPath
    }

    Assert-RegularDirectory -Path $releaseRoot -Description 'The Helmsman release root'
    $packagePath = Join-Path $releaseRoot 'package.json'
    try {
        $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    }
    catch {
        throw 'The selected source has an invalid package.json.'
    }
    foreach ($requiredProperty in @('name', 'version')) {
        if ($null -eq $package.PSObject.Properties[$requiredProperty] -or
            $null -eq $package.PSObject.Properties[$requiredProperty].Value) {
            throw "The selected source package.json is missing the required '$requiredProperty' property."
        }
    }
    if ([string]$package.name -cne 'helmsman') {
        throw 'The selected source package name is not helmsman.'
    }
    $version = [string]$package.version
    $releaseSemVer = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$'
    if ($version -notmatch $releaseSemVer) {
        throw "The selected source version is not release-safe SemVer: $version"
    }
    return [PSCustomObject]@{
        Root = $releaseRoot
        Version = $version
        Tag = 'v' + $version
    }
}

function Select-ReleaseSourceDirectory {
    $selection = $null
    $dialogResult = $null
    $pickerFailed = $false
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        $dialog = New-Object Windows.Forms.FolderBrowserDialog
        try {
            $dialog.Description = 'Select the extracted Helmsman release folder'
            $dialog.ShowNewFolderButton = $false
            $suggested = Split-Path -Parent $PSScriptRoot
            if (Test-Path -LiteralPath $suggested -PathType Container) {
                $dialog.SelectedPath = $suggested
            }
            $dialogResult = $dialog.ShowDialog()
            if ($dialogResult -eq [Windows.Forms.DialogResult]::OK) {
                $selection = $dialog.SelectedPath
            }
        }
        finally {
            $dialog.Dispose()
        }
    }
    catch {
        $pickerFailed = $true
    }

    if ($pickerFailed) {
        Write-Warning 'The Windows folder picker is unavailable. Enter the full path to the extracted Helmsman release folder instead.'
        $selection = Read-Host 'Extracted release folder path'
    }
    elseif ($dialogResult -ne [Windows.Forms.DialogResult]::OK) {
        throw 'Release-folder selection was cancelled.'
    }

    if ([string]::IsNullOrWhiteSpace($selection)) {
        throw 'No extracted release folder was selected.'
    }
    return $selection.Trim().Trim('"')
}

function ConvertTo-GitHubSlug {
    param([Parameter(Mandatory = $true)][string]$RemoteUrl)

    $value = $RemoteUrl.Trim().TrimEnd('/')
    if ($value.EndsWith('.git', [StringComparison]::OrdinalIgnoreCase)) {
        $value = $value.Substring(0, $value.Length - 4)
    }
    if ($value -match '^https://github\.com/(?<slug>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$') {
        return $Matches.slug.ToLowerInvariant()
    }
    if ($value -match '^git@github\.com:(?<slug>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$') {
        return $Matches.slug.ToLowerInvariant()
    }
    if ($value -match '^ssh://git@github\.com/(?<slug>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$') {
        return $Matches.slug.ToLowerInvariant()
    }
    throw 'The origin remote is not a supported credential-free GitHub URL.'
}

function Assert-ExpectedHttpsCloneUrl {
    param(
        [Parameter(Mandatory = $true)][string]$RemoteUrl,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $value = $RemoteUrl.Trim().TrimEnd('/')
    $expected = $script:ExpectedCloneUrl.TrimEnd('/')
    if (![string]::Equals($value, $expected, [StringComparison]::Ordinal)) {
        throw "$Description must resolve to the verified credential-free HTTPS URL $script:ExpectedCloneUrl. SSH, embedded credentials, alternate hosts, and Git URL rewrites are not allowed."
    }
}

function Assert-CorrectRepository {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools
    )

    Assert-RegularDirectory -Path $RepoRoot -Description 'The Helmsman Git clone'
    $gitDirectory = Join-Path $RepoRoot '.git'
    Assert-RegularDirectory -Path $gitDirectory -Description 'The Helmsman Git metadata'

    $actualRoot = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'rev-parse', '--show-toplevel'
    ) -FailureMessage 'Git repository discovery'
    if ((Get-NormalizedPath $actualRoot) -cne (Get-NormalizedPath $RepoRoot)) {
        throw 'The configured repository path is not the root of its Git clone.'
    }

    $fetchText = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'remote', 'get-url', '--all', 'origin'
    ) -FailureMessage 'Origin remote discovery'
    $pushText = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'remote', 'get-url', '--push', '--all', 'origin'
    ) -FailureMessage 'Origin push-remote discovery'
    $fetchUrls = @($fetchText -split "`r?`n" | Where-Object { $_ -ne '' })
    $pushUrls = @($pushText -split "`r?`n" | Where-Object { $_ -ne '' })
    if ($fetchUrls.Count -ne 1 -or $pushUrls.Count -ne 1) {
        throw 'The origin remote must have exactly one fetch URL and one push URL.'
    }
    Assert-ExpectedHttpsCloneUrl -RemoteUrl $fetchUrls[0] -Description 'The effective origin fetch URL'
    Assert-ExpectedHttpsCloneUrl -RemoteUrl $pushUrls[0] -Description 'The effective origin push URL'
    if ((ConvertTo-GitHubSlug -RemoteUrl $fetchUrls[0]) -cne $script:ExpectedRepository -or
        (ConvertTo-GitHubSlug -RemoteUrl $pushUrls[0]) -cne $script:ExpectedRepository) {
        throw "The existing clone does not point to $script:ExpectedRepository."
    }
}

function Assert-CleanRepository {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)][string]$Context
    )

    $status = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'status', '--porcelain=v1', '--untracked-files=all'
    ) -FailureMessage 'Git working-tree check'
    if (![string]::IsNullOrWhiteSpace($status)) {
        throw "$Context The launcher will not reset, clean, or overwrite an existing working tree."
    }
}

function Get-PublishingRepositorySelection {
    param(
        [string]$RequestedPath,
        [Parameter(Mandatory = $true)][string]$UserProfile
    )

    if (![string]::IsNullOrWhiteSpace($RequestedPath)) {
        return [PSCustomObject]@{
            RepositoryPath = [IO.Path]::GetFullPath($RequestedPath)
            RecoveryPath = $null
            IsExplicit = $true
        }
    }
    if ([string]::IsNullOrWhiteSpace($UserProfile)) {
        throw 'USERPROFILE is unavailable, so the persistent publishing-clone path cannot be resolved.'
    }

    $repositoryParent = Join-Path $UserProfile 'Downloads'
    $defaultRepository = [IO.Path]::GetFullPath((Join-Path $repositoryParent 'helmsman-github'))
    $recoveryRepository = [IO.Path]::GetFullPath((Join-Path $repositoryParent 'helmsman-github-recovery'))
    return [PSCustomObject]@{
        RepositoryPath = $defaultRepository
        RecoveryPath = $recoveryRepository
        IsExplicit = $false
    }
}

function Get-RecoveryRepositoryCandidate {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [ValidateRange(1, 20)][int]$StartIndex = 1
    )

    for ($index = $StartIndex; $index -le $script:MaximumRecoveryClones; $index++) {
        $candidate = if ($index -eq 1) {
            [IO.Path]::GetFullPath($BasePath)
        }
        else {
            [IO.Path]::GetFullPath($BasePath + '-' + $index)
        }

        if (!(Test-Path -LiteralPath $candidate)) {
            return [PSCustomObject]@{
                Path = $candidate
                Index = $index
                Exists = $false
            }
        }

        $candidateItem = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
        $gitDirectory = Join-Path $candidate '.git'
        $gitItem = Get-Item -LiteralPath $gitDirectory -Force -ErrorAction SilentlyContinue
        if ($candidateItem.PSIsContainer -and
            ($candidateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and
            $null -ne $gitItem -and
            $gitItem.PSIsContainer -and
            ($gitItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
            return [PSCustomObject]@{
                Path = $candidate
                Index = $index
                Exists = $true
            }
        }

        Write-Warning "The occupied recovery path is not a reusable Git clone and was left untouched: $candidate"
    }

    throw "All $script:MaximumRecoveryClones bounded recovery-clone paths are occupied. They were left untouched."
}

function Get-ExpectedGitHubLogin {
    param([Parameter(Mandatory = $true)]$Tools)

    $login = (Invoke-NativeText -FilePath $Tools.GitHub -ArgumentList @(
        'api', 'user', '--jq', '.login'
    ) -FailureMessage 'GitHub account lookup').Trim()
    if ($login -cne $script:ExpectedGitHubLogin) {
        throw "GitHub CLI is authenticated as '$login', not '$script:ExpectedGitHubLogin'. Run 'gh auth switch --hostname github.com --user $script:ExpectedGitHubLogin' or sign into the required account, then retry."
    }
    return $login
}

function Test-GitHubAuthenticationScope {
    param(
        [Parameter(Mandatory = $true)][string]$StatusText,
        [Parameter(Mandatory = $true)][string]$RequiredScope
    )

    $scopeLines = [regex]::Matches(
        $StatusText,
        '(?im)^\s*-\s*Token scopes:\s*(?<scopes>[^\r\n]*)\s*$'
    )
    if ($scopeLines.Count -ne 1) { return $false }
    foreach ($entry in $scopeLines[0].Groups['scopes'].Value.Split(',')) {
        $scope = $entry.Trim()
        if ($scope.Length -ge 2) {
            $first = $scope.Substring(0, 1)
            $last = $scope.Substring($scope.Length - 1, 1)
            if (($first -ceq "'" -and $last -ceq "'") -or
                ($first -ceq '"' -and $last -ceq '"')) {
                $scope = $scope.Substring(1, $scope.Length - 2)
            }
        }
        if ($scope -ceq $RequiredScope) { return $true }
    }
    return $false
}

function ConvertFrom-GitHubRepositoryJson {
    param([Parameter(Mandatory = $true)][string]$Json)

    try {
        $repository = $Json | ConvertFrom-Json
    }
    catch {
        throw 'GitHub returned malformed repository metadata.'
    }
    if ($null -eq $repository -or $repository -is [Array]) {
        throw 'GitHub returned an unexpected repository metadata shape.'
    }
    foreach ($requiredProperty in @('nameWithOwner', 'viewerPermission', 'defaultBranchRef', 'isArchived')) {
        if ($null -eq $repository.PSObject.Properties[$requiredProperty]) {
            throw "GitHub repository metadata is missing '$requiredProperty'."
        }
    }
    if (([string]$repository.nameWithOwner).ToLowerInvariant() -cne $script:ExpectedRepository) {
        throw 'GitHub CLI resolved a different repository than expected.'
    }
    if ([string]$repository.viewerPermission -cnotin @('WRITE', 'MAINTAIN', 'ADMIN')) {
        throw 'The authenticated GitHub account does not have permission to publish to the Helmsman repository.'
    }
    if ($null -eq $repository.defaultBranchRef -or
        $null -eq $repository.defaultBranchRef.PSObject.Properties['name'] -or
        [string]$repository.defaultBranchRef.name -cne 'main') {
        throw 'The Helmsman repository default branch is not main.'
    }
    if ($repository.PSObject.Properties['isArchived'].Value -isnot [bool]) {
        throw 'GitHub repository metadata contains an invalid archive state.'
    }
    if ([bool]$repository.isArchived) {
        throw 'The Helmsman repository is archived and cannot accept a release.'
    }
    return $repository
}

function Initialize-GitHubAuthentication {
    param([Parameter(Mandatory = $true)]$Tools)

    Write-Step 'Checking GitHub authentication'
    foreach ($environmentOverride in @('GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR')) {
        $ambientValue = [Environment]::GetEnvironmentVariable($environmentOverride, 'Process')
        if (![string]::IsNullOrWhiteSpace($ambientValue)) {
            throw "The $environmentOverride environment variable is set. Clear it before publishing so GitHub CLI uses its verified github.com keyring account. Its value was not displayed."
        }
    }
    $status = Invoke-NativeProbe -FilePath $Tools.GitHub -ArgumentList @(
        'auth', 'status', '--active', '--hostname', 'github.com'
    )
    if ($status.ExitCode -ne 0) {
        Write-Host 'A browser will open so GitHub can authorize this computer.' -ForegroundColor Yellow
        Invoke-NativeLive -FilePath $Tools.GitHub -ArgumentList @(
            'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https',
            '--web', '--scopes', 'repo,workflow'
        ) -FailureMessage 'GitHub browser authentication'
        $status = Invoke-NativeProbe -FilePath $Tools.GitHub -ArgumentList @(
            'auth', 'status', '--active', '--hostname', 'github.com'
        )
    }
    if ($status.ExitCode -ne 0) {
        throw 'GitHub CLI is not authenticated after the browser login.'
    }

    $login = Get-ExpectedGitHubLogin -Tools $Tools
    $refreshed = $false
    if (!(Test-GitHubAuthenticationScope -StatusText $status.Text -RequiredScope 'repo') -or
        !(Test-GitHubAuthenticationScope -StatusText $status.Text -RequiredScope 'workflow')) {
        Write-Host 'Adding the GitHub repository and workflow permissions required to publish releases.' -ForegroundColor Yellow
        Invoke-NativeLive -FilePath $Tools.GitHub -ArgumentList @(
            'auth', 'refresh', '--hostname', 'github.com', '--scopes', 'repo,workflow'
        ) -FailureMessage 'GitHub repository and workflow authorization'
        $refreshed = $true
        $status = Invoke-NativeProbe -FilePath $Tools.GitHub -ArgumentList @(
            'auth', 'status', '--active', '--hostname', 'github.com'
        )
        if ($status.ExitCode -ne 0 -or
            !(Test-GitHubAuthenticationScope -StatusText $status.Text -RequiredScope 'repo') -or
            !(Test-GitHubAuthenticationScope -StatusText $status.Text -RequiredScope 'workflow')) {
            throw 'GitHub CLI did not confirm the repository and workflow permissions after authorization.'
        }
        $login = Get-ExpectedGitHubLogin -Tools $Tools
    }

    $repositorySelector = 'github.com/' + $script:ExpectedRepository
    $repositoryArguments = @(
        'repo', 'view', $repositorySelector,
        '--json', 'nameWithOwner,viewerPermission,defaultBranchRef,isArchived'
    )
    $repositoryProbe = Invoke-NativeProbe -FilePath $Tools.GitHub -ArgumentList $repositoryArguments
    if ($repositoryProbe.ExitCode -ne 0 -and !$refreshed) {
        Write-Host 'GitHub is signed in, but Helmsman repository access must be refreshed in the browser.' -ForegroundColor Yellow
        Invoke-NativeLive -FilePath $Tools.GitHub -ArgumentList @(
            'auth', 'refresh', '--hostname', 'github.com', '--scopes', 'repo,workflow'
        ) -FailureMessage 'GitHub repository authorization'
        $refreshed = $true
        $status = Invoke-NativeProbe -FilePath $Tools.GitHub -ArgumentList @(
            'auth', 'status', '--active', '--hostname', 'github.com'
        )
        if ($status.ExitCode -ne 0 -or
            !(Test-GitHubAuthenticationScope -StatusText $status.Text -RequiredScope 'repo') -or
            !(Test-GitHubAuthenticationScope -StatusText $status.Text -RequiredScope 'workflow')) {
            throw 'GitHub CLI authentication was lost while refreshing repository access.'
        }
        $login = Get-ExpectedGitHubLogin -Tools $Tools
        $repositoryProbe = Invoke-NativeProbe -FilePath $Tools.GitHub -ArgumentList $repositoryArguments
    }
    if ($repositoryProbe.ExitCode -ne 0) {
        throw "GitHub CLI is signed in as '$login' but cannot access $script:ExpectedRepository. Confirm that the repository still exists and grant this account repository access, then retry."
    }
    $null = ConvertFrom-GitHubRepositoryJson -Json $repositoryProbe.StdOut

    Invoke-NativeLive -FilePath $Tools.GitHub -ArgumentList @(
        'auth', 'setup-git', '--hostname', 'github.com'
    ) -FailureMessage 'GitHub Git credential setup'

    $effectiveCloneUrl = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
        'ls-remote', '--get-url', $script:ExpectedCloneUrl
    ) -FailureMessage 'Effective Helmsman HTTPS URL check'
    Assert-ExpectedHttpsCloneUrl `
        -RemoteUrl $effectiveCloneUrl `
        -Description 'The effective authenticated clone URL'

    $remoteMain = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
        'ls-remote', '--exit-code', $script:ExpectedCloneUrl, 'refs/heads/main'
    ) -FailureMessage 'Authenticated HTTPS access to the Helmsman repository'
    $remoteMainLines = @($remoteMain -split "`r?`n" | Where-Object { $_ -ne '' })
    if ($remoteMainLines.Count -ne 1 -or
        $remoteMainLines[0] -notmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})\s+refs/heads/main$') {
        throw 'The authenticated Helmsman repository did not return one valid main branch reference.'
    }

    return [PSCustomObject]@{
        Login = $login
        CloneUrl = $script:ExpectedCloneUrl
    }
}

function Assert-RepositoryPathSeparation {
    param(
        [Parameter(Mandatory = $true)][string]$CandidatePath,
        [string[]]$ForbiddenPaths = @(),
        [Parameter(Mandatory = $true)][string]$Description
    )

    $candidateNormalized = Get-NormalizedPath $CandidatePath
    foreach ($forbiddenPath in $ForbiddenPaths) {
        if ([string]::IsNullOrWhiteSpace($forbiddenPath)) { continue }
        $forbiddenNormalized = Get-NormalizedPath $forbiddenPath
        if ($candidateNormalized -eq $forbiddenNormalized -or
            $candidateNormalized.StartsWith($forbiddenNormalized + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $forbiddenNormalized.StartsWith($candidateNormalized + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "$Description must be separate from and not nested within the release source or active launcher path."
        }
    }
}

function Invoke-RecoveryRepositoryFallback {
    param(
        [Parameter(Mandatory = $true)][string]$CurrentRepoRoot,
        [Parameter(Mandatory = $true)][string]$RecoveryRepoRoot,
        [ValidateRange(0, 20)][int]$CurrentRecoveryIndex,
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)]$Account,
        [string[]]$ForbiddenPaths = @(),
        [Parameter(Mandatory = $true)][string]$Reason
    )

    if ($CurrentRecoveryIndex -ge $script:MaximumRecoveryClones) {
        throw "$Reason The final bounded recovery path was left untouched, and no additional recovery path is available."
    }
    $candidate = Get-RecoveryRepositoryCandidate `
        -BasePath $RecoveryRepoRoot `
        -StartIndex ($CurrentRecoveryIndex + 1)
    $currentNormalized = Get-NormalizedPath $CurrentRepoRoot
    $candidateNormalized = Get-NormalizedPath $candidate.Path
    if ($currentNormalized -eq $candidateNormalized -or
        $currentNormalized.StartsWith($candidateNormalized + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $candidateNormalized.StartsWith($currentNormalized + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The recovery clone must be separate from and not nested within the preserved clone.'
    }
    Assert-RepositoryPathSeparation `
        -CandidatePath $candidate.Path `
        -ForbiddenPaths $ForbiddenPaths `
        -Description 'The recovery clone'

    Write-Warning "$Reason No local files or commits were changed at $CurrentRepoRoot. Continuing with the separate recovery clone: $($candidate.Path)"
    return Initialize-Repository `
        -RepoRoot $candidate.Path `
        -Tools $Tools `
        -Account $Account `
        -RecoveryRepoRoot $RecoveryRepoRoot `
        -RecoveryIndex $candidate.Index `
        -ForbiddenPaths $ForbiddenPaths
}

function Initialize-Repository {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)]$Account,
        [string]$RecoveryRepoRoot,
        [ValidateRange(0, 20)][int]$RecoveryIndex = 0,
        [string[]]$ForbiddenPaths = @()
    )

    Assert-RepositoryPathSeparation `
        -CandidatePath $RepoRoot `
        -ForbiddenPaths $ForbiddenPaths `
        -Description 'The publishing clone'
    $repoParent = Split-Path -Parent $RepoRoot
    if (!(Test-Path -LiteralPath $RepoRoot)) {
        if ($null -eq $Account.PSObject.Properties['CloneUrl'] -or
            [string]$Account.CloneUrl -cne $script:ExpectedCloneUrl) {
            throw 'The verified GitHub account did not provide the expected authenticated clone URL.'
        }
        if (!(Test-Path -LiteralPath $repoParent -PathType Container)) {
            $null = New-Item -ItemType Directory -Path $repoParent -ErrorAction Stop
        }
        Write-Step "Cloning $script:ExpectedRepository"
        Invoke-NativeLive -FilePath $Tools.GitHub -ArgumentList @(
            'repo', 'clone', $script:ExpectedCloneUrl, $RepoRoot, '--no-upstream', '--',
            '--branch', 'main', '--single-branch', '--no-tags'
        ) -FailureMessage 'Helmsman repository clone'
    }
    elseif (!(Test-Path -LiteralPath $RepoRoot -PathType Container)) {
        if (![string]::IsNullOrWhiteSpace($RecoveryRepoRoot)) {
            return Invoke-RecoveryRepositoryFallback `
                -CurrentRepoRoot $RepoRoot `
                -RecoveryRepoRoot $RecoveryRepoRoot `
                -CurrentRecoveryIndex $RecoveryIndex `
                -Tools $Tools `
                -Account $Account `
                -ForbiddenPaths $ForbiddenPaths `
                -Reason 'The occupied managed-clone path is not a directory.'
        }
        throw "The repository path exists but is not a directory: $RepoRoot"
    }

    try {
        Assert-CorrectRepository -RepoRoot $RepoRoot -Tools $Tools
        Assert-CleanRepository -RepoRoot $RepoRoot -Tools $Tools -Context 'The existing Helmsman clone has local changes.'
        $currentBranch = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
            '-C', $RepoRoot, 'branch', '--show-current'
        ) -FailureMessage 'Current branch check'
        if ($currentBranch -cne 'main') {
            throw 'The existing Helmsman clone is not on main. The launcher will not switch an existing working tree.'
        }
    }
    catch {
        if (![string]::IsNullOrWhiteSpace($RecoveryRepoRoot)) {
            return Invoke-RecoveryRepositoryFallback `
                -CurrentRepoRoot $RepoRoot `
                -RecoveryRepoRoot $RecoveryRepoRoot `
                -CurrentRecoveryIndex $RecoveryIndex `
                -Tools $Tools `
                -Account $Account `
                -ForbiddenPaths $ForbiddenPaths `
                -Reason 'The existing managed clone is not a clean canonical HTTPS Helmsman clone.'
        }
        throw
    }

    if ($RecoveryIndex -gt 0) {
        Write-Host "Using the verified persistent recovery clone: $RepoRoot" -ForegroundColor Green
    }

    Write-Step 'Synchronizing the clean main branch'
    Invoke-NativeLive -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'fetch', '--no-tags', '--no-prune', '--recurse-submodules=no', 'origin',
        'refs/heads/main:refs/remotes/origin/main'
    ) -FailureMessage 'Exact fetch of origin/main'
    $localHead = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'rev-parse', 'HEAD'
    ) -FailureMessage 'Local main identity check'
    $remoteHead = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'rev-parse', 'refs/remotes/origin/main'
    ) -FailureMessage 'Remote main identity check'
    if ($localHead -cne $remoteHead) {
        $fastForward = Invoke-NativeProbe -FilePath $Tools.Git -ArgumentList @(
            '-C', $RepoRoot, 'merge-base', '--is-ancestor', $localHead, $remoteHead
        )
        if ($fastForward.ExitCode -eq 0) {
            Invoke-NativeLive -FilePath $Tools.Git -ArgumentList @(
                '-C', $RepoRoot, 'merge', '--ff-only', '--no-edit', 'refs/remotes/origin/main'
            ) -FailureMessage 'Fast-forward merge of origin/main'
        }
        elseif ($fastForward.ExitCode -eq 1 -and ![string]::IsNullOrWhiteSpace($RecoveryRepoRoot)) {
            return Invoke-RecoveryRepositoryFallback `
                -CurrentRepoRoot $RepoRoot `
                -RecoveryRepoRoot $RecoveryRepoRoot `
                -CurrentRecoveryIndex $RecoveryIndex `
                -Tools $Tools `
                -Account $Account `
                -ForbiddenPaths $ForbiddenPaths `
                -Reason 'The existing clone has a clean local commit that is not on origin/main.'
        }
        elseif ($fastForward.ExitCode -eq 1) {
            throw 'Local main is ahead of or diverges from origin/main. The launcher will not force, reset, amend, or delete it.'
        }
        else {
            throw 'Git could not determine whether local main can fast-forward to origin/main.'
        }
    }

    Assert-CleanRepository -RepoRoot $RepoRoot -Tools $Tools -Context 'The synchronized Helmsman clone is not clean.'
    $localHead = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'rev-parse', 'HEAD'
    ) -FailureMessage 'Synchronized local main identity check'
    $remoteHead = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'rev-parse', 'refs/remotes/origin/main'
    ) -FailureMessage 'Synchronized remote main identity check'
    if ($localHead -cne $remoteHead) {
        throw 'Local main still differs from origin/main after synchronization.'
    }

    $githubId = (Invoke-NativeText -FilePath $Tools.GitHub -ArgumentList @(
        'api', 'user', '--jq', '.id'
    ) -FailureMessage 'GitHub numeric account ID lookup').Trim()
    if ($githubId -notmatch '^[0-9]+$') {
        throw 'GitHub returned an invalid numeric account ID.'
    }
    $email = $githubId + '+' + $Account.Login + '@users.noreply.github.com'
    Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'config', '--local', 'user.name', $Account.Login
    ) -FailureMessage 'Repository-local Git author-name setup' | Out-Null
    Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'config', '--local', 'user.email', $email
    ) -FailureMessage 'Repository-local Git author-email setup' | Out-Null

    return $RepoRoot
}

function Assert-SelfTestThrows {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $threw = $false
    try { & $Action | Out-Null }
    catch { $threw = $true }
    if (!$threw) { throw "Self-test '$Name' did not reject unsafe input." }
}

function Invoke-LauncherSelfTest {
    Write-Step 'Running offline launcher self-tests'
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) ('helmsman-launcher-test-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $testRoot -ErrorAction Stop
    try {
        $outerRoot = Join-Path $testRoot 'release'
        $releaseRoot = Join-Path $outerRoot 'helmsman'
        $invalidRoot = Join-Path $testRoot 'invalid-release'
        $malformedRoot = Join-Path $testRoot 'malformed-release'
        $hiddenRoot = Join-Path $testRoot 'hidden-directory'
        $null = New-Item -ItemType Directory -Path $releaseRoot -Force -ErrorAction Stop
        $null = New-Item -ItemType Directory -Path $invalidRoot -ErrorAction Stop
        $null = New-Item -ItemType Directory -Path $malformedRoot -ErrorAction Stop
        $null = New-Item -ItemType Directory -Path $hiddenRoot -ErrorAction Stop

        $hiddenItem = Get-Item -LiteralPath $hiddenRoot -Force -ErrorAction Stop
        $hiddenItem.Attributes = $hiddenItem.Attributes -bor [IO.FileAttributes]::Hidden
        Assert-RegularDirectory -Path $hiddenRoot -Description 'The hidden-directory self-test'
        Write-Host 'Hidden-directory inspection: PASS' -ForegroundColor Green

        [IO.File]::WriteAllText(
            (Join-Path $releaseRoot 'package.json'),
            '{"name":"helmsman","version":"9.8.7-test.1"}'
        )
        [IO.File]::WriteAllText(
            (Join-Path $releaseRoot 'compose.yaml'),
            'name: helmsman'
        )
        [IO.File]::WriteAllText(
            (Join-Path $malformedRoot 'package.json'),
            '{"name":"not-helmsman","version":"9.8.7-test.1"}'
        )
        [IO.File]::WriteAllText(
            (Join-Path $malformedRoot 'compose.yaml'),
            'name: helmsman'
        )

        $direct = Resolve-ReleaseRoot -Path $releaseRoot
        $nested = Resolve-ReleaseRoot -Path $outerRoot
        if ($direct.Root -cne $nested.Root -or
            $direct.Version -cne '9.8.7-test.1' -or
            $nested.Tag -cne 'v9.8.7-test.1') {
            throw 'Extracted release discovery did not return the expected canonical source.'
        }

        Assert-SelfTestThrows -Name 'missing release files' -Action {
            Resolve-ReleaseRoot -Path $invalidRoot
        }
        Assert-SelfTestThrows -Name 'wrong package identity' -Action {
            Resolve-ReleaseRoot -Path $malformedRoot
        }

        $repositoryMetadata = ConvertFrom-GitHubRepositoryJson -Json '{"nameWithOwner":"nunesg130-boop/helmsman","viewerPermission":"WRITE","defaultBranchRef":{"name":"main"},"isArchived":false}'
        if ([string]$repositoryMetadata.nameWithOwner -cne $script:ExpectedRepository -or
            [string]$repositoryMetadata.viewerPermission -cne 'WRITE') {
            throw 'GitHub repository metadata validation returned the wrong repository.'
        }
        Assert-SelfTestThrows -Name 'read-only repository permission' -Action {
            ConvertFrom-GitHubRepositoryJson -Json '{"nameWithOwner":"nunesg130-boop/helmsman","viewerPermission":"READ","defaultBranchRef":{"name":"main"},"isArchived":false}'
        }
        Assert-SelfTestThrows -Name 'wrong default branch' -Action {
            ConvertFrom-GitHubRepositoryJson -Json '{"nameWithOwner":"nunesg130-boop/helmsman","viewerPermission":"ADMIN","defaultBranchRef":{"name":"master"},"isArchived":false}'
        }
        Assert-SelfTestThrows -Name 'missing repository metadata' -Action {
            ConvertFrom-GitHubRepositoryJson -Json '{"nameWithOwner":"nunesg130-boop/helmsman"}'
        }
        Assert-SelfTestThrows -Name 'null repository archive state' -Action {
            ConvertFrom-GitHubRepositoryJson -Json '{"nameWithOwner":"nunesg130-boop/helmsman","viewerPermission":"ADMIN","defaultBranchRef":{"name":"main"},"isArchived":null}'
        }
        Assert-SelfTestThrows -Name 'archived repository' -Action {
            ConvertFrom-GitHubRepositoryJson -Json '{"nameWithOwner":"nunesg130-boop/helmsman","viewerPermission":"ADMIN","defaultBranchRef":{"name":"main"},"isArchived":true}'
        }
        Assert-ExpectedHttpsCloneUrl `
            -RemoteUrl ($script:ExpectedCloneUrl + '/') `
            -Description 'The self-test HTTPS URL'
        Assert-SelfTestThrows -Name 'SSH repository transport' -Action {
            Assert-ExpectedHttpsCloneUrl `
                -RemoteUrl 'git@github.com:nunesg130-boop/helmsman.git' `
                -Description 'The self-test URL'
        }
        Assert-SelfTestThrows -Name 'credential-bearing repository URL' -Action {
            Assert-ExpectedHttpsCloneUrl `
                -RemoteUrl 'https://token@github.com/nunesg130-boop/helmsman.git' `
                -Description 'The self-test URL'
        }
        Assert-SelfTestThrows -Name 'case-changed repository URL' -Action {
            Assert-ExpectedHttpsCloneUrl `
                -RemoteUrl 'https://github.com/NUNESG130-BOOP/HELMSMAN.git' `
                -Description 'The self-test URL'
        }
        $minimumGitHubCli = ConvertFrom-GitHubCliVersionOutput `
            -VersionOutput "gh version 2.57.0 (self-test)`ngh.example.invalid"
        if ($minimumGitHubCli -ne $script:MinimumGitHubCliVersion) {
            throw 'GitHub CLI version parsing did not preserve the minimum supported version.'
        }
        Assert-SelfTestThrows -Name 'malformed GitHub CLI version' -Action {
            ConvertFrom-GitHubCliVersionOutput -VersionOutput 'gh version unknown'
        }
        $scopeFixture = "  - Token scopes: 'repo', 'workflow'"
        if (!(Test-GitHubAuthenticationScope -StatusText $scopeFixture -RequiredScope 'repo') -or
            !(Test-GitHubAuthenticationScope -StatusText $scopeFixture -RequiredScope 'workflow') -or
            (Test-GitHubAuthenticationScope `
                -StatusText "  - Token scopes: 'repo:status', 'workflow'" `
                -RequiredScope 'repo')) {
            throw 'GitHub CLI scope parsing did not require exact scope names.'
        }
        Assert-SelfTestThrows -Name 'repository nested in release source' -Action {
            Assert-RepositoryPathSeparation `
                -CandidatePath (Join-Path $releaseRoot 'nested-clone') `
                -ForbiddenPaths @($releaseRoot) `
                -Description 'The self-test clone'
        }
        Assert-SelfTestThrows -Name 'repository contains release source' -Action {
            Assert-RepositoryPathSeparation `
                -CandidatePath $outerRoot `
                -ForbiddenPaths @($releaseRoot) `
                -Description 'The self-test clone'
        }

        $profileRoot = Join-Path $testRoot 'profile'
        $downloadsRoot = Join-Path $profileRoot 'Downloads'
        $null = New-Item -ItemType Directory -Path $downloadsRoot -Force -ErrorAction Stop
        $defaultClone = [IO.Path]::GetFullPath((Join-Path $downloadsRoot 'helmsman-github'))
        $recoveryClone = [IO.Path]::GetFullPath((Join-Path $downloadsRoot 'helmsman-github-recovery'))
        $initialSelection = Get-PublishingRepositorySelection -UserProfile $profileRoot
        if ($initialSelection.RepositoryPath -cne $defaultClone -or
            $initialSelection.RecoveryPath -cne $recoveryClone -or
            $initialSelection.IsExplicit) {
            throw 'Repository selection did not prepare the expected non-destructive recovery path.'
        }

        $null = New-Item -ItemType Directory -Path $recoveryClone -ErrorAction Stop
        $firstSentinel = Join-Path $recoveryClone 'preserve-first.txt'
        [IO.File]::WriteAllText($firstSentinel, 'preserve-first')
        $secondRecoveryClone = $recoveryClone + '-2'
        $null = New-Item -ItemType Directory -Path $secondRecoveryClone -ErrorAction Stop
        $secondSentinel = Join-Path $secondRecoveryClone 'preserve-second.txt'
        [IO.File]::WriteAllText($secondSentinel, 'preserve-second')
        $unusedCandidate = Get-RecoveryRepositoryCandidate -BasePath $recoveryClone
        if ($unusedCandidate.Path -cne ($recoveryClone + '-3') -or
            $unusedCandidate.Index -ne 3 -or
            $unusedCandidate.Exists -or
            [IO.File]::ReadAllText($firstSentinel) -cne 'preserve-first' -or
            [IO.File]::ReadAllText($secondSentinel) -cne 'preserve-second') {
            throw 'Recovery selection did not preserve and skip incomplete occupied paths.'
        }

        $null = New-Item -ItemType Directory -Path $defaultClone -ErrorAction Stop
        $null = New-Item -ItemType Directory -Path (Join-Path $defaultClone '.git') -ErrorAction Stop
        $defaultSentinel = Join-Path $defaultClone 'preserve-default.txt'
        [IO.File]::WriteAllText($defaultSentinel, 'preserve-default')
        $fakeGit = Join-Path $testRoot 'fake-git.cmd'
        $fakeGitHub = Join-Path $testRoot 'fake-gh.cmd'
        $fakeGitLog = Join-Path $testRoot 'fake-git.log'
        $fakeGitHubLog = Join-Path $testRoot 'fake-gh.log'
        $localSelfTestSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        $remoteSelfTestSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        $fakeGitLines = @(
            '@echo off',
            '>>"%~dp0fake-git.log" echo %*',
            'if /I "%~3"=="rev-parse" if /I "%~4"=="--show-toplevel" (',
            '  echo %~2',
            '  exit /b 0',
            ')',
            'if /I "%~3"=="remote" if /I "%~4"=="get-url" (',
            ('  echo ' + $script:ExpectedCloneUrl),
            '  exit /b 0',
            ')',
            'if /I "%~3"=="status" exit /b 0',
            'if /I "%~3"=="branch" (',
            '  echo main',
            '  exit /b 0',
            ')',
            'if /I "%~3"=="fetch" exit /b 0',
            'if /I "%~3"=="rev-parse" if /I "%~4"=="HEAD" (',
            ('  echo ' + $localSelfTestSha),
            '  exit /b 0',
            ')',
            'if /I "%~3"=="rev-parse" if /I "%~4"=="refs/remotes/origin/main" (',
            ('  echo ' + $remoteSelfTestSha),
            '  exit /b 0',
            ')',
            'if /I "%~3"=="merge-base" exit /b 1',
            'exit /b 71'
        )
        $fakeGitHubLines = @(
            '@echo off',
            '>>"%~dp0fake-gh.log" echo %*',
            'if not exist "%~4" mkdir "%~4"',
            '>"%~4\partial-sentinel.txt" echo preserve-partial',
            'exit /b 73'
        )
        [IO.File]::WriteAllText(
            $fakeGit,
            (($fakeGitLines -join "`r`n") + "`r`n")
        )
        [IO.File]::WriteAllText(
            $fakeGitHub,
            (($fakeGitHubLines -join "`r`n") + "`r`n")
        )
        $fakeTools = [PSCustomObject]@{ Git = $fakeGit; GitHub = $fakeGitHub }
        $fakeAccount = [PSCustomObject]@{
            Login = $script:ExpectedGitHubLogin
            CloneUrl = $script:ExpectedCloneUrl
        }
        foreach ($attempt in @(1, 2)) {
            $cloneFailureObserved = $false
            try {
                Initialize-Repository `
                    -RepoRoot $defaultClone `
                    -Tools $fakeTools `
                    -Account $fakeAccount `
                    -RecoveryRepoRoot $recoveryClone `
                    -RecoveryIndex 0 `
                    -ForbiddenPaths @($releaseRoot) | Out-Null
            }
            catch {
                if ($_.Exception.Message -notmatch 'Helmsman repository clone \(exit code 73\)') {
                    throw
                }
                $cloneFailureObserved = $true
            }
            if (!$cloneFailureObserved) {
                throw "Recovery attempt $attempt did not reach the expected guarded GitHub CLI clone failure."
            }
        }
        $thirdRecoveryClone = $recoveryClone + '-3'
        $fourthRecoveryClone = $recoveryClone + '-4'
        $githubArguments = @([IO.File]::ReadAllLines($fakeGitHubLog))
        $gitArguments = @([IO.File]::ReadAllLines($fakeGitLog))
        if ($githubArguments.Count -ne 2) {
            throw 'The failed recovery rerun did not make exactly two guarded GitHub CLI clone attempts.'
        }
        for ($argumentIndex = 0; $argumentIndex -lt $githubArguments.Count; $argumentIndex++) {
            $expectedDestination = if ($argumentIndex -eq 0) {
                $thirdRecoveryClone
            }
            else {
                $fourthRecoveryClone
            }
            if (!$githubArguments[$argumentIndex].StartsWith(
                    'repo clone ' + $script:ExpectedCloneUrl + ' ',
                    [StringComparison]::OrdinalIgnoreCase
                ) -or
                $githubArguments[$argumentIndex].IndexOf(
                    $expectedDestination,
                    [StringComparison]::OrdinalIgnoreCase
                ) -lt 0 -or
                !$githubArguments[$argumentIndex].EndsWith(
                    '--no-upstream -- --branch main --single-branch --no-tags',
                    [StringComparison]::Ordinal
                )) {
                throw 'Recovery routing did not use the exact guarded HTTPS clone command and next unused suffix.'
            }
        }
        $unsafeGitArguments = @($gitArguments | Where-Object {
            $_ -match '(?:^|\s)(?:clone|reset|clean|switch|push)(?:\s|$)'
        })
        $mergeBaseArguments = @($gitArguments | Where-Object {
            $_.EndsWith(
                "merge-base --is-ancestor $localSelfTestSha $remoteSelfTestSha",
                [StringComparison]::OrdinalIgnoreCase
            )
        })
        if ($gitArguments.Count -lt 18 -or
            $mergeBaseArguments.Count -ne 2 -or
            $unsafeGitArguments.Count -ne 0) {
            throw 'Clean-ahead recovery routing used an unsafe direct Git operation.'
        }
        $thirdPartialSentinel = Join-Path $thirdRecoveryClone 'partial-sentinel.txt'
        $fourthPartialSentinel = Join-Path $fourthRecoveryClone 'partial-sentinel.txt'
        if ([IO.File]::ReadAllText($defaultSentinel) -cne 'preserve-default' -or
            [IO.File]::ReadAllText($firstSentinel) -cne 'preserve-first' -or
            [IO.File]::ReadAllText($secondSentinel) -cne 'preserve-second' -or
            ([IO.File]::ReadAllText($thirdPartialSentinel)).Trim() -cne 'preserve-partial' -or
            ([IO.File]::ReadAllText($fourthPartialSentinel)).Trim() -cne 'preserve-partial') {
            throw 'Clean-ahead recovery routing changed a preserved clone or partial recovery path.'
        }

        $fifthRecoveryClone = $recoveryClone + '-5'
        $null = New-Item -ItemType Directory -Path $fifthRecoveryClone -ErrorAction Stop
        $null = New-Item -ItemType Directory -Path (Join-Path $fifthRecoveryClone '.git') -ErrorAction Stop
        $existingCandidate = Get-RecoveryRepositoryCandidate -BasePath $recoveryClone
        if ($existingCandidate.Path -cne $fifthRecoveryClone -or
            $existingCandidate.Index -ne 5 -or
            !$existingCandidate.Exists) {
            throw 'Recovery selection did not identify a reusable Git-clone-shaped path.'
        }

        $explicitClone = Join-Path $testRoot 'explicit-clone'
        $explicitSelection = Get-PublishingRepositorySelection -RequestedPath $explicitClone -UserProfile $profileRoot
        if ($explicitSelection.RepositoryPath -cne ([IO.Path]::GetFullPath($explicitClone)) -or
            $null -ne $explicitSelection.RecoveryPath -or
            !$explicitSelection.IsExplicit) {
            throw 'Repository selection changed an explicit publishing-clone path.'
        }

        Write-Host 'Extracted-folder discovery: PASS' -ForegroundColor Green
        Write-Host 'GitHub CLI compatibility: PASS' -ForegroundColor Green
        Write-Host 'Repository metadata: PASS' -ForegroundColor Green
        Write-Host 'Partial recovery preservation: PASS' -ForegroundColor Green
        Write-Host 'Clean-ahead failed-clone recovery routing: PASS' -ForegroundColor Green
        Write-Host 'Launcher self-test: PASS' -ForegroundColor Green
    }
    finally {
        # This exact directory was created by this self-test and never existed beforehand.
        if (Test-Path -LiteralPath $testRoot -PathType Container) {
            [IO.Directory]::Delete($testRoot, $true)
        }
    }
}

function Invoke-HelmsmanBootstrapCore {
    $repositorySelection = Get-PublishingRepositorySelection -RequestedPath $RepositoryPath -UserProfile $env:USERPROFILE
    $RepositoryPath = $repositorySelection.RepositoryPath
    $recoveryRepositoryFull = $repositorySelection.RecoveryPath
    $repositoryFull = [IO.Path]::GetFullPath($RepositoryPath)
    if ($repositoryFull -match '[\x00-\x1f\x7f]') {
        throw 'The repository path cannot contain control characters.'
    }
    $repositoryNormalized = Get-NormalizedPath $repositoryFull
    $launcherNormalized = Get-NormalizedPath $PSScriptRoot
    if ((Test-Path -LiteralPath (Join-Path $PSScriptRoot '.git')) -or
        $launcherNormalized -eq $repositoryNormalized -or
        $launcherNormalized.StartsWith($repositoryNormalized + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Run this launcher from an extracted release or a standalone copy, not from the persistent Helmsman Git clone. This prevents the publisher from overwriting its running launcher.'
    }

    if (![string]::IsNullOrWhiteSpace($SourcePath)) {
        $selectedSource = $SourcePath
    }
    elseif (Test-ReleaseRoot -Path $PSScriptRoot) {
        $selectedSource = $PSScriptRoot
        Write-Host "Using the extracted release beside this launcher: $selectedSource" -ForegroundColor Green
    }
    else {
        $selectedSource = Select-ReleaseSourceDirectory
        Write-Host "Using the selected extracted release folder: $selectedSource" -ForegroundColor Green
    }

    $release = Resolve-ReleaseRoot -Path $selectedSource
    Write-Host "Selected Helmsman $($release.Version) from $($release.Root)" -ForegroundColor Green

    $releaseNormalized = Get-NormalizedPath $release.Root
    if ($releaseNormalized -eq $repositoryNormalized -or
        $releaseNormalized.StartsWith($repositoryNormalized + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $repositoryNormalized.StartsWith($releaseNormalized + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The release source and persistent Git clone must be separate directories.'
    }

    Write-Step 'Checking Git and GitHub CLI'
    $tools = Get-RequiredTools
    $account = Initialize-GitHubAuthentication -Tools $tools
    $repoRoot = Initialize-Repository `
        -RepoRoot $repositoryFull `
        -Tools $tools `
        -Account $account `
        -RecoveryRepoRoot $recoveryRepositoryFull `
        -ForbiddenPaths @($release.Root, $PSScriptRoot)

    $activeRepositoryNormalized = Get-NormalizedPath $repoRoot
    if ($releaseNormalized -eq $activeRepositoryNormalized -or
        $releaseNormalized.StartsWith($activeRepositoryNormalized + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $activeRepositoryNormalized.StartsWith($releaseNormalized + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The release source and active publishing clone must be separate directories.'
    }

    $publisher = Join-Path $release.Root 'scripts\Publish-HelmsmanRelease.ps1'
    if (!(Test-Path -LiteralPath $publisher -PathType Leaf)) {
        throw 'The guarded publisher is missing from the extracted Helmsman release.'
    }
    $publisherItem = Get-Item -LiteralPath $publisher -Force
    if (($publisherItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The guarded publisher in the extracted release cannot be a symlink or reparse point.'
    }
    $publisherNormalized = Get-NormalizedPath $publisherItem.FullName
    if (!$publisherNormalized.StartsWith($releaseNormalized + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The guarded publisher escaped the validated release root.'
    }
    $publisherSha256 = (Get-FileHash -LiteralPath $publisherItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($publisherSha256 -cne $script:ExpectedPublisherSha256) {
        throw 'The guarded publisher does not match the publisher bound to this launcher.'
    }

    Write-Step "Starting the guarded publisher for $($release.Tag)"
    Write-Host 'The guarded publisher will validate the source, retain its final PUBLISH confirmation, and require hosted CI before tagging.' -ForegroundColor Yellow
    $publisherParameters = @{
        SourcePath = $release.Root
        RepositoryPath = $repoRoot
        DeploymentHost = $DeploymentHost
        DeploymentUser = $DeploymentUser
        DeploymentRoot = $DeploymentRoot
    }
    & $publisher @publisherParameters
}

function Invoke-HelmsmanBootstrap {
    if ($env:OS -cne 'Windows_NT') {
        throw 'This portable launcher is intended for Windows PowerShell 5.1 on Windows.'
    }

    $mutex = [Threading.Mutex]::new($false, 'Local\HelmsmanReleasePublisher')
    $ownsMutex = $false
    try {
        try {
            $ownsMutex = $mutex.WaitOne(0, $false)
        }
        catch [Threading.AbandonedMutexException] {
            $ownsMutex = $true
        }
        if (!$ownsMutex) {
            throw 'Another Helmsman publisher is already running in this Windows session.'
        }
        Invoke-HelmsmanBootstrapCore
    }
    finally {
        if ($ownsMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

# Dot-sourcing exposes the safe helper functions for offline contract tests.
if ($MyInvocation.InvocationName -eq '.') { return }

try {
    $gitHooksIsolation = $null
    try {
        # Keep Git hooks disabled for repository setup and for the nested guarded
        # publisher. Its own nested scope restores these exact outer values.
        $gitHooksIsolation = Enter-GitHooksIsolation
        if ($SelfTest) {
            Invoke-LauncherSelfTest
        }
        else {
            Invoke-HelmsmanBootstrap
        }
    }
    finally {
        if ($null -ne $gitHooksIsolation) {
            Exit-GitHooksIsolation -Scope $gitHooksIsolation
        }
    }
}
catch {
    Write-Host ''
    Write-Host ('Publisher launcher stopped: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
