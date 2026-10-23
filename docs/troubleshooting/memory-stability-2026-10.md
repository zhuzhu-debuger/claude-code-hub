# 高并发内存调查与修复（2026-10-23）

## 范围与证据边界

维护仓库：<https://github.com/zhuzhu-debuger/claude-code-hub>；上游保留为 `upstream`。
本次修复基于上游 `0c508eaa`（v0.9.8），但内存缺陷在该基础上仍然存在，升级本身不构成修复。
用户报告 v0.9.6 也出现内存失控。43 服务器只读取现有日志、诊断报告和容器状态；未修改配置、版本、网络或重启服务。
所有新代码和压力验证在本机及 acer-server 进行。

不能把 RSS、V8 heap、ArrayBuffer、Redis 内存混称为“缓存”。本次确认了可重现的请求缓冲保留、全量预读取、重复响应分支和监控查询放大；历史 OOM 报告没有对象级 heap snapshot，不能据此声称某一条路径解释了所有历史崩溃。

## 生产只读检查

| 项目 | 观测 | 含义 |
| --- | --- | --- |
| 运行版本 | 容器 v0.9.4，Node v26.7.0 | 与本地测试基础不同；用户也已验证 v0.9.6 会复现 |
| 容器内存限制 | Docker `Memory=0`、`MemorySwap=0` | 没有容器级隔离上限；这是故障影响面的放大条件，不是泄漏证明 |
| 历史报告 | 9 月 29–30 日保留 34 份 `OOMError` | 确认真实分配失败，不是单纯监控显示缓存高 |
| OOM 时 heap | 约 949–1447 MiB，heap 上限约 4192 MiB | 不能简单认定为达到普通 old-space 上限 |
| 大对象区 | 约 829–1244 MiB | 大字符串/数组等大对象占据显著比例，但报告不能识别其业务所有者 |
| 堆外内存 | 约 514–775 MiB | 与 heap 同时存在，必须分别观察 |
| 峰值 malloc | 多份报告约 1843–1844 MiB | 曾发生大的 native 分配；没有符号化栈，暂不归因于单个模块 |
| Redis | 应用连接名 `redis` 的 DNS 返回 `ENOTFOUND` | 应用与实际 Redis 位于不同 Docker 网络，目标别名对应用不可见 |
| 近期日志 | 30 分钟窗口内最多取 30000 行，解析 22729 行；Redis 连接错误 3030 次、重试耗尽 512 次 | 这是有界日志样本，不是全时段计数。持续失败导致降级、重连和日志开销 |

生产 Redis 网络问题需要单独修正，但本次遵守只读约束，未做网络连接或环境变量变更。改进客户端重试只能减少重连风暴，不能修复 DNS 配置。

## 已实现的修复

### 1. 流式修复器立即释放已消费数据

原 `ChunkBuffer.take()` 只移动 `head`，直到消费超过 64 块才压缩数组。已经消费的 `Uint8Array` 仍被数组引用，活跃长流会保留最多 64 块的 backing store，即使未读长度已经为 0。

修复将 SSE 行缓冲提取为 `SseChunkBuffer`，每消费一整块即清除该槽的引用，保留原有增量 CR/LF 扫描和批量数组压缩，避免引入逐块 `shift()` 的移动成本。

可重复对照（32 个仍活跃缓冲、每个 64 块、每块 64 KiB、读取后 GC）：

| 指标 | 原实现 | 修复后 |
| --- | ---: | ---: |
| 未读字节 | 0 | 0 |
| 残留 ArrayBuffer 增量 | 128 MiB | 0 MiB |

这证明去除了无用引用。RSS 受 allocator 高水位影响，不保证同步下降 128 MiB。

```bash
node tests/load/memory-regression/sse-buffer-retention.mjs --baseline 0c508eaa
```

### 2. 非流式响应在修复上限内预读

原实现先 `response.arrayBuffer()` 全量收集，之后才检查 `maxFixSize`。1 MiB 的修复上限并没有限制实际读取；大响应会在修复器中产生完整缓冲副本。

新增 `readResponseWithinLimit()`：已知超限长度直接透传；未知长度只预读到上限加触发超限的当前块，随后按下游读取速度转发前缀和剩余上游数据。超限响应仍返回原始内容，不引入新的响应大小拒绝策略。明确的兼容性取舍：超过修复上限的异常 JSON 不再执行 `output:null` 或函数 arguments 的结构规范化，避免再次完整物化超大正文。取消和读取异常释放 reader 与已缓存前缀。

