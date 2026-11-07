import { randomUUID } from "node:crypto"
import { readUsage, signIn, checkin, listModels } from "./lib/session.mjs"

const ID = "ccx"
const NAME = "AutoBits AI Hub"
const API_BASE = "https://ccx.autobits.cc/v1"

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
        } catch {
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
          prompts: [
            { type: "password", key: "apiKey", message: "AutoBits 的 LLM API Key", placeholder: "sk-..." },
          ],
          async authorize(inputs) {
            const key = String(inputs?.apiKey ?? "").trim()
            if (!key) return { type: "failed", error: "请输入 API Key" }
            // api 方法由 Magpie 存成 {type:"api", key}，这里只确认拿到 key
            return { type: "success", key }
          },
        },
        {
          type: "oauth",
          label: "浏览器登录",
          prompts: [],
          authorize() {
            const profileId = fingerprint({ apiKey: randomUUID() })
            const auth = { type: "oauth", profileId }
            // authorize 必须立刻返回（Magpie 只等几秒），登录在后台进行；
            // callback 等它结束。opened:true 表示插件自己开浏览器，
            // Magpie 不会再开一次（两个窗口会冲突）。
            const pending = signIn(auth, { ...options })
              .then((info) => ({ ok: true, info }))
              .catch((e) => ({ ok: false, error: e?.message ?? String(e) }))
            return {
              url: "",
              opened: true,
              method: "auto",
              instructions: "登录窗口会自己打开。请完成登录（密码、验证码或通行密钥），完成后自动结束。",
              async callback() {
                const r = await pending
                if (!r.ok) return { type: "failed", error: r.error }
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
        return { baseURL: API_BASE, apiKey: key }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        try { return await readUsage(auth, options) } catch (e) { return { error: e?.message ?? String(e), signIn: "kept" } }
      },
      async checkin(getAuth) {
        const auth = await getAuth()
        try { return await checkin(auth, options) } catch (e) { return { outcome: "failed", message: e?.message ?? String(e) } }
      },
    },
  }
}
