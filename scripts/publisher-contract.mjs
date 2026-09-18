import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(root, "scripts", "Publish-HelmsmanRelease.ps1");
const sourceBuffer = readFileSync(scriptPath);
const source = sourceBuffer.toString("utf8").replace(/\r\n?/gu, "\n");
const workflow = readFileSync(join(root, ".github", "workflows", "container.yml"), "utf8").replace(/\r\n?/gu, "\n");
const sourceWithoutStringLiterals = source
  .replace(/'(?:''|[^'])*'/gu, "''")
  .replace(/"(?:`.|[^"`])*"/gu, '""');
const failures = [];
const passes = [];

function record(condition, label, detail = "") {
  if (condition) passes.push(label);
  else failures.push(detail ? `${label}: ${detail}` : label);
}

function functionBlock(name) {
  const startPattern = new RegExp(`^function ${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\{`, "mu");
  const start = source.search(startPattern);
  if (start < 0) return "";
  const remainder = source.slice(start + 1);
  const nextFunction = remainder.search(/^function [A-Za-z][A-Za-z0-9-]* \{/mu);
  const orchestration = remainder.search(/^# ORCHESTRATION\s*$/mu);
  const boundaries = [nextFunction, orchestration].filter((value) => value >= 0);
  return boundaries.length ? source.slice(start, start + 1 + Math.min(...boundaries)) : source.slice(start);
}

record(
  /^#requires -Version 5[.]1\s*$/mu.test(source)
    && /Set-StrictMode -Version Latest/u.test(source)
    && /\$ErrorActionPreference = 'Stop'/u.test(source)
    && sourceBuffer.every((byte) => byte < 0x80)
    && !source.includes("\0"),
  "publisher is an ASCII-safe Windows PowerShell 5.1 fail-closed script"
);

record(
  /^  publisher-syntax:\s*$/mu.test(workflow)
    && /name: Windows PowerShell 5[.]1 publisher contracts/u.test(workflow)
    && /runs-on: windows-latest/u.test(workflow)
    && /- name: Parse the portable and guarded publishers\s*\n\s*shell: powershell\s*\n\s*run: \|/u.test(workflow)
    && /[.]\/Publish-Helmsman[.]ps1/u.test(workflow)
    && /[.]\/scripts\/Publish-HelmsmanRelease[.]ps1/u.test(workflow)
    && /System[.]Management[.]Automation[.]Language[.]Parser\]::ParseFile\(/u.test(workflow)
    && /\[ref\]\$tokens/u.test(workflow)
    && /\[ref\]\$parseErrors/u.test(workflow)
    && /\$parseErrors[.]Count -ne 0/u.test(workflow)
    && /Publish-Helmsman[.]ps1 -SelfTest/u.test(workflow)
    && /Publish-HelmsmanRelease[.]ps1 -SourcePath [.] -RepositoryPath [.] -SelfTest/u.test(workflow)
    && /exit 1/u.test(workflow),
  "GitHub CI parses both publishers and runs both offline Windows PowerShell self-tests before any image can be released"
);

record(
  /\[Parameter\(Mandatory = \$true\)\]\s*\n\s*\[ValidateNotNullOrEmpty\(\)\]\s*\n\s*\[string\]\$SourcePath/iu.test(source)
    && /\$Repository = 'nunesg130-boop\/helmsman'/u.test(source)
    && /\$GitHubLogin = 'nunesg130-boop'/u.test(source)
    && /\$MinimumGitHubCliVersion = \[version\]'2[.]57[.]0'/u.test(source)
    && /\$Workflow = 'container[.]yml'/u.test(source)
    && /\[string\]\$RepositoryPath/u.test(source)
    && /\[string\]\$DeploymentHost/u.test(source)
    && /\[string\]\$DeploymentUser/u.test(source)
    && /\[string\]\$DeploymentRoot/u.test(source)
    && /\[switch\]\$SelfTest/u.test(source)
    && !/SkipLocalTests|Invoke-LocalTestsIfAvailable|npm[.]cmd|node[.]exe/u.test(source)
    && !/\?\?|ForEach-Object\s+-Parallel|\[IO[.]Path\]::GetRelativePath|^\s*[^#\r\n]+\s(?:&&|\|\|)\s/imu.test(sourceWithoutStringLiterals),
  "publisher accepts optional deployment guidance inputs and remains compatible with Windows PowerShell 5.1"
);

const deploymentSettings = functionBlock("Get-ValidatedDeploymentSettings");
record(
  /DeploymentHost, DeploymentUser, and DeploymentRoot must be supplied together or all omitted/u.test(deploymentSettings)
    && /\^\[A-Za-z_\]\[A-Za-z0-9[.]_-\]\{0,31\}\$/u.test(deploymentSettings)
    && /IPAddress\]::TryParse/u.test(deploymentSettings)
    && /AddressFamily\]::InterNetwork/u.test(deploymentSettings)
    && /valid DNS host name or IPv4 address/u.test(deploymentSettings)
    && /\^\/\[A-Za-z0-9[.]_-\]\+/u.test(deploymentSettings)
    && /\$rootSegments -contains '[.]'/u.test(deploymentSettings)
    && /\$rootSegments -contains '[.][.]'/u.test(deploymentSettings)
    && /Root = \$DeploymentRoot[.]TrimEnd\(\[char\[\]\]@\('\/'\)\)/u.test(deploymentSettings),
  "optional deployment inputs are all-or-none and reject shell syntax, credentials, relative paths, traversal, and malformed hosts"
);

const enterHooksIsolation = functionBlock("Enter-GitHooksIsolation");
const exitHooksIsolation = functionBlock("Exit-GitHooksIsolation");
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
    && /Directory\]::Delete\(\$hooksFull, \$false\)/u.test(exitHooksIsolation)
    && /\$gitHooksIsolation = Enter-GitHooksIsolation/u.test(source)
    && /Exit-GitHooksIsolation -Scope \$gitHooksIsolation/u.test(source),
  "publisher disables Git hooks and interactive credential fallback for direct and nested execution, then restores the environment"
);

const probe = functionBlock("Invoke-NativeProbe");
const text = functionBlock("Invoke-NativeText");
const live = functionBlock("Invoke-NativeLive");
const json = functionBlock("Invoke-NativeJson");
const directNativeInvocations = source.split("\n").filter((line) => /^\s*(?:git|gh|node|npm)(?:[.]exe|[.]cmd)?\s/iu.test(line));
const nativeCallOperators = source.match(/& \$FilePath @ArgumentList/gu) || [];
const capturedNativeCallOperators = source.match(/\$stdoutRecords = @\(& \$FilePath @ArgumentList 2> \$stderrPath\)/gu) || [];
record(
  /\$previousPreference = \$ErrorActionPreference/u.test(probe)
    && /\$ErrorActionPreference = 'Continue'/u.test(probe)
    && /& \$FilePath @ArgumentList 2> \$stderrPath/u.test(probe)
    && /\$exitCode = \$LASTEXITCODE/u.test(probe)
    && /finally\s*\{\s*\$ErrorActionPreference = \$previousPreference\s*\}/su.test(probe)
    && /StdOut = \$stdout/u.test(probe)
    && /StdErr = \$stderr/u.test(probe)
    && /Remove-Item -LiteralPath \$stderrPath -Force/u.test(probe)
    && /Invoke-NativeProbe/u.test(text)
    && /\$result[.]ExitCode -ne 0/u.test(text)
    && /\$ErrorActionPreference = 'Continue'/u.test(live)
    && /\$exitCode = \$LASTEXITCODE/u.test(live)
    && /\$exitCode -ne 0/u.test(live)
    && /& \$FilePath @ArgumentList 2> \$stderrPath/u.test(json)
    && /\$exitCode = \$LASTEXITCODE/u.test(json)
    && /\$stdout \| ConvertFrom-Json/u.test(json)
    && /Remove-Item -LiteralPath \$stderrPath -Force/u.test(json)
    && directNativeInvocations.length === 0
    && nativeCallOperators.length === 3
    && capturedNativeCallOperators.length === 2,
  "native tools are invoked only through exit-code-checked wrappers that tolerate normal Git stderr",
  directNativeInvocations.join("; ")
);

const canonicalRepository = functionBlock("Get-CanonicalRepository");
const expectedHttpsRepositoryUrl = functionBlock("Assert-ExpectedHttpsRepositoryUrl");
const credentialOverrides = functionBlock("Assert-NoGitHubCredentialOverrides");
const authenticationScope = functionBlock("Test-GitHubAuthenticationScope");
const githubAuthentication = functionBlock("Assert-GitHubAuthentication");
const requiredTools = functionBlock("Assert-RequiredTool");
const cleanMain = functionBlock("Assert-CleanMainAtOrigin");
record(
  /PathType Container/u.test(canonicalRepository)
    && /Git metadata cannot be a symlink or reparse point/u.test(canonicalRepository)
    && /remote', 'get-url', '--all', 'origin'/u.test(canonicalRepository)
    && /remote', 'get-url', '--push', '--all', 'origin'/u.test(canonicalRepository)
    && /\$origins[.]Count -ne 1/u.test(canonicalRepository)
    && /\$pushOrigins[.]Count -ne 1/u.test(canonicalRepository)
    && /remote[.]origin[.]mirror/u.test(canonicalRepository)
    && /ConvertTo-GitHubSlug/u.test(canonicalRepository)
    && /Assert-ExpectedHttpsRepositoryUrl/u.test(canonicalRepository)
    && /https:\/\/github[.]com\//u.test(expectedHttpsRepositoryUrl)
    && /StringComparison\]::Ordinal\)/u.test(expectedHttpsRepositoryUrl)
    && /Git URL rewrites are not allowed/u.test(expectedHttpsRepositoryUrl)
    && /Assert-NoGitHubCredentialOverrides/u.test(canonicalRepository)
    && /--get-urlmatch', 'http[.]extraHeader'/u.test(credentialOverrides)
    && /its value was not displayed/iu.test(credentialOverrides)
    && /--local', '--name-only', '--get-regexp'/u.test(credentialOverrides)
    && /repository-local credential helper override/u.test(credentialOverrides)
    && /--worktree', '--name-only', '--get-regexp'/u.test(credentialOverrides)
    && /worktree-specific credential helper override/u.test(credentialOverrides)
    && /\$slug -cne \$ExpectedRepository[.]ToLowerInvariant\(\)/u.test(canonicalRepository)
    && /\$pushSlug -cne \$ExpectedRepository[.]ToLowerInvariant\(\)/u.test(canonicalRepository)
    && /-cne 'main'/u.test(canonicalRepository)
    && /ExpectedRepository[.]ToLowerInvariant/u.test(canonicalRepository)
    && /--version/u.test(requiredTools)
    && /MinimumGitHubCliVersion/u.test(requiredTools)
    && /'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR'/u.test(githubAuthentication)
    && /Its value was not displayed/u.test(githubAuthentication)
    && /auth', 'status', '--active', '--hostname', 'github[.]com'/u.test(githubAuthentication)
    && /'api', 'user', '--jq', '[.]login'/u.test(githubAuthentication)
    && /\$login -cne \$ExpectedLogin/u.test(githubAuthentication)
    && /repo.*workflow permissions/u.test(githubAuthentication)
    && /Test-GitHubAuthenticationScope -StatusText \$statusText -RequiredScope 'repo'/u.test(githubAuthentication)
    && /Test-GitHubAuthenticationScope -StatusText \$statusText -RequiredScope 'workflow'/u.test(githubAuthentication)
    && /Token scopes:/u.test(authenticationScope)
    && /[.]Value[.]Split\(','\)/u.test(authenticationScope)
    && /\$scope -ceq \$RequiredScope/u.test(authenticationScope)
    && /\$repositorySelector = 'github[.]com\/' \+ \$ExpectedRepository/u.test(githubAuthentication)
    && /repo', 'view', \$repositorySelector/u.test(githubAuthentication)
    && /nameWithOwner,viewerPermission,defaultBranchRef,isArchived/u.test(githubAuthentication)
    && /viewerPermission -cnotin @\('WRITE', 'MAINTAIN', 'ADMIN'\)/u.test(githubAuthentication)
    && /defaultBranchRef[.]name -cne 'main'/u.test(githubAuthentication)
    && /Properties\['isArchived'\][.]Value -isnot \[bool\]/u.test(githubAuthentication)
    && /'auth', 'setup-git', '--hostname', 'github[.]com'/u.test(githubAuthentication)
    && /Assert-NoGitHubCredentialOverrides/u.test(githubAuthentication)
    && /'ls-remote', '--get-url', \$expectedUrl/u.test(githubAuthentication)
    && /'ls-remote', '--exit-code', \$expectedUrl, 'refs\/heads\/main'/u.test(githubAuthentication)
    && /status', '--porcelain=v1', '--untracked-files=all'/u.test(cleanMain)
    && /fetch', '--no-tags', '--no-prune', '--recurse-submodules=no', 'origin'/u.test(cleanMain)
    && /refs\/heads\/main:refs\/remotes\/origin\/main/u.test(cleanMain)
    && /merge', '--ff-only', '--no-edit', 'refs\/remotes\/origin\/main'/u.test(cleanMain)
    && /rev-parse', 'HEAD'/u.test(cleanMain)
    && /rev-parse', 'refs\/remotes\/origin\/main'/u.test(cleanMain)
    && /\$localHead -cne \$remoteHead/u.test(cleanMain),
  "publisher binds HTTPS Git to the exact active writable GitHub account, rejects credential overrides, and fast-forwards clean main only"
);

const prohibitedPaths = functionBlock("Test-ProhibitedReleasePath");
const embeddedSecrets = functionBlock("Assert-NoEmbeddedSecrets");
const sourceValidation = functionBlock("Get-ValidatedSourceRelease");
const allowedBinaryPathsBlock = embeddedSecrets.match(/\$allowedBinaryPaths\s*=\s*@\(([\s\S]*?)\n\s*\)/u)?.[1] || "";
const configuredAllowedBinaryPaths = [...allowedBinaryPathsBlock.matchAll(/'([^']+)'/gu)]
  .map((match) => match[1])
  .sort();
const expectedAllowedBinaryPaths = [
  "assets/helmsman-logo.png",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/icon-maskable-512.png",
  "assets/services/bazarr.png",
  "assets/services/prowlarr.png",
  "assets/services/proxmox.png",
].sort();
record(
  [".git", ".idea", ".nyc_output", ".vscode", "backup", "backups", "coverage", "data", "node_modules", ".helmsman-data"]
    .every((name) => prohibitedPaths.includes(`'${name}'`))
    && [".npmrc", ".pypirc", ".netrc", "_netrc"]
      .every((name) => prohibitedPaths.includes(`'${name}'`))
    && prohibitedPaths.includes("if ($name -match '^id_(?:rsa|dsa|ecdsa|ed25519(?:_sk)?)(?:[.]pub)?$')")
    && ["state.json", "sessions.json", "credentials.json", "credentials.key", "master-key.hex"]
      .every((name) => prohibitedPaths.includes(`'${name}'`))
    && /[.]env[.]example/u.test(prohibitedPaths)
    && /key\|pem\|crt\|cer\|p12\|pfx\|log\|zip\|tar\|tgz\|db\|sqlite\|sqlite3\|bak\|old\|orig\|rej\|swp\|swo\|tmp\|temp\|patch\|diff/u.test(prohibitedPaths)
    && /PRIVATE KEY/u.test(embeddedSecrets)
    && /GitHub classic token/u.test(embeddedSecrets)
    && /GitHub fine-grained token/u.test(embeddedSecrets)
    && /HELMSMAN_ACCESS_KEY\|CLOUDFLARE_API_TOKEN\|CF_API_TOKEN/u.test(embeddedSecrets)
    && /allowedBinaryPaths/u.test(embeddedSecrets)
    && JSON.stringify(configuredAllowedBinaryPaths) === JSON.stringify(expectedAllowedBinaryPaths)
    && /unreviewed binary or unknown file type/u.test(embeddedSecrets),
  "source and staged trees reject credentials, runtime state, dependencies, backups, archives, and binaries outside the exact reviewed raster allowlist",
  configuredAllowedBinaryPaths.join(", ")
);

const scannerPatternSources = [
  "-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?" + "PRIVATE KEY-----",
  "-----BEGIN PGP " + "PRIVATE KEY BLOCK-----",
  "gh[pousr]_[A-Za-z0-9]{20,}",
  "github_pat_[A-Za-z0-9_]{20,}",
  "(?:AKIA|ASIA)[A-Z0-9]{16}",
  "npm_[A-Za-z0-9]{30,}",
  "^\\s*(?:HELMSMAN_ACCESS_KEY|CLOUDFLARE_API_TOKEN|CF_API_TOKEN)\\s*=\\s*\\S+"
];
const scannerPatterns = scannerPatternSources.map((pattern, index) => new RegExp(pattern, index === 6 ? "imu" : "iu"));
const detectedScannerFixtures = [
  "-----BEGIN " + "PRIVATE KEY-----",
  "-----BEGIN PGP " + "PRIVATE KEY BLOCK-----",
  `ghp_${"A".repeat(20)}`,
  `github_pat_${"B".repeat(20)}`,
  `AKIA${"C".repeat(16)}`,
  `npm_${"D".repeat(30)}`,
  "HELMSMAN_" + "ACCESS_KEY=not-a-release-value"
];
const allowedSyntheticFixtures = [
  "https://" + "admin:secret@example.invalid/path",
  "http://" + "user:pass@media.test",
  "https://" + "${username}:${secret}@example.invalid"
];
record(
  (embeddedSecrets.match(/\[PSCustomObject\]@\{/gu) || []).length === scannerPatterns.length
    && /\('gh' \+ '\[pousr\]_'\) \+ '\[A-Za-z0-9\]\{20,\}'/u.test(embeddedSecrets)
    && /\('\(\?:AK' \+ 'IA\|AS' \+ 'IA\)'\) \+ '\[A-Z0-9\]\{16\}'/u.test(embeddedSecrets)
    && /PGP private key material/u.test(embeddedSecrets)
    && scannerPatterns.every((pattern, index) => pattern.test(detectedScannerFixtures[index]))
    && allowedSyntheticFixtures.every((fixture) => scannerPatterns.every((pattern) => !pattern.test(fixture)))
    && /The matching value was not displayed/u.test(embeddedSecrets),
  "embedded-secret scanner patterns compile, catch high-confidence credentials, avoid synthetic URL fixtures, and never echo a match"
);
record(
  [
    "package.json",
    "compose.yaml",
    "container.env.example",
    ".gitattributes",
    ".github/workflows/container.yml",
    "Publish-Helmsman.ps1",
    "Publish-Helmsman.cmd"
  ].every((name) => sourceValidation.includes(`'${name}'`))
    && /FileAttributes\]::ReparsePoint/u.test(sourceValidation)
    && /Get-RegularTreeEntries/u.test(sourceValidation)
    && /sourcePathKeys[.]ContainsKey/u.test(sourceValidation)
    && /case-colliding files/u.test(sourceValidation)
    && /Assert-NoProhibitedPaths/u.test(sourceValidation)
    && /Assert-NoEmbeddedSecrets/u.test(sourceValidation)
    && /ConvertFrom-Json/u.test(sourceValidation)
    && /package[.]name -cne 'helmsman'/u.test(sourceValidation)
    && /\$semver = '\^\(0\|\[1-9\]\[0-9\]\*\)/u.test(sourceValidation)
    && /\$version -notmatch \$semver/u.test(sourceValidation)
    && /\$expectedImage = "ghcr[.]io\/OWNER\/REPOSITORY:\$version"/u.test(sourceValidation)
    && /\$composeImageLines = @\(\[regex\]::Matches\(\$composeText/u.test(sourceValidation)
    && /\$composeImageLines[.]Count -ne 1/u.test(sourceValidation)
    && /\[regex\]::IsMatch\(\$composeText, \$expectedComposePattern\)/u.test(sourceValidation)
    && /\$environmentImageLines = @\(\[regex\]::Matches\(\$environmentText/u.test(sourceValidation)
    && /\$environmentImageLines[.]Count -ne 1/u.test(sourceValidation)
    && /\[regex\]::IsMatch\(\$environmentText, \$expectedEnvironmentPattern\)/u.test(sourceValidation)
    && /source [. ]gitattributes cannot invoke an external Git content filter/iu.test(sourceValidation)
    && /Tag = 'v' \+ \$version/u.test(sourceValidation),
  "publisher validates a complete, regular-file Helmsman source tree and derives its release tag from strict SemVer"
);

const newRelease = functionBlock("Assert-ReleaseIsNew");
const synchronization = functionBlock("Sync-SourceTree");
const staging = functionBlock("Stage-AndValidateRelease");
record(
  /\$repositorySelector = 'github[.]com\/' \+ \$ExpectedRepository/u.test(newRelease)
    && /show-ref', '--verify', '--quiet', "refs\/tags\/\$Tag"/u.test(newRelease)
    && /check-ref-format', "refs\/tags\/\$Tag"/u.test(newRelease)
    && /ls-remote', '--exit-code', '--tags', 'origin', "refs\/tags\/\$Tag"/u.test(newRelease)
    && /release', 'view', \$Tag/u.test(newRelease)
    && /GitHub release lookup failed unexpectedly/u.test(newRelease),
  "publisher refuses to replace an existing local tag, remote tag, or GitHub release"
);
record(
  /'ls-files'/u.test(synchronization)
    && /Assert-NoProhibitedPaths/u.test(synchronization)
    && /\$publisherPath/u.test(synchronization)
    && /Existing index-mode inspection/u.test(synchronization)
    && /\$tracked \+ \$Release[.]Files/u.test(synchronization)
    && /Remove-Item -LiteralPath \$destinationFile -Force/u.test(synchronization)
    && !/Remove-Item[^\n]*-Recurse/iu.test(synchronization)
    && /Copy-Item -LiteralPath \$sourceFile -Destination \$destinationFile -Force/u.test(synchronization)
    && /Join-SafePath/u.test(synchronization),
  "source synchronization preserves the running helper and removes only validated tracked files absent from the release"
);
record(
  /\$pathsToStage = @\(\$Release[.]Files\)/u.test(staging)
    && /\$pathsToStage -notcontains \$PublisherPath/u.test(staging)
    && /'check-attr', '--all', '--', \$relative/u.test(staging)
    && /\$attribute -match '\(\?m\): filter:'/u.test(staging)
    && /'add', '-A', '--', '[.]'/u.test(staging)
    && /'diff', '--cached', '--quiet'/u.test(staging)
    && /'diff', '--cached', '--check'/u.test(staging)
    && /'ls-files', '--stage'/u.test(staging)
    && /120000\|160000/u.test(staging)
    && /Assert-NoProhibitedPaths/u.test(staging)
    && /'checkout-index', '--all', "--prefix=\$gitPrefix"/u.test(staging)
    && /Assert-NoEmbeddedSecrets -Root \$indexRoot -RelativePaths \$tracked/u.test(staging)
    && /\$expectedPaths[.]ContainsKey/u.test(staging)
    && /\$trackedPaths[.]ContainsKey/u.test(staging)
    && /foreach \(\$key in \$expectedPaths[.]Keys\)/u.test(staging)
    && /validated source file is absent from the staged release/u.test(staging)
    && /foreach \(\$key in \$trackedPaths[.]Keys\)/u.test(staging)
    && /staged release contains a file outside the validated source manifest/u.test(staging)
    && /'hash-object', "--path=\$relative"/u.test(staging)
    && /'rev-parse', ":\$relative"/u.test(staging)
    && /\$sourceBlob -cne \$stagedBlob/u.test(staging)
    && /destinationPackage[.]version -cne \$Release[.]Version/u.test(staging)
    && /return Invoke-NativeText[^\n]*'write-tree'/u.test(staging),
  "staging includes deletions and rejects empty, malformed, linked, secret-bearing, or version-mismatched releases"
);

const stagedTree = functionBlock("Assert-StagedTreeUnchanged");
record(
  !/SkipLocalTests|Invoke-LocalTestsIfAvailable|Assert-NoUnstagedReleaseChanges|npm[.]cmd|node[.]exe/u.test(source)
    && /'write-tree'/u.test(stagedTree)
    && /\$actualTree -cne \$ExpectedTree/u.test(stagedTree),
  "authenticated publisher never executes candidate code and rechecks the reviewed staged tree before confirmation"
);

const confirmation = functionBlock("Confirm-Release");
const readHostCalls = source.match(/\bRead-Host\b/gu) || [];
record(
  readHostCalls.length === 1
    && /Type PUBLISH \$\(\$Release[.]Version\) to continue/u.test(confirmation)
    && /-ceq "PUBLISH \$\(\$Release[.]Version\)"/u.test(confirmation),
  "one exact typed confirmation gates all remote publication"
);

const workflowWaiter = functionBlock("Wait-WorkflowForCommit");
const workflowRunIds = functionBlock("Get-WorkflowRunIds");
const workflowRunListParser = functionBlock("ConvertFrom-GitHubRunListJson");
const workflowRunViewParser = functionBlock("ConvertFrom-GitHubRunViewJson");
const requiredJsonProperties = functionBlock("Assert-RequiredJsonProperties");
const publisherSelfTest = functionBlock("Invoke-PublisherSelfTest");
record(
  /Assert-ExpectedHttpsRepositoryUrl/u.test(publisherSelfTest)
    && /git@github[.]com:nunesg130-boop\/helmsman[.]git/u.test(publisherSelfTest)
    && /accepted an SSH origin URL/u.test(publisherSelfTest)
    && /caseChangedUrlRejected/u.test(publisherSelfTest)
    && /accepted a case-changed origin URL/u.test(publisherSelfTest)
    && /repo:status/u.test(publisherSelfTest)
    && /did not require exact GitHub scope names/u.test(publisherSelfTest)
    && /\$parsedRuns = \$trimmed \| ConvertFrom-Json/u.test(workflowRunListParser)
    && /\$rawRuns = @\(\$parsedRuns \| Write-Output\)/u.test(workflowRunListParser)
    && /'databaseId', 'headBranch', 'headSha'/u.test(workflowRunListParser)
    && /PSObject[.]Properties\[\$name\]/u.test(requiredJsonProperties)
    && /missing the required '\$name' property/u.test(requiredJsonProperties)
    && /returned null for the required '\$name' property/u.test(requiredJsonProperties)
    && /ConvertFrom-GitHubRunListJson/u.test(workflowRunIds)
    && /\$repositorySelector = 'github[.]com\/' \+ \$ExpectedRepository/u.test(workflowRunIds)
    && /'run', 'list', '--repo', \$repositorySelector, '--workflow', \$WorkflowName/u.test(workflowRunIds)
    && /'--event', 'push', '--commit', \$CommitSha, '--limit', '100'/u.test(workflowRunIds)
    && /HeadSha -ceq \$CommitSha -and \$_[.]HeadBranch -ceq \$RefName/u.test(workflowRunIds)
    && /DatabaseId/u.test(workflowRunIds)
    && /\[string\]\$CommitSha/u.test(workflowWaiter)
    && /\[string\]\$RefName/u.test(workflowWaiter)
    && /\[string\[\]\]\$ExcludedRunIds/u.test(workflowWaiter)
    && /DiscoveryTimeoutSeconds = 180/u.test(workflowWaiter)
    && /CompletionTimeoutSeconds = 3600/u.test(workflowWaiter)
    && /\$repositorySelector = 'github[.]com\/' \+ \$ExpectedRepository/u.test(workflowWaiter)
    && /\$excluded\[\[string\]\$runId\] = \$true/u.test(workflowWaiter)
    && /'run', 'list'/u.test(workflowWaiter)
    && /'--event', 'push', '--commit', \$CommitSha/u.test(workflowWaiter)
    && /ConvertFrom-GitHubRunListJson/u.test(workflowWaiter)
    && /HeadSha -ceq \$CommitSha -and \$_[.]HeadBranch -ceq \$RefName/u.test(workflowWaiter)
    && /!\$excluded[.]ContainsKey\(\$_[.]DatabaseId\)/u.test(workflowWaiter)
    && /Start-Sleep -Seconds 5/u.test(workflowWaiter)
    && /'run', 'view'/u.test(workflowWaiter)
    && /\$matchingRuns[.]Count -gt 1/u.test(workflowWaiter)
    && /Refusing to guess/u.test(workflowWaiter)
    && /ConvertFrom-GitHubRunViewJson/u.test(workflowWaiter)
    && /\$view[.]HeadSha -cne \$CommitSha/u.test(workflowWaiter)
    && /\$view[.]HeadBranch -cne \$RefName/u.test(workflowWaiter)
    && /\$view[.]Event -cne 'push'/u.test(workflowWaiter)
    && /\$view[.]Status -ceq 'completed'/u.test(workflowWaiter)
    && /\$view[.]Conclusion -cne 'success'/u.test(workflowWaiter)
    && /'conclusion', 'headBranch', 'headSha', 'event', 'status'/u.test(workflowRunViewParser)
    && /Start-Sleep -Seconds 10/u.test(workflowWaiter),
  "workflow gates snapshot prior IDs, discover one new exact commit/ref run, and poll it within bounded deadlines"
);

record(
  /ConvertFrom-GitHubRunListJson -Json '\[\]'/u.test(publisherSelfTest)
    && /Get-ValidatedDeploymentSettings/u.test(publisherSelfTest)
    && /host[.]example[.]test/u.test(publisherSelfTest)
    && /invalidDeploymentCases/u.test(publisherSelfTest)
    && /host;whoami/u.test(publisherSelfTest)
    && /user@example[.]test/u.test(publisherSelfTest)
    && /999[.]1[.]1[.]1/u.test(publisherSelfTest)
    && /\/srv\/[.][.]\/helmsman/u.test(publisherSelfTest)
    && /singleRuns[.]Count -ne 1/u.test(publisherSelfTest)
    && /twoRuns[.]Count -ne 2/u.test(publisherSelfTest)
    && /missingPropertyRejected/u.test(publisherSelfTest)
    && /nullPropertyRejected/u.test(publisherSelfTest)
    && /wrongShapeRejected/u.test(publisherSelfTest)
    && /malformedViewRejected/u.test(publisherSelfTest)
    && /if \(\$SelfTest\)\s*\{\s*Invoke-PublisherSelfTest\s*return\s*\}/su.test(source)
    && !source.includes("$runs = @($json | ConvertFrom-Json)"),
  "Windows PowerShell self-test covers malformed workflow JSON and unsafe optional deployment inputs"
);

const mainPush = functionBlock("Push-Main");
const tagPush = functionBlock("New-AndPushReleaseTag");
const publishedRelease = functionBlock("Assert-PublishedRelease");
const releaseCommit = functionBlock("New-ReleaseCommit");
const remotePushes = source.match(/'push', '--no-follow-tags', '--recurse-submodules=no', 'origin'/gu) || [];
record(
  /Get-CanonicalRepository/u.test(mainPush)
    && mainPush.indexOf("Get-CanonicalRepository") < mainPush.indexOf("'push'")
    && /Assert-GitHubAuthentication/u.test(mainPush)
    && mainPush.indexOf("Assert-GitHubAuthentication") < mainPush.indexOf("'push'")
    && /ExpectedRepository/u.test(mainPush)
    && /ExpectedLogin/u.test(mainPush)
    && /'push', '--no-follow-tags', '--recurse-submodules=no', 'origin', "\$\{CommitSha\}:refs\/heads\/main"/u.test(mainPush)
    && /refs\/heads\/main/u.test(mainPush)
    && /'tag', '-a', \$Release[.]Tag/u.test(tagPush)
    && /\$tagObject = Invoke-NativeText[^\n]*'rev-parse', "refs\/tags\/\$\(\$Release[.]Tag\)"/u.test(tagPush)
    && /Get-CanonicalRepository/u.test(tagPush)
    && tagPush.indexOf("Get-CanonicalRepository") < tagPush.indexOf("'tag'")
    && tagPush.indexOf("Get-CanonicalRepository") < tagPush.indexOf("'push'")
    && /Assert-GitHubAuthentication/u.test(tagPush)
    && tagPush.indexOf("Assert-GitHubAuthentication") < tagPush.indexOf("'tag'")
    && /Assert-ReleaseIsNew/u.test(tagPush)
    && tagPush.indexOf("Assert-ReleaseIsNew") < tagPush.indexOf("'tag'")
    && /ExpectedRepository/u.test(tagPush)
    && /ExpectedLogin/u.test(tagPush)
    && /'push', '--no-follow-tags', '--recurse-submodules=no', 'origin', "\$\{tagObject\}:refs\/tags\/\$\(\$Release[.]Tag\)"/u.test(tagPush)
    && /refs\/tags\/\$\(\$Release[.]Tag\)\^\{\}/u.test(tagPush)
    && /\$repositorySelector = 'github[.]com\/' \+ \$ExpectedRepository/u.test(publishedRelease)
    && /\$assetNames[.]Count -ne 3/u.test(publishedRelease)
    && /'compose[.]yaml', 'container[.]env[.]example', 'SHA256SUMS'/u.test(publishedRelease)
    && /'release', 'download', \$Release[.]Tag/u.test(publishedRelease)
    && /'--dir', \$assetRoot/u.test(publishedRelease)
    && /\$checksumLines[.]Count -ne 2/u.test(publishedRelease)
    && /\^\(\[0-9a-f\]\{64\}\)\\s\+\(\(\?:compose/u.test(publishedRelease)
    && /Get-FileHash/u.test(publishedRelease)
    && /OWNER\/REPOSITORY/u.test(publishedRelease)
    && /sha256:\[0-9a-f\]\{64\}/u.test(publishedRelease)
    && /\$publishedDigest -cne \$assetDigests\[0\]/u.test(publishedRelease)
    && /expectedPrerelease/u.test(publishedRelease)
    && /verified deployment directory already exists/u.test(publishedRelease)
    && /Move-Item -LiteralPath \$assetRoot -Destination \$DeploymentDirectory/u.test(publishedRelease)
    && /Directory = \$DeploymentDirectory/u.test(publishedRelease)
    && /Image = 'ghcr[.]io\/' \+ \$ExpectedRepository[.]ToLowerInvariant\(\) \+ '@' \+ \$publishedDigest/u.test(publishedRelease)
    && /'write-tree'/u.test(releaseCommit)
    && /'rev-parse', 'HEAD\^\{tree\}'/u.test(releaseCommit)
    && /\$actualTree -cne \$ExpectedTree/u.test(releaseCommit)
    && /status', '--porcelain=v1', '--untracked-files=all'/u.test(releaseCommit)
    && remotePushes.length === 2
    && !/(?:['"]--force(?:-with-lease)?['"]|'reset', '--hard'|'clean', '-[a-z]*f'|'release', '(?:create|upload|delete)'|'checkout', '--'|\bInvoke-Expression\b|^\s*iex\s)/imu.test(source),
  "publisher permits only ordinary main and annotated-tag pushes and verifies immutable release assets"
);

const orchestrationMarker = source.indexOf("# ORCHESTRATION");
const orchestration = orchestrationMarker >= 0 ? source.slice(orchestrationMarker) : "";
const orderedCalls = [
  "Get-ValidatedDeploymentSettings",
  "Assert-RequiredTool",
  "Get-CanonicalRepository",
  "Assert-GitHubAuthentication",
  "Assert-CleanMainAtOrigin",
  "Assert-GitAuthor",
  "Get-ValidatedSourceRelease",
  "Assert-ReleaseIsNew",
  "Sync-SourceTree",
  "Stage-AndValidateRelease",
  "Assert-StagedTreeUnchanged",
  "Show-StagedSummary",
  "Confirm-Release",
  "New-ReleaseCommit",
  "Get-WorkflowRunIds",
  "Push-Main",
  "Wait-WorkflowForCommit",
  "Get-WorkflowRunIds",
  "New-AndPushReleaseTag",
  "Wait-WorkflowForCommit",
  "Assert-PublishedRelease",
  "Show-DeploymentHandoff"
];
let cursor = -1;
let orchestrationValid = orchestrationMarker >= 0;
for (const name of orderedCalls) {
  const position = orchestration.indexOf(name, cursor + 1);
  if (position <= cursor) {
    orchestrationValid = false;
    break;
  }
  cursor = position;
}
const expectedCallCounts = new Map(orderedCalls.map((name) => [
  name,
  ["Get-WorkflowRunIds", "Wait-WorkflowForCommit"].includes(name) ? 2 : 1
]));
for (const [name, expected] of expectedCallCounts) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const count = (orchestration.match(new RegExp(`\\b${escaped}\\b`, "gu")) || []).length;
  if (count !== expected) orchestrationValid = false;
}
record(
  orchestrationValid
    && /-DeploymentHost \$DeploymentHost/u.test(orchestration)
    && /-DeploymentUser \$DeploymentUser/u.test(orchestration)
    && /-DeploymentRoot \$DeploymentRoot/u.test(orchestration)
    && /Resolve-Path -LiteralPath \$SourcePath/u.test(orchestration)
    && /\$repositoryCandidate = if \(\[string\]::IsNullOrWhiteSpace\(\$RepositoryPath\)\)/u.test(orchestration)
    && /Resolve-Path -LiteralPath \$repositoryCandidate/u.test(orchestration)
    && /FileAttributes\]::ReparsePoint/u.test(orchestration)
    && /source release and publisher repository must be separate, non-nested directories/u.test(orchestration)
    && /\$publisherPath = 'scripts\/Publish-HelmsmanRelease[.]ps1'/u.test(orchestration)
    && /Sync-SourceTree[^\n]*-PublisherPath \$publisherPath/u.test(orchestration)
    && /Stage-AndValidateRelease[^\n]*-Release \$release -PublisherPath \$publisherPath/u.test(orchestration)
    && /\$existingMainRuns = @\(Get-WorkflowRunIds/u.test(orchestration)
    && /-RefName 'main' -ExcludedRunIds \$existingMainRuns/u.test(orchestration)
    && /\$existingTagRuns = @\(Get-WorkflowRunIds/u.test(orchestration)
    && /-RefName \$release[.]Tag -ExcludedRunIds \$existingTagRuns/u.test(orchestration)
    && /RefName 'main'/u.test(orchestration)
    && /RefName \$release[.]Tag/u.test(orchestration)
    && /Nothing was committed, tagged, or pushed/u.test(orchestration),
  "orchestration confirms once, validates main CI before tagging, validates tag CI, and only then reports deployment",
  orderedCalls.join(" -> ")
);

const deploymentHandoff = functionBlock("Show-DeploymentHandoff");
record(
  /No deployment host was changed/u.test(deploymentHandoff)
    && /No deployment target was supplied/u.test(deploymentHandoff)
    && /For future releases, supply all three optional parameters before publication/u.test(deploymentHandoff)
    && /-DeploymentHost '<server-host>' -DeploymentUser '<ssh-user>' -DeploymentRoot '<absolute-install-directory>'/u.test(deploymentHandoff)
    && /if \(\$null -eq \$Deployment\)/u.test(deploymentHandoff)
    && /\$target = \$Deployment[.]User \+ '@' \+ \$Deployment[.]Host/u.test(deploymentHandoff)
    && /\$remoteReleaseDirectory = \$Deployment[.]Root \+ '\/releases\/' \+ \$Release[.]Tag/u.test(deploymentHandoff)
    && /Join-Path \$Publication[.]Directory 'compose[.]yaml'/u.test(deploymentHandoff)
    && /Join-Path \$Publication[.]Directory 'container[.]env[.]example'/u.test(deploymentHandoff)
    && /Join-Path \$Publication[.]Directory 'SHA256SUMS'/u.test(deploymentHandoff)
    && /scp [^\n]*\$localCompose/u.test(deploymentHandoff)
    && /scp [^\n]*\$localEnvironmentExample/u.test(deploymentHandoff)
    && /scp [^\n]*\$localChecksums/u.test(deploymentHandoff)
    && /sha256sum --strict --check SHA256SUMS/u.test(deploymentHandoff)
    && /if \[ -e compose[.]yaml[.]before-\$\(\$Release[.]Version\) \] \|\| \[ -e [.]env[.]before-\$\(\$Release[.]Version\) \]/u.test(deploymentHandoff)
    && /cp -- compose[.]yaml compose[.]yaml[.]before-\$\(\$Release[.]Version\)/u.test(deploymentHandoff)
    && /unset HELMSMAN_IMAGE COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROJECT_NAME COMPOSE_PROFILES/u.test(deploymentHandoff)
    && /if \[ -f [.]env \]; then cp -- [.]env [.]env[.]before-\$\(\$Release[.]Version\)/u.test(deploymentHandoff)
    && /awk [^\n]*HELMSMAN_IMAGE/u.test(deploymentHandoff)
    && /HELMSMAN_IMAGE=" \+ \$image/u.test(deploymentHandoff)
    && /chmod --reference=[.]env/u.test(deploymentHandoff)
    && /chown --reference=[.]env/u.test(deploymentHandoff)
    && /mv -- [^\n]*[.]env/u.test(deploymentHandoff)
    && /docker compose --file compose[.]yaml --env-file [.]env config/u.test(deploymentHandoff)
    && /docker compose --file compose[.]yaml --env-file [.]env config --images/u.test(deploymentHandoff)
    && /Resolved image does not match the verified release digest/u.test(deploymentHandoff)
    && /docker compose --file compose[.]yaml --env-file [.]env pull helmsman/u.test(deploymentHandoff)
    && /docker compose --file compose[.]yaml --env-file [.]env up -d --force-recreate helmsman/u.test(deploymentHandoff)
    && /docker compose --file compose[.]yaml --env-file [.]env ps/u.test(deploymentHandoff)
    && /docker compose --file compose[.]yaml --env-file [.]env logs --tail=100 helmsman/u.test(deploymentHandoff)
    && !/Invoke-Native/u.test(deploymentHandoff)
    && !/\$remoteReleaseDirectory = '|The .* server was not changed/u.test(source)
    && !/docker compose down -v/iu.test(source)
    && !/^\s*(?:docker|ssh)\s/imu.test(source),
  "generic deployment handoff is optional, validates its target, transfers verified assets, and remains manual"
);

if (failures.length) {
  console.error(`Publisher contract failed with ${failures.length} issue${failures.length === 1 ? "" : "s"}:`);
  failures.forEach((failure) => console.error(`  - ${failure}`));
  console.error(`${passes.length} checks passed.`);
  process.exitCode = 1;
} else {
  console.log(`Publisher contract passed: ${passes.length} deterministic release-safety checks.`);
}
