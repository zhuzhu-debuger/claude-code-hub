# 构建、测试和镜像发布

本仓库的镜像地址为 `ghcr.io/zhuzhu-debuger/claude-code-hub`。

## 执行链路

1. 专用本机 runner `cch-mac-builder` 接收已推送分支的构建任务。
2. `scripts/ci/build.py` 对当前提交执行 `git archive`，经 SSH 发送给 `acer-server`。
3. acer 运行独立的检查、PostgreSQL、Redis 和应用容器，执行代码检查、单元测试、v1 合约测试、数据库集成测试、生产构建和 E2E 测试。
4. SSH 连接、测试、构建或产物传输失败时，本机 Docker 从同一提交重新执行完整流程。每台机器最多执行 60 分钟；两边都失败则不发布。
5. 测试通过后导出压缩镜像、SHA-256 和构建信息。GitHub hosted runner 下载并校验这些产物，然后执行 `docker load/tag/push` 上传 GHCR，不执行依赖安装或镜像构建。
6. 发布完成删除中转 artifact；失败时保留一天便于重试和排查。本地临时镜像、测试容器、网络及源码目录会清理，BuildKit 缓存保留供后续构建复用。

只上传镜像及构建信息到 GitHub artifact；本机 `.env`、Git 凭据、生产数据和未提交内容不会进入源码快照。新源码修改必须先提交，之后运行本地 CI 才会包含它们。镜像默认构建 `linux/amd64`，与 acer/生产服务器一致；Mac 回退时采用 Docker Desktop 的目标架构模拟，避免把 ARM 原生依赖复制进 x86 镜像。

