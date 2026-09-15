#requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SourcePath,
    [string]$RepositoryPath,
    [switch]$SkipLocalTests,
    [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Repository = 'nunesg130-boop/helmsman'
$GitHubLogin = 'nunesg130-boop'
$MinimumGitHubCliVersion = [version]'2.57.0'
$Workflow = 'container.yml'

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host ''
    Write-Host ('=> ' + $Message) -ForegroundColor Cyan
}

function Get-RequiredApplication {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$InstallHint
    )

    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $command) {
        throw "Required command '$Name' was not found. $InstallHint"
    }
    return $command.Source
}

function Invoke-NativeProbe {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )

    $stdoutRecords = @()
    $exitCode = -1
    $stderrPath = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 can convert normal Git progress on stderr into
        # NativeCommandError records. Native success is determined only from
        # LASTEXITCODE, captured immediately after the process finishes.
        $ErrorActionPreference = 'Continue'
        $stdoutRecords = @(& $FilePath @ArgumentList 2> $stderrPath)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    try {
        $stdout = (($stdoutRecords | ForEach-Object { $_.ToString() }) -join "`n").Trim()
        $stderr = if (Test-Path -LiteralPath $stderrPath) {
            ([IO.File]::ReadAllText($stderrPath)).Trim()
        }
        else {
            ''
        }
        $text = if ($exitCode -eq 0) {
            $stdout
        }
        else {
            (@($stdout, $stderr) | Where-Object { ![string]::IsNullOrWhiteSpace($_) }) -join "`n"
        }
        return [PSCustomObject]@{
            ExitCode = $exitCode
            Text = $text
            StdOut = $stdout
            StdErr = $stderr
        }
    }
    finally {
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
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
    return $result.Text
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

function Invoke-NativeJson {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    $stderrPath = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
    $stdoutRecords = @()
    $exitCode = -1
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $stdoutRecords = @(& $FilePath @ArgumentList 2> $stderrPath)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    try {
        $stdout = (($stdoutRecords | ForEach-Object { $_.ToString() }) -join "`n").Trim()
        $stderr = if (Test-Path -LiteralPath $stderrPath) {
            ([IO.File]::ReadAllText($stderrPath)).Trim()
        }
        else {
            ''
        }
        if ($exitCode -ne 0) {
            $detail = if ([string]::IsNullOrWhiteSpace($stderr)) { '' } else { "`n$stderr" }
            throw "$FailureMessage (exit code $exitCode).$detail"
        }
        if ([string]::IsNullOrWhiteSpace($stdout)) {
            throw "$FailureMessage returned no JSON."
        }
        try {
            $null = $stdout | ConvertFrom-Json
        }
        catch {
            throw "$FailureMessage returned invalid JSON."
        }
        return $stdout
    }
    finally {
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Assert-RequiredJsonProperties {
    param(
        $InputObject,
        [Parameter(Mandatory = $true)][string[]]$PropertyNames,
        [Parameter(Mandatory = $true)][string]$Context,
        [string[]]$NullablePropertyNames = @()
    )

    if ($null -eq $InputObject) {
        throw "$Context returned a null record."
    }
    foreach ($name in $PropertyNames) {
        $property = $InputObject.PSObject.Properties[$name]
        if ($null -eq $property) {
            throw "$Context is missing the required '$name' property."
        }
        if ($null -eq $property.Value -and $NullablePropertyNames -notcontains $name) {
            throw "$Context returned null for the required '$name' property."
        }
    }
}

function ConvertFrom-GitHubRunListJson {
    param(
        [Parameter(Mandatory = $true)][string]$Json,
        [Parameter(Mandatory = $true)][string]$Context
    )

    $trimmed = $Json.Trim()
    if (!$trimmed.StartsWith('[') -or !$trimmed.EndsWith(']')) {
        throw "$Context did not return a JSON array."
    }
    try {
        $parsedRuns = $trimmed | ConvertFrom-Json
    }
    catch {
        throw "$Context returned invalid JSON."
    }

    # Windows PowerShell 5.1 emits a top-level JSON array as one pipeline
    # object. Write-Output deliberately enumerates that object so [] becomes
    # zero records instead of one empty Object[] record under StrictMode.
    $rawRuns = @($parsedRuns | Write-Output)
    $runs = @()
    foreach ($rawRun in $rawRuns) {
        Assert-RequiredJsonProperties -InputObject $rawRun -PropertyNames @(
            'databaseId', 'headBranch', 'headSha'
        ) -Context $Context
        $databaseId = [string]$rawRun.databaseId
        $headBranch = [string]$rawRun.headBranch
        $headSha = [string]$rawRun.headSha
        if ($databaseId -notmatch '^[1-9][0-9]*$') {
            throw "$Context returned an invalid databaseId."
        }
        if ([string]::IsNullOrWhiteSpace($headBranch) -or $headBranch -match '[\x00-\x1f\x7f]') {
            throw "$Context returned an invalid headBranch."
        }
        if ($headSha -notmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$') {
            throw "$Context returned an invalid headSha."
        }
        $runs += [PSCustomObject]@{
            DatabaseId = $databaseId
            HeadBranch = $headBranch
            HeadSha = $headSha
        }
    }
    return @($runs)
}

function ConvertFrom-GitHubRunViewJson {
    param(
        [Parameter(Mandatory = $true)][string]$Json,
        [Parameter(Mandatory = $true)][string]$Context
    )

    $trimmed = $Json.Trim()
    if (!$trimmed.StartsWith('{') -or !$trimmed.EndsWith('}')) {
        throw "$Context did not return a JSON object."
    }
    try {
        $view = $trimmed | ConvertFrom-Json
    }
    catch {
        throw "$Context returned invalid JSON."
    }
    Assert-RequiredJsonProperties -InputObject $view -PropertyNames @(
        'conclusion', 'headBranch', 'headSha', 'event', 'status'
    ) -NullablePropertyNames @('conclusion') -Context $Context

    $headBranch = [string]$view.headBranch
    $headSha = [string]$view.headSha
    $eventName = [string]$view.event
    $status = [string]$view.status
    $conclusion = [string]$view.conclusion
    if ([string]::IsNullOrWhiteSpace($headBranch) -or $headBranch -match '[\x00-\x1f\x7f]') {
        throw "$Context returned an invalid headBranch."
    }
    if ($headSha -notmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$') {
        throw "$Context returned an invalid headSha."
    }
    if ([string]::IsNullOrWhiteSpace($eventName) -or [string]::IsNullOrWhiteSpace($status)) {
        throw "$Context returned an invalid workflow event or status."
    }
    return [PSCustomObject]@{
        Conclusion = $conclusion
        HeadBranch = $headBranch
        HeadSha = $headSha
        Event = $eventName
        Status = $status
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

function ConvertTo-PowerShellLiteral {
    param([Parameter(Mandatory = $true)][string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function Get-SafeRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$FullName
    )

    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
    $candidate = [IO.Path]::GetFullPath($FullName)
    $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
    if (!$candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A release path escaped its validated root.'
    }
    $relative = $candidate.Substring($prefix.Length).Replace('\', '/')
    if ($relative -match '[\x00-\x1f\x7f]') {
        throw 'Release paths cannot contain control characters.'
    }
    return $relative
}

function Join-SafePath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $nativeRelative = $RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
    $candidate = [IO.Path]::GetFullPath((Join-Path $Root $nativeRelative))
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
    $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
    if (!$candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe relative path was rejected: $RelativePath"
    }
    $current = $rootFull
    foreach ($segment in @($RelativePath.Replace('\', '/').Split('/') | Where-Object { $_ -ne '' })) {
        $current = Join-Path $current $segment
        $existing = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($null -eq $existing) { break }
        if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "A symlink or reparse point was rejected: $RelativePath"
        }
    }
    return $candidate
}

function Get-RegularTreeEntries {
    param([Parameter(Mandatory = $true)][string]$Root)

    $entries = @()
    foreach ($entry in @(Get-ChildItem -LiteralPath $Root -Force)) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'The source release cannot contain symlinks or reparse points.'
        }
        $entries += $entry
        if ($entry.PSIsContainer) {
            $entries += @(Get-RegularTreeEntries -Root $entry.FullName)
        }
    }
    return $entries
}

function Test-ProhibitedReleasePath {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $normalized = $RelativePath.Replace('\', '/').TrimStart('/').ToLowerInvariant()
    $segments = @($normalized.Split('/') | Where-Object { $_ -ne '' })
    if ($segments.Count -eq 0) { return $true }
    $name = $segments[$segments.Count - 1]

    foreach ($segment in $segments) {
        if ($segment -in @(
            '.aws', '.docker', '.git', '.idea', '.nyc_output', '.ssh', '.vscode',
            'backup', 'backups', 'coverage', 'data', 'node_modules', '.helmsman-data'
        )) {
            return $true
        }
    }
    if ($segments.Count -ge 2 -and $segments[0] -eq '.config' -and $segments[1] -eq 'gh') { return $true }

    if ($name -eq '.env') { return $true }
    if ($name.StartsWith('.env.') -and $name -ne '.env.example') { return $true }
    if ($name -in @(
        '.ds_store', '.git-credentials', '.netrc', '.npmrc', '.pypirc', '_netrc',
        'authorized_keys', 'known_hosts', 'thumbs.db'
    )) { return $true }
    if ($name -match '^id_(?:rsa|dsa|ecdsa|ed25519(?:_sk)?)(?:[.]pub)?$') { return $true }
    if ($name -in @('state.json', 'sessions.json', 'credentials.json', 'credentials.key', 'master-key.hex')) {
        return $true
    }
    if ($name -match '^(?:state|sessions|credentials)\.(?:json|key)(?:[.-].*)?$') { return $true }
    if ($name -match '^master-key\.hex(?:[.-].*)?$') { return $true }
    if ($name -match '\.(key|pem|crt|cer|p12|pfx|log|zip|tar|tgz)$') { return $true }
    if ($name -match '\.tar\.gz$') { return $true }
    if ($name -match '\.(corrupt|unrecoverable)-') { return $true }
    return $false
}

function Assert-NoProhibitedPaths {
    param(
        [Parameter(Mandatory = $true)][string[]]$RelativePaths,
        [Parameter(Mandatory = $true)][string]$Context
    )

    $blocked = @($RelativePaths | Where-Object { Test-ProhibitedReleasePath -RelativePath $_ })
    if ($blocked.Count -gt 0) {
        throw "$Context contains a prohibited secret, runtime, dependency, backup, or archive path: $($blocked[0])"
    }
}

function Assert-NoEmbeddedSecrets {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string[]]$RelativePaths,
        [Parameter(Mandatory = $true)][string]$Context
    )

    $textExtensions = @(
        '.cjs', '.conf', '.config', '.cs', '.css', '.env', '.example', '.go',
        '.gradle', '.html', '.ini', '.java', '.js', '.json', '.jsx', '.md',
        '.mjs', '.properties', '.ps1', '.py', '.rb', '.rs', '.sh', '.svg',
        '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml'
    )
    $textNames = @('dockerfile', 'caddyfile', '.dockerignore', '.gitattributes', '.gitignore')
    $patterns = @(
        [PSCustomObject]@{ Label = 'private key material'; Pattern = '-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?' + 'PRIVATE KEY-----' },
        [PSCustomObject]@{ Label = 'PGP private key material'; Pattern = '-----BEGIN PGP ' + 'PRIVATE KEY BLOCK-----' },
        [PSCustomObject]@{ Label = 'GitHub classic token'; Pattern = ('gh' + '[pousr]_') + '[A-Za-z0-9]{20,}' },
        [PSCustomObject]@{ Label = 'GitHub fine-grained token'; Pattern = ('github' + '_pat_') + '[A-Za-z0-9_]{20,}' },
        [PSCustomObject]@{ Label = 'AWS access key ID'; Pattern = ('(?:AK' + 'IA|AS' + 'IA)') + '[A-Z0-9]{16}' },
        [PSCustomObject]@{ Label = 'npm access token'; Pattern = ('np' + 'm_') + '[A-Za-z0-9]{30,}' },
        [PSCustomObject]@{ Label = 'plaintext access or edge token assignment'; Pattern = '(?m)^\s*(?:HELMSMAN_ACCESS_KEY|CLOUDFLARE_API_TOKEN|CF_API_TOKEN)\s*=\s*\S+' }
    )

    foreach ($relative in $RelativePaths) {
        $fullName = Join-SafePath -Root $Root -RelativePath $relative
        if (!(Test-Path -LiteralPath $fullName -PathType Leaf)) { continue }
        $item = Get-Item -LiteralPath $fullName
        $extension = [IO.Path]::GetExtension($item.Name).ToLowerInvariant()
        if (($textExtensions -notcontains $extension) -and ($textNames -notcontains $item.Name.ToLowerInvariant())) {
            continue
        }
        if ($item.Length -gt 5MB) {
            throw "$Context contains an oversized text file that cannot be safely scanned: $relative"
        }
        $content = [IO.File]::ReadAllText($item.FullName)
        foreach ($candidate in $patterns) {
            if ([regex]::IsMatch($content, $candidate.Pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
                throw "$Context contains $($candidate.Label) in $relative. The matching value was not displayed."
            }
        }
    }
}

function Assert-RequiredTool {
    $git = Get-RequiredApplication -Name 'git.exe' -InstallHint 'Install Git for Windows, then reopen PowerShell.'
    $gh = Get-RequiredApplication -Name 'gh.exe' -InstallHint 'Install GitHub CLI, then reopen PowerShell.'
    $versionOutput = Invoke-NativeText -FilePath $gh -ArgumentList @('--version') -FailureMessage 'GitHub CLI version check'
    $versionMatch = [regex]::Match(
        $versionOutput,
        '(?m)^gh version (?<version>[0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)'
    )
    if (!$versionMatch.Success) {
        throw 'GitHub CLI returned an unrecognized version string.'
    }
    try {
        $githubVersion = [version]$versionMatch.Groups['version'].Value
    }
    catch {
        throw 'GitHub CLI returned an invalid version number.'
    }
    if ($githubVersion -lt $MinimumGitHubCliVersion) {
        throw "GitHub CLI $MinimumGitHubCliVersion or newer is required for unambiguous active-account verification; found $githubVersion. Update GitHub CLI, then retry."
    }
    return [PSCustomObject]@{ Git = $git; GitHub = $gh }
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

function Assert-ExpectedHttpsRepositoryUrl {
    param(
        [Parameter(Mandatory = $true)][string]$RemoteUrl,
        [Parameter(Mandatory = $true)][string]$ExpectedRepository,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $value = $RemoteUrl.Trim().TrimEnd('/')
    $expectedUrl = 'https://github.com/' + $ExpectedRepository.ToLowerInvariant() + '.git'
    if (![string]::Equals($value, $expectedUrl, [StringComparison]::Ordinal)) {
        throw "$Description must use the credential-free HTTPS URL $expectedUrl. SSH, embedded credentials, alternate hosts, and Git URL rewrites are not allowed."
    }
}

function Assert-NoGitHubCredentialOverrides {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)][string]$ExpectedRepository
    )

    $expectedUrl = 'https://github.com/' + $ExpectedRepository.ToLowerInvariant() + '.git'
    $extraHeaderProbe = Invoke-NativeProbe -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'config', '--get-urlmatch', 'http.extraHeader', $expectedUrl
    )
    if ($extraHeaderProbe.ExitCode -eq 0) {
        $extraHeaderProbe = $null
        throw 'An effective GitHub HTTP extraHeader is configured. Remove the credential-bearing override before publishing; its value was not displayed.'
    }
    if ($extraHeaderProbe.ExitCode -ne 1) {
        throw 'The effective GitHub HTTP extraHeader check failed.'
    }
    $extraHeaderProbe = $null

    $localHelperProbe = Invoke-NativeProbe -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'config', '--local', '--name-only', '--get-regexp',
        '^credential(\..*)?\.helper$'
    )
    if ($localHelperProbe.ExitCode -eq 0) {
        throw 'The publishing clone has a repository-local credential helper override. Remove it before publishing; no credential value was displayed.'
    }
    if ($localHelperProbe.ExitCode -ne 1) {
        throw 'The repository-local credential helper check failed.'
    }

    $worktreeHelperProbe = Invoke-NativeProbe -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'config', '--worktree', '--name-only', '--get-regexp',
        '^credential(\..*)?\.helper$'
    )
    if ($worktreeHelperProbe.ExitCode -eq 0) {
        throw 'The publishing clone has a worktree-specific credential helper override. Remove it before publishing; no credential value was displayed.'
    }
    if ($worktreeHelperProbe.ExitCode -ne 1) {
        throw 'The worktree-specific credential helper check failed.'
    }
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

function Get-CanonicalRepository {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)][string]$ExpectedRepository
    )

    $gitMetadataPath = Join-Path $RepoRoot '.git'
    if (!(Test-Path -LiteralPath $gitMetadataPath -PathType Container)) {
        throw 'The publishing repository must be a regular Git clone.'
    }
    $gitMetadata = Get-Item -LiteralPath $gitMetadataPath -Force
    if (($gitMetadata.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The repository Git metadata cannot be a symlink or reparse point.'
    }
    $gitRoot = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'rev-parse', '--show-toplevel') -FailureMessage 'Git repository discovery'
    if ((Get-NormalizedPath $gitRoot) -ne (Get-NormalizedPath $RepoRoot)) {
        throw 'The selected publishing repository is not its Git clone root.'
    }
    $branch = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'branch', '--show-current') -FailureMessage 'Current branch discovery'
    if ($branch -cne 'main') {
        throw "The Helmsman repository must be on main, not '$branch'."
    }
    $originText = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'remote', 'get-url', '--all', 'origin') -FailureMessage 'Origin remote discovery'
    $origins = @($originText -split "`r?`n" | Where-Object { $_ -ne '' })
    if ($origins.Count -ne 1) {
        throw 'The origin remote must have exactly one canonical fetch URL.'
    }
    Assert-ExpectedHttpsRepositoryUrl `
        -RemoteUrl $origins[0] `
        -ExpectedRepository $ExpectedRepository `
        -Description 'The effective origin fetch URL'
    $slug = ConvertTo-GitHubSlug -RemoteUrl $origins[0]
    if ($slug -cne $ExpectedRepository.ToLowerInvariant()) {
        throw 'The origin remote does not point to the expected Helmsman repository.'
    }
    $pushOriginText = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'remote', 'get-url', '--push', '--all', 'origin') -FailureMessage 'Origin push-remote discovery'
    $pushOrigins = @($pushOriginText -split "`r?`n" | Where-Object { $_ -ne '' })
    if ($pushOrigins.Count -ne 1) {
        throw 'The origin remote must have exactly one canonical push URL.'
    }
    Assert-ExpectedHttpsRepositoryUrl `
        -RemoteUrl $pushOrigins[0] `
        -ExpectedRepository $ExpectedRepository `
        -Description 'The effective origin push URL'
    $pushSlug = ConvertTo-GitHubSlug -RemoteUrl $pushOrigins[0]
    if ($pushSlug -cne $ExpectedRepository.ToLowerInvariant()) {
        throw 'The origin push URL does not point to the expected Helmsman repository.'
    }
    Assert-NoGitHubCredentialOverrides `
        -RepoRoot $RepoRoot `
        -Tools $Tools `
        -ExpectedRepository $ExpectedRepository
    $mirror = Invoke-NativeProbe -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'config', '--bool', '--get', 'remote.origin.mirror')
    if ($mirror.ExitCode -eq 0 -and $mirror.Text -ceq 'true') {
        throw 'remote.origin.mirror must not be enabled for guarded releases.'
    }
    if ($mirror.ExitCode -notin @(0, 1)) {
        throw 'The origin mirror-mode check failed.'
    }
    return [PSCustomObject]@{ Root = $RepoRoot; Branch = $branch; Slug = $slug }
}

function Assert-GitHubAuthentication {
    param(
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedRepository,
        [Parameter(Mandatory = $true)][string]$ExpectedLogin
    )

    foreach ($environmentOverride in @('GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR')) {
        $ambientValue = [Environment]::GetEnvironmentVariable($environmentOverride, 'Process')
        if (![string]::IsNullOrWhiteSpace($ambientValue)) {
            throw "The $environmentOverride environment variable is set. Clear it so GitHub CLI and Git use the verified github.com keyring account. Its value was not displayed."
        }
    }

    $status = Invoke-NativeProbe -FilePath $Tools.GitHub -ArgumentList @(
        'auth', 'status', '--active', '--hostname', 'github.com'
    )
    if ($status.ExitCode -ne 0) {
        throw 'GitHub CLI does not have a valid active github.com account. Run the root Publish-Helmsman launcher to authenticate, then retry.'
    }
    $statusText = (@($status.StdOut, $status.StdErr) |
        Where-Object { ![string]::IsNullOrWhiteSpace($_) }) -join "`n"
    if (!(Test-GitHubAuthenticationScope -StatusText $statusText -RequiredScope 'repo') -or
        !(Test-GitHubAuthenticationScope -StatusText $statusText -RequiredScope 'workflow')) {
        throw 'The active GitHub CLI account does not report the repo and workflow permissions. Run the root Publish-Helmsman launcher to refresh authorization.'
    }

    $login = (Invoke-NativeText -FilePath $Tools.GitHub -ArgumentList @(
        'api', 'user', '--jq', '.login'
    ) -FailureMessage 'GitHub account lookup').Trim()
    if ($login -cne $ExpectedLogin) {
        throw "GitHub CLI is authenticated as '$login', not '$ExpectedLogin'. Switch the active github.com account, then retry."
    }

    $repositorySelector = 'github.com/' + $ExpectedRepository
    $repositoryJson = Invoke-NativeJson -FilePath $Tools.GitHub -ArgumentList @(
        'repo', 'view', $repositorySelector,
        '--json', 'nameWithOwner,viewerPermission,defaultBranchRef,isArchived'
    ) -FailureMessage 'GitHub repository access check'
    $repository = $repositoryJson | ConvertFrom-Json
    Assert-RequiredJsonProperties `
        -InputObject $repository `
        -PropertyNames @('nameWithOwner', 'viewerPermission', 'defaultBranchRef', 'isArchived') `
        -Context 'GitHub repository access check'
    if (([string]$repository.nameWithOwner).ToLowerInvariant() -cne
        $ExpectedRepository.ToLowerInvariant()) {
        throw 'GitHub CLI resolved a different repository than expected.'
    }
    if ([string]$repository.viewerPermission -cnotin @('WRITE', 'MAINTAIN', 'ADMIN')) {
        throw 'The active GitHub CLI account does not have permission to publish to the Helmsman repository.'
    }
    if ($null -eq $repository.defaultBranchRef.PSObject.Properties['name'] -or
        [string]$repository.defaultBranchRef.name -cne 'main') {
        throw 'The Helmsman repository default branch is not main.'
    }
    if ($repository.PSObject.Properties['isArchived'].Value -isnot [bool]) {
        throw 'GitHub repository metadata contains an invalid archive state.'
    }
    if ([bool]$repository.isArchived) {
        throw 'The Helmsman repository is archived and cannot accept a release.'
    }

    Invoke-NativeLive -FilePath $Tools.GitHub -ArgumentList @(
        'auth', 'setup-git', '--hostname', 'github.com'
    ) -FailureMessage 'GitHub Git credential setup'

    Assert-NoGitHubCredentialOverrides `
        -RepoRoot $RepoRoot `
        -Tools $Tools `
        -ExpectedRepository $ExpectedRepository
    $expectedUrl = 'https://github.com/' + $ExpectedRepository.ToLowerInvariant() + '.git'
    $effectiveUrl = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'ls-remote', '--get-url', $expectedUrl
    ) -FailureMessage 'Effective authenticated HTTPS URL check'
    Assert-ExpectedHttpsRepositoryUrl `
        -RemoteUrl $effectiveUrl `
        -ExpectedRepository $ExpectedRepository `
        -Description 'The effective authenticated repository URL'
    $remoteMain = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'ls-remote', '--exit-code', $expectedUrl, 'refs/heads/main'
    ) -FailureMessage 'Authenticated HTTPS access to the Helmsman repository'
    $remoteMainLines = @($remoteMain -split "`r?`n" | Where-Object { $_ -ne '' })
    if ($remoteMainLines.Count -ne 1 -or
        $remoteMainLines[0] -notmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})\s+refs/heads/main$') {
        throw 'The authenticated Helmsman repository did not return one valid main branch reference.'
    }
}

function Assert-CleanMainAtOrigin {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools
    )

    $status = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'status', '--porcelain=v1', '--untracked-files=all') -FailureMessage 'Git status check'
    if (![string]::IsNullOrWhiteSpace($status)) {
        throw 'The Helmsman clone has uncommitted or untracked files. Commit, move, or remove them before publishing.'
    }
    Invoke-NativeLive -FilePath $Tools.Git -ArgumentList @(
        '-C', $RepoRoot, 'fetch', '--no-tags', '--no-prune', '--recurse-submodules=no', 'origin',
        'refs/heads/main:refs/remotes/origin/main'
    ) -FailureMessage 'Exact fetch of origin/main'
    Invoke-NativeLive -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'merge', '--ff-only', '--no-edit', 'refs/remotes/origin/main') -FailureMessage 'Fast-forward merge of origin/main'
    $afterPull = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'status', '--porcelain=v1', '--untracked-files=all') -FailureMessage 'Post-pull Git status check'
    if (![string]::IsNullOrWhiteSpace($afterPull)) {
        throw 'The Helmsman clone changed unexpectedly while synchronizing main.'
    }
    $localHead = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'rev-parse', 'HEAD') -FailureMessage 'Local main identity check'
    $remoteHead = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'rev-parse', 'refs/remotes/origin/main') -FailureMessage 'Remote main identity check'
    if ($localHead -cne $remoteHead) {
        throw 'Local main is ahead of or differs from origin/main. Publish only from an exact clean clone of origin/main.'
    }
}

function Assert-GitAuthor {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools
    )

    $userName = Invoke-NativeProbe -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'config', '--get', 'user.name')
    $userEmail = Invoke-NativeProbe -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'config', '--get', 'user.email')
    if ($userName.ExitCode -ne 0 -or $userEmail.ExitCode -ne 0 -or
        [string]::IsNullOrWhiteSpace($userName.Text) -or [string]::IsNullOrWhiteSpace($userEmail.Text)) {
        throw 'Configure git user.name and user.email in this clone before publishing.'
    }
}

function Get-ValidatedSourceRelease {
    param([Parameter(Mandatory = $true)][string]$SourceRoot)

    foreach ($required in @(
        'package.json',
        'compose.yaml',
        'container.env.example',
        '.gitattributes',
        '.github/workflows/container.yml',
        'Publish-Helmsman.ps1',
        'Publish-Helmsman.cmd',
        'scripts/Publish-HelmsmanRelease.ps1'
    )) {
        if (!(Test-Path -LiteralPath (Join-SafePath -Root $SourceRoot -RelativePath $required) -PathType Leaf)) {
            throw "The source release is missing $required. Select the extracted inner helmsman folder."
        }
    }

    $rootItem = Get-Item -LiteralPath $SourceRoot
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The source release root cannot be a symlink or reparse point.'
    }

    $entries = @(Get-RegularTreeEntries -Root $SourceRoot)
    $relativePaths = @($entries | ForEach-Object { Get-SafeRelativePath -Root $SourceRoot -FullName $_.FullName })
    Assert-NoProhibitedPaths -RelativePaths $relativePaths -Context 'The source release'
    $sourceFiles = @($entries | Where-Object { !$_.PSIsContainer } | ForEach-Object { Get-SafeRelativePath -Root $SourceRoot -FullName $_.FullName })
    $sourcePathKeys = @{}
    foreach ($relative in $sourceFiles) {
        $key = $relative.ToLowerInvariant()
        if ($sourcePathKeys.ContainsKey($key)) {
            throw "The source release contains case-colliding files: $relative"
        }
        $sourcePathKeys[$key] = $true
    }
    Assert-NoEmbeddedSecrets -Root $SourceRoot -RelativePaths $sourceFiles -Context 'The source release'

    try {
        $package = Get-Content -LiteralPath (Join-Path $SourceRoot 'package.json') -Raw | ConvertFrom-Json
    }
    catch {
        throw 'The source package.json is not valid JSON.'
    }
    Assert-RequiredJsonProperties -InputObject $package -PropertyNames @('name', 'version') -Context 'The source package.json'
    if ([string]$package.name -cne 'helmsman') {
        throw 'The source package name is not helmsman.'
    }
    $version = [string]$package.version
    $semver = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$'
    if ($version -notmatch $semver) {
        throw "The source package version is not release-safe SemVer: $version"
    }
    $expectedImage = "ghcr.io/OWNER/REPOSITORY:$version"
    $composeText = [IO.File]::ReadAllText((Join-Path $SourceRoot 'compose.yaml'))
    $composeImageLines = @([regex]::Matches($composeText, '(?m)^[ \t]*image[ \t]*:[^\r\n]*\r?$'))
    $expectedComposePattern = '(?m)^    image: "\$\{HELMSMAN_IMAGE:-' + [regex]::Escape($expectedImage) + '\}"[ \t]*\r?$'
    if ($composeImageLines.Count -ne 1 -or ![regex]::IsMatch($composeText, $expectedComposePattern)) {
        throw "compose.yaml must contain exactly one active Helmsman image field using $expectedImage."
    }
    $environmentText = [IO.File]::ReadAllText((Join-Path $SourceRoot 'container.env.example'))
    $environmentImageLines = @([regex]::Matches($environmentText, '(?m)^[ \t]*(?:export[ \t]+)?HELMSMAN_IMAGE[ \t]*=[^\r\n]*\r?$'))
    $expectedEnvironmentPattern = '(?m)^HELMSMAN_IMAGE=' + [regex]::Escape($expectedImage) + '[ \t]*\r?$'
    if ($environmentImageLines.Count -ne 1 -or ![regex]::IsMatch($environmentText, $expectedEnvironmentPattern)) {
        throw "container.env.example must contain exactly one active HELMSMAN_IMAGE assignment using $expectedImage."
    }
    $attributesText = [IO.File]::ReadAllText((Join-Path $SourceRoot '.gitattributes'))
    if ($attributesText -match '(?im)(?:^|\s)[-!]?filter(?:=|\s|$)') {
        throw 'The source .gitattributes cannot invoke an external Git content filter.'
    }
    return [PSCustomObject]@{
        Root = $SourceRoot
        Version = $version
        Tag = 'v' + $version
        Files = $sourceFiles
    }
}

function Assert-ReleaseIsNew {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)][string]$ExpectedRepository,
        [Parameter(Mandatory = $true)][string]$Tag
    )

    $repositorySelector = 'github.com/' + $ExpectedRepository
    $localTag = Invoke-NativeProbe -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'show-ref', '--verify', '--quiet', "refs/tags/$Tag")
    if ($localTag.ExitCode -eq 0) { throw "The local release tag already exists: $Tag" }
    if ($localTag.ExitCode -ne 1) { throw 'The local release-tag check failed.' }

    $validRef = Invoke-NativeProbe -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'check-ref-format', "refs/tags/$Tag")
    if ($validRef.ExitCode -ne 0) { throw "The release tag is not a valid Git reference: $Tag" }

    $remoteTag = Invoke-NativeProbe -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'ls-remote', '--exit-code', '--tags', 'origin', "refs/tags/$Tag")
    if ($remoteTag.ExitCode -eq 0) { throw "The remote release tag already exists: $Tag" }
    if ($remoteTag.ExitCode -ne 2) { throw 'The remote release-tag check failed.' }

    $release = Invoke-NativeProbe -FilePath $Tools.GitHub -ArgumentList @('release', 'view', $Tag, '--repo', $repositorySelector, '--json', 'tagName')
    if ($release.ExitCode -eq 0) { throw "A GitHub release already exists for $Tag" }
    if (($release.Text -notmatch '(?i)(release not found|HTTP 404|not found)')) {
        throw "GitHub release lookup failed unexpectedly. $($release.Text)"
    }
}

function Remove-EmptyDirectoryTree {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path
    if (!$item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'Only a regular destination directory can be replaced by a release file.'
    }
    foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) {
        if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "A reparse point blocks replacement of $Path."
        }
        if (!$child.PSIsContainer) {
            throw "An untracked file blocks replacement of $Path."
        }
        Remove-EmptyDirectoryTree -Path $child.FullName
    }
    Remove-Item -LiteralPath $item.FullName -Force
}

function Sync-SourceTree {
    param(
        [Parameter(Mandatory = $true)]$Release,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)][string]$PublisherPath
    )

    $trackedText = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'ls-files') -FailureMessage 'Tracked-file inventory'
    $tracked = @($trackedText -split "`r?`n" | Where-Object { $_ -ne '' })
    Assert-NoProhibitedPaths -RelativePaths $tracked -Context 'The tracked repository'

    $existingModes = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'ls-files', '--stage') -FailureMessage 'Existing index-mode inspection'
    if ($existingModes -match '(?m)^(120000|160000) ') {
        throw 'The repository contains a tracked symlink or nested Git repository.'
    }
    foreach ($relative in @($tracked + $Release.Files | Sort-Object -Unique)) {
        $null = Join-SafePath -Root $RepoRoot -RelativePath $relative
    }

    foreach ($relative in $tracked) {
        if ($relative -ieq $publisherPath -and !(Test-Path -LiteralPath (Join-SafePath -Root $Release.Root -RelativePath $relative) -PathType Leaf)) {
            continue
        }
        $sourceFile = Join-SafePath -Root $Release.Root -RelativePath $relative
        if (!(Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
            $destinationFile = Join-SafePath -Root $RepoRoot -RelativePath $relative
            if (Test-Path -LiteralPath $destinationFile -PathType Leaf) {
                Remove-Item -LiteralPath $destinationFile -Force
            }
        }
    }

    foreach ($relative in $Release.Files) {
        $sourceFile = Join-SafePath -Root $Release.Root -RelativePath $relative
        $destinationFile = Join-SafePath -Root $RepoRoot -RelativePath $relative
        if (Test-Path -LiteralPath $destinationFile -PathType Container) {
            Remove-EmptyDirectoryTree -Path $destinationFile
        }
        $destinationDirectory = Split-Path -Parent $destinationFile
        if (!(Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
            New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
        }
        Copy-Item -LiteralPath $sourceFile -Destination $destinationFile -Force
    }
}

function Stage-AndValidateRelease {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)]$Release,
        [Parameter(Mandatory = $true)][string]$PublisherPath
    )

    $pathsToStage = @($Release.Files)
    if ($pathsToStage -notcontains $PublisherPath) {
        $pathsToStage += $PublisherPath
    }
    foreach ($relative in $pathsToStage) {
        $attribute = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
            '-C', $RepoRoot, 'check-attr', '--all', '--', $relative
        ) -FailureMessage "Effective Git-attribute inspection for $relative"
        if ($attribute -match '(?m): filter:') {
            throw "A Git content filter is active for $relative. Release staging was refused."
        }
    }

    Invoke-NativeLive -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'add', '-A', '--', '.') -FailureMessage 'Git staging'

    $changed = Invoke-NativeProbe -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'diff', '--cached', '--quiet')
    if ($changed.ExitCode -eq 0) { throw 'The source release produced no staged changes.' }
    if ($changed.ExitCode -ne 1) { throw 'The staged-change check failed.' }

    Invoke-NativeLive -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'diff', '--cached', '--check') -FailureMessage 'Staged whitespace validation'

    $trackedText = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'ls-files') -FailureMessage 'Staged tracked-file inventory'
    $tracked = @($trackedText -split "`r?`n" | Where-Object { $_ -ne '' })
    Assert-NoProhibitedPaths -RelativePaths $tracked -Context 'The staged repository'

    $expectedPaths = @{}
    foreach ($relative in $Release.Files) {
        $key = $relative.ToLowerInvariant()
        if ($expectedPaths.ContainsKey($key)) {
            throw "The source release contains a case-colliding path: $relative"
        }
        $expectedPaths[$key] = $relative
    }
    if (!$expectedPaths.ContainsKey($PublisherPath.ToLowerInvariant())) {
        $expectedPaths[$PublisherPath.ToLowerInvariant()] = $PublisherPath
    }
    $trackedPaths = @{}
    foreach ($relative in $tracked) {
        $key = $relative.ToLowerInvariant()
        if ($trackedPaths.ContainsKey($key)) {
            throw "The staged release contains a case-colliding path: $relative"
        }
        $trackedPaths[$key] = $relative
    }
    foreach ($key in $expectedPaths.Keys) {
        if (!$trackedPaths.ContainsKey($key)) {
            throw "A validated source file is absent from the staged release: $($expectedPaths[$key])"
        }
    }
    foreach ($key in $trackedPaths.Keys) {
        if (!$expectedPaths.ContainsKey($key)) {
            throw "The staged release contains a file outside the validated source manifest: $($trackedPaths[$key])"
        }
    }

    $stageText = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'ls-files', '--stage') -FailureMessage 'Git index-mode inspection'
    if ($stageText -match '(?m)^(120000|160000) ') {
        throw 'The staged release contains a symlink or nested Git repository.'
    }

    foreach ($relative in $Release.Files) {
        $sourceFile = Join-SafePath -Root $Release.Root -RelativePath $relative
        $sourceBlob = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @(
            '-C', $RepoRoot, 'hash-object', "--path=$relative", '--', $sourceFile
        ) -FailureMessage "Source blob verification for $relative"
        $stagedBlob = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'rev-parse', ":$relative") -FailureMessage "Staged blob verification for $relative"
        if ($sourceBlob -cne $stagedBlob) {
            throw "The staged content does not match the validated source file: $relative"
        }
    }
    if ($Release.Files -notcontains $PublisherPath) {
        $publisherChange = Invoke-NativeProbe -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'diff', '--cached', '--quiet', '--', $PublisherPath)
        if ($publisherChange.ExitCode -ne 0) {
            throw 'The preserved publisher changed even though it was absent from the source release.'
        }
    }

    $indexRoot = Join-Path ([IO.Path]::GetTempPath()) ('helmsman-index-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $indexRoot
    try {
        $gitPrefix = $indexRoot.Replace('\', '/') + '/'
        Invoke-NativeLive -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'checkout-index', '--all', "--prefix=$gitPrefix") -FailureMessage 'Staged-index export'
        Assert-NoEmbeddedSecrets -Root $indexRoot -RelativePaths $tracked -Context 'The staged repository'

        try {
            $destinationPackage = Get-Content -LiteralPath (Join-Path $indexRoot 'package.json') -Raw | ConvertFrom-Json
        }
        catch {
            throw 'The staged package.json is not valid JSON.'
        }
        Assert-RequiredJsonProperties -InputObject $destinationPackage -PropertyNames @('version') -Context 'The staged package.json'
        if ([string]$destinationPackage.version -cne $Release.Version) {
            throw 'The staged package version does not match the validated source version.'
        }
    }
    finally {
        if (Test-Path -LiteralPath $indexRoot -PathType Container) {
            [IO.Directory]::Delete($indexRoot, $true)
        }
    }
    return Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'write-tree') -FailureMessage 'Reviewed staged tree identity'
}

function Assert-StagedTreeUnchanged {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)][string]$ExpectedTree
    )

    $actualTree = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'write-tree') -FailureMessage 'Post-test staged tree identity'
    if ($actualTree -cne $ExpectedTree) {
        throw 'The staged tree changed after it was reviewed. Nothing was committed or pushed.'
    }
}

function Assert-NoUnstagedReleaseChanges {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools
    )

    $unstaged = Invoke-NativeProbe -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'diff', '--quiet')
    if ($unstaged.ExitCode -eq 1) { throw 'Local tests changed a tracked file after staging.' }
    if ($unstaged.ExitCode -ne 0) { throw 'The post-test working-tree check failed.' }
    $untracked = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'ls-files', '--others', '--exclude-standard') -FailureMessage 'Post-test untracked-file check'
    if (![string]::IsNullOrWhiteSpace($untracked)) {
        throw 'Local tests created an unexpected untracked file.'
    }
}

function Invoke-LocalTestsIfAvailable {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)][bool]$Skip
    )

    if ($Skip) {
        Write-Warning 'Local npm tests were explicitly skipped. GitHub Actions will still gate both pushes.'
        return
    }
    $node = Get-RequiredApplication -Name 'node.exe' -InstallHint 'Install Node.js 24.19.x, or rerun with -SkipLocalTests to rely on GitHub Actions.'
    $npm = Get-RequiredApplication -Name 'npm.cmd' -InstallHint 'Install Node.js 24.19.x, or rerun with -SkipLocalTests to rely on GitHub Actions.'
    $nodeText = Invoke-NativeText -FilePath $node -ArgumentList @('-p', 'process.versions.node') -FailureMessage 'Node.js version check'
    try { $nodeVersion = [version]$nodeText }
    catch { throw "Node.js returned an invalid version: $nodeText" }
    if ($nodeVersion -lt [version]'24.19.0' -or $nodeVersion -ge [version]'25.0.0') {
        throw "Node.js 24.19.x is required for local release tests; found $nodeVersion."
    }
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) ('helmsman-tests-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $testRoot
    try {
        $gitPrefix = $testRoot.Replace('\', '/') + '/'
        Invoke-NativeLive -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'checkout-index', '--all', "--prefix=$gitPrefix") -FailureMessage 'Test-tree export'
        Invoke-NativeLive -FilePath $npm -ArgumentList @('--prefix', $testRoot, 'test') -FailureMessage 'Local Helmsman test suite'
    }
    finally {
        if (Test-Path -LiteralPath $testRoot -PathType Container) {
            [IO.Directory]::Delete($testRoot, $true)
        }
    }
    Assert-NoUnstagedReleaseChanges -RepoRoot $RepoRoot -Tools $Tools
}

function Show-StagedSummary {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)]$Release,
        [Parameter(Mandatory = $true)][string]$ExpectedRepository
    )

    Write-Host ''
    Write-Host 'Release summary' -ForegroundColor Green
    Write-Host "  Repository: $ExpectedRepository"
    Write-Host "  Source:     $($Release.Root)"
    Write-Host "  Version:    $($Release.Version)"
    Write-Host "  Tag:        $($Release.Tag)"
    Write-Host ''
    Invoke-NativeLive -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'diff', '--cached', '--name-status') -FailureMessage 'Staged file summary'
    Invoke-NativeLive -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'diff', '--cached', '--stat') -FailureMessage 'Staged change statistics'
}

function Confirm-Release {
    param([Parameter(Mandatory = $true)]$Release)
    Write-Warning 'The next step commits to main, pushes it, and may publish a public container after both workflow gates pass.'
    $answer = Read-Host "Type PUBLISH $($Release.Version) to continue"
    return $answer -ceq "PUBLISH $($Release.Version)"
}

function New-ReleaseCommit {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)]$Release,
        [Parameter(Mandatory = $true)][string]$ExpectedTree
    )

    Assert-GitAuthor -RepoRoot $RepoRoot -Tools $Tools
    $expectedTreeBeforeCommit = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'write-tree') -FailureMessage 'Staged tree identity'
    if ($expectedTreeBeforeCommit -cne $ExpectedTree) {
        throw 'The staged tree changed after confirmation. Nothing was committed or pushed.'
    }
    Invoke-NativeLive -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'commit', '-m', "Release Helmsman $($Release.Tag)") -FailureMessage 'Release commit'
    $commitSha = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'rev-parse', 'HEAD') -FailureMessage 'Release commit identity'
    $actualTree = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'rev-parse', 'HEAD^{tree}') -FailureMessage 'Committed tree identity'
    if ($actualTree -cne $ExpectedTree) {
        throw 'A Git hook changed the reviewed staged tree during commit. Nothing was pushed.'
    }
    $status = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'status', '--porcelain=v1', '--untracked-files=all') -FailureMessage 'Post-commit Git status check'
    if (![string]::IsNullOrWhiteSpace($status)) {
        throw 'The repository is not clean after the release commit. Nothing was pushed.'
    }
    return $commitSha
}

function Push-Main {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)][string]$CommitSha,
        [Parameter(Mandatory = $true)][string]$ExpectedRepository,
        [Parameter(Mandatory = $true)][string]$ExpectedLogin
    )

    $null = Get-CanonicalRepository `
        -RepoRoot $RepoRoot `
        -Tools $Tools `
        -ExpectedRepository $ExpectedRepository
    Assert-GitHubAuthentication `
        -Tools $Tools `
        -RepoRoot $RepoRoot `
        -ExpectedRepository $ExpectedRepository `
        -ExpectedLogin $ExpectedLogin
    Invoke-NativeLive -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'push', '--no-follow-tags', '--recurse-submodules=no', 'origin', "${CommitSha}:refs/heads/main") -FailureMessage 'Push of main'
    $remote = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'ls-remote', 'origin', 'refs/heads/main') -FailureMessage 'Remote main verification'
    $remoteSha = @($remote -split '\s+')[0]
    if ($remoteSha -cne $CommitSha) {
        throw 'Remote main does not point to the release commit after the push.'
    }
}

