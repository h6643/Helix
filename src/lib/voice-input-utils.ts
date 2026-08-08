// Browser-native speech-to-text using the Web Speech API (SpeechRecognition).
// On platforms where SpeechRecognition is unavailable (e.g. Linux/WebKitGTK),
// falls back to MediaRecorder + Hermes backend STT via the Tauri bridge.
//
// The "official" Hermes voice input approach:
//   - Primary: browser-native SpeechRecognition (zero-latency, no backend)
//   - Fallback: MediaRecorder → Tauri `hermes_transcribe` → Hermes Python STT

export type SttStatus = 'idle' | 'listening' | 'error'

export interface SttState {
  status: SttStatus
  /** Accumulated final transcript from this session. */
  finalText: string
  /** Current interim (unconfirmed) result — updates in real time. */
  interimText: string
  errorMessage: string
}

export function isSpeechRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  return typeof Ctor === 'function'
}

export function createSpeechRecognition(): any {
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (typeof Ctor !== 'function') return null
  return new Ctor()
}

export interface SttCallbacks {
  onFinal: (text: string) => void
  onInterim: (text: string) => void
  onStatus: (status: SttStatus) => void
  onError: (message: string) => void
}

export interface SttHandle {
  start: () => void
  stop: () => void
  abort: () => void
}

/**
 * Create a speech-recognition session. Returns a handle with `start()` and
 * `stop()` methods. Callers should clean up by calling `abort()` on unmount.
 *
 * The recognition engine auto-restarts on `end` while the session is still
 * active, so the user can keep speaking across natural pauses.
 */
export function startStt(lang: string, callbacks: SttCallbacks): SttHandle {
  let active = false
  let restartTimer: ReturnType<typeof setTimeout> | null = null

  const recognition = createSpeechRecognition()
  if (!recognition) {
    callbacks.onError('SpeechRecognition 不可用（当前平台不支持浏览器语音识别）')
    return { start: () => {}, stop: () => {}, abort: () => {} }
  }

  recognition.lang = lang || 'zh-CN'
  recognition.interimResults = true
  recognition.continuous = true
  // Some engines produce better results when they expect shorter utterances.
  // We keep continuous=true so the user doesn't have to re-click the mic
  // after every pause; the auto-restart below handles engine stops.

  recognition.onstart = () => {
    active = true
    callbacks.onStatus('listening')
  }

  recognition.onresult = (event: any) => {
    let interim = ''
    let final = ''

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      if (result.isFinal) {
        final += result[0].transcript
      } else {
        interim += result[0].transcript
      }
    }

    if (final) callbacks.onFinal(final)
    if (interim) callbacks.onInterim(interim)
    // Don't clear interim here — the caller resets it when final text arrives.
  }

  recognition.onerror = (event: any) => {
    // "no-speech" and "aborted" are normal operational errors — don't surface
    // them as user-visible errors.
    if (event.error === 'no-speech' || event.error === 'aborted') return

    const msg =
      event.error === 'not-allowed'
        ? '麦克风权限被拒绝，请在系统设置中允许麦克风访问'
        : event.error === 'audio-capture'
          ? '未检测到麦克风设备'
          : event.error === 'network'
            ? '语音识别需要网络连接'
            : `语音识别错误: ${event.error}`

    callbacks.onError(msg)
  }

  recognition.onend = () => {
    // Auto-restart while the user hasn't explicitly stopped. This handles the
    // case where the engine stops after a natural pause (common on some
    // platforms despite continuous=true).
    if (active) {
      restartTimer = setTimeout(() => {
        if (active) {
          try { recognition.start() } catch { /* ignore — abort was called */ }
        }
      }, 200)
    } else {
      callbacks.onStatus('idle')
    }
  }

  return {
    start: () => {
      active = true
      try { recognition.start() } catch { /* may already be started */ }
    },
    stop: () => {
      active = false
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
      try { recognition.stop() } catch { /* ignore */ }
      callbacks.onStatus('idle')
    },
    abort: () => {
      active = false
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
      try { recognition.abort() } catch { /* ignore */ }
    },
  }
}

// ── Native audio recording (Tauri arecord) — Linux WebKitGTK fallback ─────

/**
 * Check whether native audio recording is available via Tauri commands.
 * This is the primary voice-input fallback on Linux, where WebKitGTK does
 * not support ``getUserMedia`` audio capture.
 */
export function isNativeRecordingSupported(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as any).__TAURI_INTERNALS__
}

/**
 * Create a native-recording STT session. Records audio via the OS-native
 * ``arecord`` command (spawned through the Tauri backend), then sends the
 * captured audio to the Hermes STT pipeline for transcription.
 *
 * No browser APIs are used for capture — this is immune to WebKitGTK's
 * ``getUserMedia`` limitations on Linux.
 */
