import React, { useState, useRef } from 'react'
import { Check, Copy, Download } from 'lucide-react'
import 'highlight.js/styles/github-dark.css'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

export const markdownPlugins = {
  remarkPlugins: [remarkGfm],
}

// Click-to-zoom image for assistant messages (multimodal output)
const LightboxImage = ({ src, alt }: { src?: string; alt?: string }) => {
  const [open, setOpen] = useState(false)
  if (!src) return null
  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={() => setOpen(true)}
        className="rounded-lg max-w-full h-auto my-2 cursor-zoom-in hover:opacity-90 transition-opacity"
      />
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8 cursor-zoom-out"
          onClick={() => setOpen(false)}
        >
          <img src={src} alt={alt} className="max-w-full max-h-full rounded-lg" />
        </div>
      )}
    </>
  )
}

export const markdownComponents: Components = {
  a: ({ href, children, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
  ),
  img: ({ src, alt }) => <LightboxImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
  // Code block wrapper with a copy button (syntax highlighting added via rehype plugin upstream)
  pre: ({ children }) => {
    const ref = useRef<HTMLPreElement>(null)
    const [copied, setCopied] = useState(false)
    const onCopy = () => {
      const text = ref.current?.textContent || ''
      if (navigator.clipboard) navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
    return (
      <div className="relative group my-3 rounded-xl overflow-hidden border border-border/40">
        <button
          type="button"
          onClick={onCopy}
          className="absolute right-2 top-2 z-10 px-1.5 py-1 rounded bg-muted/80 text-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
        <pre ref={ref}>{children}</pre>
      </div>
    )
  },
}
