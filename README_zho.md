<p align="center">
  <img src="images/HYDRA_UMC_BANNER.svg" alt="HYDRA-UMC-OPCUA-SERVER banner" width="100%">
</p>

# 🏭 HYDRA-UMC-OPCUA-SERVER

<p align="center"><a href="README.md">🇺🇸 English</a> | <a href="README_spa.md">🇪🇸 Español</a> | <a href="README_fra.md">🇫🇷 Français</a> | <a href="README_ita.md">🇮🇹 Italiano</a> | <a href="README_deu.md">🇩🇪 Deutsch</a> | 🇨🇳 <b>简体中文</b> | <a href="README_jpn.md">🇯🇵 日本語</a></p>

### 🛠️ 将 HydraState 对象映射到标准化 OPC-UA 地址空间

<p align="left">
  <img src="https://img.shields.io/badge/Licencia-GPL%203.0-blue.svg" alt="GPL 3.0">
  <img src="https://img.shields.io/badge/Standard-OPC--UA-orange.svg" alt="OPC-UA">
  <img src="https://img.shields.io/badge/Feature-Address%20Space%20Modeling-blue.svg" alt="Modeling">
</p>

---

## 1. 🛠️ 技术概述

**HYDRA-UMC-OPCUA-SERVER** 是网关的核心工业建模模块。它将内部的动态
HydraState（JSON）转换为一个结构化的、可发现的 OPC-UA 地址空间。

它使工业自动化软件（如 Ignition、Siemens TIA Portal 或 Rockwell
FactoryTalk）能够浏览、读取和写入机器人变量，就像它们是标准的 PLC
标签一样。

### 关键特性：
* 🛠️ **动态信息建模：** 根据活跃的机器人和工具自动生成 OPC-UA 树。
* 🔄 **读写访问：** 从 PLC 客户端安全地控制机器人关节和执行器。
* 🔖 **版本化命名空间与稳定的 NodeId：** 真实、明确的命名空间 URI，以及明确的字符串 NodeId——地址空间的更新不会悄悄改变客户端所依赖的路径。*(已实现)*
* 🔐 **按会话的写入授权：** 真实、动态的检查，区分匿名会话与已认证会话——并非每个客户端默认都能获得写入权限。*(已实现)*
* 📡 **订阅支持：** 使用 OPC-UA 发布-订阅机制实现高效的数据更新。
* 🛡️ **加密：** 完全支持签名和加密安全策略（Basic256Sha256）。

---

## 2. 🔄 OPC-UA 地址空间流程

```mermaid
flowchart LR
    API["Hydra Internal API"] --> MAP["OPC-UA Mapper"]
    MAP --> SPACE["Address Space Tree"]
    SPACE --> TAGS["Standardized PLC Tags"]
    TAGS --> CLIENT["External PLC / SCADA"]
```

---

## 3. 🧱 架构与设计决策

