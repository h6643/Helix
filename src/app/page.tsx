'use client'

import dynamic from 'next/dynamic'

const HelixLayout = dynamic(
  () => import('@/components/Helix/helix-layout').then(m => ({ default: m.HelixLayout })),
  {
    ssr: false,
    loading: () => (
      <div className="h-screen w-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading Helix...</div>
      </div>
    ),
  }
)

export default function Home() {
  return <HelixLayout />
}