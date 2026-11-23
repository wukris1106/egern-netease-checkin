// 网易云音乐签到 · Egern 脚本 v18 (2026-11-24)
// 三个签到目标：积分/经验、云贝、VIP 成长值（黑胶乐签）
// v18 修复：/api/nuser/account/get 的账号信息在 **顶层** profile/account（不在 data 里），
//           v17 判的是 info.data.profile → 永远为假 → 每天把有效 Cookie 当失效删掉，
//           所以才会一直收到「Cookie 已过期，已清理 N 个失效 Cookie」。
//           同时改成：校验失败不立刻删（连续 3 天才删），web / app 两种 Cookie 形态都试。

const KEY_ACCOUNTS = "netease_music_accounts";
const KEY_CAPTURE_DAY = "netease_music_capture_complete";
const KEY_LAST_RESULT = "netease_music_last_result";
const KEY_LAST_CAPTURE = "netease_music_last_capture";

const UA_WEB =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const UA_APP = "NeteaseMusic/9.1.0 (iPhone; iOS 17.0; Scale/3.00)";

// 两种 Cookie 形态：网页登录的 MUSIC_U 走 music.163.com；App 抓到的走 interface3
const FLAVORS = {
  web: {
    base: "https://music.163.com",
    headers(cookie) {
      return {
        Cookie: cookie,
        "User-Agent": UA_WEB,
        Referer: "https://music.163.com/",
        Accept: "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
      };
    },
  },
  app: {
    base: "https://interface3.music.163.com",
    headers(cookie) {
      return {
        Cookie: "os=ios; appver=9.1.0; channel=distribution; " + cookie,
        "User-Agent": UA_APP,
        Accept: "*/*",
      };
    },
  },
};

function envEnabled(ctx, key) {
  const raw = String(ctx.env?.[key] ?? "");
  if (raw === "" || raw.includes("{{{")) return true;
  return raw === "true";
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function safeGetJSON(ctx, key, fallback) {
  try {
    const v = ctx.storage.getJSON(key);
    if (v === null || v === undefined) return fallback;
    return typeof v === "string" ? JSON.parse(v) : v;
  } catch (e) {
    return fallback;
  }
}

function fp(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

function headerValue(headers, name) {
  if (!headers) return "";
  const lower = name.toLowerCase();
  try {
    if (typeof headers.get === "function") {
      const v = headers.get(name) || headers.get(lower);
      if (v) return String(v);
    }
  } catch (e) {}
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      return Array.isArray(v) ? v.join("; ") : String(v ?? "");
    }
  }
  return "";
}

