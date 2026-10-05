/**
 * Thompson sampling over CTA variants. Each arm's click-through rate has a
 * Beta posterior; the arm with the highest draw is shown. The prior is
 * centred on the pooled click-through rate (worth `PRIOR_STRENGTH` views), so
 * a brand-new variant starts "about average, very uncertain" rather than
 * "anything from 0–100%", which would send it almost all traffic at first.
 */
export type Arm = { id: string; impressions: number; clicks: number };

const PRIOR_STRENGTH = 10;

export function chooseArm<T extends Arm>(arms: T[], random: () => number = Math.random): T | null {
  const totalClicks = arms.reduce((sum, arm) => sum + arm.clicks, 0);
  const totalViews = arms.reduce((sum, arm) => sum + arm.impressions, 0);
  const pooled = (totalClicks + 1) / (totalViews + 2);
  let best: T | null = null;
  let bestDraw = -1;
  for (const arm of arms) {
    const clicks = Math.min(arm.clicks, arm.impressions);
    const draw = sampleBeta(
      clicks + pooled * PRIOR_STRENGTH,
      arm.impressions - clicks + (1 - pooled) * PRIOR_STRENGTH,
      random,
    );
    if (draw > bestDraw) {
      best = arm;
      bestDraw = draw;
    }
  }
  return best;
}

/** Monte Carlo estimate of each arm's probability of having the best click-through rate. */
export function probabilityBest(arms: Arm[], draws = 4000, random: () => number = Math.random): Map<string, number> {
  const wins = new Map(arms.map((arm) => [arm.id, 0]));
  for (let i = 0; i < draws; i++) {
    const winner = chooseArm(arms, random);
    if (winner) wins.set(winner.id, (wins.get(winner.id) ?? 0) + 1);
  }
  return new Map([...wins].map(([id, count]) => [id, count / draws]));
}

function sampleNormal(random: () => number): number {
  let u = 0;
  while (u === 0) u = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** Marsaglia–Tsang gamma sampler; shapes below 1 use the standard boost. */
function sampleGamma(shape: number, random: () => number): number {
  if (shape < 1) return sampleGamma(shape + 1, random) * Math.pow(random() || Number.MIN_VALUE, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal(random);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number, random: () => number = Math.random): number {
  const x = sampleGamma(alpha, random);
  const y = sampleGamma(beta, random);
  return x / (x + y);
}
