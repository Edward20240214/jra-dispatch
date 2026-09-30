#Requires -Version 7.2
<#
.SYNOPSIS
  run_dynamic_audit.ps1 に「利用上限で止まったら、リセット後の自動再開を予約する」
  フック（resume_audit.ps1 -Schedule の呼び出し）を追加・削除する。

.DESCRIPTION
  既定はプレビューのみ（ファイルは変更しない）。-Apply で追加、-Uninstall で削除。

  「監査が異常終了」を記録している文を探し、その文と同じブロックの中で
    - 後ろに exit / return / throw があれば、その直前
    - なければ、その文の直後
  にフックを挿入する。変更前にバックアップを作り、変更後の構文チェックと
  挿入位置の検査に通らなければ書き込まない。文字コード（BOM）と改行コードは元のまま。

.EXAMPLE
  pwsh -File install_resume_hook.ps1              # 挿入位置のプレビュー（変更しない）
  pwsh -File install_resume_hook.ps1 -Apply       # フックを追加
  pwsh -File install_resume_hook.ps1 -Uninstall   # フックを削除
#>
[CmdletBinding()]
param(
    [string]$Path = (Join-Path $PSScriptRoot 'run_dynamic_audit.ps1'),
    [string]$Marker = '監査が異常終了',
    [switch]$Apply,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Begin = '# >>> resume_audit hook'
$End   = '# <<< resume_audit hook'

function Stop-WithMessage([string]$Msg, [int]$Code = 1) {
    Write-Host $Msg -ForegroundColor Red
    exit $Code
}

if (-not (Test-Path -LiteralPath $Path)) { Stop-WithMessage "見つかりません: $Path" }
$Path = (Resolve-Path -LiteralPath $Path).Path

# ---------------------------------------------------------------- 読み込み（BOM・改行コードを記録）
$bytes = [IO.File]::ReadAllBytes($Path)
if ($bytes.Length -ge 2 -and (($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF))) {
    Stop-WithMessage 'UTF-16 のファイルには対応していません'
}
$hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
$skip   = if ($hasBom) { 3 } else { 0 }
$text   = [Text.UTF8Encoding]::new($false).GetString($bytes, $skip, $bytes.Length - $skip)
$nl     = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
$lines  = [Collections.Generic.List[string]]::new([string[]]($text -split '\r?\n'))

function Get-ParseErrors([string]$Src) {
    $errs = $null
    [System.Management.Automation.Language.Parser]::ParseInput($Src, [ref]$null, [ref]$errs) | Out-Null
    $errs
}

function Save-Lines([Collections.Generic.List[string]]$NewLines) {
    $newText = $NewLines -join $nl
    $errs = Get-ParseErrors $newText
    if ($errs) { Stop-WithMessage "変更後の構文チェックに失敗したため書き込みを中止しました: $($errs[0].Message)" }
    $bak = "$Path.bak_resumehook_$(Get-Date -Format yyyyMMdd_HHmmss)"
    Copy-Item -LiteralPath $Path -Destination $bak
    [IO.File]::WriteAllText($Path, $newText, [Text.UTF8Encoding]::new($hasBom))
    Write-Host "バックアップ: $bak"
}

function Show-Context([int]$From, [int]$To, [int[]]$Added = @()) {
    for ($i = [math]::Max(0, $From); $i -le [math]::Min($lines.Count - 1, $To); $i++) {
        $mark  = if ($Added -contains $i) { '+' } else { ' ' }
        $color = if ($Added -contains $i) { 'Green' } else { 'Gray' }
        Write-Host ('{0} {1,5}: {2}' -f $mark, ($i + 1), $lines[$i]) -ForegroundColor $color
    }
}

# ---------------------------------------------------------------- 削除
if ($Uninstall) {
    $b = $lines.FindIndex([Predicate[string]] { param($l) $l.TrimStart().StartsWith($Begin) })
    $e = $lines.FindIndex([Predicate[string]] { param($l) $l.Trim() -eq $End })
    if ($b -lt 0 -or $e -lt $b) { Write-Host 'フックは見つかりませんでした（変更なし）'; exit 0 }
    Show-Context ($b - 3) ($e + 3)
    $lines.RemoveRange($b, $e - $b + 1)
    Save-Lines $lines
    Write-Host "✅ フックを削除しました（$($b + 1)〜$($e + 1) 行目）" -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------- 追加位置の決定
if ($text.Contains($Begin)) { Write-Host '✅ フックは既に追加されています（変更なし）' -ForegroundColor Green; exit 0 }
$errs = Get-ParseErrors $text
if ($errs) { Stop-WithMessage "元のスクリプトに構文エラーがあります: $($errs[0].Message)" }

$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$null)

# 「監査が異常終了」を含む文字列（コメントは除く）を持つ、最も内側の文
$strTokens = @($tokens | Where-Object { $_ -is [System.Management.Automation.Language.StringToken] -and $_.Text.Contains($Marker) })
$stmts = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.StatementAst] -and ($n.Parent -is [System.Management.Automation.Language.StatementBlockAst] -or $n.Parent -is [System.Management.Automation.Language.NamedBlockAst]) }, $true))
$hits = @(@(foreach ($t in $strTokens) {
    $stmts | Where-Object { $_.Extent.StartOffset -le $t.Extent.StartOffset -and $_.Extent.EndOffset -ge $t.Extent.EndOffset } |
        Sort-Object { $_.Extent.EndOffset - $_.Extent.StartOffset } | Select-Object -First 1
}) | Sort-Object { $_.Extent.StartOffset } -Unique)

