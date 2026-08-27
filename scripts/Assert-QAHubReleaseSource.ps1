param(
  [Parameter(Mandatory = $true)]
  [string]$RepoRoot
)

$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
$git = Get-Command git -ErrorAction Stop
$gitRoot = (& $git.Source -C $resolvedRoot rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "The release source is not a Git repository: $resolvedRoot"
}
$normalizedGitRoot = [IO.Path]::GetFullPath($gitRoot).TrimEnd('\')
$normalizedRepoRoot = [IO.Path]::GetFullPath($resolvedRoot).TrimEnd('\')
if (-not $normalizedGitRoot.Equals($normalizedRepoRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Release source must be the repository root. Expected $normalizedRepoRoot, got $normalizedGitRoot."
}

$branch = (& $git.Source -C $resolvedRoot branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $branch -ne "main") {
  throw "Windows releases may only be built from the main branch; current branch is '$branch'."
}

$dirty = @(& $git.Source -C $resolvedRoot status --porcelain --untracked-files=normal)
if ($LASTEXITCODE -ne 0) {
  throw "Could not verify the release worktree state."
}
if ($dirty.Count -ne 0) {
  throw "Windows releases require a clean main worktree. Commit or preserve all source changes first."
}

$requiredProductFiles = @(
  "apps\web\src\OverviewPage.tsx",
  "apps\desktop\src\portable-updater.ts",
  "apps\desktop\src\runtime-config.ts",
  "apps\desktop\scripts\package-windows.ps1"
)
foreach ($relativePath in $requiredProductFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $resolvedRoot $relativePath) -PathType Leaf)) {
    throw "The checkout does not contain the current product mainline marker: $relativePath"
  }
}

[pscustomobject][ordered]@{
  repoRoot = $resolvedRoot
  branch = $branch
  commit = (& $git.Source -C $resolvedRoot rev-parse HEAD).Trim()
  clean = $true
}
