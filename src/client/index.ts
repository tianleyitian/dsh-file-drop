/**
 * dsh-file-drop — client half（持久版拖放拦截的浏览器侧）。
 * 移植自 dynamic 插件 drop-1 的客户端：全窗口拖放监听 + 拦截窗状态轮询 +
 * inputActions 桥（把真实路径写入输入框）。host 通信走 /file-drop/api HTTP。
 */
import React from 'react'
import type { Context } from 'cordis'

/** slots 运行时服务面（结构类型：register 双参形式 + inject）。 */
interface SlotsService {
  inject(key: string, callback: () => unknown): () => void
  register(options: { name: string; id?: string; order?: number; label?: string | (() => string) }, component: unknown): () => void
}

type ClientContext = Context & {
  slots: SlotsService
  timer: {
    timeout(cb: () => void, ms: number): () => void
    interval(cb: () => void, ms: number): () => void
  }
  sessions: {
    list: {
      getSnapshot(): { current?: string; byId?: Record<string, unknown> }
    }
    scope(id: string): unknown
  }
}

export const inject = ['slots', 'timer', 'sessions']

// apply 时登记的上下文（组件内直接取服务，生态标准做法，见 dsh-better-sidebar）
let clientCtx: ClientContext | null = null

// ── host API（POST /file-drop/api/{method}，响应 { ok, value }） ──────────
async function apiCall(method: string, payload?: unknown): Promise<any> {
  const res = await fetch('/file-drop/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  const parsed = await res.json().catch(() => null)
  if (!res.ok || !parsed || parsed.ok !== true) {
    throw new Error(parsed?.error?.message ?? ('HTTP ' + res.status))
  }
  return parsed.value
}
const api = {
  arm: (sessionId: string) => apiCall('arm', { sessionId }),
  take: () => apiCall('take', {}),
  disarm: () => apiCall('disarm', {}),
  ingest: (sessionId: string, files: unknown[]) => apiCall('ingest', { sessionId, files }),
  pick: () => apiCall('pick', {}),
}

const MAX_BYTES = 25 * 1024 * 1024
const MAX_MB = 25
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const bridgeEntries = new Map<string, { actions: { setDraft(text: string): void }; draftRef: React.MutableRefObject<string> }>()
// 最近挂载的桥接会话（标准 props 缺失时的回退来源）
let lastBridgeSession: string | undefined

// ── 会话与输入框的稳健解析 ────────────────────────────────────────────
/** 当前会话：sessions 服务快照优先（生态标准），桥登记兜底。拖放时实时读取。 */
function resolveCurrent(): string | undefined {
  try {
    const cur = clientCtx?.sessions.list.getSnapshot().current
    if (cur) return cur
  } catch { /* 服务不可用则走兜底 */ }
  return lastBridgeSession
}

/** 会话输入框操作面：优先桥（标准 props），其次 conversation 服务直连。 */
interface InputFace {
  setDraft(text: string): void
  state?: { getSnapshot(): { draft: string } }
}
function inputFaceFor(sessionId: string): InputFace | null {
  const bridge = bridgeEntries.get(sessionId)
  if (bridge && bridge.actions) {
    return {
      setDraft: (text) => bridge.actions.setDraft(text),
      state: { getSnapshot: () => ({ draft: bridge.draftRef.current }) },
    }
  }
  try {
    const actx = clientCtx?.sessions.scope(sessionId)
    if (!actx) return null
    const conversation = clientCtx?.get('conversation') as { input?: { for(actx: unknown): InputFace } } | undefined
    if (!conversation?.input) return null
    return conversation.input.for(actx) ?? null
  } catch { return null }
}

// ── 文件工具（与 dynamic 版一致） ──────────────────────────────────────
async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

interface DropItem { entry: FileSystemEntry | null; file?: File; name?: string }

function collectTopItems(dt: DataTransfer): DropItem[] {
  const items = dt.items ? Array.from(dt.items) : []
  const files = dt.files ? Array.from(dt.files) : []
  const out: DropItem[] = []
  if (items.length && typeof items[0].webkitGetAsEntry === 'function') {
    for (const item of items) {
      const entry = item.webkitGetAsEntry()
      if (!entry) continue
      if (entry.isFile || entry.isDirectory) out.push({ entry })
    }
  } else {
    for (const file of files) out.push({ entry: null, file, name: file.name })
  }
  return out
}

async function walkEntry(entry: FileSystemEntry, relPrefix: string, out: Array<{ file: File; relPath: string }>): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
    out.push({ file, relPath: relPrefix })
    return
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  let batch: FileSystemEntry[]
  do {
    batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    for (const child of batch) {
      if (child.isFile) {
        const file = await new Promise<File>((resolve, reject) => (child as FileSystemFileEntry).file(resolve, reject))
        out.push({ file, relPath: relPrefix + '/' + child.name })
      } else if (child.isDirectory) {
        await walkEntry(child, relPrefix + '/' + child.name, out)
      }
    }
  } while (batch.length > 0)
}