function Get-WorkflowRunIds {
    param(
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)][string]$ExpectedRepository,
        [Parameter(Mandatory = $true)][string]$WorkflowName,
        [Parameter(Mandatory = $true)][string]$CommitSha,
        [Parameter(Mandatory = $true)][string]$RefName
    )

    $repositorySelector = 'github.com/' + $ExpectedRepository
    $json = Invoke-NativeJson -FilePath $Tools.GitHub -ArgumentList @(
        'run', 'list', '--repo', $repositorySelector, '--workflow', $WorkflowName,
        '--event', 'push', '--commit', $CommitSha, '--limit', '100',
        '--json', 'databaseId,headBranch,headSha'
    ) -FailureMessage 'Existing GitHub workflow-run inventory'
    $runs = @(ConvertFrom-GitHubRunListJson -Json $json -Context 'Existing GitHub workflow-run inventory')
    return @($runs | Where-Object {
        $_.HeadSha -ceq $CommitSha -and $_.HeadBranch -ceq $RefName
    } | ForEach-Object { $_.DatabaseId })
}

function Wait-WorkflowForCommit {
    param(
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)][string]$ExpectedRepository,
        [Parameter(Mandatory = $true)][string]$WorkflowName,
        [Parameter(Mandatory = $true)][string]$CommitSha,
        [Parameter(Mandatory = $true)][string]$RefName,
        [string[]]$ExcludedRunIds = @(),
        [int]$DiscoveryTimeoutSeconds = 180,
        [int]$CompletionTimeoutSeconds = 3600
    )

    $repositorySelector = 'github.com/' + $ExpectedRepository
    $excluded = @{}
    foreach ($runId in $ExcludedRunIds) {
        $excluded[[string]$runId] = $true
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($DiscoveryTimeoutSeconds)
    $run = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        $json = Invoke-NativeJson -FilePath $Tools.GitHub -ArgumentList @(
            'run', 'list', '--repo', $repositorySelector, '--workflow', $WorkflowName,
            '--event', 'push', '--commit', $CommitSha, '--limit', '20',
            '--json', 'databaseId,headBranch,headSha'
        ) -FailureMessage 'GitHub workflow discovery'
        $runs = @(ConvertFrom-GitHubRunListJson -Json $json -Context 'GitHub workflow discovery')
        if ($runs.Count -gt 0) {
            $matchingRuns = @($runs | Where-Object {
                $_.HeadSha -ceq $CommitSha -and $_.HeadBranch -ceq $RefName
            } | Where-Object {
                !$excluded.ContainsKey($_.DatabaseId)
            })
            if ($matchingRuns.Count -gt 1) {
                throw "More than one push workflow matched $RefName at $CommitSha. Refusing to guess."
            }
            if ($matchingRuns.Count -eq 1) {
                $run = $matchingRuns[0]
            }
        }
        if ($null -ne $run) { break }
        Start-Sleep -Seconds 5
    }
    if ($null -eq $run) {
        throw "The $RefName workflow did not appear within $DiscoveryTimeoutSeconds seconds."
    }

    Write-Host "Waiting for $RefName workflow run $($run.DatabaseId)..."
    $completionDeadline = [DateTime]::UtcNow.AddSeconds($CompletionTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $completionDeadline) {
        $viewJson = Invoke-NativeJson -FilePath $Tools.GitHub -ArgumentList @(
            'run', 'view', $run.DatabaseId, '--repo', $repositorySelector,
            '--json', 'conclusion,headBranch,headSha,event,status'
        ) -FailureMessage 'GitHub workflow result verification'
        $view = ConvertFrom-GitHubRunViewJson -Json $viewJson -Context 'GitHub workflow result verification'
        if ($view.HeadSha -cne $CommitSha -or $view.HeadBranch -cne $RefName -or $view.Event -cne 'push') {
            throw "The $RefName workflow identity changed while it was being monitored."
        }
        if ($view.Status -ceq 'completed') {
            if ($view.Conclusion -cne 'success') {
                throw "The $RefName workflow completed with conclusion '$($view.Conclusion)'."
            }
            return $run.DatabaseId
        }
        Start-Sleep -Seconds 10
    }
    throw "The $RefName workflow did not complete within $CompletionTimeoutSeconds seconds."
}

