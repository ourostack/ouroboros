export { returnFocusTo };

/**
 * The focus an overlay returns to on close: its trigger, `target`, unless another dialog opened since
 * has it. Base UI returns focus to an explicit `finalFocus` whatever has focus, so a dialog that closes
 * while the next one opens (its exit transition still runs) would take focus from that dialog. Focus can
 * sit on a focus guard or on `<body>` while the newer dialog is open, so the check looks at the open dialogs instead.
 *
 * @internal Shared by Dialog and Sheet; apps don't need it. Pass it from `finalFocus` as a function that
 * reads the ref when the overlay closes: `finalFocus: () => returnFocusTo(triggerRef.current)`.
 * @claim "Focus can sit on a focus guard or on `<body>` while the newer dialog is open" test:registry/ouro/components/ouro/dialog/dialog.sheet-overlap.test.tsx::an overlay opened while the one before it is still closing > keeps Tab inside the second sheet, and the page behind it hidden, after Escape on the first verify:testExists(registry/ouro/components/ouro/dialog/dialog.sheet-overlap.test.tsx::an overlay opened while the one before it is still closing > keeps Tab inside the second sheet, and the page behind it hidden, after Escape on the first)
 */
function returnFocusTo(target: HTMLElement | null): HTMLElement | null | undefined {
  const newer = [...document.querySelectorAll<HTMLElement>('[role="dialog"][data-open], [role="alertdialog"][data-open]')].some(
    (dialog) => !dialog.contains(target),
  );
  return newer ? undefined : target;
}
