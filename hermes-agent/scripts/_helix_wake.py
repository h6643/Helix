#!/usr/bin/env python3
"""Stdin/stdout bridge for Helix desktop wake-word detection.

Long-running process that wraps ``tools.wake_word``. Commands arrive on stdin
(one per line); JSON events are written to stdout (one per line). The desktop
shell spawns this process, pipes both streams, and forwards ``wake_word`` events
to the frontend via Tauri IPC.

Commands (stdin)::

    start        Initialise and start the wake-word listener.
    stop         Stop the listener and exit the process.
    pause        Release the microphone (for a voice turn).
    resume       Re-arm the microphone after a voice turn.
    status       Print current status as a JSON event.

Events (stdout)::

    {"event":"started","engine":"openwakeword"}
    {"event":"wake_word"}
    {"event":"paused"}
    {"event":"resumed"}
    {"event":"stopped"}
    {"event":"status","listening":true,"silent":false}
    {"event":"in_use"}
    {"event":"error","message":"..."}

Owner: ``helix-desktop`` — prevents collision with ``/wake on`` in CLI sessions.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

# Ensure the hermes-agent root is on sys.path. The script lives in
# <hermes-agent>/scripts/, so the parent directory is the repo root.
_AGENT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _AGENT_ROOT not in sys.path:
    sys.path.insert(0, _AGENT_ROOT)

# Make sure PortAudio is found when installed to ~/.local/lib.
# This must happen before sounddevice (imported via tools.wake_word) is loaded.
_LD_PATH = os.environ.get("LD_LIBRARY_PATH", "")
_LOCAL_LIB = os.path.join(os.path.expanduser("~"), ".local", "lib")
if _LOCAL_LIB not in _LD_PATH:
    os.environ["LD_LIBRARY_PATH"] = f"{_LOCAL_LIB}:{_LD_PATH}" if _LD_PATH else _LOCAL_LIB

# Ensure HERMES_HOME is set so load_wake_word_config() can find config.yaml.
if not os.environ.get("HERMES_HOME"):
    os.environ["HERMES_HOME"] = os.path.join(Path.home(), ".hermes")


def _emit(event: str, **extra):
    """Write a single JSON line to stdout and flush immediately."""
    payload = {"event": event, **extra}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class WakeBridge:
    """Manages the wake-word detector lifecycle for the desktop shell."""

    def __init__(self):
        self._detector = None  # WakeWordDetector | None
        self._owner_id = "helix-desktop"

    # ── Commands ──────────────────────────────────────────────────────────

    def cmd_start(self):
        """Build and start the wake-word listener."""
        if self._detector is not None and self._detector.running:
            engine_labels = getattr(self._detector.engine, "_labels", ["unknown"])
            engine_label = engine_labels[0] if isinstance(engine_labels, list) and engine_labels else str(engine_labels)
            _emit("started", engine=engine_label)
            return

        try:
            from tools.wake_word import (
                WakeWordInUse,
                is_listening,
                load_wake_word_config,
                start_listening,
            )
        except ImportError as e:
            _emit("error", message=f"无法加载唤醒词模块: {e}")
            return

        # Check if another surface already owns the microphone.
        if is_listening():
            _emit("in_use", message="唤醒词麦克风已被其他进程占用")
            return

        cfg = load_wake_word_config()
        if not cfg.get("enabled"):
            # Auto-enable for the desktop surface.
            cfg["enabled"] = True

        # Force the surface to "gui" so the desktop always claims ownership
        # regardless of the configured surface (which may be "cli" or "auto").
        cfg["surface"] = "gui"

        try:
            self._detector = start_listening(
                on_wake=self._on_wake,
                owner=self._owner_id,
                config=cfg,
            )
        except WakeWordInUse:
            _emit("in_use", message="唤醒词麦克风已被其他进程占用")
            return
        except Exception as e:
            _emit("error", message=f"启动唤醒词监听失败: {e}")
            return

        engine_name = getattr(self._detector.engine, "_labels", ["unknown"])
        if isinstance(engine_name, list):
            engine_name = engine_name[0] if engine_name else "unknown"
        _emit("started", engine=str(engine_name))

    def cmd_stop(self):
        """Stop the listener and signal the main loop to exit."""
        if self._detector is None:
            _emit("stopped")
            return True  # signal exit

        try:
            from tools.wake_word import stop_listening
            stop_listening(owner=self._owner_id)
        except Exception:
            pass
        self._detector = None
        _emit("stopped")
        return True  # signal exit

    def cmd_pause(self):
        if self._detector is None:
            _emit("error", message="唤醒词监听未启动")
            return
        try:
            from tools.wake_word import pause_listening
            if pause_listening(owner=self._owner_id):
                _emit("paused")
            else:
                _emit("error", message="暂停失败：不是当前持有者")
        except Exception as e:
            _emit("error", message=f"暂停失败: {e}")

    def cmd_resume(self):
        if self._detector is None:
            _emit("error", message="唤醒词监听未启动")
            return
        try:
            from tools.wake_word import resume_listening
            if resume_listening(owner=self._owner_id):
                _emit("resumed")
            else:
                _emit("error", message="恢复失败：不是当前持有者")
        except Exception as e:
            _emit("error", message=f"恢复失败: {e}")

    def cmd_status(self):
        if self._detector is None or not self._detector.running:
            _emit("status", listening=False, silent=False)
            return

        try:
            from tools.wake_word import audio_is_silent
            silent = audio_is_silent()
        except Exception:
            silent = False

        engine_labels = getattr(self._detector.engine, "_labels", ["unknown"])
        engine_label = engine_labels[0] if isinstance(engine_labels, list) and engine_labels else str(engine_labels)
        _emit("status", listening=True, silent=silent, engine=engine_label)

    # ── Callback ──────────────────────────────────────────────────────────

    def _on_wake(self):
        """Called from the detector's daemon thread when the wake word fires."""
        _emit("wake_word")


# ── Main loop ────────────────────────────────────────────────────────────────


def main():
    bridge = WakeBridge()
    # Start automatically on launch — the desktop shell expects this.
    bridge.cmd_start()

    try:
        for line in sys.stdin:
            cmd = line.strip().lower()
            if not cmd:
                continue
            if cmd == "start":
                bridge.cmd_start()
            elif cmd == "stop":
                if bridge.cmd_stop():
                    break
            elif cmd == "pause":
                bridge.cmd_pause()
            elif cmd == "resume":
                bridge.cmd_resume()
            elif cmd == "status":
                bridge.cmd_status()
            else:
                _emit("error", message=f"未知命令: {cmd}")
    except KeyboardInterrupt:
        pass
    except EOFError:
        # Parent closed stdin — clean shutdown.
        pass
    finally:
        bridge.cmd_stop()


if __name__ == "__main__":
    main()