async function httpRaw(ctx, method, url, headers, body) {
  const opts = { headers: headers || {}, timeout: 20000 };
  if (body !== undefined) opts.body = body;
  try {
    const r = method === "POST"
      ? await ctx.http.post(url, opts)
      : await ctx.http.get(url, opts);
    let text = "";
    if (r && typeof r.text === "function") text = await r.text();
    else if (typeof r === "string") text = r;
    else if (r !== null && r !== undefined) text = JSON.stringify(r);
    return { ok: true, status: (r && r.status) || 200, text: text || "" };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
}

function parseJSON(res) {
  if (!res.ok) return { _err: res.error || "请求失败" };
  try {
    return JSON.parse(res.text);
  } catch (e) {
    return { _err: "接口返回非 JSON（可能被风控）" };
  }
}

function isFakeSuccess(msg) {
  return /暂不支持|不支持|未登录|请登录|已失效|失败|异常|错误|系统错误/.test(String(msg || ""));
}

function isDone(data) {
  if (!data || typeof data !== "object") return false;
  const msg = String(data.message || data.msg || "");
  if (isFakeSuccess(msg)) return false;
  if (data.code === 200 && !isFakeSuccess(msg)) return true;
  return /成功|已签到|已签|重复|已领取|已完成|已打卡|明天再来/.test(msg);
}

// 关键修复：profile / account 在顶层
function profileOf(info) {
  if (!info || typeof info !== "object" || info._err) return null;
  const p = info.profile || (info.data && info.data.profile) || null;
  const a = info.account || (info.data && info.data.account) || null;
  if (p && (p.userId || p.nickname)) return p;
  if (a && a.id) return { userId: a.id, nickname: (p && p.nickname) || "网易云账号" };
  return null;
}

async function captureCookie(ctx) {
  if (!envEnabled(ctx, "ENABLE_CAPTURE")) return;
  const cookie = headerValue(ctx.request?.headers, "cookie");
  if (!cookie) return;
  if (!/MUSIC_U=/.test(cookie)) {
    console.log(`netease: 有 Cookie 但无 MUSIC_U (len=${cookie.length})，跳过`);
    return;
  }

  const f = fp(cookie);
  const accounts = safeGetJSON(ctx, KEY_ACCOUNTS, {});
  const key = "acc_" + f;
  const changed = !accounts[key] || accounts[key].cookie !== cookie;

  accounts[key] = {
    cookie: cookie,
    name: accounts[key]?.name || "网易云账号",
    updated: Date.now(),
    fail: 0,
  };
  ctx.storage.setJSON(KEY_ACCOUNTS, accounts);
  ctx.storage.setJSON(KEY_LAST_CAPTURE, { f: f });

  if (changed) {
    const day = ctx.storage.get(KEY_CAPTURE_DAY);
    if (String(day || "") !== today()) {
      ctx.storage.set(KEY_CAPTURE_DAY, today());
      ctx.notify({
        title: "网易云 Cookie 已保存",
        body: "每日 00:10 自动签到（积分 / 云贝 / 成长值）",
      });
    }
  }
  console.log(`netease: 捕获 MUSIC_U 成功 len=${cookie.length} changed=${changed}`);

  // MUSIC_U 随 App 请求轮换，只留最新 3 条
  const ks = Object.keys(accounts);
  if (ks.length > 3) {
    ks.sort((a, b) => (accounts[b].updated || 0) - (accounts[a].updated || 0));
    const trimmed = {};
    ks.slice(0, 3).forEach((x) => { trimmed[x] = accounts[x]; });
    ctx.storage.setJSON(KEY_ACCOUNTS, trimmed);
    console.log(`netease: 账号条目裁剪 ${ks.length} -> 3`);
  }
}

// 依次尝试 web / app 两种形态，任一拿到 profile 即视为登录态有效
async function validate(ctx, cookie) {
  const tried = [];
  for (const name of ["web", "app"]) {
    const fl = FLAVORS[name];
    const info = parseJSON(
      await httpRaw(ctx, "GET", fl.base + "/api/nuser/account/get", fl.headers(cookie))
    );
    if (info._err) {
      tried.push(`${name}:err(${info._err})`);
      continue;
    }
    const prof = profileOf(info);
    if (prof) return { ok: true, flavor: name, profile: prof, tried };
    tried.push(`${name}:${info.code}${info.message ? "/" + info.message : ""}`);
  }
  return { ok: false, flavor: null, profile: null, tried };
}

async function signOne(ctx, cookie, flavor, path, method) {
  const fl = FLAVORS[flavor] || FLAVORS.web;
  const headers = { ...fl.headers(cookie), "Content-Type": "application/x-www-form-urlencoded" };
  const res = await httpRaw(ctx, method || "POST", fl.base + path, headers, method === "POST" ? "" : undefined);
  const data = parseJSON(res);
  if (data._err) return { ok: false, msg: data._err };
  if (data.code === 301 || data.code === 302) return { ok: false, msg: "未登录(301)" };
  return { ok: isDone(data), msg: String(data.message || data.msg || (isDone(data) ? "已完成" : "未知响应")) };
}

async function signVipGrowth(ctx, cookie, flavor) {
  const fl = FLAVORS[flavor] || FLAVORS.web;
  const h = { ...fl.headers(cookie), "Content-Type": "application/x-www-form-urlencoded" };

  const signRes = parseJSON(await httpRaw(ctx, "POST", fl.base + "/api/vip-center-bff/task/sign", h, ""));
  if (signRes._err) return { ok: false, msg: "打卡失败：" + signRes._err };
  if (signRes.code === 301 || signRes.code === 302) return { ok: false, msg: "未登录(301)" };
  if (!(signRes.code === 200 && !isFakeSuccess(signRes.message || signRes.msg))) {
    return { ok: false, msg: "打卡响应异常：" + String(signRes.message || signRes.msg || "未知") };
  }

  const histRes = parseJSON(await httpRaw(
    ctx, "POST", fl.base + "/api/vipnewcenter/app/level/user/checkin/history/detail", h,
    `signDayTime=${Date.now()}&type=1`
  ));
  const histOk = histRes.code === 200;

  const rewardRes = parseJSON(await httpRaw(
    ctx, "POST", fl.base + "/api/vipnewcenter/app/level/task/reward/getall", h, ""
  ));
  const rewardOk = rewardRes.code === 200 || isDone(rewardRes);

  if (histOk && rewardOk) return { ok: true, msg: "打卡+领取成功" };
  if (histOk) return { ok: true, msg: "打卡成功（领取待确认）" };
  return { ok: true, msg: "打卡提交成功" };
}

async function runScheduled(ctx) {
  if (!envEnabled(ctx, "ENABLE_SCHEDULE")) return null;

  const accounts = safeGetJSON(ctx, KEY_ACCOUNTS, {});
  const keys = Object.keys(accounts);
  if (!keys.length) {
    ctx.notify({
      title: "网易云签到",
      body: "没有 Cookie：请打开网易云 App 任意页面（或重新登录一次）",
    });
    return null;
  }

  const lines = [];
  let okCount = 0;
  let failCount = 0;
  let deadCount = 0;
  let changed = false;
  let firstFailDetail = "";
  const seenUid = {};

  for (const k of keys) {
    const acc = accounts[k];
    if (!acc || !acc.cookie) {
      delete accounts[k];
      changed = true;
      continue;
    }

    const v = await validate(ctx, acc.cookie);
    if (!v.ok) {
      // v18：不再立刻删，连续 3 次校验失败才清掉（避免把有效 Cookie 误删成死循环）
      acc.fail = (acc.fail || 0) + 1;
      if (acc.fail >= 3) {
        delete accounts[k];
        changed = true;
        deadCount++;
      } else {
        changed = true;
        lines.push(`${acc.name || k}：登录态校验失败，保留待重试（${acc.fail}/3）`);
      }
      failCount++;
      if (!firstFailDetail) firstFailDetail = `校验明细 ${v.tried.join(" | ")}`;
      continue;
    }

    if (acc.fail) { acc.fail = 0; changed = true; }

    const uid = String(v.profile.userId || "");
    if (uid && seenUid[uid]) {
      delete accounts[k];
      changed = true;
      continue;
    }
    if (uid) seenUid[uid] = true;

    const name = v.profile.nickname || acc.name || k;
    if (acc.name !== name) { accounts[k].name = name; changed = true; }

    const flavor = v.flavor;
    const parts = [];
    const daily = await signOne(ctx, acc.cookie, flavor, "/api/point/dailyTask?type=0", "POST");
    parts.push("积分 " + (daily.ok ? "✓" : "✗"));
    const yunbei = await signOne(ctx, acc.cookie, flavor, "/api/pointmall/user/sign", "POST");
    parts.push("云贝 " + (yunbei.ok ? "✓" : "✗"));
    const vip = await signVipGrowth(ctx, acc.cookie, flavor);
    parts.push("成长值 " + (vip.ok ? "✓" : "✗"));

    const allOk = daily.ok && yunbei.ok && vip.ok;
    if (allOk) okCount++; else failCount++;
    lines.push(`${name}：${parts.join(" / ")}（${flavor}）`);
    if (!allOk && !firstFailDetail) {
      firstFailDetail = `明细 积分:${daily.msg} 云贝:${yunbei.msg} 成长值:${vip.msg}`;
    }
  }

  if (changed) ctx.storage.setJSON(KEY_ACCOUNTS, accounts);

  if (deadCount) lines.push(`已清理 ${deadCount} 个连续 3 天校验失败的 Cookie`);
  if (!lines.length) lines.push("没有可用 Cookie：请打开网易云 App 任意页面，或重新登录一次");

  const head = deadCount && !okCount
    ? "Cookie 已过期"
    : (failCount === 0 ? "全部签到成功" : `${okCount}/${okCount + failCount} 成功`);
  const body = head + "\n" + lines.join("\n") + (firstFailDetail ? "\n" + firstFailDetail : "");
  ctx.storage.setJSON(KEY_LAST_RESULT, { at: Date.now(), ok: okCount, fail: failCount, body });
  ctx.notify({ title: "网易云签到", body });
  return null;
}

export default async function (ctx) {
  if (ctx.request && ctx.request.url) {
    try {
      await captureCookie(ctx);
    } catch (e) {
      console.log("netease: 捕获钩子异常（不通知） " + String((e && e.message) || e));
    }
    return;
  }
  try {
    return await runScheduled(ctx);
  } catch (e) {
    ctx.notify({ title: "网易云签到异常", body: String((e && e.message) || e) });
    return null;
  }
}
