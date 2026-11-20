# ENAEA 自动连播助手

[![Version](https://img.shields.io/badge/version-v1.0.4-blue.svg)](https://github.com/Sereindian/enaea-auto-study/releases)
[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-606389-670000.svg)](https://greasyfork.org/zh-CN/scripts/606389)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/Sereindian/enaea-auto-study/blob/main/enaea-auto-study.user.js)
[![Platform](https://img.shields.io/badge/target-estudy.enaea.edu.cn-orange.svg)](https://estudy.enaea.edu.cn/)

针对中国教育干部网络学院新版学习平台（`estudy.enaea.edu.cn`）的 Tampermonkey（油猴）辅助脚本，适配平台 React 18 SPA 结构与 xgplayer 播放器。

---

## 安装方式

> **前置准备**：请先在 Chrome / Edge / Firefox 浏览器中安装 **Tampermonkey（篡改猴）** 或 **Violentmonkey（暴力猴）** 扩展。

### 方式一：Greasy Fork 一键安装（推荐）

支持自动检测并更新脚本版本：

1. 打开脚本发布页：**[ENAEA 新版学习平台自动连播助手 — Greasy Fork](https://greasyfork.org/zh-CN/scripts/606389)**
2. 点击页面上的 **「安装此脚本」**，在弹出的油猴确认页点击 **「安装」** 即可。

### 方式二：Tampermonkey（油猴）直接 / 手动安装

- **在线一键安装（二选一）**：
  - GitHub Release 最新版直链：[点击安装 enaea-auto-study.user.js](https://github.com/Sereindian/enaea-auto-study/releases/latest/download/enaea-auto-study.user.js)
  - GitHub `main` 分支 Raw 直链：[点击安装 enaea-auto-study.user.js](https://raw.githubusercontent.com/Sereindian/enaea-auto-study/main/enaea-auto-study.user.js)
- **本地手动粘贴安装**：
  1. 点击浏览器右上角 **Tampermonkey** 图标 -> **添加新脚本**。
  2. 全选删除默认模板内容，打开本仓库中的 [`enaea-auto-study.user.js`](./enaea-auto-study.user.js) 复制全部源码粘贴进去，按 `Ctrl + S` 保存。

安装完成后，打开或刷新 `https://estudy.enaea.edu.cn/web/.../requiredCourse` 页面，左下角即会出现 **「🎓 ENAEA 连播助手」** 悬浮控制面板（支持拖拽移动与折叠收起）。

---

## 核心功能

### 1. 看完自动切 P 与官方 1.25x 倍速锁定
- **自动播放与切集**：进入播放页自动关闭「温馨提示」弹窗并开始播放；视频结束后等待 3 秒确保平台完成学习记录与心跳上报，随后自动切换右侧目录中的下一集（支持跨子章节切集与文档型章节）。
- **断点续学与防误判**：优先续播进行中（1%–99%）的集数，并结合目录总时长校验防止 MSE 缓冲分片触发提前切集；内置会话级已播完缓存，避免列表进度延迟刷新引起的循环播放。
- **官方 1.25x 倍速锁定**：自动选中播放器官方 `.xgplayer-playbackrate` 的 `1.25x` 选项，切集、切课或倍速被重置时自动重新锁定；未开放倍速的课程保持平台默认速度。
- **持续自动静音**：切集（含手动切 P 与自动切 P）或音量变动后自动保持静音状态。

### 2. 完成课程自动切换下一课程
- 当前课程全部集数播完后，支持在悬浮窗切换以下两种策略：
  - **优先「下一个课程」+ 章末回目录切章**（默认）：点击顶部「下一个课程」进入下一门课；遇到「没有下一个课程」或连续碰到已完成课程时自动返回目录页。
  - **总是回目录按章节顺序选课**：直接返回目录页按章节顺序选取下一门课。

### 3. 看完一章自动切换章节
- 适配必修课（`requiredCourse`）与选修课（`electiveCourses`）的两级折叠目录结构，返回目录页后自动逐级展开面板，跳过已完成（100% / 完成）课程，**优先进入进行中（1%–99%）课程**，再按顺序学习未开始（0%）课程；同时兼容扁平网格与分页列表。

### 4. 弹窗处理与安全提醒
- **自动关闭非验证弹窗**：可自动关闭进入播放页的「温馨提示」以及学习达 90% 时弹出的「我要评价」（自动点击「暂不评价」）。
- **每日上限自动停止**：检测到「已达到每日学习上限」提示时自动停止运行并发送提醒。
- **防挂机/人机验证自动暂停（不绕过）**：遇到「行为验证」「右侧验证码」「滑块验证」「人脸识别验证」等弹窗时，脚本**立即暂停**且绝不自动点击或尝试绕过，同时通过悬浮窗红色警告、网页标题闪烁、提示音及桌面通知提醒人工处理，验证完成后自动恢复。

---

## 悬浮窗配置说明

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| 自动静音 | 开启 | 持续保持视频静音（含手动/自动切 P） |
| 锁定1.25倍速 | 开启 | 自动选择并维持官方 `1.25x` 倍速 |
| 跳过90%评价 | 开启 | 自动点击评价弹窗中的「暂不评价」 |
| 关温馨提示 | 开启 | 自动点击进入学习时的「知道了」 |
| 验证提示音 | 开启 | 触发人机/人脸验证时播放提示音 |
| 切课策略 | 优先下一课+章末回目录 | 控制一门课完成后如何衔接下一课 |

---

## 使用建议

- **保持窗口可见**：平台存在窗口切换检测及浏览器后台标签页节能限速，挂机学习时建议让浏览器窗口保持可见或单独置顶一个小窗口，以免影响计时。
- **手动微调与重置**：播放页可使用悬浮窗内的 **「下一集」** / **「下一课」** 手动切换（不会误标记当前课程为已完成）；如需重播当前会话已播完的集数，点击 **「清除缓存」** 即可。

---

## 更新日志

- **v1.0.4**：修复平台原生 `ended` 同步切集时误将下一集（如 2% 集数）标记为已完成并跳至再下一集的问题；新增总时长双向匹配校验、95 秒临时缓存自动过期及手动切回未完成集数时自动重置缓存。
- **v1.0.3**：补充 Greasy Fork 规范元数据（`@license MIT`、作者与仓库链接）并上线 Greasy Fork（#606389）；优化文档结构与安装指引；GitHub Release 改为直接提供 `.user.js` 源码文件。
- **v1.0.2**：优先续学进行中（1%–99%）的课程与集数，新增真实时长校验防止续播视频因 MSE 缓冲分片误判播完，手动切集/切课不污染已完成缓存。
- **v1.0.1**：修复手动切 P 与自动切 P 时未同步静音的问题，新增视频事件监听持续保持静音。
- **v1.0.0**：首发版本，实现看完自动切 P、完成课程切下一课、看完一章自动切章节、1.25x 倍速锁定、评价跳过与人机验证暂停提醒。

---

## 开源协议

本项目基于 [MIT License](https://opensource.org/licenses/MIT) 开源，仅用于学习辅助与前端技术交流。
