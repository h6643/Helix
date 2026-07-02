'use client'

import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Mic, MicOff, Loader2 } from 'lucide-react'

interface VoiceInputProps {
  onResult: (text: string) => void
  disabled?: boolean
}

export function VoiceInput({ onResult, disabled }: VoiceInputProps) {
  const [isListening, setIsListening] = useState(false)
  const [isSupported, setIsSupported] = useState(true)
  const [interimText, setInterimText] = useState('')
  const recognitionRef = useRef<SpeechRecognition | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const SpeechRecognition = (window as unknown as Record<string, unknown>).SpeechRecognition
      || (window as unknown as Record<string, unknown>).webkitSpeechRecognition
    if (!SpeechRecognition) {
      setIsSupported(false)
    }
  }, [])

  const toggleListening = useCallback(() => {
    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop()
      setIsListening(false)
      setInterimText('')
      return
    }

    const SpeechRecognition = (window as unknown as Record<string, unknown>).SpeechRecognition
      || (window as unknown as Record<string, unknown>).webkitSpeechRecognition as typeof window.SpeechRecognition | undefined

    if (!SpeechRecognition) {
      setIsSupported(false)
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    let finalTranscript = ''

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) {
          finalTranscript += result[0].transcript
        } else {
          interim += result[0].transcript
        }
      }
      setInterimText(interim || finalTranscript)

      if (finalTranscript) {
        onResult(finalTranscript)
        finalTranscript = ''
        setInterimText('')
      }
    }

    recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error)
      setIsListening(false)
      setInterimText('')
    }

    recognition.onend = () => {
      setIsListening(false)
      setInterimText('')
    }

    recognitionRef.current = recognition
    recognition.start()
    setIsListening(true)
  }, [isListening, onResult])

  if (!isSupported) return null

  return (
    <div className="relative flex items-center">
      <button
        onClick={toggleListening}
        disabled={disabled}
        className={`p-1.5 rounded-lg transition-all duration-200 ${
          isListening
            ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 animate-pulse'
            : 'text-muted-foreground hover:text-foreground hover:bg-muted'
        } ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
        title={isListening ? '停止语音输入' : '语音输入'}
      >
        {isListening ? (
          <MicOff className="size-4" />
        ) : (
          <Mic className="size-4" />
        )}
      </button>
      {isListening && interimText && (
        <div className="absolute bottom-full right-0 mb-1 max-w-[200px] bg-popover border border-border rounded-md shadow-lg px-2.5 py-1.5 text-xs text-foreground">
          <div className="flex items-center gap-1.5 mb-1">
            <Loader2 className="size-3 text-red-400 animate-spin" />
            <span className="text-[10px] text-red-400 font-medium">正在聆听...</span>
          </div>
          <p className="text-muted-foreground line-clamp-3">{interimText}</p>
        </div>
      )}
      {isListening && (
        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 animate-ping" />
      )}
    </div>
  )
}