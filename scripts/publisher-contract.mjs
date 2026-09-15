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
    && /name: Windows PowerShell 5[.]1 publisher syntax/u.test(workflow)
    && /runs-on: windows-latest/u.test(workflow)
    && /- name: Parse the guarded release publisher\s*\n\s*shell: powershell\s*\n\s*run: \|/u.test(workflow)
    && /Resolve-Path [.]\/scripts\/Publish-HelmsmanRelease[.]ps1/u.test(workflow)
    && /System[.]Management[.]Automation[.]Language[.]Parser\]::ParseFile\(/u.test(workflow)
    && /\[ref\]\$tokens/u.test(workflow)
    && /\[ref\]\$parseErrors/u.test(workflow)
    && /\$parseErrors[.]Count -ne 0/u.test(workflow)
    && /exit 1/u.test(workflow),
  "GitHub CI parses the complete publisher with PowerShell before any image can be released"
);

record(
  /\[Parameter\(Mandatory = \$true\)\]\s*\n\s*\[ValidateNotNullOrEmpty\(\)\]\s*\n\s*\[string\]\$SourcePath/iu.test(source)
    && /\$Repository = 'nunesg130-boop\/helmsman'/u.test(source)
    && /\$Workflow = 'container[.]yml'/u.test(source)
    && /\[switch\]\$SkipLocalTests/u.test(source)
    && !/\[string\]\$RepositoryPath/u.test(source)
    && !/\?\?|ForEach-Object\s+-Parallel|\[IO[.]Path\]::GetRelativePath|^\s*[^#\r\n]+\s(?:&&|\|\|)\s/imu.test(sourceWithoutStringLiterals),
  "publisher accepts one source tree and remains compatible with Windows PowerShell 5.1"
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
const githubAuthentication = functionBlock("Assert-GitHubAuthentication");
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
    && /\$slug -cne \$ExpectedRepository[.]ToLowerInvariant\(\)/u.test(canonicalRepository)
    && /\$pushSlug -cne \$ExpectedRepository[.]ToLowerInvariant\(\)/u.test(canonicalRepository)
    && /-cne 'main'/u.test(canonicalRepository)
    && /ExpectedRepository[.]ToLowerInvariant/u.test(canonicalRepository)
    && /auth', 'status', '--hostname', 'github[.]com'/u.test(githubAuthentication)
    && /\$repositorySelector = 'github[.]com\/' \+ \$ExpectedRepository/u.test(githubAuthentication)
    && /repo', 'view', \$repositorySelector/u.test(githubAuthentication)
    && /status', '--porcelain=v1', '--untracked-files=all'/u.test(cleanMain)
    && /fetch', '--no-tags', '--no-prune', '--recurse-submodules=no', 'origin'/u.test(cleanMain)
    && /refs\/heads\/main:refs\/remotes\/origin\/main/u.test(cleanMain)
    && /merge', '--ff-only', '--no-edit', 'refs\/remotes\/origin\/main'/u.test(cleanMain)
    && /rev-parse', 'HEAD'/u.test(cleanMain)
    && /rev-parse', 'refs\/remotes\/origin\/main'/u.test(cleanMain)
    && /\$localHead -cne \$remoteHead/u.test(cleanMain),
  "publisher proves the canonical repository, authenticated GitHub account, clean main branch, and exact fast-forward synchronization"
);

const prohibitedPaths = functionBlock("Test-ProhibitedReleasePath");
const embeddedSecrets = functionBlock("Assert-NoEmbeddedSecrets");
const sourceValidation = functionBlock("Get-ValidatedSourceRelease");
record(
  [".git", ".idea", ".nyc_output", ".vscode", "backup", "backups", "coverage", "data", "node_modules", ".helmsman-data"]
    .every((name) => prohibitedPaths.includes(`'${name}'`))
    && [".npmrc", ".pypirc", ".netrc", "_netrc"]
      .every((name) => prohibitedPaths.includes(`'${name}'`))
    && prohibitedPaths.includes("if ($name -match '^id_(?:rsa|dsa|ecdsa|ed25519(?:_sk)?)(?:[.]pub)?$')")
    && ["state.json", "sessions.json", "credentials.json", "credentials.key", "master-key.hex"]
      .every((name) => prohibitedPaths.includes(`'${name}'`))
    && /[.]env[.]example/u.test(prohibitedPaths)
    && /key\|pem\|crt\|cer\|p12\|pfx\|log\|zip\|tar\|tgz/u.test(prohibitedPaths)
    && /PRIVATE KEY/u.test(embeddedSecrets)
    && /GitHub classic token/u.test(embeddedSecrets)
    && /GitHub fine-grained token/u.test(embeddedSecrets)
    && /HELMSMAN_ACCESS_KEY\|CLOUDFLARE_API_TOKEN\|CF_API_TOKEN/u.test(embeddedSecrets),
  "source and staged trees reject credentials, runtime state, dependencies, backups, and release archives"
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
  "https://admin:secret@example.invalid/path",
  "http://user:pass@media.test",
  "https://${username}:${secret}@example.invalid"
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
  /'package[.]json', 'compose[.]yaml', 'container[.]env[.]example', '[.]gitattributes', '[.]github\/workflows\/container[.]yml'/u.test(sourceValidation)
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

const localTests = functionBlock("Invoke-LocalTestsIfAvailable");
const postTest = functionBlock("Assert-NoUnstagedReleaseChanges");
const stagedTree = functionBlock("Assert-StagedTreeUnchanged");
record(
  /Local npm tests were explicitly skipped/u.test(localTests)
    && /node[.]exe/u.test(localTests)
    && /npm[.]cmd/u.test(localTests)
    && /24[.]19[.]0/u.test(localTests)
    && /25[.]0[.]0/u.test(localTests)
    && /'checkout-index', '--all', "--prefix=\$gitPrefix"/u.test(localTests)
    && /'--prefix', \$testRoot, 'test'/u.test(localTests)
    && /'test'/u.test(localTests)
    && /Assert-NoUnstagedReleaseChanges/u.test(localTests)
    && /'diff', '--quiet'/u.test(postTest)
    && /'ls-files', '--others', '--exclude-standard'/u.test(postTest)
    && /'write-tree'/u.test(stagedTree)
    && /\$actualTree -cne \$ExpectedTree/u.test(stagedTree),
  "local Node 24 tests are the default and cannot silently alter the reviewed release tree"
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
record(
  /\$repositorySelector = 'github[.]com\/' \+ \$ExpectedRepository/u.test(workflowRunIds)
    && /'run', 'list', '--repo', \$repositorySelector, '--workflow', \$WorkflowName/u.test(workflowRunIds)
    && /'--event', 'push', '--commit', \$CommitSha, '--limit', '100'/u.test(workflowRunIds)
    && /headSha -ceq \$CommitSha -and \$_[.]headBranch -ceq \$RefName/u.test(workflowRunIds)
    && /databaseId/u.test(workflowRunIds)
    && /\[string\]\$CommitSha/u.test(workflowWaiter)
    && /\[string\]\$RefName/u.test(workflowWaiter)
    && /\[string\[\]\]\$ExcludedRunIds/u.test(workflowWaiter)
    && /DiscoveryTimeoutSeconds = 180/u.test(workflowWaiter)
    && /CompletionTimeoutSeconds = 3600/u.test(workflowWaiter)
    && /\$repositorySelector = 'github[.]com\/' \+ \$ExpectedRepository/u.test(workflowWaiter)
    && /\$excluded\[\[string\]\$runId\] = \$true/u.test(workflowWaiter)
    && /'run', 'list'/u.test(workflowWaiter)
    && /'--event', 'push', '--commit', \$CommitSha/u.test(workflowWaiter)
    && /headSha -ceq \$CommitSha -and \$_[.]headBranch -ceq \$RefName/u.test(workflowWaiter)
    && /!\$excluded[.]ContainsKey\(\[string\]\$_[.]databaseId\)/u.test(workflowWaiter)
    && /Start-Sleep -Seconds 5/u.test(workflowWaiter)
    && /'run', 'view'/u.test(workflowWaiter)
    && /\$matchingRuns[.]Count -gt 1/u.test(workflowWaiter)
    && /Refusing to guess/u.test(workflowWaiter)
    && /\$view[.]headSha -cne \$CommitSha/u.test(workflowWaiter)
    && /\$view[.]headBranch -cne \$RefName/u.test(workflowWaiter)
    && /\$view[.]event -cne 'push'/u.test(workflowWaiter)
    && /\$view[.]status -ceq 'completed'/u.test(workflowWaiter)
    && /\$view[.]conclusion -cne 'success'/u.test(workflowWaiter)
    && /Start-Sleep -Seconds 10/u.test(workflowWaiter),
  "workflow gates snapshot prior IDs, discover one new exact commit/ref run, and poll it within bounded deadlines"
);

const mainPush = functionBlock("Push-Main");
const tagPush = functionBlock("New-AndPushReleaseTag");
const publishedRelease = functionBlock("Assert-PublishedRelease");
const releaseCommit = functionBlock("New-ReleaseCommit");
const remotePushes = source.match(/'push', '--no-follow-tags', '--recurse-submodules=no', 'origin'/gu) || [];
record(
  /'push', '--no-follow-tags', '--recurse-submodules=no', 'origin', "\$\{CommitSha\}:refs\/heads\/main"/u.test(mainPush)
    && /refs\/heads\/main/u.test(mainPush)
    && /'tag', '-a', \$Release[.]Tag/u.test(tagPush)
    && /\$tagObject = Invoke-NativeText[^\n]*'rev-parse', "refs\/tags\/\$\(\$Release[.]Tag\)"/u.test(tagPush)
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
  "Assert-RequiredTool",
  "Get-CanonicalRepository",
  "Assert-GitHubAuthentication",
  "Assert-CleanMainAtOrigin",
  "Assert-GitAuthor",
  "Get-ValidatedSourceRelease",
  "Assert-ReleaseIsNew",
  "Sync-SourceTree",
  "Stage-AndValidateRelease",
  "Invoke-LocalTestsIfAvailable",
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
  "Show-ServerUpdateCommands"
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
    && /Resolve-Path -LiteralPath \$SourcePath/u.test(orchestration)
    && /Resolve-Path -LiteralPath \(Split-Path -Parent \$PSScriptRoot\)/u.test(orchestration)
    && /FileAttributes\]::ReparsePoint/u.test(orchestration)
    && /source release and publisher repository must be separate, non-nested directories/u.test(orchestration)
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

const serverCommands = functionBlock("Show-ServerUpdateCommands");
record(
  /The Jellyfin server was not changed/u.test(serverCommands)
    && /\$image = \$Publication[.]Image/u.test(serverCommands)
    && /\$remoteReleaseDirectory = '\/opt\/helmsman\/releases\/' \+ \$Release[.]Tag/u.test(serverCommands)
    && /Join-Path \$Publication[.]Directory 'compose[.]yaml'/u.test(serverCommands)
    && /Join-Path \$Publication[.]Directory 'container[.]env[.]example'/u.test(serverCommands)
    && /Join-Path \$Publication[.]Directory 'SHA256SUMS'/u.test(serverCommands)
    && /scp [^\n]*\$localCompose/u.test(serverCommands)
    && /scp [^\n]*\$localEnvironmentExample/u.test(serverCommands)
    && /scp [^\n]*\$localChecksums/u.test(serverCommands)
    && /sha256sum --strict --check SHA256SUMS/u.test(serverCommands)
    && /if \[ -e compose[.]yaml[.]before-\$\(\$Release[.]Version\) \] \|\| \[ -e [.]env[.]before-\$\(\$Release[.]Version\) \]/u.test(serverCommands)
    && /cp -- compose[.]yaml compose[.]yaml[.]before-\$\(\$Release[.]Version\)/u.test(serverCommands)
    && /unset HELMSMAN_IMAGE COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROJECT_NAME COMPOSE_PROFILES/u.test(serverCommands)
    && /if \[ -f [.]env \]; then cp -- [.]env [.]env[.]before-\$\(\$Release[.]Version\)/u.test(serverCommands)
    && /awk [^\n]*HELMSMAN_IMAGE/u.test(serverCommands)
    && /HELMSMAN_IMAGE=" \+ \$image/u.test(serverCommands)
    && /chmod --reference=[.]env/u.test(serverCommands)
    && /chown --reference=[.]env/u.test(serverCommands)
    && /mv -- [^\n]*[.]env/u.test(serverCommands)
    && /docker compose --file compose[.]yaml --env-file [.]env config/u.test(serverCommands)
    && /docker compose --file compose[.]yaml --env-file [.]env config --images/u.test(serverCommands)
    && /Resolved image does not match the verified release digest/u.test(serverCommands)
    && /docker compose --file compose[.]yaml --env-file [.]env pull helmsman/u.test(serverCommands)
    && /docker compose --file compose[.]yaml --env-file [.]env up -d --force-recreate helmsman/u.test(serverCommands)
    && /docker compose --file compose[.]yaml --env-file [.]env ps/u.test(serverCommands)
    && /docker compose --file compose[.]yaml --env-file [.]env logs --tail=100 helmsman/u.test(serverCommands)
    && !/Invoke-Native/u.test(serverCommands)
    && !/docker compose down -v/iu.test(source)
    && !/^\s*(?:docker|ssh)\s/imu.test(source),
  "Jellyfin handoff transfers verified assets, canonicalizes one digest-pinned environment value, and remains manual"
);

if (failures.length) {
  console.error(`Publisher contract failed with ${failures.length} issue${failures.length === 1 ? "" : "s"}:`);
  failures.forEach((failure) => console.error(`  - ${failure}`));
  console.error(`${passes.length} checks passed.`);
  process.exitCode = 1;
} else {
  console.log(`Publisher contract passed: ${passes.length} deterministic release-safety checks.`);
}
