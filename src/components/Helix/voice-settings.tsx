'use client'

import React, { useState, useEffect, useRef } from 'react'
import { Mic, MicOff, Volume2, VolumeX, AudioLines } from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { getRecognition, speak, stripAcp, stopSpeaking } from '@/lib/voice-utils'

// The "语音" page in Settings. Replaces the old standalone Voice panel:
// the auto-speak toggle is a persisted setting (voiceAutoSpeak), while the
// voice-input trigger and TTS controls are actions available here.
export function VoiceSettings() {
  const voiceAutoSpeak = useHelixStore((s) => s.voiceAutoSpeak)
  const setVoiceAutoSpeak = useHelixStore((s) => s.setVoiceAutoSpeak)
  const injectInput = useHelixStore((s) => s.injectInput)

  const [listening, setListening] = useState(false)
  const [supported, setSupported] = useState(true)
  const [transcript, setTranscript] = useState('')
  const recRef = useRef<any>(null)

  useEffect(() => {
    const r = getRecognition()
    if (!r) {
      setSupported(false)
      return
    }
    recRef.current = r
    r.onresult = (e: any) => {
      let text = ''
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript
      setTranscript(text)
    }
    r.onend = () => setListening(false)
    return () => r.stop?.()
  }, [])

  const toggleListen = () => {
    const r = recRef.current
    if (!r) return
    if (listening) {
      r.stop()
      setListening(false)
      if (transcript.trim()) injectInput(transcript.trim())
      setTranscript('')
    } else {
      setTranscript('')
      try {
        r.start()
        setListening(true)
      } catch {
        /* already started */
      }
    }
  }

  const speakLast = () => {
    const msgs = useHelixStore.getState().chatMessages
    const last = msgs[msgs.length - 1]
    if (last && last.role === 'assistant') speak(stripAcp(last.content))
  }

  return (
    <div className="max-w-2xl space-y-8">
      <div className="flex items-center gap-2">
        <AudioLines className="size-5 text-primary" />
        <h2 className="text-lg font-bold">语音</h2>
      </div>

      <section className="rounded-xl border border-border/50 bg-card/50 shadow-sm p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">自动朗读 Agent 回复</p>
            <p className="text-xs text-muted-foreground">每次任务结束后自动用语音读出最新回复</p>
          </div>
          <button
            onClick={() => setVoiceAutoSpeak(!voiceAutoSpeak)}
            className={`relative w-10 h-6 rounded-full transition-colors duration-200 ${
              voiceAutoSpeak ? 'bg-primary' : 'bg-muted-foreground/20'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-200 ${
                voiceAutoSpeak ? 'translate-x-4' : ''
              }`}
            />
          </button>
        </div>

        <div className="border-t border-border/50 pt-4 space-y-3">
          <p className="text-xs text-muted-foreground">语音输入（浏览器 Web Speech API，无需网关）</p>
          {!supported && (
            <p className="text-xs text-amber-400">
              当前环境不支持语音识别（Web Speech API）。朗读功能仍可用。
            </p>
          )}
          <button
            onClick={toggleListen}
            disabled={!supported}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm transition-colors ${
              listening
                ? 'bg-red-500/90 text-white animate-pulse'
                : 'bg-primary/10 text-primary hover:bg-primary/20'
            } disabled:opacity-40`}
          >
            {listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            {listening ? '正在聆听…点击停止并发送' : '开始语音输入'}
          </button>
          {transcript && (
            <p className="text-xs text-foreground/80 bg-muted/40 rounded-lg p-2 w-full break-words">{transcript}</p>
          )}
        </div>

        <div className="border-t border-border/50 pt-4 grid grid-cols-2 gap-3">
          <button
            onClick={speakLast}
            className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-muted/50 hover:bg-muted text-sm"
          >
            <Volume2 className="size-4" /> 朗读上一条回复
          </button>
          <button
            onClick={stopSpeaking}
            className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-muted-foreground hover:bg-muted/50 text-sm"
          >
            <VolumeX className="size-4" /> 停止朗读
          </button>
        </div>
      </section>
    </div>
  )
}