async function flattenTopItem(item: DropItem): Promise<Array<{ file: File; relPath: string }>> {
  if (item.entry) {
    const out: Array<{ file: File; relPath: string }> = []
    await walkEntry(item.entry, item.entry.name, out)
    return out
  }
  return [{ file: item.file!, relPath: item.name! }]
}

function allFileItemsAreImages(e: React.DragEvent | DragEvent): boolean {
  const dt = (e as DragEvent).dataTransfer
  const items = dt && dt.items
  if (!items || !items.length) return false
  const list = Array.from(items)
  const files = list.filter((it) => it.kind === 'file')
  if (!files.length) return false
  return files.every((it) => typeof it.type === 'string' && it.type.indexOf('image/') === 0)
}
function allDroppedAreImages(e: React.DragEvent | DragEvent): boolean {
  const dt = (e as DragEvent).dataTransfer
  const files = dt && dt.files
  if (!files || !files.length) return false
  return Array.prototype.every.call(files, (f: File) => typeof f.type === 'string' && f.type.indexOf('image/') === 0)
}

// ── 桥：把当前会话的 inputActions 登记到共享表 ────────────────────────
interface BridgeProps {
  sessionId: string
  inputActions?: { setDraft(text: string): void }
  useInput?: (sel: (s: { draft: string }) => any) => any
}
function DropBridge(props: BridgeProps): null {
  const { sessionId, inputActions, useInput } = props
  const draft = useInput ? useInput((state) => state.draft) : ''
  const draftRef = React.useRef('')
  draftRef.current = draft
  React.useEffect(() => {
    if (!inputActions) return
    lastBridgeSession = sessionId
    const entry = { actions: inputActions, draftRef }
    bridgeEntries.set(sessionId, entry)
    return () => {
      if (bridgeEntries.get(sessionId) === entry) bridgeEntries.delete(sessionId)
    }
  }, [sessionId, inputActions])
  return null
}

// ── 命令菜单"选择文件"源（输入框左下角 + / 命令菜单） ─────────────────
/** 打开系统原生文件选择框（host 侧 WinForms OpenFileDialog），把路径写入输入框。 */
async function pickAndPaste(sessionId: string): Promise<void> {
  try {
    const r = await api.pick()
    const paths: string[] = r && Array.isArray(r.paths) ? r.paths : []
    if (!paths.length) return
    const input = inputFaceFor(sessionId)
    if (!input) return
    const draft = input.state ? input.state.getSnapshot().draft : ''
    const joined = paths.join('\n')
    input.setDraft(draft ? draft.replace(/[ \t]+\n?$/, '') + '\n' + joined : joined)
  } catch (err) {
    console.warn('[dsh-file-drop] pick failed:', err)
  }
}