export function startNativeRecordStt(
  _lang: string,
  callbacks: SttCallbacks,
): SttHandle {
  let active = false
  let recordStarted = false

  const start = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke('hermes_record_start') as string
      // result is the record_id string
      active = true
      recordStarted = true
      callbacks.onStatus('listening')
    } catch (err: any) {
      callbacks.onError(`启动录音失败: ${err.message || err}`)
    }
  }

  const stop = async () => {
    if (!recordStarted) {
      active = false
      callbacks.onStatus('idle')
      return
    }
    active = false
    recordStarted = false
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke('hermes_record_stop') as any
      if (result?.success && result?.transcript) {
        callbacks.onFinal(result.transcript)
      } else if (result?.error) {
        callbacks.onError(result.error)
      } else {
        callbacks.onError('语音识别失败：未返回识别结果')
      }
    } catch (err: any) {
      callbacks.onError(`语音识别出错: ${err.message || err}`)
    } finally {
      callbacks.onStatus('idle')
    }
  }

  const abort = () => {
    active = false
    recordStarted = false
    // Stop recording without transcribing.
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('hermes_record_stop')
      } catch { /* ignore cleanup errors */ }
    })()
    callbacks.onStatus('idle')
  }

  return { start, stop, abort }
}

/**
 * Check whether the MediaRecorder API is available for audio capture.
 * This is the fallback path on platforms where SpeechRecognition is
 * unavailable (e.g. WebKitGTK on Linux).
 */
export function isMediaRecorderSupported(): boolean {
  if (typeof window === 'undefined') return false
  return !!(
    typeof navigator?.mediaDevices?.getUserMedia === 'function' &&
    typeof (window as any).MediaRecorder === 'function'
  )
}

/**
 * Create a MediaRecorder-based STT session. Records audio via the
 * microphone, then sends it to the Hermes backend for transcription
 * via the Tauri `hermes_transcribe` command.
 *
 * Unlike browser-native STT, there is no real-time interim text —
 * transcription happens only after recording stops.
 *
 * Returns the same ``SttHandle`` interface as ``startStt`` so
 * callers can use either backend interchangeably.
 */
export function startMediaRecorderStt(
  _lang: string,
  callbacks: SttCallbacks,
): SttHandle {
  let mediaRecorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let chunks: BlobPart[] = []
  let active = false

  const cleanup = () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop() } catch { /* ignore */ }
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop())
      stream = null
    }
    mediaRecorder = null
    chunks = []
  }

  const start = async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err: any) {
      const msg =
        err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError'
          ? '麦克风权限被拒绝，请在系统设置中允许麦克风访问'
          : err.name === 'NotFoundError'
            ? '未检测到麦克风设备'
            : `无法访问麦克风: ${err.message || err}`
      callbacks.onError(msg)
      return
    }

    // Prefer webm/opus; fall back to whatever the browser offers.
    let mimeType = 'audio/webm;codecs=opus'
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/webm'
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = '' // let the browser pick
      }
    }

    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    chunks = []

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    mediaRecorder.onstart = () => {
      active = true
      callbacks.onStatus('listening')
    }

    mediaRecorder.onerror = () => {
      callbacks.onError('录音设备出错')
      cleanup()
      callbacks.onStatus('idle')
    }

    mediaRecorder.start(250) // emit data every 250ms for responsiveness
  }

  const stop = async () => {
    if (!active || !mediaRecorder) {
      cleanup()
      callbacks.onStatus('idle')
      return
    }

    // Capture the promise that resolves when the recorder stops and all
    // dataavailable events have fired.
    const stopped = new Promise<Blob>((resolve) => {
      mediaRecorder!.addEventListener(
        'stop',
        () => {
          const mime = mediaRecorder?.mimeType || 'audio/webm'
          const blob = new Blob(chunks, { type: mime })
          resolve(blob)
        },
        { once: true },
      )
    })

    active = false
    mediaRecorder.requestData() // flush any pending chunks
    mediaRecorder.stop()

    // Stop the mic stream immediately so the user knows recording ended.
    if (stream) {
      stream.getTracks().forEach((t) => t.stop())
      stream = null
    }

    try {
      const blob = await stopped
      if (blob.size === 0) {
        callbacks.onError('未录制到音频数据')
        callbacks.onStatus('idle')
        return
      }

      // Convert to base64.
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => callbacks.onError('读取录音数据失败')
        reader.readAsDataURL(blob)
      })
      // Strip the data:audio/...;base64, prefix.
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const ext = blob.type.includes('webm') ? 'webm' : blob.type.split('/')[1] || 'webm'

      // Dynamically import invoke so this module stays tree-shakeable.
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke('hermes_transcribe', { audioB64: b64, format: ext }) as any

      if (result?.success && result?.transcript) {
        callbacks.onFinal(result.transcript)
      } else if (result?.error) {
        callbacks.onError(result.error)
      } else {
        callbacks.onError('语音识别失败：未返回识别结果')
      }
    } catch (err: any) {
      callbacks.onError(`语音识别出错: ${err.message || err}`)
    } finally {
      cleanup()
      callbacks.onStatus('idle')
    }
  }

  const abort = () => {
    active = false
    cleanup()
    callbacks.onStatus('idle')
  }

  return { start, stop, abort }
}
