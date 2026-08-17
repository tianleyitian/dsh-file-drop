/**
 * dsh-file-drop — host half（持久版拖放拦截）。
 * 原 dynamic 插件 drop-1 的宿主逻辑完整移植：
 *   - 常驻 PowerShell WinForms 透明小窗（跟随鼠标），OLE 拖放截获真实路径
 *   - 命令通道：cmdDir/cmd 追加式文件 + UI 线程 Timer 轮询（杜绝竞态丢命令）
 *   - helper 自愈：点击关闭 / 8s 无活动自动隐藏 / ThreadException 捕获 / DLL 缓存重启
 *   - 看门狗 20s 检测 + arm 时后台拉起；失败回退内容上传（fs 直写 / node 批量）
 *   - 客户端通信：POST /file-drop/api/{arm|take|disarm|ingest}（webServer 路由）
 */
import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'

// ── 最小服务面（结构类型，随运行服务装配） ─────────────────────────────
interface FsTarget { targetKey: string }
interface FsService {
  resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget>
  stat(t: FsTarget): Promise<unknown | undefined>
  processPath(t: FsTarget): string
  readText(t: FsTarget): Promise<string>
  writeText(t: FsTarget, content: string, expected?: unknown, signal?: unknown, policy?: unknown): Promise<unknown>
}
interface SubprocessHandle {
  pid: number
  stdin: { write(s: string): void; on(ev: string, fn: (...a: unknown[]) => void): void }
  stdout: { on(ev: 'data', fn: (c: Buffer) => void): void; on(ev: 'error', fn: () => void): void }
  collected?: { stderr?: { readFrom(n: number): { text: string } } }
  done: Promise<{ exitCode: number | null }>
  terminate(): void
}
interface SubprocessService {
  resolveExecutable(cmd: string): Promise<string>
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: { stdin: 'ignore' | 'pipe' | { data: string }; stdout: 'inherit' | 'pipe' | { maxBytes: number }; stderr: 'inherit' | 'pipe' | { maxBytes: number } }
    graceMs: number
  }): SubprocessHandle
}
interface ShellService {
  resolve(req: unknown): any
  run(spec: { command: string; stdin?: string; timeoutMs?: number; sandboxPolicy?: unknown }): Promise<{ exitCode: number | null; stderr?: { text?: string } }>
}
interface SessionLike { header?: { cwd?: string } }
interface SessionsService { get(id: string): SessionLike | undefined }
interface WebRoute { kind: 'prefix' | 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }
interface WebServerService { register(route: WebRoute): () => void }
interface CommandsService {
  register(def: {
    name: string
    description: string
    handler(inv: { rawInput: string; signal: AbortSignal }): unknown
  }): () => void
}

type AppContext = Context & {
  fs: FsService
  subprocess: SubprocessService
  shell: ShellService
  sessions: SessionsService
  webServer: WebServerService
  sandboxPolicy?: { workspaceRoot?: string }
  timer: { timeout(cb: () => void, ms: number): () => void }
  commands: CommandsService
  setInterval(fn: () => void, ms: number): any
}

export const name = 'dsh-file-drop'
export const inject = ['fs', 'shell', 'sessions', 'subprocess', 'timer', 'webServer', 'sandboxPolicy', 'commands']

