'use client'

import React from 'react'

export function FileCodeBlock({ language, children }: { language: string; children: string }) {
  return (
    <pre className="bg-muted rounded-lg p-4 overflow-x-auto text-sm">
      <code className={`language-${language}`}>{children}</code>
    </pre>
  )
}