if ($hits.Count -eq 0) { Stop-WithMessage "「$Marker」を記録している箇所が見つかりませんでした" }
if ($hits.Count -gt 1) {
    Write-Host "「$Marker」を記録している箇所が $($hits.Count) か所あります。自動では決められないため、次の内容をお知らせください:" -ForegroundColor Yellow
    foreach ($h in $hits) { Write-Host '----'; Show-Context ($h.Extent.StartLineNumber - 6) ($h.Extent.EndLineNumber + 8) }
    exit 1
}

$stmt  = $hits[0]
$block = $stmt.Parent
$list  = $block.Statements
$exitStmt = $null
for ($i = $list.IndexOf($stmt) + 1; $i -lt $list.Count; $i++) {
    if ($list[$i] -is [System.Management.Automation.Language.ExitStatementAst] -or $list[$i] -is [System.Management.Automation.Language.ReturnStatementAst] -or $list[$i] -is [System.Management.Automation.Language.ThrowStatementAst]) {
        $exitStmt = $list[$i]; break
    }
}

function Get-LineStartOffset([int]$LineNumber) {   # 1 始まりの行番号 → その行頭の文字位置
    $off = 0
    for ($i = 0; $i -lt $LineNumber - 1; $i++) { $off = $text.IndexOf("`n", $off) + 1 }
    $off
}

if ($exitStmt) {
    # exit が行頭にあること（同じ行の前に別の文があると、そこより前に入ってしまう）
    $insertAt = $exitStmt.Extent.StartLineNumber - 1          # 0 始まり: この行の前に挿入
    $lineHead = $text.Substring((Get-LineStartOffset $exitStmt.Extent.StartLineNumber), $exitStmt.Extent.StartColumnNumber - 1)
    $ok = $lineHead.Trim() -eq ''
    $where = "$($exitStmt.Extent.StartLineNumber) 行目の「$($exitStmt.Extent.Text.Split("`n")[0].Trim())」の直前"
} else {
    # 文の後ろ（同じ行）に別の文や } が続かないこと
    $insertAt = $stmt.Extent.EndLineNumber                   # 0 始まり: この位置（= 次の行）に挿入
    $lineEnd  = $text.IndexOf("`n", $stmt.Extent.EndOffset)
    $rest     = if ($lineEnd -lt 0) { $text.Substring($stmt.Extent.EndOffset) } else { $text.Substring($stmt.Extent.EndOffset, $lineEnd - $stmt.Extent.EndOffset) }
    $ok = $rest.Trim() -eq '' -or $rest.Trim().StartsWith('#')
    $where = "$($stmt.Extent.EndLineNumber) 行目（「$Marker」の記録）の直後"
}
# 挿入位置がブロックの内側にあること
$ok = $ok -and ($block.Extent.StartLineNumber -le $insertAt) -and ($insertAt + 1 -le $block.Extent.EndLineNumber)
if (-not $ok) {
    Write-Host '安全に挿入できる位置を自動で決められませんでした。次の内容をお知らせください:' -ForegroundColor Yellow
    Show-Context ($stmt.Extent.StartLineNumber - 6) ($stmt.Extent.EndLineNumber + 8)
    exit 1
}

