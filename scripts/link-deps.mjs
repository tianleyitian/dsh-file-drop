// Link build/type dependencies from the installed dsh npm package into this
// plugin's node_modules (junctions on Windows). Also ensures typescript /
// tsdown / @types are present (npm install --no-save when missing).
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'

const root = process.env.DSH_PLUGIN_ROOT ?? process.cwd()

function locateDshModules() {
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
    join(root, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, '@deepseek-ai', 'dsh-tools'))) return c
  }
  return null
}

const dsh = locateDshModules()
if (!dsh) {
  console.error('link-deps: cannot locate the installed dsh node_modules (looked in APPDATA npm + plugin node_modules)')
  process.exit(1)
}
console.log('link-deps: dsh modules root =', dsh)

// 确保构建工具与类型定义就位（缺省时静默安装）
const hasTsc = existsSync(join(root, 'node_modules', '.bin', 'tsc.cmd')) || existsSync(join(root, 'node_modules', '.bin', 'tsc'))
const hasTsdown = existsSync(join(root, 'node_modules', '.bin', 'tsdown.cmd')) || existsSync(join(root, 'node_modules', '.bin', 'tsdown'))
if (!hasTsc || !hasTsdown || !existsSync(join(root, 'node_modules', '@types', 'react', 'index.d.ts'))) {
  console.log('link-deps: installing typescript/tsdown/@types via npm (--no-save --legacy-peer-deps)...')
  execSync(
    'npm install --no-save --legacy-peer-deps typescript@6.0.3 tsdown@^0.22.14 @types/node@^22.0.0 @types/react@^18.3.1',
    { cwd: root, stdio: 'inherit' },
  )
}

// 链接类型依赖：优先已安装 dsh 的编译包；@deepseek-ai/cordis 同时以
// 顶层 cordis 名字链接（host 代码 import 'cordis'）。
const deps = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/schemastery',
]
mkdirSync(join(root, 'node_modules', '@deepseek-ai'), { recursive: true })
for (const name of deps) {
  const src = join(dsh, name)
  if (!existsSync(src)) {
    console.warn('link-deps: skip missing dep:', name)
    continue
  }
  const link = join(root, 'node_modules', ...name.split('/'))
  rmSync(link, { recursive: true, force: true })
  symlinkSync(src, link, platform() === 'win32' ? 'junction' : 'dir')
}
// 顶层别名：cordis / cosmokit / schemastery（宿主与 cordis 类型解析）
for (const name of ['cordis', 'cosmokit', 'schemastery']) {
  const scoped = join(dsh, '@deepseek-ai', name)
  if (!existsSync(scoped)) continue
  const link = join(root, 'node_modules', name)
  rmSync(link, { recursive: true, force: true })
  symlinkSync(scoped, link, platform() === 'win32' ? 'junction' : 'dir')
}
console.log('link-deps: done')
