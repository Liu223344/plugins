import { randomUUID } from "node:crypto"
import { readUsage, signIn, checkin, listModels, freshProfile, existingProfiles } from "./lib/session.mjs"

const ID = "ccx"
const NAME = "AutoBits AI Hub"
// 官方文档给的三个地址：OpenAI 兼容在 /v1，Claude 在根路径，Gemini 在 /v1beta
const OPENAI_BASE = "https://ccx.autobits.cc/v1"
const ANTHROPIC_BASE = "https://ccx.autobits.cc"
const GEMINI_BASE = "https://ccx.autobits.cc/v1beta"
const DEFAULT_BASE = OPENAI_BASE

// 账号里存的 Base URL（用户自己填的）。空的话用官方地址。
const baseOf = (auth) => {
  const b = String(auth?.baseURL ?? auth?.baseUrl ?? auth?.metadata?.baseURL ?? "").trim()
  return b || DEFAULT_BASE
}
// 用户填的通常是 OpenAI 兼容地址（…/v1）。Claude 用去掉 /v1 的根路径。
const stripV1 = (b) => b.replace(/\/+$/, "").replace(/\/v1(beta)?$/, "")
const openaiBaseOf = (b) => {
  const s = b.replace(/\/+$/, "")
  return /\/v1$/.test(s) ? s : `${stripV1(s)}/v1`
}
const anthropicBaseOf = (b) => stripV1(b)

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
          // 用账号里存的 Base URL 拉模型（用户自己填的中转站地址）
          const base = baseOf(auth)
          const rows = await listModels(key, base)
          const out = { ...(provider?.models ?? {}) }
          for (const row of rows) {
            const id = row.id
            // Claude 模型走 Anthropic 协议（根路径），其余走 OpenAI 兼容（/v1）
            const anthropic = /claude|sonnet|opus|haiku/i.test(id)
            const npm = anthropic ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible"
            const url = anthropic ? anthropicBaseOf(base) : openaiBaseOf(base)
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
          label: "浏览器登录（余额 + 签到 + 模型）",
          // 必须非空：Magpie 的宿主在 prompts 为空时会把用户填的答案整个丢掉
          // （host.js: m.prompts?.length ? inputs : undefined）
          prompts: [
            { type: "text", key: "baseURL", message: "API 请求地址（OpenAI 兼容）", placeholder: DEFAULT_BASE },
            { type: "password", key: "apiKey", required: false, message: "API Key（可留空）", placeholder: "sk-..." },
          ],
          // 动态问两个问题：
          // 1. API Key（可留空，但留空就不能调模型）
          // 2. 复用哪个已登录的浏览器；选「开新窗口」才需要重新登录
          async ask(inputs = {}) {
            if (!("baseURL" in inputs)) {
              return {
                type: "text",
                key: "baseURL",
                message: "API 请求地址（OpenAI 兼容）",
                placeholder: DEFAULT_BASE,
              }
            }
            if (!("apiKey" in inputs)) {
              return {
                type: "password",
                key: "apiKey",
                message: "AutoBits 的 API Key（调模型用；留空则只能读余额和签到）",
                placeholder: "sk-...",
              }
            }
            if (!("profile" in inputs)) {
              const opts = existingProfiles().map((p) => ({ value: p.path, label: p.label }))
              return {
                type: "select",
                key: "profile",
                message: opts.length
                  ? "用哪个浏览器登录？（已登录的直接选，不用重新输密码）"
                  : "用哪个浏览器登录？",
                options: [...opts, { value: "", label: "开新窗口登录新账号" }],
              }
            }
            return null
          },
          async authorize(inputs) {
            // 前面的提问（ask）已经把答案攒进 inputs；这里再兜一层，
            // 万一宿主没传，就当作空值（baseURL 用默认地址）。
            const apiKey = String(inputs?.apiKey ?? "").trim()
            const baseURL = String(inputs?.baseURL ?? "").trim() || DEFAULT_BASE
            const reuse = String(inputs?.profile ?? "").trim()
            const profile = reuse || freshProfile()
            const auth = { type: "oauth", profileId: profile, apiKey, baseURL, reuseProfile: reuse || undefined }
            const pending = doSignIn(auth, { ...options })
              .then((info) => ({ ok: true, info }))
              .catch((e) => ({ ok: false, error: e?.message ?? String(e) }))
            return {
              url: "",
              opened: true,
              method: "auto",
              instructions: reuse
                ? "正在用你选的浏览器读取登录状态，几秒就好。"
                : "登录窗口会打开，请在窗口里登录要添加的 AutoBits 账号。",
              async callback() {
                const r = await pending
                if (!r.ok) return { type: "failed", error: r.error }
                const realId = r.info.profile ?? profile
                const who = r.info.email || r.info.username || realId
                return {
                  type: "success",
                  access: apiKey,
                  refresh: "",
                  expires: 0,
                  apiKey,
                  baseURL,
                  profileId: realId,
                  accountId: who,
                  username: r.info.username || r.info.email || "AutoBits 账号",
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "只填地址和 Key（只调模型）",
          prompts: [
            { type: "text", key: "baseURL", message: "API 请求地址（OpenAI 兼容）", placeholder: DEFAULT_BASE },
            { type: "password", key: "apiKey", message: "AutoBits 的 LLM API Key", placeholder: "sk-..." },
          ],
          async authorize(inputs) {
            const key = String(inputs?.apiKey ?? "").trim()
            const baseURL = String(inputs?.baseURL ?? "").trim() || DEFAULT_BASE
            if (!key) return { type: "failed", error: "请输入 API Key" }
            // api 方法把答案放进 metadata，账号里就带着地址
            return { type: "success", key, metadata: { apiKey: key, baseURL } }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        const key = auth?.apiKey ?? auth?.access ?? auth?.key
        // 用账号里存的地址；Claude 模型在 models 里已各自指定 url
        return { baseURL: openaiBaseOf(baseOf(auth)), apiKey: key }
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
