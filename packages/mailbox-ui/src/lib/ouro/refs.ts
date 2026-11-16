"use client";

import { useCallback, type Ref, type RefCallback } from "react";

/**
 * Points `ref` at `element` and returns what undoes it. Handles object refs,
 * callback refs, and React 19 callback refs that return their own cleanup.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 * @claim "Handles object refs, callback refs, and" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::Sheet parts > forwards a ref passed to SheetBackdrop, as an object or a callback)
 * @claim "Handles object refs, callback refs, and" https://react.dev/blog/2024/12/05/react-19#cleanup-functions-for-refs verify:urlOk(https://react.dev/blog/2024/12/05/react-19#cleanup-functions-for-refs)
 */
export function attachRef<T>(ref: Ref<T> | undefined, element: T): () => void {
  if (typeof ref === "function") {
    const cleanup = ref(element);
    return typeof cleanup === "function" ? cleanup : () => ref(null);
  }
  if (ref) {
    ref.current = element;
    return () => {
      ref.current = null;
    };
  }
  return () => {};
}

/**
 * One callback ref that sets both an app's `ref` and a component's own ref, so a
 * component can hold an element the app also wants.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 *
 * @example
 * const own = useRef<HTMLElement>(null);
 * const ref = useMergedRef(trigger.props.ref, own);
 */
export function useMergedRef<T>(appRef: Ref<T> | undefined, ownRef: Ref<T>): RefCallback<T> {
  return useCallback(
    (element: T) => {
      const detachOwn = attachRef(ownRef, element);
      const detachApp = attachRef(appRef, element);
      return () => {
        detachOwn();
        detachApp();
      };
    },
    [appRef, ownRef],
  );
}