* **为何这是 HYDRA-UMC-GATEWAY-INDUSTRIAL 的兄弟项目，而非子模块。** 每个协议适配器都是可独立部署/重启的进程——一次 OPC-UA 客户端库问题永远不会导致与其并行运行的 MQTT 或 MTConnect 适配器宕机。
* **为何是一个 OPC-UA 地址空间，而非一个扁平的 REST 透传。** OPC-UA 客户端（SCADA/历史数据库）期望的是一个真正的、可浏览的、带类型节点的地址空间——一个扁平的 REST 透传技术上可以暴露数据，但完全违背了使用 OPC-UA 协议的初衷。
* **为何入口点今天只打印身份/版本，在健康检查监听器启动后才退出。** 处于脚手架（scaffolding）阶段，与父项目自身 README 中的理由相同——一个真正的网关本质上是长期运行的，因此证明该进程能够保持运行是真正的第一个里程碑。
* **这如何融入生态系统的其余部分。** 作为 HYDRA-UMC-GATEWAY-INDUSTRIAL 下的同级服务——将 HYDRA-UMC-SERVER 自身的状态转换为一个真实的 OPC-UA 地址空间。
* **真实的协议级测试，而不仅仅是编译检查。** `tests/server.test.ts` 使用真实的 `OPCUAClient`（node-opcua 自带的客户端，与 UAExpert/Ignition 使用的是同一个库）通过真实的二进制协议、在真实的 TCP 端口上连接真实的 `OPCUAServer`——打开会话、按路径浏览/读取 `SwarmOnline`/`ActiveRobotCount`，并确认客户端发出的写入操作既反映在回读的值中，也反映在服务器端状态中。
* **为何使用明确的字符串 NodeId，而非 node-opcua 自动分配的数字 NodeId。** 数字 NodeId 按创建顺序分配——在代码中把新的 DataItem 插入到已有 DataItem 之前，会悄悄将其重新编号，导致任何硬编码了旧编号的工业客户端出现故障。像 `s=HydraNode_1.SwarmOnline` 这样的显式 NodeId，不会仅仅因为地址空间代码的结构发生变化，就在客户端下方发生偏移。
* **为何 `SpindleTemp` 使用 `timestamped_get`，而不是其他变量所用的更简单的 `get()`。** `get()` 会自动为每次读取盖上当前时间戳——这对实时变化的值没有问题，但对于变化缓慢的值来说却并不诚实（主轴不会在两次轮询之间重新升温）。`timestamped_get` 返回一个真正的 `DataValue`，带有明确的 `sourceTimestamp`，追踪该值实际最后一次变化的时间，这正是 OPC-UA 历史数据库所依赖的真实语义。
* **为何写入授权按会话进行（`isUserWritable`），而非使用静态的访问级别标志。** 静态的 `userAccessLevel` 无法区分一个客户端的会话与另一个客户端的会话——它对每个连接都是相同的。在变量节点上重写 `isUserWritable(context)` 是 node-opcua 自身文档化的机制，用于实现一个真正按会话变化的检查，真实到足以用两个不同的真实客户端身份进行测试。

---

## 📂 目录结构

```text
HYDRA-UMC-OPCUA-SERVER/
├── src/         # 源代码（Node/TypeScript —— 模型、服务器、映射器）
├── docs/        # 文档与标签映射参考
├── build/       # 编译输出（npm run build）
├── images/      # 媒体与图表
├── scripts/     # 实用脚本（bump-version.mjs）
└── README.md
```

纯网络服务，没有自己专属的硬件——`hardware/`、`firmware/` 和 `os/`
已根据仓库结构策略从项目模板中省略。

---

## 🛠️ 开发环境

