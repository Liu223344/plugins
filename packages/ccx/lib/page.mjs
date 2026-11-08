export const SITE = "https://ccx.autobits.cc"
export const WALLET = `${SITE}/app/wallet`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 所有受保护接口都要带 X-CCH-Organization，它的值在 sessionStorage 里。
// 不带这个头会 403（网站前端会自己带上，直接 fetch 时必须自己加）。
// 这段在页面里执行，返回 {status, body}。
const fetchInPage = async (path, method = "GET") => {
  const headers = { Accept: "application/json" }
  try {
    const org = sessionStorage.getItem("cch:active-org-selection")
    if (org) headers["X-CCH-Organization"] = org
  } catch {}
  const res = await fetch(path, { method, credentials: "include", headers })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = { detail: text.slice(0, 300) } }
  return { status: res.status, body }
}

const tzPath = (base) =>
  `${base}?timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai")}`

// 等钱包页真正渲染出来。只认签到状态按钮，不能用「页面里有『每日签到』字样」
// 判断——侧边栏导航和充值记录里都有这几个字。
export async function waitWalletReady(page, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      for (const b of document.querySelectorAll("button,[role=button]")) {
        const t = (b.innerText || "").trim()
        if (t === "每日签到" || t.startsWith("今日已签")) return true
      }
      return location.pathname.includes("/login")
    }).catch(() => false)
    if (ready) return true
    await sleep(400)
  }
  return false
}

// 读余额和签到状态：走网站自己的接口，结构化、可靠
export async function readStatus(page, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    const r = await page.evaluate(async () => {
      const org = (() => { try { return sessionStorage.getItem("cch:active-org-selection") } catch { return null } })()
      const headers = { Accept: "application/json" }
      if (org) headers["X-CCH-Organization"] = org
      const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai")

      const wallet = await fetch("/api/account/wallet", { credentials: "include", headers })
      if (wallet.status === 401 || wallet.status === 403) return { unauthorized: true, status: wallet.status }
      if (!wallet.ok) return { status: wallet.status, error: `钱包读取失败 (${wallet.status})` }
      const walletBody = await wallet.json()

      const ck = await fetch(`/api/account/wallet/checkin?timezone=${tz}`, { credentials: "include", headers })
      const ckBody = ck.ok ? await ck.json() : null

      return { status: 200, balance: walletBody?.balanceUnits, checkin: ckBody }
    }).catch((e) => ({ error: String(e) }))
    if (r.status === 200 || r.unauthorized) return r
    last = r.error || ""
    await sleep(500)
  }
  return { error: last || "钱包读取超时" }
}

export async function waitForSignIn(page, { signal, timeoutMs = 8 * 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("登录已取消")
    const url = await page.url()
    if (url.includes("/app/") && !url.includes("/login")) {
      const ok = await waitWalletReady(page, { timeoutMs: 30000 })
      if (ok) {
        const status = await readStatus(page, { timeoutMs: 20000 })
        if (status.status === 200) return status
      }
    }
    await sleep(500)
  }
  throw new Error("登录超时，请重试")
}

// 签到：点页面上真正的签到按钮，让网站前端自己处理 CSRF proof。
// 直接 POST 会 403（invalid CSRF proof），必须走前端。
export async function claim(page) {
  // 先读状态
  const status = await readStatus(page, { timeoutMs: 30000 })
  if (status.unauthorized) return { outcome: "failed", message: "登录已失效，请重新登录" }
  if (status.status !== 200) return { outcome: "failed", message: status.error || "钱包读取失败" }
  const ck = status.checkin
  if (ck?.enabled === false) return { outcome: "inactive", message: "签到活动目前没有开放" }
  if (ck?.checkedInToday) return { outcome: "done", streak: ck.streakDays, credit: toDollars(ck.todayRewardUnits) }

  // 点页面上的「每日签到」按钮
  const clicked = await page.evaluate(() => {
    for (const b of document.querySelectorAll("button,[role=button]")) {
      if ((b.innerText || "").trim() === "每日签到") { b.click(); return true }
    }
    return false
  })
  if (!clicked) return { outcome: "failed", message: "页面上没有找到签到按钮" }

  // 等结果：轮询签到状态
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    await sleep(800)
    const text = await page.evaluate(() => document.body?.innerText ?? "")
    if (/签到成功|获得/.test(text)) {
      const after = await readStatus(page, { timeoutMs: 8000 })
      return {
        outcome: "claimed",
        credit: toDollars(after.checkin?.todayRewardUnits),
        streak: after.checkin?.streakDays,
      }
    }
    const after = await readStatus(page, { timeoutMs: 8000 })
    if (after.checkin?.checkedInToday) {
      return { outcome: "claimed", credit: toDollars(after.checkin.todayRewardUnits), streak: after.checkin.streakDays }
    }
  }
  return { outcome: "failed", message: "点了签到按钮，但没看到成功提示" }
}

// 网站的金额单位是 1e10 = 1 美元（balanceUnits 4291302175 → $0.429）
export const UNITS_PER_DOLLAR = 1e10
export const toDollars = (units) => {
  const n = Number(units)
  return Number.isFinite(n) ? n / UNITS_PER_DOLLAR : undefined
}
export const money = (units) => {
  const d = toDollars(units)
  return d === undefined ? "" : `$${d.toFixed(d >= 1 ? 2 : 4)}`
}

export function walletCard(status) {
  const c = status.checkin
  const balance = toDollars(status.balance)
  const signedToday = c?.checkedInToday === true
  return {
    plan: "钱包余额",
    ...(balance !== undefined ? { balance, unit: "$" } : {}),
    windows: [{
      name: "每日签到",
      used: signedToday ? 100 : 0,
      display: c?.enabled === false
        ? "签到未开放"
        : signedToday
          ? `今天已签 · 连签 ${c.streakDays ?? "?"} 天${c.todayRewardUnits ? ` · 获得 ${money(c.todayRewardUnits)}` : ""}`
          : "今天可签到",
      aside: true,
    }],
  }
}

// 模型列表：公开 API，用 API Key 即可，不需要浏览器
export async function listModels(key) {
  const r = await fetch(`${SITE}/v1/models`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } })
  if (!r.ok) return []
  const data = await r.json()
  return (data.data ?? data.models ?? []).map((m) => ({ id: m.id, name: m.id }))
}
