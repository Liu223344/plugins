import assert from "node:assert/strict"
import test from "node:test"
import { walletCard, toDollars, money } from "./lib/page.mjs"
import { profileOf, fingerprint, freshProfile } from "./lib/session.mjs"

test("金额单位是 1e10 = 1 美元", () => {
  assert.equal(money(4291302175), "$0.4291")
  assert.equal(money(25797695471), "$2.58")
  assert.equal(toDollars(10000000000), 1)
})

test("余额卡片不伪造签到成功", () => {
  const card = walletCard({ balance: 4291302175, checkin: { enabled: true, checkedInToday: false } })
  assert.equal(card.balance, 0.4291302175)
  assert.equal(card.unit, "$")
  assert.equal(card.windows[0].display, "今天可签到")
})

test("每个账号的浏览器配置独立", () => {
  assert.notEqual(fingerprint({ apiKey: "a" }), fingerprint({ apiKey: "b" }))
  assert.notEqual(profileOf({ apiKey: "a" }), profileOf({ apiKey: "b" }))
  assert.notEqual(freshProfile(), freshProfile())
})

test("账号名为空时不会落到 profiles 根目录", () => {
  const p = profileOf({})
  assert.match(p, /magpie\/ccx-browser\//)
})

test("浏览器登录的账号用它的 profile 路径", () => {
  assert.equal(profileOf({ profileId: "/tmp/ccx-some-profile" }), "/tmp/ccx-some-profile")
})