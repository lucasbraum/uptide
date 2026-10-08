import { useRef } from 'react';

export function Field({ onMount }: { onMount: (el: HTMLInputElement | null) => void }) {
  const input = useRef<HTMLInputElement | null>(null);
  let last: HTMLInputElement | null = null;
  return (
    <form>
      <input
        ref={(el) => (input.current = el)} // @uptide ref-callback-return at:ref
      />
      <input
        ref={(el) => { last = el; }} // @uptide ref-callback-return keep at:ref
      />
      <input
        ref={(el) => (last = el)} // @uptide ref-callback-return at:ref
        name="b"
      />
      <input ref={input} />
      <input ref={(el) => onMount(el)} />
      <input ref={(el) => (el ? (last = el) : null)} />
    </form>
  );
}

// An object key named ref is not a ref prop.
export const config = { ref: (el: unknown) => (el as { x: number }).x };
