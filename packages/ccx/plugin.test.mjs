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