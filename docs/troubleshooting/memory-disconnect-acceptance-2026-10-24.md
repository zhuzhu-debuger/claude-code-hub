# 客户端提前断线与请求正文回收验收

## 原有验收缺口

此前隔离负载测试只覆盖完整读取响应，以及读到首字节后主动断线。入站正文很小，压力主要来自出站 SSE。它没有覆盖上游已经收到请求、客户端却在收到响应头之前断开的场景。

旧生命周期只在响应流 EOF、读取失败或 `cancel()` 完成后结束根所有者；后台宽限期又只在根所有者结束后启动。因此，框架丢弃断线后返回的响应时，可以出现后台任务已经归零、请求却长期 `active > 0` 且 `draining = 0` 的状态。提高堆限制或缩短缓存 TTL 不能修复这个所有权缺口。

## 分层验收

`tests/unit/proxy/memory-aware-response-owner.test.ts` 经过真实 `handleProxyRequest` 和 `ProxySession` 正文解析，仅替换系统设置和 guard 外部边界。每条请求携带 1 MiB 正文，覆盖：

- guard 未结束时断线：操作仍在使用正文时不能提前释放；操作返回无人读取的响应后必须释放。
- 已返回但无人读取的响应：三波、每波八条请求断线后，生命周期和正文租约均归零，不依赖 GC。
- 正常连接：状态码和正文保持不变，EOF 后释放，迟到的 abort 不重复归还。

`tests/unit/proxy/memory-aware-lifetime.test.ts` 补充永不结束的底层取消 Promise、仍在执行的操作与计费后台所有者、正常长流和监听器清理。未断线且仍在消费的合法长流不新增固定寿命限制。

`tests/load/memory-regression/run-isolated.mjs` 使用独立 PostgreSQL、Redis、真实 Next.js 生产构建以及本地 mock 上游。新增 `--early-disconnects` 时，mock 确认完整上游请求已经到达，然后主动触发客户端断线，500 ms 后才允许返回响应头。新增 `--request-body-bytes` 可放大入站正文；两个参数均不改变旧命令的默认行为。

```bash
node tests/load/memory-regression/run-isolated.mjs \
  --early-disconnects \
  --request-body-bytes 262144 \
  --concurrency 4 --waves 1 --cycles 1 \
  --payload-bytes 65536 --replay-detached-ms 10000 \
  --output /tmp/cch-early-disconnect
```

静默阶段先要求 mock 上游连接、后台任务和请求生命周期全部归零，之后才进行强制 GC 采样，因此 GC 不能掩盖仍被注册的根所有者。全部普通和取消请求都必须恰好产生一条账本记录；成功响应逐字节哈希一致，取消终态为 499，成功请求 token 与费用总和保持不变。

## 对照证据

旧实现运行上述 handler 测试，断线前返回和未消费响应两项失败，正常 EOF 对照通过：分别残留 1 个和 8 个 active 生命周期。修复后这三项全部通过。

旧生产构建的隔离测试在本机 Node 22.23.1 上执行，完整响应、首字节后断线两阶段通过；四条响应头前断线请求结束后，后台任务为 0，但 `active = 4`、`draining = 0`。数据库中已有完整 13 条账本记录（5 条 200，8 条 499），说明请求已结算，内存根所有者仍未退出。

修复后的本机生产构建先在 Node 22.23.1 上完成同运行时对照，再使用项目 `.node-version` 固定的 Node 26.12.1 完整重跑。后者是本次主要运行时验收，测试运行器及其启动的真实应用都使用 `/Users/lin/.local/share/cch-toolchain/node_modules/node/bin/node`。两次都执行两周期、每波八并发，每条请求携带 1 MiB 入站正文，正常响应也是 1 MiB。每次均包含预热共 49 条上游请求和 49 条账本记录：17 条 200、32 条 499，其中 16 条在响应头前断线。16 条正式成功响应通过完整 SHA-256 校验；累计输入、输出各 17 token，费用 0.000051 USD。每个阶段在 GC 前均确认后台任务、请求生命周期、正文租约归零，强制回收次数为 0。

| 运行时 | 两轮早断线结束后的 ArrayBuffer | 最终 heapUsed 相对预热基线 | 请求与账本 |
| --- | --- | --- | --- |
| Node 26.12.1，项目固定版本 | 均为 1,652,243 字节，两轮增量 0 | -240,944 字节 | 49 / 49 |
| Node 22.23.1，补充对照 | 均为 1,220,614 字节，两轮增量 0 | -2,862,432 字节 | 49 / 49 |

测试显式使用 10 秒 Replay 断线窗口，不能代替生产默认窗口及多小时流量验证。机器可读摘要见 [memory-disconnect-results-2026-10-24.json](memory-disconnect-results-2026-10-24.json)：`after` 为 Node 26 主要验收，`additionalRuntimeVerifications` 保留首轮 Node 22 结果，两次没有混算。

本次验证对象是基于 `9fd9549a` 的未提交工作区构建，Next.js BUILD_ID 为 `5j7P-sVV0l6hbMQC74kKj`；结果文件记录构建源码 SHA-256。它不代表旧提交 `9fd9549a` 本身已经包含修复。隔离脚本也已补充启动时记录 `testedSource`，将基准提交、工作区状态、构建编号及关键源码哈希分别输出。

## 生产判断边界

容器收到 SIGTERM 和业务请求失败不能单独证明内核 OOM，也不能据此否定应用内部内存积累。需要将重启触发来源、请求终态、worker 生命周期、正文租约与堆数据分别关联。本回归锁定的是可重复的客户端断线所有权缺陷；上线后的多小时稳定性仍需通过真实流量验证。
