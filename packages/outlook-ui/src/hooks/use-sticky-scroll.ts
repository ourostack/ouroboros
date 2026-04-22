import { useCallback, useEffect, useRef } from "react"

const BOTTOM_STICKINESS_PX = 48

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_STICKINESS_PX
}

export function useStickyScroll<T extends HTMLElement>(trigger: unknown) {
  const ref = useRef<T>(null)
  const shouldStickRef = useRef(true)

  const onScroll = useCallback(() => {
    const element = ref.current
    if (!element) return
    shouldStickRef.current = isNearBottom(element)
  }, [])

  const preserveScroll = useCallback(() => {
    shouldStickRef.current = false
  }, [])

  useEffect(() => {
    const element = ref.current
    if (!element || !shouldStickRef.current) return
    element.scrollTop = element.scrollHeight
  }, [trigger])

  return { ref, onScroll, preserveScroll }
}
