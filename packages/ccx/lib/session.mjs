import { createHash } from "node:crypto"
import { access, mkdir, rename, writeFile } from "node:fs/promises"
import { existsSync, readdirSync, readFileSync } from "node:fs"
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

// 新增账号时用一个全新的浏览器 profile，绝不复用别的账号的登录状态。
export function freshProfile() {
  const dir = join(configRoot(), "magpie", "ccx-browser", `acct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  return dir
}

// 已经登录过的浏览器（供「复用已有登录」选择），带可读的名字。
// 只列确认登录成功的：原来那个工具的 4 个账号，或插件建过且写下了账号信息的。
export function existingProfiles() {
  const out = []
  const legacyRoot = join(home(), "ccx-checkin", "profiles")
  try {
    for (const name of readdirSync(legacyRoot)) {
      const p = join(legacyRoot, name)
      if (existsSync(join(p, "Default"))) out.push({ path: p, label: name })
    }
  } catch {}
  const ownRoot = join(configRoot(), "magpie", "ccx-browser")
  try {
    for (const name of readdirSync(ownRoot)) {
      const p = join(ownRoot, name)
      if (!existsSync(join(p, "Default"))) continue
      let a = null
      try { a = JSON.parse(readFileSync(join(p, "account.json"), "utf8")) } catch {}
      // 只认写下了邮箱的（真正的登录）；「AutoBits 账号」是旧版本留下的空记录
      if (a?.email) out.push({ path: p, label: a.email })
    }
  } catch {}
  return out
}

export function profileOf(auth) {
  if (process.env.CCX_BROWSER_ROOT) return join(resolve(process.env.CCX_BROWSER_ROOT), fingerprint(auth))
  const pid = auth?.profileId
  // 浏览器登录的账号，profileId 就是它的 profile 目录（新建时可能还不存在）
  if (typeof pid === "string" && pid.startsWith("/")) return pid
  // 复用独立签到工具已有的登录状态（~/ccx-checkin/profiles/<账号名>）
  const name = String(pid ?? auth?.username ?? "").trim()
  if (name && !name.includes("/")) {
    const legacy = join(home(), "ccx-checkin", "profiles", name)
    if (existsSync(join(legacy, "Default"))) return legacy
  }
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

// 登录：
// - auth.reuseProfile 给了路径 → 复用那个已登录的浏览器（无窗口，几秒完成）
// - 否则 → 开一个新的可见窗口，让用户登录要新增的账号
export async function signIn(auth, { browser, signal, timeoutMs = 8 * 60_000 } = {}) {
  const reuse = typeof auth?.reuseProfile === "string" && auth.reuseProfile
    ? auth.reuseProfile
    : null
  const profile = reuse ?? (auth?.profileId && String(auth.profileId).startsWith("/") && !existsSync(auth.profileId)
    ? auth.profileId
    : freshProfile())
  auth = { ...auth, profileId: profile }

  const session = await open(auth, { headless: Boolean(reuse), browser })
  try {
    const status = reuse
      ? await (async () => {
        await waitWalletReady(session.page, { timeoutMs: 30000 })
        const st = await readStatus(session.page, { timeoutMs: 20000 })
        if (st.status !== 200) throw new Error(st.unauthorized ? "这个浏览器里的登录已失效" : (st.error || "读取失败"))
        return st
      })()
      : await waitForSignIn(session.page, { signal, timeoutMs })
    const name = status.me?.user?.displayName ?? status.me?.user?.email ?? ""
    const email = status.me?.user?.email ?? ""
    await storeCredentials(auth, { username: name, email, balance: status.balance, profile })
    return { username: name, email, balance: status.balance, profile }
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
