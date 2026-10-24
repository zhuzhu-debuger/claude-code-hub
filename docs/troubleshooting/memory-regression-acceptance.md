# 高并发内存修复验收

本轮以当前 fork 工作树的生产构建为对象。线上旧版本的日志、历史 #1408 复现、本轮代码审计和
本轮隔离实测是四种不同证据；不能把其中任何一项直接当作线上唯一根因或所有 OOM 已解决的证明。

## 已确认的持有链与修复

| 路径 | 证据 | 修复与边界 |
| --- | --- | --- |
| SSE 格式修复缓冲 | 已消费的前 64 个 chunk 仍保留 backing store，32 个活跃流各消费 64 × 64 KiB 后，旧实现仍持有 128 MiB ArrayBuffer | 消费时立即释放 chunk 引用，数组延迟整理只保留空占位；同一微基准新实现残留为 0 |
| 非流式 ResponseFixer | 旧代码先执行完整 `arrayBuffer()`，之后才应用 `maxFixSize`，修复上限没有约束预读 | 对小正文有限预读；超限保留已读前缀并按下游需求继续透传，保留完整响应与取消传播 |
| Gemini 非流式转换 | 统计和转换重复 clone，未消费分支可留住整个响应 | 复用已有统计正文，转换成功后取消废弃原始分支；计费仍需要完整非流式正文，不能称所有非流式处理都已严格有界 |
| 会话监控聚合 | 2 秒缓存过期时，每位查看监控页的用户都会同时发起全量 Redis ID 扫描和数据库聚合 | 同一 worker、同类列表查询共享进行中的读取；每位调用者仍独立做权限过滤和实时并发查询 |
| 会话列表分页 | 返回每页 20 条前，原逻辑为全部会话构造完整展示对象和拼接字符串 | 先确定分类与分页范围，仅创建当前页展示对象；总数和权限语义不变。共享聚合本身仍是全量数据 |

会话缓存合并支持失败后的重试、空结果缓存，以及缓存失效/新写入后禁止旧查询回填。它没有
延长 2 秒缓存有效期，也没有加入请求拒绝或新的业务限流。日志历史浏览、活跃会话页面的取消和
超时已经有既有保护，不应误报为本轮首次修复。端点探测日志的后台轮询仍是可进一步改善的请求放大点，
本轮没有把它认定为生产 OOM 主因。

历史 Replay 本地正文累积、失效 spool 的断线窗口以及响应快照 Redis 多份复制，已有
[独立调查记录](issue-1408-replay-oom.md)和[原始夹具](../../tests/load/issue-1408-replay-oom/README.md)。
升级版本时应核对线上实际包含的提交和配置，不能仅凭相似日志假定历史修复已在运行。

## sub2api 的可复用经验

本轮参考本机 sub2api 的实现，不把不同语言的 RSS 数字直接比较：

- `backend/internal/service/usage_record_worker_pool.go` 把异步计费任务放入有界队列和有限 worker；
  默认满队列同步兜底，避免为了降内存而静默丢账。
- `backend/internal/service/ops_service.go` 在错误日志进入异步队列前限制正文大小，控制的是实际
  待保留数据，不能只限制队列条数。
- `backend/internal/service/openai_gateway_upstream_errors.go` 用有限读取处理上游错误正文，
  避免“读完才截断”。

本项目已经有异步写入队列、TTL/LRU 和 detached stream 预算，本轮优先修复绕过这些预算的
实际持有链，并复用既有缓冲模块；没有为每个入口再叠加一层门禁。

## 无服务依赖回归

已安装仓库依赖后，在本机或 acer-server 执行同一命令：

```bash
tests/load/memory-regression/run-offline.sh \
  --baseline 0c508eaac7e1f3c3717eb6a965b466e719f92b1e
```

该脚本把 DSN、Redis 地址显式置空，避免 `tests/setup.ts` 读取开发者 `.env` 后接触既有数据库。
它运行会话缓存和响应缓冲的定向覆盖率检查，以及断线计费、断线预算、流式首字节和非流式终态回归，
最后在独立 Node 子进程中比较旧/新实际 SSE 缓冲类的 ArrayBuffer 持有量。

会话缓存定向验证为 28 个测试；`session-cache.ts` 的行、语句、函数、分支覆盖率分别为
98.68%、98.75%、100%、84.84%。覆盖率配置要求四项均不低于 80%。

## 隔离全链路验收

需要 Docker、Bun、兼容项目的 Node 和已完成的 `bun run build`。脚本固定新建随机名称的
PostgreSQL 17、Redis 7 容器，端口仅绑定本机回环；应用使用 `.next/standalone`，mock 上游仅监听回环地址。
通过项目已有迁移命令初始化全新测试数据库，再通过管理 API 创建模型单价、供应商、用户和 Key。
脚本不接受外部应用地址或生产密钥，结束后清理自己创建的进程与容器。

长窗口验收保留真实 Replay 300 秒断线窗口，上游 idle timeout 设为 600 秒，避免另一个更短超时
先行结束流而产生错误结论。这里的“默认”仅指 Replay 窗口：夹具明确设置 stream gate 为 enforce、
响应去重开启、`CCH_MEMORY_BUDGET_BYTES=1 GiB`，内存 admission 仍为默认关闭；不是所有生产配置的默认组合。
通常需要等待至少 5 分钟：

```bash
node tests/load/memory-regression/run-isolated.mjs \
  --concurrency 32 --waves 1 --payload-bytes 1048576 \
  --output /tmp/cch-memory-default-window
```

