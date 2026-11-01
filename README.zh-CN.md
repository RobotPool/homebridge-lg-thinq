<div align="center">

<img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

# Homebridge LG ThinQ

可以正常登录 LG 账号的 LG ThinQ 家电 Homebridge 插件，由 RobotPool 独立维护。

**简体中文** | [English](README.md)

[![release](https://img.shields.io/github/v/release/RobotPool/homebridge-lg-thinq?include_prereleases&sort=semver)](https://github.com/RobotPool/homebridge-lg-thinq/releases)
[![build](https://github.com/RobotPool/homebridge-lg-thinq/actions/workflows/build.yml/badge.svg)](https://github.com/RobotPool/homebridge-lg-thinq/actions/workflows/build.yml)
[![license](https://img.shields.io/github/license/RobotPool/homebridge-lg-thinq)](LICENSE)
[![stars](https://img.shields.io/github/stars/RobotPool/homebridge-lg-thinq?style=social)](https://github.com/RobotPool/homebridge-lg-thinq/stargazers)

</div>

> 从 2026 年 9 月起，`homebridge-lg-thinq@2.0.0-beta.8` 用 LG 账号登录会报 `LG pre-login failed: ... 403` 或 `LG OAuth key lookup failed: ... 404`。本版本修复了这两个问题，并已用真实 LG 账号验证（美国账号、邮箱密码登录、洗衣机和烘干机）。安装、回滚和已知限制见 [docs/robotpool-fork.zh-CN.md](docs/robotpool-fork.zh-CN.md)。
>
> 基于 nVuln 及贡献者的 [nVuln/homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq)（Apache-2.0）。与 nVuln 和 LG Electronics 无关联。

## 简介

Homebridge LG ThinQ 是用来控制和监控 LG ThinQ 家电的 Homebridge 平台插件。

本插件不是 LG 官方 API 客户端。它使用 LG ThinQ 账号数据，支持大部分现行 ThinQ2 设备，也可选支持部分旧款 ThinQ1 设备。

## 运行要求

* Homebridge `^1.11.2` 或 `^2.0.0`
* Node.js `^22.13.0` 或 `^24.0.0`

## 安装

在 Homebridge 主机的终端（Homebridge UI：菜单 > 终端）中，把最新 [Release](https://github.com/RobotPool/homebridge-lg-thinq/releases) 的安装包装到 Homebridge 存储目录：

```sh
# Homebridge apt 安装包 / 树莓派镜像
npm install --prefix /var/lib/homebridge TARBALL_URL

# 官方 Docker 镜像（homebridge/homebridge）
npm install --prefix /homebridge TARBALL_URL
```

把 `TARBALL_URL` 换成 Release 中 `.tgz` 附件的链接，然后重启 Homebridge。包名和平台名 `LGThinQ` 与上游相同，现有配置可以继续使用。详细步骤和回滚方法见 [docs/robotpool-fork.zh-CN.md](docs/robotpool-fork.zh-CN.md)。可在 Homebridge UI 一键安装的 npm 包正在计划中。

## 配置

推荐使用 Homebridge UI 的插件设置：

1. 打开 Homebridge UI。
2. 进入插件页面。
3. 打开 Homebridge LG ThinQ 的设置。
4. 选择 LG 账号所在的国家和语言。
5. 登录 LG 账号，获取 refresh token。
6. 点击 Homebridge UI 的保存按钮。
7. 重启 Homebridge 或插件子桥。
8. 重新打开插件设置，查看已发现的设备和设备选项。

插件配置中没有列出设备时，LG 账号下所有支持的设备都会启用。只有在需要重命名设备、配置设备选项或只启用部分设备时，才需要添加设备条目。

## 手动配置

可以手动编辑配置，但推荐使用 Homebridge UI。

```json
{
  "platform": "LGThinQ",
  "auth_mode": "token",
  "refresh_token": "refresh-token-from-lg-login",
  "country": "US",
  "language": "en-US",
  "devices": []
}
```

| 选项 | 必填 | 说明 |
| --- | --- | --- |
| `platform` | 是 | 必须为 `LGThinQ`。 |
| `auth_mode` | 是 | `token` 表示使用 refresh token；也接受 `account`，表示用户名密码配置。 |
| `refresh_token` | Token 模式必填 | LG 登录流程返回的 refresh token。 |
| `username` | 账号模式必填 | LG ThinQ 账号用户名。 |
| `password` | 账号模式必填 | LG ThinQ 账号密码。 |
| `country` | 是 | LG 账号国家的两位代码，例如 `US`。 |
| `language` | 是 | LG 账号语言代码，例如 `en-US`。 |
| `devices` | 否 | 留空或省略时启用所有已发现的支持设备。 |
| `thinq1` | 否 | 高级旧版选项，手动设为 `true` 可启用 ThinQ1 设备。 |

设备类型根据 LG 返回的发现数据识别。设备被发现后，设备专属设置会出现在 Homebridge UI 中。

## 支持的设备

支持情况取决于 LG 返回的型号数据。如果设备在 LG ThinQ App 中可见、但 Homebridge 中没有，请提交 Issue，附上设备类型、型号、国家和 debug 日志。

| 设备 | 状态 | 控制 | ThinQ2 | ThinQ1 |
| --- | --- | --- | --- | --- |
| 冰箱 | 支持 | 支持 | 是 | 是 |
| 空气净化器 | 支持 | 支持 | 是 | 是 |
| AeroTower | 支持 | 支持 | 是 | 否 |
| 洗衣机 / 烘干机 / WashTower | 支持 | 有限 | 是 | 是 |
| 洗碗机 | 支持 | 否 | 是 | 否 |
| 除湿机 | 支持 | 部分 | 是 | 否 |
| 空调 | 支持 | 支持 | 是 | 是 |
| Styler 衣物护理机 | 支持 | 有限 | 是 | 否 |
| 油烟机 | 支持 | 支持 | 是 | 是 |
| 烤箱 | 支持 | 部分 | 是 | 否 |
| 微波炉 | 支持 | 部分 | 是 | 否 |

## 故障排查

排查安装或设备问题时，请开启 Homebridge debug 日志。提交 Issue 时请附上启动日志、设备类型和型号、国家、语言以及错误信息。登录失败时，日志中以 `LG ... failed:` 开头的那一行会指明出错的步骤，其中不含密码或 Token。

## 命令行

```sh
thinq login <用户名> <密码>   # 用 LG 账号获取 refresh_token
thinq auth                    # 浏览器登录（含 Google、Apple 账号）获取 refresh_token
thinq -c US -l en-US ...      # 指定国家和语言（默认 US / en-US）
```

## 支持

本版本的问题、Bug 和登录结果反馈，请提交 [Issue](https://github.com/RobotPool/homebridge-lg-thinq/issues)。

## 致谢

本项目基于 nVuln 及其贡献者创建的 [nVuln/homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq)，版权与许可证见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。

特别感谢 [carlosgamezvillegas](https://github.com/carlosgamezvillegas) 实现烤箱和微波炉支持，详见 [#87](https://github.com/nVuln/homebridge-lg-thinq/issues/87)。
