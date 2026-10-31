# 一次跑完附属插件「自动沉淀」的全部单测。
#
# 跑法（仓库根）：pwsh -File test/run-all.ps1
#
# 与其他插件测试的区别：**不需要 Harness、不需要 profile**。
#  - 全部用例都是纯 node（`node test/xxx.test.mjs`），不 import 宿主包；
#  - 主插件 `./store` 与 `schemastery` 都是**可选**的：
#      · store 全程注入（`createValidator({ resolveStore })`），未装时按「不可用」降级；
#      · schemastery 缺失时 wiring 用例退化成 `node --check`，并打印 SKIP（不算失败）；
#  - 每个用例自带临时 `DSH_HOME`，绝不会写到真实的 `~/.dsh/memory`。
#
# 第 N 步（bm25 对照测试）会去读兄弟仓库 `dsh-plugin-persona-memory-recall`
# 的真实实现——只在开发机有意义；装进 profile 后那一步会打印 SKIP。

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot

$node = $env:DSH_NODE
if (-not $node) {
    $candidate = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    $node = if (Test-Path $candidate) { $candidate } else { 'node' }
}

$tests = @(
    'trigger',
    'sampler',
    'cursor',
    'budget',
    'redact',
    'bm25-parity',
    'merger',
    'extractor',
    'writer',
    'settings',
    'workspace',
    'pending',
    'llm',
    'pipeline',
    'autotrigger',
    'commands',
    'sources',
    'crosssession',
    'runlog',
    'wiring'
)

$failures = @()

Write-Host '=== 1/(N+1) 语法检查：lib/*.js（node --check，不执行）' -ForegroundColor Cyan
Get-ChildItem (Join-Path $repo 'lib') -Filter '*.js' | ForEach-Object {
    & $node --check $_.FullName
    if ($LASTEXITCODE -ne 0) { $script:failures += "node --check $($_.Name)" }
}

$index = 0
$total = $tests.Count + 1
foreach ($name in $tests) {
    $index += 1
    Write-Host "=== $($index + 1)/$total $name.test.mjs" -ForegroundColor Cyan
    & $node (Join-Path $repo "test\$name.test.mjs")
    if ($LASTEXITCODE -ne 0) { $failures += "$name.test.mjs" }
}

Write-Host ''
if ($failures.Count -gt 0) {
    Write-Host ('✗ 失败：' + ($failures -join '、')) -ForegroundColor Red
    exit 1
}
Write-Host ('✓ 全部通过（' + $tests.Count + ' 组单测 + 语法检查）') -ForegroundColor Green
