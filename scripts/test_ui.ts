/**
 * UI 冒烟（T8）：真实浏览器验收。
 *
 * 规则（诚实优先）：
 * - 无 Playwright / 无浏览器 / 无目标地址 → 明确打印 SKIPPED 与原因，退出 0，
 *   绝不拿构建或离线测试冒充「UI 验收通过」。
 * - 有浏览器且设置了 DSH_UI_URL → 真跑冒烟（首页加载→研究/档案导航→会话选择器键盘交互），
 *   失败退出 1。
 *
 * 用法：DSH_UI_URL=http://<面板地址> npm run test:ui
 */
import { mkdir } from 'node:fs/promises'

const TARGET = process.env.DSH_UI_URL ?? ''
const SHOT_DIR = process.env.DSH_UI_SHOTS ?? 'data/ui-shots'

function skip(reason: string): never {
  console.log(`SKIPPED: UI 冒烟未执行 — ${reason}`)
  console.log('说明：本环境未提供真实浏览器验收，不能以构建/离线测试替代 UI 验收。')
  process.exit(0)
}

if (!TARGET) skip('未设置 DSH_UI_URL（面板地址）')

type PlaywrightModule = typeof import('playwright')
let pw: PlaywrightModule
try {
  pw = await import('playwright')
} catch {
  skip('未安装 playwright（npm i -D playwright 且 npx playwright install 后可真实执行）')
}

let browser: import('playwright').Browser
try {
  browser = await pw.chromium.launch({ headless: true })
} catch (err) {
  skip(`浏览器启动失败：${err instanceof Error ? err.message : String(err)}`)
}

const results: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await mkdir(SHOT_DIR, { recursive: true })

  // 1) 面板可加载
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 15_000 })
  await page.waitForSelector('body', { timeout: 5_000 })
  await page.screenshot({ path: `${SHOT_DIR}/smoke-home.png` })
  results.push('面板加载 + 截图 smoke-home.png')

  // 2) 当前任务导航可切换到研究区，并打开资料档案。
  const nav = page.getByRole('navigation', { name: '金融面板导航' })
  await nav.getByRole('button', { name: '研究', exact: true }).click({ timeout: 5_000 })
  await nav.getByRole('button', { name: '档案', exact: true }).click({ timeout: 5_000 })
  await page.waitForTimeout(300)
  results.push('任务导航可切换：首页 → 研究 → 档案')
  await page.screenshot({ path: `${SHOT_DIR}/smoke-dossier.png` })

  // 3) 会话选择默认收起，打开时直接显示可搜索的目标列表，Esc 可收起。
  const picker = page.locator('details').filter({ hasText: 'Agent 投递目标' }).first()
  const summary = picker.locator('summary')
  if (await picker.evaluate((el) => (el as HTMLDetailsElement).open)) throw new Error('会话选择器应默认收起')
  await summary.click({ timeout: 5_000 })
  await page.getByPlaceholder('按标题 / ID / 目录搜索…').waitFor({ state: 'visible', timeout: 5_000 })
  await page.keyboard.press('Escape')
  await page.getByPlaceholder('按标题 / ID / 目录搜索…').waitFor({ state: 'hidden', timeout: 5_000 })
  if (!(await summary.evaluate((el) => el === document.activeElement))) throw new Error('关闭会话选择器后焦点应返回标题')
  results.push('任务会话选择器：默认收起、单击展开、Esc 收起并恢复焦点')

  console.log('PASS: UI 冒烟通过')
  for (const r of results) console.log(`  - ${r}`)
  await browser.close()
  process.exit(0)
} catch (err) {
  await browser.close().catch(() => {})
  console.log(`FAIL: UI 冒烟失败 — ${err instanceof Error ? err.message : String(err)}`)
  for (const r of results) console.log(`  - ${r}`)
  process.exit(1)
}