// ── HTTP 工具 ────────────────────────────────────────────────────────
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => {
      data += c
      if (data.length > 64 * 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** 同源围栏：Origin/Referer 与 Host 不一致时拒绝（本地其他页面不可调用）。 */
function fence(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (!host) return true
  const origin = req.headers.origin
  if (origin) {
    try { return new URL(origin).host === host } catch { return false }
  }
  const referer = req.headers.referer
  if (referer) {
    try { return new URL(referer).host === host } catch { return false }
  }
  return true
}

export function apply(ctx: AppContext): void {
  let helper: {
    handle: SubprocessHandle
    buf: string
    dead: boolean
    cmdDir: string
  } | null = null
  let pendingPaths: string[] | null = null
  let pendingCancelled = false
  // 文件选择（命令菜单）：helper 弹出系统对话框后的路径回传
  let pendingPickResolve: ((paths: string[]) => void) | null = null
  // host 命令 pick-file 选出的路径，client 经 take 取回写入输入框
  let pendingPickPaths: string[] | null = null
  let helperActive = false
  let spawnPromise: Promise<unknown> | null = null
  let diagFile: string | null = null

  const sanitizeSegment = (seg: string): string | null => {
    const s = String(seg).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
    if (!s || s === '.' || s === '..') return null
    return s.length > 120 ? s.slice(0, 120) : s
  }

  const resolveCwd = (sessionId?: string): string | null => {
    if (sessionId) {
      const session = ctx.sessions.get(sessionId)
      if (session && session.header && typeof session.header.cwd === 'string' && session.header.cwd) return session.header.cwd
    }
    const sp = ctx.sandboxPolicy
    if (sp && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot) return sp.workspaceRoot
    return null
  }

  // fs 写入统一走 danger-full-access（fs 沙箱根是进程 cwd，会话工作区在其外时默认拒写）
  const fsWrite = async (path: string, content: string): Promise<void> => {
    const cwd = resolveCwd()
    const target = await ctx.fs.resolve(path)
    await ctx.fs.writeText(target, content, undefined, undefined, {
      mode: 'danger-full-access',
      workspaceRoot: String(cwd || path),
    })
  }

  const diag = async (msg: string): Promise<void> => {
    try {
      if (!diagFile) {
        const cwd = resolveCwd()
        if (!cwd) return
        diagFile = String(cwd).replace(/[\\/]+$/, '') + '/.dsh-file-drop/.helper/diag.log'
      }
      let prev = ''
      try { prev = await ctx.fs.readText(await ctx.fs.resolve(diagFile)) } catch { /* 首写 */ }
      await fsWrite(diagFile, prev + new Date().toISOString() + ' ' + msg + '\n')
    } catch { /* 诊断失败静默 */ }
  }

  // helper 脚本：小透明窗跟随鼠标 + 自愈 + 状态上报。日志函数不能叫 H
  // （h 是 Get-History 内置别名，优先级高于函数，会让 helper 一启动就崩）。
  const HELPER_SCRIPT = `$ErrorActionPreference = 'Stop'
# 隐藏控制台 + 管道输出时 [Console]::Out 默认走 OEM 代码页（中文系统 = GBK），
# 中文路径经 stdout 上报会被宿主按 UTF-8 解码成乱码——强制 UTF-8。
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
# 单实例自清理：host 重启时旧 helper 可能未被 terminate 干净，多个 helper 会
# 竞争同一 cmd 文件、上报到已断开的旧管道（导致 pick 请求挂起）——启动即
# 杀掉所有命令行含本脚本特征（DshDropWin32）的遗留 powershell。
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*DshDropWin32*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$cmdDir = Join-Path (Get-Location) '.dsh-file-drop/.helper'
[System.IO.Directory]::CreateDirectory($cmdDir) | Out-Null
$dll = Join-Path $cmdDir 'DshDropWin32.dll'
# DLL 缓存：已含全部所需类型则直接加载；旧版本缺失 DshFolderPicker 时重新编译。
$typesOk = $false
if (Test-Path $dll) {
  try {
    Add-Type -Path $dll
    $typesOk = ('DshFolderPicker' -as [type]) -ne $null -and ('DshDropWin32' -as [type]) -ne $null
  } catch { $typesOk = $false }
}
if (-not $typesOk) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshDropWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
[ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
public class FileOpenDialogRCW { }
[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileOpenDialog {
  [PreserveSig] int Show(IntPtr hwndOwner);
  [PreserveSig] int SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
  [PreserveSig] int SetFileTypeIndex(uint iFileType);
  [PreserveSig] int GetFileTypeIndex(out uint piFileType);
  [PreserveSig] int Advise(IntPtr pfde, out uint pdwCookie);
  [PreserveSig] int Unadvise(uint dwCookie);
  [PreserveSig] int SetOptions(uint fos);
  [PreserveSig] int GetOptions(out uint pfos);
  [PreserveSig] int SetDefaultFolder(IShellItem psi);
  [PreserveSig] int SetFolder(IShellItem psi);
  [PreserveSig] int GetFolder(out IShellItem ppsi);
  [PreserveSig] int GetCurrentSelection(out IShellItem ppsi);
  [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
  [PreserveSig] int GetFileName(out IntPtr pszName);
  [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
  [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
  [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
  [PreserveSig] int GetResult(out IShellItem ppsi);
}
[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItem {
  [PreserveSig] int BindToHandler(IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid bhid, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);
  [PreserveSig] int GetParent(out IShellItem ppsi);
  [PreserveSig] int GetDisplayName(uint sigdnName, out IntPtr ppszName);
  [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
  [PreserveSig] int Compare(IShellItem psi, uint hint, out int piOrder);
}
/// Windows 10+ 现代文件夹选择对话框（IFileDialog + FOS_PICKFOLDERS）。
public static class DshFolderPicker {
  public static string Pick(IntPtr owner) {
    try {
      IFileOpenDialog dialog = (IFileOpenDialog)(new FileOpenDialogRCW());
      uint opts;
      if (dialog.GetOptions(out opts) == 0) {
        dialog.SetOptions(opts | 0x00000020u); // FOS_PICKFOLDERS
      }
      dialog.SetTitle("选择文件夹（路径将填入输入框）");
      if (dialog.Show(owner) != 0) return null;
      IShellItem item;
      if (dialog.GetResult(out item) != 0 || item == null) return null;
      IntPtr psz;
      if (item.GetDisplayName(0x80018000u, out psz) != 0 || psz == IntPtr.Zero) return null;
      string path = Marshal.PtrToStringUni(psz);
      if (path != null && path.StartsWith("\\\\?\\", StringComparison.Ordinal)) path = path.Substring(4);
      return path;
    } catch { return null; }
  }
}
'@ -OutputAssembly $dll -OutputType Library
  Add-Type -Path $dll
}
[DshDropWin32]::SetProcessDPIAware() | Out-Null
function LogH($m) { try { [System.IO.File]::AppendAllText($cmdDir + '/helper.log', [DateTime]::Now.ToString('HH:mm:ss.fff') + ' ' + $m + [Environment]::NewLine) } catch {} }
function Report($j) { try { [Console]::Out.WriteLine($j); [Console]::Out.Flush() } catch {} }
LogH('helper starting')
[System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
[System.Windows.Forms.Application]::add_ThreadException({ param($s, $e) try { LogH('THREAD-EX: ' + [string]$e.Exception) } catch {} })
$null = [System.AppDomain]::CurrentDomain.add_UnhandledException({ param($s, $e) try { LogH('FATAL: ' + [string]$e.ExceptionObject) } catch {} })
$form = New-Object System.Windows.Forms.Form
$form.Text = 'dsh-drop-helper'
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.Opacity = 0.02
$form.BackColor = [System.Drawing.Color]::Black
$form.AllowDrop = $true
$form.Width = 200
$form.Height = 200
$lastActivity = [DateTime]::Now
function Touch { $script:lastActivity = [DateTime]::Now }
$form.Add_DragEnter({
  param($s, $e)
  try {
    Touch
    $e.Effect = [System.Windows.Forms.DragDropEffects]::Copy
  } catch { LogH('DRAGENTER-ERR: ' + $_.Exception.Message) }
})
$form.Add_DragOver({
  param($s, $e)
  try {
    Touch
    $e.Effect = [System.Windows.Forms.DragDropEffects]::Copy
  } catch {}
})
$form.Add_DragDrop({
  param($s, $e)
  try {
    $e.Effect = [System.Windows.Forms.DragDropEffects]::Copy
    $paths = @($e.Data.GetData([System.Windows.Forms.DataFormats]::FileDrop))
    LogH('dropped count=' + $paths.Count)
    Report((@{ kind = 'dropped'; paths = $paths } | ConvertTo-Json -Compress -Depth 6))
  } catch {
    LogH('DROP-ERR: ' + $_.Exception.Message)
    Report((@{ kind = 'error'; msg = [string]$_.Exception.Message } | ConvertTo-Json -Compress))
  }
  try { $form.Hide() } catch {}
})
$form.Add_DragLeave({
  param($s, $e)
  try {
    LogH('dragleave')
    Report('{"kind":"cancelled"}')
  } catch {}
  try { $form.Hide() } catch {}
})
$form.Add_Click({
  param($s, $e)
  try {
    LogH('clicked')
    Report('{"kind":"cancelled"}')
  } catch {}
  try { $form.Hide() } catch {}
})
$script:pickOpen = $false
$script:pickDlg = $null
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 50
$timer.Add_Tick({
  # 对话框打开期间（pickOpen）：不跟随鼠标、不自动隐藏——8s 无活动隐藏会
  # 连带隐藏模态对话框（owner 被 Hide → 对话框"莫名其妙消失"，ShowDialog
  # 却仍在阻塞，输入焦点被占）。对话框期间只响应 close-picker 命令。
  if (-not $script:pickOpen) {
    try {
      if ($form.Visible) {
        $p = [System.Windows.Forms.Cursor]::Position
        $form.Location = New-Object System.Drawing.Point(($p.X - 100), ($p.Y - 100))
        if (((Get-Date) - $lastActivity).TotalSeconds -gt 8) {
          LogH('auto-hide (idle 8s)')
          Report('{"kind":"cancelled"}')
          $form.Hide()
        }
      }
    } catch { LogH('FOLLOW-ERR: ' + $_.Exception.Message) }
  }
  try {
    $cmdFile = Join-Path $cmdDir 'cmd'
    if (Test-Path $cmdFile) {
      $lines = @(Get-Content $cmdFile)
      Remove-Item $cmdFile -Force -ErrorAction SilentlyContinue
      foreach ($line in $lines) {
        if ($line -eq 'show') {
          Touch
          $p = [System.Windows.Forms.Cursor]::Position
          $form.Location = New-Object System.Drawing.Point(($p.X - 100), ($p.Y - 100))
          if (-not $form.IsHandleCreated) { [void]$form.CreateControl() }
          $h = $form.Handle
          [DshDropWin32]::ShowWindow($h, 8) | Out-Null
          [DshDropWin32]::ShowWindow($h, 8) | Out-Null
          [DshDropWin32]::SetWindowPos($h, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null
          LogH('shown')
          Report('{"kind":"shown"}')
        } elseif ($line -eq 'hide') {
          $form.Hide()
          Report('{"kind":"hidden"}')
        } elseif ($line -eq 'close-picker') {
          # 请求超时/中止时由宿主下发：在嵌套 tick 里关闭模态对话框，
          # ShowDialog 随即返回（Cancel），对话框不再悬挂。
          LogH('CLOSE-PICKER: 关闭对话框')
          if ($script:pickDlg) {
            try { $script:pickDlg.Close() } catch { LogH('CLOSE-PICKER-ERR: ' + $_.Exception.Message) }
          }
        } elseif ($line -eq 'open-picker') {
          # 系统原生文件选择框（模态，跑在 UI 线程）；取消时上报空结果。
          # 对话框打开期间 Timer 仍会 tick（嵌套消息循环）——用 pickOpen 标志
          # 挡住重复/嵌套的 open-picker，避免连点出多个对话框互相打架。
          if ($script:pickOpen) {
            LogH('PICK-BUSY: 已有对话框打开，忽略重复命令')
          } else {
            $script:pickOpen = $true
            try {
              LogH('PICK: 打开对话框')
              $dlg = New-Object System.Windows.Forms.OpenFileDialog
              $dlg.Multiselect = $true
              $dlg.Title = '选择文件（路径将填入输入框）'
              $dlg.Filter = '所有文件 (*.*)|*.*'
              $dlg.RestoreDirectory = $true
              # 关键：ShowDialog 无 owner 时对话框可能弹出在屏幕外/被遮挡（用户看不到，
              # ShowDialog 永久阻塞）。先显示透明窗（跟随鼠标、topmost）作为 owner，
              # 对话框会出现在鼠标附近且层级在最前。
              try {
                $p = [System.Windows.Forms.Cursor]::Position
                $form.Location = New-Object System.Drawing.Point(($p.X - 100), ($p.Y - 100))
                $form.Show()
                if (-not $form.IsHandleCreated) { [void]$form.CreateControl() }
                [DshDropWin32]::ShowWindow($form.Handle, 8) | Out-Null
                [DshDropWin32]::SetWindowPos($form.Handle, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null
              } catch { LogH('PICK-OWNER-ERR: ' + $_.Exception.Message) }
              $script:pickDlg = $dlg
              $result = $dlg.ShowDialog($form)
              LogH('PICK: ShowDialog 结果=' + $result)
              if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
                $names = @($dlg.FileNames)
                LogH('PICK: 选中 ' + $names.Count + ' 个文件')
                Report((@{ kind = 'picked'; paths = $names } | ConvertTo-Json -Compress -Depth 6))
              } else {
                LogH('PICK: 用户取消')
                Report('{"kind":"pick-cancelled"}')
              }
            } catch {
              LogH('PICK-ERR: ' + $_.Exception.Message)
              Report('{"kind":"pick-cancelled"}')
            } finally {
              $script:pickOpen = $false
              $script:pickDlg = $null
              try { $form.Hide() } catch {}
            }
          }
        } elseif ($line -eq 'open-folder-picker') {
          # 现代文件夹选择对话框（IFileDialog FOS_PICKFOLDERS，与资源管理器同款 UI）
          if ($script:pickOpen) {
            LogH('PICK-BUSY: 已有对话框打开，忽略重复命令')
          } else {
            $script:pickOpen = $true
            try {
              LogH('FOLDERPICK: 打开文件夹选择器')
              $p = [System.Windows.Forms.Cursor]::Position
              $form.Location = New-Object System.Drawing.Point(($p.X - 100), ($p.Y - 100))
              $form.Show()
              if (-not $form.IsHandleCreated) { [void]$form.CreateControl() }
              [DshDropWin32]::ShowWindow($form.Handle, 8) | Out-Null
              [DshDropWin32]::SetWindowPos($form.Handle, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null
              $folder = [DshFolderPicker]::Pick($form.Handle)
              LogH('FOLDERPICK: 结果=' + ($(if ($folder) { '选中' } else { '取消' })))
              if ($folder) {
                Report((@{ kind = 'picked'; paths = @($folder) } | ConvertTo-Json -Compress -Depth 6))
              } else {
                Report('{"kind":"pick-cancelled"}')
              }
            } catch {
              LogH('FOLDERPICK-ERR: ' + $_.Exception.Message)
              Report('{"kind":"pick-cancelled"}')
            } finally {
              $script:pickOpen = $false
              try { $form.Hide() } catch {}
            }
          }
        } elseif ($line -eq 'quit') {
          [System.Windows.Forms.Application]::Exit()
        }
      }
    }
  } catch { LogH('TICK-ERR: ' + $_.Exception.Message) }
})
$timer.Start()
Report('{"kind":"ready"}')
LogH('loop starting')
[System.Windows.Forms.Application]::Run()
LogH('loop ended')
Report('{"kind":"exited"}')
`

  const spawnHelper = async (cwd: string): Promise<void> => {
    if (helper && !helper.dead && helper.handle) return
    if (spawnPromise) { await spawnPromise; return }
    spawnPromise = (async () => {
      let ps: string | null = null
      try { ps = await ctx.subprocess.resolveExecutable('powershell') } catch { ps = null }
      if (!ps) ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      await diag('spawn helper start')
      const handle = ctx.subprocess.spawn({
        argv: [ps, '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', HELPER_SCRIPT],
        cwd: String(cwd),
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 8192 } },
        graceMs: 5000,
      })
      const cmdDir = String(cwd).replace(/[\\/]+$/, '') + '/.dsh-file-drop/.helper'
      const state = { handle, buf: '', dead: false, cmdDir }
      helper = state
      handle.stdout.on('data', (chunk: Buffer) => {
        state.buf += String(chunk)
        let idx: number
        while ((idx = state.buf.indexOf('\n')) !== -1) {
          const line = state.buf.slice(0, idx).trim()
          state.buf = state.buf.slice(idx + 1)
          if (!line) continue
          try {
            const msg = JSON.parse(line) as { kind?: string; paths?: unknown[] }
            if (msg && msg.kind === 'dropped' && Array.isArray(msg.paths)) {
              pendingPaths = msg.paths.map((p) => String(p))
              pendingCancelled = false
              helperActive = false
              void diag('helper dropped: ' + pendingPaths.length + ' paths')
            } else if (msg && msg.kind === 'cancelled') {
              pendingCancelled = true
              pendingPaths = null
              helperActive = false
              void diag('helper cancelled')
            } else if (msg && msg.kind === 'shown') {
              helperActive = true
              void diag('helper shown')
            } else if (msg && msg.kind === 'hidden') {
              helperActive = false
              void diag('helper hidden')
            } else if (msg && msg.kind === 'ready') {
              void diag('helper ready')
            } else if (msg && msg.kind === 'picked' && Array.isArray(msg.paths)) {
              const paths = msg.paths.map((p) => String(p))
              void diag('helper picked: ' + paths.length + ' paths')
              if (pendingPickResolve) {
                const r = pendingPickResolve
                pendingPickResolve = null
                r(paths)
              }
            } else if (msg && msg.kind === 'pick-cancelled') {
              void diag('helper pick cancelled')
              if (pendingPickResolve) {
                const r = pendingPickResolve
                pendingPickResolve = null
                r([])
              }
            }
          } catch { /* 非 JSON 行忽略 */ }
        }
      })
      handle.stdout.on('error', () => { state.dead = true; void diag('helper stdout error') })
      handle.done.then(() => {
        state.dead = true
        helperActive = false
        void diag('helper exited')
        try {
          const err = handle.collected?.stderr?.readFrom(0).text ?? ''
          if (err.trim()) void diag('helper stderr: ' + err.slice(0, 500))
        } catch { /* ignore */ }
      }).catch(() => { state.dead = true; helperActive = false; void diag('helper done rejected') })
    })()
    try {
      await spawnPromise
    } finally {
      spawnPromise = null
    }
  }

  // 追加式命令：helper 按行顺序执行，最后一条命令生效（show→hide 必收敛）
  const sendCmd = async (state: { cmdDir: string }, text: string): Promise<void> => {
    const p = state.cmdDir + '/cmd'
    let prev = ''
    try { prev = await ctx.fs.readText(await ctx.fs.resolve(p)) } catch { /* 首写 */ }
    await fsWrite(p, prev + text + '\n')
  }

  // 打开系统原生选择框并等待结果（取消返回空数组）。供 API pick 与
  // host 命令 pick-file/pick-folder 共用；同一时刻只允许一个选择进行中。
  // cmd：'open-picker'（文件）/ 'open-folder-picker'（文件夹）。
  // signal：命令执行中止（会话关闭/UI 取消）时主动 close-picker 关闭对话框，
  // 避免对话框与请求生命周期脱节（对话框悬挂 → helper 卡死 → 无法再 pick）。
  const openPicker = async (signal?: AbortSignal, cmd = 'open-picker'): Promise<string[]> => {
    const state = (helper && !helper.dead) ? helper : null
    if (!state) {
      const cwd = resolveCwd()
      if (cwd) {
        void diag('pick: helper missing, background respawn')
        spawnHelper(cwd).catch((e) => void diag('pick respawn failed: ' + String((e as Error)?.message ?? e)))
      }
      return []
    }
    if (pendingPickResolve) return []
    const result = new Promise<string[]>((resolve) => { pendingPickResolve = resolve })
    // 请求中止：让 helper 在嵌套 tick 里关闭模态对话框（ShowDialog 随即返回并
    // 上报 pick-cancelled），pendingPickResolve 被消费，不残留悬挂状态。
    // （文件夹对话框为 COM 对话框，无 Close API——中止时仅解除 host 等待，
    // 对话框由用户自行关闭，关闭后的上报会被忽略，无害。）
    const onAbort = (): void => {
      try { void sendCmd(state, 'close-picker') } catch { /* ignore */ }
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      await sendCmd(state, cmd)
    } catch (e) {
      pendingPickResolve = null
      void diag('pick sendCmd failed: ' + String((e as Error)?.message ?? e))
      return []
    }
    // 用户长时间不选择/对话框异常时兜底（5min，选文件足够宽裕）：
    // 超时后同样 close-picker 关闭对话框，避免对话框悬挂。
    const timeout = new Promise<string[]>((resolve) => {
      ctx.timer.timeout(() => {
        if (pendingPickResolve) {
          pendingPickResolve = null
          try { void sendCmd(state, 'close-picker') } catch { /* ignore */ }
          resolve([])
        }
      }, 300000)
    })
    return Promise.race([result, timeout])
  }

  // host 命令 pick-file：加号菜单点击即执行（无参数 bare 命令 → runDetached
  // 直接执行，不经过 popupSelect 选项壳）。路径暂存 pendingPickPaths，
  // client 经 take 取回写入输入框。
  const registerPickCommand = (name: string, description: string, cmd: string): (() => void) => {
    return ctx.commands.register({
      name,
      description,
      handler: async (inv): Promise<{ kind: 'success' | 'error'; text: string }> => {
        const paths = await openPicker(inv.signal, cmd)
        pendingPickPaths = paths.length ? paths : null
        void diag('command ' + name + ': ' + (paths.length ? paths.length + ' paths' : 'cancelled'))
        if (!paths.length) return { kind: 'success', text: '未选择' }
        return { kind: 'success', text: '已选择 ' + paths.length + ' 个' }
      },
    })
  }
  ctx.effect(() => registerPickCommand('pick-file', '打开系统文件选择框，把文件路径填入输入框', 'open-picker'),
    'dsh-file-drop: pick-file command')
  ctx.effect(() => registerPickCommand('pick-folder', '打开系统文件夹选择框，把文件夹路径填入输入框', 'open-folder-picker'),
    'dsh-file-drop: pick-folder command')

  ctx.effect(() => () => {
    if (helper && helper.handle) {
      try { helper.handle.terminate() } catch { /* ignore */ }
    }
  })

  // 看门狗：helper 意外死亡时自动重启（DLL 缓存后重启约 1 秒）
  ctx.setInterval(() => {
    if (helper && helper.dead) {
      const cwd = resolveCwd()
      if (cwd) spawnHelper(cwd).catch((e) => void diag('watchdog respawn failed: ' + String((e as Error)?.message ?? e)))
    }
  }, 20000)

  // ── HTTP API（POST /file-drop/api/{arm|take|disarm|ingest}） ──────────
  const api: Record<string, (payload: any) => Promise<unknown>> = {
    arm: async (payload: { sessionId?: string }) => {
      pendingPaths = null
      pendingCancelled = false
      const cwd = resolveCwd(payload?.sessionId)
      if (!cwd) return { armed: false, error: '无法确定工作目录' }
      let state = (helper && !helper.dead) ? helper : null
      if (!state) {
        void diag('arm: helper missing, background respawn')
        spawnHelper(cwd).catch((e) => void diag('arm respawn failed: ' + String((e as Error)?.message ?? e)))
        return { armed: false, error: '拦截器启动中，本次使用内容上传' }
      }
      try {
        await sendCmd(state, 'show')
        helperActive = true
        void diag('arm: show sent')
        return { armed: true }
      } catch (e) {
        void diag('arm sendCmd failed: ' + String((e as Error)?.message ?? e))
        return { armed: false, error: String((e as Error)?.message ?? e) }
      }
    },
    take: async () => {
      const out = {
        pending: pendingPaths,
        cancelled: pendingCancelled,
        armed: helperActive,
        pickPaths: pendingPickPaths,
      }
      if (pendingPaths) void diag('take: ' + pendingPaths.length + ' paths consumed')
      pendingPaths = null
      pendingCancelled = false
      pendingPickPaths = null
      return out
    },
    disarm: async () => {
      pendingPaths = null
      pendingCancelled = false
      pendingPickPaths = null
      helperActive = false
      if (helper && !helper.dead) {
        try { await sendCmd(helper, 'hide'); void diag('disarm: hide sent') } catch { /* ignore */ }
      }
      return {}
    },
    pick: async () => {
      const paths = await openPicker()
      return { paths }
    },
    ingest: async (payload: { sessionId?: string; files?: Array<{ seq?: number; name?: string; relPath?: string; top?: string; data?: string }> }) => {
      const files = Array.isArray(payload?.files) ? payload.files : []
      if (!files.length) throw new Error('缺少文件数据')
      const cwd = resolveCwd(payload?.sessionId)
      if (!cwd) throw new Error('无法确定工作目录，请先打开一个会话')
      const dropDir = String(cwd).replace(/[\\/]+$/, '') + '/.dsh-file-drop'
      const written: Array<{ seq: number | undefined; path: string; rootPath: string }> = []
      const skipped: Array<{ seq: number | undefined; relPath: string; reason: string }> = []
      const nodeBatch: Array<{ seq: number | undefined; dir: string; path: string; rootPath: string; b64: string }> = []

      for (const f of files) {
        const seq = f.seq
        const data = typeof f.data === 'string' ? f.data : ''
        const relPath = String(f.relPath || f.name || 'file')
        const segs = relPath.split(/[\\/]/).map(sanitizeSegment).filter((s): s is string => s !== null)
        if (!segs.length || !data) {
          skipped.push({ seq, relPath, reason: '无效的文件名或数据' })
          continue
        }
        const rootName = sanitizeSegment(f.top ?? '') || segs[0]
        const dest = dropDir + '/' + segs.join('/')
        let candidate = dest
        let n = 1
        for (;;) {
          const t = await ctx.fs.resolve(candidate)
          const info = await ctx.fs.stat(t)
          if (!info) break
          const dot = dest.lastIndexOf('.')
          const base = dot > 0 ? dest.slice(0, dot) : dest
          const ext = dot > 0 ? dest.slice(dot) : ''
          candidate = base + '-' + n + ext
          n += 1
        }
        const finalTarget = await ctx.fs.resolve(candidate)
        const filePath = ctx.fs.processPath(finalTarget)
        const rootTarget = await ctx.fs.resolve(dropDir + '/' + rootName)
        const rootPath = ctx.fs.processPath(rootTarget)

        let text: string | null = null
        if (data.length <= 4 * 1024 * 1024) {
          try {
            const bin = atob(data)
            const bytes = new Uint8Array(bin.length)
            for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            if (decoded.indexOf('\u0000') === -1) text = decoded
          } catch { /* 非 UTF-8 走二进制 */ }
        }
        if (text !== null) {
          try {
            await fsWrite(filePath, text)
            written.push({ seq, path: filePath, rootPath })
          } catch (err) {
            skipped.push({ seq, relPath, reason: String((err as Error)?.message ?? err).slice(0, 200) })
          }
          continue
        }
        nodeBatch.push({ seq, dir: dropDir, path: filePath, rootPath, b64: data })
      }

      if (nodeBatch.length) {
        let nodeExe: string | null = null
        try { nodeExe = await ctx.subprocess.resolveExecutable('node') } catch { nodeExe = null }
        if (nodeExe) {
          const script = "const fs=require('fs');let r='';process.stdin.on('data',c=>{r+=c});process.stdin.on('end',()=>{const j=JSON.parse(r);const bad=[];for(const f of j.files){try{fs.mkdirSync(f.dir,{recursive:true});fs.writeFileSync(f.path,Buffer.from(f.b64,'base64'))}catch(e){bad.push({seq:f.seq,msg:String(e&&e.message||e)})}}if(bad.length){console.error(JSON.stringify(bad));process.exitCode=2}})"
          try {
            const handle = ctx.subprocess.spawn({
              argv: [nodeExe, '-e', script],
              cwd: String(cwd),
              stdio: {
                stdin: { data: JSON.stringify({ files: nodeBatch }) },
                stdout: { maxBytes: 8192 },
                stderr: { maxBytes: 16384 },
              },
              graceMs: 10000,
            })
            const outcome = await handle.done
            const errText = handle.collected?.stderr?.readFrom(0).text ?? ''
            if (outcome.exitCode === 0) {
              for (const b of nodeBatch) written.push({ seq: b.seq, path: b.path, rootPath: b.rootPath })
            } else {
              let perFile: Array<{ seq: number; msg: string }> | null = null
              try { perFile = JSON.parse(errText) as Array<{ seq: number; msg: string }> } catch { perFile = null }
              if (Array.isArray(perFile)) {
                const failBySeq = new Map<number, string>()
                for (const item of perFile) failBySeq.set(item.seq, item.msg)
                for (const b of nodeBatch) {
                  const msg = b.seq !== undefined ? failBySeq.get(b.seq) : undefined
                  if (msg) skipped.push({ seq: b.seq, relPath: b.path, reason: String(msg).slice(0, 200) })
                  else written.push({ seq: b.seq, path: b.path, rootPath: b.rootPath })
                }
              } else {
                for (const b of nodeBatch) skipped.push({ seq: b.seq, relPath: b.path, reason: '二进制写入失败 (' + String(errText || outcome.exitCode).slice(0, 200) + ')' })
              }
            }
          } catch (err) {
            for (const b of nodeBatch) skipped.push({ seq: b.seq, relPath: b.path, reason: String((err as Error)?.message ?? err).slice(0, 200) })
          }
        } else {
          for (const b of nodeBatch) {
            try {
              const script = "$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force -Path '" + b.dir.replace(/'/g, "''") + "' | Out-Null; $b=[Console]::In.ReadToEnd(); [IO.File]::WriteAllBytes('" + b.path.replace(/'/g, "''") + "',[Convert]::FromBase64String($b.Trim()))"
              const spec = ctx.shell.resolve({ command: script, stdin: b.b64, timeoutMs: 120000, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: String(cwd) } })
              const res = await ctx.shell.run(spec)
              if (res.exitCode !== 0) {
                const detail = res.stderr?.text ? res.stderr.text : String(res.exitCode)
                throw new Error(detail.slice(0, 200))
              }
              written.push({ seq: b.seq, path: b.path, rootPath: b.rootPath })
            } catch (err) {
              skipped.push({ seq: b.seq, relPath: b.path, reason: String((err as Error)?.message ?? err).slice(0, 200) })
            }
          }
        }
      }
      return { written, skipped }
    },
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/file-drop/api',
    handler: async (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const PREFIX = '/file-drop/api/'
      const method = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : undefined
      if (!method || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown API method' } })
        return
      }
      try {
        const payload = (await readJsonBody(req)) as any
        const handler = api[method]
        if (!handler) {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown API method' } })
          return
        }
        writeJson(res, 200, { ok: true, value: await handler(payload) })
      } catch (e) {
        writeJson(res, 500, { ok: false, error: { code: 'internal', message: String((e as Error)?.message ?? e) } })
      }
    },
  }), 'dsh-dropin: /file-drop/api routes')

  // 激活时预热拦截器
  const bootCwd = resolveCwd()
  if (bootCwd) spawnHelper(bootCwd).catch((e) => void diag('boot spawn failed: ' + String((e as Error)?.message ?? e)))
}