使用本机 runner 调度 SSH，能立即识别 acer 离线并回退，避免将首个 job 直接绑定离线 acer runner 后一直排队。Mac 必须开机且 runner 与 Docker Desktop 在线；如果 Mac 也不可用，任务会等待，不会改用收费的 hosted 构建。[GitHub self-hosted queue limits](https://docs.github.com/en/actions/reference/limits)

## 工作流

| 文件 | 触发 | 行为 |
| --- | --- | --- |
| `dev.yml` | 非 main 分支 push / 手动 | 完整测试、构建，发布分支标签及分支与提交号标签 |
| `release.yml` | main push / v* tag / 手动 | 完整测试、构建并发布；main 和稳定版本标签更新 latest |
| `test.yml` | 手动 | `check` 运行完整验证但不发布；`smoke` 验证 SSH、回退、镜像导出和 artifact 传输 |
| `pr-check.yml` | 向 dev/main 的 PR | 只报告验证方式，不检出或执行 PR 代码 |
| `build-image.yml` | 被以上工作流调用 | 复用构建与 GHCR 上传逻辑 |

同仓库分支由 push 工作流验证，避免 PR 再重复构建。外部 fork PR 不会自动在私有主机执行；维护者审查代码后，可将其推送为本仓库分支来执行完整测试。PR metadata check 通过只表示元数据检查完成，不能代替完整构建结果；合并前应检查对应 push 构建。

不再自动格式化并向分支提交代码，也不再自动升级版本或删除历史 tag/release。正式发布由维护者创建版本 tag，例如 `v0.9.9`，稳定 tag 产生 `v0.9.9` 与 `latest` 镜像。普通 main push 更新 `main`、`latest` 与 `main-<sha>`，开发分支产生 `<branch>` 与 `<branch>-<sha>`。所有 PR 继续以 `dev` 为目标分支。

原有 Claude/Codex issue、review、文档和自动修复工作流默认关闭；当前 fork 的旧工作流也已在 GitHub Actions 设置中停用，避免 PR 使用尚未合并的旧默认分支配置。需要时先在 Actions 中重新启用所需工作流，再设置仓库变量 `ENABLE_AI_AUTOMATION=true` 并配置对应凭据。默认构建链路不需要这些服务。

## 安装与配置

Mac 需要 Python 3.9+、Git、SSH、Docker Desktop 和已登录的 GitHub CLI。创建专用 runner：

```bash
bash scripts/ci/install-macos-runner.sh zhuzhu-debuger/claude-code-hub
```

安装位置为 `~/.local/share/claude-code-hub-runner`，标签为 `self-hosted, macOS, ARM64, cch-local`，通过 launchd 常驻运行。脚本会校验 GitHub 官方 runner 下载包 SHA-256，已注册的 runner 会保持原样，不影响其他仓库的 runner。

`~/.ssh/config` 中配置可免交互登录的 `acer-server` 别名；仓库变量 `CCH_BUILD_HOST` 可覆盖该别名。首次安装时人工确认 SSH 主机指纹。构建脚本不会关闭 SSH 主机校验。

acer 需要 Docker、Buildx、Python/Git 非必需、GNU `timeout`、`setsid`、tar 和 gzip。构建工具与应用依赖全部来自固定版本容器和已提交的 `bun.lock`。

如 acer 的出网必须经过本机代理，在 acer 创建私有配置：

```bash
mkdir -p ~/.config/claude-code-hub
printf '%s\n' 'export CCH_BUILD_PROXY=http://127.0.0.1:7897' > ~/.config/claude-code-hub/ci.env
chmod 600 ~/.config/claude-code-hub/ci.env
```

配置只影响 `cch-ci` 专用 BuildKit，不修改 Docker daemon、系统 DNS 或其他项目 builder。代理地址改变时，在没有构建运行的情况下执行 `docker buildx rm cch-ci`，下次构建会按新配置重建。不要把含账号密码的代理 URL 写入仓库。

Mac 的后台 runner 可能无法访问 Docker Desktop 的钥匙串凭据，从而卡在 `docker-credential-desktop get`。构建只拉取公共基础镜像，可为本项目创建不含凭据助手的 Docker CLI 配置，并继续连接已有 Docker Desktop socket：

```bash
mkdir -p ~/.config/claude-code-hub/docker
python3 - <<'PY'
import json
from pathlib import Path
config = Path.home() / ".config/claude-code-hub/docker/config.json"
config.write_text(json.dumps({
    "auths": {},
    "cliPluginsExtraDirs": [str(Path.home() / ".docker/cli-plugins")],
}))
PY
```

在 Mac 的 `~/.config/claude-code-hub/ci.env` 中加入以下两行；如需出网代理，再添加指向本机实际 HTTP 代理的 `HTTP_PROXY` 和 `HTTPS_PROXY`。Mac 的此配置与 acer 的 `CCH_BUILD_PROXY` 独立，不改变其他项目的 Docker 登录或网络设置。

```bash
export DOCKER_CONFIG="$HOME/.config/claude-code-hub/docker"
export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
```

GHCR 上传使用 GitHub 自动提供的 `GITHUB_TOKEN`，仅 hosted 发布 job 具有 `packages: write`。本机和 acer 不需要存储 GHCR 发布凭据。仓库需启用 Actions，并允许 workflow 写入 Packages。首次发布后可在 GitHub Packages 中按需设置镜像可见性。

## 本地执行与验证

```bash
# 构建当前已提交版本；优先 acer，失败回退本机
python3 scripts/ci/build.py --output /tmp/cch-image

# 仅验证完整流程，不导出镜像
python3 scripts/ci/build.py --mode check --output /tmp/cch-check

# 快速验证调度、Docker 构建和镜像导出
python3 scripts/ci/build.py --mode smoke --output /tmp/cch-smoke

# 明确验证离线回退路径
python3 scripts/ci/build.py --mode smoke --host unavailable.invalid --output /tmp/cch-fallback

# 调度器单测
python3 -m unittest discover -s scripts/ci -p 'test_*.py' -v
```

构建日志会明确记录首选主机失败原因，`build.json` 记录实际完成主机、提交号和目标架构。测试数据库仅位于每次构建的专属 Docker 网络，不发布到宿主端口，容器退出时删除。该流程不会连接或部署 43 服务器。
