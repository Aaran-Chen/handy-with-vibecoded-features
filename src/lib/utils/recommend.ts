import type { SystemCapability } from "@/bindings";

export interface RecommendCandidate {
  id: string;
  speedScore: number;
  accuracyScore: number;
  /** Approximate memory (MB) the model needs to run comfortably. */
  vramNeedMb: number;
  /**
   * Whether this model can run on the GPU in this build (transcribe-cpp /
   * Vulkan). ONNX models are CPU-only on Windows, so on a GPU machine their
   * catalog speed scores (CPU-relative) understate how much faster the
   * GPU-capable models actually run.
   */
  gpuCapable?: boolean;
  /**
   * Number of languages the model supports. The machine pick prefers
   * broad-language models so the headline recommendation isn't a narrow
   * specialist; leave undefined to opt out of that preference.
   */
  languageCount?: number;
}

export interface Recommendations {
  /** Best pick for this machine: accuracy-first among models that run fast here. */
  machine: string | null;
  /** Most accurate pick that fits. */
  accuracy: string | null;
  /** Fastest pick that still has near-top accuracy. */
  speed: string | null;
}

/** Effective speed on this machine. GPU-capable models are lifted above
 * CPU-only ones when a GPU is present (their catalog scores are CPU-relative),
 * using a monotonic rescale (50 + s/2) so ordering among GPU models is
 * preserved instead of saturating at a cap. */
const effectiveSpeed = (c: RecommendCandidate, hasGpu: boolean): number =>
  hasGpu && c.gpuCapable ? 50 + c.speedScore / 2 : c.speedScore;

/**
 * Pick machine / accuracy / speed recommendations from a set of candidates,
 * given the detected hardware.
 *
 * - Budget: GPU VRAM when present, else half of system RAM (CPU inference).
 * - "Fastest" enforces an accuracy floor (within 6 points of the best
 *   available) so it never surfaces a fast-but-sloppy model.
 * - "For your machine" is accuracy-weighted: with a GPU, big models run fast
 *   anyway, so accuracy should dominate; GPU-capable models are preferred to
 *   keep the CPU free.
 */
export function recommendModels(
  candidates: RecommendCandidate[],
  cap: SystemCapability | null,
): Recommendations {
  if (candidates.length === 0) {
    return { machine: null, accuracy: null, speed: null };
  }

  const hasGpu = !!cap?.has_gpu && (cap?.vram_mb ?? 0) > 0;
  const budget = !cap
    ? Infinity
    : hasGpu
      ? cap.vram_mb
      : Math.floor(cap.ram_mb * 0.5);

  const fitting = candidates.filter((c) => c.vramNeedMb <= budget);
  const pool = fitting.length ? fitting : candidates;

  const maxAccuracy = Math.max(...pool.map((c) => c.accuracyScore));

  // Fastest with near-top accuracy (never a sloppy model).
  const speedPool = pool.filter((c) => c.accuracyScore >= maxAccuracy - 6);
  const speed =
    [...(speedPool.length ? speedPool : pool)].sort(
      (a, b) =>
        effectiveSpeed(b, hasGpu) - effectiveSpeed(a, hasGpu) ||
        b.accuracyScore - a.accuracyScore,
    )[0]?.id ?? null;

  // Most accurate; ties broken by what actually runs faster here.
  const accuracy =
    [...pool].sort(
      (a, b) =>
        b.accuracyScore - a.accuracyScore ||
        effectiveSpeed(b, hasGpu) - effectiveSpeed(a, hasGpu),
    )[0]?.id ?? null;

  // Machine pick: fits with headroom; on GPU machines prefer GPU-capable
  // models (CPU stays free, and they scale with the hardware) and weight
  // accuracy heavily since the GPU absorbs their compute cost.
  const comfy = pool.filter((c) => c.vramNeedMb <= budget * 0.6);
  let machinePool = comfy.length ? comfy : pool;
  if (hasGpu) {
    const gpuPool = machinePool.filter((c) => c.gpuCapable);
    if (gpuPool.length) machinePool = gpuPool;
  }
  // Prefer broad-language models for the headline pick (candidates without
  // language info pass through).
  const broad = machinePool.filter((c) => (c.languageCount ?? Infinity) >= 10);
  if (broad.length) machinePool = broad;
  const accuracyWeight = hasGpu ? 0.75 : 0.5;
  const balanced = (c: RecommendCandidate) =>
    accuracyWeight * c.accuracyScore +
    (1 - accuracyWeight) * effectiveSpeed(c, hasGpu);
  const machine =
    [...machinePool].sort((a, b) => balanced(b) - balanced(a))[0]?.id ?? null;

  return { machine, accuracy, speed };
}
