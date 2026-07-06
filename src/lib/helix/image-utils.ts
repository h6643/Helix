/**
 * Image processing utilities for clipboard paste support
 */

import type { ImageAttachment } from '@/stores/helix-store'

const MAX_IMAGE_SIZE = 2048 // Maximum dimension in pixels
const MAX_IMAGES_PER_MESSAGE = 5
const SUPPORTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export function validateImageType(type: string): boolean {
  return SUPPORTED_TYPES.includes(type)
}

export function generateImageId(): string {
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export async function getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = reject
    img.src = dataUrl
  })
}

export async function compressImage(dataUrl: string, maxWidth: number = MAX_IMAGE_SIZE, quality: number = 0.85): Promise<string> {
  const { width, height } = await getImageDimensions(dataUrl)

  // No compression needed if already within limits
  if (width <= maxWidth && height <= maxWidth) {
    return dataUrl
  }

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataUrl

  // Calculate new dimensions maintaining aspect ratio
  let newWidth = width
  let newHeight = height
  if (width > height) {
    newWidth = Math.min(width, maxWidth)
    newHeight = Math.round((height / width) * newWidth)
  } else {
    newHeight = Math.min(height, maxWidth)
    newWidth = Math.round((width / height) * newHeight)
  }

  canvas.width = newWidth
  canvas.height = newHeight

  const img = await loadImage(dataUrl)
  ctx.drawImage(img, 0, 0, newWidth, newHeight)

  return canvas.toDataURL('image/jpeg', quality)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

export async function processClipboardImage(blob: Blob): Promise<ImageAttachment | null> {
  if (!validateImageType(blob.type)) {
    return null
  }

  const dataUrl = await blobToDataUrl(blob)
  const compressed = await compressImage(dataUrl)
  const { width, height } = await getImageDimensions(compressed)

  return {
    id: generateImageId(),
    dataUrl: compressed,
    mediaType: blob.type,
    width,
    height,
    name: `clipboard-image-${Date.now()}.${blob.type.split('/')[1] || 'png'}`,
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

export function canAddMoreImages(currentCount: number, newCount: number): boolean {
  return currentCount + newCount <= MAX_IMAGES_PER_MESSAGE
}

export function getImagePreviewSize(attachment: ImageAttachment): { width: number; height: number } {
  const maxSize = 80
  const { width = maxSize, height = maxSize } = attachment

  if (width <= maxSize && height <= maxSize) {
    return { width, height }
  }

  if (width > height) {
    return { width: maxSize, height: Math.round((height / width) * maxSize) }
  } else {
    return { height: maxSize, width: Math.round((width / height) * maxSize) }
  }
}