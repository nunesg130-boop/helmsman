import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcherPath = join(root, "Publish-Helmsman.ps1");
const commandPath = join(root, "Publish-Helmsman.cmd");
const publisherPath = join(root, "scripts", "Publish-HelmsmanRelease.ps1");
const workflowPath = join(root, ".github", "workflows", "container.yml");
const attributesPath = join(root, ".gitattributes");
const launcherBuffer = readFileSync(launcherPath);
const commandBuffer = readFileSync(commandPath);
const publisherBuffer = readFileSync(publisherPath);
const launcher = launcherBuffer.toString("utf8").replace(/\r\n?/gu, "\n");
const command = commandBuffer.toString("utf8").replace(/\r\n?/gu, "\n");
const publisher = publisherBuffer.toString("utf8").replace(/\r\n?/gu, "\n");
const publisherSha256 = createHash("sha256").update(publisherBuffer).digest("hex");
const workflow = readFileSync(workflowPath, "utf8").replace(/\r\n?/gu, "\n");
const attributes = readFileSync(attributesPath, "utf8").replace(/\r\n?/gu, "\n");
const failures = [];
const passes = [];

function record(condition, label, detail = "") {
  if (condition) passes.push(label);
  else failures.push(detail ? `${label}: ${detail}` : label);
}

