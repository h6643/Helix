'use client'

import dynamic from 'next/dynamic'

const HelixLayout = dynamic(
  () => import('@/components/Helix/helix-layout').then(m => ({ default: m.HelixLayout })),
  {
    ssr: false,
    loading: () => (
      <div className="h-screen w-screen flex items-center justify-center bg-[#FCFBF9]">
        <div className="text-sm text-[#2D2A24]/40">Loading Helix...</div>
      </div>
    ),
  }
)

export default function Home() {
  return <HelixLayout />
}