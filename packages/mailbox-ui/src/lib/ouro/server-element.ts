import { Children, isValidElement, type ReactNode } from "react";

/**
 * Whether `node` is the lazy wrapper React's Flight client can hand a client component in
 * place of an element, or a list of them, that a Server Component passed
 * (https://github.com/facebook/react/issues/32392). The wrapper has no `type`, `props` or `key`.
 * @claim "The wrapper has no `type`, `props`" registry/ouro/lib/ouro/server-element.test.tsx verify:testExists(registry/ouro/lib/ouro/server-element.test.tsx::resolves a wrapper to the element inside it, with the element's own key)
 * @claim "The wrapper has no `type`, `props`" registry/ouro/lib/ouro/server-element.test.tsx verify:testExists(registry/ouro/lib/ouro/server-element.test.tsx::resolves a wrapper that holds a wrapper)
 */
const isWrapper = (node: unknown): boolean => (node as { $$typeof?: symbol } | null | undefined)?.$$typeof === Symbol.for("react.lazy");

/**
 * What a wrapper holds, with each element's own key. `Children.forEach` resolves the wrapper
 * and hands over the elements as they are; `Children.toArray` would give them new keys.
 * A wrapper still loading suspends, and one that failed throws its error.
 * @claim "What a wrapper holds, with each" registry/ouro/lib/ouro/server-element.test.tsx verify:testExists(registry/ouro/lib/ouro/server-element.test.tsx::gives every element of a list a wrapper holds, each with its own key)
 * @claim "What a wrapper holds, with each" registry/ouro/lib/ouro/server-element.test.tsx verify:testExists(registry/ouro/lib/ouro/server-element.test.tsx::resolves a wrapper to the element inside it, with the element's own key)
 */
function held(wrapper: unknown): ReactNode[] {
  const nodes: ReactNode[] = [];
  Children.forEach(wrapper as ReactNode, (node) => nodes.push(node));
  return nodes;
}

/**
 * The one element a Server Component passed as a prop or an item, resolved from React's lazy
 * wrapper so its `props` and `key` can be read and it can be cloned. Anything else comes back
 * unchanged, and so does a wrapper that holds no element or more than one, so cloning it
 * still fails loudly.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 * @claim "Anything else comes back unchanged, and" registry/ouro/lib/ouro/server-element.test.tsx verify:testExists(registry/ouro/lib/ouro/server-element.test.tsx::keeps a wrapper that holds no element, or more than one, so cloning it still fails loudly)
 */
export function serverElement<T>(element: T): T {
  if (!isWrapper(element)) return element;
  const nodes = held(element);
  return (nodes.length === 1 && isValidElement(nodes[0]) ? nodes[0] : element) as T;
}

/**
 * Children a Server Component passed, for a component that walks them by hand: what React's
 * lazy wrapper holds (every element of a list, not just the first), or `node` unchanged.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 * @claim "Children a Server Component passed, for" registry/ouro/lib/ouro/server-element.test.tsx verify:testExists(registry/ouro/lib/ouro/server-element.test.tsx::gives every element of a list a wrapper holds, each with its own key)
 * @claim "Children a Server Component passed, for" registry/ouro/lib/ouro/server-element.test.tsx verify:testExists(registry/ouro/lib/ouro/server-element.test.tsx::keeps a wrapper that holds no element, or more than one, so cloning it still fails loudly)
 */
export function serverNodes(node: ReactNode): ReactNode {
  return isWrapper(node) ? held(node) : node;
}

/**
 * Whether the element's `type` is a lazy reference, not a component: what a client
 * component's element has when a Server Component passed it. Such an element cannot be told
 * apart by `type === Component`, only by its props.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 */
export function hasLazyType(element: { type: unknown }): boolean {
  return isWrapper(element.type);
}
