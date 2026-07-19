import type { SystemCapability } from "@/bindings";

export interface RecommendCandidate {
  id: string;
  speedScore: number;
  accuracyScore: number;
  /** Approximate memory (MB) the model needs to run comfortably. */
  vramNeedMb: number;
}

export interface Recommendations {
  /** Best balanced pick that fits this machine comfortably. */
  machine: string | null;
  /** Most accurate pick that fits. */
  accuracy: string | null;
  /** Fastest pick. */
  speed: string | null;
}

/**
 * Pick machine / accuracy / speed recommendations from a set of candidates,
 * given the detected hardware. GPU VRAM is the budget when present; otherwise a
 * conservative share of system RAM (CPU inference). Everything degrades
 * gracefully: with no capability info, all candidates are considered to fit.
 */
export function recommendModels(
  candidates: RecommendCandidate[],
  cap: SystemCapability | null,
): Recommendations {
  if (candidates.length === 0) {
    return { machine: null, accuracy: null, speed: null };
  }

  const budget = !cap
    ? Infinity
    : cap.has_gpu && cap.vram_mb > 0
      ? cap.vram_mb
      : Math.floor(cap.ram_mb * 0.5);

  const fitting = candidates.filter((c) => c.vramNeedMb <= budget);
  const pool = fitting.length ? fitting : candidates;

  const speed =
    [...pool].sort((a, b) => b.speedScore - a.speedScore)[0]?.id ?? null;
  const accuracy =
    [...pool].sort((a, b) => b.accuracyScore - a.accuracyScore)[0]?.id ?? null;

  // Machine pick favors a balance of speed and accuracy among models that fit
  // with headroom to spare, so real-time cleanup stays responsive.
  const comfy = candidates.filter((c) => c.vramNeedMb <= budget * 0.6);
  const machinePool = comfy.length ? comfy : pool;
  const balanced = (c: RecommendCandidate) =>
    0.5 * c.accuracyScore + 0.5 * c.speedScore;
  const machine =
    [...machinePool].sort((a, b) => balanced(b) - balanced(a))[0]?.id ?? null;

  return { machine, accuracy, speed };
}
