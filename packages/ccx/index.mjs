import { randomUUID } from "node:crypto"
import { readUsage, signIn, checkin, listModels, freshProfile } from "./lib/session.mjs"

const ID = "ccx"
const NAME = "AutoBits AI Hub"
// 官方文档给的三个地址：OpenAI 兼容在 /v1，Claude 在根路径，Gemini 在 /v1beta
const OPENAI_BASE = "https://ccx.autobits.cc/v1"
const ANTHROPIC_BASE = "https://ccx.autobits.cc"
const GEMINI_BASE = "https://ccx.autobits.cc/v1beta"

export function fingerprint(auth) {
  return auth?.profileId ?? auth?.apiKey ?? auth?.access ?? auth?.key ?? randomUUID()
}

export async function CCXPlugin({ client } = {}, options = {}) {
  // 测试时可注入一个假的登录函数（真机永远用 signIn）
  const doSignIn = typeof options.signIn === "function" ? options.signIn : signIn

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[ID] ??= {}
      Object.assign(cfg.provider[ID], {
        name: NAME,
        npm: "@ai-sdk/openai-compatible",
        api: OPENAI_BASE,
        models: cfg.provider[ID].models ?? {},
      })
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
            const id = row.id
            // Claude 模型走 Anthropic 协议，其余走 OpenAI 兼容
            const anthropic = /claude|sonnet|opus|haiku/i.test(id)
            const npm = anthropic ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible"
            const url = anthropic ? ANTHROPIC_BASE : OPENAI_BASE
            const model = { name: row.name || id, api: { id, npm, url } }
            if (row.context) model.limit = { context: Number(row.context) }
            if (row.output) model.limit = { ...(model.limit ?? {}), output: Number(row.output) }
            if (row.modalities) model.modalities = row.modalities
            out[id] = model
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
          type: "oauth",
          label: "浏览器登录（推荐：余额 + 签到 + 填 Key）",
          prompts: [
            {
              type: "password",
              key: "apiKey",
              required: false,
              message: "AutoBits 的 API Key（调模型用；可留空，登录后再填）",
              placeholder: "sk-...",
            },
          ],
          authorize(inputs) {
            // 每次都开一个新的浏览器窗口，让用户登录要新增的那个账号。
            // 绝不复用已有 profile —— 那会把新账号登成第一个号。
            const profile = freshProfile()
            const apiKey = String(inputs?.apiKey ?? "").trim()
            const auth = { type: "oauth", profileId: profile, apiKey }
            const pending = doSignIn(auth, { ...options })
              .then((info) => ({ ok: true, info }))
              .catch((e) => ({ ok: false, error: e?.message ?? String(e) }))
            return {
              url: "",
              opened: true,
              method: "auto",
              instructions: "登录窗口会打开，请在窗口里登录要添加的 AutoBits 账号。登录成功后窗口自动关闭。",
              async callback() {
                const r = await pending
                if (!r.ok) return { type: "failed", error: r.error }
                const realId = r.info.profile ?? profile
                return {
                  type: "success",
                  access: apiKey,
                  refresh: "",
                  expires: 0,
                  apiKey,
                  profileId: realId,
                  accountId: r.info.username || `ccx-${realId}`,
                  username: r.info.username || "AutoBits 账号",
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "只填 API Key（不读余额、不签到）",
          prompts: [
            { type: "password", key: "apiKey", message: "AutoBits 的 LLM API Key", placeholder: "sk-..." },
          ],
          async authorize(inputs) {
            const key = String(inputs?.apiKey ?? "").trim()
            if (!key) return { type: "failed", error: "请输入 API Key" }
            return { type: "success", key }
          },
        },
        {
          type: "oauth",
          label: "只浏览器登录（不调模型）",
          prompts: [],
          authorize() {
            const profile = freshProfile()
            const auth = { type: "oauth", profileId: profile }
            const pending = doSignIn(auth, { ...options })
              .then((info) => ({ ok: true, info }))
              .catch((e) => ({ ok: false, error: e?.message ?? String(e) }))
            return {
              url: "",
              opened: true,
              method: "auto",
              instructions: "登录窗口会打开，请登录要添加的 AutoBits 账号。",
              async callback() {
                const r = await pending
                if (!r.ok) return { type: "failed", error: r.error }
                const realId = r.info.profile ?? profile
                return {
                  type: "success",
                  access: "",
                  refresh: "",
                  expires: 0,
                  apiKey: "",
                  profileId: realId,
                  accountId: r.info.username || `ccx-${realId}`,
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
        // 默认 OpenAI 兼容地址；Claude 模型在 models 里已各自指定 url
        return { baseURL: OPENAI_BASE, apiKey: key }
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
