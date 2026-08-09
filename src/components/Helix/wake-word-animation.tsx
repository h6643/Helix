'use client'

import React, { useEffect, useState } from 'react'

interface WakeWordAnimationProps {
  show: boolean
  onComplete?: () => void
}

export function WakeWordAnimation({ show, onComplete }: WakeWordAnimationProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (show) {
      setVisible(true)
      const timer = setTimeout(() => {
        setVisible(false)
        onComplete?.()
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [show, onComplete])

  if (!visible) return null

  return (
    <>
      {/* Screen edge flash */}
      <div
        className="fixed inset-0 z-[9999] pointer-events-none"
        style={{
          background: 'transparent',
          boxShadow: 'inset 0 0 120px 40px rgba(59, 130, 246, 0.5)',
          animation: 'edgeFlash 1.5s ease-out forwards',
        }}
      />

      {/* Center animation */}
      <div className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-none">
        <div className="relative">
          {/* Concentric rings */}
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="absolute inset-0 rounded-full border-2 border-blue-400"
              style={{
                animation: `pulseRing 1.5s ease-out ${i * 0.2}s forwards`,
                opacity: 0,
              }}
            />
          ))}

          {/* Center dot */}
          <div
            className="w-4 h-4 rounded-full bg-blue-500"
            style={{
              animation: 'centerPulse 1.5s ease-out forwards',
              boxShadow: '0 0 20px 10px rgba(59, 130, 246, 0.6)',
            }}
          />

          {/* Text */}
          <div
            className="absolute top-12 left-1/2 -translate-x-1/2 whitespace-nowrap text-blue-400 font-medium text-sm"
            style={{ animation: 'fadeInUp 0.3s ease-out 0.2s both' }}
          >
            唤醒成功
          </div>
        </div>
      </div>

      <style>{`
        @keyframes edgeFlash {
          0% { box-shadow: inset 0 0 120px 40px rgba(59, 130, 246, 0.6); }
          100% { box-shadow: inset 0 0 0px 0px rgba(59, 130, 246, 0); }
        }

        @keyframes pulseRing {
          0% {
            transform: scale(0.5);
            opacity: 0.8;
            border-width: 3px;
          }
          100% {
            transform: scale(4);
            opacity: 0;
            border-width: 1px;
          }
        }

        @keyframes centerPulse {
          0% {
            transform: scale(1);
            box-shadow: 0 0 20px 10px rgba(59, 130, 246, 0.6);
          }
          50% {
            transform: scale(1.5);
            box-shadow: 0 0 40px 20px rgba(59, 130, 246, 0.4);
          }
          100% {
            transform: scale(0);
            box-shadow: 0 0 0px 0px rgba(59, 130, 246, 0);
          }
        }

        @keyframes fadeInUp {
          0% { opacity: 0; transform: translate(-50%, 10px); }
          100% { opacity: 1; transform: translate(-50%, 0); }
        }
      `}</style>
    </>
  )
}