### 前提条件
- [Node.js](https://nodejs.org/)（建议 v18 或更高版本）
- npm

### 安装
```bash
npm install
```

### 开发模式
使用 `tsx` 直接运行 OPC-UA 服务器（无需打包器）：
- **Windows：** 双击 `dev.bat` 或运行 `npm run dev`
- **Linux/Mac：** 运行 `./dev.sh` 或 `npm run dev`

### 生产构建
使用 esbuild 将服务器打包为单个可部署文件：
- **Windows：** 双击 `build.bat` 或运行 `npm run build`
- **Linux/Mac：** 运行 `./build.sh` 或 `npm run build`

然后启动它：
```bash
npm start
```

服务器监听 `0.0.0.0:4840`（IANA 注册的默认 OPC-UA 端口），端点为
`opc.tcp://<host>:4840/HYDRA-UMC-OPCUA-SERVER`——将任何 OPC-UA 客户端
（UAExpert、Ignition、Siemens TIA Portal……）指向该端点即可浏览地址
空间。

### 版本管理
每次真实的 `npm run build` 都会自动递增 `package.json` 自身的
`version`（`scripts/bump-version.mjs`，作为 `build` 脚本的第一步接入）
——一种十进制"里程表"方案：每次构建 patch +1，超过 9 时进位到 minor
（minor 超过 9 时进位到 major），而不会到达两位数段（`0.0.9` ->
`0.1.0`，而非 `0.0.10`）。

---

## 🚀 路线图
* **第一阶段：** OPC-UA 发布/订阅实现，用于高速数据交换和传统协议桥接。
* **第二阶段：** 用于海量 IoT 设备管理和高并发的 MQTT Broker 集群。
* **第三阶段：** MTConnect 适配器支持，用于多厂商 CNC 和 PLC 机械集成。
* **第四阶段：** 完全符合 OPC UA Robotics 配套规范，并实现工业网关同步。

---

## 🔗 相关项目

本项目是同一作者（JuanenRac / Electro Hobby 3D）打造的更大规模机器人生态
系统的一部分，涵盖固件、控制软件、AI 节点和车队工具。值得了解，因为某个
需求实际上可能是关于这些项目之一，而非本仓库。

### 项目族

**父项目：** **[HYDRA-UMC-GATEWAY-INDUSTRIAL](https://github.com/JuanenRac/HYDRA-UMC-GATEWAY-INDUSTRIAL)** —— 本 OPC-UA 适配器所接入的集成父项目。

**同族项目：**
- **[HYDRA-UMC-MQTT-BROKER](https://github.com/JuanenRac/HYDRA-UMC-MQTT-BROKER)** —— 同级协议适配器，同一父项目。
- **[HYDRA-UMC-MTCONNECT-ADAPTER](https://github.com/JuanenRac/HYDRA-UMC-MTCONNECT-ADAPTER)** —— 同级协议适配器，同一父项目。

### 直接相关（项目族之外）

- **[HYDRA-UMC-SERVER](https://github.com/JuanenRac/HYDRA-UMC-SERVER)** —— 本适配器所暴露状态的来源。

### 生态系统的其余部分

**HYDRA-UMC 平台** —— 多机器人微工厂单元
- **[HYDRA-UMC](https://github.com/JuanenRac/HYDRA-UMC)** —— 协调最多 8 条机械臂的 CM5 + STM32H745 主板。
- **[HYDRA-UMC-SERVER](https://github.com/JuanenRac/HYDRA-UMC-SERVER)** —— 每个控制客户端所对接的 Express/WebSocket 后端。
- **[HYDRA-UMC-STUDIO](https://github.com/JuanenRac/HYDRA-UMC-STUDIO)** —— 基于 Web 的控制仪表盘，多机器人 3D 可视化。
- **[HYDRA-UMC-ANDROID-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-ANDROID-CONTROL)** —— 通过 Wi-Fi/蓝牙的 Android 控制应用。
- **[HYDRA-UMC-IOS-CONTROL](https://github.com/JuanenRac/HYDRA-UMC-IOS-CONTROL)** —— 基于 Flutter 构建的 iOS/iPadOS 控制应用。
- **[HYDRA-UMC-SUITE](https://github.com/JuanenRac/HYDRA-UMC-SUITE)** —— 桌面端集群指挥中心（Python/PySide6）。
- **[HYDRA-UMC-EDITOR-URDF](https://github.com/JuanenRac/HYDRA-UMC-EDITOR-URDF)** —— 用于机器人目录的桌面端 URDF 模型编辑器。
- **[HYDRA-UMC-DSI](https://github.com/JuanenRac/HYDRA-UMC-DSI)** —— 机载 DSI 触摸屏的原生触控 UI。

**URTC 平台** —— 每台 HYDRA-UMC 机械臂搭载的工具头控制器
- **[URTC](https://github.com/JuanenRac/URTC)** —— CAN 总线工具头控制器，25 种工具配置。
- **[URTC-FLASHER](https://github.com/JuanenRac/URTC-FLASHER)** —— 桌面端 CAN-OTA + SWD/JTAG 刷写工具。
- **[URTC-TESTER](https://github.com/JuanenRac/URTC-TESTER)** —— 桌面端实时 CAN 总线诊断工具。
- **[URTC-WEB-STUDIO](https://github.com/JuanenRac/URTC-WEB-STUDIO)** —— 通过 Web Serial API 的浏览器端替代方案。

**🎥 视觉 AI 节点（Hailo-8）**
- [HYDRA-UMC-VISION-NODE](https://github.com/JuanenRac/HYDRA-UMC-VISION-NODE)
- [HYDRA-UMC-VISION-STREAMER](https://github.com/JuanenRac/HYDRA-UMC-VISION-STREAMER)
- [HYDRA-UMC-DETECTION-HEF](https://github.com/JuanenRac/HYDRA-UMC-DETECTION-HEF)
- [HYDRA-UMC-SAFETY-ZONES](https://github.com/JuanenRac/HYDRA-UMC-SAFETY-ZONES)
- [HYDRA-UMC-VISUAL-SERVOING-API](https://github.com/JuanenRac/HYDRA-UMC-VISUAL-SERVOING-API)

**🧠 认知 AI 节点（Hailo-10）**
- [HYDRA-UMC-COGNITIVE-NODE](https://github.com/JuanenRac/HYDRA-UMC-COGNITIVE-NODE)
- [HYDRA-UMC-VLA-ENGINE](https://github.com/JuanenRac/HYDRA-UMC-VLA-ENGINE)
- [HYDRA-UMC-VOICE-UI](https://github.com/JuanenRac/HYDRA-UMC-VOICE-UI)
- [HYDRA-UMC-SEMANTIC-PLANNER](https://github.com/JuanenRac/HYDRA-UMC-SEMANTIC-PLANNER)
- [HYDRA-UMC-DOCS-QA](https://github.com/JuanenRac/HYDRA-UMC-DOCS-QA)

**🐝 编排与集群**
- [HYDRA-UMC-ORCHESTRATOR](https://github.com/JuanenRac/HYDRA-UMC-ORCHESTRATOR)
- [HYDRA-UMC-SWARM-SYNC](https://github.com/JuanenRac/HYDRA-UMC-SWARM-SYNC)
- [HYDRA-UMC-PATH-PLANNER-3D](https://github.com/JuanenRac/HYDRA-UMC-PATH-PLANNER-3D)
- [HYDRA-UMC-JOB-DISPATCHER](https://github.com/JuanenRac/HYDRA-UMC-JOB-DISPATCHER)
- [HYDRA-UMC-NODE-HEALING](https://github.com/JuanenRac/HYDRA-UMC-NODE-HEALING)

**🎮 数字孪生与仿真**
- [HYDRA-UMC-TWIN](https://github.com/JuanenRac/HYDRA-UMC-TWIN)
- [HYDRA-UMC-PHYSICS-REPLICA](https://github.com/JuanenRac/HYDRA-UMC-PHYSICS-REPLICA)
- [HYDRA-UMC-HIL-BRIDGE](https://github.com/JuanenRac/HYDRA-UMC-HIL-BRIDGE)
- [HYDRA-UMC-SYNTHETIC-DATA-GEN](https://github.com/JuanenRac/HYDRA-UMC-SYNTHETIC-DATA-GEN)

**📊 数据与分析**
- [HYDRA-UMC-DATALAKE](https://github.com/JuanenRac/HYDRA-UMC-DATALAKE)
- [HYDRA-UMC-TELEMETRY-COLLECTOR](https://github.com/JuanenRac/HYDRA-UMC-TELEMETRY-COLLECTOR)
- [HYDRA-UMC-ANOMALY-DETECTOR](https://github.com/JuanenRac/HYDRA-UMC-ANOMALY-DETECTOR)
- [HYDRA-UMC-PRODUCTION-REPORTS](https://github.com/JuanenRac/HYDRA-UMC-PRODUCTION-REPORTS)

**🛠️ 配套工具**
- [URTC-SMART-RACK](https://github.com/JuanenRac/URTC-SMART-RACK)
- [URTC-VISION-TOOL](https://github.com/JuanenRac/URTC-VISION-TOOL)
- [HYDRA-UMC-WATCH](https://github.com/JuanenRac/HYDRA-UMC-WATCH)
- [HYDRA-UMC-TOOL-CLI](https://github.com/JuanenRac/HYDRA-UMC-TOOL-CLI)
- [HYDRA-UMC-DASHBOARD-AI](https://github.com/JuanenRac/HYDRA-UMC-DASHBOARD-AI)


## 👤 作者
**JuanenRac**（Electro Hobby 3D）
📧 electrohobby3d@gmail.com

## 📜 许可证
GPL-3.0 —— 详见 LICENSE。

## 🛠️ BUILD & RUN

请在发布构建前使用不改动版本的构建检查：

| 操作 | Windows | Linux / macOS |
|---|---|---|
| 构建检查（不修改版本或 CHANGELOG） | `build-test.bat` | `./build-test.sh` |
| 运行 / 开发（如提供） | `run*.bat` 或 `dev*.bat` | `./run*.sh` 或 `./dev*.sh` |

`build-test.bat` 和 `build-test.sh` 会编译或验证项目技术栈，但不会递增 `hydra-umc.project.json`，也不会修改 `CHANGELOG.md`。它们仅可能生成正常的编译器输出。现有的 `build*.bat`、`build*.sh`、`run*` 和 `dev*` 脚本保留各自的版本化或运行时行为；需要该行为时请使用它们。