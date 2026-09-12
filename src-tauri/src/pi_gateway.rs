//! Multi-instance stdio adapter for `pi --mode rpc`.
//!
//! Helix speaks the Helix `session/*` API in its renderer. This module adapts
//! that API to the pi coding agent's JSONL RPC protocol (`pi --mode rpc`):
//! prompt/abort/new_session/switch_session commands plus event translation
//! (message_update / tool_execution_* / agent_settled) into the `session/update`
//! shapes the frontend already consumes. No frontend changes required.
//!
//! Differences from the legacy ACP (codex app-server) adapter:
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

use crate::gateway::emit_helix_event;
use crate::state::AppState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const RPC_TIMEOUT: Duration = Duration::from_secs(60);
/// Handshake (get_state on a fresh spawn) allowance. pi answers get_state
/// only after ALL extensions finish initializing; heavyweight extensions
/// (e.g. pi-hermes-memory's SQLite backfill) may legitimately block for
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
const STREAM_SILENCE_TIMEOUT: Duration = Duration::from_secs(180);
/// How often turn-wait loops re-check the watchdog between PROMPT_TIMEOUT
/// deadlines.
const WATCHDOG_TICK: Duration = Duration::from_secs(30);

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// pi session id → session file path. GLOBAL (outside instances) so it
/// survives instance reaping/restarts — a respawned conversation restores
/// via switch_session(file).
static SESSION_FILES: std::sync::LazyLock<Mutex<HashMap<String, String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
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
    cwd: Mutex<Option<String>>,
    writer: Mutex<Option<mpsc::Sender<String>>>,
    /// pi command ids → pending responders.
    pending: Mutex<HashMap<String, PendingRequest>>,
    child: Mutex<Option<Child>>,
    /// Current pi session id of THIS process — stamped onto emitted events.
    current_session: Mutex<Option<String>>,
    /// Pending extension UI requests (confirm/select/input/editor).
    ui_requests: Mutex<HashMap<String, PendingUI>>,
    /// Single in-flight turn waiter (one turn at a time per process).
    turn_waiter: Mutex<Option<TurnWaiter>>,
    /// Set when session/cancel releases the waiter so agent_settled (which
    /// still fires after abort) does not double-emit session/complete.
    turn_cancelled: AtomicBool,
    /// Buffered tool-call argument deltas, toolCallId → args string.
    tool_args: Mutex<HashMap<String, String>>,
    /// Model context window (get_state's model.contextWindow) for usage ring.
    context_window: Mutex<Option<i64>>,
    initialized: AtomicBool,
    /// Serializes (re)spawns of this instance so concurrent callers can't
    /// kill each other's fresh child.
    spawn_lock: Mutex<()>,
    /// Bumped BEFORE each (re)spawn; the reader thread only does death
    /// bookkeeping if its generation still matches.
    generation: AtomicU64,
    /// Turn in flight (prompt sent, agent_settled not seen) → never reap.
    streaming: AtomicBool,
    /// Last RPC activity (ms epoch) for idle reaping.
    last_active_ms: AtomicU64,
    /// Plan-mode extension armed? (@narumitw/pi-plan-mode). Tracks whether
    /// `/plan start` was sent without a matching `/plan exit`.
    plan_mode: Mutex<bool>,
    /// Last pi EVENT arrival (ms epoch) — any non-response line on stdout,
    /// refreshed by the reader thread. The turn watchdog distinguishes a
    /// wedged model stream (no events at all) from legitimate long tool
    /// runs / user-pending UI cards.
    last_event_ms: AtomicU64,
    /// Tool calls currently EXECUTING (tool_execution_start without its
    /// matching end). Long-running tools legitimately produce no stream
    /// events, so the watchdog must not fire while this is non-empty.
    executing_tools: Mutex<std::collections::HashSet<String>>,
}