### 3. Gemini 非流式统计复用响应分支

原透传分支先创建通用统计 clone，随后再次 clone 并提前返回，第一条分支没有消费者。修复复用已存在的统计分支；Gemini 转换也复用同一份统计文本，转换成功后取消不再返回的原始分支，终态清理未读的统计和 before 快照。其他确实需要分别读取的分支仍保留。

`Response.clone()` 的慢分支可以无上限积压，这是 Fetch 流的语义，不能把 clone 当作零成本的元数据复制。参见 [MDN Response.clone](https://developer.mozilla.org/en-US/docs/Web/API/Response/clone)。

### 4. 会话监控合并并发刷新并提前分页

多个监控页面同时遇到 2 秒缓存过期，会重复执行全量 Redis ID 扫描和 PostgreSQL 聚合。共享进行中的加载任务后，同一 worker 同类查询只执行一次；每位调用者仍独立进行权限过滤和实时并发状态查询。缓存失效或更新后，旧查询不得覆盖较新的缓存。

分页只构造当前页会话明细，不再为所有会话生成 provider/model 拼接字符串及展示对象。数据库聚合仍读取完整候选集合；本次没有把该机制描述为数据库层分页。

### 5. Redis 故障时保留单例并递增退避

旧逻辑重试 5 次后结束并清空单例，下一个业务请求立即新建连接并从短间隔重试，故障时间越长、流量越高，反复连接和日志开销越大。

现在保留一个 reconnecting 客户端，指数退避至最多 30 秒，恢复不依赖下一条用户请求。离线命令队列仍关闭，未完成命令仍不在重连后补发，业务保持原有快速降级语义。未引入请求准入门禁。

参见 [ioredis 自动重连与离线队列](https://github.com/redis/ioredis#auto-reconnect)。

## 参考 sub2api 的具体做法

参考本机已存在的 sub2api 源码，采用其“有界读取、明确流所有权、及时释放”的实现原则；未复制整个网关架构，也未把 Go 运行时等同于自动解决泄漏。

- `backend/internal/service/openai_gateway_cc_pipeline.go`：SSE Scanner 增量读取、非流式 `io.LimitReader`。
- `backend/internal/service/openai_gateway_anthropic_native_pump.go`：单一读取泵传递流事件。
- `backend/internal/service/openai_apikey_responses_probe.go`：探测响应有明确读取上限。

本项目大响应采用继续透传，保留现有兼容性；不直接照搬拒绝超限正文的策略。

## 验收和长期运行

本机 Node 26.12.1 / Bun 1.4.3 验证：生产 build、lint、lint:fix、typecheck、OpenAPI 检查通过；全量 Vitest 928 个文件通过、2 个跳过，9459 项通过、13 项跳过。流缓冲/有界预读新模块行覆盖率 100%、分支 95.65%；会话缓存行覆盖率 98.68%、分支 84.84%；均固化 80% 阈值。CI 调度器 15 项单测通过，覆盖率 99%。acer 优先构建和强制不可达主机后的本机回退均完成真实 smoke 镜像导出。完整应用压力和发布结果在后续验收记录及 PR 中补充。关键验收包含原/新实现数据一致、SSE CRLF 跨块、取消与错误释放、非流式超限背压、缓存失效竞态、多用户隔离和分页边界。

压力测试分两层：纯 Node 对照精确测量已消费 backing store；隔离应用使用已有 `tests/load/issue-1408-replay-oom` 模拟上游，验证客户端断开后的后台任务/连接/内存恢复。不可向真实供应商或生产容器发送压力流量。

长期运行应记录 heapUsed、external、arrayBuffers、RSS、活跃请求/后台任务数、Redis 内存和 cgroup memory，比较多轮流量结束后的基线。只有业务负载相同、请求终态完成且静默一段时间后仍阶梯式增长，才进一步抓取堆快照分析保留链。

## 协作与构建

技术负责人负责证据边界与集成；产品经理定义可用性和计费验收；后端负责流所有权和缓冲；前端负责监控请求及分页；测试负责对照、取消、权限和覆盖率；DevOps 负责专用 runner、acer 优先与本机回退。

完整构建使用提交中的 `bun.lock`，避免本机与 acer 解析出不同依赖。本机专用 runner 调度 acer-server；SSH、测试或构建失败时回退本机，GitHub hosted runner 接收已构建镜像并推送 GHCR。外部 PR 不执行私有网络 runner。具体使用方法见 [CI 运维文档](../../.github/CI_CD_SETUP.md)。
