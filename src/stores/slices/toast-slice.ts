/**
 * Toast notification slice.
 * Isolated domain: toasts[] is consumed by ToastContainer; showToast/dismissToast
 * are called from many places but only read/write this slice's own state.
 */
import type { StateCreator } from 'zustand'
import type { ToastMessage } from '../helix-types'
import { generateId } from '@/lib/format'

export interface ToastSlice {
  toasts: ToastMessage[]
  showToast: (toast: Omit<ToastMessage, 'id'>) => void
  dismissToast: (id: string) => void
}

export const createToastSlice: StateCreator<ToastSlice, [], [], ToastSlice> = (set) => ({
  toasts: [],
  showToast: (toast) => {
    const id = generateId()
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }))
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter(t => t.id !== id) }))
    }, toast.duration || 3000)
  },
  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter(t => t.id !== id) })),
})
