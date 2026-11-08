import assert from "node:assert/strict"
import test from "node:test"
import { CCXPlugin } from "./index.mjs"

// 假登录：模拟用户在窗口里登录成功后返回
const fakeSignIn = (calls) => async (auth) => {
  calls.push(auth)
  return { username: `账号${calls.length}`, balance: 1, profile: auth.profileId }
}

test("浏览器登录会带上 API Key，并各用一个新 profile", async () => {
  const calls = []
  const plugin = await CCXPlugin({}, { signIn: fakeSignIn(calls) })
  const method = plugin.auth.methods[0]

  const a = method.authorize({ apiKey: "sk-aaa" })
  const ra = await a.callback()

  const b = method.authorize({ apiKey: "sk-bbb" })
  const rb = await b.callback()

  assert.equal(ra.type, "success")
  assert.equal(ra.apiKey, "sk-aaa", "浏览器登录里填的 API Key 必须保存")
  assert.equal(rb.apiKey, "sk-bbb")
  assert.notEqual(ra.profileId, rb.profileId, "两个账号必须用不同的浏览器 profile")
  assert.match(ra.profileId, /ccx-browser\//, "profileId 是 profile 目录路径")
  assert.notEqual(ra.accountId, rb.accountId, "两个账号不能是同一个")
})

test("浏览器登录不填 Key 也能成功（之后可补）", async () => {
  const plugin = await CCXPlugin({}, { signIn: fakeSignIn([]) })
  const r = await plugin.auth.methods[0].authorize({}).callback()
  assert.equal(r.type, "success")
  assert.equal(r.apiKey, "")
})

test("只填 API Key 的方法返回 key", async () => {
  const plugin = await CCXPlugin({}, { signIn: fakeSignIn([]) })
  const method = plugin.auth.methods.find((m) => m.type === "api")
  const r = await method.authorize({ apiKey: "sk-only" })
  assert.equal(r.type, "success")
  assert.equal(r.key, "sk-only")
})

test("没填 Key 时报错而不是静默成功", async () => {
  const plugin = await CCXPlugin({}, { signIn: fakeSignIn([]) })
  const method = plugin.auth.methods.find((m) => m.type === "api")
  const r = await method.authorize({ apiKey: "  " })
  assert.equal(r.type, "failed")
})

test("provider 配置有三个官方地址可用", async () => {
  const plugin = await CCXPlugin({}, { signIn: fakeSignIn([]) })
  const cfg = { provider: {} }
  await plugin.config(cfg)
  const p = cfg.provider.ccx
  assert.equal(p.api, "https://ccx.autobits.cc/v1")
  assert.equal(p.name, "AutoBits AI Hub")
})
test("登录会问 Base URL，并保存进账号", async () => {
  const calls = []
  const plugin = await CCXPlugin({}, { signIn: async (a) => { calls.push(a); return { username: "u", email: "e@x", balance: 1, profile: a.profileId } } })
  const m = plugin.auth.methods[0]
  assert.equal((await m.ask({}))?.key, "baseURL", "第一问问地址")
  assert.equal((await m.ask({ baseURL: "" }))?.key, "apiKey", "第二问问 Key")
  const r = await m.authorize({ baseURL: "https://ccx.autobits.cc/v1", apiKey: "sk-x", profile: "" }).callback()
  assert.equal(r.baseURL, "https://ccx.autobits.cc/v1")
  assert.equal(calls[0].baseURL, "https://ccx.autobits.cc/v1")
})

test("地址留空用官方地址", async () => {
  const plugin = await CCXPlugin({}, { signIn: async (a) => ({ username: "u", email: "e@x", balance: 1, profile: a.profileId }) })
  const r = await plugin.auth.methods[0].authorize({ baseURL: "", apiKey: "", profile: "" }).callback()
  assert.equal(r.baseURL, "https://ccx.autobits.cc/v1")
})

test("只填 Key 的方法也要地址", async () => {
  const plugin = await CCXPlugin({}, { signIn: async () => ({}) })
  const m = plugin.auth.methods.find((x) => x.type === "api")
  assert.equal(m.prompts[0].key, "baseURL")
  const r = await m.authorize({ baseURL: "https://relay.example/v1", apiKey: "sk-y" })
  assert.equal(r.metadata.baseURL, "https://relay.example/v1")
})
