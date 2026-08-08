#!/usr/bin/env python3
"""Minimal CLI bridge for Helix voice input.

Takes an audio file path via ``--file``, runs the Hermes STT pipeline
(``transcribe_audio``), and prints a JSON result to stdout.

Used by the Helix Tauri desktop shell when browser-native SpeechRecognition
is unavailable (e.g. WebKitGTK on Linux).
"""

import argparse
import json
import os
import sys

# Ensure the hermes-agent root is on sys.path so that `tools.transcription_tools`
# resolves regardless of CWD. The script lives in <hermes-agent>/scripts/, so
# the parent directory is the repo root.
_AGENT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _AGENT_ROOT not in sys.path:
    sys.path.insert(0, _AGENT_ROOT)


def main() -> None:
    parser = argparse.ArgumentParser(description="Helix STT bridge")
    parser.add_argument("--file", required=True, help="Path to audio file to transcribe")
    args = parser.parse_args()

    file_path = args.file
    if not os.path.isfile(file_path):
        json.dump(
            {"success": False, "transcript": "", "error": f"File not found: {file_path}"},
            sys.stdout,
        )
        sys.stdout.flush()
        sys.exit(1)

    try:
        from tools.transcription_tools import transcribe_audio

        result = transcribe_audio(file_path)
    except Exception as exc:
        result = {
            "success": False,
            "transcript": "",
            "error": f"transcribe_audio raised: {exc}",
        }

    json.dump(result, sys.stdout)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
