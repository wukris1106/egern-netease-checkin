// 网易云音乐签到 · Egern 脚本 v17 (2026-11-23)
// 三个签到目标：积分/经验、云贝、VIP 成长值（黑胶乐签）
// 明文 /api/ 路径可用，无需 weapi 加密

const ACCOUNT_URL = "https://music.163.com/api/nuser/account/get";
const DAILY_URL = "https://music.163.com/api/point/dailyTask?type=0";
const YUNBEI_URL = "https://music.163.com/api/pointmall/user/sign";
const VIP_SIGN_URL = "https://music.163.com/api/vip-center-bff/task/sign";
const VIP_HISTORY_URL = "https://music.163.com/api/vipnewcenter/app/level/user/checkin/history/detail";
const VIP_REWARD_ALL_URL = "https://music.163.com/api/vipnewcenter/app/level/task/reward/getall";

const KEY_ACCOUNTS = "netease_music_accounts";
const KEY_CAPTURE_DAY = "netease_music_capture_complete";
const KEY_LAST_RESULT = "netease_music_last_result";
const KEY_LAST_CAPTURE = "netease_music_last_capture";

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
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
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
    return { _err: "接口返回非 JSON（可能被风控或需要重新登录）" };
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

function cookieHeaders(cookie) {
  return {
    "Cookie": cookie,
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Referer": "https://music.163.com/",
    "Accept": "*/*",
  };
}

