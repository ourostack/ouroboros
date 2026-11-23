export { willOverflow };

/**
 * Whether the links need more room than they have, given whether they were already folded into the menu
 * button. Folding shows the button, which narrows the slot by the very room folding found missing; without a
 * margin on the unfold side, that narrowing alone can read as "still not enough room", and hiding the button
 * again to check puts the slot right back where the links did not fit either, flipping forever at a width
 * where they are only barely over (ourostack/ouro-ui#3168). So once folded, only unfold once the room clears
 * what the links need by a margin.
 *
 * @internal
 */
function willOverflow(wasFolded: boolean, needed: number, room: number): boolean {
  return wasFolded ? needed > room - 8 : needed > room;
}