impl PiInstance {
    fn new(key: String, cwd: Option<String>) -> Arc<Self> {
        Arc::new(Self {
            key: Mutex::new(key),
            cwd: Mutex::new(cwd),
            writer: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            child: Mutex::new(None),
            current_session: Mutex::new(None),
            ui_requests: Mutex::new(HashMap::new()),
            turn_waiter: Mutex::new(None),
            turn_cancelled: AtomicBool::new(false),
            tool_args: Mutex::new(HashMap::new()),
            context_window: Mutex::new(None),
            initialized: AtomicBool::new(false),
            spawn_lock: Mutex::new(()),
            generation: AtomicU64::new(0),
            streaming: AtomicBool::new(false),
            last_active_ms: AtomicU64::new(now_ms()),
            plan_mode: Mutex::new(false),
            last_event_ms: AtomicU64::new(now_ms()),
            executing_tools: Mutex::new(std::collections::HashSet::new()),
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

    /// True when the model stream is considered wedged: the turn is
    /// unsettled, nothing is executing, and pi has been silent for
    /// STREAM_SILENCE_TIMEOUT. Long tool runs don't trip it — the reader
    /// refreshes last_event_ms on EVERY pi line, including bash
    /// execution updates.
    fn stream_wedged(&self) -> bool {
        now_ms().saturating_sub(self.last_event_ms.load(Ordering::SeqCst))
            >= STREAM_SILENCE_TIMEOUT.as_millis() as u64
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
        self.submit(id.clone(), line, Responder::Sync(tx))?;
        let message = rx.recv_timeout(timeout).map_err(|e| match e {
            mpsc::RecvTimeoutError::Disconnected => {
                format!("pi request {cmd} failed: process exited (no response channel)")
            }
            mpsc::RecvTimeoutError::Timeout => format!("pi request {cmd} timed out"),
        })?;
        Self::decode_response(message, cmd)
    }

    /// Kill this instance's child and clear its transport state (a respawn
    /// rebuilds everything). Registered UI requests lose their owner entry.
    /// `cwd`, `current_session` and the SESSION_FILES mapping survive so a
    /// respawn lands in the same project and can restore the session.
    fn kill(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *self.writer.lock().unwrap() = None;
        self.pending.lock().unwrap().clear();
        let dead_ids: Vec<String> = self
            .ui_requests
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in dead_ids {
            UI_REQUEST_OWNERS.lock().unwrap().remove(&id);
        }
        self.ui_requests.lock().unwrap().clear();
        *self.turn_waiter.lock().unwrap() = None;
        self.tool_args.lock().unwrap().clear();
        self.executing_tools.lock().unwrap().clear();
        self.initialized.store(false, Ordering::SeqCst);
        self.streaming.store(false, Ordering::SeqCst);
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
                }
            }
        }
        if let Some(data) = data {
            if let Some(window) = data.pointer("/model/contextWindow").and_then(Value::as_i64) {
                *self.context_window.lock().unwrap() = Some(window);
            }
        }
    }

    /// The model's context window, when known from get_state.
    fn context_window(&self) -> Option<i64> {
        *self.context_window.lock().unwrap()
    }

    /// get_state + stamp. Returns the state `data`.
    async fn session_state(&self) -> Result<Value, String> {
        let data = self.request("get_state", Value::Null, RPC_TIMEOUT).await?;
        self.stamp_session_from_state(Some(&data));
        Ok(data)
    }

