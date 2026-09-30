#Requires -Version 7.2
<#
.SYNOPSIS
  ダイナミック監査（run_dynamic_audit.ps1）が途中で止まったとき、
  5時間枠の回復を待って「中断したセッションの続き」から再開する。

.DESCRIPTION
  1. 中断したセッションIDを特定する
       -SessionId 指定 > resume_state.json（前回の再開記録）> 最新 claude_run_*.log から自動検出
  2. ログの「resets 3:20pm」などからリセット時刻を読み取り、その 2 分後まで待機（スリープ防止つき）
  3. claude -p /usage で使用率を確認してから claude --resume で続きを実行
  4. 実行前後で canonical md5 を照合（不一致なら以後の自動再開を停止）
  5. 再び上限に達したら、次のリセットを待って再開（最大 -MaxAttempts 回）
  6. 結果を Discord に通知（DISCORD_WEBHOOK_URL が環境変数か <RepoDir>\.env にあれば）

  run_dynamic_audit.ps1 と同じフォルダ（jra-odds-scanner）に置いて使う想定。

.EXAMPLE
  pwsh -File resume_audit.ps1 -Target weekly_report.py -DryRun
    何をするか（セッションID・再開予定時刻）だけを表示。実行はしない。

.EXAMPLE
  pwsh -File resume_audit.ps1 -Target weekly_report.py
    このウィンドウでリセットまで待機し、続きを実行する。

.EXAMPLE
  pwsh -File resume_audit.ps1 -Target weekly_report.py -Schedule
    Windows のタスクスケジューラに「リセット 2 分後に再開」を登録して即終了。
    ウィンドウを閉じても、PC がスリープしていても（スリープ解除タイマー有効時）実行される。
#>
[CmdletBinding()]
param(
    [string]$Target = 'weekly_report.py',
    [string]$SessionId,
    [string]$RepoDir,
    [string]$OutDir,
    [string]$Model = 'claude-opus-5-5',
    [string]$Effort = 'high',
    [int]$MaxAttempts = 3,
    [int]$UsageThreshold = 20,
    [int]$WeeklyThreshold = 90,
    [int]$ResetMarginMinutes = 2,
    [switch]$Schedule,
    [switch]$NoWait,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

# ---------------------------------------------------------------- 設定
if (-not $RepoDir) {
    $RepoDir = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'bet_config.json')) { $PSScriptRoot }
               else { Join-Path $HOME 'jra-odds-scanner' }
}
$TargetStem = [IO.Path]::GetFileNameWithoutExtension($Target)
if (-not $OutDir) { $OutDir = Join-Path $HOME 'ad-hoc-analysis' "${TargetStem}_audit" }

$CanonFiles = @(
    'bet_config.json'
    'final_check_log.csv'
    'payout_log.csv'
    'purchase_log.csv'
    'results\bayesian_sequential_history.csv'
)
$MainLog   = Join-Path $OutDir 'resume_audit.log'
$StatePath = Join-Path $OutDir 'resume_state.json'
$LockPath  = Join-Path $OutDir 'resume_audit.lock'
$TaskName  = "JRA-AuditResume-$TargetStem"

# 上限到達メッセージ（例: "You've hit your session limit · resets 3:20pm (Asia/Tokyo)"）
$LimitPattern = "hit your \w+ limit|usage limit reached|Claude AI usage limit"
$ErrorPattern = '(?m)API Error|Execution error|error_during_execution|^Error:'

# 改行を含む引数は環境によって途中で切れるため 1 行にしておく
$ResumePrompt = @'
このセッションは利用上限などにより途中で中断しました。中断した地点から、当初の指示どおり最後まで完了させてください。
1. すでに結果が返っている作業（Find・Verify など）は再実行しない。
2. 結果が返っていない作業だけを再実行する。サブエージェント（Task/Agent）を使う場合は model に sonnet を指定し、同時実行は最大 3 体まで。scratch 内の既存スクリプトは再利用してよい。
3. すべてそろったら Synthesize を行い、当初の指示どおり report.md に書き出す。
4. READ-ONLY の制約は当初と同じ。canonical ファイルには一切書き込まない。
'@ -replace "\r?\n", ' '