async function captureCookie(ctx) {
  if (!envEnabled(ctx, "ENABLE_CAPTURE")) return;
  const cookie = headerValue(ctx.request?.headers, "cookie");
  if (!cookie) {
    console.log("netease: 无 Cookie 头，跳过");
    return;
  }
  if (!/MUSIC_U=/.test(cookie)) {
    console.log(`netease: 有 Cookie 但无 MUSIC_U (len=${cookie.length})，跳过`);
    return;
  }

  const f = fp(cookie);
  const last = safeGetJSON(ctx, KEY_LAST_CAPTURE, {});
  const accounts = safeGetJSON(ctx, KEY_ACCOUNTS, {});
  const key = "acc_" + f;
  const changed = !accounts[key] || accounts[key].cookie !== cookie;

  accounts[key] = {
    cookie: cookie,
    name: accounts[key]?.name || "网易云账号",
    updated: Date.now(),
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

  // MUSIC_U 会随 App 请求轮换，不裁会每次捕获都多一条账号，签到任务天天刷一堆失效提示
  const ks = Object.keys(accounts);
  if (ks.length > 3) {
    ks.sort((a, b) => (accounts[b].updated || 0) - (accounts[a].updated || 0));
    const trimmed = {};
    ks.slice(0, 3).forEach((x) => { trimmed[x] = accounts[x]; });
    ctx.storage.setJSON(KEY_ACCOUNTS, trimmed);
    console.log(`netease: 账号条目裁剪 ${ks.length} -> 3`);
  }
}

async function signOne(ctx, cookie, url, method) {
  const res = await httpRaw(ctx, method || "POST", url, cookieHeaders(cookie), method === "POST" ? "" : undefined);
  const data = parseJSON(res);
  if (data._err) return { ok: false, msg: data._err };
  const done = isDone(data);
  return {
    ok: done,
    msg: String(data.message || data.msg || (done ? "已完成" : "未知响应")),
  };
}

async function signVipGrowth(ctx, cookie) {
  const h = cookieHeaders(cookie);
  // 1. 打卡
  const signRes = parseJSON(await httpRaw(ctx, "POST", VIP_SIGN_URL, h, ""));
  if (signRes._err) return { ok: false, msg: "打卡失败：" + signRes._err };
  const signOk = signRes.code === 200 && !isFakeSuccess(signRes.message || signRes.msg);
  if (!signOk) {
    return { ok: false, msg: "打卡响应异常：" + String(signRes.message || signRes.msg || "未知") };
  }
  // 2. 确认打卡记录
  const body = `signDayTime=${Date.now()}&type=1`;
  const histRes = parseJSON(await httpRaw(ctx, "POST", VIP_HISTORY_URL, {
    ...h,
    "Content-Type": "application/x-www-form-urlencoded",
  }, body));
  const histOk = histRes.code === 200;
  // 3. 一键领取
  const rewardRes = parseJSON(await httpRaw(ctx, "POST", VIP_REWARD_ALL_URL, h, ""));
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
      body: "没有 Cookie：请先打开网易云 App 任意页面，或重新登录一次",
    });
    return null;
  }

  const lines = [];
  let okCount = 0;
  let failCount = 0;
  let deadCount = 0;
  let firstOk = true;
  const seenUid = {};
  let changed = false;

  for (const k of keys) {
    const acc = accounts[k];
    if (!acc || !acc.cookie) {
      delete accounts[k];
      changed = true;
      continue;
    }

    // 验证登录态 + 取昵称
    const info = parseJSON(await httpRaw(ctx, "GET", ACCOUNT_URL, cookieHeaders(acc.cookie)));
    if (info._err) {
      // 网络/解析异常 ≠ Cookie 失效，保留条目等下一轮
      failCount++;
      lines.push(`${acc.name || k}：网络异常，Cookie 已保留（${info._err}）`);
      continue;
    }
    if (info.code !== 200 || !(info.data && info.data.profile)) {
      // 真失效：直接删掉。MUSIC_U 会随 App 请求轮换，旧条目留着只会天天刷同一条失败
      delete accounts[k];
      changed = true;
      deadCount++;
      failCount++;
      continue;
    }

    const profile = info.data.profile;
    const uid = String(profile.userId || "");
    if (uid && seenUid[uid]) {
      // 同一账号的重复条目（Cookie 轮换产生的），删掉不重复签到
      delete accounts[k];
      changed = true;
      continue;
    }
    if (uid) seenUid[uid] = true;

    const name = profile.nickname || acc.name || k;
    if (acc.name !== name) {
      accounts[k].name = name;
      changed = true;
    }

    const parts = [];
    const daily = await signOne(ctx, acc.cookie, DAILY_URL, "POST");
    parts.push("积分 " + (daily.ok ? "✓" : "✗"));
    const yunbei = await signOne(ctx, acc.cookie, YUNBEI_URL, "POST");
    parts.push("云贝 " + (yunbei.ok ? "✓" : "✗"));
    const vip = await signVipGrowth(ctx, acc.cookie);
    parts.push("成长值 " + (vip.ok ? "✓" : "✗"));

    const allOk = daily.ok && yunbei.ok && vip.ok;
    if (allOk) okCount++;
    else failCount++;
    lines.push(`${name}：${parts.join(" / ")}`);
    if (!allOk && firstOk) {
      lines.push(`  明细 积分:${daily.msg} 云贝:${yunbei.msg} 成长值:${vip.msg}`);
      firstOk = false;
    }
  }

  if (changed) ctx.storage.setJSON(KEY_ACCOUNTS, accounts);

  if (deadCount) {
    lines.push(`已清理 ${deadCount} 个失效 Cookie，打开网易云 App 会自动重新抓取`);
  }
  if (!lines.length) {
    lines.push("没有可用 Cookie：请打开网易云 App 任意页面，或重新登录一次");
  }

  const head = deadCount && !okCount
    ? "Cookie 已过期"
    : (failCount === 0 ? "全部签到成功" : `${okCount}/${okCount + failCount} 成功`);
  const body = head + "\n" + lines.join("\n");
  ctx.storage.setJSON(KEY_LAST_RESULT, { at: Date.now(), ok: okCount, fail: failCount, body: body });
  ctx.notify({ title: "网易云签到", body: body });
  return null;
}

export default async function (ctx) {
  // 请求钩子（捕获 Cookie）：失败只记日志，绝不通知
  if (ctx.request && ctx.request.url) {
    try {
      await captureCookie(ctx);
    } catch (e) {
      console.log("netease: 捕获钩子异常（不通知） " + String((e && e.message) || e));
    }
    return;
  }
  // 定时任务：完成/失败才通知
  try {
    return await runScheduled(ctx);
  } catch (e) {
    ctx.notify({ title: "网易云签到异常", body: String((e && e.message) || e) });
    return null;
  }
}