快速验证和两周期回落可以显式缩短 Replay 窗口，结果必须注明该配置：

```bash
node tests/load/memory-regression/run-isolated.mjs \
  --concurrency 32 --waves 2 --cycles 2 --replay-detached-ms 10000 \
  --payload-bytes 1048576 --output /tmp/cch-memory-short-cycles
```

每个周期先执行正常响应波次，再执行取消波次。正常响应按 SHA-256 校验全部 SSE 字节，包含终态和 usage；
取消场景是客户端收到正文后断开、mock 上游继续悬挂而不发送 usage 终态。它不等同于模拟所有类型的半包取消。
输出包括 `app.log`、`migration.log`、`samples.jsonl`、`summary.json`。

验收必须同时满足：

| 维度 | 要求 |
| --- | --- |
| 正常输出 | 全部正常请求 HTTP 200，响应字节数与 SHA-256 与 mock 一致 |
| 计费正确性 | 每条请求对应一条 ledger；成功请求含 warmup，input/output token 与固定价格计算精确一致；本夹具无 usage 的取消请求应为 499 |
| 生命周期 | 每次静默恢复后，AsyncTaskManager 活跃任务数、请求内存 active/draining 均为 0，mock 上游连接关闭 |
| 内存恢复 | 分开报告 heap、external、ArrayBuffer、RSS；对照每周期静默后的采样，明确哪些样本使用了强制 GC |
| 用户体验 | 报告正常组首字节时间中位数和 p95；没有同机同负载的旧版本基线时，不声称延迟“零退化” |

强制 GC 只存在于测试进程的采样钩子，用来检查是否仍有引用保留正文。运行时仍可能保留 V8/allocator
高水位，RSS 不要求与 ArrayBuffer 等幅回落。短时实验不能代替多小时的真实流量、Redis 持久化 fork、
长输出、慢下游、所有转换协议和独特正文组合的容量验证。

## 本机实测

2026-10-23，macOS ARM64，Node 26.12.1，生产构建，独立 PG/Redis：

- 首轮短时验证：32 并发 × 2 波正常响应，再 32 并发 × 2 波取消，每条 1 MiB，Replay 断线窗口显式 10 秒。
- 64 条正常响应通过逐字节验证，64 条取消请求完成，另有 1 条 warmup；ledger 共 129 条，65 条成功，
  input/output token 各 65，金额精确为 0.000195 USD。
- heapUsed 从约 83.19 MiB 回到 81.93 MiB，ArrayBuffer 从约 0.576 MiB 回到 0.582 MiB；最终任务与请求内存 active/draining 为 0。
- RSS 峰值约 484.13 MiB，最终约 398.50 MiB，仍高于初始约 271.69 MiB；不能将其描述为 RSS 全部回收。
- 正常组首字节时间中位数约 312.45 ms，p95 约 663.94 ms（nearest-rank）；这是单次实测，不是相对旧版的回归结论。

随后完成了两个独立验收，机器可读摘要见 [memory-regression-results.json](memory-regression-results.json)。

| 项目 | 两周期短窗口 | 真实 300 秒 Replay 窗口 |
| --- | ---: | ---: |
| 正常 / 取消（不含 warmup） | 128 / 128 | 32 / 32 |
| ledger 总数 | 257 | 65 |
| HTTP 200 / 499 终态 | 129 / 128 | 33 / 32 |
| input / output token | 129 / 129 | 33 / 33 |
| 按夹具单价计费（USD） | 0.000387 | 0.000099 |
| 最终活跃任务 / 请求内存 active / draining | 0 / 0 / 0 | 0 / 0 / 0 |
| 最终请求生命周期 forcedTotal | 0 | 1 |
| 正常首字节中位数 / p95（ms） | 417.29 / 1010.42 | 385.78 / 608.25 |

两周期短窗口在每周期正常与取消波次后都等待静默并强制 GC。两次取消后的 ArrayBuffer 分别为
676,326 和 676,337 bytes，仅相差 11 bytes；heapUsed 分别约 81.75 和 82.46 MiB。每次采样的
活跃任务、请求内存 active/draining 均为 0。该证据支持短时重复负载后正文引用释放，不代表数小时稳态保证。

真实 300 秒窗口设置上游 idle timeout 为 600 秒，正常与取消各 32 条。最终 heapUsed 从
87,045,720 回到 84,619,792 bytes，ArrayBuffer 从 603,953 回到 602,685 bytes。
**这里并非 32 个流都驻留 300 秒**：31 条因既有 detached Replay 预算不足而降级，
其中 21 条后台 drain 被预算拒绝，10 条由普通 drain 窗口结束，只有 1 条 Replay 长尾驻留到长窗口。
请求生命周期回收器在最终终态前介入过一次（`forcedTotal=1`），因此不能表述成全部自然终态释放，
也不能把原有预算保护的效果全部归功于本轮代码修改。

两组均在本机存在其他开发任务时运行，没有旧版本同负载延迟对照。Redis 容器关闭持久化；此轮没有验证
RDB/AOF fork 峰值，也未保存旧脚本运行时的 Redis used_memory 对照。最终夹具已补上 Redis 最终
used_memory、peak 和 keyCount 统计，供后续同样命令采集。响应去重为每请求内的视图去重，
当前固定正文不能替代真实多样正文的容量评估。所有临时 app、mock、PG/Redis 已清理。
生产旧容器仍需部署修复版本后的观察验证。
