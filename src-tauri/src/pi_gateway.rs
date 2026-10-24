//! Multi-instance stdio adapter for `pi --mode rpc`.
//!
//! Helix speaks the Helix `session/*` API in its renderer. This module adapts
//! that API to the pi coding agent's JSONL RPC protocol (`pi --mode rpc`):
//! prompt/abort/new_session/switch_session commands plus event translation
//! (message_update / tool_execution_* / agent_settled) into the `session/update`
//! shapes the frontend already consumes. No frontend changes required.
//!
//! Differences from the legacy ACP adapter:
//! - pi has a single active session per process → each Helix conversation
//!   gets its OWN pi child process (`PiInstance`), so conversations run in
//!   parallel without clobbering each other's active session.
//! - pi tools run without an approval policy (pi's extension UI protocol is
//!   forwarded as `permission_request` when an extension asks the user).
//! - session/set_mode is translated into plan-mode extension commands.
//!
//! Instance routing: every session-scoped RPC the frontend sends carries
//! `session_id` (= the pi session id returned by session/new). That id picks
//! the instance. Session-less RPCs (get_commands / set_model / get_state / …)
//! go to the MAIN instance (key ""), which spawns at app startup and serves
//! the global UI surfaces (model list, thinking level, session stats panel).
//!
//! Idle reaping: an instance with no traffic for IDLE_REAP_MS (and not
//! streaming) is killed to bound resource use; pi persists sessions to disk,
//! and the next RPC for a reaped session transparently respawns the instance
//! and restores the conversation via switch_session (from the global
//! SESSION_FILES cache). The reaped instance keeps its map entry (with its
//! cwd + session-file mapping) so the respawn lands in the same project.

use sha2::{Digest, Sha256};
use crate::gateway::emit_helix_event;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::Emitter;

use std::os::windows::process::CommandExt;

/// 子进程句柄。
///
/// `Local` 是传统路径：本进程直接 spawn `pi --mode rpc`，stdio pipe 收发
/// JSONL，pi 的 cwd 由 `Command::current_dir` 指定。
///
/// `Remote` 是远程工作区路径：一条 TCP 连接，对面跑 remote-bridge.js
/// （fork-per-connection：每个连接 exec 一个新的 `pi --mode rpc`）。所以
/// 一条连接 == 一个 pi 实例，和本地的「一会话一子进程」模型同形。
/// 远端 pi 的 cwd 经连接握手行（`cwd:<path>`）下发，而不是 `current_dir`。
/// 远端没有 exit code 概念 —— 连接 EOF 就是实例没了。
enum ChildHandle {
    Local(Child),
    Remote(TcpStream),
}

/// RPC 传输的读写两端。`Local` 是子进程 pipe，`Remote` 是 TcpStream 的 clone，
/// 统一抹成 trait object，reader/writer 线程两边零改动。
type RpcWrite = Box<dyn std::io::Write + Send + Sync + 'static>;
type RpcRead = Box<dyn std::io::Read + Send + Sync + 'static>;

impl ChildHandle {
    /// 终止实例。Local = SIGKILL/TerminateProcess + `wait()` 收尸（保持与
    /// 原实现在 kill() 前 wait 的行为一致，避免 Unix 下留僵尸进程）；
    /// Remote = 断掉 TCP 连接，对面 bridge 随 stdin EOF 退出它 spawn 的 pi
    /// 子进程。Remote 没有 exit code 可等，也不该等 —— 对面挂死时这里
    /// 不能跟着挂，所以 shutdown 后立刻返回。
    fn kill(&mut self) {
        match self {
            Self::Local(c) => {
                let _ = c.kill();
                let _ = c.wait();
            }
            Self::Remote(s) => {
                let _ = s.shutdown(std::net::Shutdown::Both);
            }
        }
    }

    /// Local 子进程是否已退出（退出码）。Remote 无 exit code，恒为 None。
    fn try_wait_status(&mut self) -> Option<std::process::ExitStatus> {
        match self {
            Self::Local(c) => c.try_wait().ok().flatten(),
            Self::Remote(_) => None,
        }
    }
}

const RPC_TIMEOUT: Duration = Duration::from_secs(60);
/// Compaction is a synchronous wait for the model to summarize the ENTIRE
/// context — and it only ever runs when the context is at its largest, so the
/// generic 60s budget times out on big sessions (the "压缩超时" seen from
/// /compact and auto-compaction). 5 min leaves ~60s of the frontend's
/// COMPRESS_RPC_TIMEOUT_MS (360s, serve-gateway.ts) for the trailing
/// get_session_stats / get_messages round-trips in session.compress.
const COMPACT_RPC_TIMEOUT: Duration = Duration::from_secs(300);
/// pi 的 **in-run 自动压缩**（`compaction_start` → `compaction_end`，发生在两
/// 次 assistant 调用之间）本身就是一次完整的 LLM 摘要调用，期间主事件流必然
/// 零帧。压缩窗口内不能按「模型流卡死」中止回合 —— 大上下文正常压缩超过
/// STREAM_SILENCE_TIMEOUT 是常态，这和前端 90s 空闲检测误砍是同一类 bug。
/// 上界取 2x COMPACT_RPC_TIMEOUT：`compaction_end` 真在传输中丢了时，回合仍然
/// 能按 STREAM_SILENCE_TIMEOUT 收敛，而不是挂到 PROMPT_TIMEOUT（一小时）。
const COMPACTION_GUARD_MS: u64 = 600_000;
/// 回合闸门的上界（见 `PiInstance::turn_gate_until_ms`）：中止失步的旧回合后，
/// 旧回合的尾巴事件最多吞掉这么久。新回合的 `agent_start` 正常会在这之前到达并
/// 立即开门；真丢了（或 pi 版本不认 `agent_start`），也绝不永久吞输出。
const TURN_GATE_MS: u64 = 15_000;
/// 武装状态的有效期：中止旧回合到用户真的发出下一条消息之间的空档。超过它就
/// 作废（不能因为半小时前点过一次停止，就让下一条消息吞掉自己的开头）。
const TURN_GATE_ARM_WINDOW_MS: u64 = 30_000;
/// 失步中止后等 pi 自认空闲的预算（见 `session/prompt` 的 already-processing 分支）。
/// abort 命令返回 ≠ 回合已收尾，`agent_end`/`agent_settled` 还在路上；不等就重发
/// 会再次撞上 "already processing"。
const DESYNC_SETTLE_BUDGET: Duration = Duration::from_secs(3);
/// Handshake (get_state on a fresh spawn) allowance. pi answers get_state
/// only after ALL extensions finish initializing; heavyweight extensions
/// (e.g. the memory extension's SQLite backfill) may legitimately block for
/// minutes under lock contention (its own busy_timeout is 120s, lock
/// takeover 300s). Killing at RPC_TIMEOUT loses that wait and restarts it
/// from scratch, so the handshake gets a longer budget than a normal RPC.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(150);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// Idle instance reaping: no RPC traffic for this long (and not streaming)
/// → kill the child. The next RPC respawns it and restores the session.
const IDLE_REAP_MS: u64 = 15 * 60 * 1000;
/// How often the reaper sweeps instances.
const REAP_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
/// Model-stream watchdog: if a turn is unsettled, no tool is executing and
/// no extension UI card is pending, yet pi has produced NO event for this
/// long, the model stream is considered wedged (free-tier upstreams do
/// silently drop SSE streams). The turn is aborted instead of holding the
/// UI in "工作中" until PROMPT_TIMEOUT (an hour).
/// 300s：实际观测到 agnes 等上游在工具调用后的下一次生成可能静默 3 分钟以上
/// 才出流（180s 时误杀过两次，196s/199s 被中止）。放宽到 5 分钟。
const STREAM_SILENCE_TIMEOUT: Duration = Duration::from_secs(300);
/// How often turn-wait loops re-check the watchdog between PROMPT_TIMEOUT
/// deadlines.
const WATCHDOG_TICK: Duration = Duration::from_secs(30);


static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// pi session id → session file path. GLOBAL (outside instances) so it
/// survives instance reaping/restarts — a respawned conversation restores
/// via switch_session(file).
static SESSION_FILES: std::sync::LazyLock<Mutex<HashMap<String, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
/// 网关存活期间、确认过「sid 的 jsonl 曾经真实存在于磁盘」的 sid 集合。pi 的
/// jsonl 是**惰性创建**的：直到第一条 user/assistant 消息 persist 才落盘
///（bundle 的 `_persist` 里有 `_hasConversation()` 门槛），所以新会话的早期
/// prompt 在文件不存在时完全合法。而文件一旦落盘过又被人为删除，pi 对活实例
/// 的后续写入走 `appendFileSync`，它会在原路径旁路重建出只剩新内容的 jsonl =
/// 用户看到的「静默新建会话文件」。因此：prompt 路由前如果磁盘上还能找到该
/// sid 的文件 → 记入本集合；找不到且已在集合（= 曾经存在、现在没了）→ 按
/// session_not_found 拒绝，前端据此把会话锁死。从不误伤全新会话（文件从未
/// 出现过 → 不在集合 → 放行）。
static FILE_SEEN_SIDS: std::sync::LazyLock<Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));
/// Live instances: key = pi session id ("" for the main instance, or a
/// "pending-N" placeholder between spawn and new_session).
static INSTANCES: std::sync::LazyLock<Mutex<HashMap<String, Arc<PiInstance>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
/// extension_ui_request id → instance key. Approval/clarify responses from
/// the renderer carry only the request id (the Tauri `helix_approval_respond`
/// command has no session context) — this maps the id back to its instance.
static UI_REQUEST_OWNERS: std::sync::LazyLock<Mutex<HashMap<String, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
/// Pre-warmed spare instances, handshaked and idle — session/new claims one
/// instead of paying pi's cold start (node boot + extension/MCP load, easily
/// 10s+ on Windows) inside the user-visible "工作中" phase. Spares run with
/// the GLOBAL work dir; a session/new with a different per-conversation cwd
/// falls back to an on-demand spawn.
static WARM_SPARES: std::sync::LazyLock<Mutex<Vec<Arc<PiInstance>>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));
static LIFECYCLE_LOCK: std::sync::LazyLock<Mutex<()>> = std::sync::LazyLock::new(|| Mutex::new(()));
/// How many spares to keep warm.
const WARM_SPARE_COUNT: usize = 1;
/// 已派发、还在握手的补热数量。池子里的备件要 17-27s 才出现，只比 `spares.len()`
/// 会让每个并发调用都以为位子空着（见 `rearm_warm_spares`）。
static SPARE_INFLIGHT: AtomicUsize = AtomicUsize::new(0);

/// 归还一个补热位子；所有退出路径（含 panic 展开）都算。
struct SpareReservation;

impl Drop for SpareReservation {
    fn drop(&mut self) {
        SPARE_INFLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}
/// Context-token safety margin below the model window for the restore-time
/// trim: the trimmed session must leave room for the user's next prompt AND
/// the model's reply, not merely squeeze under the window.
pub const TRIM_MARGIN_TOKENS: i64 = 16 * 1024;
/// In-flight session restores, keyed by session id. Resume = spawn (or spare
/// claim) + switch_session, which scales with session length; two concurrent
/// resumes of the SAME session (e.g. background prepare + the user's first
/// prompt) would each claim their own pi process and race switch_session on
/// the shared jsonl. Single-flight: the second caller reuses the first's work.
static RESUME_LOCKS: std::sync::LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// How a pending command's response is delivered: tokio oneshot for async
/// callers, std mpsc for sync callers (spawn paths run on plain threads or
/// the main thread where blocking_recv would not work uniformly).
enum Responder {
    Async(tokio::sync::oneshot::Sender<Value>),
    Sync(std::sync::mpsc::Sender<Value>),
}

impl Responder {
    fn deliver(self, message: Value) {
        match self {
            Responder::Async(tx) => {
                let _ = tx.send(message);
            }
            Responder::Sync(tx) => {
                let _ = tx.send(message);
            }
        }
    }
}

struct PendingRequest {
    tx: Responder,
}

struct TurnWaiter {
    tx: tokio::sync::oneshot::Sender<Value>,
}

struct PendingUI {
    method: String,
    /// pi-permission 的 rpc 审批弹窗（select）。只有它会被自动作废 —— 见
    /// [`evict_settled_permission_asks`]。
    permission: bool,
    /// 这条审批弹窗正挡在 `prepareToolCall` 里的哪个工具调用（只有
    /// `permission == true` 才记，见 [`PiInstance::preparing_tool`]）。用户答完
    /// 的那一刻就是那次调用真正开跑的时刻。
    blocking_tool: Option<String>,
}

/// pi-permission rpc 审批弹窗标题首行（approval.ts `formatTitle`，选项固定为
/// Appr/Deny 两个）。扩展被 `pi update --extensions` 还原或以后改文案时这里会
/// 失配 —— 失配只会让自动作废静默失效（退回人工点卡），不会误关别的扩展的 select。
const PERMISSION_TITLE_PREFIX: &str = "[pi-permission]";

/// 该 UI 请求是否 pi-permission 的竞速审批弹窗。
fn is_permission_ui_request(method: &str, title: Option<&str>) -> bool {
    method == "select" && title.is_some_and(|t| t.starts_with(PERMISSION_TITLE_PREFIX))
}

/// 审批 / 澄清弹窗文本的 toast 摘要：丢掉 pi-permission 的固定抬头行
/// （approval.ts `formatTitle` 首行，与 PERMISSION_TITLE_PREFIX 同一个失配面）
/// 与空行，留下 Tool / Command / Reason 等实质内容。
fn dialog_toast_body(raw: &str) -> String {
    let lines: Vec<&str> = raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && *l != "[pi-permission] Approval required")
        .collect();
    if lines.is_empty() {
        raw.trim().to_string()
    } else {
        lines.join("\n")
    }
}

/// 摘除全部已标记的审批请求，返回它们的 id（纯函数，便于单测）。
fn take_permission_asks(map: &mut HashMap<String, PendingUI>) -> Vec<String> {
    let ids: Vec<String> = map
        .iter()
        .filter(|(_, p)| p.permission)
        .map(|(id, _)| id.clone())
        .collect();
    for id in &ids {
        map.remove(id);
    }
    ids
}

/// 作废本实例所有仍挂着的 pi-permission 审批弹窗 —— 仅在网关能**推导出**
/// 它们已被 pi 判定完毕时调用：
///
///  - 非嵌套 `tool_execution_start`：pi 对每条工具调用**先发 start 再 await 钩子**
///    （prepareToolCall 里跑 pi-permission 的竞速弹窗），且 start/prepare 严格
///    串行、按序 —— 第 k+1 次 start 只在第 k 次钩子返回后才发出（pi-agent-core/
///    dist/agent-loop.js 两条执行路径都是这个次序：parallel 路径只把「执行」推迟
///    并发，prepare 仍串行）。所以此刻仍挂着的弹窗，其钩子必然已返回：要么
///    AI 赢了竞速（僵尸 —— pi 侧 abort 只本地 resolve/删 id，宿主收不到任何消息，
///    见 rpc-mode.js `createDialogPromise` 的 onAbort），要么用户已答（前端已关，
///    幂等）。还活着的弹窗（AI 判定中/等用户点）对应一个未返回的钩子，此时后续
///    start 事件根本不存在 —— 不会误关。
///  - 非嵌套 `tool_execution_update` / `tool_execution_end`：执行期事件只在对应
///    调用的 prepare 返回后发出，同上推理 —— 让「本轮最后一个工具/单工具消息」
///    的僵尸在工具跑完（或首次输出）时就关掉，不必等 `agent_settled`。
///  - `agent_settled`：turn 结束 ⇒ 不存在未返回的工具钩子（阻塞的钩子会让 turn
///    无法 settle；用户停止时 pi 同样静默 abort 弹窗）。覆盖「本轮最后一个工具」
///    与停止残局。
///
/// 嵌套调用（codemode `ctx.executeTool`，事件带 parentToolCallId）可能并发跑钩子，
/// 不套用这条推理，调用点会跳过。作废只清本地状态并通知前端出队，**不给 pi 发任何
/// 响应** —— pi 侧那些 id 早已删除，回了也会被静默丢弃（rpc-mode.js 未知 id 直接
/// return）。
fn evict_settled_permission_asks(instance: &PiInstance, reason: &str) {
    let ids = {
        let mut reqs = instance.ui_requests.lock().unwrap();
        take_permission_asks(&mut reqs)
    };
    if ids.is_empty() {
        return;
    }
    {
        let mut owners = UI_REQUEST_OWNERS.lock().unwrap();
        for id in &ids {
            owners.remove(id);
        }
    }
    let sid = instance
        .current_session
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| instance.key());
    log_spawn_diag(&format!(
        "evict_permission_asks sid={} reason={} ids={}",
        sid,
        reason,
        ids.join(",")
    ));
    for id in ids {
        emit_helix_event(
            "session/update",
            &json!({
                "session_id": sid,
                "update": {
                    "sessionUpdate": "clarify_settled",
                    "requestId": id,
                    "reason": reason,
                },
            }),
        );
    }
}

/// One `pi --mode rpc` child process plus its per-process state. All state
/// that the old single-process design kept in file statics lives here, per
/// instance, so parallel conversations are fully isolated.
pub struct PiInstance {
    /// Map key: pi session id, "" for the main instance, or a "pending-N"
    /// placeholder before session/new returns the real id.
    key: Mutex<String>,
    /// cwd this instance's pi process runs in (per-conversation project dir;
    /// None = follow the global work_dir on each spawn).
    ///
    /// 远程实例里这个字段是**远端**绝对路径（`/home/user/proj`），本机磁盘上并不
    /// 存在 —— 绝不能拿它去 `create_dir_all` 或本地 `current_dir`。
    cwd: Mutex<Option<String>>,
    /// 这个实例的 pi 跑在远端（经 SSH 隧道连 remote-bridge.js），而不是本机子进程。
    /// 决定 `spawn_process` 走哪条通道 —— 双通道的关键：**不能**再看全局
    /// `pi.remote_rpc` 是否配置，否则隧道一开，本地项目的对话也会被搬到远端去跑。
    remote: AtomicBool,
    /// 本实例被 Helix 自己 `kill()` 过（重启清场 / idle reaper / 弃用备件）。
    /// kill() 和 reader 的死亡簿记都会清 pending，于是 in-flight 请求拿到的
    /// 断连在文本上与「子进程崩了」完全一样 —— 冷启动重试分支靠文本判断，
    /// 没有这一位就会把一次正常清场当成崩溃去重生子进程（约 12s 白等），远程
    /// 实例上还会误触发 30s 的 `mark_remote_down` 冷却。`spawn_process` 复位。
    killed_by_us: AtomicBool,
    writer: Mutex<Option<mpsc::Sender<String>>>,
    /// pi command ids → pending responders.
    pending: Mutex<HashMap<String, PendingRequest>>,
    child: Mutex<Option<ChildHandle>>,
    /// Current pi session id of THIS process — stamped onto emitted events.
    current_session: Mutex<Option<String>>,
    /// Pending extension UI requests (confirm/select/input/editor).
    ui_requests: Mutex<HashMap<String, PendingUI>>,
    /// Single in-flight turn waiter (one turn at a time per process).
    turn_waiter: Mutex<Option<TurnWaiter>>,
    /// Set when session/cancel releases the waiter so agent_settled (which
    /// still fires after abort) does not double-emit session/complete.
    turn_cancelled: AtomicBool,
    /// Fire-and-forget turns outstanding (seed history replay, /plan arm).
    /// These queue NO turn_waiter, but pi serializes them AHEAD of the
    /// caller's real prompt: the seed turn's agent_settled fires while the
    /// real prompt's waiter is already registered, releasing it early and
    /// emitting a premature session/complete — the frontend run then ends
    /// with empty output while the real turn still executes headless
    /// ("重启后旧对话一直不输出"). Each queued turn increments the debt;
    /// agent_settled consumes one before touching the waiter, so settles
    /// belonging to fire-and-forget turns never release a real turn.
    /// 旁路回合同样占着这个实例，所以它是 `streaming` 的判据之一
    /// （见 `sync_streaming_flag`），登记/注销都走 `begin_debt_turn`/`end_debt_turn`。
    turn_debt: AtomicU64,
    /// 回合归属闸门（见 `arm_turn_gate` / `turn_gate_active`）：
    /// `turn_gate_armed_until_ms` = 已请求闸门（中止了旧回合，下一条 prompt 来领），
    /// `turn_gate_until_ms` = 本回合正在吞旧回合的残留事件。
    turn_gate_armed_until_ms: AtomicU64,
    turn_gate_until_ms: AtomicU64,
    /// Buffered tool-call argument deltas, toolCallId → args string.
    tool_args: Mutex<HashMap<String, String>>,
    /// Args of EXECUTING tools, toolCallId → parsed args. tool_execution_start
    /// carries them, but tool_execution_end does not — needed there to
    /// synthesize a patch for `write` (pi's write result has no details).
    exec_tool_args: Mutex<HashMap<String, Value>>,
    /// 此刻正卡在 `prepareToolCall` 里的那个**非嵌套**工具调用 id。
    ///
    /// 依据：pi 对每条调用先发 `tool_execution_start` 再 await prepare，且
    /// start/prepare 严格串行按序（推理与出处同
    /// [`evict_settled_permission_asks`]）。所以审批弹窗到达时「最后一个 start 的
    /// 那条」就是被它挡住的那条 —— 网关据此把「用户答完」精确记到某个 toolCall 上，
    /// 前端才好把工具计时起点从「卡片出现」挪到「真正开跑」。
    /// 嵌套调用（codemode `ctx.executeTool`，带 parentToolCallId）不更新这里。
    preparing_tool: Mutex<Option<String>>,
    /// `write` 工具**覆盖前**的文件状态：toolCallId → 旧状态。在
    /// tool_execution_start（文件还没被写）抓取。
    ///
    /// 为什么需要：pi 的 write 结果不带 details（源码实测 `details:void 0`），
    /// 网关只能拿 args 合成 patch —— 而"覆盖已有文件"用 `@@ -0,0 +1,N @@` 是假的，
    /// 前端按它反推撤销会按行号切坏文件。有了旧内容就能算出**真 diff**，撤销
    /// 也随之安全；只有 `Text` 能逐行 diff，`Bytes` 有字节指纹能判断"原样重写"
    /// （不登记），`Unreadable` 什么都判断不了 → 前端按"撤销不安全"处理。
    exec_file_prior: Mutex<HashMap<String, PriorFile>>,
    /// Model context window (get_state's model.contextWindow) for usage ring.
    context_window: Mutex<Option<i64>>,
    /// 这个实例**当前实际在用的**模型 id / 供应商（get_state 的 model.id /
    /// model.provider，以及每轮透传的 per-session `set_model` 参数）。
    ///
    /// 为什么必须记：上下文环的分母必须取「本会话正在跑的那个模型」的窗口。
    /// 对话级模型覆盖（输入栏下拉 → 每轮 `set_model`）只作用在这个实例上，
    /// 不会写进 settings.json 的全局 defaultModel —— 以前分母从全局默认模型
    /// 解析，于是"会话在跑 1M 模型、全局默认是 256k 模型"时环显示 256k，
    /// 且恢复时的权威快照会把数字直接压低（"我选了 1M，有时候自动变成 256k"）。
    current_model: Mutex<Option<String>>,
    /// 与 `current_model` 同源：模型 id 会在多个端点下重名（同一个 id 挂两个
    /// baseUrl），窗口必须按「供应商 + 模型」一起解析，不能只按 id 全库首匹配。
    current_provider: Mutex<Option<String>>,
    /// Last REAL context figure we saw for this instance: pi's per-call
    /// `totalTokens` (input+output+cache, i.e. what the provider actually
    /// loaded). The session-file estimate counts message text only (chars/4)
    /// and lands far below the real prompt size, so any path that can only
    /// compute the estimate must floor it with this — otherwise restoring a
    /// conversation reports a number far below what the last turn really used
    /// ("对话中 50k → 对话后 20.7k").
    last_context_used: AtomicI64,
    initialized: AtomicBool,
    /// Serializes (re)spawns of this instance so concurrent callers can't
    /// kill each other's fresh child.
    spawn_lock: Mutex<()>,
    /// Bumped BEFORE each (re)spawn; the reader thread only does death
    /// bookkeeping if its generation still matches.
    generation: AtomicU64,
    /// Turn in flight (prompt sent, agent_settled not seen) → never reap.
    /// 由 `sync_streaming_flag` 按事实推导（未结算的 waiter 或仍欠的旁路回合），
    /// 不是「刚收到一条 settle」就能写 false。
    streaming: AtomicBool,
    /// Last RPC activity (ms epoch) for idle reaping.
    last_active_ms: AtomicU64,
    /// Plan-mode extension armed? (@narumitw/pi-plan-mode). Tracks whether
    /// `/plan start` was sent without a matching `/plan exit`. An approved
    /// plan (`plan_approved: true`) also clears it: the renderer follows up
    /// with `/plan implement`, which leaves plan mode inside the extension.
    plan_mode: Mutex<bool>,
    /// Last pi EVENT arrival (ms epoch) — any non-response line on stdout,
    /// refreshed by the reader thread. The turn watchdog distinguishes a
    /// wedged model stream (no events at all) from legitimate long tool
    /// runs / user-pending UI cards.
    last_event_ms: AtomicU64,
    /// pi 正在做 in-run 上下文压缩的截止时刻（ms epoch），0 = 没在压缩。
    /// 见 `COMPACTION_GUARD_MS` 与 `emit_pi_event` 的 compaction 分支。
    compaction_guard_until_ms: AtomicU64,
    /// Tool calls currently EXECUTING (tool_execution_start without its
    /// matching end). Long-running tools legitimately produce no stream
    /// events, so the watchdog must not fire while this is non-empty.
    executing_tools: Mutex<std::collections::HashSet<String>>,
    /// Authoritative final text/thinking of the last assistant message,
    /// captured from pi's `message_end` (which carries the complete message
    /// object). pi only streams text via `message_update` text_delta; when
    /// that stream is lost/nonexistent the frontend's textBuffer ends up
    /// empty and the run completes with no visible output. `agent_settled`
    /// forwards these as session/complete content/reasoning so the frontend
    /// can self-heal from the authoritative source.
    last_assistant_text: Mutex<String>,
    last_assistant_thinking: Mutex<String>,
    /// Terminal model error captured from pi's `message_end` when the message
    /// carries `stopReason: "error"` (e.g. an upstream 400). `agent_settled`
    /// forwards it as a fatal `error` event so the frontend surfaces the real
    /// message instead of the "no visible content" fallback.
    last_assistant_error: Mutex<String>,
    /// Live subagents spawned by the pi-subagents extension. Maps the parent
    /// tool-call id to the extension's real agent id — background Agent calls
    /// return "Agent started in background" immediately while the child keeps
    /// running, so the frontend card must stay "running" until the child's
    /// terminal event arrives (entry_appended subagents:record / started).
    subagents: Mutex<HashMap<String, SubAgentRecord>>,
    /// `/context` 探针闩：`Some` 时把 pi-cc-extensions 的 context 报告 notify
    /// 收进缓冲（不当成 warning 抛给前端），见 [`pi_context_report_parts`]。
    /// 闩是**每实例**的：别的实例的 notify 不该被这里吞掉。
    context_probe: Mutex<Option<Vec<String>>>,
    /// `/context` 命令是否可用（pi-cc-extensions 装没装）。0 = 还没探过，
    /// 1 = 有，-1 = 没有。「有」直接缓存住（一直成立）；「没有」带 60s 保质期
    /// —— 用户中途装了扩展不该被一个长期存活的实例永久判死。
    context_cmd_state: std::sync::atomic::AtomicI8,
    context_cmd_checked_ms: std::sync::atomic::AtomicU64,
}

/// One live pi-subagents child tracked across its full lifecycle.
struct SubAgentRecord {
    /// Extension-side agent id (stable across resume/steer).
    agent_id: String,
    /// Full `prompt` the parent Agent tool sent to the child — captured at
    /// `tool_execution_start`. The extension's terminal `subagents:record`
    /// carries no prompt, so this is the only copy that lets a re-emitted
    /// subagent.start (orphans / resume re-arms) re-carry the text and the
    /// disk manifest persist it.
    prompt: String,
    /// Set when the parent Agent tool call has returned (background start
    /// acknowledged or foreground result delivered). The terminal record
    /// alone is authoritative for completion.
    tool_returned: bool,
    /// Terminal status from the extension (completed / failed / …). Absent
    /// while the child still runs.
    status: Option<String>,
    /// Set once the child's terminal result has been auto-injected back into
    /// the parent session as a new prompt. Guards against re-injection when a
    /// resume/re-arm re-arms the record and it goes terminal again.
    injected: bool,
}

impl PiInstance {
    fn new(key: String, cwd: Option<String>, remote: bool) -> Arc<Self> {
        Arc::new(Self {
            key: Mutex::new(key),
            cwd: Mutex::new(cwd),
            remote: AtomicBool::new(remote),
            killed_by_us: AtomicBool::new(false),
            writer: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            child: Mutex::new(None),
            current_session: Mutex::new(None),
            ui_requests: Mutex::new(HashMap::new()),
            turn_waiter: Mutex::new(None),
            turn_cancelled: AtomicBool::new(false),
            turn_debt: AtomicU64::new(0),
            turn_gate_armed_until_ms: AtomicU64::new(0),
            turn_gate_until_ms: AtomicU64::new(0),
            tool_args: Mutex::new(HashMap::new()),
            exec_tool_args: Mutex::new(HashMap::new()),
            preparing_tool: Mutex::new(None),
            exec_file_prior: Mutex::new(HashMap::new()),
            context_window: Mutex::new(None),
            current_model: Mutex::new(None),
            current_provider: Mutex::new(None),
            last_context_used: AtomicI64::new(0),
            initialized: AtomicBool::new(false),
            spawn_lock: Mutex::new(()),
            generation: AtomicU64::new(0),
            streaming: AtomicBool::new(false),
            last_active_ms: AtomicU64::new(now_ms()),
            plan_mode: Mutex::new(false),
            last_event_ms: AtomicU64::new(now_ms()),
            compaction_guard_until_ms: AtomicU64::new(0),
            executing_tools: Mutex::new(std::collections::HashSet::new()),
            last_assistant_text: Mutex::new(String::new()),
            last_assistant_thinking: Mutex::new(String::new()),
            last_assistant_error: Mutex::new(String::new()),
            subagents: Mutex::new(HashMap::new()),
            context_probe: Mutex::new(None),
            context_cmd_state: std::sync::atomic::AtomicI8::new(0),
            context_cmd_checked_ms: std::sync::atomic::AtomicU64::new(0),
        })
    }

    fn current_session_id(&self) -> Value {
        self.current_session
            .lock()
            .unwrap()
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null)
    }

    fn key(&self) -> String {
        self.key.lock().unwrap().clone()
    }

    /// The directory this instance's pi process actually runs in. Spares
    /// follow the global work dir; session instances carry their own.
    fn spawn_dir(&self) -> String {
        self.cwd.lock().unwrap().clone().unwrap_or_default()
    }

    fn touch(&self) {
        self.last_active_ms.store(now_ms(), Ordering::SeqCst);
    }

    /// `streaming` 的唯一含义：**这个实例还有回合没跑完**（自己注册过、尚未结算的
    /// `session/prompt`，或仍欠着的 fire-and-forget 回合）。收到一条 settle 不等于
    /// 旗子该落 —— 那条 settle 可能属于种子历史 / `/plan arm` 这类旁路回合，用户
    /// 真正那一轮此刻还排在后面。
    ///
    /// 为什么必须按事实推导而不是写死 false：这个旗子是 idle reaper（15 分钟无 RPC
    /// 活动就 kill）和子代理回填闸门（`agent_settled` 的 `!streaming`）唯一的判据。
    /// `last_active_ms` 只在发 RPC 时刷新，一个正常跑十几分钟的回合中间一条 RPC 都不
    /// 发 —— 旗子被误落下，活着的子进程就会被当空闲回收掉。
    fn sync_streaming_flag(&self) {
        let outstanding = self.turn_debt.load(Ordering::SeqCst) > 0
            || self.turn_waiter.lock().unwrap().is_some();
        self.streaming.store(outstanding, Ordering::SeqCst);
    }

    /// 登记一个 fire-and-forget 回合（种子历史 / `/plan` arm / 子代理结果回填）。
    /// 它没有 waiter，但照样占着这个实例，所以旗子必须跟着 debt 一起走 —— 只加
    /// debt 不落旗子，这个旁路回合本身就没有任何保护，reaper 可以照样把它连同子
    /// 进程一起回收。
    fn begin_debt_turn(&self) {
        self.turn_debt.fetch_add(1, Ordering::SeqCst);
        self.sync_streaming_flag();
    }

    /// 注销一个旁路回合：它结算了（`agent_settled` 消费掉这条 debt），或者压根没
    /// 发出去（发送失败）。两种情况都不会再有 settle 到来，debt 与旗子一起回落。
    fn end_debt_turn(&self) {
        self.turn_debt.fetch_sub(1, Ordering::SeqCst);
        self.sync_streaming_flag();
    }

    /// True when the model stream is considered wedged: the turn is
    /// unsettled, nothing is executing, and pi has been silent for
    /// STREAM_SILENCE_TIMEOUT. Long tool runs don't trip it — the reader
    /// refreshes last_event_ms on EVERY pi line, including bash
    /// execution updates.
    fn stream_wedged(&self) -> bool {
        // 压缩期间的静默是合法的（见 COMPACTION_GUARD_MS），但窗口有上界：
        // 过了截止时刻就照旧按事件静默判卡死，丢掉 compaction_end 的回合不会
        // 永久挂着。
        let guard = self.compaction_guard_until_ms.load(Ordering::SeqCst);
        if guard != 0 && now_ms() < guard {
            return false;
        }
        now_ms().saturating_sub(self.last_event_ms.load(Ordering::SeqCst))
            >= STREAM_SILENCE_TIMEOUT.as_millis() as u64
    }

    /// 请求「下一条 prompt 到来前先吞掉旧回合的残留事件」。
    ///
    /// 为什么需要：中止 A 之后，A 的尾巴事件仍会继续到达，而它们带的是**同一个
    /// session id** —— 前端按 sid 过滤（agent-flow-panel 的 run 循环）分不出来，
    /// 于是 A 的续跑被渲染进 B 那一轮（「发新任务却看到它还在做旧任务」里「看见」
    /// 的那一半）。更致命的是 A 的 `agent_settled` 会释放 B 已经注册的
    /// turn_waiter，前端拿到一个空 done（"输出消失"）。
    ///
    /// 闸门只在**真的发过 abort**之后武装，调用点全在 `session/prompt` / `session/cancel`：
    /// 用户 Stop、失步重发、卡死看门狗、`PROMPT_TIMEOUT` —— 常规回合不受影响。
    fn arm_turn_gate(&self) {
        self.turn_gate_armed_until_ms
            .store(now_ms() + TURN_GATE_ARM_WINDOW_MS, Ordering::SeqCst);
    }

    /// 新回合注册 waiter 时领取闸门：上一轮被中止过 ⇒ 开始吞事件，直到本轮自己的
    /// `agent_start`（见 `release_turn_gate`）或 `TURN_GATE_MS` 上界。返回是否领取。
    fn claim_turn_gate(&self) -> bool {
        let armed = self.turn_gate_armed_until_ms.swap(0, Ordering::SeqCst);
        if armed <= now_ms() {
            return false;
        }
        self.turn_gate_until_ms
            .store(now_ms() + TURN_GATE_MS, Ordering::SeqCst);
        eprintln!("[pi agent] turn gate claimed (stale turn was aborted) -> swallowing tail");
        true
    }

    /// True while the gate still swallows events. Self-clears at the bound so a
    /// lost `agent_start` can never permanently mute a turn.
    fn turn_gate_active(&self) -> bool {
        let until = self.turn_gate_until_ms.load(Ordering::SeqCst);
        if until == 0 {
            return false;
        }
        if now_ms() >= until {
            self.turn_gate_until_ms.store(0, Ordering::SeqCst);
            return false;
        }
        true
    }

    /// 闸门开门：本回合真正开始了（或这一轮已确认结束）。
    fn release_turn_gate(&self) {
        self.turn_gate_until_ms.store(0, Ordering::SeqCst);
    }

    /// Register a pending responder and send the frame. Shared by the async
    /// and sync request paths; both check the writer BEFORE inserting so a
    /// dead instance can't leak pending entries.
    fn submit(&self, id: String, line: String, tx: Responder) -> Result<(), String> {
        let Some(writer) = self.writer.lock().unwrap().clone() else {
            return Err("pi agent not connected".into());
        };
        self.pending
            .lock()
            .unwrap()
            .insert(id, PendingRequest { tx });
        writer
            .send(line)
            .map_err(|_| "pi agent stdin closed".to_string())
    }

    fn decode_response(message: Value, _cmd: &str) -> Result<Value, String> {
        let ok = message
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !ok {
            let error = message
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("pi command failed");
            return Err(error.to_string());
        }
        Ok(message.get("data").cloned().unwrap_or(Value::Null))
    }

    /// Async request: send one pi command frame, await its response.
    async fn request(&self, cmd: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.touch();
        let (id, line) = request_frame(cmd, params)?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.submit(id, line, Responder::Async(tx))?;
        let message = tokio::time::timeout(timeout, rx)
            .await
            .map_err(|_| format!("pi request {cmd} timed out"))?
            .map_err(|_| "pi agent response channel closed".to_string())?;
        Self::decode_response(message, cmd)
    }

    /// Sync request (spawn/handshake paths): blocks the calling thread until
    /// the response arrives or the timeout expires. Safe on plain threads
    /// AND on runtime workers (mpsc recv, no tokio blocking APIs).
    fn request_sync(&self, cmd: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.touch();
        let (id, line) = request_frame(cmd, params)?;
        let (tx, rx) = mpsc::channel::<Value>();
        let submit_gen = self.generation.load(Ordering::SeqCst);
        self.submit(id.clone(), line, Responder::Sync(tx))?;
        let start = std::time::Instant::now();
        let message = rx.recv_timeout(timeout).map_err(|e| match e {
            mpsc::RecvTimeoutError::Disconnected => {
                let now_gen = self.generation.load(Ordering::SeqCst);
                // 我们自己杀的（清场/reaper/弃用备件）不是崩溃：报成 "process
                // exited" 会让 spawn_instance 的重试分支去重生一个刚被判了死刑的
                // 子进程。见 `killed_by_us`。
                let cause = if self.killed_by_us.load(Ordering::SeqCst) {
                    "killed by Helix"
                } else {
                    "process exited"
                };
                format!(
                    "pi request {cmd} failed: {cause} (no response channel) [waited {}ms, submit_gen={} now_gen={}]",
                    start.elapsed().as_millis(),
                    submit_gen,
                    now_gen
                )
            }
            mpsc::RecvTimeoutError::Timeout => {
                format!(
                    "pi request {cmd} timed out [{}] (submit_gen={})",
                    timeout.as_millis(),
                    submit_gen
                )
            }
        })?;
        Self::decode_response(message, cmd)
    }

    /// Kill this instance's child and clear its transport state (a respawn
    /// rebuilds everything). Registered UI requests lose their owner entry.
    /// `cwd`, `current_session` and the SESSION_FILES mapping survive so a
    /// respawn lands in the same project and can restore the session.
    fn kill(&self) {
        log_spawn_diag(&format!("kill({}): entry", self.key()));
        // 最先置位：下面的 pending.clear() 和 reader 的死亡簿记都会让 in-flight
        // 请求断连，那才是 `killed_by_us` 唯一要回答的问题。
        self.killed_by_us.store(true, Ordering::SeqCst);
        // C: release an armed turn waiter BEFORE the child dies.
        //
        // 顺序是承重结构，不是风格问题：`child.kill()` 会让 stdout 立刻 EOF，
        // 而 reader 线程的死亡簿记（见 stdout reader 的 EOF 分支）也会清
        // `turn_waiter` —— 两个线程谁先拿到谁说了算。原先"先杀子进程、再 take()
        // waiter"的顺序让 reader 几乎必然先到：它把 oneshot 裸丢掉，kill() 随后
        // take 到 None，于是下面这条结构化 `{cancelled:true}` **永远发不出去**，
        // 在飞的 session/prompt 只能以裸的 "pi turn event channel closed" 冒到
        // 前端（2026-09-21 实测：helix-recover.log 里
        // `child death: turn_waiter dropped bare` 与
        // `kill(<sid>): turn_waiter was None` 出现在同一毫秒）。
        // 先取 waiter 就把这个竞态彻底关掉：kill 现在**总是**结构化取消。
        //
        // 注意必须先把 guard.take() 的结果放进 `let` 再判分支，不能写成
        // `if let Some(w) = self.turn_waiter.lock().unwrap().take() { … } else { … }`
        // —— edition 2021 下 `if let` 的 scrutinee 临时值（MutexGuard）会活到整个
        // `if let` 表达式结束（含 else 块），else 里再 lock() 就是对同一把非重入
        // Mutex 的重入 → 自死锁（kill() 卡住 → 初始化永不完 → 前端一直"正在连接
        // 网关"）。
        let armed = self.turn_waiter.lock().unwrap().take();
        if let Some(w) = armed {
            let _ = w.tx.send(json!({ "cancelled": true }));
            log_spawn_diag(&format!(
                "kill({}): cancelled armed turn waiter (before child kill)",
                self.key()
            ));
        } else {
            log_spawn_diag(&format!("kill({}): turn_waiter was None", self.key()));
        }
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
        log_spawn_diag(&format!("kill({}): child cleared", self.key()));
        *self.writer.lock().unwrap() = None;
        self.pending.lock().unwrap().clear();
        let dead_ids: Vec<String> = self.ui_requests.lock().unwrap().keys().cloned().collect();
        self.ui_requests.lock().unwrap().clear();
        log_spawn_diag(&format!("kill({}): ui_requests cleared", self.key()));
        // Clean up UI_REQUEST_OWNERS in a separate lock scope — the RPC
        // paths (extension_ui_request handlers) take ui_requests first,
        // then UI_REQUEST_OWNERS, so kill() must release ui_requests
        // before acquiring UI_REQUEST_OWNERS to avoid a lock-ordering
        // inversion that deadlocks against the reaper thread.
        log_spawn_diag(&format!("kill({}): acquiring UI_REQUEST_OWNERS", self.key()));
        {
            let mut owners = UI_REQUEST_OWNERS.lock().unwrap();
            for id in &dead_ids {
                owners.remove(id);
            }
        }
        log_spawn_diag(&format!("kill({}): UI_REQUEST_OWNERS cleared", self.key()));
        self.tool_args.lock().unwrap().clear();
        self.exec_tool_args.lock().unwrap().clear();
        self.exec_file_prior.lock().unwrap().clear();
        self.executing_tools.lock().unwrap().clear();
        *self.preparing_tool.lock().unwrap() = None;
        self.initialized.store(false, Ordering::SeqCst);
        // 子进程死了 ⇒ 它欠的每一条 settle 永远不会来。旁路回合的记账必须一起清零，
        // 否则 `sync_streaming_flag` 会永远认为还有回合在跑（streaming 卡 true ⇒
        // reaper 再也无权回收，旁路注入闸门也一直不开）。
        self.turn_debt.store(0, Ordering::SeqCst);
        self.streaming.store(false, Ordering::SeqCst);
        log_spawn_diag(&format!("kill({}): exit", self.key()));
    }

    /// Stamp `sessionId`/`sessionFile` from a get_state-shaped `data` payload
    /// into the instance + the global SESSION_FILES cache.
    fn stamp_session_from_state(&self, data: Option<&Value>) {
        if let Some(session_id) = data
            .and_then(|d| d.get("sessionId"))
            .and_then(Value::as_str)
        {
            if !session_id.is_empty() {
                *self.current_session.lock().unwrap() = Some(session_id.to_string());
                if let Some(session_file) = data
                    .and_then(|d| d.get("sessionFile"))
                    .and_then(Value::as_str)
                {
                    SESSION_FILES
                        .lock()
                        .unwrap()
                        .insert(session_id.to_string(), session_file.to_string());
                    // 远程实例的 sessionFile 是**远端**机器上的绝对路径，本机
                    // restore 的缓存/扫描都看不到它。登记一份到磁盘：网关重启后
                    // 这个 sid 的 resume 才能直接 switch_session 回原会话，而不是
                    // 落到前端的「本地历史重建」（新 sid + 系统注入回放 = 事实分叉）。
                    if self.remote.load(Ordering::SeqCst) {
                        remember_remote_session_file(session_id, session_file);
                    }
                }
            }
        }
        if let Some(data) = data {
            if let Some(window) = data.pointer("/model/contextWindow").and_then(Value::as_i64) {
                *self.context_window.lock().unwrap() = Some(window);
            }
            // 本实例当前在用的模型：pi 的 get_state 带完整 Model 对象，id /
            // provider 都要记 —— 窗口解析得按「供应商 + 模型」查 models.json。
            if let Some(model_id) = data.pointer("/model/id").and_then(Value::as_str) {
                if !model_id.is_empty() {
                    *self.current_model.lock().unwrap() = Some(model_id.to_string());
                }
            }
            if let Some(provider) = data.pointer("/model/provider").and_then(Value::as_str) {
                if !provider.is_empty() {
                    *self.current_provider.lock().unwrap() = Some(provider.to_string());
                }
            }
        }
    }

    /// 记录「本实例现在跑的是哪个模型」——透传 per-session `set_model` 时调用。
    /// `get_state` 只在握手/恢复时刷新，对话级切换模型不会经过它，所以这是
    /// 「本会话模型」的第二条（也是每轮都会重放的）写入源。
    fn note_active_model(&self, model: Option<&str>, provider: Option<&str>) {
        if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
            *self.current_model.lock().unwrap() = Some(m.to_string());
        }
        if let Some(p) = provider.map(str::trim).filter(|p| !p.is_empty()) {
            *self.current_provider.lock().unwrap() = Some(p.to_string());
        }
    }

    /// 上下文环的分母：**本实例自己的模型**的窗口，全局默认模型放最后。
    ///
    /// 优先级（逐级下降，只在前一级拿不到时才往下走）：
    ///   ① `pi_hint`：pi 本次上报的、属于这个会话的窗口（`contextUsage.contextWindow`）
    ///   ② models.json 里本实例当前模型的条目（`config::model_context_window_for`，
    ///      按 current_provider + current_model 查）—— 对话级模型覆盖只存在这里
    ///   ③ 本实例 `get_state` 报的窗口
    ///   ④ 全局默认模型（`config::model_context_window_fallback`）——**最后**才用
    ///
    /// 旧顺序把 ④ 放第一，于是「会话覆盖成 1M 模型、全局默认是 256k 模型」时
    /// 分母被解析成 256k；恢复路径是权威快照（`authoritative=true`），会把环
    /// 直接压低，表现为「我选了 1M，有时候自动变成 256k」。
    fn context_max(&self, pi_hint: Option<i64>) -> i64 {
        if let Some(w) = pi_hint.filter(|w| *w > 0) {
            return w;
        }
        let model = self.current_model.lock().unwrap().clone();
        if let Some(m) = model.as_deref() {
            let provider = self.current_provider.lock().unwrap().clone();
            let w = crate::config::model_context_window_for(m, provider.as_deref());
            if w > 0 {
                return w;
            }
        }
        if let Some(w) = self.context_window() {
            if w > 0 {
                return w;
            }
        }
        crate::config::model_context_window_fallback()
    }

    /// The model's context window, when known from get_state.
    fn context_window(&self) -> Option<i64> {
        *self.context_window.lock().unwrap()
    }

    /// Remember the last real context figure (see the field docs). Only
    /// overwritten by a fresh real number — never by an estimate.
    fn set_last_context_used(&self, tokens: i64) {
        if tokens > 0 {
            self.last_context_used.store(tokens, Ordering::SeqCst);
        }
    }

    /// Reset the remembered figure (compaction discarded the context it
    /// described). Bypasses `set_last_context_used`'s `> 0` guard, which
    /// exists so an estimate can't overwrite a real number and would
    /// otherwise make a zeroing write a silent no-op.
    fn reset_last_context_used(&self) {
        self.last_context_used.store(0, Ordering::SeqCst);
    }

    /// Last real context figure; 0 when nothing has been measured yet.
    fn last_context_used(&self) -> i64 {
        self.last_context_used.load(Ordering::SeqCst)
    }

    /// get_state + stamp. Returns the state `data`.
    async fn session_state(&self) -> Result<Value, String> {
        let data = self.request("get_state", Value::Null, RPC_TIMEOUT).await?;
        self.stamp_session_from_state(Some(&data));
        Ok(data)
    }

    /// 轮询 pi 自报的 `isStreaming`，直到它承认上一轮已结束（预算
    /// `DESYNC_SETTLE_BUDGET`）。abort 命令返回只代表命令被处理，`agent_end` /
    /// `agent_settled` 还在收尾；不等就重发 prompt 会再撞一次 "already processing"。
    async fn wait_until_idle(&self) -> bool {
        let deadline = tokio::time::Instant::now() + DESYNC_SETTLE_BUDGET;
        loop {
            if let Ok(state) = self.session_state().await {
                if state.get("isStreaming").and_then(Value::as_bool) == Some(false) {
                    return true;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    }
}

/// Classify a restore/resume failure into a structured kind so the frontend can
/// decide the SESSION'S LIFECYCLE STATE, not just display a message.
///
/// Only `session_not_found` is permanent — the SID's persisted session file does
/// not exist (cache miss + disk scan miss), so the conversation is marked
/// `broken` and no later operation may pretend it still exists.
///
/// `session_restore_failed` means the file WAS found but could not be restored
/// (permission denied, JSONL parse/decode error, `switch_session` timeout or
/// process death, pi declining the switch, oversized-trim failure). These are
/// recovery failures, not "the session is gone" — the file is still on disk and
/// a retry can succeed. Marking these `broken` would permanently lose a
/// restorable conversation because of one transient failure.
///
/// `internal` is everything else: spawn failure, app quitting, missing app
/// state — gateway-level problems that say nothing about the session.
///
/// NOTE: text matching is a fallback for the fact that the lower layers
/// (`restore_session_instance`, `spawn_instance`, pi's `switch_session` RPC)
/// return bare strings. Keep the "no session file" check FIRST — the
/// `restore FAILED … no session file` log line and the wrapped
/// `session restore task failed: no session file for …` message both contain
/// "no session file" and must classify as `session_not_found`, not as a
/// generic restore failure. The `switch_session` form is the one that actually
/// occurs (`pi request switch_session failed: …` — an RPC method name with an
/// underscore); matching only "switch session" silently downgraded every
/// killed-by-restart restore failure to `internal`.
fn classify_session_error(msg: &str) -> &'static str {
    let m = msg.to_lowercase();
    if m.contains("no session file")
        || m.contains("session not found")
        || m.contains("unknown session")
        || m.contains("no such session")
    {
        "session_not_found"
    } else if m.contains("permission")
        || m.contains("access denied")
        || m.contains("denied")
        || m.contains("corrupt")
        || m.contains("parse")
        || m.contains("decode")
        || m.contains("restore")
        || m.contains("switch_session")
        || m.contains("switch session")
        || m.contains("get_state")
        || m.contains("timeout")
    {
        "session_restore_failed"
    } else {
        "internal"
    }
}

/// Recovery-path diagnostic log: `~/.pi/agent/helix-recover.log`, rotated at
/// 1MB (one `.1` backup kept). Every spawn / resume / restore /
/// fingerprint-recovery / session-new step lands here with a UTC timestamp —
/// without it a failed recovery chain (resume → storedId → fingerprint →
/// session/new) is undebuggable: the release build drops stderr and the
/// frontend swallows the concrete errors, so "找回对话失败" has always been
/// unreproducible after the fact. Best-effort: IO errors are silently ignored
/// (logging must never take the gateway down), and the file matches the
/// session jsonl filenames' UTC clock so timestamps correlate directly.
pub(crate) fn log_spawn_diag(message: &str) {
    use std::io::Write;
    static LOG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let Ok(_guard) = LOG_LOCK.lock() else {
        return;
    };
    let Some(dir) = dirs::home_dir().map(|h| h.join(".pi/agent")) else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("helix-recover.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 1_000_000 {
            let _ = std::fs::rename(&path, dir.join("helix-recover.log.1"));
        }
    }
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let ts = now_ms();
    let (secs, ms) = (ts / 1000, ts % 1000);
    let _ = writeln!(
        f,
        "[{:02}:{:02}:{:02}.{:03}] {}",
        secs / 3600 % 24,
        secs / 60 % 60,
        secs % 60,
        ms,
        message
    );
}

/// conversation → 后端 sid 的**反向**索引：`~/.pi/agent/conversation-index.json`
///
/// 前端的 sessionMap（IndexedDB `conversationSessions`）是唯一记录这个关系的
/// 地方，且可能随 site-data 一起清空（2026-09-21 之前还有两处代码会把它整条
/// `delete` / 把 sid 清空：syncConfigToBackend 改设置、handleUndoChat 撤回——
/// 那两处已改成保留 sid 只标 epoch 过期）。一旦这个关系没了：sid → conversation
/// 在全系统范围无解——pi 的 jsonl 文件名只有 `时间戳_sid`，内容里也不含前端
/// conversation id（实测 3.1MB 会话文件里 `session-17…` 出现 0 次）。这里在
/// 每次 sid 绑定时顺手落一份到磁盘，作为唯一持久化的反向索引——map 再丢，
/// 也能反查这个后端会话属于哪个对话、还能不能 resume 回来。
///
/// 注意目前只实现了 `sid → conversation` 方向（`index_lookup`）；`conversation
/// → sid` 需要扫全表反查，前端在「有本地历史但无 SID」时**还没有**用上它，
/// 所以那个状态下仍是不可自愈的（只能新建对话）。
///
/// 尽力而为：索引失败绝不影响正常的会话绑定。
fn conversation_index_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".pi/agent").join("conversation-index.json"))
}

#[derive(Debug, Serialize, Deserialize)]
struct ConversationIndexEntry {
    conversation_id: String,
    ts: u64,
}

fn write_index(index: &HashMap<String, Vec<ConversationIndexEntry>>) {
    let Some(path) = conversation_index_path() else {
        return;
    };
    let Ok(json) = serde_json::to_string_pretty(index) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // 临时文件 + rename：写一半被杀不会留下半个 JSON 把下一次读盘搞坏。
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_err() {
        return;
    }
    let _ = std::fs::rename(&tmp, &path);
}

fn index_upsert(entries: &[(String, String)]) {
    static INDEX_LOCK: Mutex<()> = Mutex::new(());
    let Ok(_guard) = INDEX_LOCK.lock() else {
        return;
    };
    let Some(path) = conversation_index_path() else {
        return;
    };
    let mut index: HashMap<String, Vec<ConversationIndexEntry>> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    for (conversation_id, session_id) in entries {
        let list = index.entry(session_id.clone()).or_default();
        list.retain(|e| e.conversation_id != *conversation_id);
        list.push(ConversationIndexEntry {
            conversation_id: conversation_id.clone(),
            ts: now_ms(),
        });
        // 一个 sid 正常情况下只绑一个对话；多余的是历史噪声，留最近几条。
        if list.len() > 3 {
            list.drain(0..list.len() - 3);
        }
    }
    write_index(&index);
}

/// 删除对话后清理反向索引：按前端 conversation_id 全表移除对应条目，
/// 某个 sid 名下的列表清空时把整个 sid 键也删掉（该文件只增不减的
/// 历史累积由此收敛）。
fn index_remove(conversation_ids: &[String]) -> usize {
    static INDEX_LOCK: Mutex<()> = Mutex::new(());
    let Ok(_guard) = INDEX_LOCK.lock() else {
        return 0;
    };
    let Some(path) = conversation_index_path() else {
        return 0;
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return 0;
    };
    let Ok(mut index) =
        serde_json::from_str::<HashMap<String, Vec<ConversationIndexEntry>>>(&raw)
    else {
        return 0;
    };
    let mut removed = 0;
    index.retain(|_, list| {
        let before = list.len();
        list.retain(|e| !conversation_ids.iter().any(|cid| cid == &e.conversation_id));
        removed += before - list.len();
        !list.is_empty()
    });
    if removed > 0 {
        write_index(&index);
    }
    removed
}

/// `conversation → sid` 方向的反查：前端 sessionMap 里的条目被清空（sid=""）
/// 或整条丢失后，用它把绑定找回来。
///
/// 索引是 `sid → [conversation]` 的哈希表，反查要扫全表 —— 表很小（每个
/// 绑定一条），O(entries) 可忽略。
///
/// 同一个 conversation 历史上可能绑过多个 sid（/clear、重建会让它换新 sid），
/// 而这里返回的**每一个都是可 resume 的候选**：新的优先（jsonl 更可能是活的），
/// 调用方逐个 try，第一个成功的就接回去。所以不返回单一 sid。
fn index_lookup_conversation(conversation_id: &str) -> Value {
    let Some(path) = conversation_index_path() else {
        return json!({ "found": false });
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return json!({ "found": false });
    };
    let Ok(index) =
        serde_json::from_str::<HashMap<String, Vec<ConversationIndexEntry>>>(&raw)
    else {
        return json!({ "found": false });
    };
    let mut hits: Vec<(&String, u64)> = Vec::new();
    for (sid, list) in &index {
        for e in list {
            if e.conversation_id == conversation_id {
                hits.push((sid, e.ts));
            }
        }
    }
    if hits.is_empty() {
        return json!({ "found": false });
    }
    hits.sort_by(|a, b| b.1.cmp(&a.1));
    let session_ids: Vec<&String> = hits.iter().map(|(sid, _)| *sid).collect();
    log_spawn_diag(&format!(
        "index_lookup_conversation: {} -> {} candidate(s) {:?}",
        conversation_id,
        session_ids.len(),
        session_ids
            .iter()
            .map(|s| s.chars().take(8).collect::<String>())
            .collect::<Vec<_>>()
    ));
    json!({
        "found": true,
        "conversation_id": conversation_id,
        "session_ids": session_ids,
    })
}

fn index_lookup(session_id: &str) -> Value {
    let Some(path) = conversation_index_path() else {
        return json!({ "found": false });
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return json!({ "found": false });
    };
    let Ok(index) =
        serde_json::from_str::<HashMap<String, Vec<ConversationIndexEntry>>>(&raw)
    else {
        return json!({ "found": false });
    };
    let Some(list) = index.get(session_id) else {
        return json!({ "found": false });
    };
    json!({
        "found": true,
        "session_id": session_id,
        "conversations": list,
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Path equality that tolerates case, separators and trailing slashes
/// (Windows dir paths arrive from the renderer in arbitrary form).
pub fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        p.trim_end_matches(['/', '\\'])
            .replace('/', "\\")
            .to_lowercase()
    };
    norm(a) == norm(b)
}

pub fn is_active() -> bool {
    // The app is "connected" when the main instance is live. Session
    // instances come and go; only the main one's death is a gateway-level
    // disconnect.
    INSTANCES
        .lock()
        .unwrap()
        .get("")
        .map(|i| i.initialized.load(Ordering::SeqCst))
        .unwrap_or(false)
}

/// Kill every pi child process (main + all session instances + warm spares).
/// Used by gateway.rs on restart / quit; session instances respawn lazily on
/// demand, spares re-warm after the respawn settles.
pub fn kill_all() {
    let instances: Vec<Arc<PiInstance>> =
        INSTANCES.lock().unwrap().values().map(Arc::clone).collect();
    for instance in instances {
        instance.kill();
    }
    let spares: Vec<Arc<PiInstance>> = std::mem::take(&mut *WARM_SPARES.lock().unwrap());
    for spare in spares {
        spare.kill();
    }
}

pub fn stop_all() {
    let _guard = LIFECYCLE_LOCK.lock().unwrap();
    kill_all();
}

/// Overlapping restart: spawn the replacement main instance FIRST (it reads
/// the freshly written settings.json — pi snapshots config at process start),
/// handshake it on a placeholder key while the OLD main keeps serving, then
/// atomically promote it to the "" key and kill the old one. No
/// gateway.disconnected event is ever emitted (the old main's key field is
/// renamed before its kill, so its reader thread skips gateway-level death
/// bookkeeping), so the frontend badge stays "ready" throughout instead of
/// showing "connecting" for the whole cold-start window.
///
/// A warm spare cannot be used here — it was spawned under the PREVIOUS
/// config, so promoting it would silently no-op the very change the restart
/// exists to apply. Spares are killed only after the handover and re-warmed
/// under the new config.
pub fn restart_overlapping(state: &Arc<AppState>) -> Result<(), String> {
    let _guard = LIFECYCLE_LOCK.lock().unwrap();
    start_reaper();
    warm_session_file_index();

    // Snapshot the old main but LEAVE it registered under "": concurrent RPCs
    // (instance_for_session("")) keep finding and using it during the
    // handshake. The placeholder key must not be "spare-N" (the reaper skips
    // those — this one must not be reaped mid-handshake).
    let old_main = INSTANCES.lock().unwrap().get("").map(Arc::clone);
    let pending_key = format!("restart-{}", REQUEST_ID.fetch_add(1, Ordering::SeqCst));
    match spawn_instance(pending_key.clone(), None, false, state) {
        Ok(new_main) => {
            // Rename the old main's key field so its reader thread treats the
            // upcoming kill as a session-instance death (no gateway.disconnected
            // emission, no self-heal respawn) — the frontend badge stays green
            // through the handover.
            if let Some(old) = &old_main {
                *old.key.lock().unwrap() = "__retired__".to_string();
            }
            // Promote: replaces the "" map entry (the old main stays alive
            // under its renamed key until we kill it below).
            rekey_instance(&new_main, String::new());
            // Handover done — retire the rest. Session instances die (they
            // respawn lazily per conversation under the new config), spares
            // die (they were warm under the old config).
            if let Some(old) = &old_main {
                old.kill();
            }
            let old_sessions: Vec<Arc<PiInstance>> = INSTANCES
                .lock()
                .unwrap()
                .values()
                .filter(|i| !i.key().is_empty())
                .map(Arc::clone)
                .collect();
            for inst in old_sessions {
                inst.kill();
            }
            let old_spares: Vec<Arc<PiInstance>> =
                std::mem::take(&mut *WARM_SPARES.lock().unwrap());
            for spare in old_spares {
                spare.kill();
            }
            emit_helix_event(
                "gateway.ready",
                &json!({
                    "backend": "pi",
                    "session_id": new_main.current_session_id(),
                }),
            );
            rearm_warm_spares(state);
            Ok(())
        }
        Err(e) => {
            // Handshake failed — the child is already killed by spawn_instance.
            // Drop the zombie placeholder entry; the old main was never touched
            // and keeps serving. Strictly better than the old kill-first flow,
            // which left the gateway dead on handshake failure.
            INSTANCES.lock().unwrap().remove(&pending_key);
            if old_main.is_none() {
                // No previous main either (first spawn failed) — retry a plain
                // spawn so the app is not left without a backend.
                let _ = spawn_instance(String::new(), None, false, state);
            }
            rearm_warm_spares(state);
            Err(e)
        }
    }
}

/// Kill and remove one session's instance outright (conversation deleted).
/// Used by the scheduled-task dispatcher to reap a one-shot task's instance as
/// soon as its turn settles, instead of letting it idle for IDLE_REAP_MS.
pub fn drop_session_instance(session_id: &str) {
    if let Some(instance) = INSTANCES.lock().unwrap().remove(session_id) {
        instance.kill();
    }
}

/// Startup / restart entry point: make sure the MAIN instance exists. Called
/// from lib.rs setup, gateway.rs restarts, and the reader-thread self-heal.
pub fn spawn(state: &Arc<AppState>) -> Result<(), String> {
    let _guard = LIFECYCLE_LOCK.lock().unwrap();
    log_spawn_diag("spawn: acquired LIFECYCLE_LOCK, spawning main instance");
    start_reaper();
    warm_session_file_index();
    let result = spawn_instance(String::new(), None, false, state).map(|_| ());
    log_spawn_diag(&match &result {
        Ok(()) => "spawn: main instance initialized, gateway ready".to_string(),
        Err(e) => format!("spawn: main instance FAILED: {e}"),
    });
    // (Re)fill the warm-spare pool after the main instance is up — its spawn
    // cost is paid off the user's critical path.
    rearm_warm_spares(state);
    result
}

/// Refill the warm-spare pool in the background to WARM_SPARE_COUNT.
///
/// 补热必须**先占位再动手**：一次握手要 17-27s（pi 冷启动实测，见 helix-recover.log
/// 2026-10-11：`awaiting get_state` → `get_state OK` 普遍 17~20s），期间池子
/// 一直是空的，所以只比 `spares.len()` 的话，每个并发调用都会各自起一个 pi 进程，
/// 最后 N-1 个在握手完成后被「位子已满」判死 —— 白付冷启动、白占内存，还让
/// 被清场打断的那几次打出 `warm spare spawn failed`。日志里 spare-29/spare-30
/// 相差 2ms 成对起、spare-41/spare-43 相差 15ms 成对起，就是这个洞。
/// Spares whose dir no longer matches the global work dir are reaped (a
/// work-dir switch orphaned them).
fn rearm_warm_spares(state: &Arc<AppState>) {
    {
        let global_dir = state
            .work_dir
            .read()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mut spares = WARM_SPARES.lock().unwrap();
        spares.retain(|spare| {
            let ok = same_path(&spare.spawn_dir(), &global_dir);
            if !ok {
                INSTANCES.lock().unwrap().remove(&spare.key());
                spare.kill();
            }
            ok
        });
        // 位子（池 + 在途）算满就不补。占位与读池大小在同一把锁里做，
        // 所以两个并发 rearm 不可能都认为自己该起一个。
        let outstanding = spares.len() + SPARE_INFLIGHT.load(Ordering::SeqCst);
        if outstanding >= WARM_SPARE_COUNT {
            return;
        }
        SPARE_INFLIGHT.fetch_add(1, Ordering::SeqCst);
    }
    let state = Arc::clone(state);
    // 在 `thread::spawn` 之前构造、再 move 进线程：起线程本身失败时也会随栈展开归还位子。
    let reservation = SpareReservation;
    thread::spawn(move || {
        let _reservation = reservation;
        let key = format!("spare-{}", REQUEST_ID.fetch_add(1, Ordering::SeqCst));
        // Spares follow the global work dir (cwd = None).
        match spawn_instance(key, None, false, &state) {
            Ok(instance) => {
                // 清场/restart 可能在握手的这 20 秒里把池重新排过 —— 位子已被别人
                // 占了就让出这个进程，别把它塞进池外当孤儿。
                let mut spares = WARM_SPARES.lock().unwrap();
                if spares.len() >= WARM_SPARE_COUNT {
                    drop(spares);
                    // Also remove from INSTANCES (registered under spare-N).
                    INSTANCES.lock().unwrap().remove(&instance.key());
                    instance.kill();
                    return;
                }
                spares.push(instance);
            }
            Err(e) => eprintln!("[pi agent] warm spare spawn failed: {e}"),
        }
    });
}

/// Pull a live, handshaked spare from the pool whose spawn dir matches the
/// requested conversation cwd. Dead spares are purged along the way.
fn take_warm_spare(requested_cwd: Option<&str>) -> Option<Arc<PiInstance>> {
    let mut spares = WARM_SPARES.lock().unwrap();
    let mut candidate: Option<Arc<PiInstance>> = None;
    spares.retain(|spare| {
        if !spare.initialized.load(Ordering::SeqCst) {
            // Dead spare — drop from pool and INSTANCES.
            INSTANCES.lock().unwrap().remove(&spare.key());
            spare.kill();
            return false;
        }
        if candidate.is_some() {
            return true; // keep extras for later claims
        }
        let dir_matches = match requested_cwd {
            Some(dir) => same_path(dir, &spare.spawn_dir()),
            None => true,
        };
        if dir_matches {
            candidate = Some(Arc::clone(spare));
            false // leaves the pool
        } else {
            true // wrong project — keep it for a matching session/new
        }
    });
    candidate
}

/// Get-or-create the instance for `key`, spawn its pi child (with the
/// handshake), and return it. Concurrent callers for the same key serialize
/// on the instance's spawn_lock; a caller that arrives after another finished
/// sees `initialized` and returns immediately.
/// Pi has no persistent thinking-level config key, so Helix owns the user's
/// chosen reasoning effort and re-applies it to each spawned pi instance.
fn configured_effort() -> Option<String> {
    let path = crate::config::config_yaml_path();
    let yaml = std::fs::read_to_string(&path).ok()?;
    let v: serde_yaml::Value = serde_yaml::from_str(&yaml).ok()?;
    v.get("agent")?
        .get("reasoning_effort")?
        .as_str()
        .map(|s| s.to_string())
}

/// Pi's `set_thinking_level` accepts a fixed set; anything else falls back to
/// "medium" (mirrors the renderer's own coercion in the old ACP path).
fn normalize_effort(level: &str) -> String {
    match level {
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" => level.to_string(),
        _ => "medium".to_string(),
    }
}

/// 自动压缩开关（pi 的 in-run 阈值压缩）：跟用户配置 agent.auto_compaction
/// 走，缺省 true（与前端 store 的 autoCompactContext 默认值一致）。pi 会把它
/// 持久化进自己的全局 settings（compaction.enabled），所以之后重新 spawn 的
/// 实例也会继承上一次的值；这里负责在每次实例初始化时重放，保证两个来源
/// 对齐（与 configured_effort 同一套路）。
fn configured_auto_compaction() -> bool {
    let path = crate::config::config_yaml_path();
    let Ok(yaml) = std::fs::read_to_string(&path) else {
        return true;
    };
    let Ok(v) = serde_yaml::from_str::<serde_yaml::Value>(&yaml) else {
        return true;
    };
    match v
        .get("agent")
        .and_then(|a| a.get("auto_compaction"))
        .and_then(|b| b.as_bool())
    {
        Some(b) => b,
        None => true,
    }
}

/// 广播自动压缩开关给所有活的 pi 实例。用户改 autoCompactContext 设置时
/// 由前端调用：pi 的回合内阈值压缩（压缩完 agent.continue() 续跑任务）
/// 立即在所有打开的对话上跟手，pi 同时会把值写进自己的全局 settings，
/// 新实例自动继承。
pub fn set_auto_compaction_all(enabled: bool) {
    let instances: Vec<Arc<PiInstance>> = INSTANCES.lock().unwrap().values().cloned().collect();
    for inst in instances {
        let _ = inst.request_sync(
            "set_auto_compaction",
            json!({ "enabled": enabled }),
            RPC_TIMEOUT,
        );
    }
}

/// 当前是否有**任意**会话还有未结算的回合在跑。以实例的 `streaming` 标志为
/// 事实源（与 idle-reaper / 重启交接闸门同一判据）：只要有一个为真，就不应
/// 做会打断对话的网关 respawn。供技能启停等用户动作判断“能不能立刻重启”。
pub fn any_turn_running() -> bool {
    INSTANCES
        .lock()
        .unwrap()
        .values()
        .any(|inst| inst.streaming.load(Ordering::SeqCst))
}

/// Broadcast a thinking level to every live pi instance. Used when the user
/// changes the reasoning-effort slider so the change takes effect across all
/// open conversations immediately (Pi has no global/persistent thinking level).
pub fn set_thinking_level_all(level: String) {
    let instances: Vec<Arc<PiInstance>> = INSTANCES.lock().unwrap().values().cloned().collect();
    let normalized = normalize_effort(&level);
    for inst in instances {
        let _ = inst.request_sync(
            "set_thinking_level",
            json!({ "level": normalized }),
            RPC_TIMEOUT,
        );
    }
}

fn spawn_instance(
    key: String,
    cwd: Option<String>,
    remote: bool,
    state: &Arc<AppState>,
) -> Result<Arc<PiInstance>, String> {
    let instance = get_or_create_instance(key, cwd, remote);
    if instance.initialized.load(Ordering::SeqCst) {
        return Ok(instance);
    }
    let key = instance.key();
    {
        let _guard = instance.spawn_lock.lock().unwrap();
        if instance.initialized.load(Ordering::SeqCst) {
            return Ok(Arc::clone(&instance));
        }
        log_spawn_diag(&format!(
            "spawn_instance({}): start spawn_process",
            key,
        ));
        spawn_process(&instance, state)?;
        log_spawn_diag(&format!(
            "spawn_instance({}): child up, awaiting get_state ({}s)",
            key,
            HANDSHAKE_TIMEOUT.as_secs(),
        ));

        // Pi has no handshake — get_state succeeding proves the RPC is live.
        // A transient child death during the cold-start window (node boot +
        // extension init + the memory extension's SQLite backfill) can kill
        // the process before get_state answers; the reader thread's death
        // bookkeeping then drops the pending channel ("process exited").
        // Respawn + retry ONCE — a second failure is a genuine crash loop
        // (bad config, leaked sibling holding the SQLite lock, …) and is
        // surfaced as an error rather than looped.
        //
        // 只有真崩溃才重试。Helix 自己在这 12s 窗口里清场（restart_overlapping
        // 的「交接后清场」会杀 INSTANCES 里所有非主实例，而在飞的 spare 此刻已经
        // 注册进 INSTANCES、还没进 WARM_SPARES；reaper / kill_all 同理）报的是
        // "killed by Helix"，走下面的通用分支直接失败 —— 重生一个刚被自己判死
        // 的子进程只是白等，而且在远程实例上会连带触发 30s 冷却。清场方自己会
        // 再 rearm，池子不会因此空着。
        match instance.request_sync("get_state", Value::Null, HANDSHAKE_TIMEOUT) {
            Err(e) if e.contains("process exited") => {
                let reason = e.clone();
                eprintln!("[pi agent] get_state failed ({e}); respawning and retrying once");
                log_spawn_diag(&format!(
                    "spawn_instance({}): get_state transient death ({reason}) — retrying once",
                    key,
                ));
                instance.kill();
                spawn_process(&instance, state)?;
                let retry_start = std::time::Instant::now();
                match instance.request_sync("get_state", Value::Null, HANDSHAKE_TIMEOUT) {
                    Ok(data) => {
                        // 重试成功以前什么都不落 —— 初始失败只有一条 eprintln 到
                        // 控制台，release 构建里直接丢，事后完全无法复盘是哪一端
                        // 断的。
                        log_spawn_diag(&format!(
                            "spawn_instance({}): get_state retry OK ({}ms)",
                            key,
                            retry_start.elapsed().as_millis()
                        ));
                        instance.stamp_session_from_state(Some(&data));
                        instance.initialized.store(true, Ordering::SeqCst);
                        return Ok(Arc::clone(&instance));
                    }
                    Err(e2) => {
                        eprintln!("[pi agent] get_state retry failed: {e2}");
                        log_spawn_diag(&format!(
                            "get_state retry failed (initial: {reason}): {e2}"
                        ));
                        instance.kill();
                        // 远程实例连续两次 get_state 秒退：隧道本地监听还活着，但
                        // 远端已不可达（或远端 pi 起不来）。标记冷却，让后续 30s 内
                        // 快速失败而不是反复重连。
                        //
                        // **不**回退本地 spawn：那是把一次远程对话悄悄搬到本机某个
                        // 目录去跑（另一个项目、另一份文件），比直接失败危险。双通道
                        // 之前这个回退是"能用"的（整台 Helix 只有一个通道），现在不行。
                        if instance.remote.load(Ordering::SeqCst) {
                            mark_remote_down(30_000);
                            log_spawn_diag(
                                "remote endpoint 连续两次 get_state 秒退 — 冷却 30s，本次直接失败（不回退本地）",
                            );
                        }
                        return Err(e2);
                    }
                }
            }
            Ok(data) => {
                log_spawn_diag(&format!(
                    "spawn_instance({}): get_state OK, initializing",
                    key,
                ));
                instance.stamp_session_from_state(Some(&data));
                instance.initialized.store(true, Ordering::SeqCst);
                // Pi has no persistent thinking-level config key — re-apply the
                // user's chosen reasoning effort on every freshly-spawned
                // instance so new conversations honor the slider instead of
                // falling back to Pi's built-in default.
                if let Some(effort) = configured_effort() {
                    let level = normalize_effort(&effort);
                    let _ = instance.request_sync(
                        "set_thinking_level",
                        json!({ "level": level }),
                        RPC_TIMEOUT,
                    );
                }
                // 自动压缩：把压缩决策交给 pi 的回合内阈值压缩——压缩完
                // agent.continue() 继续任务（与 CLI 语义一致）。旧的 Helix
                // 前端 80% 轮询走手动 compact，pi 的手动 compact 第一步就
                // abort 当前回合且永不续跑，才是“压缩后任务暂停”的根因。
                let _ = instance.request_sync(
                    "set_auto_compaction",
                    json!({ "enabled": configured_auto_compaction() }),
                    RPC_TIMEOUT,
                );
                if instance.key().is_empty() {
                    emit_helix_event(
                        "gateway.ready",
                        &json!({
                            "backend": "pi",
                            "session_id": instance.current_session_id(),
                        }),
                    );
                }
            }
            Err(e) => {
                eprintln!("[pi agent] get_state failed: {e}");
                log_spawn_diag(&format!("get_state failed: {e}"));
                instance.kill();
                return Err(e);
            }
        }
    }
    Ok(instance)
}

/// Find the instance under `key`, or create it (registering it in the map).
fn get_or_create_instance(
    key: String,
    cwd: Option<String>,
    remote: bool,
) -> Arc<PiInstance> {
    let mut instances = INSTANCES.lock().unwrap();
    if let Some(existing) = instances.get(&key) {
        Arc::clone(existing)
    } else {
        let instance = PiInstance::new(key.clone(), cwd, remote);
        instances.insert(key, Arc::clone(&instance));
        instance
    }
}

/// 远程实例的通道：连本机 SSH 隧道，握手行下发**这个会话自己的**远端目录。
///
/// 失败一律直接返回错误，**不**回退本地 spawn。回退等于把一次远程对话悄悄搬到
/// 本机某个目录去跑（那是另一个项目、另一份文件），比直接失败危险得多 —— 远端不
/// 可达时该由用户决定重连还是换本地项目，不该由网关替他决定。
fn spawn_remote(
    instance: &Arc<PiInstance>,
    generation: u64,
    remote_dir: &str,
) -> Result<(), String> {
    let Some(endpoint) = remote_rpc_endpoint() else {
        return Err(format!(
            "会话 {} 属于远程项目，但当前没有 SSH 隧道（config.yaml 的 pi.remote_rpc 为空）。\
             请先在侧边栏连接该服务器。",
            instance.key()
        ));
    };
    if remote_marked_down() {
        return Err(format!(
            "远程端点 {endpoint} 在冷却中（此前连续两次握手失败）。请检查隧道与远端 pi，\
             或改用本地项目。"));
    }
    log_spawn_diag(&format!(
        "spawn_process({}): remote RPC → {endpoint} cwd={remote_dir}",
        instance.key(),
    ));
    let (writer, reader, control) = open_remote_transport(remote_dir)?;
    *instance.child.lock().unwrap() = Some(ChildHandle::Remote(control));
    let (writer_tx, writer_rx) = mpsc::channel::<String>();
    *instance.writer.lock().unwrap() = Some(writer_tx);
    thread::spawn(move || {
        let mut w = writer;
        for line in writer_rx {
            if w.write_all(line.as_bytes()).is_err() {
                break;
            }
            let _ = w.flush();
        }
    });
    let instance_clone = Arc::clone(instance);
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
            let record = line.trim_end_matches(['\n', '\r']);
            if !record.is_empty() {
                handle_line(&instance_clone, record);
            }
        }
        // 远程 child 没有 exit code，仅通知死亡簿记（若 gen 未变）。
        if instance_clone.generation.load(Ordering::SeqCst) == generation {
            // 本地 reader 有 "child exited" / "stdout EOF" 两条落盘记录，远程这条
            // 原先一条都没有 —— 远程握手秒失败（"process exited"）事后无从区分
            // 隧道断、远端 pi 起不来、还是远端把连接关了。
            log_spawn_diag(&format!(
                "remote connection closed: gen={generation} key={}",
                instance_clone.key()
            ));
            instance_clone.initialized.store(false, Ordering::SeqCst);
            *instance_clone.writer.lock().unwrap() = None;
            instance_clone.pending.lock().unwrap().clear();
            let sid = instance_clone.current_session_id();
            if instance_clone.streaming.swap(false, Ordering::SeqCst) {
                emit_helix_event(
                    "error",
                    &json!({
                        "session_id": sid,
                        "message": "remote pi agent connection closed",
                    }),
                );
            }
        }
    });
    Ok(())
}

/// Spawn (or replace) the child process + I/O threads for one instance.
/// The generation is bumped BEFORE the old child is killed so the outgoing
/// reader thread can observe the mismatch and skip its death bookkeeping.
fn spawn_process(instance: &Arc<PiInstance>, state: &Arc<AppState>) -> Result<(), String> {
    let _generation = instance.generation.fetch_add(1, Ordering::SeqCst) + 1;
    instance.kill();
    // 复位必须在 kill() **之后**：kill 自己会把这一位置起来。从这里起，
    // request_sync 看到的断连才只可能是新子进程的事。
    instance.killed_by_us.store(false, Ordering::SeqCst);
    log_spawn_diag(&format!(
        "spawn_process({}): kill done, resolving pi cli -> {}",
        instance.key(),
        pi_cli_debug_summary(),
    ));

    // 走哪条通道由**这个实例**决定，不是由全局配置决定。以前只看 `pi.remote_rpc`
    // 是否配置，于是 SSH 隧道一开，本地项目的对话也被搬到远端跑 —— 用户看到的正是
    // 「界面选的是本地目录，agent 实际在远程项目」。
    //
    // 必须在下面那段本地 cwd 解析**之前**分流：那段会把空 cwd 兜到全局 work_dir，
    // 那是本机路径，发给远端只会 ENOENT。
    if instance.remote.load(Ordering::SeqCst) {
        let remote_dir = instance
            .cwd
            .lock()
            .unwrap()
            .clone()
            .filter(|c| !c.is_empty())
            .or_else(remote_cwd_override)
            .unwrap_or_else(|| "~".to_string());
        return spawn_remote(instance, _generation, &remote_dir);
    }

    // Per-conversation cwd when set; otherwise the global work dir. A stale
    // persisted work dir (folder deleted/moved) falls back to the home dir.
    let cwd: PathBuf = instance
        .cwd
        .lock()
        .unwrap()
        .clone()
        .filter(|c| !c.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let dir = state.work_dir.read().unwrap().clone();
            if dir.is_dir() {
                dir
            } else {
                eprintln!(
                    "[Helix] work dir missing, falling back to home: {}",
                    dir.display()
                );
                dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
            }
        });
    // The global work dir is canonical (verbatim `\\?\` on Windows); the
    // pi agent parses the cwd itself, so hand it the plain form.
    let cwd = crate::paths::strip_verbatim_prefix(&cwd);
    // Record the RESOLVED dir — a spare's claim check compares against it.
    *instance.cwd.lock().unwrap() = Some(cwd.to_string_lossy().into_owned());

    // ── 本地 spawn ────────────────────────────────────────────────────────
    let mut command = pi_command();
    command
        .current_dir(cwd)
        // Pi's embedded RPC gateway owns configuration and model refresh; the
        // user-facing update check runs separately in Helix. Pi's startup
        // model/version refresh otherwise adds an 8s+ network wait to every
        // child (including warm spares) before get_state answers.
        .env("PI_OFFLINE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // 代理：pi 内的模型 / MCP / 命令工具 / npx 出口流量也走用户配置的代理。
    // `NODE_USE_ENV_PROXY=1` 是必需的 —— Node 24 的全局 fetch（undici）默认
    // **不读** `HTTP_PROXY` 等 env，缺这个开关 pi 内的 fetch 全走直连。
    for (k, v) in crate::proxy::proxy_env_pairs() {
        command.env(k, v);
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = command.spawn().map_err(|e| {
        format!(
            "Failed to start pi agent: {e} — {}. Configure pi.cli_path in config.yaml \
             (or HELIX_PI_CLI) if Helix should use a specific pi install.",
            pi_cli_debug_summary()
        )
    })?;
    log_spawn_diag(&format!(
        "spawn_process({}): child spawned, wiring stdio",
        instance.key(),
    ));
    let Some(stdout) = child.stdout.take() else {
        return Err("Failed to open pi agent stdout".into());
    };
    let stderr = child.stderr.take();
    if let Some(stderr) = stderr {
        // Main-instance stderr is the only place pi's real startup errors
        // (bad config, provider errors, SQLite lock) surface. Mirror it to
        // the file diagnostic log so a stuck "连接中" badge is reproducible
        // even when the app runs from the tray / a release build.
        let key = instance.key();
        let is_main = key.is_empty();
        thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let trimmed = line.trim_end();
                        eprintln!("[pi agent] stderr: {trimmed}");
                        if is_main {
                            log_spawn_diag(&format!("child stderr: {trimmed}"));
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open pi agent stdin".to_string())?;
    *instance.child.lock().unwrap() = Some(ChildHandle::Local(child));

    let (writer_tx, writer_rx) = mpsc::channel::<String>();
    *instance.writer.lock().unwrap() = Some(writer_tx);
    thread::spawn(move || {
        let mut stdin = stdin;
        for line in writer_rx {
            if stdin.write_all(line.as_bytes()).is_err() {
                break;
            }
            let _ = stdin.flush();
        }
    });

    let instance_clone = Arc::clone(instance);
    let state_clone = Arc::clone(state);
    thread::spawn(move || {
        // Strict JSONL: split on \n only (pi docs/rpc.md framing rule).
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
            let record = line.trim_end_matches(['\n', '\r']);
            if !record.is_empty() {
                handle_line(&instance_clone, record);
            }
        }
        {
            let mut child_guard = instance_clone.child.lock().unwrap();
            if let Some(child) = child_guard.as_mut() {
                match child.try_wait_status() {
                    Some(status) => {
                        eprintln!(
                            "[pi agent] child exited: gen={} key={} status={:?}",
                            _generation,
                            instance_clone.key(),
                            status
                        );
                        log_spawn_diag(&format!(
                            "child exited: gen={} key={} status={:?}",
                            _generation,
                            instance_clone.key(),
                            status
                        ));
                    }
                    None => {
                        eprintln!(
                            "[pi agent] stdout EOF on live child: gen={} key={}",
                            _generation,
                            instance_clone.key()
                        );
                        log_spawn_diag(&format!(
                            "stdout EOF on live child: gen={} key={}",
                            _generation,
                            instance_clone.key()
                        ));
                    }
                }
            }
        }
        // Only do death bookkeeping if THIS thread's child is the current
        // one (generation unchanged → no respawn happened meanwhile).
        if instance_clone.generation.load(Ordering::SeqCst) == _generation {
            let quitting = state_clone.gateway.app_quitting.load(Ordering::SeqCst);
            instance_clone.initialized.store(false, Ordering::SeqCst);
            *instance_clone.writer.lock().unwrap() = None;
            instance_clone.pending.lock().unwrap().clear();
            // Release an in-flight turn with a STRUCTURED marker — never a bare
            // drop. A bare drop closes the oneshot with no reason at all, which
            // the frontend can only report as the unattributable "pi turn event
            // channel closed" (2026-09-21: that message turned out to be a kill()
            // race, not this branch — kill() now takes the waiter before the child
            // dies, so reaching HERE means the child really did exit on its own:
            // crash / external kill / OOM).
            let waiter = {
                let mut guard = instance_clone.turn_waiter.lock().unwrap();
                let w = guard.take();
                drop(guard);
                w
            };
            if let Some(w) = waiter {
                log_spawn_diag(&format!(
                    "child death: released armed turn waiter with process_exited marker (gen={} key={} quitting={})",
                    _generation,
                    instance_clone.key(),
                    quitting
                ));
                let _ = w.tx.send(json!({
                    "process_exited": true,
                    "message": "pi agent process exited unexpectedly",
                }));
            }
            let sid = instance_clone.current_session_id();
            // Fail any in-flight turn: dropping the waiter wakes the
            // session/prompt call with an error (the frontend's run loop
            // ends on it); a session-tagged error event also ends the view.
            if instance_clone.streaming.swap(false, Ordering::SeqCst) && !quitting {
                emit_helix_event(
                    "error",
                    &json!({
                        "session_id": sid,
                        "message": "pi agent process exited unexpectedly",
                    }),
                );
            }
            // Main instance dying = gateway-level disconnect (frontend bumps
            // its epoch, re-creating sessions on the next prompt) + self-heal
            // respawn. Session instances respawn lazily on their next RPC.
            if instance_clone.key().is_empty() && !quitting {
                emit_helix_event(
                    "gateway.disconnected",
                    &json!({ "backend": "pi", "session_id": Value::Null }),
                );
                let state_respawn = Arc::clone(&state_clone);
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(300));
                    let _ = spawn(&state_respawn);
                });
            }
        }
    });
    Ok(())
}

/// Background sweeper: kills idle session instances after IDLE_REAP_MS.
/// The main instance is never reaped (it serves global UI surfaces).
fn start_reaper() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(|| loop {
        thread::sleep(REAP_SWEEP_INTERVAL);
        let now = now_ms();
        let mut to_reap: Vec<Arc<PiInstance>> = Vec::new();
        {
            let instances = INSTANCES.lock().unwrap();
            for (key, instance) in instances.iter() {
                if key.is_empty() {
                    continue; // main instance: never reap
                }
                if key.starts_with("spare-") {
                    continue; // warm spares: idle by design, keep them hot
                }
                if instance.initialized.load(Ordering::SeqCst)
                    && !instance.streaming.load(Ordering::SeqCst)
                    && now.saturating_sub(instance.last_active_ms.load(Ordering::SeqCst))
                        > IDLE_REAP_MS
                {
                    to_reap.push(Arc::clone(instance));
                }
            }
        }
        for instance in to_reap {
            eprintln!(
                "[pi agent] reaping idle instance (session {})",
                instance.key()
            );
            instance.kill();
        }
    });
}

/// Send a pi command frame and wait for its `response` (correlated by `id`).
fn request_frame(method: &str, params: Value) -> Result<(String, String), String> {
    let id = format!("helix-{}", REQUEST_ID.fetch_add(1, Ordering::SeqCst));
    let mut frame = json!({ "id": id, "type": method });
    if let Some(obj) = params.as_object() {
        for (key, value) in obj {
            frame[key.as_str()] = value.clone();
        }
    }
    let line = serde_json::to_string(&frame).map_err(|e| e.to_string())? + "\n";
    Ok((id, line))
}

/// Extract text + images from the Helix prompt shape:
/// - `prompt` as a string → message
/// - `prompt` as an array of blocks: `{type:"text", text}` +
///   `{type:"image_url", image_url:{url}}` (data: URLs)
/// - `images` (array of data URLs) also accepted.
// ── 粘贴图片 → describe_image 分流（见 session/prompt）──────────────────────
// 最早的逻辑是在 session/prompt 里无条件对粘贴图跑 `vision_describe_core` 自动
// 转述。现在改为按序分流：
//   ① 多模态主模型     → 原生透传 images，不转述不提示（模型自己读图）
//   ② 文本模型 + 工具可用 → 图片落盘成文件 + prompt 给路径提示，模型按需调
//                          describe_image（可自定义提问，省一次固定视觉调用）
//
// ③（旧的「网关无条件自动转述」）已于 2026-10-06 移除。理由：
//   - 它与 ② 读**同一份** `vision:` 配置、调**同一个**视觉模型、产出**同一种**
//     「图的文字描述」——两份实现，同一件事。
//   - 质量明显更差：`vision.rs` 那份没有 system prompt，只有一句写死的
//     "Describe this image in detail"；而 describe_image 带「穷尽转写底座契约」
//     （先分类 → 逐字转写 → 标注布局 → 再回答 → 完整性声明），且撞 max_tokens
//     时会显式声明截断。
//   - 每张图白跑一次视觉调用，不管模型需不需要。
// 现在②是**唯一**的识图通路；工具不可用时图片仍落盘，但提示里会明说「你看不懂」
// —— 静默丢弃比明说更坏，模型至少知道自己缺了什么。
//
// 工具可用判定 = pi ≥ 1.0.0（pi-aux-vision 的硬要求）且 settings.json
// packages 里登记了 pi-aux-vision。describe_image 的 gating 只把工具暴露给
// 不支持图片输入的模型，与 ① 的判定天然互补。

/// pi CLI 是否 ≥ 1.0.0（describe_image 工具所在的 pi-aux-vision 的硬要求）。
/// 用与 spawn 相同的 pi_cli_args 探测，结果缓存；任何失败都按 false 处理
/// （保守 → 走自动转述兜底，不阻断贴图）。
fn pi_describe_image_supported() -> bool {
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(|| {
        let (mut cmd, _) = pi_cli_args();
        let Ok(out) = cmd.arg("--version").output() else {
            return false;
        };
        String::from_utf8_lossy(&out.stdout)
            .split(['.', ' ', '\n'])
            .find_map(|t| t.parse::<u32>().ok())
            .map(|major| major >= 1)
            .unwrap_or(false)
    })
}

/// settings.json `packages` 里是否登记了 pi-aux-vision。
fn pi_aux_vision_registered() -> bool {
    crate::config::read_pi_settings()
        .get("packages")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .any(|p| p.as_str().map(|s| s.contains("pi-aux-vision")).unwrap_or(false))
        })
        .unwrap_or(false)
}

/// 本实例当前模型是否原生支持图片输入。
fn current_model_supports_images(instance: &PiInstance) -> bool {
    let model = instance.current_model.lock().unwrap().clone();
    let provider = instance.current_provider.lock().unwrap().clone();
    crate::config::model_supports_image_input(model.as_deref().unwrap_or(""), provider.as_deref())
}

/// 把粘贴图片（pi ImageContent `{type:"image", data, mimeType}`）解码落盘到
/// `~/.pi/agent/paste-images/`（pi_agent_dir，和其他 pi 配置同级），返回可读的
/// 绝对路径列表。顺带 best-effort 清理 7 天前的旧文件，防目录无限膨胀。
/// 返回空 Vec = 全部失败。
fn save_pasted_images(images: &[Value]) -> Vec<String> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    let dir = crate::paths::pi_agent_dir().join("paste-images");
    if std::fs::create_dir_all(&dir).is_err() {
        return Vec::new();
    }
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let cutoff = std::time::SystemTime::now()
            .checked_sub(Duration::from_secs(7 * 24 * 3600))
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        for e in entries.flatten() {
            if let Ok(md) = e.metadata() {
                if md.modified().map(|t| t < cutoff).unwrap_or(false) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    let mut paths = Vec::new();
    for (i, img) in images.iter().enumerate() {
        let Some(data) = img.get("data").and_then(Value::as_str) else { continue };
        let Ok(bytes) = B64.decode(data) else { continue };
        let mime = img
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("image/png");
        let ext = match mime {
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/bmp" => "bmp",
            _ => "png",
        };
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = dir.join(format!("paste-{nanos:x}-{}.{ext}", i + 1));
        if std::fs::write(&path, &bytes).is_ok() {
            paths.push(path.to_string_lossy().into_owned());
        }
    }
    paths
}

fn prompt_parts(params: &Value) -> Result<(String, Vec<Value>), String> {
    let mut text = String::new();
    let mut images: Vec<Value> = Vec::new();
    match params.get("prompt") {
        Some(Value::String(prompt)) => text = prompt.clone(),
        Some(Value::Array(blocks)) => {
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = block.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(t);
                        }
                    }
                    Some("image_url") | Some("image") => {
                        let url = block
                            .pointer("/image_url/url")
                            .or_else(|| block.get("url"))
                            .or_else(|| block.get("data"))
                            .and_then(Value::as_str);
                        if let Some(image) = parse_image_data(url) {
                            images.push(image);
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {
            if let Some(arr) = params.get("images").and_then(Value::as_array) {
                for url in arr.iter().filter_map(Value::as_str) {
                    if let Some(image) = parse_image_data(Some(url)) {
                        images.push(image);
                    }
                }
            }
        }
    }
    if text.trim().is_empty() && images.is_empty() {
        return Err("session/prompt is missing text".into());
    }
    Ok((text, images))
}

/// Data URLs (frontend attachments) → pi ImageContent `{data, mimeType}`.
fn parse_image_data(url: Option<&str>) -> Option<Value> {
    let url = url?.trim();
    if let Some(rest) = url.strip_prefix("data:") {
        let (meta, data) = rest.split_once(',')?;
        let mime = meta
            .split(';')
            .next()
            .filter(|m| !m.is_empty() && m.starts_with("image/"))
            .unwrap_or("image/png");
        Some(json!({ "type": "image", "data": data, "mimeType": mime }))
    } else if url.starts_with("http://") || url.starts_with("https://") {
        // pi RPC images are base64-only; skip remote URLs rather than fail.
        None
    } else {
        // Raw base64 blob.
        Some(json!({ "type": "image", "data": url, "mimeType": "image/png" }))
    }
}

/// 重放历史的条数上限（只保留最近 N 轮）。
const SEED_MAX_TURNS: usize = 40;
/// 重放历史的字符预算（超了就从最早处丢整轮）。
const SEED_MAX_CHARS: usize = 24_000;

/// ─────────────────────────────────────────────────────────────────────────
/// HISTORY → NEW SESSION  （职责隔离：这不是 Resume 的 fallback）
///
/// 这段机制的作用是把一份**已有的本地历史**作为会话开场消息注入到一个
/// **全新的** session 里，让新会话带着上下文启动。它属于「History → New
/// Session」这一职责：调用方必须已经决定要开一个新会话，历史只是新会话的
/// 初始上下文。
///
/// 它**绝不**是 `session/resume` 的 fallback。Resume 的契约是：按 SID 恢复
/// 原会话；SID 对应的文件不存在 → `session_not_found`，由前端把会话标记为
/// broken 并结束——不允许「resume 失败 → session/new + seed」换一个新 SID
/// 顶替。那样做的直接后果是新会话文件里第一句话是这段注入的对话记录，
/// 而真正的原始会话从此无法再被找回（指纹/映射全部指向一个不存在的 SID）。
/// 因此 `session/resume` 处理器里**不得**调用本函数或 `spawn_history_seed_turn`。
/// 若将来需要迁移/合并会话，请走 session/merge 之类显式命名的 RPC，不要
/// 把本机制接回 Resume 链。
/// ─────────────────────────────────────────────────────────────────────────

/// History → New Session: the session-opening user message that seeds a FRESH
/// session with prior history (session/new {messages: [{role, content}, …]}).
/// Renders as a transcript the model can continue from; asks for no response
/// beyond a short ack. See the block above for the Resume prohibition.
fn build_history_seed_prompt(messages: Option<&Value>) -> String {
    let Some(messages) = messages.and_then(Value::as_array) else {
        return String::new();
    };
    let mut turns: Vec<String> = Vec::new();
    for m in messages {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("user");
        let content = m
            .get("content")
            .or_else(|| m.get("text"))
            .map(|c| match c {
                Value::String(s) => s.clone(),
                Value::Array(_) => content_to_text(c)
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_default(),
                _ => String::new(),
            })
            .unwrap_or_default();
        if content.trim().is_empty() {
            continue;
        }
        let speaker = match role {
            "user" => "用户",
            "assistant" => "助手",
            _ => continue,
        };
        turns.push(format!("[{}]\n{}", speaker, content));
    }
    if turns.is_empty() {
        return String::new();
    }
    // 上限：只重放**最近**的若干轮，再按字符预算从头丢整轮。前端传的是对话
    // 全部本地历史（没有截断），长对话一次重建就会把几万 token 灌进新会话，
    // 既贵又会把模型带偏。近期上下文才是恢复的重点，所以从最早处裁。
    // 注意**按整轮裁、不做字节切片**——切字节要处理 char 边界（多字节字符
    // 中间切会 panic），丢整轮天然安全。
    if turns.len() > SEED_MAX_TURNS {
        turns.drain(0..turns.len() - SEED_MAX_TURNS);
    }
    let mut body_len: usize = turns.iter().map(|t| t.len() + 2).sum();
    let mut cut = 0usize;
    while cut + 1 < turns.len() && body_len > SEED_MAX_CHARS {
        body_len -= turns[cut].len() + 2;
        cut += 1;
    }
    if cut > 0 {
        turns.drain(0..cut);
    }
    // Only prepend the "（系统注入…）" marker when a real prior-conversation
    // replay is being re-established (multiple turns). A brand-new
    // conversation (0–1 turn) is returned raw, so a clean session/new no
    // longer bakes the marker into the file's first user message — that
    // was the root cause of it showing on every restart.
    if turns.len() > 1 {
        return format!(
            "（系统注入：以下是本次会话恢复的先前对话记录，供你恢复上下文。无需重新执行其中已完成的工作，直接基于这些上下文继续后续对话即可。请只回复一个「好」，不要复述、不要解释这段记录。）\n\n{}",
            turns.join("\n\n")
        );
    }
    turns.join("\n\n")
}

/// History → New Session: replay prior history into a FRESHLY CREATED session
/// as its opening user message. Called ONLY from `session/new`, AFTER the new
/// session id is known and the instance is re-keyed. See the block above
/// `build_history_seed_prompt` for the Resume prohibition.
///
/// Fire-and-forget: AWAITING the seed turn (the old request_turn call) held
/// session/new until the model finished digesting the whole replayed history —
/// meanwhile the frontend's run loop had not yet subscribed to events or sent
/// the real prompt, so the UI sat in "工作中" with zero streaming output for
/// minutes ("重启后旧对话一直不输出"). Worse, a seed turn that raised an
/// approval/clarify card deadlocked: the backend waits for the user, but the
/// card event had no subscriber yet. The seed is sent as a plain queued prompt:
/// the ack (session_id) returns immediately, and pi's queue serializes it ahead
/// of the caller's real prompt, preserving turn order without blocking the send.
///
/// Turn debt: the seed's agent_settled consumes the debt instead of releasing
/// the real prompt's waiter (registered after this returns) — the seed settles
/// FIRST because pi serializes the queue, and without the debt its settle
/// prematurely completes the caller's run with empty output.
async fn spawn_history_seed_turn(
    instance: &Arc<PiInstance>,
    history: Option<&Value>,
    session_id: &str,
) -> usize {
    let seed = build_history_seed_prompt(history);
    if seed.is_empty() {
        return 0;
    }
    // Diagnostics: every use of this mechanism must be visible in the
    // recover log. A seed turn means a NEW session was opened carrying
    // imported history — if that ever shows up where a resume is expected,
    // the wiring is wrong.
    log_spawn_diag(&format!(
        "history → new session: sid={session_id} seeded {len} chars of prior history",
        len = seed.len()
    ));
    instance.begin_debt_turn();
    if let Err(e) = instance
        .request("prompt", json!({ "message": seed }), RPC_TIMEOUT)
        .await
    {
        eprintln!("[pi agent] history seed turn failed: {e}");
        log_spawn_diag(&format!("history → new session: seed failed sid={session_id}: {e}"));
        instance.end_debt_turn();
    }
    seed.len()
}

/// Top-level RPC dispatch (Tauri `helix_send`). Routes session-scoped calls
/// to the instance owning that session; everything else to the main instance.
pub async fn send(method: &str, params: Value) -> Result<Value, String> {
    let state = crate::state::app_state().ok_or("app state unavailable")?;
    start_reaper();

    let method = method.replace('.', "/");
    let method = method.as_str();

    match method {
        "session/new" => {
            log_spawn_diag(&format!(
                "session/new: cwd={:?} msgs={}",
                params.get("cwd").and_then(Value::as_str),
                params
                    .get("messages")
                    .and_then(Value::as_array)
                    .map(|a| a.len())
                    .unwrap_or(0),
            ));
            // Dedicated instance per conversation: pi keeps ONE active
            // session per process, so a fresh conversation gets a fresh pi
            // child, in the conversation's own project dir. A warm spare
            // (pre-spawned + handshaked) skips pi's 10s+ cold start when its
            // dir matches the conversation's; anything else spawns on demand.
            let cwd = params
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty())
                .map(str::to_string);
            // 远程对话：前端把**远端**绝对路径放在 `remote_cwd` 里（只有它知道 ——
            // session.workDir 是 `remote://<机器>/<路径>` 虚拟键，见前端
            // lib/remote-projects.ts）。这条会话走隧道，并且**不能**认领预热
            // spare：池子里清一色是本地子进程。
            let remote_cwd = params
                .get("remote_cwd")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty())
                .map(str::to_string);
            // No project picked: the conversation must NOT inherit the last
            // used project (persisted workdir.json — the global work_dir).
            // That's how a brand-new chat landed in e.g. the LangGraph dir
            // just because a previous conversation ran there. The no-project
            // default dir (`~/.pi/agent/workspace/default`, outside
            // sessions/) is the neutral home; a warm spare (spawned in the
            // global dir) is never claimed for such a conversation either.
            let spawn_cwd = remote_cwd.clone().or_else(|| cwd.clone()).or_else(|| {
                Some(
                    crate::state::pi_sessions_default_dir()
                        .to_string_lossy()
                        .into_owned(),
                )
            });
            let instance = if remote_cwd.is_some() {
                rearm_warm_spares(&state);
                let temp_key = format!(
                    "pending-{}",
                    REQUEST_ID.fetch_add(1, Ordering::SeqCst)
                );
                spawn_instance(temp_key, spawn_cwd, true, &state)?
            } else {
                match take_warm_spare(spawn_cwd.as_deref()) {
                    Some(spare) => {
                        // Claimed — rearm a replacement for the next session.
                        rearm_warm_spares(&state);
                        spare
                    }
                    None => {
                        // Pool empty or dir mismatch: spawn on demand + rearm so
                        // the NEXT session/new finds a warm spare.
                        rearm_warm_spares(&state);
                        let temp_key = format!(
                            "pending-{}",
                            REQUEST_ID.fetch_add(1, Ordering::SeqCst)
                        );
                        spawn_instance(temp_key, spawn_cwd, false, &state)?
                    }
                }
            };
            instance
                .request("new_session", Value::Null, RPC_TIMEOUT)
                .await?;
            // Pi has no persistent thinking-level config key — re-apply the
            // user's chosen effort now that this conversation's session exists
            // (set_thinking_level may require an active session, so we apply
            // here in addition to the spawn-time attempt).
            if let Some(effort) = configured_effort() {
                let level = normalize_effort(&effort);
                let _ = instance
                    .request("set_thinking_level", json!({ "level": level }), RPC_TIMEOUT)
                    .await;
            }
            // session/new's mode_id was previously dropped here — a new
            // conversation created in plan mode then ran its FIRST prompt with
            // the plan contract never armed, so the model skipped straight to
            // execution. Arm it the same way session/set_mode does: a plan
            // mode_id translates into the /plan start extension command.
            let initial_mode = params
                .get("mode_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if initial_mode == "plan" {
                // Fire-and-forget arm turn: register turn debt so its
                // agent_settled is not mistaken for the real prompt's.
                instance.begin_debt_turn();
                if let Err(e) = instance
                    .request("prompt", json!({ "message": "/plan start" }), RPC_TIMEOUT)
                    .await
                {
                    eprintln!("[pi agent] /plan start failed: {e}");
                    instance.end_debt_turn();
                }
                *instance.plan_mode.lock().unwrap() = true;
            }
            let state_data = instance.session_state().await?;
            let session_id = state_data
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_default();
            if session_id.is_empty() {
                return Err("pi new_session returned no sessionId".into());
            }
            // Re-key BEFORE the seed turn: its events (and any extension UI
            // request it raises) must already be routable under the real
            // session id.
            rekey_instance(&instance, session_id.clone());
            // 登记「这个 sid 是远程会话，目录在远端 …」——实例被回收后重新 spawn
            // 时靠它选对通道（session/prompt 不带 cwd，无从判断）。
            if let Some(dir) = &remote_cwd {
                remember_remote_session_dir(&session_id, dir);
            }
            // seedHistory (gateway restart / reaped conversation rebuild): pi
            // has no RPC to inject prior history into a session, so replay it
            // as the session-opening user message. Only user/assistant turns
            // are carried — tool noise would hurt more than help.
            //
            // Fire-and-forget: AWAITING the seed turn (old request_turn call)
            // held session/new until the model finished digesting the whole
            // replayed history — meanwhile the frontend's run loop had not yet
            // subscribed to events or sent the real prompt, so the UI sat in
            // "工作中" with zero streaming output for minutes (the user saw the
            // classic "重启后旧对话一直不输出"). Worse, a seed turn that raised
            // an approval/clarify card deadlocked: the backend waits for the
            // user, but the card event had no subscriber yet. The seed is now
            // sent as a plain queued prompt: the ack (session_id) returns
            // immediately, and pi's queue serializes it ahead of the caller's
            // real prompt, preserving turn order without blocking the send.
            let seeded = spawn_history_seed_turn(&instance, params.get("messages"), &session_id)
                .await;
            log_spawn_diag(&format!(
                "session/new OK sid={session_id} seed_len={}",
                seeded
            ));
            emit_helix_event(
                "gateway.sessionCreated",
                &json!({ "sessionId": session_id }),
            );
            Ok(json!({ "session_id": session_id, "threadId": session_id }))
        }
        "session/peek" => {
            // Instant history read WITHOUT the pi process: tail the jsonl
            // directly (O(last 512KB), independent of session length). First
            // paint when switching back to an old conversation.
            let session_id = params
                .get("session_id")
                .and_then(Value::as_str)
                .ok_or("session/peek is missing session_id")?
                .to_string();
            let count = params
                .get("count")
                .and_then(Value::as_u64)
                .unwrap_or(30) as usize;
            peek_session_tail(&session_id, count)
        }
        "session/index_put" => {
            // 前端 rebindSessionSid 之后调用：把 conversation → sid 的关系冗余
            // 落盘。IndexedDB 的 sessionMap 被 delete / site-data 清空之后，
            // 这是唯一还能反查"这个后端会话属于哪个对话"的地方。
            let mut pairs: Vec<(String, String)> = Vec::new();
            if let Some(arr) = params.get("entries").and_then(Value::as_array) {
                for e in arr {
                    if let (Some(cid), Some(sid)) = (
                        e.get("conversation_id").and_then(Value::as_str),
                        e.get("session_id").and_then(Value::as_str),
                    ) {
                        if !cid.is_empty() && !sid.is_empty() {
                            pairs.push((cid.to_string(), sid.to_string()));
                        }
                    }
                }
            }
            if !pairs.is_empty() {
                index_upsert(&pairs);
            }
            Ok(json!({ "indexed": pairs.len() }))
        }
        "session/index_get" => {
            let session_id = params
                .get("session_id")
                .and_then(Value::as_str)
                .ok_or("session/index_get is missing session_id")?
                .to_string();
            Ok(index_lookup(&session_id))
        }
        "session/index_lookup_conversation" => {
            // conversation → sid 反查（前端「有本地历史但无 SID」时的兜底）。
            // 以前前端就在调这个名字，但网关没有这个分支 → 每次都是 unknown
            // method → 反查恒失败 → 那种对话一律被判"永久失效"。
            let conversation_id = params
                .get("conversation_id")
                .and_then(Value::as_str)
                .ok_or("session/index_lookup_conversation is missing conversation_id")?
                .to_string();
            Ok(index_lookup_conversation(&conversation_id))
        }
        "session/index_del" => {
            // 删除对话时同步清理反向索引：按前端 conversation_id 全表移除，
            // 不再需要先查 sid（删除路径只拿得到 conversation id）。
            let mut ids: Vec<String> = Vec::new();
            if let Some(arr) = params.get("conversation_ids").and_then(Value::as_array) {
                for e in arr {
                    if let Some(cid) = e.as_str() {
                        if !cid.is_empty() {
                            ids.push(cid.to_string());
                        }
                    }
                }
            }
            let removed = if ids.is_empty() {
                0
            } else {
                index_remove(&ids)
            };
            Ok(json!({ "removed": removed }))
        }
        "session/prepare" => {
            // Fire-and-forget resume warmup: restores the session's instance
            // (spawn/spare-claim + switch_session) in the BACKGROUND so the
            // user's first prompt finds it hot instead of paying the whole
            // restore latency inside "工作中". Notifies the frontend via
            // gateway.sessionPrepared when done.
            let session_id = params
                .get("session_id")
                .and_then(Value::as_str)
                .ok_or("session/prepare is missing session_id")?
                .to_string();
            // Already live → nothing to warm.
            if let Some(instance) = INSTANCES.lock().unwrap().get(&session_id) {
                if instance.initialized.load(Ordering::SeqCst) {
                    emit_helix_event(
                        "gateway.sessionPrepared",
                        &json!({ "session_id": session_id, "ok": true }),
                    );
                    return Ok(json!({ "prepared": true, "live": true }));
                }
            }
            let state_clone = Arc::clone(&state);
            tokio::task::spawn(async move {
                let started = std::time::Instant::now();
                let result = instance_for_session(&session_id, &state_clone).await;
                if let Err(e) = result {
                    let kind = classify_session_error(&e);
                    eprintln!("[pi agent] session prepare failed for {session_id}: {e}");
                    log_spawn_diag(&format!(
                        "session/prepare FAILED sid={session_id} kind={kind}: {e}"
                    ));
                    // Same error_kind contract as session/resume: warm-up callers
                    // can decide `broken` vs retryable from the kind alone.
                    emit_helix_event(
                        "gateway.sessionPrepared",
                        &json!({
                            "session_id": session_id,
                            "ok": false,
                            "error": e,
                            "error_kind": kind,
                        }),
                    );
                    return;
                }
                eprintln!(
                    "[pi agent] session prepared for {session_id} in {:?}",
                    started.elapsed()
                );
                emit_helix_event(
                    "gateway.sessionPrepared",
                    &json!({ "session_id": session_id, "ok": true }),
                );
            });
            Ok(json!({ "prepared": true }))
        }
        "remote/probe" => {
            // 启动路径的远程探活：config.yaml 配了 `pi.remote_rpc` 才算「远程
            // 模式配过」；2s TCP 探一次本地隧道口。**不 spawn、不碰凭证、不读
            // 会话**——前端据此决定「这个远程对话要不要恢复」：连不上就不恢复
            // （不 set_mode、不 resume、不干等），连得上才走正常恢复链。
            //
            // 只证明「隧道本地监听在」，不证明远端 pi 活着（那要一次 RPC 往返，
            // 启动路径等不起）。真连上但远端已死的情况，随后的 switch_session
            // 会快速 EOF 报错兜底，不会挂住。
            let Some(endpoint) = remote_rpc_endpoint() else {
                return Ok(json!({ "configured": false, "reachable": false }));
            };
            if remote_marked_down() {
                return Ok(
                    json!({ "configured": true, "reachable": false, "cooling": true }),
                );
            }
            let reachable = remote_endpoint_reachable(&endpoint);
            Ok(json!({ "configured": true, "reachable": reachable, "endpoint": endpoint }))
        }
        "session/resume" => {
            // Resume = restore THIS session, by its SID. Exactly one of:
            //   live / restored            → Ok(state)
            //   file missing               → Ok({error, error_kind:"session_not_found"})
            //   file found, restore failed → Ok({error, error_kind:"session_restore_failed"})
            //   anything else              → Ok({error, error_kind:"internal"})
            // and NEVER `session/new` + `build_history_seed_prompt` /
            // `spawn_history_seed_turn`. Replacing a lost session with a fresh
            // seeded one would mint a new SID that shadows the dead one, and
            // the original conversation becomes unrecoverable. The decision of
            // whether a failure is permanent (`broken`) belongs to the
            // frontend, and it must be driven by error_kind — not by "it
            // failed, therefore broken".
            let session_id = params
                .get("session_id")
                .and_then(Value::as_str)
                .ok_or("session/resume is missing session_id")?
                .to_string();
            // Respawns the instance (switch_session restores the reaped
            // conversation from its session file) if it is not live.
            log_spawn_diag(&format!("session/resume: sid={session_id}"));
            let resume_started = now_ms();
            let instance = match instance_for_session(&session_id, &state).await {
                Ok(i) => i,
                Err(e) => {
                    let kind = classify_session_error(&e);
                    log_spawn_diag(&format!(
                        "session/resume FAILED sid={session_id} kind={kind}: {e}"
                    ));
                    // Structured, NOT a throw: the frontend decides whether the
                    // session is permanently `broken` from `error_kind`, and only
                    // `session_not_found` earns that. Returning an Err would
                    // collapse every failure mode into one indistinguishable
                    // string and force the frontend back to guessing.
                    return Ok(json!({ "error": e, "error_kind": kind }));
                }
            };
            log_spawn_diag(&format!(
                "session/resume OK sid={session_id} elapsed_ms={}",
                now_ms() - resume_started
            ));
            // 实例**活着**也不等于会话还在磁盘上：jsonl 可能被删（清理/人工删除）。
            // 此时照常回 Ok 的话，前端会沿用这个 sid 继续发 prompt，pi 在内存里
            // 续写、把文件在原路径旁路重建出来（同 sid 的新 jsonl、内容只剩新轮
            // 次）——用户看到的就是"静默新建了会话文件"。语义对齐 restore 的
            // 落地校验（4223 行注释）：文件不在（本机扫描 + 远端登记都没有）→
            // 按文件丢失处理，让前端走锁死阶梯。这层是恢复阶梯 ①/② 验证的
            // 权威兜底。
            if remote_session_file(&session_id).is_none()
                && remote_session_dir(&session_id).is_none()
                && find_session_file(&session_id).is_none()
            {
                log_spawn_diag(&format!(
                    "session/resume FAILED sid={session_id} kind=session_not_found: live instance but jsonl gone"
                ));
                return Ok(json!({
                    "error": format!("no session file for {session_id}"),
                    "error_kind": "session_not_found",
                }));
            }
            // Restore-time context read for the frontend's context ring:
            // session/new's seed-history replay can re-shape the active
            // branch, so estimate AFTER the switch has landed. `context_max`
            // resolves against THIS session's own model (per-session override
            // included); the global default is only the last resort — see
            // `PiInstance::context_max`.
            let (jsonl_estimate, jsonl_categories, jsonl_anchor) =
                jsonl_active_branch_estimate(&instance);
            let estimated = jsonl_estimate;
            let ctx_max = instance.context_max(None);
            // Floor the estimate with the last REAL per-call figure. Priority:
            // chars/4 estimate → persisted jsonl usage anchor (last provider
            // `totalTokens` written into the session file, survives a gateway
            // restart) → volatile in-process last_context_used. Without the
            // anchor, a respawn reports 0 → estimate-only ("对话中 50k →
            // 对话后 20.7k" or straight to 0).
            let resumed_context_used =
                estimated.max(jsonl_anchor).max(instance.last_context_used()).max(0);
            let resumed_context_max = ctx_max;
            let resumed_context_percent = if resumed_context_max > 0 {
                (resumed_context_used as f64 / resumed_context_max as f64) * 100.0
            } else {
                0.0
            };
            // Carried buckets as-is; fall back to the aggregate lump so the
            // panel shows a stable single row instead of an empty set.
            let mut categories: Value = jsonl_categories.unwrap_or(Value::Array(Vec::new()));
            if resumed_context_used > 0 && categories == Value::Array(Vec::new()) {
                categories = json!({
                    "id": "conversation",
                    "label": "整体上下文占用",
                    "tokens": resumed_context_used,
                    "color": "var(--context-usage-conversation)",
                    "aggregate": true,
                });
            }
            // 回给前端的身份**固定是请求的 sid**，不是 current_session。
            //
            // `current_session` 在 restore 的 rekey→switch_session 窗口内可能
            // 还是 pi 启动时自建的内存态幽灵 sid（从无 jsonl）；把它回传出去，
            // 前端就会拿它 rebind 映射，之后每次 resume 都是
            // `no session file`。而且前端拿到的 map key 本来就是这个 sid，
            // 后续所有 RPC 也都按它路由，回传别的值只会让身份漂移。
            let resumed_id = session_id.clone();
            // The resync path replaces the visible transcript with the
            // backend's authoritative history — return it in the shape
            // mapBackendMessages reads (role + text/content). Plain user /
            // assistant turns come back as text; `toolResult` entries are
            // rebuilt into tool_group blocks (tool_call + tool_result steps)
            // so the transcript renders them as real tool cards — including a
            // proper ✕ failed card for an interrupted tool — instead of a
            // flat "bash (错误):\n<output>" assistant text line.
            let pi_messages = instance
                .request("get_messages", Value::Null, RPC_TIMEOUT)
                .await?
                .get("messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let messages: Vec<Value> = pi_messages
                .iter()
                .filter_map(|m| match m.get("role").and_then(Value::as_str) {
                    Some("user") => {
                        let text = match m.get("content") {
                            Some(Value::String(s)) => s.clone(),
                            Some(Value::Array(_)) => content_to_text(
                                m.get("content").unwrap(),
                            )
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_default(),
                            _ => String::new(),
                        };
                        Some(json!({
                            "id": m.get("id").and_then(Value::as_str),
                            "role": "user",
                            "text": text,
                            "timestamp": m.get("timestamp"),
                        }))
                    }
                    Some("assistant") => {
                        let text = content_to_text(
                            m.get("content").unwrap_or(&Value::Null),
                        )
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_default();
                        Some(json!({
                            "id": m.get("id").and_then(Value::as_str),
                            "role": "assistant",
                            "text": text,
                            "timestamp": m.get("timestamp"),
                        }))
                    }
                    Some("toolResult") => {
                        // Reconstruct a proper tool-step block (tool_call +
                        // tool_result steps) instead of folding the result into
                        // a flat assistant text line. The frontend's
                        // transcript renderer shows this as a real tool card
                        // (✕ glyph for failures), matching the live streaming
                        // path — rather than the old "bash (错误):\n<output>"
                        // plain text that looked like garbled output.
                        let tool_name = m
                            .get("toolName")
                            .and_then(Value::as_str)
                            .unwrap_or("tool");
                        let is_error =
                            m.get("isError").and_then(Value::as_bool) == Some(true);
                        let text = match m.get("content") {
                            Some(Value::String(s)) => s.clone(),
                            Some(other) => content_to_text(other)
                                .as_str()
                                .map(str::to_string)
                                .unwrap_or_default(),
                            None => String::new(),
                        };
                        let timestamp = m.get("timestamp").cloned().unwrap_or(Value::Null);
                        let msg_id = m
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let tool_params = m
                            .get("toolParams")
                            .cloned()
                            .unwrap_or_else(|| json!({}));
                        let status = if is_error { "failed" } else { "completed" };
                        let call_id = format!("{}-call", msg_id);
                        let result_id = format!("{}-result", msg_id);
                        Some(json!({
                            "id": msg_id,
                            "role": "assistant",
                            "content": "",
                            "timestamp": timestamp,
                            "blocks": [{
                                "type": "tool_group",
                                "steps": [
                                    {
                                        "id": call_id,
                                        "type": "tool_call",
                                        "toolName": tool_name,
                                        "status": status,
                                        "toolParams": tool_params,
                                        "content": "",
                                        "timestamp": timestamp,
                                    },
                                    {
                                        "id": result_id,
                                        "type": "tool_result",
                                        "toolName": tool_name,
                                        "status": status,
                                        "content": text,
                                        "timestamp": timestamp,
                                    },
                                ],
                            }],
                        }))
                    }
                    _ => None,
                })
                .collect();
            emit_helix_event(
                "gateway.sessionCreated",
                &json!({ "sessionId": resumed_id }),
            );
            Ok(json!({
                "session_id": resumed_id,
                "threadId": resumed_id,
                "messages": messages,
                "context_used": resumed_context_used,
                "context_max": resumed_context_max,
                "context_percent": resumed_context_percent,
                "categories": categories,
            }))
        }
        "session/file_exists" => {
            // 轻量存在性检查：SID 的持久化 jsonl 是否还在磁盘上。恢复阶梯的
            // ①「现存 sid 直接沿用（不付 resume 代价）」用它在**不 spawn 实例**
            // 的前提下验证凭据仍然有效——pi 对缺失的 sessionPath 不报错而是
            // 就地 newSession 铸新 sid（SessionManager._setSessionFile），直接
            // 发 prompt 会静默开新会话文件。文件不在就回 false 让前端锁死。
            let sid = params
                .get("session_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("session/file_exists is missing session_id")?;
            Ok(json!({ "ok": find_session_file(sid).is_some() }))
        }
        "session/latest_for_cwd" => {
            // Recover the newest on-disk pi session file for a conversation's
            // project dir WITHOUT needing a persisted sid. The frontend's
            // conversation→sid mapping (conversationSessions) can be empty
            // after a user wipes it or a wipe-on-restart — in that case the
            // resume branch is skipped and handleRun falls through to
            // session/new + seedHistory, re-injecting "系统注入" every time.
            // pi CLI's `resume` sidesteps this by scanning the sessions dir;
            // this RPC gives Helix the same locate-and-resume behavior, handing
            // back the uuid of the matching jsonl so the caller resumes it
            // (switch_session, no new file, no replay). Reads only the 4KB
            // header of each candidate — O(files).
            //
            // Selection is **行数最多者优先**（见 find_session_file_by_cwd），
            // 所以这个 RPC 只在 cwd 能唯一圈定对话时才成立。
            //
            // 缺 cwd **必须拒绝**，绝不能回退到中立兜底目录
            // (~/.pi/agent/workspace/default)：
            // 有项目的对话 cwd 唯一、语义成立；而所有**无项目**的对话共用同一
            // 个兜底目录，那个共享桶里"行数最多"= "历史上最长的一条无关对话"。
            // 一旦回退过去，新建对话会认领别人的老会话、把自己的消息续写进去；
            // 更糟的是被续写的文件此后永远行数最多 → 每次都抢同一个文件，形成
            // 不可逆劫持。（2026-09-18 踩过：一次"无项目时也去 resume"的改动让
            // 新对话挂到了两天前那条含 120KB base64 图片的会话上。）
            let cwd = params
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty())
                .map(str::to_string)
                .ok_or("session/latest_for_cwd is missing cwd")?;
            // Optional conversation fingerprint: the caller's first user message.
            // When present we match by fingerprint (precise, no hijack); otherwise
            // the legacy "longest chain in this cwd" fallback is used.
            let first_user_message = params
                .get("first_user_message")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty());
            let candidates = match first_user_message {
                Some(_) => find_session_files_by_cwd(&cwd, first_user_message, 5),
                // 无指纹：退回旧"行数最多"启发（保持旧行为，仅前端未传指纹时）。
                None => find_session_file_by_cwd(&cwd, None).into_iter().collect(),
            };
            log_spawn_diag(&format!(
                "latest_for_cwd: cwd={cwd:?} fp={:?} -> {:?}",
                first_user_message.map(|f| f.chars().take(40).collect::<String>()),
                candidates
            ));
            // session_ids = 按 mtime 新→旧的候选；session_id 保留第一个
            // （旧前端只读它）。分叉会复制完整历史 → 父/分叉指纹相同，单一
            // "最佳"答案有歧义，调用方需逐个尝试、跳过被其他对话占用的 sid。
            Ok(json!({
                "session_ids": candidates,
                "session_id": candidates.first(),
            }))
        }
        "session/set_mode" => {
            let instance = routed_instance(&params, &state).await?;
            // pi has no per-session approval modes; the plan-mode extension
            // (@narumitw/pi-plan-mode) provides the read-only planning
            // contract. Extension commands (`/plan …`) execute immediately
            // even mid-stream, so translate Helix mode switches into them:
            //   - entering "plan"  → /plan start (activates the contract,
            //     gates write tools until the user approves implementation)
            //   - leaving "plan"   → /plan exit (clears the active/saved plan
            //     and unlocks the tools)
            // Any other mode_id only means "not in plan mode" (no-op when the
            // instance was already unlocked). The permission tier (ask/auto/
            // full) is NOT handled here: the gate that actually blocks tool
            // calls is @zhushanwen/pi-permission, which reads its own config
            // file — see approval_policy.rs. Never invent a second tier state
            // on this path; that is how "UI says full access, still prompts"
            // happened once already.
            let mut mode = params
                .get("mode_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            // plan_approved (set by the renderer's 批准执行 path): the plan was
            // just approved and `/plan implement` will launch the execution —
            // must NOT clear the saved plan here.
            let plan_approved = params
                .get("plan_approved")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let prev_active = *instance.plan_mode.lock().unwrap();
            if mode == "plan" {
                if !prev_active {
                    // Fire-and-forget arm turn (see turn_debt on PiInstance):
                    // its settle must not release a concurrent session/prompt
                    // waiter. set_mode is sent on EVERY run, so this can race
                    // with the run's own prompt even without a seed history.
                    instance.begin_debt_turn();
                    if let Err(e) = instance
                        .request("prompt", json!({ "message": "/plan start" }), RPC_TIMEOUT)
                        .await
                    {
                        eprintln!("[pi agent] /plan start failed: {e}");
                        instance.end_debt_turn();
                    }
                }
                *instance.plan_mode.lock().unwrap() = true;
            } else if prev_active && !plan_approved {
                instance.begin_debt_turn();
                if let Err(e) = instance
                    .request("prompt", json!({ "message": "/plan exit" }), RPC_TIMEOUT)
                    .await
                {
                    eprintln!("[pi agent] /plan exit failed: {e}");
                    instance.end_debt_turn();
                }
                *instance.plan_mode.lock().unwrap() = false;
            }
            // normalize: plan_approved with a non-plan target means the user
            // approved execution — the extension itself leaves plan mode.
            if plan_approved && mode == "plan" {
                mode = "accept_edits";
            }
            // plan_approved=true ⇒ drop the tracked flag WITHOUT sending
            // `/plan exit` (exit would delete the plan the user just approved;
            // the renderer's next prompt is `/plan implement`, and the
            // extension leaves plan mode itself). The flag still has to go
            // false: the run loop calls set_mode before EVERY prompt, and with
            // a stale true the next non-plan call would fire `/plan exit` right
            // after `/plan implement` — wiping the plan mid-implementation.
            if plan_approved {
                *instance.plan_mode.lock().unwrap() = false;
            }
            Ok(json!({ "status": "mode-applied", "mode_id": mode }))
        }
        "session/context_breakdown" => {
            let instance = routed_instance(&params, &state).await?;
            let stats = instance
                .request("get_session_stats", Value::Null, RPC_TIMEOUT)
                .await?;
            context_breakdown(&stats, &instance).await
        }
        // pi 自己的 `/context` 分类（pi-cc-extensions）：系统提示 / 记忆 / 技能 /
        // 工具定义 / 工具结果 / 对话上下文，加「其他」和「剩余空间」——与 pi CLI 里
        // `/context` 弹框完全同一份数（就是问 pi 要的，不自己猜）。
        // `source: "pi-context"` 是前端的识别标记：带上它才按整窗口径渲染
        // （part 之和 + 剩余 = 窗口），否则回落 jsonl 分类的比例归一化。
        "session/context_report" => {
            let instance = routed_instance(&params, &state).await?;
            let stats = instance
                .request("get_session_stats", Value::Null, RPC_TIMEOUT)
                .await?;
            let base = context_breakdown(&stats, &instance).await?;
            let context_max = base
                .get("context_max")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let context_used = base
                .get("context_used")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let Some(parts) = pi_context_report_parts(&instance).await else {
                return Ok(json!({
                    "source": "unavailable",
                    "context_max": context_max,
                    "context_used": context_used,
                    "context_percent": base.get("context_percent").cloned().unwrap_or(Value::Null),
                    "categories": base.get("categories").cloned().unwrap_or_else(|| json!([])),
                }));
            };
            // pi 的 part 顺序固定（collectContextBreakdown 的 returns）。按英文
            // label 映射到 Helix 的分类 id / 中文 label / 主题色；表里没有的
            // part（扩展改了文案）直接丢掉 —— 前端按「已归因」之和算其他/剩余，
            // 漏一个只会掉进「其他」，不会让条形超出窗口。
            let mut rows: Vec<(&str, &str, i64, &str)> = Vec::new();
            for (pi_label, tokens) in &parts {
                let row = match pi_label.as_str() {
                    "System prompt" => ("systemPrompt", "系统提示", "var(--context-usage-system)"),
                    "Memory" => ("memory", "记忆文件", "var(--context-usage-memory)"),
                    "Skills" => ("skills", "技能", "var(--context-usage-skills)"),
                    "Tools definition" => ("tools", "工具定义", "var(--context-usage-tools)"),
                    "Tool results" => (
                        "toolResults",
                        "工具结果",
                        "var(--context-usage-tool-results)",
                    ),
                    "Context" => (
                        "context",
                        "对话上下文",
                        "var(--context-usage-conversation)",
                    ),
                    _ => continue,
                };
                rows.push((row.0, row.1, *tokens, row.2));
            }
            // 其他 / 剩余按网关自己的权威口径重算，不用 pi 报告里那两个数：
            // pi 的 `used` 与 context_breakdown 的 context_used（provider 实测 /
            // jsonl 估算取 max）可能差一截，混用会让条形和百分比对不上。
            let attributed: i64 = rows.iter().map(|r| r.2).sum();
            rows.push((
                "other",
                "其他",
                (context_used - attributed).max(0),
                "var(--context-usage-other)",
            ));
            let free = (context_max - context_used).max(0);
            // 剩余空间单独一个字段（前端拿它收尾条形），同时作为分类进列表 ——
            // pi 的面板也把它和别的 part 并列成一行。
            rows.push(("free", "剩余空间", free, "var(--context-usage-free)"));
            let categories: Vec<Value> = rows
                .into_iter()
                .filter(|r| r.2 > 0)
                .map(|(id, label, tokens, color)| {
                    json!({ "id": id, "label": label, "tokens": tokens, "color": color })
                })
                .collect();
            Ok(json!({
                "source": "pi-context",
                "context_max": context_max,
                "context_used": context_used,
                "context_percent": base.get("context_percent").cloned().unwrap_or(Value::Null),
                "free_space": free,
                "estimated_total": attributed,
                "categories": categories,
                "usage_stats": base.get("usage_stats").cloned().unwrap_or(Value::Null),
            }))
        }
        // Helix's /compact + auto-compaction. pi's compact returns
        // {summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter};
        // the frontend needs {status:"compressed", messages, removed} and
        // replaces the visible transcript with `messages` (mapBackendMessages
        // reads role/text), so fetch them after compacting.
        "session.compress" | "session/compress" => {
            let instance = routed_instance(&params, &state).await?;
            let compacted =
                instance.request("compact", Value::Null, COMPACT_RPC_TIMEOUT).await?;
            let stats = instance
                .request("get_session_stats", Value::Null, RPC_TIMEOUT)
                .await?;
            let session_file = stats
                .get("sessionFile")
                .and_then(Value::as_str)
                .map(str::to_string);
            let messages = instance
                .request("get_messages", Value::Null, RPC_TIMEOUT)
                .await?
                .get("messages")
                .cloned()
                .unwrap_or_else(|| json!([]));
            // Re-anchor the session-file map: compaction keeps the same file,
            // but a switch_session later must still resolve.
            if let Some(file) = session_file {
                let sid = stats
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(sid) = sid {
                    // 远程实例同上：压缩不换文件，但这个（可能更新的）远端路径要
                    // 重新登记，供网关重启后的远程 resume 使用。
                    if instance.remote.load(Ordering::SeqCst) {
                        remember_remote_session_file(&sid, &file);
                    }
                    SESSION_FILES.lock().unwrap().insert(sid, file);
                }
            }
            // Re-anchor the remembered context figure to the compacted context.
            // Otherwise `last_context_used` keeps the pre-compaction peak, which
            // wins the max() in `context_breakdown` and `emit_usage` until the
            // next real call — the ring stays pinned at the old high, and
            // `context_percent` stays past the 80% auto-compact gate. Prefer pi's
            // own post-compact `contextUsage` (a real figure) over the chars/4
            // estimate, which lands a few thousand low on a summary message; if
            // it is missing, clear the floor entirely rather than keeping the
            // stale peak.
            let post_compact_used = stats
                .get("contextUsage")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if post_compact_used > 0 {
                instance.set_last_context_used(post_compact_used);
            } else {
                instance.reset_last_context_used();
            }
            let tokens_before = compacted
                .get("tokensBefore")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            // pi's `compact` result is {summary, firstKeptEntryId, tokensBefore, usage,
            // details}; the gateway (Helix) can't trust `estimatedTokensAfter` because
            // it's computed in-memory by pi's agent-session and NOT written back into
            // the session file — so it's absent from the RPC response in many builds.
            // Estimate the AFTER size directly from `get_messages` (same chars/4
            // heuristic pi uses in estimateTokens). This matches what the model
            // will actually replay next (compaction summary + kept messages).
            let tokens_after = estimate_messages_tokens(&messages);
            let removed = (tokens_before - tokens_after).max(0);
            Ok(json!({
                "status": "compressed",
                "messages": messages,
                "removed": removed,
                "before_tokens": tokens_before,
                "after_tokens": tokens_after,
                "summary": compacted.get("summary").cloned().unwrap_or(Value::Null),
            }))
        }
        // Helix's chat undo (撤回): truncate the backend history to before
        // the last user message. pi has no truncation RPC — the closest honest
        // primitive is `fork`, which rewinds the active branch to a previous
        // user message. The frontend passes the number of messages to drop
        // (count semantics) or nothing (rewind one user turn).
        "session.undo" | "session/undo" => {
            let instance = routed_instance(&params, &state).await?;
            let forks = instance
                .request("get_fork_messages", Value::Null, RPC_TIMEOUT)
                .await?;
            let messages = forks
                .get("messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if messages.is_empty() {
                return Ok(json!({ "ok": true, "removed": 0 }));
            }
            // Drop count: frontend sends count (messages to remove) when the
            // local history was truncated; default = 1 user turn (the last).
            let count = params
                .get("count")
                .and_then(Value::as_i64)
                .unwrap_or(1)
                .max(1) as usize;
            let rewind_to = messages.len().saturating_sub(count);
            if rewind_to == 0 {
                return Ok(json!({ "ok": true, "removed": 0 }));
            }
            let entry_id = messages[rewind_to - 1]
                .get("entryId")
                .and_then(Value::as_str)
                .ok_or("pi fork target is missing entryId")?;
            let forked = instance
                .request("fork", json!({ "entryId": entry_id }), RPC_TIMEOUT)
                .await?;
            if forked.get("cancelled").and_then(Value::as_bool) == Some(true) {
                return Err("pi extension cancelled the fork".into());
            }
            Ok(json!({ "ok": true, "removed": count }))
        }
        "session/prompt" => {
            let (message, images) = prompt_parts(&params)?;
            let instance = routed_instance(&params, &state).await?;
            let session_id = instance
                .current_session
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_default();

            // 路由前的落盘校验（「找不到就不准聊天」的实盘兜底）：session/resume
            // 只在恢复时验证一次，之后 jsonl 完全可能被人为删除——而 pi 对活实例
            // 的下一笔写入走 appendFileSync，会把文件在原路径**旁路重建**出来
            // （只剩新内容、没有 session 头），用户看到的就是「静默新建了会话
            // 文件」。所以每次 prompt 前都查：文件在 → 记入 FILE_SEEN_SIDS 放行；
            // 文件不在但它曾经存在（在 FILE_SEEN_SIDS 里）→ 按 session_not_found
            // 拒绝，前端 classifyResumeError 会把会话锁死。全新会话的文件本来
            // 就还没落盘（pi 惰性创建）→ 不在集合 → 放行，不误伤。远端会话的
            // jsonl 在远端机器上，本机查不到，直接放行。
            if !session_id.is_empty() && !instance.remote.load(Ordering::SeqCst) {
                let mut seen = FILE_SEEN_SIDS.lock().unwrap();
                let found = match SESSION_FILES.lock().unwrap().get(&session_id).cloned() {
                    Some(file_path) => std::path::Path::new(&file_path).exists(),
                    None => false,
                } || remote_session_file(&session_id).is_some()
                    || remote_session_dir(&session_id).is_some()
                    || find_session_file(&session_id).is_some();
                if found {
                    seen.insert(session_id.clone());
                } else if seen.contains(&session_id) {
                    drop(seen);
                    log_spawn_diag(&format!(
                        "session/prompt REJECTED sid={session_id}: jsonl gone (was seen earlier)"
                    ));
                    return Err(format!("no session file for {session_id}"));
                }
            }

            // 粘贴图片的分流（替代旧的无条件自动转述；详见上方 helper 注释）。
            let message = if images.is_empty() {
                message
            } else if current_model_supports_images(&instance) {
                // ① 多模态主模型：原生透传 images，模型直接读图，不需要转述
                message
            } else {
                // ② 纯文本主模型：落盘 + 路径提示，模型自己决定调不调 describe_image。
                //    工具不可用时也走这里，只是提示改成「你没有看图能力」——图片
                //    已经落盘，模型至少知道它们存在、缺的是什么。
                let tool_available =
                    pi_describe_image_supported() && pi_aux_vision_registered();
                let paths = save_pasted_images(&images);
                if paths.is_empty() {
                    message
                } else {
                    let listing = paths
                        .iter()
                        .enumerate()
                        .map(|(i, p)| format!("  {}. {}", i + 1, p))
                        .collect::<Vec<_>>()
                        .join("\n");
                    let hint = if tool_available {
                        format!(
                            "[用户粘贴了 {} 张图片，已落盘到以下路径。如需查看图片内容，用 \
describe_image 工具逐个分析（可附具体问题，如“读出图里的报错文字”）:\n{}\n]",
                            paths.len(),
                            listing
                        )
                    } else {
                        format!(
                            "[用户粘贴了 {} 张图片，已落盘到以下路径。\n\
警告：当前 describe_image 工具不可用（pi 版本过低或扩展未注册），\
你**无法**查看这些图片的内容，只能看到路径。如果任务依赖图里的信息，\
请直接告诉用户「我看不到这些图片」，不要猜测内容。\n{}]",
                            paths.len(),
                            listing
                        )
                    };
                    format!("{message}\n\n{hint}")
                }
            };

            let mut pi_params = json!({ "message": message });
            if !images.is_empty() {
                pi_params["images"] = json!(images);
            }
            // Register the turn waiter BEFORE the prompt so agent_settled can
            // never be missed (events arrive on the reader thread).
            let (tx, mut rx) = tokio::sync::oneshot::channel();
            instance.turn_cancelled.store(false, Ordering::SeqCst);
            *instance.turn_waiter.lock().unwrap() = Some(TurnWaiter { tx });
            instance.streaming.store(true, Ordering::SeqCst);
            // 上一条消息之前中止过旧回合 ⇒ 本回合开头要先吞掉旧回合带同一 sid 的
            // 尾巴事件；顺带清掉网关侧「工具仍在跑」的记账 —— 那些工具已随旧回合
            // 一起死掉，留着会让卡死看门狗永久以为有工具在执行而不作为。
            if instance.claim_turn_gate() {
                instance.executing_tools.lock().unwrap().clear();
            }

            let prompt_params = pi_params.clone();
            // 调用方可以显式声明「本轮正忙时怎么办」：`streaming_behavior` =
            // "followUp" / "steer" 时按声明排队（定时任务用它——它绝不能掐掉用户
            // 正在跑的回合）；缺省即交互式发送，命中忙态就是失步，走下面的中止重发。
            let declared_behavior = params
                .get("streaming_behavior")
                .and_then(Value::as_str)
                .filter(|b| *b == "followUp" || *b == "steer")
                .map(str::to_string);
            let result = instance.request("prompt", prompt_params, RPC_TIMEOUT).await;
            let result = match result {
                Ok(data) => Ok(data),
                Err(first_error) => {
                    if let Some(behavior) = &declared_behavior {
                        let mut retried = pi_params.clone();
                        retried["streamingBehavior"] = json!(behavior);
                        instance.request("prompt", retried, RPC_TIMEOUT).await
                    } else if first_error.contains("already processing") {
                        // pi 只在一种情况下拒绝 prompt：上一回合还在它那儿跑。旧代码把
                        // **任何**失败都重试成 `streamingBehavior:"steer"`，于是用户的新
                        // 任务被塞进旧回合当插话（模型读完旁注照常把旧任务干完 = 「发新
                        // 任务却继续做旧任务」），顺带把别的真错误也静默吞了。
                        // 带声明 behavior 的发送（插话 / 排队）走上面的 retry 分支；命中
                        // 这里的是未声明 behavior 的交互式发送，所以只可能是失步：前端/
                        // 网关已把旧回合当结束，pi 却还在 headless 跑。
                        eprintln!(
                            "[pi agent] prompt rejected (previous turn still live) \
                             -> aborting stale turn before resending"
                        );
                        // 闸门必须在发 abort **之前**打开：abort 命令返回时旧回合的
                        // `agent_settled` 可能已经到 reader 线程，而它要释放的是这条
                        // 消息刚注册的 waiter（= 新回合空手收场）。这里 waiter 已注册，
                        // 所以直接领取闸门，不等下一次注册。
                        instance.arm_turn_gate();
                        instance.claim_turn_gate();
                        let _ = instance
                            .request("clear_queue", Value::Null, RPC_TIMEOUT)
                            .await;
                        let _ = instance.request("abort", Value::Null, RPC_TIMEOUT).await;
                        if instance.wait_until_idle().await {
                            instance
                                .request("prompt", pi_params.clone(), RPC_TIMEOUT)
                                .await
                        } else {
                            // 停不住：作为 follow-up 排队，等旧回合真正结束后自成新一轮。
                            // 绝不退回 "steer" —— 那正是把新任务降级成旁注的做法。
                            eprintln!(
                                "[pi agent] stale turn did not settle; delivering as followUp queue"
                            );
                            let mut retried = pi_params.clone();
                            retried["streamingBehavior"] = json!("followUp");
                            instance.request("prompt", retried, RPC_TIMEOUT).await
                        }
                    } else {
                        *instance.turn_waiter.lock().unwrap() = None;
                        instance.sync_streaming_flag();
                        return Err(first_error);
                    }
                }
            };
            if result.is_err() {
                *instance.turn_waiter.lock().unwrap() = None;
                instance.sync_streaming_flag();
                return Err(result.unwrap_err());
            }

            // ── 扩展命令回合（/connect、/plan、/context 之类）───────��────────
            // pi 对「斜杠命令」不启动 agent 回合：prompt 直接执行扩展命令本身，
            // 响应里 disposition="handled"，之后**不会**再有 agent_settled。
            // 旧代码一律等 turn_waiter，于是这类回合必然干等到 PROMPT_TIMEOUT、
            // 再被看门狗判成「模型响应流中断（3 分钟无任何输出）」——用户在
            // Helix 里看到的就是「输入 /connect 后一直转圈，最后报错」。
            // handled 就是这一轮的终局：命令自己的输出走 notify/toast。
            let disposition = result
                .as_ref()
                .ok()
                .and_then(|data| data.get("disposition"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if disposition == "handled" {
                *instance.turn_waiter.lock().unwrap() = None;
                instance.sync_streaming_flag();
                return Ok(json!({
                    "session_id": session_id,
                    "state": "complete",
                    "turn": { "disposition": "handled" },
                }));
            }

            // Wait for the turn to fully settle (streaming continues as
            // events). While an extension UI request (approval / clarify
            // card) is pending, pi is blocked waiting for the USER — the
            // turn legitimately stays unsettled for as long as they don't
            // click. PROMPT_TIMEOUT still bounds an ordinary stuck turn,
            // but whenever it expires with a UI request outstanding the
            // wait is re-armed, so the model waits for the user indefinitely.
            // Between deadlines a watchdog aborts turns whose model stream
            // went silent (no pi event for STREAM_SILENCE_TIMEOUT, nothing
            // executing, no card pending) — otherwise a dropped free-tier
            // SSE stream holds the UI in "工作中" for the full hour.
            let mut deadline = tokio::time::Instant::now() + PROMPT_TIMEOUT;
            let completion = loop {
                let sleep = tokio::time::sleep_until(deadline);
                tokio::select! {
                    result = &mut rx => {
                        // map_err 是最后一道网：这个 oneshot 现在所有**主动**关闭
                        // 都带结构化标记——kill() → {cancelled:true}，子进程真死 →
                        // {process_exited:true}。裸 close 只剩"没人发就 drop"的
                        // 意外情形。
                        let v = result.map_err(|_| "pi turn event channel closed".to_string())?;
                        instance.sync_streaming_flag();
                        if v.get("process_exited").and_then(Value::as_bool) == Some(true) {
                            // 子进程中途退出：这一轮不可能有终局，报明确原因（前端
                            // 按"可恢复中断"处理，等 respawn/重连，而不是当模型失败）。
                            return Err(v
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("pi agent process exited unexpectedly")
                                .to_string());
                        }
                        break v;
                    }
                    _ = tokio::time::sleep(WATCHDOG_TICK) => {
                        let pending_ui = instance.ui_requests.lock().unwrap().len();
                        let tools_running = instance.executing_tools.lock().unwrap().len();
                        if pending_ui == 0 && tools_running == 0 && instance.stream_wedged() {
                            instance.arm_turn_gate();
                            let _ = instance
                                .request("abort", Value::Null, RPC_TIMEOUT)
                                .await;
                            *instance.turn_waiter.lock().unwrap() = None;
                            instance.sync_streaming_flag();
                            return Err("模型响应流中断（3 分钟无任何输出）".to_string());
                        }
                    }
                    _ = sleep => {
                        let pending_ui = instance.ui_requests.lock().unwrap().len();
                        if pending_ui == 0 {
                            // 这里返回 Err ⇒ 前端把这一轮当结束。只清本地旗子的话，pi
                            // 仍在 headless 跑它，下一条用户消息就会撞上失步路径
                            // （见上方 already-processing 分支）。宣告结束就必须真结束，
                            // 和上面的卡死看门狗同一套收尾。
                            instance.arm_turn_gate();
                            let _ = instance
                                .request("abort", Value::Null, RPC_TIMEOUT)
                                .await;
                            *instance.turn_waiter.lock().unwrap() = None;
                            instance.sync_streaming_flag();
                            return Err("pi turn timed out".to_string());
                        }
                        // User still hasn't answered the card — keep waiting
                        // (and keep the instance off the reaper's list).
                        instance.touch();
                        deadline = tokio::time::Instant::now() + PROMPT_TIMEOUT;
                    }
                }
            };
            instance.sync_streaming_flag();
            // Ack-only contract: completion details arrive as events.
            Ok(json!({
                "session_id": session_id,
                "state": "complete",
                "turn": completion,
            }))
        }
        "session/cancel" => {
            // Cancel targets whichever conversation the user stopped: route
            // by session_id when present, else the main instance.
            let instance = routed_instance(&params, &state).await?;
            // 这一回合被判结束（Stop 按钮 / 前端合成 done）。被中止回合的尾巴事件
            // 带的是同一个 session id，下一条消息的 run 循环分不出它们属于上一回合；
            // 它迟到的 `agent_settled` 更会释放下一条消息的 waiter。闸门在这里武装，
            // 由下一条 prompt 注册时领取（`claim_turn_gate`）。
            instance.arm_turn_gate();
            // Clear queued steering/follow-ups first (mirrors the interactive
            // Esc behavior), then abort the running operation.
            let _ = instance
                .request("clear_queue", Value::Null, RPC_TIMEOUT)
                .await;
            let result = instance.request("abort", Value::Null, RPC_TIMEOUT).await?;
            // Release the in-flight session/prompt waiter (if any) with a
            // cancelled marker; agent_settled will still fire — flag it so
            // the reader thread skips the duplicate session/complete.
            instance.turn_cancelled.store(true, Ordering::SeqCst);
            let waiter = {
                let mut guard = instance.turn_waiter.lock().unwrap();
                let w = guard.take();
                drop(guard);
                w
            };
            if let Some(waiter) = waiter {
                let _ = waiter.tx.send(json!({ "cancelled": true }));
            }
            instance.sync_streaming_flag();
            emit_helix_event(
                "session/update",
                &json!({
                    "session_id": instance.current_session_id(),
                    "update": { "sessionUpdate": "run.cancelled" },
                }),
            );
            Ok(result)
        }
        "pi/approval/respond"
        | "approval/respond"
        | "approval.respond"
        // clarify/respond: the clarify bar's answer — same extension_ui_response
        // frame, but the payload key is `answer` (agent-flow-panel handleClarifyRespond).
        | "clarify/respond"
        | "clarify.respond" => {
            let approval_id = params
                .get("request_id")
                .or_else(|| params.get("requestId"))
                .or_else(|| params.get("tool_call_id"))
                .or_else(|| params.get("toolCallId"))
                .and_then(Value::as_str)
                .ok_or("approval response is missing request_id")?
                .to_string();
            let choice = params
                .get("choice")
                .and_then(Value::as_str)
                .unwrap_or("approve");
            let respond_session = params
                .get("session_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            // 应答到达网关的第一行留痕，和前端的 `ui_card respond` 配成一对：
            // 「前端说它回了」和「网关真的收到了这条回」之间断掉过（审批卡挂到
            // 超时自己拒），只有两端各记一行才能把断点夹出来。
            log_spawn_diag(&format!(
                "ui_card respond_recv id={} session={} choice={}",
                approval_id, respond_session, choice
            ));
            // Route by session_id when the frontend sent one (it always does
            // for approval.respond/clarify/respond); fall back to the
            // request-id → instance owner map (Tauri's helix_approval_respond
            // carries no session).
            let instance =
                routed_instance_or_ui_owner(&params, &approval_id, &state).await?;
            let pending = instance
                .ui_requests
                .lock()
                .unwrap()
                .remove(&approval_id);
            if pending.is_none() {
                // 这张卡在 Rust 侧早已被清（kill/重启/竞速作废），现在回的这一下
                // 什么也解不开 —— 表现和「前端根本没答」完全一样：扩展挂满
                // approvalTimeoutSec 后 fail-closed。
                log_spawn_diag(&format!(
                    "ui_card respond_unknown id={} session={}",
                    approval_id, respond_session
                ));
            }
            let PendingUI {
                method: ui_method,
                blocking_tool,
                ..
            } = pending.ok_or("Unknown pi UI request")?;
            UI_REQUEST_OWNERS.lock().unwrap().remove(&approval_id);
            let denied = matches!(choice, "deny" | "cancel");
            // pi's extension_ui_response carries the answer fields at top
            // level (docs/rpc.md "Extension UI Responses").
            let mut frame = json!({ "type": "extension_ui_response", "id": approval_id });
            match ui_method.as_str() {
                // pi's confirm dialog is one-shot: confirmed or cancelled.
                // Helix's "session"/"always" levels have no pi equivalent
                // (the gate is re-asked per call), so they map to a single
                // approve — the only non-fabricated option.
                "confirm" => {
                    frame["confirmed"] = json!(!denied);
                }
                // select/input/editor: the answer is the picked option / typed
                // text. Deny (or an empty answer) cancels the dialog — pi
                // hands the extension `undefined`, which its ask-and-wait
                // wrappers treat as "user declined".
                "select" | "input" | "editor" => {
                    let answer = params
                        .get("answer")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("");
                    if denied || answer.is_empty() {
                        frame["cancelled"] = json!(true);
                    } else {
                        frame["value"] = json!(answer);
                    }
                }
                _ => {
                    if denied {
                        frame["cancelled"] = json!(true);
                    } else {
                        frame["value"] = json!("");
                    }
                }
            }
            let line = serde_json::to_string(&frame).map_err(|e| e.to_string())? + "\n";
            let Some(writer) = instance.writer.lock().unwrap().clone() else {
                return Err("pi agent stdin closed".into());
            };
            let unblocked_at = now_ms();
            writer
                .send(line)
                .map_err(|_| "pi agent stdin closed".to_string())?;
            // 用户答完审批 = 这条工具调用的 prepare 返回，它从这一刻才真正开跑。
            // 前端把那张卡片的计时起点挪到这里，否则「等用户点批准」的那几分钟全
            // 算进了工具耗时（卡片转了 3 分钟，其实两分半是在等人）。
            // AI 抢先判定那一路不经过这里（pi 侧静默 abort 弹窗，宿主收不到任何
            // 回应），拿不到确切时刻 ⇒ 干脆不报，也不拿作废时刻去猜。
            if let Some(tool_call_id) = blocking_tool {
                emit_helix_event(
                    "session/update",
                    &json!({
                        "session_id": instance.current_session_id(),
                        "update": {
                            "sessionUpdate": "tool_prepare_unblocked",
                            "toolCallId": tool_call_id,
                            "at": unblocked_at,
                        },
                    }),
                );
            }
            Ok(json!({ "ok": true }))
        }
        // pi's RPC surface has no MCP introspection, but the CLI does:
        // `pi mcp list --json` connects every enabled server and prints its
        // state, tools and errors. Run it here so the settings page can show
        // "this server won't connect, and here's why" instead of a dead stub.
        // The RPC surface also has no hot-reload: servers load at pi process
        // start, so the gateway respawn that mcp_config_save already triggers
        // is the reload. Overall cap 45s — a single server may take up to its
        // own 60s timeout, so a hung entry must not hang the settings page.
        "mcp.servers.status" | "mcp/servers/status" => {
            let (program, base) = pi_cli_strings();
            let mut args: Vec<String> = base;
            args.push("mcp".into());
            args.push("list".into());
            args.push("--json".into());
            let mut cmd = tokio::process::Command::new(&program);
            cmd.args(&args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            #[cfg(windows)]
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            for (k, v) in crate::proxy::proxy_env_pairs() {
                cmd.env(k, v);
            }
            let started = tokio::time::Instant::now();
            match tokio::time::timeout(
                std::time::Duration::from_secs(45),
                cmd.output(),
            )
            .await
            {
                Ok(Ok(output)) => {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let parsed: Value =
                        serde_json::from_str(stdout.trim()).unwrap_or(Value::Null);
                    let raw_servers = parsed
                        .get("servers")
                        .cloned()
                        .unwrap_or_else(|| json!([]));
                    let errors = parsed
                        .get("errors")
                        .cloned()
                        .unwrap_or_else(|| json!([]));
                    // `tools` is an array of names; surface the count so the
                    // UI doesn't have to know the wire shape.
                    let servers = raw_servers
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .map(|s| {
                                    let mut entry = s.clone();
                                    let count = entry
                                        .get("tools")
                                        .and_then(Value::as_array)
                                        .map(|t| t.len())
                                        .unwrap_or(0);
                                    if let Some(obj) = entry.as_object_mut() {
                                        obj.insert("toolCount".into(), json!(count));
                                    }
                                    entry
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let mut extra = serde_json::Map::new();
                    extra.insert("elapsedMs".into(), json!(started.elapsed().as_millis()));
                    if !output.status.success() {
                        extra.insert(
                            "exitCode".into(),
                            json!(output.status.code().unwrap_or(-1)),
                        );
                    }
                    let mut out = serde_json::Map::new();
                    out.insert("servers".into(), Value::Array(servers));
                    out.insert("errors".into(), errors);
                    out.insert("available".into(), json!(true));
                    for (k, v) in extra {
                        out.insert(k, v);
                    }
                    if !output.status.success() && !stderr.trim().is_empty() {
                        out.insert("stderr".into(), json!(stderr.trim()));
                    }
                    Ok(Value::Object(out))
                }
                Ok(Err(e)) => Ok(json!({
                    "servers": [],
                    "errors": [],
                    "available": false,
                    "error": format!("spawn `pi mcp list` failed: {e}")
                })),
                Err(_) => Ok(json!({
                    "servers": [],
                    "errors": [],
                    "available": false,
                    "timeout": true,
                    "error": "pi mcp list timed out (45s)"
                })),
            }
        }
        "reload.mcp" | "reload/mcp" => {
            // MCP servers load from config.yaml at pi process start; a real
            // reload = the gateway respawn config writes already trigger
            // (mcp_config_save respawns pi). Report skipped so callers can
            // tell "nothing to do" from an actual failure.
            Ok(json!({ "ok": true, "skipped": true }))
        }
        // Helix sidebar browser: pi extension's `open_browser` tool routes here
        // via `helix/app/open_browser` and we emit the Tauri event the renderer
        // listens for — so the model can drive the in-app webview, not just the
        // system default browser.
        "app/open_browser" | "app.open_browser" => {
            let url = params.get("url").and_then(Value::as_str).unwrap_or("");
            if url.is_empty() {
                return Err("open_browser requires a non-empty url".into());
            }
            // `quiet: true` 标记为 agent 触发（与 poll_browser_requests 的
            // navigate 一致）：前端只在侧边栏本来就开着浏览器时才让它可见，
            // 否则只记 URL + 弹「Agent 打开了一个页面」toast。缺这个标记的话，
            // 模型每次 open_browser 都会把侧边栏从「更改」上拽到「浏览器」。
            let _ = crate::state::app_handle().emit(
                "helix:open-browser",
                json!({ "url": url, "quiet": true }),
            );
            Ok(json!({ "ok": true, "url": url }))
        }
        // ── Pi-native pass-through commands ─────────────────────────────────
        // These forward directly to pi's RPC without Helix-specific translation.
        // Session-less UI surfaces (model list, thinking level, plugin
        // manager) land on the main instance; a session_id routes them to
        // that conversation's instance (stats for THIS chat).
        "get_commands"
        | "get_available_models"
        | "get_state"
        | "set_model"
        | "set_thinking_level"
        | "cycle_thinking_level"
        | "get_available_thinking_levels"
        | "compact"
        | "set_auto_compaction"
        | "get_session_stats"
        | "get_messages"
        | "get_entries"
        | "get_fork_messages"
        | "get_last_assistant_text"
        | "clear_queue"
        | "set_auto_retry"
        | "abort_retry"
        | "export_html"
        | "bash"
        // 忙时注入当前轮：pi 在**正在跑的那一轮**里消费 _steeringMessages /
        // _followUpMessages（agent-session.js 的 _runAgentPrompt while 循环），
        // 所以注入不新起一轮、回答仍从当前轮的事件流出来，网关也不用注册
        // turn_waiter。必须显式列进白名单：走 session/prompt 的话，网关会在
        // 发 prompt **之前**就注册 waiter 并置 streaming=true，那条 waiter
        // 属于一个永远不会来的 agent_settled（pi 不为注入单独 settle），
        // 于是实例被永久判忙、reaper 都不能杀它。
        | "steer"
        | "follow_up"
        | "abort_bash" => {
            let instance = routed_instance(&params, &state).await?;
            // 每轮重放的 per-session 模型切换：先记下本实例现在跑的是哪个
            // 模型，上下文环的分母（context_max）才会跟着切（否则一直按
            // 全局默认模型的窗口算 → "我选了 1M，有时候自动变成 256k"）。
            if method == "set_model" {
                instance.note_active_model(
                    params.get("modelId").and_then(Value::as_str),
                    params.get("provider").and_then(Value::as_str),
                );
            }
            // Bare `compact`（pi_compact 命令）与 session.compress 里的是同一
            // 个长 LLM 总结调用，同样吃扩展预算；其余保持通用超时。
            let timeout = if method == "compact" {
                COMPACT_RPC_TIMEOUT
            } else {
                RPC_TIMEOUT
            };
            instance.request(method, params, timeout).await
        }
        _ => Err(format!("pi adapter does not implement {method}")),
    }
}

/// Frontend bridge: parent Agent toolCallId → extension agent id (and live
/// status) per session, so AgentWorkPanel can map its card id to the child's
/// .output transcript (see delegations::subagent_timeline). Session scoped:
/// each instance only sees its own children.
#[tauri::command]
pub fn subagent_map(session_id: Option<String>) -> Value {
    let instances = INSTANCES.lock().unwrap();
    let mut agents = Vec::new();
    let collect = |instance: &Arc<PiInstance>, agents: &mut Vec<Value>| {
        for (tool_call_id, rec) in instance.subagents.lock().unwrap().iter() {
            agents.push(json!({
                "tool_call_id": tool_call_id,
                "agent_id": rec.agent_id,
                "status": rec.status.clone().unwrap_or_else(|| "running".into()),
            }));
        }
    };
    match session_id.as_deref() {
        Some(sid) if !sid.is_empty() => {
            if let Some(instance) = instances.get(sid) {
                collect(instance, &mut agents);
            }
        }
        _ => {
            for instance in instances.values() {
                collect(instance, &mut agents);
            }
        }
    }
    json!({ "ok": true, "agents": agents })
}

/// Move an instance from its placeholder key to its real pi session id.
fn rekey_instance(instance: &Arc<PiInstance>, new_key: String) {
    let old_key = instance.key();
    {
        let mut instances = INSTANCES.lock().unwrap();
        instances.remove(&old_key);
        if let Some(existing) = instances.get(&new_key) {
            // Shouldn't happen (pi session ids are unique) — kill the stale one.
            if !Arc::ptr_eq(existing, instance) {
                existing.kill();
            }
        }
        instances.insert(new_key.clone(), Arc::clone(instance));
    }
    *instance.key.lock().unwrap() = new_key;
}

/// Get-or-spawn the instance for a Helix/pi session id, restoring the pi
/// session from disk if the instance was reaped (switch_session). Single-
/// flight per session: concurrent callers serialize on the session's resume
/// lock, so only ONE spawn/claim + switch_session runs and the rest observe
/// the restored instance (spawn_instance's spawn_lock returns it instantly
/// once initialized).
async fn instance_for_session(
    session_id: &str,
    state: &Arc<AppState>,
) -> Result<Arc<PiInstance>, String> {
    if session_id.is_empty() {
        return spawn_instance(String::new(), None, false, state);
    }
    if let Some(instance) = INSTANCES.lock().unwrap().get(session_id) {
        if instance.initialized.load(Ordering::SeqCst) {
            // 快路径的身份校验：map key 是「我们声称的 sid」，current_session 是
            // 「pi 报告的 sid」。两者不一致说明这个实例还没真正切到目标会话
            // （restore 的 rekey→switch_session 窗口、或 rekey 后 switch 失败），
            // 此时返回它会让 `session/resume` 把 current_session 当作 resumed_id
            // 回给前端 —— 那是一个从无 jsonl 的幽灵 sid。宁可让它继续往下走
            // 锁定路径重新 restore，也不能把错 sid 交出去。
            let on_target = instance.current_session_id().as_str() == Some(session_id);
            if on_target {
                return Ok(Arc::clone(instance));
            }
        }
    }
    let lock = {
        let mut locks = RESUME_LOCKS.lock().unwrap();
        Arc::clone(locks.entry(session_id.to_string()).or_default())
    };
    let sid = session_id.to_string();
    let state2 = Arc::clone(state);
    let restored = tokio::task::spawn_blocking(move || {
        let _guard = lock.lock().unwrap();
        // Double-check after acquiring: the first flyer may have finished
        // while we waited.
        if let Some(instance) = INSTANCES.lock().unwrap().get(&sid) {
            if instance.initialized.load(Ordering::SeqCst) {
                return Ok(Arc::clone(instance));
            }
        }
        match restore_session_instance(&sid, &state2) {
            Ok(instance) => Ok(instance),
            // 网关交接的清场扫帚杀掉了在飞的恢复（switch_session / get_state 的
            // pending 被 kill() 清掉 → `killed by Helix`）。这条失败**必然**发生在
            // 杀完之后，此刻交接已经收尾：重跑一次会按新配置重生实例，
            // await_handover_window 会先等掉残余的交接窗口（连续多次重启的
            // follow-up restart 也一并等到）。比把一次纯瞬时故障抛给前端、让它
            // 重走整条 resume 阶梯便宜得多，而且 session/set_mode 这类只
            // console.warn 的调用点根本不会重试（后端 plan/权限档就此漏同步）。
            //
            // 只重试一次：真正的坏会话（文件损坏、pi 拒绝切换）第二次照样失败，
            // 不会退化成循环。退出中不重试 —— 那会在 stop_all 的杀光之后又拉起
            // 一个 pi 子进程。
            Err(e)
                if e.contains("killed by Helix")
                    && !state2.gateway.app_quitting.load(Ordering::SeqCst) =>
            {
                log_spawn_diag(&format!(
                    "restore: sid={sid} killed mid-restore by Helix — retrying once ({e})"
                ));
                restore_session_instance(&sid, &state2)
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| format!("session restore task failed: {e}"))?;
    // restore 失败（如 "no session file"）原样上抛给调用方（session/prompt、
    // session/resume、session/prepare）。绝不在这里静默 new_session 建空白
    // 会话：session/prompt 路由过来时前端不会带 seedHistory，用户消息会直接
    // 落进零上下文的空白会话——无声的彻底失忆。也绝不在此触发
    // session/new + spawn_history_seed_turn：那会用一个新 SID 顶替丢失的
    // 原会话，把原始对话变成永远找不回来。失败只上报，处理权在调用方
    // （session/resume 返回 error_kind，前端据此标记 broken 或提示可重试）。
    restored
}

/// 恢复前等掉在飞的网关交接窗口。拿不到 `LIFECYCLE_LOCK`（试锁失败）说明
/// `restart_overlapping` / `spawn` / `stop_all` 正持有它 —— 交接的**清场扫帚**
/// 在整段窗口的末尾，`restore` 里那条几秒到几十秒的 `switch_session` 撞进去
/// 必死：`kill()` 清 pending 让在飞请求以
/// `killed by Helix (no response channel)` 断开（helix-recover.log 2026-10-13
/// 实测：切会话撞上「技能启用状态变更」重启，`waited 7731ms` 后被杀，
/// session/set_mode 报 session_restore_failed）。
///
/// 拿到锁**立刻放** —— 这把锁在这里只用来证明"这一刻没有清场在跑"，真正要紧
/// 的顺序是：交接收尾（含 rearm_warm_spares）→ 再恢复。这样恢复到的实例生在
/// 新配置下，也不会正好落在扫帚下面。预算内拿不到（冷启动交接实测 17-27s，
/// 卡死的 get_state 最长 150s）就继续走：后面还有一道 killed-by-Helix 重试
/// 兜底，而重试时交接早已结束，这把锁会立刻到手。
///
/// 退出中直接失败：`stop_all` 持锁杀光全部实例，此刻再重生一个 pi 子进程
/// 比报错更糟（classify_session_error 把它归为 internal，不影响会话生命周期）。
fn await_handover_window(state: &Arc<AppState>) -> Result<(), String> {
    const BUDGET: Duration = Duration::from_secs(20);
    let start = std::time::Instant::now();
    let mut waited = false;
    loop {
        if state.gateway.app_quitting.load(Ordering::SeqCst) {
            return Err("gateway is quitting".into());
        }
        match LIFECYCLE_LOCK.try_lock() {
            Ok(guard) => {
                drop(guard);
                if waited {
                    log_spawn_diag(&format!(
                        "restore: waited {}ms for the in-flight handover",
                        start.elapsed().as_millis()
                    ));
                }
                return Ok(());
            }
            // 持锁方 panic 了：锁已毒化，继续等只会空耗预算 —— 照常往下走。
            Err(std::sync::TryLockError::Poisoned(_)) => return Ok(()),
            Err(std::sync::TryLockError::WouldBlock) => {
                if start.elapsed() >= BUDGET {
                    log_spawn_diag(&format!(
                        "restore: gave up waiting for the handover after {}ms — proceeding (killed-by-Helix retry will cover it)",
                        start.elapsed().as_millis()
                    ));
                    return Ok(());
                }
                waited = true;
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// Spawn (or warm-spare-claim) the instance for a not-live session and
/// switch it onto the persisted session file. Caller holds the session's
/// resume lock. Sync — runs on a blocking thread (see instance_for_session).
fn restore_session_instance(
    session_id: &str,
    state: &Arc<AppState>,
) -> Result<Arc<PiInstance>, String> {
    // 先等掉在飞的网关交接（见 await_handover_window）：交接窗口里启动的
    // switch_session 会在收尾清场时被自己人杀掉，那次失败是纯瞬时的、且必然
    // 发生在新配置生效之后 —— 等它结束既避开扫帚，也让恢复落在新配置上。
    await_handover_window(state)?;
    // Not live (reaped / crashed / never spawned): respawn and restore the
    // conversation from its persisted session file. The existing map entry
    // (if any) keeps its stored cwd, so the respawn lands in the same project.
    // Cached paths are validated — the file may have been deleted since the
    // index was built (session cleanup / pi CLI housekeeping).
    //
    // 远程会话的 jsonl 在**远端**机器上：本机缓存（进程重启后必空）与磁盘扫描
    // （只扫 `~/.pi/agent/sessions`）都看不到它。实例存活时
    // `stamp_session_from_state` 把 get_state 报来的远端路径登记进了
    // REMOTE_SESSION_FILES —— 有登记就直接拿它当 switch_session 的
    // sessionPath：remote-bridge 是纯透传，远端 pi 自己读那个文件，于是真·
    // 续接原会话（不分叉、不注入、上下文完整）。没登记（本修复上线前创建的
    // 会话）才走本机逻辑，最终按「本机无此会话文件」上抛，由前端走重建阶梯
    // —— 不会比现在更坏。
    let remote_dir = remote_session_dir(session_id);
    let session_file = if let Some(file) =
        remote_session_file(session_id).filter(|_| remote_dir.is_some())
    {
        log_spawn_diag(&format!(
            "restore: sid={session_id} 远程会话，远端 jsonl={file}"
        ));
        file
    } else {
        match SESSION_FILES
            .lock()
            .unwrap()
            .get(session_id)
            .filter(|p| std::path::Path::new(p).exists())
            .cloned()
            .or_else(|| find_session_file(session_id))
        {
            Some(f) => {
                log_spawn_diag(&format!(
                    "restore: sid={session_id} file={f}"
                ));
                f
            }
            None => {
                // 远程会话的 jsonl 在**远端**机器的 sessions 目录里，本机扫不到 ——
                // 扫不到不等于对话不存在。这里仍按「本机无此会话文件」上抛，让前端走
                // 它已有的 seedHistory 重建阶梯（session/new 带 messages，会重新登记
                // remote_cwd，于是重建后依旧跑在远端）。
                log_spawn_diag(&format!(
                    "restore FAILED sid={session_id}: no session file (cache miss + scan miss){}",
                    match remote_session_dir(session_id) {
                        Some(d) => format!(" — 这是远程会话，jsonl 在远端 {d}"),
                        None => String::new(),
                    }
                ));
                return Err(format!("no session file for {session_id}"));
            }
        }
    };
    // The conversation's real project dir comes from the jsonl header — the
    // sessions folder name is lossy (every path separator and '-' encodes as
    // '-'), so it can't be recovered from the directory alone. Feeding it to
    // spawn_instance also fixes a fresh-start respawn landing in the global
    // work dir instead of the conversation's own project.
    // 远程会话不读本机 jsonl 头（读不到）——项目目录来自 REMOTE_SESSIONS 登记表
    // （session/new 时写下的 remote_cwd）。
    let is_remote_session = remote_dir.is_some();
    let session_cwd = if !is_remote_session {
        read_session_cwd(&session_file)
    } else {
        None
    };
    // Claim a warm spare in the same project — skips pi's 10s+ cold start
    // (process spawn + extension init + handshake) on resume. Only when the
    // session's dir is known: an unknown dir must not claim an arbitrary
    // spare, which would run the conversation in the wrong project.
    let instance = if let Some(remote) = remote_dir {
        // 远程：按登记的远端目录重连隧道 spawn。不能认领本地 warm spare（池子里
        // 清一色本地子进程），也不走本机 cwd 兜底（那会把远程会话拉到你本机某个
        // 目录去跑）。
        spawn_instance(session_id.to_string(), Some(remote), true, state)?
    } else if let Some(cwd) = session_cwd.as_deref() {
        match take_warm_spare(Some(cwd)) {
            Some(spare) => {
                // Claimed — rearm a replacement for the next resume.
                rearm_warm_spares(state);
                // The spare lives under a placeholder key ("spare-N"); re-key
                // BEFORE switch_session so its events and any extension UI
                // request are routable under the real session id.
                rekey_instance(&spare, session_id.to_string());
                spare
            }
            // Pool empty or dir mismatch: spawn on demand + rearm so the NEXT
            // resume in the global work dir finds a warm spare.
            None => {
                rearm_warm_spares(state);
                spawn_instance(session_id.to_string(), Some(cwd.to_string()), false, state)?
            }
        }
    } else {
        spawn_instance(session_id.to_string(), None, false, state)?
    };
    // 把「本实例跑的是哪个 sid」**立刻**对齐到要恢复的目标 sid，在
    // switch_session 之前。
    //
    // 为什么必须提前：pi 子进程启动时会自己建一个初始会话（内存态、从不落盘），
    // spawn_instance 的握手 get_state 已经把它 stamp 进 current_session。上面
    // 的 rekey 又让实例**立刻**以真 sid 的身份出现在 INSTANCES 里且
    // initialized=true —— 于是从 rekey 到下面 switch_session+get_state 完成
    // 之间存在一个窗口：`instance_for_session` 的快路径不拿锁、只看
    // initialized，会把本实例当成"真 sid 已经就绪"直接返回，而
    // `session/resume` 又用 `current_session` 当作 resumed_id 回给前端。
    // 那个窗口里前端会拿到一个**从无 jsonl 的幽灵 sid**并写进
    // conversation-index.json，之后每次 resume  都是
    // `no session file (cache miss + scan miss)`，直到某次恢复阶梯把它换掉。
    //
    // 这里预置 sid = 声明"本实例从此就是 session_id"，让窗口期的
    // current_session 与 map key 自洽；下面的 get_state 若真给出别的 sid，
    // stamp 会以 pi 为准覆盖（那说明 switch 真的换了会话，按 pi 走）。
    if instance.current_session_id().as_str() != Some(session_id) {
        *instance.current_session.lock().unwrap() = Some(session_id.to_string());
    }
    let data = match instance.request_sync(
        "switch_session",
        json!({ "sessionPath": session_file }),
        // Restoring a long conversation parses the whole jsonl — the same
        // heavyweight class as the spawn handshake, not a quick RPC.
        HANDSHAKE_TIMEOUT,
    ) {
        Ok(d) => d,
        Err(e) => {
            // Timeout / process death during the restore switch: the file
            // exists but never came back — log it so the recover log shows
            // WHICH layer of the chain failed and how long it hung.
            log_spawn_diag(&format!(
                "restore FAILED sid={session_id} switch_session: {e}"
            ));
            // 这个实例没有落到目标会话上，绝不能留在 INSTANCES 里冒充就绪
            // （initialized=true + 预置的 current_session 会让快路径直接返回它，
            // 之后的 prompt 全发进一个错的会话）。杀掉，下次走完整 restore。
            instance.kill();
            // 远端 jsonl 可能已被对端清掉（会话清理 / 换机器）：这类「文件没了」
            // 归一成 no session file，前端才会判 session_not_found 走重建阶梯，
            // 而不是卡在可重试的 restore_failed 反复失败。
            if is_remote_session && looks_like_missing_file(&e) {
                return Err(format!("no session file for {session_id}"));
            }
            return Err(e);
        }
    };
    if data.get("cancelled").and_then(Value::as_bool) == Some(true) {
        log_spawn_diag(&format!(
            "restore FAILED sid={session_id}: pi declined the session switch"
        ));
        instance.kill();
        return Err("pi declined the session switch".into());
    }
    // get_state + stamp (session_state is async-only; inline the sync pair).
    let state_data = instance.request_sync("get_state", Value::Null, RPC_TIMEOUT)?;
    // 落地身份校验：pi 对**不存在**的 sessionPath 不报错，而是就地 newSession
    // 铸一个随机新 sid（SessionManager._setSessionFile 的 else 分支）。远端路径
    // 过期（对端清理过会话）就会踩到：不检查的话 resume 会"成功"返回一个空会话，
    // 用户对着失忆的模型继续聊。sid 不一致 = 没落到目标会话上，按「会话文件没了」
    // 上抛，让前端走重建阶梯（本地历史还在，不会丢内容）。
    let landed_sid = state_data
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if landed_sid != session_id {
        log_spawn_diag(&format!(
            "restore FAILED sid={session_id}: switch landed on {landed_sid:?}（会话文件缺失或已失效）"
        ));
        instance.kill();
        return Err(format!("no session file for {session_id}"));
    }
    instance.stamp_session_from_state(Some(&state_data));
    // Free-tier upstreams (tokenrouter glm-5.3-free) silently DROP requests
    // whose restored context exceeds the model window: no error, no stream,
    // the turn never settles while pi stays healthy — the user sees an
    // eternal "工作中". Rescue is opencode-style, same single jsonl:
    //   1. pi's own `compact` RPC (LLM summary → compaction record appended
    //      to the same file, pi reloads it in place). Best-effort with the
    //      standard compaction timeout.
    //   2. When compact itself hits the hanging upstream (it replays the
    //      same oversized context), fall back to a LOCAL in-place cut:
    //      same turn-boundary logic, written back into the original file.
    // Neither path ever creates a `.trimmed.jsonl` twin.
    // 用「本会话自己那个模型」的窗口判断是否超限（与上下文环同一个解析口径，
    // 见 PiInstance::context_max）：用户给这个模型配了 1M，就不该按别处
    // 256k 的窗口把 300k 的会话裁掉。
    let session_window = instance.context_max(None);
    if session_window > 0 && session_oversized(&session_file, session_window) {
        log_spawn_diag(&format!(
            "restore: sid={session_id} oversized (~{session_window} window) → in-place compaction"
        ));
        match instance.request_sync("compact", Value::Null, COMPACT_RPC_TIMEOUT) {
            Ok(_) => {
                // Same post-compact anchor refresh as the session.compress RPC:
                // without it `last_context_used` keeps the pre-compaction peak,
                // which wins the max() in the usage ring until the next call.
                if let Ok(stats) =
                    instance.request_sync("get_session_stats", Value::Null, RPC_TIMEOUT)
                {
                    let used = stats
                        .get("contextUsage")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    if used > 0 {
                        instance.set_last_context_used(used);
                    } else {
                        instance.reset_last_context_used();
                    }
                }
                if let Ok(fresh) = instance.request_sync("get_state", Value::Null, RPC_TIMEOUT) {
                    instance.stamp_session_from_state(Some(&fresh));
                }
            }
            Err(e) => {
                // compact hung/failed (the oversized-context replay the note
                // above describes) → local cut, then reload pi from the same
                // path so its in-memory transcript matches the rewritten file.
                log_spawn_diag(&format!(
                    "restore WARNING sid={session_id} compact failed ({e}) → in-place trim"
                ));
                eprintln!("[pi agent] compact failed, falling back to in-place trim: {e}");
                match trim_session_in_place(&session_file, session_window) {
                    Ok(true) => match instance.request_sync(
                        "switch_session",
                        json!({ "sessionPath": session_file }),
                        HANDSHAKE_TIMEOUT,
                    ) {
                        Ok(_) => {
                            if let Ok(fresh) =
                                instance.request_sync("get_state", Value::Null, RPC_TIMEOUT)
                            {
                                instance.stamp_session_from_state(Some(&fresh));
                            }
                        }
                        Err(e) => {
                            log_spawn_diag(&format!(
                                "restore WARNING sid={session_id} post-trim reload failed: {e}"
                            ));
                            eprintln!("[pi agent] post-trim reload failed: {e}");
                        }
                    },
                    Ok(false) => {} // already fits / untrimmable — leave as is
                    Err(e) => {
                        log_spawn_diag(&format!(
                            "restore WARNING sid={session_id} in-place trim failed: {e}"
                        ));
                        eprintln!("[pi agent] in-place trim failed: {e}");
                    }
                }
            }
        }
    }
    Ok(instance)
}

/// Rough token estimate for a message's content blocks, mirroring pi's
/// estimateTokens heuristic (chars/4). Tool-call arguments and thinking
/// count toward the request too.
pub fn estimate_message_tokens(message: &Value) -> i64 {
    let content = match message.get("content") {
        Some(Value::String(s)) => return s.len() as i64 / 4,
        Some(Value::Array(blocks)) => blocks,
        _ => return 0,
    };
    let mut chars: i64 = 0;
    for block in content {
        let block_chars = match block.get("type").and_then(Value::as_str) {
            Some("text") => block.get("text").and_then(Value::as_str).map(str::len),
            Some("thinking") => block.get("thinking").and_then(Value::as_str).map(str::len),
            Some("toolCall") => block
                .get("arguments")
                .map(|a| serde_json::to_string(a).map(|s| s.len()).unwrap_or(0)),
            _ => None,
        };
        if let Some(n) = block_chars {
            chars += n as i64;
        }
    }
    chars / 4
}

/// Sum `estimate_message_tokens` over a messages array (the `.messages`
/// value from `get_messages`). Used by session.compress to estimate the
/// AFTER size when pi's `estimatedTokensAfter` field is absent from the
/// compact RPC response.
fn estimate_messages_tokens(messages: &Value) -> i64 {
    match messages {
        Value::Array(arr) => arr.iter().map(|m| estimate_message_tokens(m)).sum(),
        _ => 0,
    }
}

/// Split the active branch's replay context into per-content-type buckets.
/// This is what the NEXT prompt actually sends — the breakdown the usage bar
/// is supposed to show. Mirrors estimate_active_branch's branch location
/// (latest compaction summary + everything after firstKeptEntryId), but
/// classifies by message content-block type instead of returning one total.
fn estimate_active_branch_by_kind(lines: &[String]) -> (i64, Vec<(&'static str, i64)>) {
    let parse = |line: &str| serde_json::from_str::<Value>(line).ok();
    let mut latest_compaction: Option<(String, i64, usize)> = None;
    for (i, line) in lines.iter().enumerate() {
        if let Some(v) = parse(line) {
            if v.get("type").and_then(Value::as_str) == Some("compaction") {
                let summary_tokens = v
                    .get("summary")
                    .and_then(Value::as_str)
                    .map(|s| s.len() as i64 / 4)
                    .unwrap_or(0);
                let first_kept = v
                    .get("firstKeptEntryId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if first_kept.is_some() {
                    latest_compaction = Some((first_kept.unwrap(), summary_tokens, i));
                }
            }
        }
    }
    let (mut tokens, start_line) = match &latest_compaction {
        Some((first_kept, summary_tokens, _)) => {
            let start = lines.iter().position(|l| {
                parse(l)
                    .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_string))
                    .as_deref()
                    == Some(first_kept.as_str())
            });
            (*summary_tokens, start)
        }
        None => (0, Some(0)),
    };
    let start = start_line.unwrap_or(0);
    let mut buckets: HashMap<&'static str, i64> = HashMap::new();
    if tokens > 0 {
        buckets.insert("summary", tokens);
    }
    for line in lines.iter().skip(start) {
        let Some(v) = parse(line) else { continue };
        if v.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = v.get("message") else {
            continue;
        };
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        let blocks = match message.get("content") {
            Some(Value::Array(blocks)) => blocks,
            Some(Value::String(s)) => {
                let kind = match role {
                    "user" => "user",
                    "toolResult" => "tools",
                    _ => "assistant",
                };
                *buckets.entry(kind).or_insert(0) += s.len() as i64 / 4;
                tokens += s.len() as i64 / 4;
                continue;
            }
            _ => continue,
        };
        for block in blocks {
            let (kind, chars) = match block.get("type").and_then(Value::as_str) {
                Some("text") => (
                    if role == "user" { "user" } else { "assistant" },
                    block.get("text").and_then(Value::as_str).map(str::len),
                ),
                Some("thinking") => (
                    "thinking",
                    block.get("thinking").and_then(Value::as_str).map(str::len),
                ),
                Some("toolCall") => (
                    "tools",
                    block
                        .get("arguments")
                        .and_then(|a| serde_json::to_string(a).ok())
                        .map(|s| s.len()),
                ),
                Some("toolResult") => (
                    "tools",
                    block.get("text").and_then(Value::as_str).map(str::len),
                ),
                _ => continue,
            };
            if let Some(n) = chars {
                *buckets.entry(kind).or_insert(0) += n as i64 / 4;
                tokens += n as i64 / 4;
            }
        }
    }
    let mut parts: Vec<(&'static str, i64)> = buckets.into_iter().collect();
    parts.sort_by_key(|(k, _)| *k);
    (tokens, parts)
}

/// Persisted floor anchor for the active branch's next-prompt size: the
/// largest provider-reported `usage` total recorded **after the most recent
/// compaction**. Assistant message records carry pi's per-call usage and are
/// written into the jsonl, so the figure survives a gateway restart — unlike
/// the volatile `last_context_used` (0 after every respawn).
///
/// Scoped to post-compaction records deliberately: a compaction RESETS the
/// live context (the summarized messages are replaced by a summary), so a
/// usage recorded *before* it is a stale PEAK, not a floor. Taking the max
/// over the whole branch made the ring stick at the pre-compaction high —
/// observed 186,974 shown while the live branch's newest request was 44,883,
/// i.e. the "ring says 73% but /compact says session-too-small" paradox.
/// Returns 0 when there is no usage record after the last compaction yet
/// (callers fall back to the chars/4 estimate).
fn jsonl_usage_anchor(lines: &[String], start: usize) -> i64 {
    let parse = |line: &str| serde_json::from_str::<Value>(line).ok();
    // Everything at or before the newest compaction row belongs to a context
    // that compaction already replaced → not a valid anchor for THIS branch.
    // (firstKeptEntryId points to the kept *boundary* which sits before the
    // compaction row; scanning from the row+1 keeps only genuinely new turns.)
    let mut from = start;
    for (i, line) in lines.iter().enumerate() {
        if let Some(v) = parse(line) {
            if v.get("type").and_then(Value::as_str) == Some("compaction") {
                from = from.max(i + 1);
            }
        }
    }
    let mut anchor = 0i64;
    for line in lines.iter().skip(from) {
        let Some(v) = parse(line) else { continue };
        if v.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(usage) = v.pointer("/message/usage") else { continue };
        let total = usage
            .get("totalTokens")
            .and_then(Value::as_i64)
            .unwrap_or_else(|| {
                let get = |k: &str| usage.get(k).and_then(Value::as_i64).unwrap_or(0);
                get("input") + get("output") + get("cacheRead") + get("cacheWrite")
            });
        if total > anchor {
            anchor = total;
        }
    }
    anchor
}

/// Estimate the context the NEXT prompt will replay: pi sends the active
/// branch to the model — the latest compaction summary replaces everything
/// before it, followed by every message after its firstKeptEntryId. When
/// no compaction exists, the whole file counts. Returns
/// (tokens, first-record line index on the active branch, line index of the
/// latest compaction record).
pub fn estimate_active_branch(lines: &[String]) -> (i64, Option<usize>, Option<usize>) {
    let parse = |line: &str| serde_json::from_str::<Value>(line).ok();
    let mut latest_compaction: Option<(String, i64, usize)> = None; // (firstKeptEntryId, summary tokens, line idx)
    for (i, line) in lines.iter().enumerate() {
        if let Some(v) = parse(line) {
            if v.get("type").and_then(Value::as_str) == Some("compaction") {
                let summary_tokens = v
                    .get("summary")
                    .and_then(Value::as_str)
                    .map(|s| s.len() as i64 / 4)
                    .unwrap_or(0);
                let first_kept = v
                    .get("firstKeptEntryId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if first_kept.is_some() {
                    latest_compaction = Some((first_kept.unwrap(), summary_tokens, i));
                }
            }
        }
    }
    let (mut tokens, start_line, compaction_idx) = match &latest_compaction {
        Some((first_kept, summary_tokens, idx)) => {
            // Find the line whose record id matches the kept boundary.
            let start = lines.iter().position(|l| {
                parse(l)
                    .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_string))
                    .as_deref()
                    == Some(first_kept.as_str())
            });
            (*summary_tokens, start, Some(*idx))
        }
        None => (0, Some(0), None),
    };
    let start = start_line.unwrap_or(0);
    for line in lines.iter().skip(start) {
        if let Some(v) = parse(line) {
            if v.get("type").and_then(Value::as_str) == Some("message") {
                if let Some(message) = v.get("message") {
                    tokens += estimate_message_tokens(message);
                }
            }
        }
    }
    (tokens, start_line, compaction_idx)
}

/// Estimate whether the session's active branch already exceeds the window
/// budget (`window - TRIM_MARGIN_TOKENS`). Read-only — lets restore skip the
/// compaction rescue entirely for sessions that already fit. Any read/parse
/// failure means "not oversized": the session restores untouched.
fn session_oversized(session_file: &str, window: i64) -> bool {
    let Ok(raw) = std::fs::read_to_string(session_file) else {
        return false;
    };
    let lines: Vec<String> = raw
        .split('\n')
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    let (tokens, _, _) = estimate_active_branch(&lines);
    tokens > window - TRIM_MARGIN_TOKENS
}

/// Local fallback for an oversized restored session whose pi-side compaction
/// could not run (free-tier upstreams silently drop the summarization call —
/// it replays the same oversized context and hangs). Walks the newest-first
/// user-turn boundaries, finds the slice that fits under
/// `window - TRIM_MARGIN_TOKENS`, and WRITES THE RESULT BACK INTO THE ORIGINAL
/// jsonl — no `.trimmed.jsonl` twin (opencode-style single-file history).
///
/// Write protocol: full content first to `<file>.trim.tmp`, then copy over
/// the original path. Never rename-replace: pi holds the file open with
/// O_APPEND (libuv share mode allows the replace, but pi's handle would keep
/// appending to the unlinked old stream and silently fork the history).
/// Best-effort — on any failure the original file keeps its oversized
/// content. Returns Ok(true) when the file was rewritten, Ok(false) when it
/// already fits (or is untrimmable, e.g. a single huge turn).
pub fn trim_session_in_place(session_file: &str, window: i64) -> Result<bool, String> {
    if window <= 0 {
        return Ok(false);
    }
    let raw = std::fs::read_to_string(session_file).map_err(|e| e.to_string())?;
    let lines: Vec<String> = raw
        .split('\n')
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    if lines.len() < 2 {
        return Ok(false);
    }
    let (tokens, _, latest_compaction_idx) = estimate_active_branch(&lines);
    let budget = window - TRIM_MARGIN_TOKENS;
    if tokens <= budget {
        return Ok(false);
    }
    // Turn boundaries: indices of user-message records — a trim must cut at
    // one so the model gets whole turns (a user prompt + its replies).
    let mut user_turns: Vec<usize> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if v.get("type").and_then(Value::as_str) == Some("message")
                && v.pointer("/message/role").and_then(Value::as_str) == Some("user")
            {
                user_turns.push(i);
            }
        }
    }
    if user_turns.is_empty() {
        return Ok(false); // nothing to cut at — a single oversized turn can't be rescued here
    }
    // Walk turns newest-first; stop once the kept slice fits the budget.
    let mut keep_from: Option<usize> = None;
    let mut acc: i64 = 0;
    for &turn_start in user_turns.iter().rev() {
        let turn_end = user_turns
            .iter()
            .find(|&&t| t > turn_start)
            .copied()
            .unwrap_or(lines.len());
        let turn_tokens: i64 = lines[turn_start..turn_end]
            .iter()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| v.get("type").and_then(Value::as_str) == Some("message"))
            .filter_map(|v| v.get("message").map(estimate_message_tokens))
            .sum();
        if acc + turn_tokens > budget && keep_from.is_some() {
            break; // adding this older turn would overflow — keep what we have
        }
        acc += turn_tokens;
        keep_from = Some(turn_start);
    }
    let Some(keep_from) = keep_from else {
        return Ok(false);
    };
    // If the cut lands after the latest compaction record, carry that record
    // forward — its summary is the only surviving memory of everything before
    // the cut, and it costs only a couple thousand tokens.
    let mut prefix_records: Vec<String> = Vec::new();
    if let Some(compaction_idx) = latest_compaction_idx {
        if compaction_idx < keep_from {
            // The compaction's own parentId dangles once earlier records are
            // gone; the message records that follow keep their chain, so only
            // patch the record that starts the file's chain.
            if let Ok(mut v) = serde_json::from_str::<Value>(&lines[compaction_idx]) {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("parentId".into(), Value::Null);
                }
                if let Ok(s) = serde_json::to_string(&v) {
                    prefix_records.push(s);
                }
            }
        }
    }
    // Header + kept records; the first kept record's parentId still points at
    // a dropped record — patch it to null so the loader sees a clean root.
    let has_prefix = !prefix_records.is_empty();
    let mut out = vec![lines[0].clone()];
    out.append(&mut prefix_records);
    let mut patched_first = has_prefix;
    for line in lines.iter().skip(keep_from) {
        if let Ok(mut v) = serde_json::from_str::<Value>(line) {
            if !patched_first {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("parentId".into(), Value::Null);
                }
                patched_first = true;
            }
            out.push(serde_json::to_string(&v).map_err(|e| e.to_string())?);
        }
        // Non-JSON (crash-truncated tail) is dropped.
    }
    let tmp_path = format!("{session_file}.trim.tmp");
    std::fs::write(&tmp_path, out.join("\n") + "\n").map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::copy(&tmp_path, session_file) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e.to_string());
    }
    let _ = std::fs::remove_file(&tmp_path);
    eprintln!(
        "[pi agent] oversized session trimmed in place: ~{tokens} tokens > window {window}; kept ~{acc} tokens from record {keep_from}"
    );
    Ok(true)
}

/// touching any pi process — O(tail bytes), not O(session length). Used for
/// instant first paint when switching back to an old conversation while the
/// real instance restores in the background.
///
/// Robustness rules (the jsonl is append-only but crash-prone):
///  - lines are \n-delimited JSON; a crash-truncated final line is skipped;
///  - a single record can exceed 50KB (large tool results) — the chunked
///    tail reader may start mid-line; the first partial line is discarded;
///  - only message records with user/assistant text are rendered.
fn peek_session_tail(session_id: &str, count: usize) -> Result<Value, String> {
    let session_file = SESSION_FILES
        .lock()
        .unwrap()
        .get(session_id)
        .filter(|p| std::path::Path::new(p).exists())
        .cloned()
        .or_else(|| find_session_file(session_id))
        .ok_or_else(|| format!("no session file for {session_id}"))?;
    let tail = read_tail_lines(&session_file, 2 * 1024 * 1024)?;
    let mut messages: Vec<Value> = Vec::new();
    let mut parser_failed = 0usize;
    for line in tail.iter().rev() {
        if messages.len() >= count {
            break;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            parser_failed += 1;
            continue;
        };
        // The message body lives under `message` (see the jsonl head: each
        // message record is {"type":"message","message":{"role":...}}).
        let Some(message) = record.get("message") else {
            continue;
        };
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        let text = content_to_text(message.get("content").unwrap_or(&Value::Null));
        let text = match &text {
            Value::String(s) => s.clone(),
            _ => String::new(),
        };
        if !matches!(role, "user" | "assistant") {
            continue;
        }
        // Skip empty stubs (assistant turns that errored before any text).
        if text.trim().is_empty() {
            continue;
        }
        messages.push(json!({
            "role": role,
            "text": text,
            "timestamp": message.get("timestamp").or_else(|| record.get("timestamp")),
        }));
    }
    messages.reverse();
    if parser_failed > 0 {
        eprintln!(
            "[pi agent] peek: skipped {parser_failed} malformed tail line(s) in {session_file}"
        );
    }
    Ok(json!({
        "session_id": session_id,
        "messages": messages,
    }))
}

/// Read the last lines of a (potentially multi-MB) file by seeking backwards
/// in chunks. Returns the lines whose START falls inside the read window —
/// if the window cut a line in half, that leading partial line is dropped.
fn read_tail_lines(path: &str, max_bytes: u64) -> Result<Vec<String>, String> {
    use std::io::{Seek, SeekFrom};
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let window = size.min(max_bytes);
    file.seek(SeekFrom::End(-(window as i64)))
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; window as usize];
    std::io::Read::read_exact(&mut file, &mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    // The window may have started mid-line: drop the leading partial unless
    // we read the whole file (offset 0 → first split is a real line start).
    if window < size {
        lines.remove(0);
    }
    // A crash-truncated final line (no trailing \n) is still returned —
    // peek_session_tail's JSON parse rejects it if it's garbage.
    lines.retain(|l| !l.trim().is_empty());
    Ok(lines)
}

/// Cold-start session restore: find a pi session file on disk whose name or
/// embedded session id matches (`~/.pi/agent/sessions/<project>/*_<uuid>.jsonl`,
/// where <uuid> is the pi session id). Returns the newest match.
fn find_session_file(session_id: &str) -> Option<String> {
    if session_id.is_empty() {
        return None;
    }
    let mut best: Option<(std::time::SystemTime, String)> = None;
    scan_session_files(|id, path| {
        if id != session_id {
            return None;
        }
        let modified = path
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().is_none_or(|(m, _)| *m < modified) {
            best = Some((modified, path.to_string_lossy().into_owned()));
        }
        None::<()>
    });
    best.map(|(_, path)| path)
}

/// Pick the on-disk pi session file for a conversation's project dir.
///
/// Two selection modes, chosen by `first_user_message`:
/// - **None** (legacy / no hint): pick the file with the most message lines
///   (the most complete conversation), breaking ties by newest mtime. Only
///   safe when the cwd uniquely identifies the conversation — it would grab a
///   *different* conversation's file if several share the same cwd.
/// - **Some(fp)**: match by **conversation fingerprint** — the caller's real
///   first user message. A cwd-matching file matches when its own first user
///   message (normalized) **contains** `fp` (normalized); among matches pick the
///   newest mtime. Containment — not equality — because a rebuilt session's
///   first user message is the SEED wrapping the real message, so the real
///   message is a substring, never equal. This recovers a conversation precisely
///   even when its conversation→sid map entry was lost or its recorded sid died,
///   WITHOUT hijacking another conversation in the same project dir. Returns
///   None when no file's first user message contains `fp`, so the caller falls
///   back to session/new rather than grabbing the wrong conversation.
///
/// In fingerprint mode each candidate's header (cwd, O(1)) plus its first user
/// record (O(file), bounded by that record's position) is read. The legacy mode
/// reads each candidate's line count (O(file-size)).
/// Fingerprint-mode candidate list: files in `target_cwd` whose first user
/// message contains `fp`, newest mtime first, up to `limit`.
///
/// Why a LIST: forks duplicate the whole history, so a parent and its branch
/// share the SAME fingerprint — a single "best" answer is ambiguous (the
/// branch is usually newer and would shadow the parent). The caller tries
/// candidates in order and skips sids claimed by other conversations.
///
/// Seed compatibility: a rebuilt session's (session/new + seedHistory) first
/// user message is the whole SEED — "（系统注入…）\n\n[用户]\n{real}\n\n[助手]…"
/// — and the real first message only appears verbatim when the seed replay
/// wasn't front-truncated (SEED_MAX_TURNS/CHARS drain oldest first). For
/// seeded files we match against the first "[用户]" turn inside the seed so
/// existing seed sessions are findable again; heavily truncated seeds still
/// fall through (the frontend's storedId/sids retries cover them).
fn find_session_files_by_cwd(
    target_cwd: &str,
    first_user_message: Option<&str>,
    limit: usize,
) -> Vec<String> {
    let target_norm = normalize_path(target_cwd);
    let fp = first_user_message.map(normalize_fingerprint);
    let mut fp_hits: Vec<(std::time::SystemTime, String)> = Vec::new();
    scan_session_files(|id, path| {
        let Some(file_cwd) = read_session_cwd(&path.to_string_lossy()) else {
            return None;
        };
        if normalize_path(&file_cwd) != target_norm {
            return None;
        }
        let Some(fp) = &fp else { return None };
        let Some(first) = read_first_user_message(&path.to_string_lossy()) else {
            return None;
        };
        let first_norm = normalize_fingerprint(&first);
        // SEED 兼容：重建会话的磁盘首条消息是「（系统注入…）」包装，真实首条
        // 消息藏在首个 [用户] 段里。剥离包装后再比对，否则种子会话永远无法被
        // 指纹找回（"每次重启都铸造新 jsonl"的根因之一）。
        let effective = if first_norm.contains("系统注入：以下是本次会话恢复的先前对话记录") {
            extract_seed_fingerprint(&first_norm)
        } else {
            first_norm
        };
        let modified = path
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .unwrap_or(std::time::UNIX_EPOCH);
        // CONTAINMENT, not equality: the caller's fingerprint is the
        // conversation's *real* first user message while the file's may be a
        // seed-wrapped superset (or contain casing/whitespace drift). Require
        // ≥3 normalized chars so a 1–2 char first message can't spuriously
        // match everything.
        if fp.chars().count() >= 3 && effective.contains(fp.as_str()) {
            fp_hits.push((modified, id.to_string()));
        }
        None::<()>
    });
    fp_hits.sort_by(|a, b| b.0.cmp(&a.0));
    fp_hits.truncate(limit);
    fp_hits.into_iter().map(|(_, id)| id).collect()
}

/// Pull the conversation's real first user message out of a seed-wrapped one:
/// "（系统注入：…）\n\n[用户]\n{real}\n\n[助手]\n…" → "{real}". Returns the
/// input unchanged when no "[用户]" section exists (defensive).
fn extract_seed_fingerprint(seed_text: &str) -> String {
    let rest = match seed_text.find("[用户]") {
        Some(i) => &seed_text[i + "[用户]".len()..],
        None => return seed_text.to_string(),
    };
    let real = rest.strip_prefix('\n').unwrap_or(rest);
    match real.find("\n\n[") {
        Some(j) => real[..j].to_string(),
        None => real.to_string(),
    }
}

/// Single-best wrapper kept for other call sites: fingerprint mode delegates
/// to the candidate list (newest hit); no-fingerprint mode keeps the legacy
/// "longest chain in this cwd" heuristic (frontend only sends no-fingerprint
/// for legacy/edge paths).
fn find_session_file_by_cwd(target_cwd: &str, first_user_message: Option<&str>) -> Option<String> {
    if first_user_message.is_some() {
        return find_session_files_by_cwd(target_cwd, first_user_message, 1)
            .into_iter()
            .next();
    }
    let target_norm = normalize_path(target_cwd);
    let mut longest: Option<(u64, std::time::SystemTime, String)> = None;
    scan_session_files(|id, path| {
        let Some(file_cwd) = read_session_cwd(&path.to_string_lossy()) else {
            return None;
        };
        if normalize_path(&file_cwd) != target_norm {
            return None;
        }
        let modified = path
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .unwrap_or(std::time::UNIX_EPOCH);
        // Count newlines in the file — pi writes one JSON record per line.
        let lines =
            std::fs::read(path).map(|b| b.iter().filter(|&&c| c == b'\n').count()).unwrap_or(0);
        if longest
            .as_ref()
            .is_none_or(|(bl, bm, _)| (lines as u64, modified) > (*bl, *bm))
        {
            longest = Some((lines as u64, modified, id.to_string()));
        }
        None::<()>
    });
    longest.map(|(_, _, id)| id)
}

/// Normalize a message into a comparison key: lowercase + collapse all
/// whitespace (incl. newlines) to single spaces. Two first-user messages count
/// as "the same conversation" when their normalized forms match, regardless of
/// incidental whitespace / casing drift between the local chat store and the
/// pi session jsonl.
fn normalize_fingerprint(s: &str) -> String {
    s.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Read the first user turn's text from a pi session jsonl. Returns None if the
/// file has no user turn yet, or can't be read. Stops at the first user record
/// (O(file) but bounded by that record's position).
fn read_first_user_message(session_file: &str) -> Option<String> {
    let Ok(content) = std::fs::read_to_string(session_file) else {
        return None;
    };
    for line in content.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let role = v
            .get("message")
            .and_then(|m| m.get("role"))
            .and_then(Value::as_str)
            .or_else(|| v.get("role").and_then(Value::as_str));
        if role != Some("user") {
            continue;
        }
        let content = v
            .get("message")
            .and_then(|m| m.get("content"))
            .or_else(|| v.get("content"));
        let text = match content {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(blocks)) => {
                let mut t = String::new();
                for b in blocks {
                    if let Some(Value::String(s)) = b.get("text") {
                        t.push_str(s);
                    }
                }
                t
            }
            _ => continue,
        };
        if text.trim().is_empty() {
            continue;
        }
        return Some(text);
    }
    None
}

/// Lowercase + collapse path separators to '/' + strip a trailing slash, for
/// cross-platform path equality. The jsonl header stores the exact cwd pi was
/// spawned with (e.g. a Windows `D:\Project\Helix`) while the frontend sends
/// its own copy — normalizing both sides so case/separator drift can't defeat
/// the match.
fn normalize_path(p: &str) -> String {
    p.to_lowercase()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

/// Read the conversation's real project dir from the jsonl header record
/// (`{"type":"session",...,"cwd":"D:\\Project\\Helix"}`). Only the first line
/// is read, so cost is O(1) even for multi-MB session files.
fn read_session_cwd(session_file: &str) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(session_file).ok()?;
    // The session record is the first line; cap the read so a corrupted header
    // (or a file whose first line is enormous) can't balloon memory.
    let mut buf = vec![0u8; 4096];
    let n = file.read(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);
    let first_line = text.lines().next()?;
    let header: Value = serde_json::from_str(first_line.trim_end_matches(['\r'])).ok()?;
    match header.get("type").and_then(Value::as_str) {
        Some("session") => header
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            .map(str::to_string),
        _ => None,
    }
}

/// Walk ~/.pi/agent/sessions once and feed every `<uuid>.jsonl` to `visit`,
/// stopping when it returns Some. Filename shape: `<timestamp>_<uuid>.jsonl`
/// — the session id is the trailing uuid segment.
fn scan_session_files<T>(mut visit: impl FnMut(&str, &std::path::Path) -> Option<T>) -> Option<T> {
    let root = dirs::home_dir()?.join(".pi/agent/sessions");
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let stem = name.trim_end_matches(".jsonl");
            let Some(id) = stem.rsplit_once('_').map(|(_, id)| id) else {
                continue;
            };
            if !id.is_empty() && id != stem {
                if let Some(result) = visit(id, &path) {
                    return Some(result);
                }
            }
        }
    }
    None
}

/// Startup warm-up: index every session file into SESSION_FILES so the first
/// conversation resume doesn't pay a full directory-tree walk. Runs in the
/// background — correctness is unaffected either way (find_session_file
/// remains the fallback for a cache miss).
fn warm_session_file_index() {
    thread::spawn(|| {
        let mut map = SESSION_FILES.lock().unwrap();
        scan_session_files(|id, path| {
            // Don't clobber entries added meanwhile by live instances — those
            // are fresher than whatever this scan finds.
            map.entry(id.to_string())
                .or_insert_with(|| path.to_string_lossy().into_owned());
            None::<()>
        });
    });
}

/// Pick the instance for a session-scoped RPC: `session_id` when present
/// (spawning/respawning if needed), otherwise the main instance.
async fn routed_instance(params: &Value, state: &Arc<AppState>) -> Result<Arc<PiInstance>, String> {
    let session_id = params
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // Prefix the structured kind on the error string. The callers that keep
    // the Err contract (session/prompt, session/compress, ...) surface this
    // string verbatim to the frontend, which classifies it with the same
    // rule as session/resume's `error_kind`. prompt.submit / compress must
    // NEVER resume or create on this failure — they only report the
    // classification, and the caller decides whether the session is broken.
    instance_for_session(&session_id, state)
        .await
        .map_err(|e| {
            let kind = classify_session_error(&e);
            log_spawn_diag(&format!(
                "route FAILED sid={session_id} kind={kind}: {e}"
            ));
            format!("{kind}: {e}")
        })
}

/// approval/clarify routing: prefer session_id; fall back to which instance
/// registered the UI request (Tauri's helix_approval_respond has no session).
async fn routed_instance_or_ui_owner(
    params: &Value,
    approval_id: &str,
    state: &Arc<AppState>,
) -> Result<Arc<PiInstance>, String> {
    let session_id = params
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !session_id.is_empty() {
        return instance_for_session(&session_id, state).await;
    }
    let owner_key = UI_REQUEST_OWNERS
        .lock()
        .unwrap()
        .get(approval_id)
        .cloned()
        .unwrap_or_default();
    instance_for_session(&owner_key, state).await
}

/// Read + active-branch estimate of the instance's live session jsonl.
/// Shared by the `context_breakdown` RPC and the per-message usage ring so
/// both report the same "what the NEXT prompt will replay" figure instead of
/// the last request's (often far smaller) `contextUsage`. Returns
/// `(0, null, 0)` when the live file is unknown/unread.
/// The second return value is the per-kind breakdown as a JSON array (the same
/// shape `context_breakdown` returns as `categories`) — or `Null` when no
/// buckets were produced — so the usage ring can carry real categories instead
/// of the "会话上下文" aggregate lump, which made the panel's label set
/// appear to change on its own. The third return value is the persisted usage
/// anchor (`jsonl_usage_anchor`) — a restart-proof floor the callers take the
/// max with, so a fresh respawn no longer reports 0→chars/4 estimate and
/// the ring "resets" before the next real call re-calibrates.
fn jsonl_active_branch_estimate(
    instance: &Arc<PiInstance>,
) -> (i64, Option<Value>, i64) {
    let Value::String(sid) = instance.current_session_id() else {
        return (0, None, 0);
    };
    let cached_file = SESSION_FILES.lock().unwrap().get(&sid).cloned();
    let Some(session_file) = cached_file.or_else(|| find_session_file(&sid)) else {
        return (0, None, 0);
    };
    let Ok(raw) = std::fs::read_to_string(&session_file) else {
        return (0, None, 0);
    };
    let lines: Vec<String> = raw
        .split('\n')
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    let (estimated, parts) = estimate_active_branch_by_kind(&lines);
    let categories = if parts.is_empty() || estimated == 0 {
        None
    } else {
        Some(resume_category_payload(&parts))
    };
    let anchor = jsonl_usage_anchor(&lines, 0);
    (estimated, categories, anchor)
}

/// pi 的 `/context`（pi-cc-extensions）报告行：`System prompt: 12.3k tokens`。
/// `formatTokens` 的口径：<1k 原样、<100k 一位小数 + k、其余整数 + k —— 所以
/// 解析只要认「可选小数 + 可选 k 后缀」这一种形态，认不出就不是报告行。
fn parse_pi_context_line(line: &str) -> Option<(String, i64)> {
    let line = line.trim();
    let (label, rest) = line.split_once(':')?;
    let label = label.trim();
    if label.is_empty() {
        return None;
    }
    let rest = rest.trim().strip_suffix("tokens")?.trim();
    let (num, scale) = match rest.strip_suffix('k') {
        Some(n) => (n.trim(), 1000f64),
        None => (rest, 1f64),
    };
    let value: f64 = num.parse().ok()?;
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    Some((label.to_string(), (value * scale).round() as i64))
}

/// 拉一次 pi 自己的 `/context`（pi-cc-extensions 的 context-window 分布），
/// 返回它那 6+2 个 part 的 `(label, tokens)`。
///
/// 为什么走命令而不是自己猜分类：pi 的 `/context` 是**按真实请求**组装的
/// （systemPrompt / tools / messages 三部分同步计数，见 pi-cc-extensions
/// feature/context.ts），系统提示、技能、记忆、工具 schema 这些大头只在 pi
/// 进程里现成。网关拿 jsonl 反推永远对不上（旧分类就是这么和 pi 显示不一致的）。
///
/// 前置条件：命令必须已注册。没有它时 `/context` 会被当普通 prompt 发给模型
/// （`_tryExecuteExtensionCommand` 返回 false 就走真实回合了）——所以先用
/// `get_commands` 确认，并把这个结论缓进实例（`context_cmd_state`）。
///
/// 返回 None = 这台 pi 上没有该命令（或它没吐出报告行），调用方回落到 jsonl 分类。
async fn pi_context_report_parts(instance: &Arc<PiInstance>) -> Option<Vec<(String, i64)>> {
    let now = now_ms();
    let cached = instance.context_cmd_state.load(Ordering::SeqCst);
    let checked_at = instance.context_cmd_checked_ms.load(Ordering::SeqCst);
    // 负结论只信 60s：装扩展 / 升级扩展都不该被一个常驻实例永久否决。
    let negative_stale = cached < 0 && now.saturating_sub(checked_at) >= 60_000;
    if cached < 0 && !negative_stale {
        return None;
    }
    if cached != 1 || negative_stale {
        let cmds = instance
            .request("get_commands", Value::Null, RPC_TIMEOUT)
            .await
            .ok()?;
        let has = cmds
            .get("commands")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .any(|c| c.get("name").and_then(Value::as_str) == Some("context"))
            })
            .unwrap_or(false);
        instance
            .context_cmd_state
            .store(if has { 1 } else { -1 }, Ordering::SeqCst);
        instance.context_cmd_checked_ms.store(now, Ordering::SeqCst);
        if !has {
            return None;
        }
    }
    // 闩住，把这次 report 的 notify 收进来（handle_line 的 notify 分支见状不转发）。
    // 已经在闩 = 另有探针在跑（两个浮层同时开）：不清它的缓冲，只搭车读，
    // 免得前一个探针被抹成空、白等 1.5s 再回落到旧分类。
    let armed_by_me = instance.context_probe.lock().unwrap().is_none();
    if armed_by_me {
        *instance.context_probe.lock().unwrap() = Some(Vec::new());
    }
    let prompted = instance
        .request("prompt", json!({ "message": "/context" }), RPC_TIMEOUT)
        .await;
    // notify 是 fire-and-forget 的 event，正常情况下排在 prompt 响应**之前**
    // 就到了；agent_settled 期间发出的 prompt 会被 pi 推迟，那就再等一下。
    // 只 drain 不 take：迟到的行还能接着进同一个缓冲。
    let mut captured: Vec<String> = Vec::new();
    for _ in 0..30 {
        captured = instance
            .context_probe
            .lock()
            .unwrap()
            .as_ref()
            .map(|v| v.clone())
            .unwrap_or_default();
        if !captured.is_empty() {
            break;
        }
        if prompted.is_err() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if armed_by_me {
        *instance.context_probe.lock().unwrap() = None;
    }
    if prompted.is_err() {
        return None;
    }
    let parts: Vec<(String, i64)> = captured
        .iter()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| parse_pi_context_line(l))
        .collect();
    if parts.len() < 2 {
        return None;
    }
    Some(parts)
}

/// get_session_stats → Helix context-breakdown shape.
///
/// `context_used` is NOT pi's `contextUsage.tokens` (that is what the LAST
/// request consumed — after a trim/restore it lags far behind what the NEXT
/// prompt will actually replay). When the session's jsonl active-branch
/// estimate exceeds it, the estimate wins: the ring must warn the user the
/// next prompt is near/over the window, not report a comfortable stale figure.
async fn context_breakdown(stats: &Value, instance: &Arc<PiInstance>) -> Result<Value, String> {
    let tokens = stats.get("tokens").cloned().unwrap_or(Value::Null);
    let context = stats.get("contextUsage").cloned().unwrap_or(Value::Null);
    let input_tokens = tokens.get("input").and_then(Value::as_i64).unwrap_or(0);
    let output_tokens = tokens.get("output").and_then(Value::as_i64).unwrap_or(0);
    let cached_read = tokens.get("cacheRead").and_then(Value::as_i64).unwrap_or(0);
    let cached_write = tokens
        .get("cacheWrite")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    // 分母：本会话自己那个模型的窗口（pi 本次上报的 per-session 窗口优先，
    // 其次 models.json 里本实例模型的条目）。全局默认模型只作最后兜底 ——
    // 旧代码把全局放第一，于是"会话覆盖成 1M 模型、全局默认是 256k 模型"时
    // 分母被解析成 256k。
    let context_max = instance.context_max(
        context.get("contextWindow").and_then(Value::as_i64),
    );
    let mut context_used = context.get("tokens").and_then(Value::as_i64).unwrap_or(0);
    // True next-prompt replay size from the session file — same estimator the
    // restore-time trim uses. Cheaper than a stale 2k figure hiding a 276k
    // replay behind a 128k window. Shared with the per-message usage ring so
    // the ring and this breakdown never disagree.
    let (jsonl_estimate, jsonl_categories, jsonl_anchor) =
        jsonl_active_branch_estimate(instance);
    let mut categories: Value = jsonl_categories.unwrap_or(Value::Array(Vec::new()));
    if jsonl_estimate > context_used {
        context_used = jsonl_estimate;
    }
    // Persisted floor: the last provider-reported total on the active branch,
    // written into the session jsonl — survives a gateway restart, unlike
    // the volatile `last_context_used` (0 after every respawn).
    if jsonl_anchor > context_used {
        context_used = jsonl_anchor;
    }
    // In-process floor with the last REAL per-call figure (pi's totalTokens):
    // fresh measurements between the persisted anchor and now.
    if instance.last_context_used() > context_used {
        context_used = instance.last_context_used();
    }
    let context_percent = if context_max > 0 {
        (context_used as f64 / context_max as f64) * 100.0
    } else {
        0.0
    };

    // No session-file breakdown yet (fresh instance, file not written):
    // fall back to the provider's current context figure as one lump so the
    // bar still shows something honest. Marked `aggregate` so the UI can
    // render a stable single row instead of a set of labels that appear to
    // change on its own once buckets land.
    if context_used > 0 && categories == Value::Array(Vec::new()) {
        categories = json!({
            "id": "conversation",
            "label": "整体上下文占用",
            "tokens": context_used,
            "color": "var(--context-usage-conversation)",
            "aggregate": true,
        });
    }
    let estimated_total = match &categories {
        Value::Array(arr) => arr
            .iter()
            .filter_map(|c| c.get("tokens").and_then(Value::as_i64))
            .sum(),
        _ => 0,
    };

    Ok(json!({
        "context_max": context_max,
        "context_used": context_used,
        "context_percent": context_percent,
        "estimated_total": estimated_total,
        "categories": categories,
        // Lifetime billing counters (not composition) — the panel shows them
        // as a reference row, not as usage-bar segments.
        "usage_stats": {
            "input": input_tokens,
            "output": output_tokens,
            "cache_read": cached_read,
            "cache_write": cached_write,
        },
    }))
}

/// Build the `categories` payload from a `by_kind` breakdown the way
/// `context_breakdown` does — shared by `session.context_breakdown` and
/// `session.resume` (which must populate the frontend's context ring the
/// moment a reaped conversation is restored, before any prompt runs).
fn resume_category_payload(by_kind: &[(&'static str, i64)]) -> Value {
    let mut categories = Vec::new();
    let mut push_category = |id: &str, label: &str, tokens: i64, color: &str| {
        if tokens > 0 {
            categories.push(json!({
                "id": id,
                "label": label,
                "tokens": tokens,
                "color": color,
            }));
        }
    };
    for (kind, tokens) in by_kind {
        match *kind {
            "user" => push_category(
                "user",
                "用户消息",
                *tokens,
                "var(--context-usage-conversation)",
            ),
            "assistant" => {
                push_category("assistant", "回复", *tokens, "var(--context-usage-system)")
            }
            "thinking" => push_category(
                "thinking",
                "思考",
                *tokens,
                "var(--context-usage-subagents)",
            ),
            "tools" => push_category(
                "tools",
                "工具调用与结果",
                *tokens,
                "var(--context-usage-tools)",
            ),
            "summary" => push_category(
                "summary",
                "压缩摘要",
                *tokens,
                "var(--context-usage-memory)",
            ),
            _ => {}
        }
    }
    Value::Array(categories)
}

/// diff 文本送前端的字节上限：超了就截断（前端只显示一截），并且**必须**让
/// 前端把撤销标为不安全——被截断的 diff 反推不出原文件，拿来写盘就是损坏。
const MAX_DIFF_BYTES: usize = 16_384;

/// 按行切分用于 diff 的内容：末尾换行不算一行（`"a\n"` = 1 行，不是 2 行），
/// 空文本 = 0 行。与旧的 write 合成 patch 保持同一约定。
fn split_lines_for_diff(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    if text.ends_with('\n') {
        lines[..lines.len().saturating_sub(1)].to_vec()
    } else {
        lines
    }
}

/// `write` 覆盖前抓到的文件状态。
///
/// 为什么分四种：只有 `Text` 能算出**真 diff**（可撤销）；`Bytes` 没法逐行 diff，
/// 但有字节指纹——写完比一比就知道是不是原样重写，能消掉假"整文件新增"；
/// `Unreadable` 连字节都拿不到，什么都判断不了，只能按"改过了但撤销不安全"处理。
/// `NewFile` 单独留着是因为它**该**按空文件算 diff（头用 `--- /dev/null`），
/// 与"读不到"是两回事，不能混。
enum PriorFile {
    /// 文件当时不存在 → 这是一次新建。
    NewFile,
    /// 读到了 UTF-8 文本、≤2MB → 可以逐行 diff。
    Text(String),
    /// 读到了字节但没法逐行 diff（>2MB 或非 UTF-8）。带上字节数与 SHA-256，
    /// 写完把新内容的指纹比一比就能判断"其实一行没改"。
    Bytes { len: usize, sha: String },
    /// 字节都读不到（相对路径且实例无 cwd / 权限 / I/O 错误）。
    Unreadable,
}

/// 工具 args 里的文件路径字段：pi 默认 write/edit 用 `path`，个别封装变体
/// 用 `file_path` / `filePath`。三种都认——字段名对不上时合成 patch 会被
/// **静默**跳过，前端就再也看不到 +N −n。
fn arg_path(args: &Value) -> Option<&str> {
    args.get("path")
        .or_else(|| args.get("file_path"))
        .or_else(|| args.get("filePath"))
        .and_then(Value::as_str)
}

/// 读取 `write` 即将覆盖的文件的旧状态（在 tool_execution_start、文件还没被写时调用）。
///
/// 任何情况都返回一个值（不再有"没抓到"的 `None`）：`Bytes` / `Unreadable` 也
/// 得进缓存，否则 tool_execution_end 无从区分"新建"与"读不到"。
///
/// 字节指纹在 >2MB / 非 UTF-8 时也照算——那两条路走不到文本 diff，全靠它判断
/// 模型是不是原样重写了一遍。
fn read_prior_file_content(instance: &PiInstance, path: &str) -> PriorFile {
    let p = std::path::Path::new(path);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        let dir = instance.spawn_dir();
        if dir.is_empty() {
            return PriorFile::Unreadable;
        }
        std::path::Path::new(&dir).join(p)
    };
    match std::fs::read(&abs) {
        Ok(bytes) => {
            let len = bytes.len();
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            let sha = hex::encode(hasher.finalize());
            if len > 2 * 1024 * 1024 {
                return PriorFile::Bytes { len, sha };
            }
            match String::from_utf8(bytes) {
                Ok(text) => PriorFile::Text(text),
                Err(_) => PriorFile::Bytes { len, sha },
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => PriorFile::NewFile,
        Err(_) => PriorFile::Unreadable,
    }
}

/// 统一截断 diff 文本（见 [`MAX_DIFF_BYTES`]）。
fn truncate_diff(s: String) -> String {
    if s.len() <= MAX_DIFF_BYTES {
        return s;
    }
    format!(
        "{}…[diff 过长已截断]",
        s.chars().take(MAX_DIFF_BYTES).collect::<String>()
    )
}

/// 为 `write` 合成 unified diff（旧内容 → 新内容）。
///
/// 只出一段 hunk：公共前缀/后缀各留 ≤3 行上下文，中间整段替换。行号与计数都
/// 精确，所以前端 `reverseUnifiedDiff` 能逐行还原（撤销 = 写回旧内容）。
///
/// `new_file = true` 时用 `--- /dev/null` 头（前端据此把撤销实现为删除文件）；
/// 此时 `prior` 恒为 `None`。
///
/// 「旧内容未知」与「旧文件为空」不是一回事：调用方在 `prior = None` 且
/// `new_file = false` 时**不再**调本函数——按空文件假想会把整份新内容标成
/// 「新增」（模型只是原样重写一遍时卡片凭空显示 +N，撤销也只能靠快照），
/// 那种情况调用方直接不给 patch、只标 `undoUnsafe`。
///
/// 返回 `None` = 新旧内容一致（这次 write 没改任何东西，不该进「已修改」）。
fn write_unified_diff(
    path: &str,
    prior: Option<&str>,
    new_text: &str,
    new_file: bool,
) -> Option<String> {
    let new_lines = split_lines_for_diff(new_text);
    let old_lines = prior.map(split_lines_for_diff).unwrap_or_default();
    if !new_file && old_lines == new_lines {
        return None;
    }
    let mut patch = String::new();
    if new_file {
        patch.push_str(&format!("--- /dev/null\n+++ {path}\n"));
    } else {
        patch.push_str(&format!("--- {path}\n+++ {path}\n"));
    }
    let mut pre = 0usize;
    while pre < old_lines.len() && pre < new_lines.len() && old_lines[pre] == new_lines[pre] {
        pre += 1;
    }
    let mut suf = 0usize;
    while suf < old_lines.len() - pre
        && suf < new_lines.len() - pre
        && old_lines[old_lines.len() - 1 - suf] == new_lines[new_lines.len() - 1 - suf]
    {
        suf += 1;
    }
    let before = pre.min(3);
    let after = suf.min(3);
    let old_mid = &old_lines[pre..old_lines.len() - suf];
    let new_mid = &new_lines[pre..new_lines.len() - suf];
    patch.push_str(&format!(
        "@@ -{},{} +{},{} @@\n",
        if old_lines.is_empty() { 0 } else { pre - before + 1 },
        before + old_mid.len() + after,
        pre - before + 1,
        before + new_mid.len() + after
    ));
    // 正文各行用 "\n" 分隔但**末尾不留换行**：前端 `reverseUnifiedDiff` 是按
    // `diff.split("\n")` 逐行读的，结尾那个空串会被当成一条空的上下文行
    // （源码里 `else oldSegment.push(bodyLine)` 兜住了它），反推出来的文件就
    // 平白多一个换行 —— 撤销写回去的内容与原文差一个 \n。实测（16 个往返用例）
    // 只有不留尾换行时反推才逐字节等于旧内容。
    let mut body: Vec<String> = Vec::new();
    for line in &old_lines[pre - before..pre] {
        body.push(format!(" {line}"));
    }
    for line in old_mid {
        body.push(format!("-{line}"));
    }
    for line in new_mid {
        body.push(format!("+{line}"));
    }
    for line in &old_lines[old_lines.len() - suf..old_lines.len() - suf + after] {
        body.push(format!(" {line}"));
    }
    patch.push_str(&body.join("\n"));
    Some(patch)
}

fn handle_line(instance: &Arc<PiInstance>, line: &str) {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let event_type = message
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match event_type {
        "response" => {
            let Some(id) = message.get("id").and_then(Value::as_str) else {
                return;
            };
            if let Some(pending) = instance.pending.lock().unwrap().remove(id) {
                pending.tx.deliver(message);
            } else {
                // 响应帧找不到等待者：多半是请求侧已超时（RPC_TIMEOUT）后
                // pending 被移除。这是「session/prompt 挂满超时但 pi 其实早
                // 就回完了」的直接证据，打一行便于和前端轨迹对时间线。
                eprintln!(
                    "[pi agent] response without waiter: sid={} id={}",
                    instance.current_session_id(),
                    id
                );
            }
        }
        _ => {
            // Any pi event (stream delta, tool update, …) proves the model
            // stream is alive — heartbeat for the turn watchdog.
            instance.last_event_ms.store(now_ms(), Ordering::SeqCst);
            // 回合生命周期标记（低频，每回合 2-5 行）：「前端整回合收不到任何
            // 流式事件」时，这几行能立刻二分定位——网关侧完全没打 = pi 的输出
            // 没到 reader；网关打了但前端没内容 = 丢在 emit → Tauri → 前端过滤
            // 这一段。只挑回合边界事件，delta 不打（否则刷屏）。
            emit_pi_event(instance, event_type, &message);
        }
    }
}

/// 子 agent 终态词表收敛。扩展自己发的是
/// `queued | running | completed | steered | aborted | stopped | error`
/// （subagents/src/types.ts:174；`steered` = 被转向之后正常收尾，照样带结果），
/// **从来不存在 `"done"`**。Helix 下游只认三个词：`completed` / `failed` /
/// `running` —— 前端 `subagent.complete` 按「非 failed 即成功」画卡，磁盘委派日志
/// （delegations）与非后台工具返回路径（本文件 6509 附近）写的也是这三个。
/// 所以别处一律比 `"completed"`，不要再引入第四个词。
fn normalize_subagent_status(raw: &str) -> &'static str {
    match raw {
        "error" | "stopped" | "aborted" => "failed",
        "queued" | "running" => "running",
        // 扩展目前只会用 completed / steered 收尾；将来它新增别的终态词，
        // 也按终态成功处理（与前端「非 failed 即成功」的画法一致）。
        // 未知词打成 running 反而更糟：卡片会被回退成永久转圈。
        _ => "completed",
    }
}

/// Translate pi events into the Helix event surface the frontend consumes.
/// Every event is stamped with THIS instance's session id — the frontend's
/// run loop filters by session id, so parallel conversations only see their
/// own events.
fn emit_pi_event(instance: &Arc<PiInstance>, event_type: &str, message: &Value) {
    // 回合闸门（见 `PiInstance::arm_turn_gate`）：上一回合被中止过，它的尾巴事件带
    // 的是**同一个 session id**，前端按 sid 过滤分不出来 ⇒ 在本回合自己的
    // `agent_start` 到达之前，一律不把内容事件转出去。
    // `agent_settled` 不在这里吞：它在自己的分支里带上下文判定（见该分支）。
    if event_type == "agent_start" {
        instance.release_turn_gate();
        return;
    }
    if instance.turn_gate_active()
        && matches!(
            event_type,
            "message_update"
                | "tool_execution_start"
                | "tool_execution_update"
                | "tool_execution_end"
        )
    {
        eprintln!("[pi agent] turn gate swallowed event: {event_type}");
        return;
    }
    let sid = || instance.current_session_id();
    match event_type {
        "message_end" => {
            // pi's message_end carries the COMPLETE final message object —
            // the authoritative text/thinking, byte-perfect from the model.
            // text_delta streaming is the only text path today; when that
            // stream is lost (or the provider never streams), the frontend
            // ends the run with an empty buffer and shows "no visible
            // content". Cache it here; agent_settled attaches it to
            // session/complete as a self-heal fallback.
            if let Some(msg) = message.get("message") {
                if msg.get("role").and_then(Value::as_str) == Some("assistant") {
                    let mut text_parts: Vec<&str> = Vec::new();
                    let mut thinking_parts: Vec<&str> = Vec::new();
                    if let Some(blocks) = msg.get("content").and_then(Value::as_array) {
                        for block in blocks {
                            match block.get("type").and_then(Value::as_str) {
                                Some("text") => {
                                    if let Some(t) = block.get("text").and_then(Value::as_str) {
                                        text_parts.push(t);
                                    }
                                }
                                Some("thinking") => {
                                    if let Some(t) = block.get("thinking").and_then(Value::as_str) {
                                        thinking_parts.push(t);
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    *instance.last_assistant_text.lock().unwrap() = text_parts.join("");
                    *instance.last_assistant_thinking.lock().unwrap() = thinking_parts.join("");
                    // 回合以模型错误收尾（stopReason=error，如上游 400）时，错误
                    // 只写在 pi 的消息记录里（errorMessage），不流任何正文。缓存它，
                    // agent_settled 时作为 fatal error 事件转发给前端；正常消息清掉
                    // 上一回合残留，避免跨回合串错误。
                    let stop_reason = msg.get("stopReason").and_then(Value::as_str).unwrap_or_default();
                    let error_message = msg
                        .get("errorMessage")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    // Authoritative per-message bill. `message_end` fires
                    // exactly once per assistant message and is the only event
                    // that carries the real `model` / `provider`, so it is the
                    // correct—and only correct—source for per-model usage
                    // attribution. Billing from `message_update` instead meant
                    // (a) every assistant message counted once per content block
                    // (2.7–3.4x inflation) and (b) everything was filed under
                    // the GLOBAL default model, because the streaming event has
                    // no model field, so sessions running an overridden model
                    // showed their tokens on the wrong row.
                    let msg_model = msg
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let msg_provider = msg
                        .get("provider")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    if let Some(usage) = msg.get("usage") {
                        emit_usage(
                            instance,
                            usage,
                            msg_model.as_deref(),
                            msg_provider.as_deref(),
                            true,
                        );
                    }
                    if stop_reason == "error" && !error_message.is_empty() {
                        *instance.last_assistant_error.lock().unwrap() = error_message;
                    } else {
                        instance.last_assistant_error.lock().unwrap().clear();
                    }
                }
            }
        }
        // pi-subagents terminal lifecycle: the extension persists each
        // finished child via pi.appendEntry("subagents:record", {id, type,
        // description, status, result, error, …}) — the ONLY completion
        // signal that survives RPC mode (its subagents:completed event-bus
        // emission has no RPC stdout bridge). Runs may outlive the parent
        // tool call (background agents), so gate on the child's own status,
        // never on the parent's tool return.
        "entry_appended" => {
            let entry = message.get("entry").cloned().unwrap_or(Value::Null);
            if entry.get("type").and_then(Value::as_str) == Some("custom")
                && entry.get("customType").and_then(Value::as_str) == Some("subagents:record")
            {
                let data = entry.get("data").cloned().unwrap_or(Value::Null);
                let agent_id = data
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if agent_id.is_empty() {
                    return;
                }
                let raw_status = data
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                // 收敛到 Helix 侧的三个词（completed / failed / running），
                // 判据全部比这三个，见 `normalize_subagent_status`。
                let status = normalize_subagent_status(&raw_status).to_string();
                let summary = data
                    .get("result")
                    .and_then(Value::as_str)
                    .or_else(|| data.get("error").and_then(Value::as_str))
                    .unwrap_or_default()
                    .to_string();

                // Match the record to its parent Agent tool call.
                let mut subagents = instance.subagents.lock().unwrap();
                let matched = subagents
                    .iter()
                    .find(|(_, rec)| rec.agent_id == agent_id)
                    .map(|(tool_call_id, _)| tool_call_id.clone());
                let Some(tool_call_id) = matched else {
                    // No parent tool call seen (scheduler / RPC spawn / child
                    // of a nested agent) — key the card by the agent id so it
                    // still shows up in the live panel.
                    let tool_call_id = agent_id.clone();
                    subagents.insert(
                        tool_call_id.clone(),
                        SubAgentRecord {
                            agent_id: agent_id.clone(),
                            prompt: String::new(),
                            tool_returned: true,
                            status: Some(status.clone()),
                            injected: false,
                        },
                    );
                    drop(subagents);
                    if status == "running" {
                        emit_helix_event(
                            "subagent.start",
                            &json!({
                                "session_id": sid(),
                                "subagent_id": tool_call_id,
                                "goal": data.get("description").and_then(Value::as_str)
                                    .unwrap_or("执行子任务"),
                                "model": data.get("type").and_then(Value::as_str)
                                    .unwrap_or_default(),
                                "text": "",
                            }),
                        );
                    } else {
                        emit_helix_event(
                            "subagent.complete",
                            &json!({
                                "session_id": sid(),
                                "subagent_id": tool_call_id,
                                "status": status,
                                "summary": summary,
                            }),
                        );
                    }
                    return;
                };
                let rec = subagents.get_mut(&tool_call_id).unwrap();
                if status == "running" {
                    // Not terminal after all (resume re-arms the record) —
                    // flip back to running on the frontend card. Re-carry the
                    // cached prompt (the record's terminal payload has none).
                    let rec_prompt = rec.prompt.clone();
                    rec.status = None;
                    drop(subagents);
                    emit_helix_event(
                        "subagent.start",
                        &json!({
                            "session_id": sid(),
                            "subagent_id": tool_call_id,
                            "goal": data.get("description").and_then(Value::as_str)
                                .unwrap_or("执行子任务"),
                            "model": data.get("type").and_then(Value::as_str)
                                .unwrap_or_default(),
                            "text": rec_prompt,
                        }),
                    );
                    return;
                }
                rec.status = Some(status.clone());
                let tool_returned = rec.tool_returned;
                let rec_prompt = rec.prompt.clone();
                let rec_goal = data.get("description").and_then(Value::as_str)
                    .unwrap_or("执行子任务").to_string();
                drop(subagents);
                // Persist the child's own id to the disk manifest — terminal
                // records are the last chance to learn it for foreground
                // children whose tool result carried no agentId.
                crate::delegations::record_delegation_agent_id(&tool_call_id, &agent_id);
                // Terminal record → also finish the disk journal (background
                // children whose parent tool returned long before).
                let dir = crate::delegations::delegation_live_root().join(&tool_call_id);
                if dir.is_dir() {
                    crate::delegations::persist_delegation_prompt(&dir, &rec_prompt);
                    crate::delegations::mark_delegation_finished(&dir, &status, &summary);
                }
                // Auto-return the child's successful result to the parent
                // session: when the parent is idle and the child finished
                // successfully, queue a follow-up prompt carrying the summary
                // so the parent tells the user about it (report-only — the text
                // explicitly forbids resuming the old task). Gated on the
                // normalized terminal status (`normalize_subagent_status` —
                // 扩展从不报 "done"，此前这里比 "done" 等于门永远关着),
                // the parent being idle (no in-flight
                // turn), the instance still live, and a one-shot guard so a
                // resume/re-arm can't re-inject.
                if status == "completed"
                    && !summary.is_empty()
                    && instance.initialized.load(Ordering::SeqCst)
                    && !instance.streaming.load(Ordering::SeqCst)
                    && instance.turn_waiter.lock().unwrap().is_none()
                {
                    // Claim the one-shot guard before dispatching. `rec` still
                    // borrows the map lock we just dropped, so re-lock briefly
                    // to flip it; if a re-arm already reset the record to
                    // running, the guards above would have skipped this anyway.
                    let already_injected = {
                        let mut subs = instance.subagents.lock().unwrap();
                        if let Some(r) = subs.get_mut(&tool_call_id) {
                            if r.injected {
                                true
                            } else {
                                r.injected = true;
                                false
                            }
                        } else {
                            true
                        }
                    };
                    if !already_injected {
                        let summary_text: String = if summary.chars().count() > 8000 {
                            format!(
                                "{}…[结果过长已截断]",
                                summary.chars().take(8000).collect::<String>()
                            )
                        } else {
                            summary.clone()
                        };
                        let goal = rec_goal.clone();
                        let instance_clone = Arc::clone(instance);
                        let agent_id_clone = agent_id.clone();
                        // 这里跑在 reader 裸线程上（`thread::spawn`，无 Tokio 上下文），
                        // `tokio::task::spawn` 会 panic 并把读线程一起带走 ⇒ pi 写 stdout
                        // 拿到 EPIPE 直接崩。必须用 Tauri 的全局运行时派发。
                        tauri::async_runtime::spawn(async move {
                            // 这段文本会以 user 角色进入会话，模型把它当成"用户刚说的话"。
                            // 原来结尾那句「请基于此结果继续」读起来就是一条新指令 ——
                            // 后台子 agent 一交付，父会话自己开一轮把旧任务接着干完
                            // （用户视角：我什么都没点，它又在跑刚才的事）。所以这里必须
                            // ① 声明来源是系统转达、不是用户；② 把动作收窄到"转达结果"。
                            // 前缀同时是界面识别符：src/lib/session-resync.ts 的
                            // GATEWAY_NOTE_PREFIX 靠它把这条 user 记录从重开后的转录里
                            // 剔除（否则系统转达会显示成「用户说的话」）——改前缀要两边一起改。
                            let inject_text = format!(
                                "【系统转达，非用户指令】你此前派发的子 agent「{goal}」已完成，结果如下：\n\
                                 {summary_text}\n\
                                 请只用一到三句话把这条结果转达给用户，然后结束本轮。\
                                 不要据此继续执行之前的任务，也不要开始任何新操作；\
                                 若结果明显还需要后续动作，只列出建议，等用户明确指示后再做。"
                            );
                            // Fire-and-forget queued prompt: register turn debt so
                            // the resulting agent_settled consumes the debt instead
                            // of fabricating a session/complete for a user turn.
                            instance_clone.begin_debt_turn();
                            let first = instance_clone
                                .request("prompt", json!({ "message": inject_text }), RPC_TIMEOUT)
                                .await;
                            if let Err(e) = first {
                                // 上面的空闲检查与这条 prompt 之间，用户可能刚好发出下一句。
                                // 这时绝不能走「中止旧回合重发」（那是给用户交互发送用的），
                                // 也绝不能降级成 steer —— 结果排到用户那一轮之后再自成新一轮。
                                let busy = e.contains("already processing");
                                let retried = if busy {
                                    instance_clone
                                        .request(
                                            "prompt",
                                            json!({
                                                "message": inject_text,
                                                "streamingBehavior": "followUp"
                                            }),
                                            RPC_TIMEOUT,
                                        )
                                        .await
                                } else {
                                    Err(e)
                                };
                                if let Err(e) = retried {
                                    eprintln!(
                                        "[pi agent] subagent auto-inject failed for {agent_id_clone}: {e}"
                                    );
                                    instance_clone.end_debt_turn();
                                }
                            }
                        });
                    }
                }
                if tool_returned {
                    // Parent tool call already returned — the card is still
                    // "running" waiting for this exact moment.
                    let payload = json!({
                        "session_id": sid(),
                        "subagent_id": tool_call_id,
                        "status": status,
                        "summary": summary,
                        "goal": rec_goal,
                        "prompt": rec_prompt,
                    });
                    emit_helix_event("subagent.complete", &payload);
                } else {
                    // Terminal record arrived before the parent Agent tool
                    // returned (foreground run completing fast): let the
                    // tool_execution_end handler emit the completion so the
                    // card order matches the transcript order.
                }
            }
            // pi-subagents 扩展把子 agent 的工具活动写成 subagents:tool 记录
            // （与 subagents:record 同机制——RPC/electron 模式下只有写进父会话
            // 文件的记录能穿透到网关）。转发给前端，子 agent 卡片据此显示真实
            // 工具调用，而不是一直"等待第一个工具调用…"。归属优先按子 agent
            // 真实 id 精确匹配（后台运行 Agent 工具返回 background 时 record.
            // agent_id 已更新）；前台运行尚未返回时按"仍在运行中的子 agent"
            // （!tool_returned）归属。
            if entry.get("type").and_then(Value::as_str) == Some("custom")
                && entry.get("customType").and_then(Value::as_str) == Some("subagents:tool")
            {
                let data = entry.get("data").cloned().unwrap_or(Value::Null);
                let agent_id = data
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let tool_name = data
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let status = data
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("running")
                    .to_string();
                if agent_id.is_empty() || tool_name.is_empty() {
                    return;
                }
                let matched = {
                    let subagents = instance.subagents.lock().unwrap();
                    subagents
                        .iter()
                        .find(|(_, rec)| rec.agent_id == agent_id)
                        .or_else(|| subagents.iter().find(|(_, rec)| !rec.tool_returned))
                        .map(|(tool_call_id, _)| tool_call_id.clone())
                };
                if let Some(tool_call_id) = matched {
                    emit_helix_event(
                        "subagent.tool",
                        &json!({
                            "session_id": sid(),
                            "subagent_id": tool_call_id,
                            "tool_name": tool_name,
                            "tool_preview": tool_name,
                            "status": status,
                        }),
                    );
                }
            }
        }
        "message_update" => {
            let delta = message
                .get("assistantMessageEvent")
                .cloned()
                .unwrap_or(Value::Null);
            let delta_type = delta
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match delta_type {
                "text_delta" => {
                    let text = delta.get("delta").cloned().unwrap_or(Value::Null);
                    emit_helix_event(
                        "session/update",
                        &json!({
                        "session_id": sid(),
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": text,
                        },
                        }),
                    );
                }
                "thinking_delta" => {
                    let text = delta.get("delta").cloned().unwrap_or(Value::Null);
                    emit_helix_event(
                        "session/update",
                        &json!({
                        "session_id": sid(),
                        "update": {
                            "sessionUpdate": "agent_thought_chunk",
                            "content": text,
                        },
                        }),
                    );
                }
                "toolcall_start" => {
                    let tool_call_id = delta
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_default();
                    let tool_name = delta
                        .get("toolName")
                        .and_then(Value::as_str)
                        .unwrap_or("tool");
                    instance
                        .tool_args
                        .lock()
                        .unwrap()
                        .insert(tool_call_id.clone(), String::new());
                    emit_helix_event(
                        "session/update",
                        &json!({
                        "session_id": sid(),
                        "update": {
                            "sessionUpdate": "tool_call",
                            "toolCallId": tool_call_id,
                            "title": tool_name,
                            "kind": "tool",
                            "rawInput": Value::Null,
                        },
                        }),
                    );
                }
                "toolcall_delta" => {
                    let tool_call_id = delta.get("id").and_then(Value::as_str).unwrap_or_default();
                    if let Some(args_delta) = delta.get("delta").and_then(Value::as_str) {
                        let mut args = instance.tool_args.lock().unwrap();
                        args.entry(tool_call_id.to_string())
                            .or_default()
                            .push_str(args_delta);
                    }
                }
                "toolcall_end" => {
                    let tool_call = delta.get("toolCall").cloned().unwrap_or(Value::Null);
                    let tool_call_id = tool_call
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_default();
                    let raw_input = tool_call
                        .get("arguments")
                        .cloned()
                        .or_else(|| {
                            instance
                                .tool_args
                                .lock()
                                .unwrap()
                                .remove(&tool_call_id)
                                .map(|args| {
                                    serde_json::from_str(&args).unwrap_or(Value::String(args))
                                })
                        })
                        .unwrap_or(Value::Null);
                    if !tool_call_id.is_empty() {
                        // write 的 diff 只能由网关事后合成（pi 的 write 结果里没有
                        // diff，只有一句 "Successfully wrote to …"），合成依赖两样
                        // 在 **工具执行前** 拿到的东西：完整 args（path + content）和
                        // 覆盖前的旧内容。原来这两样只在 `tool_execution_start` 里抓，
                        // 那个事件一旦缺失/迟到，write 卡片就永远没有 diff（实测症状：
                        // 卡片里只剩一整篇「要写入的内容」预览）。`toolcall_end` 已经
                        // 带着完整 arguments 而且必然早于执行 —— 在这里也备一份兜底。
                        let call_name = tool_call
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if (call_name == "write" || call_name == "edit")
                            && raw_input.is_object()
                            && !instance
                                .exec_tool_args
                                .lock()
                                .unwrap()
                                .contains_key(&tool_call_id)
                        {
                            instance
                                .exec_tool_args
                                .lock()
                                .unwrap()
                                .insert(tool_call_id.clone(), raw_input.clone());
                            if call_name == "write" {
                                if let Some(path) = arg_path(&raw_input) {
                                    let prior = read_prior_file_content(instance, path);
                                    instance
                                        .exec_file_prior
                                        .lock()
                                        .unwrap()
                                        .entry(tool_call_id.clone())
                                        .or_insert(prior);
                                }
                            }
                        }
                        emit_helix_event(
                            "session/update",
                            &json!({
                            "session_id": sid(),
                            "update": {
                                "sessionUpdate": "tool_call_update",
                                "toolCallId": tool_call_id,
                                "status": "in_progress",
                                "rawInput": raw_input,
                            },
                            }),
                        );
                    }
                }
                _ => {}
            }
            // Per-message usage snapshot → context ring. NOT a billing event:
            // pi's top-level `usage` is cumulative for the whole assistant
            // response and re-arrives on every content-block end, so billing it
            // here counted the same tokens 2–3x per message. `final: false`
            // tells the frontend to refresh the ring only. The authoritative
            // per-message bill comes from `message_end` below.
            if let Some(usage) = message.get("usage") {
                if matches!(delta_type, "text_end" | "thinking_end" | "toolcall_end")
                {
                    let model = instance.current_model.lock().unwrap().clone();
                    let provider = instance.current_provider.lock().unwrap().clone();
                    emit_usage(
                        instance,
                        usage,
                        model.as_deref(),
                        provider.as_deref(),
                        false,
                    );
                }
            }
        }
        "tool_execution_start" => {
            // 非嵌套调用是本会话的串行工具链（推理见 evict_settled_permission_asks）：
            // 走到这里，此前收到的审批弹窗都已决。嵌套调用（带 parentToolCallId）
            // 可能并发跑钩子，跳过。
            let nested = message
                .get("parentToolCallId")
                .and_then(Value::as_str)
                .is_some_and(|p| !p.is_empty());
            if !nested {
                evict_settled_permission_asks(instance, "tool_started");
            }
            let tool_call_id = message
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_default();
            let tool_name = message
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let args = message.get("args").cloned().unwrap_or(Value::Null);
            if !tool_call_id.is_empty() {
                if !nested {
                    // 这条调用马上就要进 prepareToolCall（审批弹窗在它里面跑）。
                    *instance.preparing_tool.lock().unwrap() =
                        Some(tool_call_id.clone());
                }
                if args.is_object() {
                    instance
                        .exec_tool_args
                        .lock()
                        .unwrap()
                        .insert(tool_call_id.clone(), args.clone());
                }
                // write 会整体覆盖文件，而它的 result 不带 diff → 趁现在（工具还
                // 没跑）把旧状态读下来，tool_execution_end 才能算出真 diff、撤销
                // 才有安全的反推依据。edit 自带 details.diff/patch，不需要。
                if tool_name == "write" {
                    if let Some(path) = arg_path(&args) {
                        let prior = read_prior_file_content(instance, path);
                        instance
                            .exec_file_prior
                            .lock()
                            .unwrap()
                            .insert(tool_call_id.clone(), prior);
                    }
                }
                instance
                    .executing_tools
                    .lock()
                    .unwrap()
                    .insert(tool_call_id.clone());
                emit_helix_event(
                    "session/update",
                    &json!({
                        "session_id": sid(),
                        "update": {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": tool_call_id,
                            "toolName": tool_name,
                            "status": "in_progress",
                            "rawInput": args,
                        },
                    }),
                );
                // Forward real tool calls to the running sub-agent's card so
                // the dropdown shows activity instead of "等待第一个工具调用…".
                // Only attribute to sub-agents for foreground (synchronous)
                // runs where tool_returned is still false — background runs
                // let the parent continue, making attribution ambiguous.
                if tool_name != "Agent" && !tool_call_id.is_empty() {
                    let subagents = instance.subagents.lock().unwrap();
                    if let Some((sa_id, _)) = subagents.iter().find(|(_, rec)| !rec.tool_returned) {
                        let sa_id = sa_id.clone();
                        drop(subagents);
                        emit_helix_event(
                            "subagent.tool",
                            &json!({
                                "session_id": sid(),
                                "subagent_id": sa_id,
                                "tool_name": tool_name,
                                "tool_preview": args.get("command")
                                    .or_else(|| args.get("query"))
                                    .or_else(|| args.get("path"))
                                    .and_then(Value::as_str)
                                    .unwrap_or(tool_name),
                            }),
                        );
                    }
                }
            }
            // Plan-mode extension (@narumitw/pi-plan-mode): the model calls
            // plan_mode_complete to hand its decision-ready plan to the UI.
            // Surface it as a first-class Helix event so the renderer can
            // raise its 计划审批 bar with the real plan artifact (args.plan),
            // instead of guessing from the final chat text.
            if tool_name == "plan_mode_complete" {
                let plan = args.get("plan").and_then(Value::as_str).unwrap_or_default();
                if !plan.is_empty() {
                    emit_helix_event(
                        "session/update",
                        &json!({
                            "session_id": sid(),
                            "update": {
                                "sessionUpdate": "plan_complete",
                                "plan": plan,
                            },
                        }),
                    );
                }
            }
            // pi-subagents extension: the `Agent` tool spawns a sub-agent.
            // Register the tool-call → agent-id mapping so later lifecycle
            // events can be attributed, but DON'T emit subagent.start here:
            // the in-flight tool card already shows this call, and a separate
            // card would duplicate it. `tool_execution_update`/`_end` and the
            // extension's own lifecycle events drive the sub-agent card.
            if tool_name == "Agent" && !tool_call_id.is_empty() {
                let goal = args
                    .get("description")
                    .and_then(Value::as_str)
                    .or_else(|| args.get("prompt").and_then(Value::as_str))
                    .unwrap_or("执行子任务");
                let model = args
                    .get("subagent_type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let prompt = args
                    .get("prompt")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                // A resumption of an existing child carries no new goal — the
                // frontend already has the card from the original spawn.
                let is_resume = args.get("resume").and_then(Value::as_str).is_some();
                if !is_resume {
                    emit_helix_event(
                        "subagent.start",
                        &json!({
                            "session_id": sid(),
                            "subagent_id": tool_call_id,
                            "goal": goal,
                            "model": model,
                            "prompt": prompt,
                            "text": prompt,
                        }),
                    );
                    // Cache the child's full prompt on the in-memory record:
                    // the terminal subagents:record carries no prompt, so a
                    // later re-emitted subagent.start can only recover it
                    // from here.
                    instance
                        .subagents
                        .lock()
                        .unwrap()
                        .entry(tool_call_id.clone())
                        .or_insert_with(|| SubAgentRecord {
                            agent_id: tool_call_id.clone(),
                            prompt: prompt.to_string(),
                            tool_returned: false,
                            status: None,
                            injected: false,
                        })
                        .prompt = prompt.to_string();
                    // Mirror the legacy delegate_task disk contract so the
                    // 子Agent 历史记录 (delegations_list) sees this child too.
                    if let Some(dir) = crate::delegations::ensure_delegation_dir(
                        &tool_call_id,
                        &sid().as_str().map(str::to_string).unwrap_or_default(),
                        goal,
                    ) {
                        crate::delegations::persist_delegation_prompt(&dir, &prompt);
                        crate::delegations::append_delegation_log(
                            &dir,
                            &format!("[start] {model} — {goal}"),
                        );
                    }
                }
            }
        }
        "tool_execution_update" => {
            // 执行期事件只在各调用的 prepare（竞速弹窗所在阶段）返回后发出
            // ——走到这里，此前收到的审批弹窗都已决（推理见
            // evict_settled_permission_asks）。嵌套调用（带 parentToolCallId）
            // 保守跳过。
            let nested = message
                .get("parentToolCallId")
                .and_then(Value::as_str)
                .is_some_and(|p| !p.is_empty());
            if !nested {
                evict_settled_permission_asks(instance, "tool_running");
            }
            let tool_call_id = message
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_default();
            let tool_name = message
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let partial = message
                .pointer("/partialResult/content")
                .cloned()
                .unwrap_or(Value::Null);
            if !tool_call_id.is_empty() {
                emit_helix_event(
                    "session/update",
                    &json!({
                        "session_id": sid(),
                        "update": {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": tool_call_id,
                            "status": "in_progress",
                            "content": content_to_text(&partial),
                        },
                    }),
                );
            }
            // pi-subagents `Agent` tool: forward its streamed progress note
            // ("N tool uses…", activity line) as subagent.tool so the live
            // sub-agent card updates while the child runs. These are
            // cumulative summaries, NOT individual tool calls — emit them as
            // `progress` rows and let the frontend update the LAST row
            // in place instead of appending a new one per note. A real
            // tool-call row (from `subagent.tool` with a real tool_name)
            // that arrives between two notes must NOT be clobbered: the
            // frontend checks `lastRow.toolName === "progress"` before
            // swapping, so real rows keep their position and the summary
            // rides above the last real row, mirroring the transcript's
            // "N tools used" footer.
            if tool_name == "Agent" && !tool_call_id.is_empty() {
                // Early agent-id binding: the extension's streamUpdate carries
                // details.agentId (added for this purpose). Recording it NOW —
                // while the child is still running — lets the live panel map
                // the card to the child's .output transcript via subagent_map
                // before the tool call returns (previously the mapping only
                // existed at tool_execution_end, so a foreground run showed
                // "正在启动，等待第一个工具调用…" for its whole lifetime).
                let partial_agent_id = message
                    .pointer("/partialResult/details/agentId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(agent_id) = partial_agent_id.filter(|a| !a.is_empty()) {
                    let mut subagents = instance.subagents.lock().unwrap();
                    // The exec_args cache holds this call's full args — keep
                    // the child's prompt here so terminal re-arms can re-carry
                    // it (a record created only by this early binding has none).
                    let cached_prompt = instance
                        .exec_tool_args
                        .lock()
                        .unwrap()
                        .get(&tool_call_id)
                        .and_then(|a| a.get("prompt"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let rec = subagents
                        .entry(tool_call_id.clone())
                        .or_insert_with(|| SubAgentRecord {
                            agent_id: agent_id.clone(),
                            prompt: cached_prompt.clone(),
                            tool_returned: false,
                            status: None,
                            injected: false,
                        });
                    if rec.agent_id != agent_id {
                        rec.agent_id = agent_id.clone();
                    }
                    if rec.prompt.is_empty() {
                        rec.prompt = cached_prompt;
                    }
                    drop(subagents);
                    crate::delegations::record_delegation_agent_id(&tool_call_id, &agent_id);
                }
                let preview = content_to_text(&partial);
                if let Some(text) = preview.as_str() {
                    if !text.is_empty() {
                        // agent_id rides along so the renderer can bind the
                        // card to the child's transcript on the FIRST progress
                        // note (foreground runs previously had no binding until
                        // the tool returned — the live panel showed nothing).
                        let bound_agent_id = instance
                            .subagents
                            .lock()
                            .unwrap()
                            .get(&tool_call_id)
                            .map(|r| r.agent_id.clone());
                        let mut payload = json!({
                            "session_id": sid(),
                            "subagent_id": tool_call_id,
                            "tool_name": "progress",
                            "tool_preview": text,
                        });
                        if let Some(aid) = bound_agent_id {
                            payload["agent_id"] = json!(aid);
                        }
                        emit_helix_event("subagent.tool", &payload);
                        let dir = crate::delegations::delegation_live_root().join(&tool_call_id);
                        if dir.is_dir() {
                            crate::delegations::append_delegation_log(&dir, text);
                        }
                    }
                }
            }
        }
        "tool_execution_end" => {
            // 同 tool_execution_update：执行期事件 = prepare 已返回，此前收到的
            // 审批弹窗都已决。嵌套调用保守跳过。
            let nested = message
                .get("parentToolCallId")
                .and_then(Value::as_str)
                .is_some_and(|p| !p.is_empty());
            if !nested {
                evict_settled_permission_asks(instance, "tool_finished");
            }
            let tool_call_id = message
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_default();
            let tool_name = message
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            // 它已经跑完，不再是「可能还卡在 prepare 里」的那条了。
            {
                let mut preparing = instance.preparing_tool.lock().unwrap();
                if preparing.as_deref() == Some(tool_call_id.as_str()) {
                    *preparing = None;
                }
            }
            let is_error = message
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let content = content_to_text(
                &message
                    .pointer("/result/content")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            // pi 的 edit/write 类工具把变更信息放在 result.details（edit 的
            // details.diff / details.patch 是真正的统一 diff；content 只是一句
            // "Successfully replaced N block(s)"）。前端 +N −n 徽标按 diff 文本
            // 统计，不转发 details 时编辑类卡片永远不出统计。details 里其余
            // 大字段（图片 base64 等）不转，只挑 diff 类字段，且各截 16KB。
            let exec_args = instance
                .exec_tool_args
                .lock()
                .unwrap()
                .remove(&tool_call_id)
                .unwrap_or(Value::Null);
            // write 覆盖前的旧状态（execution_start 抓的）——同样只取一次，防泄漏。
            //   NewFile    = 当时文件不存在（新建）
            //   Text(_)    = 读到了可逐行 diff 的旧文本
            //   Bytes{..}  = 读到字节但不可 diff（>2MB / 非 UTF-8），带 SHA-256
            //   Unreadable = 字节都读不到
            //   None       = 没抓到（不是 write，或 execution_start 没走到）
            let prior_entry: Option<PriorFile> =
                instance.exec_file_prior.lock().unwrap().remove(&tool_call_id);
            // 只有真出 diff 的工具才转发 diff 类 details：edit 工具 result
            // 自带 details.diff / details.patch；write 工具（全新文件无
            // details）用 execution_start 缓存的 args 在网关侧合成。
            // 其它工具（bash/ls/grep…）的 result.details 是各自的业务字段
            // （truncation、tasks、agentId、memory output 等），按字段名硬捞
            // diff/patch 会把任意工具的任意 payload 当成 diff 喂给前端
            // （如 ls 触发 +N 徽标 / DiffView 误着色），白名单外直接不给。
            let is_diff_tool = tool_name == "edit" || tool_name == "write";
            // 这个 details 里只要出现被截断的 diff，就必须同时标 undoUnsafe —— 截断
            // 后的 diff 反推不出原文件，前端拿它撤销会写坏文件。
            let mut truncated_diff = false;
            let diff_details: Value = {
                let mut picked = serde_json::Map::new();
                if is_diff_tool {
                    if let Some(details) = message
                        .pointer("/result/details")
                        .and_then(Value::as_object)
                    {
                        for key in [
                            "diff",
                            "patch",
                            "firstChangedLine",
                            "diffSummary",
                            "changes",
                        ] {
                            // 只接受文本形态的 diff 字段：非字符串（对象/数组）
                            // 进前端会走 JSON.stringify 拼进结果文本，形态彻底跑偏。
                            if let Some(Value::String(v)) = details.get(key) {
                                if v.len() > MAX_DIFF_BYTES && key != "firstChangedLine" {
                                    truncated_diff = true;
                                }
                                picked.insert(key.to_string(), Value::String(truncate_diff(v.clone())));
                            }
                        }
                    }
                }
                // pi 的 write 工具 result 完全没有 details（源码实测 `details:void 0`），
                // 前端 write 卡片出不了 +N −n。用 execution_start 缓存的 args（path +
                // content）**加上那一刻抓到的旧状态**在网关侧合成真 diff。
                if picked.is_empty() && tool_name == "write" && !is_error {
                    // 诊断（每次 write 一行）：写入 diff 的合成链有四环——有没有
                    // args（来自 execution_start / toolcall_end）、有没有 content、
                    // 覆盖前抓到什么、最终走哪条分支。任何一环断掉症状都是"写入卡片
                    // 没有 diff"，这行日志直接指出是哪一环。
                    log_spawn_diag(&format!(
                        "write-diff: id={} args={} content={} prior={}",
                        tool_call_id,
                        if arg_path(&exec_args).is_some() { "有" } else { "缺" },
                        if exec_args.get("content").and_then(Value::as_str).is_some() { "有" } else { "缺" },
                        match &prior_entry {
                            None => "未抓取",
                            Some(PriorFile::NewFile) => "不存在(新建)",
                            Some(PriorFile::Text(_)) => "读到文本",
                            Some(PriorFile::Bytes { .. }) => "读到字节(不可 diff)",
                            Some(PriorFile::Unreadable) => "读不到字节",
                        }
                    ));
                    if let Some(path) = arg_path(&exec_args) {
                        if let Some(text) = exec_args.get("content").and_then(Value::as_str) {
                            // 能逐行 diff 的旧文本：只有 Text 有。NewFile 的 None 是
                            // 故意的（按空文件算）；Bytes / Unreadable 走下面两条分支。
                            let new_file =
                                matches!(prior_entry.as_ref(), Some(PriorFile::NewFile));
                            let prior_text: Option<&str> = match prior_entry.as_ref() {
                                Some(PriorFile::Text(s)) => Some(s.as_str()),
                                _ => None,
                            };
                            match prior_entry.as_ref() {
                                // 新建 / 读到旧文本 → 能算出真 diff。
                                Some(PriorFile::NewFile | PriorFile::Text(_)) => {
                                    match write_unified_diff(path, prior_text, text, new_file) {
                                        Some(patch) => {
                                            if patch.len() > MAX_DIFF_BYTES {
                                                truncated_diff = true;
                                            }
                                            log_spawn_diag(&format!(
                                                "write-diff: id={} → patch {} 字节（可撤销）",
                                                tool_call_id,
                                                patch.len()
                                            ));
                                            picked.insert(
                                                "patch".to_string(),
                                                Value::String(truncate_diff(patch)),
                                            );
                                        }
                                        // 内容与旧文件完全一致：这次 write 什么都没改，
                                        // 不该出现在「已修改」里。
                                        None => {
                                            log_spawn_diag(&format!(
                                                "write-diff: id={} → 内容与旧文件一致，不登记",
                                                tool_call_id
                                            ));
                                        }
                                    }
                                }
                                // 读到字节但没法逐行 diff（>2MB / 非 UTF-8）：有指纹，
                                // 比一比就知道是不是原样重写 —— 相等就是纯 no-op，
                                // 什么都不登记（"其实没改却显示修改"的最后一格）。
                                Some(PriorFile::Bytes { len, sha, .. }) => {
                                    // 原样重写 = 字节数相同且指纹相同。字节数不同就直接
                                    // 判定"改动了"，不必再算指纹。
                                    let identical = if text.len() != *len {
                                        false
                                    } else {
                                        let mut hasher = Sha256::new();
                                        hasher.update(text.as_bytes());
                                        hex::encode(hasher.finalize()).as_str()
                                            == sha.as_str()
                                    };
                                    if identical {
                                        log_spawn_diag(&format!(
                                            "write-diff: id={} → 字节与原文件一致（原样重写），不登记",
                                            tool_call_id
                                        ));
                                    } else {
                                        // 真改动了，但没有旧内容可逐行 diff —— 不给
                                        // patch（按空文件假想会谎报"整文件新增"），
                                        // 前端凭 `path` + `undoUnsafe` 仍会列出这个
                                        // 文件，只是没有 +N −N、不可反推撤销。
                                        log_spawn_diag(&format!(
                                            "write-diff: id={} → 已改动但无法逐行 diff（undoUnsafe）",
                                            tool_call_id
                                        ));
                                        picked.insert(
                                            "undoUnsafe".to_string(),
                                            Value::Bool(true),
                                        );
                                    }
                                }
                                // 字节都读不到（相对路径无 cwd / 权限 / I/O）：什么都
                                // 判断不了，只能按"改过了但撤销不安全"处理，交给本轮
                                // 快照兜底。
                                Some(PriorFile::Unreadable) | None => {
                                    log_spawn_diag(&format!(
                                        "write-diff: id={} → 覆盖前旧内容不可读，不合成 diff（undoUnsafe）",
                                        tool_call_id
                                    ));
                                    picked.insert("undoUnsafe".to_string(), Value::Bool(true));
                                }
                            }
                        }
                    }
                }
                // 文件身份的**权威来源**：工具参数里的目标路径。前端「已修改」
                // 卡片用它决定"这次改了哪个文件"，不再从 diff 文本里猜——推断
                // 曾把 diff 正文里的注释 `// 布局：chat → panel → …` 当成标签行，
                // 解析出"文件" `布局：chat`，卡片里凭空多出一个模型从没生成过
                // 的文件。edit/write 的参数名都是 `path`（arg_path 兼容别名）。
                if is_diff_tool {
                    if let Some(p) = arg_path(&exec_args) {
                        if !p.is_empty() {
                            picked.insert("path".to_string(), Value::String(p.to_string()));
                        }
                    }
                }
                if truncated_diff {
                    picked.insert("undoUnsafe".to_string(), Value::Bool(true));
                }
                Value::Object(picked)
            };
            if !tool_call_id.is_empty() {
                instance
                    .executing_tools
                    .lock()
                    .unwrap()
                    .remove(&tool_call_id);
                emit_helix_event(
                    "session/update",
                    &json!({
                        "session_id": sid(),
                        "update": {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": tool_call_id,
                            "toolName": tool_name,
                            "status": if is_error { "failed" } else { "completed" },
                            "content": content,
                            "details": diff_details,
                        },
                    }),
                );
                // Forward completed tool calls to the running sub-agent's card.
                if tool_name != "Agent" && !tool_call_id.is_empty() {
                    let subagents = instance.subagents.lock().unwrap();
                    if let Some((sa_id, _)) = subagents.iter().find(|(_, rec)| !rec.tool_returned) {
                        let sa_id = sa_id.clone();
                        drop(subagents);
                        emit_helix_event(
                            "subagent.tool",
                            &json!({
                                "session_id": sid(),
                                "subagent_id": sa_id,
                                "tool_name": tool_name,
                                "tool_preview": content.as_str().unwrap_or_default(),
                                "status": if is_error { "error" } else { "success" },
                            }),
                        );
                    }
                }
            }
            // pi-subagents `Agent` tool result. TWO shapes arrive here:
            //  - details.status == "background": the tool returned "Agent
            //    started in background. Agent ID: …" while the child keeps
            //    running. Record the tool_call_id → agent_id mapping and keep
            //    the frontend card RUNNING — the extension's terminal
            //    lifecycle event completes it.
            //  - anything else (foreground run): the child really finished;
            //    complete the card with the result text.
            if tool_name == "Agent" && !tool_call_id.is_empty() {
                let details = message.pointer("/result/details");
                let agent_id = details
                    .and_then(|d| d.get("agentId"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| tool_call_id.clone());
                let record_status = details
                    .and_then(|d| d.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let mut subagents = instance.subagents.lock().unwrap();
                // This call's full prompt lives in the exec_args cache —
                // re-carry it into the record so a terminal completion that
                // outlives the tool return can still surface it.
                let cached_prompt = instance
                    .exec_tool_args
                    .lock()
                    .unwrap()
                    .get(&tool_call_id)
                    .and_then(|a| a.get("prompt"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let record =
                    subagents
                        .entry(tool_call_id.clone())
                        .or_insert_with(|| SubAgentRecord {
                            agent_id: agent_id.clone(),
                            prompt: cached_prompt.clone(),
                            tool_returned: false,
                            status: None,
                            injected: false,
                        });
                if record.agent_id != agent_id {
                    record.agent_id = agent_id.clone();
                }
                if record.prompt.is_empty() {
                    record.prompt = cached_prompt;
                }
                let summary = content.as_str().unwrap_or_default().trim().to_string();
                let rec_prompt = record.prompt.clone();
                let rec_goal = instance
                    .exec_tool_args
                    .lock()
                    .unwrap()
                    .get(&tool_call_id)
                    .and_then(|a| a.get("description"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let mut completed_status: Option<String> = None;
                if record_status == "background" {
                    record.tool_returned = true;
                    // The extension just revealed the child's own id — persist
                    // it to the disk manifest so the timeline stays locatable
                    // after a gateway restart kills every in-memory route.
                    crate::delegations::record_delegation_agent_id(&tool_call_id, &agent_id);
                    if record.status.is_none() {
                        // Still running in the background — surface the start
                        // acknowledgement as a progress line on the live card
                        // instead of a (wrong) completion. agent_id rides along
                        // so the renderer can bind the card to the child's
                        // .output transcript (subagent_timeline) without the
                        // in-memory mapping table.
                        drop(subagents);
                        if !summary.is_empty() {
                            emit_helix_event(
                                "subagent.tool",
                                &json!({
                                    "session_id": sid(),
                                    "subagent_id": tool_call_id,
                                    "agent_id": agent_id,
                                    "tool_name": "background",
                                    "tool_preview": summary,
                                }),
                            );
                        }
                    } else {
                        // Terminal lifecycle event already arrived before the
                        // parent tool returned — emit the buffered completion
                        // (status from the entry record, summary from the
                        // tool result, which is the same child outcome).
                        let status = record.status.clone().unwrap_or_else(|| "completed".into());
                        completed_status = Some(status.clone());
                        drop(subagents);
                        let payload = json!({
                            "session_id": sid(),
                            "subagent_id": tool_call_id,
                            "status": status,
                            "summary": summary,
                            "goal": rec_goal.unwrap_or_else(|| "执行子任务".to_string()),
                            "prompt": rec_prompt,
                        });
                        emit_helix_event("subagent.complete", &payload);
                    }
                } else {
                    // Foreground (synchronous) Agent call — the child's real
                    // result is the tool result; complete the card now. Prefer
                    // the terminal entry record's status when it beat the tool
                    // return here (some failures return non-error text).
                    record.tool_returned = true;
                    let final_status = record.status.clone().unwrap_or_else(|| {
                        if is_error {
                            "failed".into()
                        } else {
                            "completed".into()
                        }
                    });
                    record.status = Some(final_status.clone());
                    completed_status = Some(final_status.clone());
                    drop(subagents);
                    let payload = json!({
                        "session_id": sid(),
                        "subagent_id": tool_call_id,
                        "status": final_status,
                        "summary": summary,
                        "goal": rec_goal.unwrap_or_else(|| "执行子任务".to_string()),
                        "prompt": rec_prompt,
                    });
                    emit_helix_event("subagent.complete", &payload);
                }
                // Journal the outcome to the legacy delegation layout (only
                // terminal outcomes — a background start leaves the manifest
                // "running" for the child's own terminal event to finish).
                if let Some(status) = completed_status {
                    crate::delegations::record_delegation_agent_id(&tool_call_id, &agent_id);
                    let dir = crate::delegations::delegation_live_root().join(&tool_call_id);
                    if dir.is_dir() {
                        crate::delegations::persist_delegation_prompt(&dir, &rec_prompt);
                        crate::delegations::mark_delegation_finished(&dir, &status, &summary);
                    }
                }
            }
        }
        "agent_settled" => {
            // Turn 结束 ⇒ 不存在未返回的工具钩子：仍挂着的审批弹窗都是竞速
            // 输掉的僵尸（也覆盖「停止」残局），作废它们。
            evict_settled_permission_asks(instance, "turn_settled");
            // 闸门还开着 ⇒ 这条 settle 属于**刚被中止的上一回合**（本回合自己的
            // `agent_start` 会先开门）。它绝不能去释放下一条消息刚注册的
            // turn_waiter，也不能发 session/complete —— 那会让新回合带着空正文收场
            //（"输出消失"）。旧回合到此为止，闸门顺手开门。
            if instance.turn_gate_active() {
                instance.sync_streaming_flag();
                instance.release_turn_gate();
                return;
            }
            // Turn (including queued steering/follow-ups) fully settled →
            // release the in-flight session/prompt waiter.
            let cancelled = instance.turn_cancelled.swap(false, Ordering::SeqCst);
            // A settle still owed by a fire-and-forget turn (seed history,
            // /plan arm) belongs to THAT turn, not to session/prompt's —
            // consume the debt and leave the real turn's waiter armed
            // (the real turn is still queued/running behind it).
            if instance.turn_debt.load(Ordering::SeqCst) > 0 {
                // 旗子按事实落不落：这一条 settle 属于旁路回合，用户那一轮的 waiter
                // 还挂着 ⇒ 实例仍在忙（写死 false 会让 reaper 有权 kill 正在跑的子进程）。
                instance.end_debt_turn();
                return;
            }
            // Only a turn initiated by session/prompt registers a waiter.
            // Seed turns (session/new history replay, fire-and-forget) settle
            // with NO waiter — forwarding their settle as session/complete
            // would fabricate a `done` for a run whose real prompt is still
            // queued behind the seed, ending the view early ("输出消失").
            let had_waiter = instance.turn_waiter.lock().unwrap().is_some();
            instance.streaming.store(false, Ordering::SeqCst);
            if had_waiter && !cancelled {
                // 回合以模型错误收尾（message_end 的 stopReason=error）时，先把
                // 真实错误作为终止性 error 事件发出去（前端 fatal 分支渲染成
                // "⚠️ …" 正文并抑制后续空 done 的兜底文案），再照常发
                // session/complete 兜底——即使 error 事件丢失，前端也只是回到
                // 旧的"未返回任何可见内容"行为，不会更糟。
                let fatal_error =
                    std::mem::take(&mut *instance.last_assistant_error.lock().unwrap());
                if !fatal_error.is_empty() {
                    emit_helix_event(
                        "error",
                        &json!({
                            "session_id": sid(),
                            "message": fatal_error,
                            "fatal": true,
                        }),
                    );
                }
                // Attach the authoritative final text/thinking captured at
                // message_end. The frontend prefers its streamed buffer when
                // non-empty and only falls back to these — so a healthy
                // stream is unaffected, but a lost/nonexistent text_delta
                // stream still completes with the full reply instead of
                // "no visible content".
                let final_text = std::mem::take(&mut *instance.last_assistant_text.lock().unwrap());
                let final_thinking =
                    std::mem::take(&mut *instance.last_assistant_thinking.lock().unwrap());
                emit_helix_event(
                    "session/complete",
                    &json!({
                        "session_id": sid(),
                        "content": final_text,
                        "reasoning": final_thinking,
                    }),
                );
                // 人不在前台时的收尾信号：出错优先报错，否则报完成（摘要取正文开头）。
                if !fatal_error.is_empty() {
                    crate::desktop_notify::notify(
                        crate::desktop_notify::Scene::TurnEnd,
                        "任务出错",
                        &fatal_error,
                    );
                } else if !final_text.is_empty() {
                    crate::desktop_notify::notify(
                        crate::desktop_notify::Scene::TurnEnd,
                        "任务完成",
                        &final_text,
                    );
                } else {
                    crate::desktop_notify::notify(
                        crate::desktop_notify::Scene::TurnEnd,
                        "任务完成",
                        "回合已结束",
                    );
                }
            }
            // Settle the waiter. The guard must be DROPPED before calling
            // w.tx.send() — send() can block on tokio runtime contention,
            // and holding the guard across it wedges kill()'s turn_waiter
            // lock (deadlock at startup).
            let waiter = {
                let mut guard = instance.turn_waiter.lock().unwrap();
                let w = guard.take();
                drop(guard);
                w
            };
            if let Some(w) = waiter {
                let _ = w.tx.send(if cancelled {
                    json!({ "cancelled": true })
                } else {
                    json!({ "type": "agent_settled" })
                });
            }
        }
        "auto_retry_start" => {
            let message_text = message
                .get("errorMessage")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let attempt = message.get("attempt").and_then(Value::as_u64).unwrap_or(1);
            let total = message
                .get("maxAttempts")
                .and_then(Value::as_u64)
                .unwrap_or(5);
            emit_helix_event(
                "model/retry",
                &json!({
                    "session_id": sid(),
                    "attempt": attempt,
                    "total": total,
                    "message": message_text,
                    "raw": message,
                }),
            );
        }
        "auto_retry_end" => {
            if message.get("success").and_then(Value::as_bool) != Some(true) {
                let final_error = message
                    .get("finalError")
                    .and_then(Value::as_str)
                    .unwrap_or("pi auto-retry exhausted");
                emit_helix_event(
                    "error",
                    &json!({
                        "session_id": sid(),
                        "message": final_error,
                        // 重试耗尽 = 回合终止性失败，前端直接渲染错误正文
                        "fatal": true,
                        "raw": message,
                    }),
                );
            } else {
                // 成功也必须发：之前只在失败时发，前端的重试提示一旦亮起来
                // 就没人把它关掉（用户看到的是「重试中」永远挂在头上）。
                emit_helix_event(
                    "model/retry",
                    &json!({
                        "session_id": sid(),
                        "success": true,
                        "raw": message,
                    }),
                );
            }
        }
        "extension_error" => {
            let error = message
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("extension error");
            emit_helix_event(
                "model/warning",
                &json!({
                    "session_id": sid(),
                    "message": error,
                    "raw": message,
                }),
            );
        }
        "extension_ui_request" => {
            let request_id = message
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_default();
            let ui_method = message
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default();
            // 审批/反问链路的**到达点**留痕。pi 的 ui 请求是阻塞式的：扩展在等
            // 回应，而前端一旦没把卡片显示出来（订阅者缺席、归属判错、事件在半路
            // 被丢），事后从 UI 上完全看不出请求到过网关。release 构建没有 stderr，
            // 这条 `~/.pi/agent/helix-recover.log` 就是唯一凭据 —— 配上
            // evict_settled_permission_asks 的作废留痕，能区分「网关没收到」
            // 「收到了但前端没显示」「收到了但被竞速作废」三种失败形态。
            log_spawn_diag(&format!(
                "ui_request sid={} method={} id={}",
                sid(),
                ui_method,
                request_id
            ));
            match ui_method {
                // confirm = a yes/no gate → keep the approval dialog path
                // (Helix's ApprovalDialog maps choice to confirmed/denied).
                "confirm" => {
                    instance.ui_requests.lock().unwrap().insert(
                        request_id.clone(),
                        PendingUI {
                            method: ui_method.to_string(),
                            permission: false,
                            // confirm 是命令式门禁（subagents 的「Overwrite/Delete
                            // agent」这类），不是工具 prepare 里的审批，挡不住任何
                            // toolCall ⇒ 不记，否则会把别人的工具计时挪错。
                            blocking_tool: None,
                        },
                    );
                    UI_REQUEST_OWNERS.lock().unwrap().insert(
                        request_id.clone(),
                        instance
                            .current_session
                            .lock()
                            .unwrap()
                            .clone()
                            .unwrap_or_else(|| instance.key()),
                    );
                    let title = message
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or(ui_method);
                    emit_helix_event(
                        "session/update",
                        &json!({
                            "session_id": sid(),
                            "update": {
                                "sessionUpdate": "permission_request",
                                "toolCallId": request_id,
                                "toolName": ui_method,
                                "title": title,
                                "params": message,
                            },
                        }),
                    );
                    crate::desktop_notify::notify(
                        crate::desktop_notify::Scene::Approval,
                        "需要确认",
                        &dialog_toast_body(title),
                    );
                }
                // select/input/editor = free-form user interaction → the
                // clarify bar (bottom floating input with optional choices),
                // answered via clarify/respond. Routing these through
                // permission_request loses the answer value (approve could
                // not pick an option), which hung the extension forever.
                "select" | "input" | "editor" => {
                    // pi-permission 的竞速审批弹窗在这里打标记：只有它会被
                    // 自动作废（见 evict_settled_permission_asks）。其它 select
                    // 是真正的用户交互，永不自动关。
                    let permission = is_permission_ui_request(
                        ui_method,
                        message.get("title").and_then(Value::as_str),
                    );
                    if permission {
                        // pi-permission 的竞速审批弹窗：它带 approvalTimeoutSec
                        // （默认 300s），到点扩展侧 fail-closed 自动拒绝。用户
                        // 看到的「工具跑了 4 分多钟自己拒了、弹窗根本没出现」
                        // 就是这条请求没有被前端认领 —— 单独留痕便于和
                        // evict_permission_asks / 前端的 enqueue 日志对齐时间线。
                        log_spawn_diag(&format!(
                            "permission_ask sid={} id={}",
                            sid(),
                            request_id
                        ));
                    }
                    // 只有 pi-permission 的审批弹窗真的挡在某个工具调用的 prepare
                    // 里；其它 select/input/editor 是模型在等用户回答
                    // （ask_user_question 那一类），「等用户」就是那件活本身，
                    // 挪计时等于把真实耗时抹掉。先取再锁 ui_requests，不套锁。
                    let blocking_tool = if permission {
                        instance.preparing_tool.lock().unwrap().clone()
                    } else {
                        None
                    };
                    instance.ui_requests.lock().unwrap().insert(
                        request_id.clone(),
                        PendingUI {
                            method: ui_method.to_string(),
                            permission,
                            blocking_tool,
                        },
                    );
                    UI_REQUEST_OWNERS.lock().unwrap().insert(
                        request_id.clone(),
                        instance
                            .current_session
                            .lock()
                            .unwrap()
                            .clone()
                            .unwrap_or_else(|| instance.key()),
                    );
                    let question = message
                        .get("title")
                        .and_then(Value::as_str)
                        .or_else(|| message.get("message").and_then(Value::as_str))
                        .or_else(|| message.get("placeholder").and_then(Value::as_str))
                        .unwrap_or("请输入");
                    let choices: Vec<&str> = message
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|opts| opts.iter().filter_map(|o| o.as_str()).collect::<Vec<_>>())
                        .unwrap_or_default();
                    // editor prefills the answer box with the text to edit.
                    let prefill = message.get("prefill").and_then(Value::as_str).unwrap_or("");
                    // 审批卡附带超时秒数（与扩展侧 withFailClosedTimeout 读同一份
                    // settings.json），前端卡片用它渲染倒计时；非审批卡为 null（不适用）。
                    let approval_timeout = if permission {
                        json!(crate::approval_policy::read_approval_timeout_sec())
                    } else {
                        Value::Null
                    };
                    emit_helix_event(
                        "session/update",
                        &json!({
                            "session_id": sid(),
                            "update": {
                                "sessionUpdate": "clarify_request",
                                "requestId": request_id,
                                "question": question,
                                "choices": if choices.is_empty() { Value::Null } else { json!(choices) },
                                "prefill": prefill,
                                "approvalTimeoutSec": approval_timeout,
                                "params": message,
                            },
                        }),
                    );
                    let (scene, toast_title) = if permission {
                        (crate::desktop_notify::Scene::Approval, "需要审批")
                    } else {
                        (crate::desktop_notify::Scene::Clarify, "需要你的回答")
                    };
                    crate::desktop_notify::notify(scene, toast_title, &dialog_toast_body(&question));
                }
                // 已知的 fire-and-forget 方法（不阻塞模型）：surface as warning。
                "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" | "status" => {
                    let msg = message
                        .get("message")
                        .or_else(|| message.get("statusText"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if msg.is_empty() {
                        return;
                    }
                    // `/context` 探针进行中（见 `pi_context_report_parts`）：形状
                    // 像报告的 notify 行进探针缓冲，不再当前端 warning 弹出去。
                    // 别的扩展的 notify 照旧转发，测试期间的通知一条不吞。
                    if ui_method == "notify" {
                        let mut probe = instance.context_probe.lock().unwrap();
                        if let Some(buf) = probe.as_mut() {
                            let is_report = msg
                                .lines()
                                .filter(|l| !l.trim().is_empty())
                                .all(|l| parse_pi_context_line(l).is_some());
                            if is_report {
                                buf.extend(msg.lines().map(str::to_string));
                            }
                            return;
                        }
                    }
                    emit_helix_event(
                        "model/warning",
                        &json!({ "session_id": sid(), "message": msg, "raw": message }),
                    );
                }
                // 其余未列出的方法（如 ask_user_question 的 ui.custom）都是
                // **交互型**：模型在等用户输入，属 Pending Work。路由成
                // clarify_request，让前端计数 pending 并弹浮条，避免 90s idle
                // 误判 done（"ask_user_question 之后模型被判定完成"根因）。
                _ => {
                    instance.ui_requests.lock().unwrap().insert(
                        request_id.clone(),
                        PendingUI {
                            method: ui_method.to_string(),
                            permission: false,
                            blocking_tool: None,
                        },
                    );
                    UI_REQUEST_OWNERS.lock().unwrap().insert(
                        request_id.clone(),
                        instance
                            .current_session
                            .lock()
                            .unwrap()
                            .clone()
                            .unwrap_or_else(|| instance.key()),
                    );
                    let question = message
                        .get("title")
                        .and_then(Value::as_str)
                        .or_else(|| message.get("message").and_then(Value::as_str))
                        .or_else(|| message.get("placeholder").and_then(Value::as_str))
                        .unwrap_or("请输入");
                    let choices: Vec<&str> = message
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|opts| opts.iter().filter_map(|o| o.as_str()).collect::<Vec<_>>())
                        .unwrap_or_default();
                    emit_helix_event(
                        "session/update",
                        &json!({
                            "session_id": sid(),
                            "update": {
                                "sessionUpdate": "clarify_request",
                                "requestId": request_id,
                                "question": question,
                                "choices": if choices.is_empty() { Value::Null } else { json!(choices) },
                                "params": message,
                            },
                        }),
                    );
                    crate::desktop_notify::notify(
                        crate::desktop_notify::Scene::Clarify,
                        "需要你的回答",
                        &dialog_toast_body(&question),
                    );
                }
            }
        }
        // pi 的 in-run 自动压缩：`_runAutoCompaction` 夹在两次 assistant 调用
        // 之间，本身就是一次完整的 LLM 摘要调用，期间主事件流零帧。这两帧必须
        // 落到前端 —— 前端的空闲检测把「已出内容 + 事件流静默」当成终结帧丢失
        // 并合成 done，而 done 会退订事件流，于是压缩完继续输出的那一轮没人接
        //（「压缩上下文后要手动继续」根因）。同一窗口也让本侧的 `stream_wedged`
        // 让路，否则大上下文在 300s 就被中止回合。
        "compaction_start" | "compaction_end" => {
            if event_type == "compaction_start" {
                instance
                    .compaction_guard_until_ms
                    .store(now_ms() + COMPACTION_GUARD_MS, Ordering::SeqCst);
            } else {
                instance.compaction_guard_until_ms.store(0, Ordering::SeqCst);
            }
            emit_helix_event(
                "session/update",
                &json!({
                    "session_id": sid(),
                    "update": {
                        "sessionUpdate": event_type,
                        "reason": message.get("reason").cloned().unwrap_or(Value::Null),
                        "aborted": message.get("aborted").cloned().unwrap_or(Value::Null),
                        "willRetry": message.get("willRetry").cloned().unwrap_or(Value::Null),
                        "error": message.get("errorMessage").cloned().unwrap_or(Value::Null),
                        "beforeTokens": message
                            .pointer("/result/tokensBefore")
                            .cloned()
                            .unwrap_or(Value::Null),
                        "afterTokens": message
                            .pointer("/result/estimatedTokensAfter")
                            .cloned()
                            .unwrap_or(Value::Null),
                    },
                }),
            );
        }
        // queue_update：排队中的 steer / follow_up 队列变了。这两个队列只由 RPC
        // 的 steer / follow_up 命令填充（用户手动输入不走这里，忙时发 prompt
        // 会撞 already processing）。整份队列都在 payload 里，前端订阅它就不
        // 需要轮询 get_state。
        "queue_update" => {
            let steering = message
                .get("steering")
                .and_then(Value::as_array)
                .map(|a| a.len())
                .unwrap_or(0);
            let follow_up = message
                .get("followUp")
                .and_then(Value::as_array)
                .map(|a| a.len())
                .unwrap_or(0);
            emit_helix_event(
                "session/update",
                &json!({
                    "session_id": sid(),
                    "update": {
                        "sessionUpdate": "queue_update",
                        "steeringCount": steering,
                        "followUpCount": follow_up,
                        "pendingCount": steering + follow_up,
                        "steering": message.get("steering").cloned().unwrap_or(Value::Array(vec![])),
                        "followUp": message.get("followUp").cloned().unwrap_or(Value::Array(vec![])),
                    },
                }),
            );
        }
        // bash_execution_update：直接 bash RPC 执行时的实时输出流。
        // 转成 session/update 让前端能显示「正在执行……」而不是等到结束才冒结果。
        "bash_execution_update" => {
            emit_helix_event(
                "session/update",
                &json!({
                    "session_id": sid(),
                    "update": {
                        "sessionUpdate": "bash_execution_update",
                        "id": message.get("id").cloned().unwrap_or(Value::Null),
                        "delta": message.get("delta").cloned().unwrap_or(Value::Null),
                        "raw": message,
                    },
                }),
            );
        }
        // Pass-through / ignore: agent_start, turn_start/end, message_start/end,
        // summarization_retry_*.
        _ => {}
    }
}

/// Flatten pi content blocks (`[{type:"text",text},...]`) to displayable text.
fn content_to_text(content: &Value) -> Value {
    match content {
        Value::Array(blocks) => Value::String(
            blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(""),
        ),
        Value::String(s) => Value::String(s.clone()),
        _ => Value::Null,
    }
}

/// One `usage:prompt-complete` notification.
///
/// Two sources, deliberately distinguished by `final_report`:
///
/// - `message_update` (`final_report = false`): pi's top-level `usage` is the
///   **cumulative** usage of the assistant response *so far* (docs/json.md), and
///   it re-arrives on every `text_end` / `thinking_end` / `toolcall_end`. These
///   events exist to keep the context ring live; the frontend must NOT bill them
///   — billing the same figure once per content block inflated the daily
///   per-model totals by 2.7–3.4x.
/// - `message_end` (`final_report = true`): the authoritative final message.
///   Fires exactly once per assistant message and carries `model` / `provider`,
///   so it is the only correct source for per-model billing attribution.
fn emit_usage(
    instance: &Arc<PiInstance>,
    usage: &Value,
    model: Option<&str>,
    provider: Option<&str>,
    final_report: bool,
) {
    if usage.is_null() {
        return;
    }
    let input = usage.get("input").and_then(Value::as_i64).unwrap_or(0);
    let output = usage.get("output").and_then(Value::as_i64).unwrap_or(0);
    let cache_read = usage.get("cacheRead").and_then(Value::as_i64).unwrap_or(0);
    let cache_write = usage.get("cacheWrite").and_then(Value::as_i64).unwrap_or(0);
    let total = usage
        .get("totalTokens")
        .and_then(Value::as_i64)
        .unwrap_or(input + output + cache_read + cache_write);
    // pi's providers report `input` as the net (uncached) token count —
    // cacheRead/cacheWrite are separate fields. Cache tokens still occupy the
    // context window, so context usage must use pi's own calculateContextTokens
    // basis (`totalTokens || input+output+cacheRead+cacheWrite`). `input+output`
    // alone badly under-reports cached sessions (cacheRead is often 80%+ of the
    // real context).
    // 分母：本会话自己那个模型的窗口（见 PiInstance::context_max）。全局默认
    // 模型只作最后兜底 —— 以前它排第一，会话级模型覆盖的窗口因此被无视。
    let context_max = instance.context_max(None);
    // pi's last-reported totalTokens under-counts a cached/long session — it is
    // a single request's usage, not what the NEXT prompt will replay. Take the
    // jsonl active-branch estimate (same basis as context_breakdown) so the ring
    // stays honest instead of being washed back down on every message_update.
    // Carry the per-kind buckets too (as `categories` in the usage payload) so
    // the frontend's snapshot writes real breakdowns instead of the aggregate
    // "会话上下文" lump, which made the panel's label set appear to change on
    // its own.
    let (jsonl_estimate, jsonl_categories, jsonl_anchor) =
        jsonl_active_branch_estimate(instance);
    let context_used = total.max(jsonl_estimate).max(jsonl_anchor);
    // Remember the REAL per-call figure (not the estimate) so restore paths can
    // floor their estimate-only numbers with it.
    instance.set_last_context_used(total);
    let context_percent = if context_max > 0 {
        (context_used as f64 / context_max as f64) * 100.0
    } else {
        0.0
    };
    let mut categories: Value = Value::Array(Vec::new());
    if jsonl_estimate > 0 {
        if let Some(cats) = jsonl_categories {
            categories = cats;
        }
    }
    if context_used > 0 && categories == Value::Array(Vec::new()) {
        categories = json!({
            "id": "conversation",
            "label": "整体上下文占用",
            "tokens": context_used,
            "color": "var(--context-usage-conversation)",
            "aggregate": true,
        });
    }
    // `at_ms` lets the frontend bucket the spend under the EVENT's day instead
    // of the write-time day — a reply that lands after midnight used to be
    // filed under the new day even though most of its tokens were generated
    // before it.
    emit_helix_event(
        "usage:prompt-complete",
        &json!({
            "usage": {
                "totalTokens": total,
                "inputTokens": input,
                "outputTokens": output,
                "cachedReadTokens": cache_read,
                "cachedWriteTokens": cache_write,
                "context_max": context_max,
                "context_used": context_used,
                "context_percent": context_percent,
                "categories": categories,
                "final": final_report,
            },
            "model": model,
            "provider": provider,
            "at_ms": now_ms(),
            "session_id": instance.current_session_id(),
            "raw": usage,
        }),
    );
}

/// Locate the pi CLI's bundled cli.js + the node that runs it. Never goes
/// through `pi.cmd`: CreateProcess would spawn cmd.exe as OUR child and node
/// as cmd's grandchild — `child.kill()` then kills only the cmd wrapper and
/// leaks the node/pi process. A leaked pi holds the memory extension's
/// SQLite lock and
/// makes every later spawn block on it ("process exited" cascades).
///
/// Resolution order:
///  0. an explicit override — `HELIX_PI_CLI` (dev escape hatch) or
///     `pi.cli_path` in config.yaml (persistent). This is how Helix runs a
///     local pi fork instead of the npm-installed upstream package, and it is
///     the ONLY way to keep the gateway working after the npm package is
///     uninstalled;
///  1. `<data_dir>/npm/node_modules/.../cli.js` (npm global prefix);
///  2. any `pi.cmd` / `pi` shim on PATH — parse it for its cli.js path
///     (same file npm's shim invokes) and run that under node directly.
/// A `pi.cmd`-style shim references the SAME install as (1), so (2) is a
/// different npm prefix (or none found) only in exotic setups.
#[cfg(windows)]
fn resolve_pi_cli() -> Option<(PathBuf, PathBuf, &'static str)> {
    if let Some(hit) = pi_cli_override() {
        return Some(hit);
    }
    // 1. npm global prefix under the data dir. On Windows npm's default
    // global prefix lives in %APPDATA%\npm (Roaming), not %LOCALAPPDATA%\npm,
    // so probe both (and the generic data_dir) before falling back to PATH.
    for candidate in npm_global_prefixes() {
        let cli_js = candidate.join("node_modules").join("@earendil-works/pi-coding-agent").join("dist/bundle/cli.js");
        if cli_js.is_file() {
            return Some((pi_node(&candidate), cli_js, "npm-global"));
        }
    }
    // 2. Walk PATH for a pi shim; read the cli.js path out of it.
    let path_env = std::env::var("PATH").ok()?;
    for dir in path_env.split(';').filter(|s| !s.is_empty()) {
        for shim in ["pi.cmd", "pi"] {
            let shim_path = PathBuf::from(dir).join(shim);
            let Ok(content) = std::fs::read_to_string(&shim_path) else {
                continue;
            };
            // npm shims embed the cli.js invocation verbatim, e.g.
            //   "%dp0%\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js"
            // ($dp0 = shim's own dir). Take the first quoted .js path.
            let Some(idx) = content.find(".js\"") else {
                continue;
            };
            let before = content[..idx].rfind('"')? + 1;
            let rel = &content[before..idx + 3]; // includes ".js
            let rel = rel
                .trim_start_matches("%dp0%\\")
                .trim_start_matches("%dp0%/")
                .replace('\\', "/");
            let cli_js = PathBuf::from(dir).join(rel);
            if cli_js.is_file() {
                return Some((pi_node(&PathBuf::from(dir)), cli_js, "path-shim"));
            }
        }
    }
    None
}

/// Trim an env/config supplied path: whitespace and one layer of quotes
/// (Windows users paste `"D:\path\cli.js"` straight out of Explorer).
fn clean_override_path(raw: &str) -> String {
    let t = raw.trim();
    let t = t.strip_prefix('"').unwrap_or(t);
    let t = t.strip_suffix('"').unwrap_or(t);
    t.trim().to_string()
}

/// `pi.cli_path` / `pi.node_path` from config.yaml (Helix data dir). Read with
/// the same hand-rolled block parser the `vision:` block uses — config.yaml is
/// deliberately never parsed with a real YAML library.
fn pi_cli_from_config() -> Option<(PathBuf, Option<PathBuf>)> {
    let read = |key: &str| -> Option<String> {
        let yaml = std::fs::read_to_string(crate::config::config_yaml_path()).ok()?;
        let block = crate::config::read_yaml_block(&yaml, "pi");
        let v = clean_override_path(block.get(key)?.as_str()?);
        if v.is_empty() {
            None
        } else {
            Some(v)
        }
    };
    let cli = PathBuf::from(read("cli_path")?);
    if !cli.is_file() {
        return None;
    }
    Some((cli, read("node_path").map(PathBuf::from)))
}

/// The explicit pi CLI override, highest priority in `resolve_pi_cli`.
/// Returns `(node, cli_js, source)`. Source is only used for the spawn log.
///
/// A configured-but-missing path does NOT hard-fail: it is logged and the
/// normal npm/PATH discovery runs instead, so a typo can never brick the
/// gateway — the spawn log line always names the source actually used, which
/// is what makes the fallback visible rather than silent.
fn pi_cli_override() -> Option<(PathBuf, PathBuf, &'static str)> {
    if let Ok(raw) = std::env::var("HELIX_PI_CLI") {
        let cli = clean_override_path(&raw);
        if !cli.is_empty() {
            let cli = PathBuf::from(cli);
            if cli.is_file() {
                let node = std::env::var("HELIX_PI_NODE")
                    .ok()
                    .map(|v| clean_override_path(&v))
                    .filter(|v| !v.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("node"));
                return Some((node, cli, "env:HELIX_PI_CLI"));
            }
            log_spawn_diag(&format!(
                "pi_cli_override: HELIX_PI_CLI={} is not a file, falling through",
                raw
            ));
        }
    }
    match pi_cli_from_config() {
        Some((cli, node)) => Some((
            node.unwrap_or_else(|| PathBuf::from("node")),
            cli,
            "config:pi.cli_path",
        )),
        None => None,
    }
}

/// Candidate npm global prefix dirs: %APPDATA%/npm (npm's actual default on
/// Windows) and data_dir/npm as a fallback.
fn npm_global_prefixes() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(dir) = std::env::var("APPDATA") {
        out.push(PathBuf::from(dir).join("npm"));
    }
    if let Some(dir) = dirs::data_dir() {
        out.push(dir.join("npm"));
    }
    out
}

/// The node binary to run pi under: prefer a node.exe sitting next to the
/// install (npm's own shim rule), else PATH's `node`.
#[cfg(windows)]
fn pi_node(install_dir: &PathBuf) -> PathBuf {
    let local = install_dir.join("node.exe");
    if local.is_file() {
        local
    } else {
        PathBuf::from("node")
    }
}

pub fn pi_cli_args() -> (Command, Vec<String>) {
    match resolve_pi_cli() {
        Some((node, cli_js, _source)) => {
            let mut command = Command::new(&node);
            let cli_js = cli_js.to_string_lossy().into_owned();
            command.arg(&cli_js);
            (command, vec![cli_js])
        }
        // Last resort — install unlocatable. Fine for one-shot `pi install`
        // callers; the RPC gateway path never gets here without a prior
        // explicit error (see pi_command).
        None => (Command::new("pi"), vec![]),
    }
}

/// One line naming what the next spawn will actually run, and where that
/// answer came from (`config:pi.cli_path` / `env:HELIX_PI_CLI` /
/// `npm-global` / `path-shim`). Written to the spawn log on every spawn so
/// "which pi am I running?" is never a guessing game again.
pub fn pi_cli_debug_summary() -> String {
    match resolve_pi_cli() {
        Some((node, cli_js, source)) => format!(
            "pi cli = {} [source: {}; node: {}]",
            cli_js.display(),
            source,
            node.display()
        ),
        None => "pi cli = NOT FOUND (tried HELIX_PI_CLI, config.yaml pi.cli_path, \
                 npm global prefix, PATH shim)"
            .to_string(),
    }
}

/// `pi.remote_rpc` from config.yaml — a `host:port` RPC endpoint. When set,
/// every pi instance is reached over TCP instead of being spawned locally.
/// Read with the same hand-rolled `pi:` block parser `pi.cli_path` uses
/// (config.yaml is deliberately never parsed with a real YAML library).
///
/// 典型用法是 SSH 端口转发：
///   ssh -L 18800:127.0.0.1:18800 user@host
///   config.yaml: pi: remote_rpc: "127.0.0.1:18800"
/// 这样 Helix 以为连的是本地端口，实际上对面是远程主机上的 pi（remote-bridge.js）。
fn remote_rpc_endpoint() -> Option<String> {
    let yaml = std::fs::read_to_string(crate::config::config_yaml_path()).ok()?;
    let block = crate::config::read_yaml_block(&yaml, "pi");
    let v = block.get("remote_rpc")?.as_str()?.trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// 远端连续两次 get_state 秒退后进入冷却：冷却期内直接本地 spawn，冷却结束
/// 自动再试远端（远端恢复即自动 re-attach）。兜住「隧道本地监听还活着、但
/// 远端已不可达」的情况——这种时候本地端口连得上，普通「不可达回退」不触发，
/// 会无限重试刷错误。
static REMOTE_DEAD_UNTIL_MS: AtomicU64 = AtomicU64::new(0);

fn mark_remote_down(cooldown_ms: u64) {
    REMOTE_DEAD_UNTIL_MS.store(now_ms() + cooldown_ms, Ordering::SeqCst);
}

fn remote_marked_down() -> bool {
    now_ms() < REMOTE_DEAD_UNTIL_MS.load(Ordering::SeqCst)
}

/// 隧道当前指向的远端项目目录（`pi.remote_cwd`），由远程向导写入。
///
/// 双通道之后它只是**兜底值**：每条远程会话自己的远端目录来自 `remote_cwd`
/// 参数（session/new）或 `REMOTE_SESSIONS` 登记表，只有两者都没有时才用它。
/// 没设就发 "~"（远端 bridge 落到远端 home）；**不要把本地路径发过去**：远端
/// spawn 会 ENOENT，bridge 关掉连接，网关误报「进程死亡」。
fn remote_cwd_override() -> Option<String> {
    let yaml = std::fs::read_to_string(crate::config::config_yaml_path()).ok()?;
    let block = crate::config::read_yaml_block(&yaml, "pi");
    let v = block.get("remote_cwd")?.as_str()?.trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// 会话 id → 该会话的**远端**项目目录。
///
/// 为什么必须落盘：`session/prompt` 只带 session_id，不带 cwd；实例被空闲回收后
/// 重新 spawn 时，网关得能再次判断「这个会话是远程的，目录在远端 `/home/...`」，
/// 否则它会在**本机**把远程会话拉起来 —— 同样的对话，跑到另一台机器、另一个目录
/// 上去。远端绝对路径本身没有可辨识的特征，所以
/// 只能显式记。
///
/// 存在数据目录的 `remote-sessions.json`，与 `workdir.json` 同级。
static REMOTE_SESSIONS: std::sync::LazyLock<Mutex<HashMap<String, String>>> =
    std::sync::LazyLock::new(|| Mutex::new({
        let mut map = HashMap::new();
        if let Some(path) = remote_sessions_path() {
            if let Ok(raw) = std::fs::read_to_string(&path) {
                if let Ok(obj) = serde_json::from_str::<Value>(&raw) {
                    if let Some(m) = obj.as_object() {
                        for (k, v) in m {
                            if let Some(s) = v.as_str() {
                                map.insert(k.clone(), s.to_string());
                            }
                        }
                    }
                }
            }
        }
        map
    }));

fn remote_sessions_path() -> Option<PathBuf> {
    Some(crate::state::user_data_dir()?.join("remote-sessions.json"))
}

fn persist_remote_sessions() {
    let Some(path) = remote_sessions_path() else {
        return;
    };
    let snapshot: Value = {
        let map = REMOTE_SESSIONS.lock().unwrap();
        Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                .collect(),
        )
    };
    let _ = std::fs::write(path, snapshot.to_string());
}

/// 记下「会话 sid 是远程的，目录 = dir」。
fn remember_remote_session_dir(session_id: &str, dir: &str) {
    if session_id.is_empty() || dir.is_empty() {
        return;
    }
    {
        let mut map = REMOTE_SESSIONS.lock().unwrap();
        if map.get(session_id).map(String::as_str) == Some(dir) {
            return;
        }
        map.insert(session_id.to_string(), dir.to_string());
    }
    persist_remote_sessions();
}

/// 这个会话是远程的吗？是则返回它的远端目录。
fn remote_session_dir(session_id: &str) -> Option<String> {
    if session_id.is_empty() {
        return None;
    }
    REMOTE_SESSIONS.lock().unwrap().get(session_id).cloned()
}

/// 本地隧道口探活（`remote/probe` 用）：2s 内 TCP 连上就算可达。
/// 只证明「隧道本地监听在」，不证明远端 pi 活着——后者要一次 RPC 往返，启动
/// 路径等不起。连上之后真出事，随后的 switch_session 会快速报错兜底。
fn remote_endpoint_reachable(endpoint: &str) -> bool {
    use std::net::TcpStream;
    let Ok(mut addrs) = endpoint.to_socket_addrs() else {
        return false;
    };
    let Some(addr) = addrs.next() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok()
}

/// 会话 id → 该会话的 jsonl 在**远端**机器上的绝对路径。
///
/// 为什么必须落盘：`restore_session_instance` 只会找**本机**的会话文件
/// （SESSION_FILES 缓存 + `find_session_file` 扫描 `~/.pi/agent/sessions`），
/// 远程会话的 jsonl 在远端机器上，本机永远扫不到 —— 远程 sid 的 resume 只能
/// 失败，前端退到「本地历史重建」阶梯：新 sid + 截断回放 + 系统注入块，原会话
/// 被分叉遗弃。实例活着时 `stamp_session_from_state` 能从 get_state 拿到这个
/// 路径（pi 报的是它自己那台机器上的绝对路径），但进程重启后内存表全丢，所以在
/// 这里登记一份到磁盘，让远程 resume 直接 switch_session 回原会话。
///
/// 与 `REMOTE_SESSIONS`（sid → 远端 cwd）分开存：那张表回答「是不是远程、在哪个
/// 目录」，这张表回答「jsonl 具体在哪」。没有路径登记的旧会话保持原行为（resume
/// 失败 → 前端重建），不会比现在更坏。
static REMOTE_SESSION_FILES: std::sync::LazyLock<Mutex<HashMap<String, String>>> =
    std::sync::LazyLock::new(|| Mutex::new({
        let mut map = HashMap::new();
        if let Some(path) = remote_session_files_path() {
            if let Ok(raw) = std::fs::read_to_string(&path) {
                if let Ok(obj) = serde_json::from_str::<Value>(&raw) {
                    if let Some(m) = obj.as_object() {
                        for (k, v) in m {
                            if let Some(s) = v.as_str() {
                                if !k.is_empty() && !s.is_empty() {
                                    map.insert(k.clone(), s.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
        map
    }));

fn remote_session_files_path() -> Option<PathBuf> {
    Some(crate::state::user_data_dir()?.join("remote-session-files.json"))
}

fn persist_remote_session_files() {
    let Some(path) = remote_session_files_path() else {
        return;
    };
    let snapshot: Value = {
        let map = REMOTE_SESSION_FILES.lock().unwrap();
        Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                .collect(),
        )
    };
    let _ = std::fs::write(path, snapshot.to_string());
}

/// 记下「这个 sid 的 jsonl 在远端这个路径」。仅远程实例的路径登记调用。
fn remember_remote_session_file(session_id: &str, file: &str) {
    if session_id.is_empty() || file.is_empty() {
        return;
    }
    {
        let mut map = REMOTE_SESSION_FILES.lock().unwrap();
        if map.get(session_id).map(String::as_str) == Some(file) {
            return;
        }
        map.insert(session_id.to_string(), file.to_string());
    }
    persist_remote_session_files();
}

/// 这个 sid 登记过的远端 jsonl 路径（没登记过就返回 None）。
fn remote_session_file(session_id: &str) -> Option<String> {
    if session_id.is_empty() {
        return None;
    }
    REMOTE_SESSION_FILES.lock().unwrap().get(session_id).cloned()
}

/// switch_session 的报错是不是「文件没了」。远端 jsonl 可能被对端清掉（会话
/// 清理 / 换机器），这种永久失败要归一成 `no session file`
/// （session_not_found），前端才会走重建阶梯，而不是卡在可重试的
/// restore_failed 反复失败。
fn looks_like_missing_file(err: &str) -> bool {
    let low = err.to_ascii_lowercase();
    low.contains("enoent")
        || low.contains("no such file")
        || low.contains("cannot read")
        || low.contains("could not read")
        || low.contains("does not exist")
        || low.contains("not found")
}

// ──────────────────────── 审批档作用域解析（给 approval_policy 用） ────────────────────────
//
// settings.json 的 `modeBySession` / `modeByProject` 由 pi-permission 扩展按
// 「pi 报来的 sid / ctx.cwd」解析。Helix 要显示同一条会话的生效档，就得用同一个
// 身份去查表；而这些身份只活在网关（实例表、REMOTE_SESSIONS、jsonl 头）里，
// 所以这里开三个只读小口，绝不 spawn / restore —— 读个档位不该把进程拉起来。

/// 这条会话是远程的吗（跑在远端的 pi 上）？
///
/// 两个来源任一即算：`REMOTE_SESSIONS`（落盘的 per-session 记录，实例被回收后
/// 仍然认得）+ 活实例的 `remote` 标志（前端还没记下目录的极早期窗口）。
pub(crate) fn session_is_remote(session_id: &str) -> bool {
    if session_id.is_empty() {
        return false;
    }
    if remote_session_dir(session_id).is_some() {
        return true;
    }
    INSTANCES
        .lock()
        .unwrap()
        .get(session_id)
        .map(|i| i.remote.load(Ordering::SeqCst))
        .unwrap_or(false)
}

/// 正在跑的实例报告的 cwd（**只查现有实例，不 spawn**）。
pub(crate) fn peek_session_cwd(session_id: &str) -> Option<String> {
    if session_id.is_empty() {
        return None;
    }
    let instance = INSTANCES.lock().unwrap().get(session_id).cloned()?;
    let cwd = instance.cwd.lock().unwrap().clone()?;
    (!cwd.is_empty()).then_some(cwd)
}

/// 会话 jsonl 头里记的 cwd（实例已回收时的来源；O(1)，只读首行）。
pub(crate) fn session_jsonl_cwd(session_id: &str) -> Option<String> {
    let file = find_session_file(session_id)?;
    read_session_cwd(&file)
}

/// `modeBySession` 的条目还算活着吗？—— 本机有 jsonl / 实例还在跑 / 被记为远程
/// 会话，任一即活。三个都不是就说明这条对话已经不在了，覆盖条目可以回收
/// （否则那张表只会随会话数无界增长）。
pub(crate) fn session_override_alive(session_id: &str) -> bool {
    if session_id.is_empty() {
        return false;
    }
    if remote_session_dir(session_id).is_some() {
        return true;
    }
    if INSTANCES.lock().unwrap().contains_key(session_id) {
        return true;
    }
    find_session_file(session_id).is_some()
}

/// 远程传输：连一条 TCP，握手行下发**本实例**的远端 cwd，然后把 socket 拆成读/写两半。
///
/// 读一半、写一半各一个 handle，第三个专给 `ChildHandle::Remote` 做 shutdown。
/// 三者共享同一个 socket，任一个 shutdown 都让另外两个看到 EOF。
///
/// 握手行**不**是协议的一部分 —— pi 的 RPC 是纯 JSONL，任何额外前缀都会
/// 毒掉流。对面（remote-bridge.js）必须读走这一行再开始透传。
///
/// `remote_cwd` 必须是远端机器上的绝对路径（或 `~`）。**绝不能**传本地路径过去：
/// 远端 spawn 会 ENOENT，bridge 关掉连接，网关于是误报「进程死亡」。
fn open_remote_transport(remote_cwd: &str) -> Result<(RpcWrite, RpcRead, TcpStream), String> {
    let endpoint = remote_rpc_endpoint().unwrap_or_default();
    let _addr = endpoint
        .to_socket_addrs()
        .map_err(|e| {
            format!(
                "Failed to resolve remote RPC endpoint {endpoint}: {e} — check \"pi.remote_rpc\" in config.yaml"
            )
        })?
        .next()
        .ok_or_else(|| format!("Failed to resolve remote RPC endpoint {endpoint}"))?;
    let mut stream = TcpStream::connect_timeout(&_addr, Duration::from_secs(10)).map_err(|e| {
        format!(
            "Failed to connect to remote RPC endpoint {endpoint}: {e} — is the ssh -L tunnel and remote-bridge.js running?"
        )
    })?;
    let effective_cwd = if remote_cwd.trim().is_empty() {
        "~".to_string()
    } else {
        remote_cwd.to_string()
    };
    let mut frame = String::from("cwd:");
    frame.push_str(&effective_cwd);
    frame.push('\n');
    stream
        .write_all(frame.as_bytes())
        .map_err(|e| format!("Failed to send remote cwd handshake: {e}"))?;
    stream
        .flush()
        .map_err(|e| format!("Failed to flush remote cwd handshake: {e}"))?;
    let reader = stream
        .try_clone()
        .map_err(|e| format!("Failed to open remote RPC transport: {e}"))?;
    // 第三个 handle 专给 ChildHandle::Remote 用来 shutdown（同一个 socket 的
    // 三个 handle，任一个 shutdown 都让另外两个看到 EOF）。
    let control = stream
        .try_clone()
        .map_err(|e| format!("Failed to open remote RPC transport: {e}"))?;
    Ok((Box::new(stream), Box::new(reader), control))
}

/// pi CLI program + base argv as plain strings, for tokio::process::Command
/// callers in other modules (install/uninstall etc.).
pub fn pi_cli_strings() -> (String, Vec<String>) {
    let (command, base) = pi_cli_args();
    (command.get_program().to_string_lossy().into_owned(), base)
}

/// pi CLI program + `--mode rpc`, plus Helix's built-in browser extension.
///
/// The extension file lives in `~/.pi/agent/helix-internal/` — outside pi's
/// `extensions/` discovery dir — so terminal `pi` runs never see its
/// `browser_*` tools; only processes spawned here load them. Skipped when the
/// installer hasn't written the file yet: pi hard-fails startup on a missing
/// `--extension` path.
fn pi_command() -> Command {
    let (mut command, _base) = pi_cli_args();
    command.arg("--mode").arg("rpc");
    // 项目信任档位：只在这里选 `--approve` 或 `--no-approve`，作用域限在
    // Helix 拉起的 pi 进程，不写 pi 的 `defaultProjectTrust`（后者会把
    // 终端里跑的 pi 也变成自动信任）。
    //
    // 没有第三档「ask/不传 flag」——RPC 模式弹不出交互提示，效果等同
    // `--no-approve`，多留一个选项只会让用户以为「项目 .pi 应该生效」却
    // 看不到提示。要加载项目资源，选 `always`。
    match crate::pi_advanced::configured_project_trust().as_str() {
        "always" => { command.arg("--approve"); }
        _ => { command.arg("--no-approve"); }
    }
    let ext = crate::pi_extensions::browser_extension_path();
    if ext.is_file() {
        command.arg("--extension").arg(ext);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ui(method: &str, permission: bool) -> PendingUI {
        PendingUI {
            method: method.into(),
            permission,
            blocking_tool: None,
        }
    }

    #[test]
    fn pi_context_report_lines_parse_like_the_extension_emits_them() {
        // 实测（pi --mode rpc + /context，pi-cc-extensions 2026-10）：
        // "System prompt: 0 tokens\n...\nTools definition: 9.5k tokens\n...\nFree space: 246k tokens"
        assert_eq!(
            parse_pi_context_line("System prompt: 12.3k tokens"),
            Some(("System prompt".to_string(), 12300))
        );
        assert_eq!(
            parse_pi_context_line("Tool results: 846 tokens"),
            Some(("Tool results".to_string(), 846))
        );
        // >=100k 时 formatTokens 走 Math.round → 整数 k。
        assert_eq!(
            parse_pi_context_line("Free space: 246k tokens"),
            Some(("Free space".to_string(), 246_000))
        );
        // 不是报告行的一律拒（探针靠这个把别的 notify 放回 warning 通道）。
        assert_eq!(parse_pi_context_line("Plan mode"), None);
        assert_eq!(parse_pi_context_line("Done: 3 files"), None);
        assert_eq!(parse_pi_context_line(": 5 tokens"), None);
        assert_eq!(parse_pi_context_line("System prompt: tokens"), None);
    }

    #[test]
    fn permission_marker_recognizes_only_extension_select() {
        assert!(is_permission_ui_request(
            "select",
            Some("[pi-permission] Approval required\nTool: bash")
        ));
        assert!(!is_permission_ui_request("select", Some("模型反问：选一个")));
        assert!(!is_permission_ui_request(
            "select",
            Some("前缀里有 [pi-permission] 但不在开头")
        ));
        assert!(!is_permission_ui_request("input", Some("[pi-permission] x")));
        assert!(!is_permission_ui_request("select", None));
    }

    #[test]
    fn take_permission_asks_removes_only_marked() {
        let mut m = HashMap::new();
        m.insert("a".to_string(), ui("select", true));
        m.insert("b".to_string(), ui("select", false));
        m.insert("c".to_string(), ui("confirm", false));
        let taken = take_permission_asks(&mut m);
        assert_eq!(taken, vec!["a".to_string()]);
        assert!(!m.contains_key("a"));
        assert!(m.contains_key("b") && m.contains_key("c"));
    }

    #[test]
    fn handshake_killed_by_our_own_restart_is_a_retryable_restore_failure() {
        // 文本取自 helix-recover.log 2026-10-12 02:09:06（网关清场掐断在飞握手）。
        // `switch_session` 是 RPC 方法名、带下划线，只匹配 "switch session"
        // 会把这类可重试故障降成 internal。
        assert_eq!(
            classify_session_error(
                "pi request switch_session failed: killed by Helix (no response channel) [waited 71ms, submit_gen=2 now_gen=2]"
            ),
            "session_restore_failed"
        );
        assert_eq!(
            classify_session_error(
                "pi request get_state failed: killed by Helix (no response channel) [waited 7639ms, submit_gen=2 now_gen=2]"
            ),
            "session_restore_failed"
        );
        // 「文件不存在」优先于任何包装文案。
        assert_eq!(
            classify_session_error("session restore task failed: no session file for 01a12b05"),
            "session_not_found"
        );
    }

    #[test]
    fn subagent_status_vocabulary_converges_to_three_tokens() {
        // 扩展的终态词表（subagents/src/types.ts:174）里没有 "done"。
        // 曾经回填门禁比的就是 `status == "done"` ⇒ 条件恒假，
        // 子 agent 的结果永远不会转达给父会话。这里把词表钉住：
        // 新增/改名的状态一律落成 completed，绝不落回 running
        // （卡片会被打回永久转圈）。
        for raw in ["completed", "steered", "done", "killed", ""] {
            assert_eq!(normalize_subagent_status(raw), "completed");
        }
        for raw in ["error", "stopped", "aborted"] {
            assert_eq!(normalize_subagent_status(raw), "failed");
        }
        for raw in ["queued", "running"] {
            assert_eq!(normalize_subagent_status(raw), "running");
        }
        // 回填的唯一判据。
        assert_eq!(normalize_subagent_status("completed"), "completed");
        assert_ne!(normalize_subagent_status("error"), "completed");
    }
}

