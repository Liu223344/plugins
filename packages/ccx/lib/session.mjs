import { createHash } from "node:crypto"
import { access, mkdir, rename, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { launch } from "./cdp.mjs"
import { take } from "./lock.mjs"
import { WALLET, readStatus, waitForSignIn, waitWalletReady, claim, walletCard, listModels } from "./page.mjs"

export const home = () => process.env.HOME || process.env.USERPROFILE || homedir()
export const configRoot = () => process.env.XDG_CONFIG_HOME || (process.platform === "win32" ? process.env.APPDATA : "") || join(home(), ".config")

// 每个账号一个独立的浏览器 profile，绝不共用（共用会串号）。
export function fingerprint(auth) {
  return createHash("sha256").update([
    auth?.profileId, auth?.apiKey, auth?.access, auth?.key, auth?.accountId, auth?.username,
  ].map((x) => String(x ?? "")).join("\0")).digest("hex").slice(0, 20)
}

export function profileOf(auth) {
  if (process.env.CCX_BROWSER_ROOT) return join(resolve(process.env.CCX_BROWSER_ROOT), fingerprint(auth))
  // 复用独立签到工具已有的登录状态（~/ccx-checkin/profiles/<账号名>）
  const legacy = join(home(), "ccx-checkin", "profiles", auth?.profileId ?? auth?.username ?? "")
  if (existsSync(legacy)) return legacy
  return join(configRoot(), "magpie", "ccx-browser", fingerprint(auth))
}

const lockOf = (profile) => join(configRoot(), "magpie", "ccx-browser-locks", createHash("sha256").update(profile).digest("hex"))

export async function requireBrowser(explicit) {
  const env = process.env
  const candidates = explicit ? [explicit] : env.CCX_BROWSER ? [env.CCX_BROWSER] : process.platform === "win32"
    ? [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean).flatMap((dir) => [
      join(dir, "Microsoft", "Edge", "Application", "msedge.exe"), join(dir, "Google", "Chrome", "Application", "chrome.exe"),
    ])
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
      : ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  for (const exe of candidates) {
    try { await access(exe); return exe } catch {}
  }
  throw new Error("需要 Microsoft Edge 或 Google Chrome。请先安装其中一个，再重新登录。")
}

const args = (profile, headless, url) => [
  `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
  "--disable-sync", "--disable-default-apps", "--disable-component-update",
  "--disable-domain-reliability", "--metrics-recording-only", "--no-service-autorun",
  ...(process.platform === "darwin" ? ["--use-mock-keychain"] : process.platform === "linux" ? ["--password-store=basic"] : []),
  "--window-size=1280,900",
  ...(headless ? ["--headless=new", "--disable-gpu"] : []),
  url,
]

async function open(auth, { headless = true, url = WALLET, browser } = {}) {
  const profile = profileOf(auth)
  await mkdir(profile, { recursive: true, mode: 0o700 })
  const release = await take(lockOf(profile))
  let started
  try {
    started = await launch(await requireBrowser(browser), args(profile, headless, url))
    const close = async () => { try { await started.browser.close() } finally { await release() } }
    return { ...started, profile, close }
  } catch (error) {
    await started?.browser.close().catch(() => {})
    await release()
    throw error
  }
}

export async function storeCredentials(auth, data) {
  const profile = profileOf(auth)
  await mkdir(profile, { recursive: true, mode: 0o700 })
  const file = join(profile, "account.json")
  const next = { ...data, savedAt: new Date().toISOString() }
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
  await rename(temp, file)
  return next
}

export async function signIn(auth, { browser, signal, timeoutMs = 8 * 60_000 } = {}) {
  const session = await open(auth, { headless: false, browser })
  try {
    const status = await waitForSignIn(session.page, { signal, timeoutMs })
    const name = status.me?.name ?? status.me?.username ?? status.me?.email ?? ""
    await storeCredentials(auth, { username: name, balance: status.balance })
    return { username: name, balance: status.balance }
  } finally { await session.close() }
}

export async function readUsage(auth, { browser } = {}) {
  const session = await open(auth, { browser })
  try {
    // 等页面真正加载完再读，否则会误判成「登录失效」
    await waitWalletReady(session.page, { timeoutMs: 45000 })
    const status = await readStatus(session.page)
    if (status.unauthorized) return { error: "登录已失效，请重新登录", signIn: "expired" }
    if (status.status !== 200) return { error: status.error || "钱包读取失败", signIn: "kept" }
    const card = walletCard(status)
    const name = status.me?.name ?? status.me?.username ?? status.me?.email ?? ""
    if (name) card.user = name
    card.signIn = "kept"
    return card
  } finally { await session.close() }
}

export async function checkin(auth, { browser } = {}) {
  const session = await open(auth, { browser })
  try {
    await waitWalletReady(session.page, { timeoutMs: 45000 })
    const result = await claim(session.page)
    if (result.outcome === "claimed") {
      await storeCredentials(auth, { lastCheckin: new Date().toISOString(), reward: result.credit, streak: result.streak })
    }
    return result
  } finally { await session.close() }
}

export { listModels }
