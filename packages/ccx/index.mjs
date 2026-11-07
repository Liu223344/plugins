import { randomUUID } from "node:crypto"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { readUsage, signIn, checkin, listModels } from "./lib/session.mjs"

const ID = "ccx"
const NAME = "AutoBits AI Hub"
const API_BASE = "https://ccx.autobits.cc/v1"

// 调试日志：写进 Magpie 的日志目录，方便排查
function trace(what, detail) {
  try {
    const line = `[${new Date().toISOString()}] ${what}: ${detail}\n`
    appendFileSync(join(homedir(), "Library", "Logs", "magpie", "ccx.log"), line)
  } catch {}
  try { console.error(`ccx ${what}: ${detail}`) } catch {}
}

export function fingerprint(auth) {
  return auth?.profileId ?? auth?.apiKey ?? auth?.access ?? auth?.key ?? randomUUID()
}

export async function CCXPlugin({ client } = {}, options = {}) {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[ID] ??= {}
      Object.assign(cfg.provider[ID], { name: NAME, npm: "@ai-sdk/openai-compatible", api: API_BASE, models: cfg.provider[ID].models ?? {} })
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const key = auth?.apiKey ?? auth?.access ?? auth?.key
        if (!key) return provider?.models ?? {}
        try {
          const rows = await listModels(key)
          const out = { ...(provider?.models ?? {}) }
          for (const row of rows) {
            out[row.id] = { name: row.name, api: { id: row.id, npm: "@ai-sdk/openai-compatible", url: API_BASE } }
          }
          return out
        } catch (e) {
          trace("models failed", e?.message ?? String(e))
          return provider?.models ?? {}
        }
      },
    },
    auth: {
      provider: ID,
      methods: [
        {
          type: "api",
          label: "API Key",
          // 声明 prompts 时，key 由用户填在表单里，经 inputs 传进来；
          // 不声明时，Magpie 把 key 作为独立参数传给 authorize 的第二个参数。
          // 这里声明 prompts，保证 key 一定在 inputs 里。
          prompts: [
            { type: "password", key: "apiKey", message: "AutoBits 的 LLM API Key", placeholder: "sk-..." },
          ],
          async authorize(inputs, extra) {
            trace("api authorize called", JSON.stringify({ keys: Object.keys(inputs ?? {}), extra: Object.keys(extra ?? {}) }))
            const key = String(inputs?.apiKey ?? extra?.key ?? "").trim()
            if (!key) {
              trace("api authorize", "no key")
              return { type: "failed", error: "请输入 API Key" }
            }
            trace("api authorize ok", `len=${key.length}`)
            return { type: "success", key }
          },
        },
        {
          type: "oauth",
          label: "浏览器登录",
          prompts: [],
          authorize() {
            trace("oauth authorize called", "")
            const profileId = fingerprint({ apiKey: randomUUID() })
            const auth = { type: "oauth", profileId }

            // 登录在后台跑：authorize 立刻返回（Magpie 只等它几秒），
            // 浏览器窗口由这里的 promise 打开，callback 只等结果。
            const pending = signIn(auth, { ...options })
              .then((info) => ({ ok: true, info }))
              .catch((e) => ({ ok: false, error: e?.message ?? String(e) }))

            return {
              url: "",
              opened: true,
              method: "auto",
              instructions: "登录窗口会自己打开。请完成登录（密码、验证码或通行密钥），完成后自动结束。",
              async callback(_code, { signal } = {}) {
                trace("oauth callback wait", profileId)
                const r = await pending
                if (!r.ok) {
                  trace("oauth callback failed", r.error)
                  return { type: "failed", error: r.error }
                }
                trace("oauth callback ok", r.info.username ?? "")
                return {
                  type: "success",
                  access: "",
                  refresh: "",
                  expires: 0,
                  apiKey: "",
                  profileId,
                  accountId: r.info.username || `ccx-${profileId}`,
                  username: r.info.username || "AutoBits 账号",
                }
              },
            }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        const key = auth?.apiKey ?? auth?.access ?? auth?.key
        trace("loader", key ? `key len=${String(key).length}` : "no key")
        return { baseURL: API_BASE, apiKey: key }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        trace("usage called", auth ? "have auth" : "no auth")
        try { return await readUsage(auth, options) } catch (e) {
          trace("usage failed", e?.message ?? String(e))
          return { error: e?.message ?? String(e), signIn: "kept" }
        }
      },
      async checkin(getAuth) {
        const auth = await getAuth()
        trace("checkin called", auth ? "have auth" : "no auth")
        try { return await checkin(auth, options) } catch (e) {
          trace("checkin failed", e?.message ?? String(e))
          return { outcome: "failed", message: e?.message ?? String(e) }
        }
      },
    },
  }
}