# ---------------------------------------------------------------- 共通関数
function Write-Log([string]$Msg, [string]$Level = 'INFO') {
    $line  = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Msg
    $color = @{ INFO = 'Gray'; OK = 'Green'; WARN = 'Yellow'; ERROR = 'Red' }[$Level]
    Write-Host $line -ForegroundColor $color
    if (-not $DryRun) { Add-Content -LiteralPath $MainLog -Value $line -Encoding utf8 }
}

function Send-Notify([string]$Text) {
    $url = $env:DISCORD_WEBHOOK_URL
    if (-not $url) {
        $envFile = Join-Path $RepoDir '.env'
        if (Test-Path -LiteralPath $envFile) {
            $line = Get-Content -LiteralPath $envFile -Encoding utf8 |
                    Where-Object { $_ -match '^\s*DISCORD_WEBHOOK_URL\s*=' } | Select-Object -First 1
            if ($line) { $url = ($line -split '=', 2)[1].Trim().Trim('"', "'") }
        }
    }
    if ($DryRun) { Write-Log "  [DryRun] Discord 通知（送信しない）: $Text"; return }
    if (-not $url) { Write-Log '  Discord 通知先（DISCORD_WEBHOOK_URL）が見つからないため通知は省略'; return }
    if ($Text.Length -gt 1900) { $Text = $Text.Substring(0, 1900) + ' …' }
    try {
        Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' `
            -Body (@{ content = $Text } | ConvertTo-Json -Compress) | Out-Null
        Write-Log '  Discord 送信成功'
    } catch {
        Write-Log "  Discord 送信失敗: $($_.Exception.Message)" 'WARN'
    }
}