# ---------------------------------------------------------------- フック本体
$indent = [regex]::Match($lines[$stmt.Extent.StartLineNumber - 1], '^\s*').Value
$hook = @(
    "$Begin`: 利用上限で止まったら、リセット後の自動再開を予約する（install_resume_hook.ps1 が追加 / -Uninstall で削除）"
    '$__resumeLec = Get-Variable -Name LASTEXITCODE -Scope Global -ValueOnly -ErrorAction SilentlyContinue'
    'try {'
    '    $__resumePs1 = Join-Path $PSScriptRoot ''resume_audit.ps1'''
    '    if (Test-Path -LiteralPath $__resumePs1) {'
    '        $__resumeArgs = @(''-NoProfile'', ''-ExecutionPolicy'', ''Bypass'', ''-File'', $__resumePs1, ''-Schedule'')'
    '        $__resumeTarget = Get-Variable -Name Target -ValueOnly -ErrorAction SilentlyContinue'
    '        $__resumeModel  = Get-Variable -Name Model -ValueOnly -ErrorAction SilentlyContinue'
    '        if ($__resumeTarget) { $__resumeArgs += @(''-Target'', $__resumeTarget) }'
    '        if ($__resumeModel)  { $__resumeArgs += @(''-Model'', $__resumeModel) }'
    '        & (Get-Process -Id $PID).Path @__resumeArgs'
    '    } else {'
    '        Write-Host "resume_audit.ps1 が見つからないため自動再開の予約を省略: $__resumePs1" -ForegroundColor Yellow'
    '    }'
    '} catch {'
    '    Write-Host "自動再開の予約に失敗: $($_.Exception.Message)" -ForegroundColor Yellow'
    '} finally {'
    '    # 元のスクリプトの終了コード（$LASTEXITCODE）を変えない'
    '    if ($null -ne $__resumeLec) { $global:LASTEXITCODE = $__resumeLec } else { Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue }'
    '}'
    $End
) | ForEach-Object { "$indent$_" }

$lines.InsertRange($insertAt, [string[]]$hook)
$added = @($insertAt..($insertAt + $hook.Count - 1))

# 挿入後の検査: 構文エラーがなく、フックが「監査が異常終了」と同じブロックにあること
$newText = $lines -join $nl
if (Get-ParseErrors $newText) { Stop-WithMessage '挿入後の構文チェックに失敗しました（ファイルは変更していません）' }
$newAst  = [System.Management.Automation.Language.Parser]::ParseInput($newText, [ref]$null, [ref]$null)
$hookAst = $newAst.Find({ param($n) $n -is [System.Management.Automation.Language.TryStatementAst] -and $n.Extent.Text.Contains('$__resumePs1') }, $true)
$sameBlock = $hookAst -and @($hookAst.Parent.Statements | Where-Object { $_.Extent.Text -eq $stmt.Extent.Text }).Count -ge 1
if (-not $sameBlock) { Stop-WithMessage '挿入位置の検査に失敗しました（ファイルは変更していません）' }

Write-Host "挿入位置: $where"
Write-Host ''
Show-Context ($insertAt - 8) ($insertAt + $hook.Count + 4) $added
Write-Host ''

if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $Path) 'resume_audit.ps1'))) {
    Write-Host '⚠ 同じフォルダに resume_audit.ps1 がありません。先に置いてください' -ForegroundColor Yellow
}

if (-not $Apply) {
    Write-Host 'これはプレビューです（ファイルは変更していません）。問題なければ -Apply を付けて実行してください' -ForegroundColor Cyan
    exit 0
}
Save-Lines $lines
Write-Host '✅ フックを追加しました' -ForegroundColor Green