function New-AndPushReleaseTag {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)]$Release,
        [Parameter(Mandatory = $true)][string]$CommitSha,
        [Parameter(Mandatory = $true)][string]$ExpectedRepository,
        [Parameter(Mandatory = $true)][string]$ExpectedLogin
    )

    $null = Get-CanonicalRepository `
        -RepoRoot $RepoRoot `
        -Tools $Tools `
        -ExpectedRepository $ExpectedRepository
    Assert-GitHubAuthentication `
        -Tools $Tools `
        -RepoRoot $RepoRoot `
        -ExpectedRepository $ExpectedRepository `
        -ExpectedLogin $ExpectedLogin
    Assert-ReleaseIsNew `
        -RepoRoot $RepoRoot `
        -Tools $Tools `
        -ExpectedRepository $ExpectedRepository `
        -Tag $Release.Tag
    Invoke-NativeLive -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'tag', '-a', $Release.Tag, '-m', "Helmsman $($Release.Tag)", $CommitSha) -FailureMessage 'Annotated release-tag creation'
    $tagObject = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'rev-parse', "refs/tags/$($Release.Tag)") -FailureMessage 'Annotated release-tag identity'
    Invoke-NativeLive -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'push', '--no-follow-tags', '--recurse-submodules=no', 'origin', "${tagObject}:refs/tags/$($Release.Tag)") -FailureMessage 'Release-tag push'
    $peeled = Invoke-NativeText -FilePath $Tools.Git -ArgumentList @('-C', $RepoRoot, 'ls-remote', 'origin', "refs/tags/$($Release.Tag)^{}") -FailureMessage 'Remote release-tag verification'
    $remoteSha = @($peeled -split '\s+')[0]
    if ($remoteSha -cne $CommitSha) {
        throw 'The remote annotated tag does not point to the validated release commit.'
    }
}

function Assert-PublishedRelease {
    param(
        [Parameter(Mandatory = $true)]$Tools,
        [Parameter(Mandatory = $true)][string]$ExpectedRepository,
        [Parameter(Mandatory = $true)]$Release,
        [Parameter(Mandatory = $true)][string]$DeploymentDirectory
    )

    $repositorySelector = 'github.com/' + $ExpectedRepository
    $json = Invoke-NativeJson -FilePath $Tools.GitHub -ArgumentList @(
        'release', 'view', $Release.Tag, '--repo', $repositorySelector,
        '--json', 'tagName,isDraft,isPrerelease,url,assets'
    ) -FailureMessage 'Published GitHub release verification'
    $published = $json | ConvertFrom-Json
    Assert-RequiredJsonProperties -InputObject $published -PropertyNames @(
        'tagName', 'isDraft', 'isPrerelease', 'url', 'assets'
    ) -Context 'Published GitHub release verification'
    foreach ($asset in @($published.assets | Write-Output)) {
        Assert-RequiredJsonProperties -InputObject $asset -PropertyNames @('name') -Context 'Published GitHub release asset'
    }
    $assetNames = @($published.assets | ForEach-Object { [string]$_.name })
    if ($assetNames.Count -ne 3) {
        throw 'The GitHub release must contain exactly the three deployment assets.'
    }
    foreach ($requiredAsset in @('compose.yaml', 'container.env.example', 'SHA256SUMS')) {
        if ($assetNames -notcontains $requiredAsset) {
            throw "The GitHub release is missing $requiredAsset."
        }
    }
    if ($published.tagName -cne $Release.Tag -or [bool]$published.isDraft) {
        throw 'The GitHub release did not pass final identity and draft-state validation.'
    }
    $expectedPrerelease = $Release.Version.Contains('-')
    if ([bool]$published.isPrerelease -ne $expectedPrerelease) {
        throw 'The GitHub release has the wrong prerelease state.'
    }

    $assetParent = Split-Path -Parent $DeploymentDirectory
    $assetRoot = Join-Path $assetParent ('.helmsman-assets-' + [guid]::NewGuid().ToString('N'))
    $assetRootMoved = $false
    $null = New-Item -ItemType Directory -Path $assetRoot
    try {
        Invoke-NativeLive -FilePath $Tools.GitHub -ArgumentList @(
            'release', 'download', $Release.Tag, '--repo', $repositorySelector,
            '--dir', $assetRoot, '--pattern', 'compose.yaml',
            '--pattern', 'container.env.example', '--pattern', 'SHA256SUMS'
        ) -FailureMessage 'GitHub release-asset download'

        $checksumLines = @(Get-Content -LiteralPath (Join-Path $assetRoot 'SHA256SUMS'))
        if ($checksumLines.Count -ne 2) {
            throw 'SHA256SUMS must contain exactly the two deployment assets.'
        }
        $expectedHashes = @{}
        foreach ($line in $checksumLines) {
            if ($line -match '^([0-9a-f]{64})\s+((?:compose\.yaml)|(?:container\.env\.example))$') {
                $expectedHashes[$Matches[2]] = $Matches[1]
            }
            else {
                throw 'SHA256SUMS contains an unexpected entry.'
            }
        }
        foreach ($assetName in @('compose.yaml', 'container.env.example')) {
            if (!$expectedHashes.ContainsKey($assetName)) {
                throw "SHA256SUMS does not contain $assetName."
            }
            $actualHash = (Get-FileHash -LiteralPath (Join-Path $assetRoot $assetName) -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -cne $expectedHashes[$assetName]) {
                throw "The downloaded $assetName checksum does not match SHA256SUMS."
            }
        }

        $digestPattern = 'ghcr\.io/' + [regex]::Escape($ExpectedRepository.ToLowerInvariant()) + '@(?<digest>sha256:[0-9a-f]{64})'
        $publishedDigest = $null
        foreach ($assetName in @('compose.yaml', 'container.env.example')) {
            $assetText = [IO.File]::ReadAllText((Join-Path $assetRoot $assetName))
            if ($assetText.Contains('OWNER/REPOSITORY')) {
                throw "The published $assetName still contains the source placeholder."
            }
            $digestMatches = @([regex]::Matches($assetText, $digestPattern))
            $assetDigests = @($digestMatches | ForEach-Object { $_.Groups['digest'].Value } | Sort-Object -Unique)
            if ($assetDigests.Count -ne 1) {
                throw "The published $assetName must contain exactly one expected image digest."
            }
            if ($null -eq $publishedDigest) {
                $publishedDigest = $assetDigests[0]
            }
            elseif ($publishedDigest -cne $assetDigests[0]) {
                throw 'The published deployment assets do not reference the same image digest.'
            }
            $activeImagePattern = if ($assetName -ceq 'compose.yaml') {
                '(?m)^    image: "\$\{HELMSMAN_IMAGE:-ghcr\.io/' + [regex]::Escape($ExpectedRepository.ToLowerInvariant()) + '@' + [regex]::Escape($assetDigests[0]) + '\}"[ \t]*\r?$'
            }
            else {
                '(?m)^HELMSMAN_IMAGE=ghcr\.io/' + [regex]::Escape($ExpectedRepository.ToLowerInvariant()) + '@' + [regex]::Escape($assetDigests[0]) + '[ \t]*\r?$'
            }
            $genericActivePattern = if ($assetName -ceq 'compose.yaml') {
                '(?m)^[ \t]*image[ \t]*:[^\r\n]*\r?$'
            }
            else {
                '(?m)^[ \t]*(?:export[ \t]+)?HELMSMAN_IMAGE[ \t]*=[^\r\n]*\r?$'
            }
            if (@([regex]::Matches($assetText, $genericActivePattern)).Count -ne 1 -or
                ![regex]::IsMatch($assetText, $activeImagePattern)) {
                throw "The published $assetName does not activate the verified image digest."
            }
        }

        if (Test-Path -LiteralPath $DeploymentDirectory) {
            throw "The verified deployment directory already exists: $DeploymentDirectory"
        }
        Move-Item -LiteralPath $assetRoot -Destination $DeploymentDirectory
        $assetRootMoved = $true
    }
    finally {
        if (!$assetRootMoved -and (Test-Path -LiteralPath $assetRoot -PathType Container)) {
            [IO.Directory]::Delete($assetRoot, $true)
        }
    }
    Write-Host "Published release: $($published.url)" -ForegroundColor Green
    return [PSCustomObject]@{
        Directory = $DeploymentDirectory
        Digest = $publishedDigest
        Image = 'ghcr.io/' + $ExpectedRepository.ToLowerInvariant() + '@' + $publishedDigest
    }
}

function Show-ServerUpdateCommands {
    param(
        [Parameter(Mandatory = $true)]$Release,
        [Parameter(Mandatory = $true)]$Publication
    )

    $image = $Publication.Image
    $remoteReleaseDirectory = '/opt/helmsman/releases/' + $Release.Tag
    $localCompose = Join-Path $Publication.Directory 'compose.yaml'
    $localEnvironmentExample = Join-Path $Publication.Directory 'container.env.example'
    $localChecksums = Join-Path $Publication.Directory 'SHA256SUMS'
    Write-Host ''
    Write-Host "Release complete. The Jellyfin server was not changed." -ForegroundColor Green
    Write-Host "Published image: $image"
    Write-Host "Verified deployment files: $($Publication.Directory)"
    Write-Host 'The server block is for the standard single-file Compose install. If that host uses an override file, adapt every Compose command before running it.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'Run these transfer commands from this Windows PowerShell window:' -ForegroundColor Yellow
    Write-Host ('ssh root@192.168.0.7 "mkdir -p ' + $remoteReleaseDirectory + '"')
    Write-Host ('scp ' + (ConvertTo-PowerShellLiteral -Value $localCompose) + ' root@192.168.0.7:' + $remoteReleaseDirectory + '/')
    Write-Host ('scp ' + (ConvertTo-PowerShellLiteral -Value $localEnvironmentExample) + ' root@192.168.0.7:' + $remoteReleaseDirectory + '/')
    Write-Host ('scp ' + (ConvertTo-PowerShellLiteral -Value $localChecksums) + ' root@192.168.0.7:' + $remoteReleaseDirectory + '/')
    Write-Host 'ssh root@192.168.0.7'
    Write-Host ''
    Write-Host 'Then run these commands inside the Jellyfin SSH session:' -ForegroundColor Yellow
    Write-Host 'set -euo pipefail'
    Write-Host ('cd ' + $remoteReleaseDirectory)
    Write-Host 'sha256sum --strict --check SHA256SUMS'
    Write-Host 'cd /opt/helmsman'
    Write-Host "if [ -e compose.yaml.before-$($Release.Version) ] || [ -e .env.before-$($Release.Version) ]; then echo 'A backup for this version already exists; inspect or resume the prior attempt manually.' >&2; exit 1; fi"
    Write-Host "cp -- compose.yaml compose.yaml.before-$($Release.Version)"
    Write-Host 'unset HELMSMAN_IMAGE COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROJECT_NAME COMPOSE_PROFILES'
    Write-Host "if [ -f .env ]; then cp -- .env .env.before-$($Release.Version); helmsman_env_source=.env; else helmsman_env_source='$remoteReleaseDirectory/container.env.example'; fi"
    Write-Host 'helmsman_env_tmp="$(mktemp .env.helmsman.XXXXXX)"'
    Write-Host 'trap ''rm -f -- "$helmsman_env_tmp"'' EXIT HUP INT TERM'
    Write-Host 'awk ''!/^[[:space:]]*(export[[:space:]]+)?HELMSMAN_IMAGE[[:space:]]*=/'' "$helmsman_env_source" > "$helmsman_env_tmp"'
    Write-Host ("printf '%s\n' 'HELMSMAN_IMAGE=" + $image + "' >> `"`$helmsman_env_tmp`"")
    Write-Host 'if [ -f .env ]; then chmod --reference=.env "$helmsman_env_tmp"; chown --reference=.env "$helmsman_env_tmp"; else chmod 600 "$helmsman_env_tmp"; fi'
    Write-Host 'mv -- "$helmsman_env_tmp" .env'
    Write-Host 'trap - EXIT HUP INT TERM'
    Write-Host 'unset helmsman_env_source helmsman_env_tmp'
    Write-Host ('cp ' + $remoteReleaseDirectory + '/compose.yaml compose.yaml')
    Write-Host 'docker compose --file compose.yaml --env-file .env config'
    Write-Host 'docker compose --file compose.yaml --env-file .env config --images'
    Write-Host ("test `"`$(docker compose --file compose.yaml --env-file .env config --images)`" = '" + $image + "' || { echo 'Resolved image does not match the verified release digest.' >&2; exit 1; }")
    Write-Host 'docker compose --file compose.yaml --env-file .env pull helmsman'
    Write-Host 'docker compose --file compose.yaml --env-file .env up -d --force-recreate helmsman'
    Write-Host 'docker compose --file compose.yaml --env-file .env ps'
    Write-Host 'docker compose --file compose.yaml --env-file .env logs --tail=100 helmsman'
}