    /// Send a prompt and await the turn's settle (agent_settled), with the
    /// same indefinite-wait-while-UI-request-pending semantics as
    /// session/prompt. Used by the seed-history path, where the session's
    /// opening turn must fully settle before the caller's real prompt runs.
    async fn request_turn(&self, message: &str) -> Result<Value, String> {
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        self.turn_cancelled.store(false, Ordering::SeqCst);
        *self.turn_waiter.lock().unwrap() = Some(TurnWaiter { tx });
        self.streaming.store(true, Ordering::SeqCst);
        let result = self
            .request("prompt", json!({ "message": message }), RPC_TIMEOUT)
            .await;
        if result.is_err() {
            *self.turn_waiter.lock().unwrap() = None;
            self.streaming.store(false, Ordering::SeqCst);
            return Err(result.unwrap_err());
        }
        let mut deadline = tokio::time::Instant::now() + PROMPT_TIMEOUT;
        loop {
            let sleep = tokio::time::sleep_until(deadline);
            tokio::select! {
                result = &mut rx => {
                    self.streaming.store(false, Ordering::SeqCst);
                    return result.map_err(|_| "pi turn event channel closed".to_string());
                }
                _ = tokio::time::sleep(WATCHDOG_TICK) => {
                    let pending_ui = self.ui_requests.lock().unwrap().len();
                    let tools_running = self.executing_tools.lock().unwrap().len();
                    if pending_ui == 0 && tools_running == 0 && self.stream_wedged() {
                        let _ = self.request("abort", Value::Null, RPC_TIMEOUT).await;
                        *self.turn_waiter.lock().unwrap() = None;
                        self.streaming.store(false, Ordering::SeqCst);
                        return Err("模型响应流中断（3 分钟无任何输出）".to_string());
                    }
                }
                _ = sleep => {
                    let pending_ui = self.ui_requests.lock().unwrap().len();
                    if pending_ui == 0 {
                        self.streaming.store(false, Ordering::SeqCst);
                        return Err("pi turn timed out".to_string());
                    }
                    self.touch();
                    deadline = tokio::time::Instant::now() + PROMPT_TIMEOUT;
                }
            }
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Path equality that tolerates case, separators and trailing slashes
/// (Windows dir paths arrive from the renderer in arbitrary form).
fn same_path(a: &str, b: &str) -> bool {
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
    match spawn_instance(pending_key.clone(), None, state) {
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
                let _ = spawn_instance(String::new(), None, state);
            }
            rearm_warm_spares(state);
            Err(e)
        }
    }
}

/// Kill and remove one session's instance outright (conversation deleted).
#[allow(dead_code)]
pub fn drop_session_instance(session_id: &str) {
    if let Some(instance) = INSTANCES.lock().unwrap().remove(session_id) {
        instance.kill();
    }
}

/// Startup / restart entry point: make sure the MAIN instance exists. Called
/// from lib.rs setup, gateway.rs restarts, and the reader-thread self-heal.
pub fn spawn(state: &Arc<AppState>) -> Result<(), String> {
    let _guard = LIFECYCLE_LOCK.lock().unwrap();
    start_reaper();
    warm_session_file_index();
    let result = spawn_instance(String::new(), None, state).map(|_| ());
    // (Re)fill the warm-spare pool after the main instance is up — its spawn
    // cost is paid off the user's critical path.
    rearm_warm_spares(state);
    result
}

/// Refill the warm-spare pool in the background to WARM_SPARE_COUNT. Safe to
/// call repeatedly; concurrent refills are deduped by checking pool size after
/// the spawn completes. Spares whose dir no longer matches the global work
/// dir are reaped (a work-dir switch orphaned them).
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
        if spares.len() >= WARM_SPARE_COUNT {
            return;
        }
    }
    let state = Arc::clone(state);
    thread::spawn(move || {
        let key = format!("spare-{}", REQUEST_ID.fetch_add(1, Ordering::SeqCst));
        // Spares follow the global work dir (cwd = None).
        match spawn_instance(key, None, &state) {
            Ok(instance) => {
                // Another refill may have won the race — kill the loser.
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
    state: &Arc<AppState>,
) -> Result<Arc<PiInstance>, String> {
    let instance = get_or_create_instance(key, cwd);
    if instance.initialized.load(Ordering::SeqCst) {
        return Ok(instance);
    }
    {
        let _guard = instance.spawn_lock.lock().unwrap();
        if instance.initialized.load(Ordering::SeqCst) {
            return Ok(Arc::clone(&instance));
        }
        spawn_process(&instance, state)?;

        // Pi has no handshake — get_state succeeding proves the RPC is live.
        match instance.request_sync("get_state", Value::Null, HANDSHAKE_TIMEOUT) {
            Ok(data) => {
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
                instance.kill();
                return Err(e);
            }
        }
    }
    Ok(instance)
}

/// Find the instance under `key`, or create it (registering it in the map).
fn get_or_create_instance(key: String, cwd: Option<String>) -> Arc<PiInstance> {
    let mut instances = INSTANCES.lock().unwrap();
    if let Some(existing) = instances.get(&key) {
        Arc::clone(existing)
    } else {
        let instance = PiInstance::new(key.clone(), cwd);
        instances.insert(key, Arc::clone(&instance));
        instance
    }
}

/// Spawn (or replace) the child process + I/O threads for one instance.
/// The generation is bumped BEFORE the old child is killed so the outgoing
/// reader thread can observe the mismatch and skip its death bookkeeping.
fn spawn_process(instance: &Arc<PiInstance>, state: &Arc<AppState>) -> Result<(), String> {
    let _generation = instance.generation.fetch_add(1, Ordering::SeqCst) + 1;
    instance.kill();

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
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to start pi agent: {e}"))?;
    let Some(stdout) = child.stdout.take() else {
        return Err("Failed to open pi agent stdout".into());
    };
    let stderr = child.stderr.take();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open pi agent stdin".to_string())?;
    *instance.child.lock().unwrap() = Some(child);

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
        // Only do death bookkeeping if THIS thread's child is the current
        // one (generation unchanged → no respawn happened meanwhile).
        if instance_clone.generation.load(Ordering::SeqCst) == _generation {
            let quitting = state_clone.gateway.app_quitting.load(Ordering::SeqCst);
            instance_clone.initialized.store(false, Ordering::SeqCst);
            *instance_clone.writer.lock().unwrap() = None;
            instance_clone.pending.lock().unwrap().clear();
            *instance_clone.turn_waiter.lock().unwrap() = None;
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

    if let Some(stderr) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                eprintln!("[pi agent] {line}");
            }
        });
    }
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
            .filter(|m| !m.is_empty())
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

/// seedHistory → the session-opening user message that re-establishes context
/// after a session rebuild (session/new {messages: [{role, content}, …]}).
/// Renders as a transcript the model can continue from; asks for no response
/// beyond a short ack.
fn seed_history_prompt(messages: Option<&Value>) -> String {
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
    format!(
        "（系统注入：以下是本次会话恢复的先前对话记录，供你恢复上下文。无需重新执行其中已完成的工作，直接基于这些上下文继续后续对话即可。）\n\n{}",
        turns.join("\n\n")
    )
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
            // No project picked: the conversation must NOT inherit the last
            // used project (persisted workdir.json — the global work_dir).
            // That's how a brand-new chat landed in e.g. the LangGraph dir
            // just because a previous conversation ran there. Home dir is the
            // neutral default; a warm spare (spawned in the global dir) is
            // never claimed for such a conversation either.
            let spawn_cwd = cwd.clone().or_else(|| {
                dirs::home_dir().map(|d| d.to_string_lossy().into_owned())
            });
            let instance = match take_warm_spare(spawn_cwd.as_deref()) {
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
                    spawn_instance(temp_key, spawn_cwd, &state)?
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
            // seedHistory (gateway restart / reaped conversation rebuild): pi
            // has no RPC to inject prior history into a session, so replay it
            // as the session-opening user message. The model's brief ack turn
            // is the cost; losing all context on restart is worse. Only
            // user/assistant turns are carried — tool noise would hurt more
            // than help. Wait for the seed turn to settle so its events don't
            // interleave with the caller's real prompt.
            let seed = seed_history_prompt(params.get("messages"));
            if !seed.is_empty() {
                if let Err(e) = instance.request_turn(&seed).await {
                    eprintln!("[pi agent] seed history failed: {e}");
                }
            }
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
                let ok = result.is_ok();
                if let Err(e) = &result {
                    eprintln!("[pi agent] session prepare failed for {session_id}: {e}");
                } else {
                    eprintln!(
                        "[pi agent] session prepared for {session_id} in {:?}",
                        started.elapsed()
                    );
                }
                emit_helix_event(
                    "gateway.sessionPrepared",
                    &json!({ "session_id": session_id, "ok": ok }),
                );
            });
            Ok(json!({ "prepared": true }))
        }
        "session/resume" => {
            let session_id = params
                .get("session_id")
                .and_then(Value::as_str)
                .ok_or("session/resume is missing session_id")?
                .to_string();
            // Respawns the instance (switch_session restores the reaped
            // conversation from its session file) if it is not live.
            let instance = instance_for_session(&session_id, &state).await?;
            let resumed_id = instance
                .current_session
                .lock()
                .unwrap()
                .clone()
                .unwrap_or(session_id);
            // The resync path replaces the visible transcript with the
            // backend's authoritative history — return it in the shape
            // mapBackendMessages reads (role + text/content, tool results
            // collapsed to assistant text).
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
                        // Fold tool results into the assistant stream the way
                        // the TUI transcript shows them (append to the prior
                        // assistant turn is not possible here — emit as its
                        // own assistant entry).
                        let text = content_to_text(
                            m.get("content").unwrap_or(&Value::Null),
                        )
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_default();
                        Some(json!({
                            "id": m.get("id").and_then(Value::as_str),
                            "role": "assistant",
                            "text": format!("{} {}:\n{}",
                                m.get("toolName").and_then(Value::as_str).unwrap_or("tool"),
                                if m.get("isError").and_then(Value::as_bool) == Some(true) { "(错误)" } else { "" },
                                text),
                            "timestamp": m.get("timestamp"),
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
            // Other mode values stay no-ops — their semantics are enforced
            // prompt-side by the renderer (read-only prefix) or are simply
            // not expressible in pi.
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
                    if let Err(e) = instance
                        .request("prompt", json!({ "message": "/plan start" }), RPC_TIMEOUT)
                        .await
                    {
                        eprintln!("[pi agent] /plan start failed: {e}");
                    }
                }
                *instance.plan_mode.lock().unwrap() = true;
            } else if prev_active && !plan_approved {
                if let Err(e) = instance
                    .request("prompt", json!({ "message": "/plan exit" }), RPC_TIMEOUT)
                    .await
                {
                    eprintln!("[pi agent] /plan exit failed: {e}");
                }
                *instance.plan_mode.lock().unwrap() = false;
            }
            // normalize: plan_approved with a non-plan target means the user
            // approved execution — the extension itself leaves plan mode.
            if plan_approved && mode == "plan" {
                mode = "accept_edits";
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
        // Helix's /compact + auto-compaction. pi's compact returns
        // {summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter};
        // the frontend needs {status:"compressed", messages, removed} and
        // replaces the visible transcript with `messages` (mapBackendMessages
        // reads role/text), so fetch them after compacting.
        "session.compress" | "session/compress" => {
            let instance = routed_instance(&params, &state).await?;
            let compacted = instance.request("compact", Value::Null, RPC_TIMEOUT).await?;
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
                    SESSION_FILES.lock().unwrap().insert(sid, file);
                }
            }
            let tokens_before = compacted
                .get("tokensBefore")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let tokens_after = compacted
                .get("estimatedTokensAfter")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let removed = (tokens_before - tokens_after).max(0);
            Ok(json!({
                "status": "compressed",
                "messages": messages,
                "removed": removed,
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

            let prompt_params = pi_params.clone();
            let result = instance.request("prompt", prompt_params, RPC_TIMEOUT).await;
            let result = match result {
                Ok(data) => Ok(data),
                Err(_first_error) => {
                    // pi rejects prompts while it is mid-stream unless queued
                    // — retry once as a steering message.
                    let mut retried = pi_params.clone();
                    retried["streamingBehavior"] = json!("steer");
                    instance.request("prompt", retried, RPC_TIMEOUT).await
                }
            };
            if result.is_err() {
                *instance.turn_waiter.lock().unwrap() = None;
                instance.streaming.store(false, Ordering::SeqCst);
                return Err(result.unwrap_err());
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
                        break result.map_err(|_| "pi turn event channel closed")?;
                    }
                    _ = tokio::time::sleep(WATCHDOG_TICK) => {
                        let pending_ui = instance.ui_requests.lock().unwrap().len();
                        let tools_running = instance.executing_tools.lock().unwrap().len();
                        if pending_ui == 0 && tools_running == 0 && instance.stream_wedged() {
                            let _ = instance
                                .request("abort", Value::Null, RPC_TIMEOUT)
                                .await;
                            *instance.turn_waiter.lock().unwrap() = None;
                            instance.streaming.store(false, Ordering::SeqCst);
                            return Err("模型响应流中断（3 分钟无任何输出）".to_string());
                        }
                    }
                    _ = sleep => {
                        let pending_ui = instance.ui_requests.lock().unwrap().len();
                        if pending_ui == 0 {
                            instance.streaming.store(false, Ordering::SeqCst);
                            return Err("pi turn timed out".to_string());
                        }
                        // User still hasn't answered the card — keep waiting
                        // (and keep the instance off the reaper's list).
                        instance.touch();
                        deadline = tokio::time::Instant::now() + PROMPT_TIMEOUT;
                    }
                }
            };
            instance.streaming.store(false, Ordering::SeqCst);
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
            if let Some(waiter) = instance.turn_waiter.lock().unwrap().take() {
                let _ = waiter.tx.send(json!({ "cancelled": true }));
            }
            instance.streaming.store(false, Ordering::SeqCst);
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
            // Route by session_id when the frontend sent one (it always does
            // for approval.respond/clarify/respond); fall back to the
            // request-id → instance owner map (Tauri's helix_approval_respond
            // carries no session).
            let instance =
                routed_instance_or_ui_owner(&params, &approval_id, &state).await?;
            let PendingUI { method: ui_method } = instance
                .ui_requests
                .lock()
                .unwrap()
                .remove(&approval_id)
                .ok_or("Unknown pi UI request")?;
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
            writer
                .send(line)
                .map_err(|_| "pi agent stdin closed".to_string())?;
            Ok(json!({ "ok": true }))
        }
        // pi's RPC surface has no MCP introspection or hot-reload. Return the
        // empty/quiet shape the frontend's fetchMcpStatus understands, so the
        // settings page stops its bounded retry loop and shows "unknown"
        // (amber) instead of erroring on every poll.
        "mcp.servers.status" | "mcp/servers/status" => {
            Ok(json!({ "servers": [], "available": false }))
        }
        "reload.mcp" | "reload/mcp" => {
            // MCP servers load from config.yaml at pi process start; a real
            // reload = the gateway respawn config writes already trigger
            // (mcp_config_save respawns pi). Report skipped so callers can
            // tell "nothing to do" from an actual failure.
            Ok(json!({ "ok": true, "skipped": true }))
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
        | "get_tree"
        | "get_fork_messages"
        | "get_last_assistant_text" => {
            let instance = routed_instance(&params, &state).await?;
            instance.request(method, params, RPC_TIMEOUT).await
        }
        _ => Err(format!("pi adapter does not implement {method}")),
    }
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
        return spawn_instance(String::new(), None, state);
    }
    if let Some(instance) = INSTANCES.lock().unwrap().get(session_id) {
        if instance.initialized.load(Ordering::SeqCst) {
            return Ok(Arc::clone(instance));
        }
    }
    let lock = {
        let mut locks = RESUME_LOCKS.lock().unwrap();
        Arc::clone(locks.entry(session_id.to_string()).or_default())
    };
    // Restore on a blocking thread: the std MutexGuard must not ride an async
    // worker across .await points (Send), and switch_session can block for
    // HANDSHAKE_TIMEOUT on long sessions.
    let sid = session_id.to_string();
    let state = Arc::clone(state);
    let result = tokio::task::spawn_blocking(move || {
        let _guard = lock.lock().unwrap();
        // Double-check after acquiring: the first flyer may have finished
        // while we waited.
        if let Some(instance) = INSTANCES.lock().unwrap().get(&sid) {
            if instance.initialized.load(Ordering::SeqCst) {
                return Ok(Arc::clone(instance));
            }
        }
        restore_session_instance(&sid, &state)
    })
    .await
    .map_err(|e| format!("session restore task failed: {e}"))??;
    Ok(result)
}

