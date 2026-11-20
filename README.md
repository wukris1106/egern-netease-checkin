# egern-netease-checkin · 网易云音乐签到模块 + 直连规则集

两块东西：

1. **签到模块**：每天自动签到三个目标 —— 积分/经验、云贝、VIP 成长值（黑胶乐签）。Cookie 从 App 请求自动捕获。
2. **直连规则集**：修网易云在代理下「云贝请求失败」「播放卡顿」的问题。

## 模块导入（Egern → 工具 → 模块 → 从 URL 导入）

```
https://cdn.jsdelivr.net/gh/wukris1106/egern-netease-checkin@main/netease-checkin.yaml
```

Raw 备用：

```
https://raw.githubusercontent.com/wukris1106/egern-netease-checkin/main/netease-checkin.yaml
```

## 规则集（Egern → 规则集 → 新建远程，策略 DIRECT）

```
https://cdn.jsdelivr.net/gh/wukris1106/egern-netease-checkin@main/netease-music-direct.list
```

## 用法要点

- 打开网易云 App 一次即可自动捕获 Cookie（存储键 `netease_music_accounts`，与历史版本一致，**旧 Cookie 直接复用，不用重新抓**）
- 默认签到时间 00:10，可在「编辑模板参数」里改 CronExp
- 两个开关（自动获取 Cookie / 每日自动签到）在编辑页与模板参数里都能改
- 关掉自动获取 Cookie 后完全静默：不抓 Cookie、不覆盖、不通知，签到照常用已存 Cookie

## 签到接口

- 积分/经验：`POST /api/point/dailyTask?type=0`
- 云贝：`POST /api/pointmall/user/sign`
- VIP 成长值：`POST /api/vip-center-bff/task/sign`，历史校验 `checkin/history/detail`，一键领取 `vipnewcenter/app/level/task/reward/getall`

明文 `/api/` 路径可用，**不需要** weapi 的 AES/RSA 加密。

## 直连规则集内容

10 条域名 + 18 条 IP 段（`no-resolve`）+ 2 条 User-Agent 匹配，取自 `blackmatrix7/ios_rule_script` NetEaseMusic。IP 段包含 `59.111.128.0/17`、`115.236.112.0/20`、`223.252.192.0/19` 这些云贝/播放实际走的网段。

## 历史

重建于 2026-11-21。脚本 v15（2026-11-20）行为不变，仅把 `script_url` 从旧自建站切到本仓库 jsDelivr。