function functionBlock(contents, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const start = contents.search(new RegExp(`^function ${escapedName} \\{`, "mu"));
  if (start < 0) return "";
  const remainder = contents.slice(start + 1);
  const nextFunction = remainder.search(/^function [A-Za-z][A-Za-z0-9-]* \{/mu);
  const orchestration = remainder.search(/^# Dot-sourcing exposes/mu);
  const boundaries = [nextFunction, orchestration].filter((value) => value >= 0);
  return boundaries.length
    ? contents.slice(start, start + 1 + Math.min(...boundaries))
    : contents.slice(start);
}

record(
  /^[*][.]ps1 text eol=lf$/mu.test(attributes)
    && /^[*][.]cmd text eol=crlf$/mu.test(attributes),
  "Git attributes keep hash-bound PowerShell source byte-stable while preserving Windows command-file endings"
);

const executableLauncher = launcher
  .replace(/'(?:''|[^'])*'/gu, "''")
  .replace(/"(?:`.|[^"`])*"/gu, '""')
  .replace(/^\s*#.*$/gmu, "");
const parameterBlock = launcher.slice(0, launcher.indexOf("Set-StrictMode"));
const publicParameters = Array.from(
  parameterBlock.matchAll(/\[(?:string|switch)\]\$([A-Za-z][A-Za-z0-9]*)/gu),
  (match) => match[1]
);

record(
  /^#requires -Version 5[.]1\s*$/mu.test(launcher)
    && /\[CmdletBinding\(\)\]/u.test(parameterBlock)
    && /Set-StrictMode -Version Latest/u.test(launcher)
    && /\$ErrorActionPreference = 'Stop'/u.test(launcher)
    && launcherBuffer.every((byte) => byte < 0x80)
    && commandBuffer.every((byte) => byte < 0x80)
    && !launcher.includes("\0")
    && !command.includes("\0")
    && !/(?:System[.]IO[.]Compression|IO[.]Compression|ZipArchive|ReleaseArchive|ExpectedSha256)/iu.test(launcher)
    && !/^function\s+[A-Za-z][A-Za-z0-9-]*Archive[A-Za-z0-9-]*\s*\{/imu.test(launcher)
    && !/\b(?:Expand-Archive|Compress-Archive|New-PrivateArchiveSnapshot|Close-PrivateArchiveSnapshot|Get-ArchiveStreamSha256|Get-ValidatedArchiveManifest(?:FromZip)?|Assert-ReleaseArchiveHash|Expand-SafeReleaseArchive|Select-ReleaseArchive|New-SelfTestArchive)\b/iu.test(launcher)
    && !/\?\?|ForEach-Object\s+-Parallel|\[IO[.]Path\]::GetRelativePath|ConvertFrom-Json\s+-AsHashtable|^\s*[^#\r\n]+\s(?:&&|\|\|)\s/imu.test(executableLauncher),
  "folder-only launcher and wrapper are ASCII-safe, compression-free, and compatible with Windows PowerShell 5.1"
);

record(
  JSON.stringify(publicParameters) === JSON.stringify([
    "SourcePath",
    "RepositoryPath",
    "DeploymentHost",
    "DeploymentUser",
    "DeploymentRoot",
    "SelfTest"
  ])
    && /\$script:ExpectedRepository = 'nunesg130-boop\/helmsman'/u.test(launcher)
    && /\$script:ExpectedGitHubLogin = 'nunesg130-boop'/u.test(launcher)
    && /\$script:ExpectedCloneUrl = 'https:\/\/github[.]com\/nunesg130-boop\/helmsman[.]git'/u.test(launcher)
    && /\$script:MaximumRecoveryClones = 20/u.test(launcher)
    && /'config', '--local', 'user[.]name', \$Account[.]Login/u.test(launcher)
    && launcher.includes(`$script:ExpectedPublisherSha256 = '${publisherSha256}'`)
    && !/\[string\]\$(?:ExpectedRepository|ExpectedGitHubLogin|ExpectedCloneUrl|Workflow)/u.test(parameterBlock)
    && !/0[.]10[.]0-beta[.][0-9]+/u.test(launcher),
  "launcher exposes only bounded local setup inputs and derives every release version from package metadata"
);

record(
  /^@echo off\s*$/mu.test(command)
    && /powershell[.]exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Publish-Helmsman[.]ps1" %\*/u.test(command)
    && /set "HELMSMAN_EXIT_CODE=%ERRORLEVEL%"/u.test(command)
    && /pause/u.test(command)
    && /exit \/b %HELMSMAN_EXIT_CODE%/u.test(command)
    && !/(?:curl|Invoke-WebRequest|Invoke-Expression)/iu.test(command),
  "double-click wrapper launches only the adjacent reviewed PowerShell script and preserves its exit code"
);

const installer = functionBlock(launcher, "Install-RequiredApplication");
const requiredTools = functionBlock(launcher, "Get-RequiredTools");
const githubCliVersionParser = functionBlock(launcher, "ConvertFrom-GitHubCliVersionOutput");
const supportedGithubCli = functionBlock(launcher, "Assert-SupportedGitHubCli");
const pathRefresh = functionBlock(launcher, "Update-ProcessPath");
record(
  /Get-Command -Name \$Name -CommandType Application/u.test(launcher)
    && /Get-ApplicationPath -Name 'winget[.]exe'/u.test(installer)
    && /'install', '--id', \$PackageId, '--exact', '--source', 'winget'/u.test(installer)
    && /'--accept-source-agreements', '--accept-package-agreements'/u.test(installer)
    && /'--disable-interactivity'/u.test(installer)
    && /Update-ProcessPath/u.test(installer)
    && /-CommandName 'git[.]exe' -PackageId 'Git[.]Git'/u.test(requiredTools)
    && /-CommandName 'gh[.]exe' -PackageId 'GitHub[.]cli'/u.test(requiredTools)
    && /Assert-SupportedGitHubCli -GitHubPath \$github/u.test(requiredTools)
    && /\(\?m\)\^gh version/u.test(githubCliVersionParser)
    && /return \[version\]\$match[.]Groups\['version'\][.]Value/u.test(githubCliVersionParser)
    && /--version/u.test(supportedGithubCli)
    && /MinimumGitHubCliVersion/u.test(supportedGithubCli)
    && /winget upgrade --id GitHub[.]cli --exact/u.test(supportedGithubCli),
  "missing tools are installed through exact WinGet identities and GitHub CLI supports active-account verification"
);
record(
  /GetEnvironmentVariable\('Path', 'Process'\)/u.test(pathRefresh)
    && /GetEnvironmentVariable\('Path', 'Machine'\)/u.test(pathRefresh)
    && /GetEnvironmentVariable\('Path', 'User'\)/u.test(pathRefresh)
    && /\$seen = @\{\}/u.test(pathRefresh)
    && /\$env:Path = \$merged -join \$separator/u.test(pathRefresh),
  "PATH refresh retains process-only tooling while merging newly installed machine and user entries"
);

const regularDirectory = functionBlock(launcher, "Assert-RegularDirectory");
const releaseRoot = functionBlock(launcher, "Resolve-ReleaseRoot");
const bootstrapCore = functionBlock(launcher, "Invoke-HelmsmanBootstrapCore");
record(
  /Get-Item -LiteralPath \$Path -Force -ErrorAction Stop/u.test(regularDirectory)
    && /FileAttributes\]::ReparsePoint/u.test(regularDirectory)
    && /Resolve-Path -LiteralPath \$Path -ErrorAction Stop/u.test(releaseRoot)
    && /ProviderPath/u.test(releaseRoot)
    && /\[\\x00-\\x1f\\x7f\]/u.test(releaseRoot)
    && /Assert-RegularDirectory/u.test(releaseRoot)
    && /Join-Path \$Path '[.]git'/u.test(launcher)
    && /package[.]json/u.test(releaseRoot)
    && /compose[.]yaml/u.test(launcher)
    && /package[.]name -cne 'helmsman'/u.test(releaseRoot)
    && /release-safe SemVer/u.test(releaseRoot)
    && /\$releaseNormalized[.]StartsWith\(\$repositoryNormalized \+ '\\', \[StringComparison\]::OrdinalIgnoreCase\)/u.test(bootstrapCore)
    && /\$repositoryNormalized[.]StartsWith\(\$releaseNormalized \+ '\\', \[StringComparison\]::OrdinalIgnoreCase\)/u.test(bootstrapCore)
    && /must be separate directories/u.test(bootstrapCore),
  "release and repository paths use literal canonical resolution, reject reparse roots, and cannot overlap"
);

const picker = functionBlock(launcher, "Select-ReleaseSourceDirectory");
record(
  /Add-Type -AssemblyName System[.]Windows[.]Forms/u.test(picker)
    && /Windows[.]Forms[.]FolderBrowserDialog/u.test(picker)
    && /ShowNewFolderButton\s*=\s*\$false/u.test(picker)
    && /\$pickerFailed = \$false/u.test(picker)
    && /\$dialogResult = \$dialog[.]ShowDialog\(\)/u.test(picker)
    && /\$dialog[.]SelectedPath/u.test(picker)
    && /\$dialog[.]Dispose\(\)/u.test(picker)
    && /if \(\$pickerFailed\)/u.test(picker)
    && /Read-Host/u.test(picker)
    && /elseif \(\$dialogResult -ne \[Windows[.]Forms[.]DialogResult\]::OK\)/u.test(picker)
    && /Release-folder selection was cancelled/u.test(picker)
    && /No extracted release folder was selected/u.test(picker),
  "folder picker selects an extracted source, disposes its dialog, and distinguishes cancellation from picker failure"
);
record(
  /if \(!\[string\]::IsNullOrWhiteSpace\(\$SourcePath\)\)/u.test(bootstrapCore)
    && /elseif \(Test-ReleaseRoot -Path \$PSScriptRoot\)/u.test(bootstrapCore)
    && /\$selectedSource = \$PSScriptRoot/u.test(bootstrapCore)
    && /Using the extracted release beside this launcher/u.test(bootstrapCore)
    && /\$selectedSource = Select-ReleaseSourceDirectory/u.test(bootstrapCore)
    && /Resolve-ReleaseRoot -Path \$selectedSource/u.test(bootstrapCore)
    && !/temporaryExtractionRoot|Expand-SafeReleaseArchive|Select-ReleaseArchive/iu.test(bootstrapCore),
  "bootstrap uses an explicit source, then an adjacent extracted release, and otherwise asks for an extracted folder"
);
record(
  !/SkipLocalTests|Get-LocalTestDecision|npm[.]cmd|node[.]exe/u.test(launcher)
    && !/SkipLocalTests|Invoke-LocalTestsIfAvailable|npm[.]cmd|node[.]exe/u.test(publisher),
  "authenticated launcher and publisher never execute candidate project code"
);
record(
  /\$launcherNormalized = Get-NormalizedPath \$PSScriptRoot/u.test(bootstrapCore)
    && /Join-Path \$PSScriptRoot '[.]git'/u.test(bootstrapCore)
    && /not from the persistent Helmsman Git clone/u.test(bootstrapCore),
  "launcher refuses clone-hosted execution so source synchronization cannot overwrite its active files"
);

const authentication = functionBlock(launcher, "Initialize-GitHubAuthentication");
const expectedLogin = functionBlock(launcher, "Get-ExpectedGitHubLogin");
const authenticationScope = functionBlock(launcher, "Test-GitHubAuthenticationScope");
const repositoryMetadata = functionBlock(launcher, "ConvertFrom-GitHubRepositoryJson");
const authenticationStatusCalls = authentication.match(/'auth', 'status'/gu) || [];
const activeAuthenticationStatusCalls = authentication.match(
  /'auth', 'status', '--active', '--hostname', 'github[.]com'/gu
) || [];
record(
  /'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR'/u.test(authentication)
    && /environment variable is set/u.test(authentication)
    && /Its value was not displayed/u.test(authentication)
    && /'auth', 'status', '--active', '--hostname', 'github[.]com'/u.test(authentication)
    && authenticationStatusCalls.length === 4
    && activeAuthenticationStatusCalls.length === 4
    && /'auth', 'login', '--hostname', 'github[.]com', '--git-protocol', 'https'/u.test(authentication)
    && /'--web', '--scopes', 'repo,workflow'/u.test(authentication)
    && /'api', 'user', '--jq', '[.]login'/u.test(expectedLogin)
    && /\$login -cne \$script:ExpectedGitHubLogin/u.test(expectedLogin)
    && /'auth', 'refresh', '--hostname', 'github[.]com', '--scopes', 'repo,workflow'/u.test(authentication)
    && /repository and workflow permissions/u.test(authentication)
    && /Test-GitHubAuthenticationScope -StatusText \$status[.]Text -RequiredScope 'repo'/u.test(authentication)
    && /Test-GitHubAuthenticationScope -StatusText \$status[.]Text -RequiredScope 'workflow'/u.test(authentication)
    && /Token scopes:/u.test(authenticationScope)
    && /[.]Value[.]Split\(','\)/u.test(authenticationScope)
    && /\$scope -ceq \$RequiredScope/u.test(authenticationScope)
    && /'repo', 'view', \$repositorySelector/u.test(authentication)
    && /nameWithOwner,viewerPermission,defaultBranchRef,isArchived/u.test(authentication)
    && /ConvertFrom-GitHubRepositoryJson -Json \$repositoryProbe[.]StdOut/u.test(authentication)
    && /viewerPermission -cnotin @\('WRITE', 'MAINTAIN', 'ADMIN'\)/u.test(repositoryMetadata)
    && /defaultBranchRef[.]name -cne 'main'/u.test(repositoryMetadata)
    && /Properties\['isArchived'\][.]Value -isnot \[bool\]/u.test(repositoryMetadata)
    && /repository[.]isArchived/u.test(repositoryMetadata)
    && /'auth', 'setup-git', '--hostname', 'github[.]com'/u.test(authentication)
    && /'ls-remote', '--get-url', \$script:ExpectedCloneUrl/u.test(authentication)
    && /Assert-ExpectedHttpsCloneUrl/u.test(authentication)
    && /'ls-remote', '--exit-code', \$script:ExpectedCloneUrl, 'refs\/heads\/main'/u.test(authentication)
    && authentication.indexOf("'repo', 'view'") < authentication.indexOf("'auth', 'setup-git'")
    && authentication.indexOf("'auth', 'setup-git'") < authentication.indexOf("'ls-remote'"),
  "launcher verifies the exact account, repository write access, repo/workflow scopes, and authenticated HTTPS Git transport before cloning"
);

const correctRepository = functionBlock(launcher, "Assert-CorrectRepository");
const expectedHttpsClone = functionBlock(launcher, "Assert-ExpectedHttpsCloneUrl");
const cleanRepository = functionBlock(launcher, "Assert-CleanRepository");
const repositorySelection = functionBlock(launcher, "Get-PublishingRepositorySelection");
const recoveryCandidate = functionBlock(launcher, "Get-RecoveryRepositoryCandidate");
const pathSeparation = functionBlock(launcher, "Assert-RepositoryPathSeparation");
const recoveryFallback = functionBlock(launcher, "Invoke-RecoveryRepositoryFallback");
const initializeRepository = functionBlock(launcher, "Initialize-Repository");
const repositoryCloneSelectors = initializeRepository.match(/'repo', 'clone'/gu) || [];
const directGitCloneInvocations = initializeRepository.match(
  /-FilePath \$Tools[.]Git\s+-ArgumentList @\(\s*'clone'/gsu
) || [];
const recoveryIndexForwardingCalls = initializeRepository.match(
  /-CurrentRecoveryIndex \$RecoveryIndex/gu
) || [];
record(
  /rev-parse', '--show-toplevel'/u.test(correctRepository)
    && /remote', 'get-url', '--all', 'origin'/u.test(correctRepository)
    && /remote', 'get-url', '--push', '--all', 'origin'/u.test(correctRepository)
    && /fetch URL and one push URL/u.test(correctRepository)
    && /ConvertTo-GitHubSlug/u.test(correctRepository)
    && /Assert-ExpectedHttpsCloneUrl/u.test(correctRepository)
    && /ExpectedCloneUrl/u.test(expectedHttpsClone)
    && /StringComparison\]::Ordinal\)/u.test(expectedHttpsClone)
    && /Git URL rewrites are not allowed/u.test(expectedHttpsClone)
    && /status', '--porcelain=v1', '--untracked-files=all'/u.test(cleanRepository)
    && /will not reset, clean, or overwrite/u.test(cleanRepository)
    && /'repo', 'clone', \$script:ExpectedCloneUrl, \$RepoRoot, '--no-upstream', '--'/u.test(initializeRepository)
    && /Invoke-NativeLive -FilePath \$Tools[.]GitHub -ArgumentList @\(\s*'repo', 'clone'/su.test(initializeRepository)
    && repositoryCloneSelectors.length === 1
    && directGitCloneInvocations.length === 0
    && /'--branch', 'main', '--single-branch', '--no-tags'/u.test(initializeRepository)
    && /Account[.]CloneUrl -cne \$script:ExpectedCloneUrl/u.test(initializeRepository)
    && /Assert-CorrectRepository/u.test(initializeRepository)
    && /Assert-CleanRepository/u.test(initializeRepository)
    && /'branch', '--show-current'/u.test(initializeRepository)
    && /will not switch an existing working tree/u.test(initializeRepository)
    && /'fetch', '--no-tags', '--no-prune', '--recurse-submodules=no', 'origin'/u.test(initializeRepository)
    && /refs\/heads\/main:refs\/remotes\/origin\/main/u.test(initializeRepository)
    && /'merge-base', '--is-ancestor', \$localHead, \$remoteHead/u.test(initializeRepository)
    && /'merge', '--ff-only', '--no-edit', 'refs\/remotes\/origin\/main'/u.test(initializeRepository)
    && /rev-parse', 'HEAD'/u.test(initializeRepository)
    && /rev-parse', 'refs\/remotes\/origin\/main'/u.test(initializeRepository)
    && /\$localHead -cne \$remoteHead/u.test(initializeRepository)
    && /\[string\]\$RecoveryRepoRoot/u.test(initializeRepository)
    && /\[ValidateRange\(0, 20\)\]\[int\]\$RecoveryIndex = 0/u.test(initializeRepository)
    && /\[ValidateRange\(0, 20\)\]\[int\]\$CurrentRecoveryIndex/u.test(recoveryFallback)
    && /-StartIndex \(\$CurrentRecoveryIndex \+ 1\)/u.test(recoveryFallback)
    && recoveryIndexForwardingCalls.length === 3
    && /if \(!\[string\]::IsNullOrWhiteSpace\(\$RecoveryRepoRoot\)\)/u.test(initializeRepository)
    && !/\$RecoveryIndex -gt 0 -and !\[string\]::IsNullOrWhiteSpace\(\$RecoveryRepoRoot\)/u.test(initializeRepository)
    && /existing clone has a clean local commit that is not on origin\/main/u.test(initializeRepository)
    && /Invoke-RecoveryRepositoryFallback/u.test(initializeRepository)
    && /Get-RecoveryRepositoryCandidate/u.test(recoveryFallback)
    && /RecoveryIndex \$candidate[.]Index/u.test(recoveryFallback)
    && /not nested within the preserved clone/u.test(recoveryFallback)
    && /Assert-RepositoryPathSeparation/u.test(recoveryFallback)
    && /ForbiddenPaths \$ForbiddenPaths/u.test(recoveryFallback)
    && /CandidatePath \$RepoRoot/u.test(initializeRepository)
    && /release source or active launcher path/u.test(pathSeparation)
    && /No local files or commits were changed at \$CurrentRepoRoot/u.test(recoveryFallback)
    && /will not force, reset, amend, or delete/u.test(initializeRepository)
    && /'api', 'user', '--jq', '[.]id'/u.test(initializeRepository)
    && /\$githubId -notmatch '\^\[0-9\]\+\$'/u.test(initializeRepository)
    && /'config', '--local', 'user[.]name'/u.test(initializeRepository)
    && /'config', '--local', 'user[.]email'/u.test(initializeRepository),
  "clone setup proves canonical fetch/push remotes, refuses dirty trees, fast-forwards only, and configures local identity"
);

record(
  /helmsman-github/u.test(repositorySelection)
    && /helmsman-github-recovery/u.test(repositorySelection)
    && /IsExplicit = \$true/u.test(repositorySelection)
    && /IsExplicit = \$false/u.test(repositorySelection)
    && /RequestedPath/u.test(repositorySelection)
    && /\$index -le \$script:MaximumRecoveryClones/u.test(recoveryCandidate)
    && /BasePath \+ '-' \+ \$index/u.test(recoveryCandidate)
    && /Test-Path -LiteralPath \$candidate/u.test(recoveryCandidate)
    && /Get-Item -LiteralPath \$gitDirectory -Force/u.test(recoveryCandidate)
    && /\$gitItem[.]Attributes -band \[IO[.]FileAttributes\]::ReparsePoint/u.test(recoveryCandidate)
    && /occupied recovery path is not a reusable Git clone and was left untouched/u.test(recoveryCandidate)
    && /Using the verified persistent recovery clone/u.test(initializeRepository)
    && /-RecoveryRepoRoot \$recoveryRepositoryFull/u.test(bootstrapCore)
    && /-ForbiddenPaths @\(\$release[.]Root, \$PSScriptRoot\)/u.test(bootstrapCore)
    && /active publishing clone must be separate directories/u.test(bootstrapCore)
    && /Join-Path \$release[.]Root 'scripts\\Publish-HelmsmanRelease[.]ps1'/u.test(bootstrapCore)
    && /Test-Path -LiteralPath \$publisher -PathType Leaf/u.test(bootstrapCore)
    && /FileAttributes\]::ReparsePoint/u.test(bootstrapCore)
    && /Get-FileHash -LiteralPath \$publisherItem[.]FullName -Algorithm SHA256/u.test(bootstrapCore)
    && /\$publisherSha256 -cne \$script:ExpectedPublisherSha256/u.test(bootstrapCore)
    && /SourcePath = \$release[.]Root/u.test(bootstrapCore)
    && /RepositoryPath = \$repoRoot/u.test(bootstrapCore)
    && /DeploymentHost = \$DeploymentHost/u.test(bootstrapCore)
    && /DeploymentUser = \$DeploymentUser/u.test(bootstrapCore)
    && /DeploymentRoot = \$DeploymentRoot/u.test(bootstrapCore)
    && !/SkipLocalTests|Get-LocalTestDecision/u.test(bootstrapCore)
    && /& \$publisher @publisherParameters/u.test(bootstrapCore)
    && (launcher.match(/& \$publisher @publisherParameters/gu) || []).length === 1
    && /if \(\$MyInvocation[.]InvocationName -eq '[.]'\) \{ return \}/u.test(launcher)
    && /if \(\$SelfTest\)\s*\{\s*Invoke-LauncherSelfTest/su.test(launcher),
  "the hash-bound source publisher receives the canonical source and verified clean clone paths"
);

const selfTest = functionBlock(launcher, "Invoke-LauncherSelfTest");
const selfTestResolutionCalls = selfTest.match(/Resolve-ReleaseRoot -Path \$/gu) || [];
record(
  /helmsman-launcher-test-/u.test(selfTest)
    && /Join-Path \$outerRoot 'helmsman'/u.test(selfTest)
    && /hidden-directory/u.test(selfTest)
    && /FileAttributes\]::Hidden/u.test(selfTest)
    && /Assert-RegularDirectory -Path \$hiddenRoot/u.test(selfTest)
    && /Hidden-directory inspection: PASS/u.test(selfTest)
    && /invalid-release/u.test(selfTest)
    && /malformed-release/u.test(selfTest)
    && /\{"name":"helmsman","version":"9[.]8[.]7-test[.]1"\}/u.test(selfTest)
    && /\{"name":"not-helmsman","version":"9[.]8[.]7-test[.]1"\}/u.test(selfTest)
    && selfTestResolutionCalls.length === 4
    && /\$direct = Resolve-ReleaseRoot -Path \$releaseRoot/u.test(selfTest)
    && /\$nested = Resolve-ReleaseRoot -Path \$outerRoot/u.test(selfTest)
    && /Assert-SelfTestThrows -Name 'missing release files'/u.test(selfTest)
    && /Assert-SelfTestThrows -Name 'wrong package identity'/u.test(selfTest)
    && /Assert-SelfTestThrows -Name 'read-only repository permission'/u.test(selfTest)
    && /Assert-SelfTestThrows -Name 'wrong default branch'/u.test(selfTest)
    && /Assert-SelfTestThrows -Name 'missing repository metadata'/u.test(selfTest)
    && /Assert-SelfTestThrows -Name 'null repository archive state'/u.test(selfTest)
    && /Assert-SelfTestThrows -Name 'archived repository'/u.test(selfTest)
    && /Assert-SelfTestThrows -Name 'SSH repository transport'/u.test(selfTest)
    && /Assert-SelfTestThrows -Name 'credential-bearing repository URL'/u.test(selfTest)
    && /Assert-SelfTestThrows -Name 'case-changed repository URL'/u.test(selfTest)
    && /ConvertFrom-GitHubCliVersionOutput/u.test(selfTest)
    && /Assert-SelfTestThrows -Name 'malformed GitHub CLI version'/u.test(selfTest)
    && /GitHub CLI compatibility: PASS/u.test(selfTest)
    && /repo:status/u.test(selfTest)
    && /GitHub CLI scope parsing did not require exact scope names/u.test(selfTest)
    && /Assert-SelfTestThrows -Name 'repository nested in release source'/u.test(selfTest)
    && /Assert-SelfTestThrows -Name 'repository contains release source'/u.test(selfTest)
    && /9[.]8[.]7-test[.]1/u.test(selfTest)
    && /Extracted-folder discovery: PASS/u.test(selfTest)
    && /Repository metadata: PASS/u.test(selfTest)
    && /Get-PublishingRepositorySelection -UserProfile \$profileRoot/u.test(selfTest)
    && /Get-PublishingRepositorySelection -RequestedPath \$explicitClone/u.test(selfTest)
    && /Get-RecoveryRepositoryCandidate -BasePath \$recoveryClone/u.test(selfTest)
    && /preserve-first[.]txt/u.test(selfTest)
    && /preserve-second[.]txt/u.test(selfTest)
    && /preserve-default[.]txt/u.test(selfTest)
    && /partial-sentinel[.]txt/u.test(selfTest)
    && /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/u.test(selfTest)
    && /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/u.test(selfTest)
    && /if \/I "%~3"=="merge-base" exit \/b 1/u.test(selfTest)
    && /fake-git[.]cmd/u.test(selfTest)
    && /fake-gh[.]cmd/u.test(selfTest)
    && /exit \/b 73/u.test(selfTest)
    && /-RecoveryIndex 0/u.test(selfTest)
    && /foreach \(\$attempt in @\(1, 2\)\)/u.test(selfTest)
    && /\$mergeBaseArguments[.]Count -ne 2/u.test(selfTest)
    && /Recovery routing did not use the exact guarded HTTPS clone command and next unused suffix/u.test(selfTest)
    && /Clean-ahead failed-clone recovery routing: PASS/u.test(selfTest)
    && /Partial recovery preservation: PASS/u.test(selfTest)
    && /Launcher self-test: PASS/u.test(selfTest)
    && /\[IO[.]Directory\]::Delete\(\$testRoot, \$true\)/u.test(selfTest),
  "offline self-test covers direct, nested, incomplete, and wrong-identity extracted source folders"
);

const lockedBootstrap = functionBlock(launcher, "Invoke-HelmsmanBootstrap");
record(
  /\[Threading[.]Mutex\]::new\(\$false, 'Local\\HelmsmanReleasePublisher'\)/u.test(lockedBootstrap)
    && /\$mutex[.]WaitOne\(0, \$false\)/u.test(lockedBootstrap)
    && /AbandonedMutexException/u.test(lockedBootstrap)
    && /Another Helmsman publisher is already running/u.test(lockedBootstrap)
    && /if \(\$ownsMutex\) \{ \$mutex[.]ReleaseMutex\(\) \}/u.test(lockedBootstrap)
    && /\$mutex[.]Dispose\(\)/u.test(lockedBootstrap),
  "a named non-blocking mutex prevents concurrent publishers and is always released"
);

const enterHooksIsolation = functionBlock(launcher, "Enter-GitHooksIsolation");
const exitHooksIsolation = functionBlock(launcher, "Exit-GitHooksIsolation");
record(
  /'GIT_CONFIG_COUNT'/u.test(enterHooksIsolation)
    && /'GIT_CONFIG_KEY_0'/u.test(enterHooksIsolation)
    && /'GIT_CONFIG_VALUE_0'/u.test(enterHooksIsolation)
    && /'GIT_CONFIG_PARAMETERS'/u.test(enterHooksIsolation)
    && /'GIT_TERMINAL_PROMPT'/u.test(enterHooksIsolation)
    && /'GCM_INTERACTIVE'/u.test(enterHooksIsolation)
    && /helmsman-empty-hooks-/u.test(enterHooksIsolation)
    && /FileAttributes\]::ReparsePoint/u.test(enterHooksIsolation)
    && /GetFileSystemEntries\(\$hooksFull\)[.]Count -ne 0/u.test(enterHooksIsolation)
    && /SetEnvironmentVariable\('GIT_CONFIG_COUNT', '1', 'Process'\)/u.test(enterHooksIsolation)
    && /SetEnvironmentVariable\('GIT_CONFIG_KEY_0', 'core[.]hooksPath', 'Process'\)/u.test(enterHooksIsolation)
    && /SetEnvironmentVariable\('GIT_TERMINAL_PROMPT', '0', 'Process'\)/u.test(enterHooksIsolation)
    && /SetEnvironmentVariable\('GCM_INTERACTIVE', 'Never', 'Process'\)/u.test(enterHooksIsolation)
    && /PreviousValues = \$previousValues/u.test(enterHooksIsolation)
    && /\$Scope[.]PreviousValues\[\$name\]/u.test(exitHooksIsolation)
    && /Refusing to remove a Git-hooks directory outside/u.test(exitHooksIsolation)
    && /GetFileSystemEntries\(\$hooksFull\)[.]Count -ne 0/u.test(exitHooksIsolation)
    && /Directory\]::Delete\(\$hooksFull, \$false\)/u.test(exitHooksIsolation)
    && /\$gitHooksIsolation = Enter-GitHooksIsolation/u.test(launcher)
    && /Exit-GitHooksIsolation -Scope \$gitHooksIsolation/u.test(launcher),
  "launcher disables configured Git hooks and interactive Git credential fallback, then restores the exact process environment"
);

record(
  !/\bInvoke-Expression\b|^\s*iex\s|\bStart-Process\b/imu.test(executableLauncher)
    && !/'(?:push|commit|tag|reset|clean|stash)'/iu.test(launcher)
    && !/Remove-Item[^\n]*-Recurse/iu.test(launcher)
    && !/^\s*(?:git|gh|winget)(?:[.]exe)?\s+(?!=)/imu.test(executableLauncher),
  "launcher cannot publish, rewrite history, auto-clean a clone, or execute constructed command text"
);

const publisherSourceValidation = functionBlock(publisher, "Get-ValidatedSourceRelease");
record(
  /'Publish-Helmsman[.]ps1'/u.test(publisherSourceValidation)
    && /'Publish-Helmsman[.]cmd'/u.test(publisherSourceValidation)
    && /'scripts\/Publish-HelmsmanRelease[.]ps1'/u.test(publisherSourceValidation)
    && /The source release is missing \$required/u.test(publisherSourceValidation),
  "guarded publisher requires both portable launchers and its source publisher in every future full source release"
);

record(
  /^  publisher-syntax:\s*$/mu.test(workflow)
    && /runs-on: windows-latest/u.test(workflow)
    && /shell: powershell/u.test(workflow)
    && /Publish-Helmsman[.]ps1/u.test(workflow)
    && /scripts\/Publish-HelmsmanRelease[.]ps1/u.test(workflow)
    && /System[.]Management[.]Automation[.]Language[.]Parser\]::ParseFile/u.test(workflow)
    && /Publish-Helmsman[.]ps1 -SelfTest/u.test(workflow)
    && /Publish-HelmsmanRelease[.]ps1 -SourcePath [.] -RepositoryPath [.] -SelfTest/u.test(workflow),
  "GitHub's Windows PowerShell gate parses both publishers and executes both offline safety self-tests"
);

if (failures.length) {
  console.error(`Bootstrap contract failed with ${failures.length} issue${failures.length === 1 ? "" : "s"}:`);
  failures.forEach((failure) => console.error(`  - ${failure}`));
  console.error(`${passes.length} checks passed.`);
  process.exitCode = 1;
} else {
  console.log(`Bootstrap contract passed: ${passes.length} portable setup and safety checks.`);
}