/// Spawn (or warm-spare-claim) the instance for a not-live session and
/// switch it onto the persisted session file. Caller holds the session's
/// resume lock. Sync — runs on a blocking thread (see instance_for_session).
fn restore_session_instance(
    session_id: &str,
    state: &Arc<AppState>,
) -> Result<Arc<PiInstance>, String> {
    // Not live (reaped / crashed / never spawned): respawn and restore the
    // conversation from its persisted session file. The existing map entry
    // (if any) keeps its stored cwd, so the respawn lands in the same project.
    // Cached paths are validated — the file may have been deleted since the
    // index was built (session cleanup / pi CLI housekeeping).
    let session_file = SESSION_FILES
        .lock()
        .unwrap()
        .get(session_id)
        .filter(|p| std::path::Path::new(p).exists())
        .cloned()
        .or_else(|| find_session_file(session_id))
        .ok_or_else(|| format!("no session file for {session_id}"))?;
    // The conversation's real project dir comes from the jsonl header — the
    // sessions folder name is lossy (every path separator and '-' encodes as
    // '-'), so it can't be recovered from the directory alone. Feeding it to
    // spawn_instance also fixes a fresh-start respawn landing in the global
    // work dir instead of the conversation's own project.
    let session_cwd = read_session_cwd(&session_file);
    // Claim a warm spare in the same project — skips pi's 10s+ cold start
    // (process spawn + extension init + handshake) on resume. Only when the
    // session's dir is known: an unknown dir must not claim an arbitrary
    // spare, which would run the conversation in the wrong project.
    let instance = if let Some(cwd) = session_cwd.as_deref() {
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
                spawn_instance(session_id.to_string(), Some(cwd.to_string()), state)?
            }
        }
    } else {
        spawn_instance(session_id.to_string(), None, state)?
    };
    let data = instance.request_sync(
        "switch_session",
        json!({ "sessionPath": session_file }),
        // Restoring a long conversation parses the whole jsonl — the same
        // heavyweight class as the spawn handshake, not a quick RPC.
        HANDSHAKE_TIMEOUT,
    )?;
    if data.get("cancelled").and_then(Value::as_bool) == Some(true) {
        return Err("pi declined the session switch".into());
    }
    // get_state + stamp (session_state is async-only; inline the sync pair).
    let state_data = instance.request_sync("get_state", Value::Null, RPC_TIMEOUT)?;
    instance.stamp_session_from_state(Some(&state_data));
    // Free-tier upstreams (tokenrouter glm-5.3-free) silently DROP requests
    // whose restored context exceeds the model window: no error, no stream,
    // the turn never settles while pi stays healthy — the user sees an
    // eternal "工作中". pi's own compact RPC can't rescue this (its
    // summarization call replays the same oversized context and hangs the
    // same way), so the rescue is a LOCAL jsonl trim: keep the header + the
    // records of the most recent complete turns and switch to the trimmed
    // copy. O(file), no model involved, sub-second. Best-effort — on any
    // failure the session restores with the original oversized context.
    if let Some(window) = instance.context_window() {
        let trimmed = trim_session_if_oversized(&session_file, window)?;
        if let Some(trimmed_path) = trimmed {
            match instance.request_sync(
                "switch_session",
                json!({ "sessionPath": trimmed_path }),
                HANDSHAKE_TIMEOUT,
            ) {
                Ok(_) => {
                    if let Ok(fresh) = instance.request_sync("get_state", Value::Null, RPC_TIMEOUT)
                    {
                        instance.stamp_session_from_state(Some(&fresh));
                    }
                }
                Err(e) => eprintln!("[pi agent] oversized-session trim switch failed: {e}"),
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

/// Local rescue for restored sessions whose next-prompt context would blow
/// past the model window (free-tier upstreams silently drop those — no
/// error, no stream, eternal "工作中"). Walks turns backwards from the end
/// accumulating estimated tokens, finds the newest user-message boundary
/// that fits under `window - TRIM_MARGIN_TOKENS`, and writes a trimmed
/// copy: header record + the kept records (the kept slice's first record
/// has its parentId broken — pi's loader treats a chain start as a root).
/// Returns the trimmed path, or None when the session already fits (or is
/// untrimmable, e.g. a single huge turn). Never touches the original file.
pub fn trim_session_if_oversized(
    session_file: &str,
    window: i64,
) -> Result<Option<String>, String> {
    if window <= 0 {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(session_file).map_err(|e| e.to_string())?;
    let lines: Vec<String> = raw
        .split('\n')
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    if lines.len() < 2 {
        return Ok(None);
    }
    let (tokens, _, latest_compaction_idx) = estimate_active_branch(&lines);
    let budget = window - TRIM_MARGIN_TOKENS;
    if tokens <= budget {
        return Ok(None);
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
        return Ok(None); // nothing to cut at — a single oversized turn can't be rescued here
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
        return Ok(None);
    };
    // If the cut lands after the latest compaction record, carry that record
    // into the trimmed file — its summary is the only surviving memory of
    // everything before the cut, and it costs only a couple thousand tokens.
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
    let trimmed_path = format!("{session_file}.trimmed.jsonl");
    std::fs::write(&trimmed_path, out.join("\n") + "\n").map_err(|e| e.to_string())?;
    eprintln!(
        "[pi agent] oversized session trimmed: ~{tokens} tokens > window {window}; kept ~{acc} tokens from record {keep_from} -> {trimmed_path}"
    );
    Ok(Some(trimmed_path))
}

/// The trimmed copy a restore may have switched this session onto. Returns
/// the path only when it exists on disk (the instance may still be on the
/// original file — no trim happened, or the copy was deleted).
fn trimmed_path_for(session_file: &str) -> Option<String> {
    let trimmed = format!("{session_file}.trimmed.jsonl");
    std::path::Path::new(&trimmed).exists().then_some(trimmed)
}

/// Last-modified time for mtime comparisons; missing files count as epoch.
fn mtime_of(path: &str) -> std::time::SystemTime {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::UNIX_EPOCH)
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
        let mut indexed = 0usize;
        let mut map = SESSION_FILES.lock().unwrap();
        scan_session_files(|id, path| {
            // Don't clobber entries added meanwhile by live instances — those
            // are fresher than whatever this scan finds.
            map.entry(id.to_string())
                .or_insert_with(|| path.to_string_lossy().into_owned());
            indexed += 1;
            None::<()>
        });
        drop(map);
        if indexed > 0 {
            eprintln!("[pi agent] session file index warmed: {indexed} files");
        }
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
    instance_for_session(&session_id, state).await
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

/// get_session_stats → Helix context-breakdown shape (same as the legacy
/// codex app-server adapter).
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
    let context_max = context
        .get("contextWindow")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| instance.context_window().unwrap_or(0));
    let mut context_used = context.get("tokens").and_then(Value::as_i64).unwrap_or(0);
    // True next-prompt replay size from the session file — same estimator the
    // restore-time trim uses. Cheaper than a stale 2k figure hiding a 276k
    // replay behind a 128k window.
    if let Value::String(sid) = instance.current_session_id() {
        // Scope the guard: it must not ride across the read_to_string await.
        let cached_file = SESSION_FILES.lock().unwrap().get(&sid).cloned();
        if let Some(session_file) = cached_file.or_else(|| find_session_file(&sid)) {
            // After a restore-time trim, pi switched to `<file>.trimmed.jsonl`
            // and appends THERE — the original never grows again. Whichever
            // file pi is on stays the newer one, so the mtime picks the live
            // file even when the trim's switch failed and pi stayed put.
            let estimate_target = trimmed_path_for(&session_file)
                .filter(|t| mtime_of(t) >= mtime_of(&session_file))
                .unwrap_or(session_file);
            if let Ok(raw) = tokio::fs::read_to_string(&estimate_target).await {
                let lines: Vec<String> = raw
                    .split('\n')
                    .map(str::trim_end)
                    .filter(|l| !l.is_empty())
                    .map(str::to_string)
                    .collect();
                let (estimated, _, _) = estimate_active_branch(&lines);
                if estimated > context_used {
                    context_used = estimated;
                }
            }
        }
    }
    let context_percent = if context_max > 0 {
        (context_used as f64 / context_max as f64) * 100.0
    } else {
        0.0
    };

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
    push_category("input", "输入", input_tokens, "var(--context-usage-system)");
    push_category(
        "cached-read",
        "缓存读取",
        cached_read,
        "var(--context-usage-skills)",
    );
    push_category(
        "cached-write",
        "缓存写入",
        cached_write,
        "var(--context-usage-mcp)",
    );
    push_category(
        "output",
        "输出",
        output_tokens,
        "var(--context-usage-conversation)",
    );
    let estimated_total = categories
        .iter()
        .filter_map(|c| c.get("tokens").and_then(Value::as_i64))
        .sum::<i64>();

    Ok(json!({
        "context_max": context_max,
        "context_used": context_used,
        "context_percent": context_percent,
        "estimated_total": estimated_total,
        "categories": categories,
    }))
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
            }
        }
        _ => {
            // Any pi event (stream delta, tool update, …) proves the model
            // stream is alive — heartbeat for the turn watchdog.
            instance.last_event_ms.store(now_ms(), Ordering::SeqCst);
            emit_pi_event(instance, event_type, &message);
        }
    }
}