/**
 * 注册 '/' 触发词源：出现在输入框左下角命令菜单里（MenuView 按 source 分组渲染）。
 * 服务可选（未装 ui-input-trigger 时拖放功能不受影响）；onPick 返回 'handled'
 * 后异步打开文件对话框——官方为"source 自行处理（如打开自己的弹窗）"设计的路径。
 */
function registerFileSource(ctx: ClientContext): void {
  const inputTriggers = ctx.get('inputTriggers') as {
    registerSource(src: Record<string, unknown>): () => void
  } | undefined
  if (!inputTriggers) return
  ctx.effect(() => inputTriggers.registerSource({
    trigger: '/',
    name: '文件',
    order: 999,
    candidates: async () => [{
      name: '选择文件',
      description: '打开系统文件选择框，把文件路径填入输入框',
    }],
    onPick: (pick: { session?: { sessionId?: string } } | undefined) => {
      const sid = pick && pick.session ? pick.session.sessionId : undefined
      if (sid) void pickAndPaste(sid)
      return 'handled'
    },
  }), 'dsh-file-drop: command source')
  // 分组标题直接使用本地化后的 name（'文件'）。
  // 注意：不能 locale.register('slash.menu', ...) 来翻译分组名——
  // 该 namespace 已被本体（dsh-client-ui-commands）注册过 zh/en，
  // 而 dsh-client-locale 的 register 不允许重复注册同一 locale（会抛错），
  // 也没有合并/扩展 API，所以分组名只能直接写成展示文案。
}

