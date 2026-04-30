export type Star = {
  x: number; // normalized [0, 1]
  y: number; // normalized [0, 1]
  r: number;
  baseAlpha: number;
  twinkleSpeed: number;
  twinklePhase: number;
  depth: number; // 0..1, smaller = farther
  hue: number; // 0 = white, 1 = brand-tinted
};

// Stars are seeded once in normalized [0, 1] coords. Window resizes scale them
// to pixel positions at render time instead of reshuffling the field.
export function seedStars(count: number, rng: () => number = Math.random): Star[] {
  return new Array(count).fill(0).map(() => {
    const depth = Math.pow(rng(), 1.6); // bias toward far
    return {
      x: rng(),
      y: rng(),
      r: 0.3 + depth * 1.6,
      baseAlpha: 0.25 + depth * 0.7,
      twinkleSpeed: 0.4 + rng() * 1.4,
      twinklePhase: rng() * Math.PI * 2,
      depth,
      hue: rng() < 0.25 ? 1 : 0,
    };
  });
}