/// Translate pi events into the Helix event surface the frontend consumes.
/// Every event is stamped with THIS instance's session id — the frontend's
/// run loop filters by session id, so parallel conversations only see their
/// own events.
fn emit_pi_event(instance: &Arc<PiInstance>, event_type: &str, message: &Value) {
    let sid = || instance.current_session_id();
    match event_type {
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
            // Per-message usage snapshot → context ring (same as the legacy
            // adapter's tokenUsage/updated event on assistant message completion).
            if message.get("usage").is_some()
                && matches!(delta_type, "text_end" | "thinking_end" | "toolcall_end")
            {
                emit_usage(instance, message);
            }
        }
        "tool_execution_start" => {
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
        }
        "tool_execution_update" => {
            let tool_call_id = message
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_string)
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
        }
        "tool_execution_end" => {
            let tool_call_id = message
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_default();
            let tool_name = message
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("tool");
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
                        },
                    }),
                );
            }
            // rpiv-todo extension (@juicesharp/rpiv-todo): every `todo` tool
            // call returns the full task list in `result.details.tasks`.
            // Forward it as a structured `todo_list` update so the renderer
            // can render the real list instead of guessing from chat text.
            if tool_name == "todo" {
                let tasks = message.pointer("/result/details/tasks");
                if let Some(tasks) = tasks.and_then(Value::as_array) {
                    let todos: Vec<Value> = tasks
                        .iter()
                        .filter(|t| t.get("subject").and_then(Value::as_str).is_some())
                        .map(|t| {
                            json!({
                                "id": t.get("id").map(|v| v.to_string()),
                                "content": t.get("subject").and_then(Value::as_str).unwrap_or(""),
                                "status": t.get("status").and_then(Value::as_str).unwrap_or("pending"),
                                "activeForm": t.get("activeForm").and_then(Value::as_str),
                            })
                        })
                        .collect();
                    // Always emit when the array is present — an empty
                    // list (action: clear) must collapse the renderer panel.
                    emit_helix_event(
                        "session/update",
                        &json!({
                            "session_id": sid(),
                            "update": {
                                "sessionUpdate": "todo_list",
                                "todos": todos,
                            },
                        }),
                    );
                }
            }
        }
        "agent_settled" => {
            // Turn (including queued steering/follow-ups) fully settled →
            // release the in-flight session/prompt waiter.
            let cancelled = instance.turn_cancelled.swap(false, Ordering::SeqCst);
            if let Some(waiter) = instance.turn_waiter.lock().unwrap().take() {
                let _ = waiter.tx.send(if cancelled {
                    json!({ "cancelled": true })
                } else {
                    json!({ "type": "agent_settled" })
                });
            }
            instance.streaming.store(false, Ordering::SeqCst);
            if !cancelled {
                emit_helix_event("session/complete", &json!({ "session_id": sid() }));
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
            match ui_method {
                // confirm = a yes/no gate → keep the approval dialog path
                // (Helix's ApprovalDialog maps choice to confirmed/denied).
                "confirm" => {
                    instance.ui_requests.lock().unwrap().insert(
                        request_id.clone(),
                        PendingUI {
                            method: ui_method.to_string(),
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
                }
                // select/input/editor = free-form user interaction → the
                // clarify bar (bottom floating input with optional choices),
                // answered via clarify/respond. Routing these through
                // permission_request loses the answer value (approve could
                // not pick an option), which hung the extension forever.
                "select" | "input" | "editor" => {
                    instance.ui_requests.lock().unwrap().insert(
                        request_id.clone(),
                        PendingUI {
                            method: ui_method.to_string(),
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
                                "params": message,
                            },
                        }),
                    );
                }
                // notify / setStatus / setWidget / setTitle / set_editor_text:
                // fire-and-forget — surface as a warning, never block.
                _ => {
                    let msg = message
                        .get("message")
                        .or_else(|| message.get("statusText"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if !msg.is_empty() {
                        emit_helix_event(
                            "model/warning",
                            &json!({ "session_id": sid(), "message": msg, "raw": message }),
                        );
                    }
                }
            }
        }
        // Pass-through / ignore: agent_start, turn_start/end, message_start/end,
        // queue_update, compaction_*, summarization_retry_*, bash_execution_update.
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

/// `message_update` carries the cumulative `usage` field → emit the context
/// ring event in the shape the frontend's addSessionUsageStats expects
/// (carried over from the legacy codex app-server adapter).
fn emit_usage(instance: &Arc<PiInstance>, message: &Value) {
    let usage = message.get("usage").cloned().unwrap_or(Value::Null);
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
    let context_max = instance.context_window.lock().unwrap().unwrap_or(0);
    let context_used = total;
    let context_percent = if context_max > 0 {
        (context_used as f64 / context_max as f64) * 100.0
    } else {
        0.0
    };
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
            },
            "session_id": instance.current_session_id(),
            "raw": usage,
        }),
    );
}