function Invoke-PublisherSelfTest {
    $sha = '0123456789abcdef0123456789abcdef01234567'
    Assert-ExpectedHttpsRepositoryUrl `
        -RemoteUrl 'https://github.com/nunesg130-boop/helmsman.git/' `
        -ExpectedRepository 'nunesg130-boop/helmsman' `
        -Description 'The self-test origin URL'
    $sshUrlRejected = $false
    try {
        Assert-ExpectedHttpsRepositoryUrl `
            -RemoteUrl 'git@github.com:nunesg130-boop/helmsman.git' `
            -ExpectedRepository 'nunesg130-boop/helmsman' `
            -Description 'The self-test origin URL'
    }
    catch {
        if ($_.Exception.Message -notmatch 'HTTPS URL') { throw }
        $sshUrlRejected = $true
    }
    if (!$sshUrlRejected) {
        throw 'Publisher self-test accepted an SSH origin URL.'
    }
    $caseChangedUrlRejected = $false
    try {
        Assert-ExpectedHttpsRepositoryUrl `
            -RemoteUrl 'https://github.com/NUNESG130-BOOP/HELMSMAN.git' `
            -ExpectedRepository 'nunesg130-boop/helmsman' `
            -Description 'The self-test origin URL'
    }
    catch {
        if ($_.Exception.Message -notmatch 'HTTPS URL') { throw }
        $caseChangedUrlRejected = $true
    }
    if (!$caseChangedUrlRejected) {
        throw 'Publisher self-test accepted a case-changed origin URL.'
    }
    $scopeFixture = "  - Token scopes: 'repo', 'workflow'"
    if (!(Test-GitHubAuthenticationScope -StatusText $scopeFixture -RequiredScope 'repo') -or
        !(Test-GitHubAuthenticationScope -StatusText $scopeFixture -RequiredScope 'workflow') -or
        (Test-GitHubAuthenticationScope `
            -StatusText "  - Token scopes: 'repo:status', 'workflow'" `
            -RequiredScope 'repo')) {
        throw 'Publisher self-test did not require exact GitHub scope names.'
    }

    $emptyRuns = @(ConvertFrom-GitHubRunListJson -Json '[]' -Context 'Self-test empty run list')
    if ($emptyRuns.Count -ne 0) {
        throw 'Publisher self-test did not normalize an empty run list to zero records.'
    }

    $singleJson = '[{"databaseId":101,"headBranch":"main","headSha":"' + $sha + '"}]'
    $singleRuns = @(ConvertFrom-GitHubRunListJson -Json $singleJson -Context 'Self-test single run list')
    if ($singleRuns.Count -ne 1 -or
        $singleRuns[0].DatabaseId -cne '101' -or
        $singleRuns[0].HeadBranch -cne 'main' -or
        $singleRuns[0].HeadSha -cne $sha) {
        throw 'Publisher self-test did not normalize a single workflow run.'
    }

    $twoJson = '[{"databaseId":101,"headBranch":"main","headSha":"' + $sha + '"},{"databaseId":202,"headBranch":"v0.0.0-test.1","headSha":"' + $sha + '"}]'
    $twoRuns = @(ConvertFrom-GitHubRunListJson -Json $twoJson -Context 'Self-test two-run list')
    if ($twoRuns.Count -ne 2 -or $twoRuns[1].DatabaseId -cne '202') {
        throw 'Publisher self-test did not enumerate a multi-record workflow run list.'
    }

    $missingPropertyRejected = $false
    try {
        $null = @(ConvertFrom-GitHubRunListJson -Json '[{"databaseId":303,"headBranch":"main"}]' -Context 'Self-test malformed run list')
    }
    catch {
        if ($_.Exception.Message -notmatch 'headSha') { throw }
        $missingPropertyRejected = $true
    }
    if (!$missingPropertyRejected) {
        throw 'Publisher self-test accepted a workflow run without headSha.'
    }

    $nullPropertyRejected = $false
    try {
        $null = @(ConvertFrom-GitHubRunListJson -Json '[{"databaseId":404,"headBranch":"main","headSha":null}]' -Context 'Self-test null run list')
    }
    catch {
        if ($_.Exception.Message -notmatch 'headSha') { throw }
        $nullPropertyRejected = $true
    }
    if (!$nullPropertyRejected) {
        throw 'Publisher self-test accepted a workflow run with null headSha.'
    }

    $wrongShapeRejected = $false
    try {
        $null = @(ConvertFrom-GitHubRunListJson -Json '{}' -Context 'Self-test wrong-shaped run list')
    }
    catch {
        if ($_.Exception.Message -notmatch 'JSON array') { throw }
        $wrongShapeRejected = $true
    }
    if (!$wrongShapeRejected) {
        throw 'Publisher self-test accepted a non-array workflow run list.'
    }

    $viewJson = '{"conclusion":null,"headBranch":"main","headSha":"' + $sha + '","event":"push","status":"in_progress"}'
    $view = ConvertFrom-GitHubRunViewJson -Json $viewJson -Context 'Self-test workflow view'
    if ($view.HeadSha -cne $sha -or $view.HeadBranch -cne 'main' -or
        $view.Event -cne 'push' -or $view.Status -cne 'in_progress' -or
        $view.Conclusion -cne '') {
        throw 'Publisher self-test did not validate a workflow view with a pending conclusion.'
    }

    $malformedViewRejected = $false
    try {
        $null = ConvertFrom-GitHubRunViewJson -Json '{"conclusion":null,"headBranch":"main","event":"push","status":"queued"}' -Context 'Self-test malformed workflow view'
    }
    catch {
        if ($_.Exception.Message -notmatch 'headSha') { throw }
        $malformedViewRejected = $true
    }
    if (!$malformedViewRejected) {
        throw 'Publisher self-test accepted a workflow view without headSha.'
    }

    Write-Host 'Guarded publisher HTTPS and JSON self-test: PASS' -ForegroundColor Green
}

if ($SelfTest) {
    Invoke-PublisherSelfTest
    return
}

# ORCHESTRATION
$startingLocation = Get-Location
$gitHooksIsolation = $null
try {
    # Process-level Git configuration outranks repository and user config, so no
    # source-controlled or preconfigured hook can run during validation, tests,
    # commits, tags, or pushes. Child npm processes inherit the same protection.
    $gitHooksIsolation = Enter-GitHooksIsolation

    Write-Step 'Validating release tools and paths'
    $tools = Assert-RequiredTool

    $sourceRoot = (Resolve-Path -LiteralPath $SourcePath -ErrorAction Stop).ProviderPath
    $repositoryCandidate = if ([string]::IsNullOrWhiteSpace($RepositoryPath)) {
        Split-Path -Parent $PSScriptRoot
    }
    else {
        $RepositoryPath
    }
    $repoRoot = (Resolve-Path -LiteralPath $repositoryCandidate -ErrorAction Stop).ProviderPath
    foreach ($validatedRoot in @($sourceRoot, $repoRoot)) {
        if ($validatedRoot -match '[\x00-\x1f\x7f]') {
            throw 'The source and repository root paths cannot contain control characters.'
        }
        $rootItem = Get-Item -LiteralPath $validatedRoot
        if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'The source and repository roots cannot be symlinks or reparse points.'
        }
    }
    $sourceNormalized = Get-NormalizedPath $sourceRoot
    $repoNormalized = Get-NormalizedPath $repoRoot
    if ($sourceNormalized -eq $repoNormalized -or
        $sourceNormalized.StartsWith($repoNormalized + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $repoNormalized.StartsWith($sourceNormalized + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The source release and publisher repository must be separate, non-nested directories.'
    }

    $canonical = Get-CanonicalRepository -RepoRoot $repoRoot -Tools $tools -ExpectedRepository $Repository
    Assert-GitHubAuthentication `
        -Tools $tools `
        -RepoRoot $canonical.Root `
        -ExpectedRepository $Repository `
        -ExpectedLogin $GitHubLogin
    Assert-CleanMainAtOrigin -RepoRoot $canonical.Root -Tools $tools
    Assert-GitAuthor -RepoRoot $canonical.Root -Tools $tools

    Write-Step 'Validating the extracted source release'
    $release = Get-ValidatedSourceRelease -SourceRoot $sourceRoot
    Assert-ReleaseIsNew -RepoRoot $canonical.Root -Tools $tools -ExpectedRepository $Repository -Tag $release.Tag
    $deploymentDirectory = Join-Path (Split-Path -Parent $release.Root) ("helmsman-$($release.Version)-deployment-assets")
    if (Test-Path -LiteralPath $deploymentDirectory) {
        throw "The deployment-output directory already exists: $deploymentDirectory"
    }

    Write-Step 'Synchronizing and staging the release'
    $publisherPath = 'scripts/Publish-HelmsmanRelease.ps1'
    Sync-SourceTree -Release $release -RepoRoot $canonical.Root -Tools $tools -PublisherPath $publisherPath
    $reviewedTree = Stage-AndValidateRelease -RepoRoot $canonical.Root -Tools $tools -Release $release -PublisherPath $publisherPath

    Write-Step 'Running local release tests'
    Invoke-LocalTestsIfAvailable -RepoRoot $canonical.Root -Tools $tools -Skip ([bool]$SkipLocalTests)
    Assert-StagedTreeUnchanged -RepoRoot $canonical.Root -Tools $tools -ExpectedTree $reviewedTree

    Show-StagedSummary -RepoRoot $canonical.Root -Tools $tools -Release $release -ExpectedRepository $Repository
    if (!(Confirm-Release -Release $release)) {
        Write-Host 'Release cancelled. Nothing was committed, tagged, or pushed. The reviewed changes remain staged.' -ForegroundColor Yellow
        return
    }

    Write-Step 'Committing and validating main'
    $commitSha = New-ReleaseCommit -RepoRoot $canonical.Root -Tools $tools -Release $release -ExpectedTree $reviewedTree
    $existingMainRuns = @(Get-WorkflowRunIds -Tools $tools -ExpectedRepository $Repository -WorkflowName $Workflow -CommitSha $commitSha -RefName 'main')
    Push-Main `
        -RepoRoot $canonical.Root `
        -Tools $tools `
        -CommitSha $commitSha `
        -ExpectedRepository $Repository `
        -ExpectedLogin $GitHubLogin
    $mainRun = Wait-WorkflowForCommit -Tools $tools -ExpectedRepository $Repository -WorkflowName $Workflow -CommitSha $commitSha -RefName 'main' -ExcludedRunIds $existingMainRuns

    Write-Step 'Publishing the version tag'
    $existingTagRuns = @(Get-WorkflowRunIds -Tools $tools -ExpectedRepository $Repository -WorkflowName $Workflow -CommitSha $commitSha -RefName $release.Tag)
    New-AndPushReleaseTag `
        -RepoRoot $canonical.Root `
        -Tools $tools `
        -Release $release `
        -CommitSha $commitSha `
        -ExpectedRepository $Repository `
        -ExpectedLogin $GitHubLogin
    $tagRun = Wait-WorkflowForCommit -Tools $tools -ExpectedRepository $Repository -WorkflowName $Workflow -CommitSha $commitSha -RefName $release.Tag -ExcludedRunIds $existingTagRuns
    $publication = Assert-PublishedRelease -Tools $tools -ExpectedRepository $Repository -Release $release -DeploymentDirectory $deploymentDirectory

    Show-ServerUpdateCommands -Release $release -Publication $publication
}
finally {
    try {
        Set-Location -LiteralPath $startingLocation.Path
    }
    finally {
        if ($null -ne $gitHooksIsolation) {
            Exit-GitHooksIsolation -Scope $gitHooksIsolation
        }
    }
}
