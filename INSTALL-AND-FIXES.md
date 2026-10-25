# DSH Qoder Connect — 本机升级记录

> 这份文档只记录**本机 fork 跟上游**的过程与踩过的坑。
> 插件本身的功能说明见 [README.md](README.md)。
> 记录起点：**2026-10-25**，升级到上游 `0.2.10`（DSH 内核 `0.2.1-rc.2`）。

---

## 一、本机布局

```
上游 masknull/dsh-qoder-connect        （git remote: origin）
        │
你的 fork Xin-zimu/dsh-qoder-connect   （git remote: fork）
        │  clone
        ▼
C:\Users\86139\Documents\Qoder\2026-10-09\2ba9efb1\dsh-qoder-connect
        │  ← 唯一改代码的地方；lib/ 构建产物也提交在此
        │
        │  Junction
        ▼
C:\Users\86139\.dsh\profiles\desktop\node_modules\dsh-qoder-connect
        │
        │  由 profile 的 dsh.profile.bundles 列出才会加载
        ▼
DSH 运行时
```

与 dsh-workbuddy-connect 不同，这里 `origin` 就是**上游**，fork 是 `fork` 这个 remote。跟上游用 `git fetch origin`，推送自己的改动用 `git push fork`。

---

## 二、升级流程

```powershell
cd "C:\Users\86139\Documents\Qoder\2026-10-09\2ba9efb1\dsh-qoder-connect"

git fetch origin --tags
git log --oneline -12 origin/main          # 看有哪些新提交
git checkout -b merge/<版本号>
git merge origin/main --no-commit --no-ff
git diff --name-only --diff-filter=U       # 看冲突
```

### 2.1 网络：代理端口会变

本机 git 配了 `http.proxy = http://127.0.0.1:7892`，但 **2026-10-25 那次该端口已失效，实际代理在 7890**。

```powershell
# 先探测
Test-NetConnection 127.0.0.1 -Port 7892 -InformationLevel Quiet
Test-NetConnection 127.0.0.1 -Port 7890 -InformationLevel Quiet
```

临时绕过（不改全局配置）：

```powershell
git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 fetch origin --tags
```

> 报错形如 `Failed to connect to 127.0.0.1 port 7892`，别误判为 GitHub 不通——
> `Test-NetConnection github.com -Port 443` 可能仍然 `True`，问题只在代理端口。

---

## 三、本机裸坑：`core.autocrlf=true` 让合并出现"整文件冲突"

**症状**：`git merge` 报 `src/index.ts` 的**全部 1917 行**都是冲突，冲突块有 103 个，但绝大多数只是注释改写。

**根因**：本机 `core.autocrlf=true`，检出时把 LF 换成 CRLF；上游提交的是 LF。
git 逐行比较时**每一行都不同**，于是整个文件被判为冲突，真正的几个 hunk 反而被噪声淹没了。

**修法**：加 `.gitattributes` 钉死 LF，再做一次 renormalize。

```
* text=auto eol=lf
*.png binary
...
```

```powershell
git add .gitattributes
git add --renormalize .
git commit -m "chore: pin LF line endings so merges show real conflicts"
```

> **教训**：合并前先看 `git diff --stat` 的增删数量。若某文件"几乎每行都改了"而它不该有这么大改动，
> 先怀疑行尾，而不是去逐块解冲突——那 103 个块里有 102 个是假的。

---

## 四、冲突处理的判据：先问"上游是不是已经用别的方案解决了"

这次合并最有价值的发现：**上游和 fork 各自修了同一批 bug，但方案相反**。
直接按"保留 fork 修复"的习惯做，会把已经过时的代码重新塞回去。

逐条核对（`git show <fork提交> -- <文件>` 对比 `git show origin/main:<文件>`）后得到的结论：