/// Locate the pi CLI's bundled cli.js + the node that runs it. Never goes
/// through `pi.cmd`: CreateProcess would spawn cmd.exe as OUR child and node
/// as cmd's grandchild — `child.kill()` then kills only the cmd wrapper and
/// leaks the node/pi process. A leaked pi holds the hermes SQLite lock and
/// makes every later spawn block on it ("process exited" cascades).
///
/// Resolution order:
///  1. `<data_dir>/npm/node_modules/.../cli.js` (npm global prefix);
///  2. any `pi.cmd` / `pi` shim on PATH — parse it for its cli.js path
///     (same file npm's shim invokes) and run that under node directly.
/// A `pi.cmd`-style shim references the SAME install as (1), so (2) is a
/// different npm prefix (or none found) only in exotic setups.
#[cfg(windows)]
fn resolve_pi_cli() -> Option<(PathBuf, PathBuf)> {
    const REL_CLI: &str = "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
    // 1. npm global prefix under the data dir.
    if let Some(npm_dir) = dirs::data_dir().map(|home| home.join("npm")) {
        let cli_js = npm_dir.join(REL_CLI);
        if cli_js.is_file() {
            return Some((pi_node(&npm_dir), cli_js));
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
                return Some((pi_node(&PathBuf::from(dir)), cli_js));
            }
        }
    }
    None
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

#[cfg(windows)]
pub fn pi_cli_args() -> (Command, Vec<String>) {
    match resolve_pi_cli() {
        Some((node, cli_js)) => {
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

#[cfg(not(windows))]
pub fn pi_cli_args() -> (Command, Vec<String>) {
    (Command::new("pi"), vec![])
}

/// pi CLI program + base argv as plain strings, for tokio::process::Command
/// callers in other modules (install/uninstall etc.).
pub fn pi_cli_strings() -> (String, Vec<String>) {
    let (command, base) = pi_cli_args();
    (command.get_program().to_string_lossy().into_owned(), base)
}

#[cfg(windows)]
fn pi_command() -> Command {
    let (mut command, _base) = pi_cli_args();
    command.arg("--mode").arg("rpc");
    command
}

#[cfg(not(windows))]
fn pi_command() -> Command {
    let (mut command, _base) = pi_cli_args();
    command.arg("--mode").arg("rpc");
    command
}
