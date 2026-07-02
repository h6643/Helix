/**
 * Shared ReactMarkdown components configuration
 */

import React from 'react'
import { FileCodeBlock } from './chat-panel'

export const markdownComponents = {
  code({ className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || '')
    const isInline = !match && !className
    if (isInline) {
      return <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono text-primary" {...props}>{children}</code>
    }
    return <FileCodeBlock language={match ? match[1] : 'text'}>{String(children)}</FileCodeBlock>
  },
  p({ children }: any) { return <p className="mb-2 last:mb-0 text-foreground/85">{children}</p> },
  ul({ children }: any) { return <ul className="list-disc pl-5 mb-2 text-foreground/85">{children}</ul> },
  ol({ children }: any) { return <ol className="list-decimal pl-5 mb-2 text-foreground/85">{children}</ol> },
  strong({ children }: any) { return <strong className="font-semibold text-foreground">{children}</strong> },
  a({ children, href }: any) { return <a href={href} className="file-ref">{children}</a> },
}