| fork 的修复 | 上游 0.2.10 | 处理 |
|---|---|---|
| 工具调用参数**修补**（`tool-arguments.ts`，未提交） | v0.2.9-alpha.4 **删掉**传输层判断，参数原样交给工具层报错让模型重试 | **丢弃 fork 方案** |
| `shim` 中途失败发 SSE error 帧 | 上游同时处理空流与截断，且分 `forwardedChunks` 两支 | **取上游**（是 fork 的超集） |
| `cosy` 的 macOS 误报为 linux | 上游改为 `${arch}_${process.platform}`，天然正确 | **取上游**，删掉 `qoderMachineOsFor` |
| `bin` 的 `pat set <TOKEN>` 位置参数 | 上游在解析阶段 `rest.shift()` 消费，更彻底 | **取上游** |
| `serialize` 丢弃 `temperature`/`stop` | **仍然丢弃** | **保留 fork** |
| `auth` 的 `expires_in` 单位判定 | **仍当毫秒** | **保留 fork** |
| `index` 的目录重试退避时钟 | **仍只读成功时钟** | **保留 fork** |
| `probe-route` 的 500 响应脱敏 | **仍然原样回显** | **保留 fork** |
| `shim` 的 `[DONE]` 跨 chunk 边界 | **仍是 `chunk.includes`** | **保留 fork** |

> **判据**：不是"谁更新"，而是**"上游有没有修、修的是不是同一个缺陷"**。
> 上游修了且更好 → 让位；上游没修 → 留下；上游用相反策略 → 跟上游，否则两条路线会长期打架。

### 4.1 被丢弃的 WIP 怎么处理

本机有一批**从未提交**的 tool-arguments 改动（含 2 个未跟踪文件）。
不要直接 `git checkout .` 丢掉——先备份：

```powershell
git diff > "$backup\uncommitted-tracked.patch"
# 未跟踪文件单独复制
```

然后**提交成一个标注为 superseded 的提交**，这样历史里查得到、将来要找回也不用翻备份。

---

## 五、测试的适配：断言"真实观测点"，而不是内部函数

上游重构掉 `qoderMachineOsFor` 之后，fork 的 `tests/qoder/cosy.test.ts` 直接 import 失败（整个文件 1 个 case 全挂）。

**不要**把测试删掉了事，也不要为了测试保留一个已无用的导出。
改成断言**上游实际发出去的那个 header**：

```ts
const headers = buildAuthHeaders(...)
const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch
assert.equal(headers['Cosy-Machineos'], `${arch}_${process.platform}`)
```

这样既守住了原来那个"macOS 不能报成 linux"的承诺，又不会在下次重构时再断一次。

---

## 六、验证四件套

```powershell
$node = "C:\Users\86139\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
cd "C:\Users\86139\Documents\Qoder\2026-10-09\2ba9efb1\dsh-qoder-connect"

# 1) 类型检查（两份 tsconfig）
& $node ".\node_modules\typescript\bin\tsc" -p tsconfig.json
& $node ".\node_modules\typescript\bin\tsc" -p tsconfig.client.json

# 2) vitest（tests/**/*.spec.ts）
& $node ".\node_modules\vitest\vitest.mjs" run

# 3) Qoder 传输层（tests/qoder/*.test.ts，node --test）
& $node --test "tests/qoder/*.test.ts"

# 4) 重建 lib/（必须，因为 lib/ 要提交）
& $node ".\node_modules\tsdown\dist\run.mjs"
```

基线（0.2.10，2026-10-25）：**vitest 607 passed**（34 文件）、**qoder 190 passed**、tsc 两份均 0。

> 直接调 `node` / `run.mjs`，**不要用 `pnpm run <script>`**：它会先做 deps-status 检查并可能触发 install。

### 6.1 构建后核对版本号

`lib/` 里带着构建期注入的版本常量，`tests/version.spec.ts` 会断言它与 `package.json` 一致：

```powershell
Get-ChildItem lib -Filter *.js | Select-String -Pattern 'QODER_CONNECT_VERSION\s*=\s*"[^"]+"' |
    ForEach-Object { "$($_.Filename): $($_.Line.Trim())" }
```