# 待機中・実行中に PC がスリープしないようにする（Windows のみ）
function Set-KeepAwake([bool]$On) {
    if (-not $IsWindows) { return }
    if (-not ('Win32.Power' -as [type])) {
        Add-Type -Namespace Win32 -Name Power -MemberDefinition `
            '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
    }
    # ES_CONTINUOUS | ES_SYSTEM_REQUIRED / ES_CONTINUOUS のみ（解除）
    $flags = if ($On) { [uint32]2147483649 } else { [uint32]2147483648 }
    [Win32.Power]::SetThreadExecutionState($flags) | Out-Null
}

function Get-CanonMd5 {
    foreach ($f in $CanonFiles) {
        $p = Join-Path $RepoDir $f
        $h = if (Test-Path -LiteralPath $p) { (Get-FileHash -LiteralPath $p -Algorithm MD5).Hash.ToLower() } else { 'MISSING' }
        [pscustomobject]@{ File = $f; Hash = $h }
    }
}

function Save-Md5([object[]]$Md5, [string]$Path) {
    $Md5 | ForEach-Object { "$($_.Hash)  $($_.File)" } | Set-Content -LiteralPath $Path -Encoding utf8
}

# run_dynamic_audit.ps1 が監査開始時に保存した md5（"<md5>  <ファイル名>" の行）と現在の md5 を比べる
# 戻り値: 記録がなければ $null、あれば .Changed（変わったファイル名の配列）
# （空の配列をそのまま返すと PowerShell が $null に展開してしまうため、オブジェクトに包む）
function Get-ChangedSinceRun([string]$Md5BeforePath) {
    if (-not (Test-Path -LiteralPath $Md5BeforePath)) { return $null }
    $saved = @{}
    foreach ($l in Get-Content -LiteralPath $Md5BeforePath -Encoding utf8) {
        if ($l -match '([0-9a-fA-F]{32})\s+(\S.*?)\s*$') { $saved[$Matches[2]] = $Matches[1].ToLower() }
    }
    if ($saved.Count -eq 0) { return $null }
    [pscustomobject]@{ Changed = @(Get-CanonMd5 | Where-Object { $saved.ContainsKey($_.File) -and $saved[$_.File] -ne $_.Hash } | ForEach-Object { $_.File }) }
}

# "resets 3:20pm" / "resets Sep 30, 3:20pm" / "resets in 2h 13m" → 日時
# 時刻だけの場合は「中断した時刻より後で最初のその時刻」とみなす
function Get-ResetTime([string]$Text, [datetime]$FailedAt) {
    if ($Text -match 'resets\s+in\s+(?:(?<hh>\d+)\s*h)?\s*(?:(?<mm>\d+)\s*m)?' -and ($Matches.hh -or $Matches.mm)) {
        return $FailedAt.AddHours([int]$Matches.hh).AddMinutes([int]$Matches.mm)
    }
    $rx = 'resets\s+(?:(?<mon>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(?<h>\d{1,2})(?::(?<m>\d{2}))?\s*(?<ap>am|pm)'
    if (-not ($Text -match $rx)) { return $null }
    $h = [int]$Matches.h % 12
    if ($Matches.ap -eq 'pm') { $h += 12 }
    $m = if ($Matches.m) { [int]$Matches.m } else { 0 }
    if ($Matches.mon) {
        $months = 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
        $mon = [array]::IndexOf($months, $Matches.mon.Substring(0, 1).ToUpper() + $Matches.mon.Substring(1).ToLower()) + 1
        $t = [datetime]::new($FailedAt.Year, $mon, [int]$Matches.day, $h, $m, 0)
        if ($t -lt $FailedAt.AddDays(-2)) { $t = $t.AddYears(1) }
    } else {
        $t = $FailedAt.Date.AddHours($h).AddMinutes($m)
        if ($t -le $FailedAt) { $t = $t.AddDays(1) }
    }
    return $t
}

function Get-Usage {
    $t = (& claude -p /usage 2>&1 | ForEach-Object { "$_" }) -join "`n"
    [pscustomobject]@{
        Session = if ($t -match 'Current session:\s*(\d+)%') { [int]$Matches[1] } else { $null }
        Week    = if ($t -match 'Current week \(all models\):\s*(\d+)%') { [int]$Matches[1] } else { $null }
    }
}

# Claude Code はセッション記録を ~/.claude/projects/<作業フォルダの英数字以外を - に置換>/ に保存する
function Get-ProjectDir {
    $full = (Resolve-Path -LiteralPath $RepoDir).Path.TrimEnd('\', '/')
    Join-Path $HOME '.claude' 'projects' ($full -replace '[^A-Za-z0-9]', '-')
}

# 監査開始時刻の前後に作られたセッション記録のうち、監査対象名を含む最大のもの
function Find-SessionId([datetime]$StartedAt) {
    $proj = Get-ProjectDir
    if (-not (Test-Path -LiteralPath $proj)) { return $null }
    Get-ChildItem -LiteralPath $proj -Filter '*.jsonl' -File |
        Where-Object { $_.CreationTime -ge $StartedAt.AddMinutes(-1) -and $_.CreationTime -le $StartedAt.AddMinutes(10) } |
        Where-Object { Select-String -LiteralPath $_.FullName -Pattern $Target -SimpleMatch -Quiet } |
        Sort-Object Length -Descending | Select-Object -First 1 |
        ForEach-Object { $_.BaseName }
}

function Read-State {
    if (Test-Path -LiteralPath $StatePath) { Get-Content -LiteralPath $StatePath -Raw -Encoding utf8 | ConvertFrom-Json }
}

function Save-State([hashtable]$State) {
    if ($DryRun) { return }
    $State.updatedAt = (Get-Date).ToString('s')
    $State | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
}

function ConvertFrom-ClaudeJson([string[]]$Lines) {
    for ($i = $Lines.Count - 1; $i -ge 0; $i--) {
        if ($Lines[$i] -match '^\s*\{') { try { return ($Lines[$i] | ConvertFrom-Json -ErrorAction Stop) } catch { } }
    }
    $all = $Lines -join "`n"
    $s = $all.IndexOf('{'); $e = $all.LastIndexOf('}')
    if ($s -ge 0 -and $e -gt $s) { try { return ($all.Substring($s, $e - $s + 1) | ConvertFrom-Json -ErrorAction Stop) } catch { } }
    return $null
}

function Invoke-Resume([string]$Sid, [int]$Attempt) {
    $stamp  = Get-Date -Format 'yyyyMMdd_HHmm'
    $logOut = Join-Path $OutDir "claude_resume_$stamp.log"
    $report = Join-Path $OutDir 'report.md'
    $before = @(Get-CanonMd5)
    Save-Md5 $before (Join-Path $OutDir "md5_before_resume_$stamp.txt")
    $t0 = Get-Date

    Write-Log "▶ 再開 $Attempt/$MaxAttempts 回目: session=$Sid model=$Model effort=$Effort"
    Write-Log '  実行中です（完了まで画面には何も出ません。進捗はセッション記録に保存されています）'
    Push-Location -LiteralPath $RepoDir
    try {
        $raw = @(& claude -p $ResumePrompt --resume $Sid --model $Model --effort $Effort `
                    --output-format json --permission-mode bypassPermissions --add-dir $OutDir 2>&1 |
                 ForEach-Object { "$_" })
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    Set-Content -LiteralPath $logOut -Value ($raw -join "`n") -Encoding utf8

    $after = @(Get-CanonMd5)
    Save-Md5 $after (Join-Path $OutDir "md5_after_resume_$stamp.txt")
    $md5Ok = -not (Compare-Object $before.Hash $after.Hash -SyncWindow 0)

    $json    = ConvertFrom-ClaudeJson $raw
    $rawText = $raw -join "`n"
    $result  = if ($json -and $json.result) { [string]$json.result } else { $rawText }
    $status  = if (-not $md5Ok) { 'md5_mismatch' }
               elseif ($code -eq 0 -and -not ($json -and $json.is_error)) { 'completed' }
               elseif ($rawText -match $LimitPattern) { 'limit' }
               else { 'error' }

    [pscustomobject]@{
        Status        = $status
        SessionId     = if ($json -and $json.session_id) { [string]$json.session_id } else { $Sid }
        ResetAt       = if ($status -eq 'limit') { Get-ResetTime $rawText (Get-Date) } else { $null }
        ExitCode      = $code
        Result        = $result
        Log           = $logOut
        Minutes       = [math]::Round(((Get-Date) - $t0).TotalMinutes)
        ReportUpdated = (Test-Path -LiteralPath $report) -and ((Get-Item -LiteralPath $report).LastWriteTime -gt $t0)
    }
}

# ---------------------------------------------------------------- 1. 再開対象の特定
foreach ($d in $RepoDir, $OutDir) {
    if (-not (Test-Path -LiteralPath $d)) { Write-Host "フォルダがありません: $d" -ForegroundColor Red; exit 1 }
}

Write-Log "########## 監査の再開 開始（Target=$Target$(if ($Schedule) {' / Schedule'})$(if ($DryRun) {' / DryRun'})） ##########"

$state   = Read-State
$runLog  = Get-ChildItem -LiteralPath $OutDir -Filter 'claude_run_*.log' -File |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
$sid     = $null
$readyAt = Get-Date
$attempt = 1
$isLimit = $false

# 再開記録は「どの監査ログの続きか」を持っている。最新の監査ログと同じなら、その続き
$stateApplies = $state -and (-not $runLog -or $state.runLog -eq $runLog.Name)

if ($stateApplies) {
    # 前回の再開の続き
    switch ($state.status) {
        'completed'    { Write-Log '最新の監査は再開済みで完了しています。再開の必要はありません' 'OK'; exit 0 }
        'md5_mismatch' { Write-Log '前回の再開で canonical md5 が不一致でした。安全のため自動再開は行いません' 'ERROR'; exit 2 }
        'limit' {
            $isLimit = $true
            $readyAt = ([datetime]$state.resetAt).AddMinutes($ResetMarginMinutes)
        }
    }
    $sid     = $state.sessionId
    $attempt = [int]$state.attempt + 1
    Write-Log "前回の再開記録: status=$($state.status) attempt=$($state.attempt) session=$sid"
} elseif ($runLog) {
    # 監査本体（run_dynamic_audit.ps1）の中断
    $text = [string](Get-Content -LiteralPath $runLog.FullName -Raw -Encoding utf8)
    Write-Log "最新の監査ログ: $($runLog.Name)（$($runLog.LastWriteTime.ToString('M/d HH:mm')) 終了）"
    Write-Log "  内容: $(($text.Trim() -split "`n")[0])"
    if ($text -match $LimitPattern) {
        $isLimit = $true
        $reset = Get-ResetTime $text $runLog.LastWriteTime
        if (-not $reset) {
            $reset = $runLog.LastWriteTime.AddHours(5)
            Write-Log 'リセット時刻を読み取れないため、中断から 5 時間後とみなします' 'WARN'
        }
        $readyAt = $reset.AddMinutes($ResetMarginMinutes)
    } elseif ($text -notmatch $ErrorPattern) {
        Write-Log '最新の監査は正常終了しているようです。再開の必要はありません' 'OK'
        exit 0
    }
    if ($runLog.Name -match 'claude_run_(\d{8})_(\d{4})') {
        $runStamp = "$($Matches[1])_$($Matches[2])"
        $sid = Find-SessionId ([datetime]::ParseExact($Matches[1] + $Matches[2], 'yyyyMMddHHmm', $null))
        # 中断した監査の開始時と比べて canonical が変わっていないか（改変検知）
        $md5Check = Get-ChangedSinceRun (Join-Path $OutDir "md5_before_$runStamp.txt")
        $changed  = if ($md5Check) { $md5Check.Changed } else { @() }
        if ($null -eq $md5Check) {
            Write-Log "  md5_before_$runStamp.txt が見つからないため、監査開始時との md5 照合は省略" 'WARN'
        } elseif ($changed.Count -gt 0) {
            if ($Schedule) {
                Write-Log "🛑 監査開始時から canonical が変わっています（$($changed -join ', ')）。安全のため自動再開は予約しません" 'ERROR'
                Send-Notify "🛑 監査（$Target）は canonical の変化（$($changed -join ', ')）を検知したため、自動再開を予約しませんでした"
                exit 2
            }
            Write-Log "監査開始時から canonical が変わっています（$($changed -join ', ')）。レース開催中の更新などでなければ確認してください" 'WARN'
        } else {
            Write-Log '  canonical md5: 監査開始時と一致'
        }
    }
} else {
    Write-Log "監査ログ（claude_run_*.log）が見つかりません: $OutDir" 'ERROR'
    exit 1
}

if ($SessionId) { $sid = $SessionId }
if (-not $sid) {
    Write-Log 'セッションIDを特定できませんでした。-SessionId <ID> を指定して実行してください' 'ERROR'
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path (Get-ProjectDir) "$sid.jsonl"))) {
    Write-Log "セッション記録 $sid.jsonl が $(Get-ProjectDir) にありません（ID を確認してください）" 'WARN'
}
if ($attempt -gt $MaxAttempts) {
    Write-Log "再開の回数が上限（$MaxAttempts 回）に達しています。-MaxAttempts を増やすか、監査を軽くしてから再実行してください" 'ERROR'
    Send-Notify "🛑 監査（$Target）の自動再開は上限 $MaxAttempts 回に達したため停止しました"
    exit 1
}

Write-Log "再開対象: session=$sid / $attempt 回目 / 再開予定 $($readyAt.ToString('M/d HH:mm'))"

# ---------------------------------------------------------------- 2. -Schedule: タスクスケジューラに登録
if ($Schedule) {
    if (-not $isLimit) {
        Write-Log '利用上限以外の理由で止まっているため、自動予約はしません（原因を確認してから手動で再開してください）' 'WARN'
        exit 1
    }
    $runAt = if ($readyAt -gt (Get-Date)) { $readyAt } else { (Get-Date).AddMinutes(1) }
    $argLine = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass'
        '-File', "`"$PSCommandPath`""
        '-Target', $Target, '-RepoDir', "`"$RepoDir`"", '-OutDir', "`"$OutDir`""
        '-SessionId', $sid, '-Model', $Model, '-Effort', $Effort, '-MaxAttempts', $MaxAttempts
    ) -join ' '
    if ($DryRun -or -not $IsWindows) {
        Write-Log "[DryRun] タスク $TaskName を $($runAt.ToString('M/d HH:mm')) に登録する予定: pwsh $argLine"
        exit 0
    }
    $pwsh     = (Get-Command pwsh).Source
    $action   = New-ScheduledTaskAction -Execute $pwsh -Argument $argLine -WorkingDirectory $RepoDir
    $trigger  = New-ScheduledTaskTrigger -Once -At $runAt
    $trigger.EndBoundary = $runAt.AddDays(1).ToString('s')
    $settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable `
                    -ExecutionTimeLimit (New-TimeSpan -Days 1) -DeleteExpiredTaskAfter (New-TimeSpan -Hours 1)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
        -Description "ダイナミック監査（$Target）の自動再開" -Force | Out-Null
    Write-Log "タスクスケジューラに登録しました: $TaskName → $($runAt.ToString('M/d HH:mm')) に再開" 'OK'
    Send-Notify "⏸ 監査（$Target）が利用上限で中断しました。$($runAt.ToString('M/d HH:mm')) に続きから自動で再開します"
    exit 0
}

if ($DryRun) {
    Write-Log "[DryRun] $($readyAt.ToString('M/d HH:mm')) まで待機 → 使用率確認 → 次のコマンドで再開:"
    Write-Log "[DryRun]   cd `"$RepoDir`"; claude -p '<再開の指示>' --resume $sid --model $Model --effort $Effort --output-format json --permission-mode bypassPermissions --add-dir `"$OutDir`""
    Write-Log "[DryRun] 再開の指示: $ResumePrompt"
    exit 0
}

# ---------------------------------------------------------------- 3. 待機 → 使用率確認 → 再開（上限なら繰り返し）
if (Test-Path -LiteralPath $LockPath) {
    $lockPid = [string](Get-Content -LiteralPath $LockPath -Raw)
    if ($lockPid -match '^\d+' -and (Get-Process -Id ([int]$Matches[0]) -ErrorAction SilentlyContinue)) {
        Write-Log "別の再開処理（PID $($Matches[0])）が実行中のため終了します" 'WARN'
        exit 0
    }
}
Set-Content -LiteralPath $LockPath -Value $PID
Set-KeepAwake $true
$exitCode = 1
try {
    :resume while ($true) {
        if (-not $NoWait -and $readyAt -gt (Get-Date)) {
            Write-Log "⏳ $($readyAt.ToString('M/d HH:mm')) まで待機します（このウィンドウは閉じないでください / 中止は Ctrl+C）"
            while (($left = ($readyAt - (Get-Date)).TotalSeconds) -gt 0) { Start-Sleep -Seconds ([math]::Min(60, [math]::Ceiling($left))) }
        }
        $NoWait = $false

        # 使用率の確認（高ければ 10 分おきに最大 6 回）
        $go = $false
        for ($i = 1; $i -le 6; $i++) {
            $u = Get-Usage
            Write-Log "使用率: セッション $($u.Session)% / 週次 $($u.Week)%"
            if ($null -ne $u.Week -and $u.Week -ge $WeeklyThreshold) {
                Write-Log "週次の使用率が $WeeklyThreshold% 以上のため再開を見送ります" 'ERROR'
                Send-Notify "🛑 監査（$Target）の再開を見送りました（週次使用率 $($u.Week)%）"
                exit 1
            }
            if ($null -eq $u.Session) { Write-Log '使用率を読み取れませんでした。そのまま再開を試みます' 'WARN'; $go = $true; break }
            if ($u.Session -le $UsageThreshold) { $go = $true; break }
            Write-Log "セッション使用率が $UsageThreshold% を超えています。10 分後に確認し直します（$i/6）" 'WARN'
            if ($i -lt 6) { Start-Sleep -Seconds 600 }
        }
        if (-not $go) {
            Send-Notify "⏸ 監査（$Target）の再開を見送りました（セッション使用率 $($u.Session)%）。resume_audit.ps1 を再実行してください"
            exit 1
        }

        $r = Invoke-Resume $sid $attempt
        $sid = $r.SessionId
        Save-State @{
            target    = $Target
            runLog    = if ($runLog) { $runLog.Name } else { $null }
            sessionId = $sid
            attempt   = $attempt
            status    = $r.Status
            resetAt   = if ($r.ResetAt) { $r.ResetAt.ToString('s') } else { $null }
            exitCode  = $r.ExitCode
            log       = $r.Log
        }

        switch ($r.Status) {
            'completed' {
                Write-Log "✅ 再開が完了しました（$($r.Minutes) 分 / canonical md5 一致 / report.md 更新: $(if ($r.ReportUpdated) {'あり'} else {'なし'})）" 'OK'
                Write-Host ''
                Write-Host $r.Result
                Write-Host ''
                $head = ($r.Result -split "`n" | Select-Object -First 12) -join "`n"
                Send-Notify "✅ 監査（$Target）の再開が完了しました（$attempt 回目 / $($r.Minutes) 分 / md5 一致 / report.md 更新: $(if ($r.ReportUpdated) {'あり'} else {'なし'})）`n$head"
                $exitCode = 0
            }
            'limit' {
                $attempt++
                $reset = if ($r.ResetAt) { $r.ResetAt } else { (Get-Date).AddHours(5) }
                $readyAt = $reset.AddMinutes($ResetMarginMinutes)
                if ($attempt -gt $MaxAttempts) {
                    Write-Log "再び利用上限に達しました。再開の回数が上限（$MaxAttempts 回）に達したため停止します" 'ERROR'
                    Send-Notify "🛑 監査（$Target）は $MaxAttempts 回再開しても完了しませんでした。監査を軽くしてから再実行してください"
                    $exitCode = 1
                    break resume
                }
                Write-Log "⏸ 再び利用上限に達しました（$($r.Minutes) 分）。$($readyAt.ToString('M/d HH:mm')) に $attempt 回目の再開を行います" 'WARN'
                Send-Notify "⏸ 監査（$Target）が再開中に再び利用上限に達しました。$($readyAt.ToString('M/d HH:mm')) に続きから再開します（$attempt/$MaxAttempts 回目）"
                continue resume
            }
            'md5_mismatch' {
                Write-Log '🛑 canonical md5 不一致！ 本番ファイルが変更された可能性があります。自動再開を停止しました' 'ERROR'
                Send-Notify "🛑 監査（$Target）の再開で canonical md5 が不一致になりました。本番ファイルを確認してください"
                $exitCode = 2
            }
            default {
                $errLine = @($r.Result -split "`n" | Where-Object { $_ -match $ErrorPattern }) + @(($r.Result -split "`n")[0]) | Select-Object -First 1
                Write-Log "🛑 再開がエラーで終了しました（exit=$($r.ExitCode)）: $errLine" 'ERROR'
                Send-Notify "🛑 監査（$Target）の再開がエラーで終了しました（exit=$($r.ExitCode)）。ログ: $($r.Log)"
                $exitCode = 1
            }
        }
        break resume
    }
} finally {
    Set-KeepAwake $false
    Remove-Item -LiteralPath $LockPath -ErrorAction SilentlyContinue
    Write-Log "########## 監査の再開 終了 ##########"
}
exit $exitCode