// ── 全窗口拖放层 ──────────────────────────────────────────────────────
function DropOverlay(): React.ReactElement {
  const [active, setActive] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  const depthRef = React.useRef(0)
  const timerRef = React.useRef<(() => void) | null>(null)
  const armedRef = React.useRef(false)
  const armingRef = React.useRef(false)
  const pollRef = React.useRef<(() => void) | null>(null)
  const pollBusyRef = React.useRef(false)
  // 会话一律在 arm/drop 时刻实时解析（sessions 快照 → 桥兜底），不缓存渲染期值
  const currentRef = React.useRef<string | undefined>(undefined)
  const timer = (window as any).__dshFileDropTimer as ClientContext['timer'] | undefined

  const flash = (text: string): void => {
    setNotice(text)
    if (timerRef.current) {
      try { timerRef.current() } catch { /* ignore */ }
    }
    timerRef.current = timer!.timeout(() => {
      setNotice(null)
      timerRef.current = null
    }, 5000)
  }

  const stopPoll = (): void => {
    if (pollRef.current) {
      try { pollRef.current() } catch { /* ignore */ }
      pollRef.current = null
    }
  }

  const disarm = (): void => {
    armedRef.current = false
    stopPoll()
    api.disarm().catch(() => { /* ignore */ })
  }

  const startPoll = (sessionId: string): void => {
    stopPoll()
    const started = Date.now()
    pollRef.current = timer!.interval(async () => {
      if (pollBusyRef.current) return
      if (Date.now() - started > 30000) {
        disarm()
        depthRef.current = 0
        setActive(false)
        return
      }
      pollBusyRef.current = true
      try {
        const r = await api.take()
        if (r && Array.isArray(r.pending) && r.pending.length) {
          disarm()
          depthRef.current = 0
          setActive(false)
          const paths: string[] = r.pending.map((p: unknown) => String(p))
          const input = inputFaceFor(sessionId)
          if (!input) {
            flash('输入框尚未就绪，请重试拖拽')
            return
          }
          const draft = input.state ? input.state.getSnapshot().draft : ''
          const joined = paths.join('\n')
          input.setDraft(draft ? draft.replace(/[ \t]+\n?$/, '') + '\n' + joined : joined)
          flash('已写入 ' + paths.length + ' 个路径')
        } else if (r && r.cancelled) {
          disarm()
          depthRef.current = 0
          setActive(false)
        } else if (r && r.armed) {
          // 拦截窗工作中：保持/恢复“等待拖拽”提示层
          setActive(true)
        }
      } catch { /* 瞬时错误忽略 */ } finally {
        pollBusyRef.current = false
      }
    }, 120)
  }

  const armHelper = (): void => {
    if (armedRef.current || armingRef.current) return
    const sid = resolveCurrent()
    currentRef.current = sid
    if (!sid) return
    armingRef.current = true
    api.arm(sid).then((r) => {
      armingRef.current = false
      if (r && r.armed) {
        armedRef.current = true
        startPoll(sid)
      }
    }).catch(() => {
      armingRef.current = false
    })
  }

  React.useEffect(() => () => {
    if (timerRef.current) {
      try { timerRef.current() } catch { /* ignore */ }
    }
    disarm()
  }, [])

  const handleDrop = async (e: DragEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    disarm()
    depthRef.current = 0
    setActive(false)
    const dt = e.dataTransfer
    if (!dt) return
    const items = collectTopItems(dt)
    if (!items.length) return
    const sid = resolveCurrent()
    currentRef.current = sid
    if (!sid) {
      flash('请先打开一个会话，再把文件拖进来 [cur=' + String(resolveCurrent()) + ' bridge=' + String(lastBridgeSession) + ']')
      return
    }
    const input = inputFaceFor(sid)
    if (!input) {
      flash('输入框尚未就绪，请稍后再试')
      return
    }
    setBusy(true)
    try {
      const plan: Array<{ seq: number; itemIdx: number; relPath: string; top: string; isDir: boolean; file: File }> = []
      const earlySkips: Array<{ relPath: string; reason: string }> = []
      let totalBytes = 0
      for (let itemIdx = 0; itemIdx < items.length; itemIdx += 1) {
        const item = items[itemIdx]
        const files = await flattenTopItem(item)
        if (!files.length) continue
        const isDir = !!(item.entry && item.entry.isDirectory)
        const top = item.entry ? item.entry.name : item.name!
        for (const f of files) {
          if (f.file.size > MAX_BYTES) {
            earlySkips.push({ relPath: f.relPath, reason: '超过 ' + MAX_MB + 'MB' })
            continue
          }
          totalBytes += f.file.size
          if (totalBytes > MAX_TOTAL_BYTES) {
            earlySkips.push({ relPath: f.relPath, reason: '总大小超过 50MB' })
            continue
          }
          plan.push({ seq: plan.length, itemIdx, relPath: f.relPath, top, isDir, file: f.file })
        }
      }
      if (!plan.length) {
        flash('没有可写入的文件')
        return
      }
      const payload = await Promise.all(plan.map(async (p) => ({
        seq: p.seq,
        name: p.file.name,
        relPath: p.relPath,
        top: p.top,
        isDir: p.isDir,
        data: await fileToBase64(p.file),
      })))
      const res = await api.ingest(sid, payload)
      const written: Array<{ seq: number; path: string; rootPath: string }> = res && Array.isArray(res.written) ? res.written : []
      const skipped: Array<{ seq: number; relPath: string; reason: string }> = res && Array.isArray(res.skipped) ? res.skipped : []
      const bySeq = new Map<number, { seq: number; path: string; rootPath: string }>()
      for (const w of written) bySeq.set(w.seq, w)
      const pasted: string[] = []
      for (let i = 0; i < items.length; i += 1) {
        const entries = plan.filter((p) => p.itemIdx === i)
        if (!entries.length) continue
        const isDir = entries[0].isDir
        const paths: Array<{ seq: number; path: string; rootPath: string }> = []
        for (const p of entries) {
          const w = bySeq.get(p.seq)
          if (w && typeof w.path === 'string') paths.push(w)
        }
        if (!paths.length) continue
        if (isDir) pasted.push(paths[0].rootPath || paths[0].path)
        else pasted.push(paths[0].path)
      }
      const skipCount = earlySkips.length + skipped.length
      if (pasted.length) {
        const draft = input.state ? input.state.getSnapshot().draft : ''
        const joined = pasted.join('\n')
        input.setDraft(draft ? draft.replace(/[ \t]+\n?$/, '') + '\n' + joined : joined)
        flash('已将 ' + written.length + ' 个文件写入' + (pasted.length > 1 ? ' ' + pasted.length + ' 个路径' : '输入框') + (skipCount ? '，跳过 ' + skipCount + ' 个' : ''))
      } else {
        const first = skipped[0] || earlySkips[0]
        flash('没有可写入的文件' + (first ? '（' + first.relPath + ': ' + first.reason + '）' : ''))
      }
    } catch (err) {
      flash('拖放失败: ' + String((err as Error)?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  React.useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => {
      const types = e.dataTransfer && e.dataTransfer.types
      return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1
    }
    const onDragEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      if (allFileItemsAreImages(e)) return
      e.preventDefault()
      e.stopPropagation()
      depthRef.current += 1
      setActive(true)
      armHelper()
    }
    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      if (allFileItemsAreImages(e)) {
        depthRef.current = 0
        setActive(false)
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      if (allFileItemsAreImages(e)) return
      // arm 进行中或拦截窗已接管时不隐藏提示层
      if (armedRef.current || armingRef.current) return
      e.stopPropagation()
      depthRef.current = Math.max(0, depthRef.current - 1)
      if (depthRef.current === 0) setActive(false)
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      if (allDroppedAreImages(e)) {
        disarm()
        depthRef.current = 0
        setActive(false)
        return
      }
      void handleDrop(e)
    }
    window.addEventListener('dragenter', onDragEnter, true)
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('dragleave', onDragLeave, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragenter', onDragEnter, true)
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('dragleave', onDragLeave, true)
      window.removeEventListener('drop', onDrop, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 2147483000,
    pointerEvents: 'none',
    display: active ? 'block' : 'none',
    background: 'rgba(80, 120, 255, 0.12)',
    outline: '3px dashed rgba(80, 120, 255, 0.8)',
    outlineOffset: '-12px',
  }
  const hintStyle: React.CSSProperties = {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    padding: '16px 28px',
    borderRadius: 12,
    background: 'rgba(30, 30, 40, 0.92)',
    color: '#fff',
    fontSize: 16,
    fontWeight: 600,
    boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
  }
  const pillStyle: React.CSSProperties = {
    position: 'fixed',
    top: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 2147483001,
    pointerEvents: 'none',
    padding: '8px 16px',
    borderRadius: 999,
    background: 'rgba(30, 30, 40, 0.92)',
    color: '#fff',
    fontSize: 13,
    boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    maxWidth: '70vw',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }
  const busyStyle: React.CSSProperties = { ...pillStyle, color: '#ffd166' }

  return React.createElement(React.Fragment, null,
    React.createElement('div', { style: overlayStyle },
      React.createElement('div', { style: hintStyle }, '松开鼠标，将文件路径写入输入框')),
    busy
      ? React.createElement('div', { style: busyStyle }, '正在接收文件…')
      : notice
        ? React.createElement('div', { style: pillStyle }, String(notice))
        : null,
  )
}

export function apply(ctx: ClientContext): void {
  // 组件内直接取服务（生态标准做法）；timer 同时暴露给组件
  clientCtx = ctx
  ;(window as any).__dshFileDropTimer = ctx.timer

  // 命令菜单"选择文件"（输入框左下角 +）
  registerFileSource(ctx)

  ctx.effect(() => ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'file-drop-zone' }, DropOverlay),
  ), 'dsh-file-drop: overlay')

  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({ name: 'conversation.input.dock', id: 'file-drop-bridge' }, DropBridge),
  ), 'dsh-file-drop: bridge')
}