---

## 七、自检与"是否已加载"

```powershell
& $node "$prof\node_modules\dsh-qoder-connect\lib\bin.js" doctor
```

```
Qoder Connect 0.2.10 on v24.21.0
Region: china
Credential: configured (card, tail …881c)
Host bundle: not started      ← 见下
Static fallback models: 6
```

### 7.1 `Host bundle: not started` 的两种含义

它读的是心跳文件 `<profile>\.dsh-qoder-connect\state\.qoder-host-heartbeat.json`。

| 现象 | 含义 |
|---|---|
| 心跳文件**不存在或时间戳早于 lib/ 的修改时间** | 换完代码**还没重启 DSH**，运行中的是旧代码 |
| 心跳文件存在且很新，但 doctor 仍说 not started | 插件真的没被加载，按 7.2 排查 |

判断依据是进程启动时间：`Get-Process -Name "DeepSeek Harness" | Select Id,StartTime`。
若启动时间早于你完成合并的时间，那就是"尚未重启"，不是故障。

### 7.2 该看的三处（顺序别颠倒）

1. `profile\package.json` 的 `dsh.profile.bundles` 里有没有 `dsh-qoder-connect` ← **先看这个**
2. junction 是否存在、`Target` 是否指向仓库
3. `dependencies` 里的 `link:` 路径对不对

### 7.3 peer 自检（0.2.10 新增）

0.2.10 起插件在 `apply()` 时**自己解析** profile 里实际会加载的 `dsh-llm` / `pi-ai` 副本，
拿 `package.json` 的 `peerDependencies` 去比，不满足就在卡片上报告而不是崩在第一轮。

复刻这个判断（本机内核 `0.2.1-rc.2`）：

```powershell
# 七个 DSH service peer 的区间都是 >=0.2.1-rc.1，rc.2 满足
# 注意 semver 要带 includePrerelease: true，否则预发布版全被判不满足
```

实测结论：**7 个 peer 全部 OK，0 个不满足**，不会因 peer 被拒载。

> 注意 devDependencies 装的是 `0.2.1-rc.1`（因为区间是 `>=0.2.1-rc.1`），
> 而宿主内核是 rc.2。这**不是问题**：那些包在运行时由宿主提供，
> 本地副本只用于 `tsc` 的类型检查，且 rc.1 的类型面是 rc.2 的子集。
> 真要本地完全对齐，可把 devDeps 固定成 rc.2 再跑一遍四件套。

---

## 八、提交与推送

```powershell
git add -A
git commit -F .git\MERGE-MSG.txt     # PowerShell 没有 heredoc，用文件传多行信息
```

> **PowerShell 注意**：`git commit -F - <<'MSG'` 这种 bash heredoc **不能用**，
> 会报 `Missing file specification after redirection operator`。写成临时文件再 `-F`。

推送：

```powershell
git push fork main                    # 更新你自己的 fork
```

---

## 附：版本对应

| DSH 内核 | 插件版本 | 备注 |
|---|---|---|
| `0.2.1-rc.2` | `0.2.10`（当前） | peer 区间 `>=0.2.1-rc.1`，rc.2 满足 |
| `0.2.1-rc.x` | `0.2.9` ~ `0.2.10` | 传输层不再判断工具参数（v0.2.9-alpha.4 起） |
| `0.1.6` / `0.1.7` | `0.2.3-alpha.1`（本 fork 起点） | 升级前状态 |

## 附：本轮提交

| 提交 | 内容 |
|---|---|
| `29fef1b` | 把未提交的工具参数修补存成 superseded 提交（仅留档） |
| `1d2f1f3` | `.gitattributes` 钉 LF + 全仓 renormalize |
| `a41a09a` | 合并上游 `0.2.10`：丢弃 3 项已被上游取代的修复，保留 5 项上游仍未修的 |
