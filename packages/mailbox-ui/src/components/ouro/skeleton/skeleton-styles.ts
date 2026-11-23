export const stillMs = 1000;
export const breathMs = 2400;

/**
 * Where a placeholder that mounts at `now` joins the shared wave: a new wave starts after a
 * gap of over `stillMs` with nothing breathing, and the delay puts the placeholder in step
 * with the wave.
 */
export function joinWave(now: number, breathing: number, emptiedAt: number, waveStart: number): { start: number; delay: string } {
  const start = breathing === 0 && now - emptiedAt > stillMs ? now : waveStart;
  const elapsed = now - start;
  return { start, delay: `${-((elapsed - stillMs) % breathMs)}ms` };
}
