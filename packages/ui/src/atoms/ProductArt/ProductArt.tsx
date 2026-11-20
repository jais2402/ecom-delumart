import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

export type ProductArtProps = Omit<ComponentPropsWithRef<"svg">, "children" | "role" | "aria-label"> & {
  /** Base hue, 0 to 359. */
  hue: number;
  /** Any string; the same hue and seed always draw the same picture. */
  seed: string;
  /** Describes the picture. Pass an empty string when the art is purely decorative. */
  alt: string;
};

type Shape =
  | { id: string; kind: "circle"; cx: number; cy: number; r: number; fill: string }
  | { id: string; kind: "rect"; x: number; y: number; w: number; h: number; rot: number; fill: string }
  | { id: string; kind: "tri"; points: string; fill: string };

/** FNV-1a hash of the seed, then a small mulberry32 generator. Deterministic across server and client. */
function makeRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const n = (value: number): string => value.toFixed(1);
const wrapHue = (value: number): number => ((Math.round(value) % 360) + 360) % 360;

export function buildShapes(hue: number, seed: string): Shape[] {
  const rand = makeRandom(`${seed}:${hue}`);
  const palette = [
    `hsl(${wrapHue(hue)} 62% 42%)`,
    `hsl(${wrapHue(hue + 28)} 70% 58%)`,
    `hsl(${wrapHue(hue - 30)} 55% 30%)`,
    `hsl(${wrapHue(hue + 150)} 65% 64%)`,
  ];
  const count = 4 + Math.floor(rand() * 3);
  const shapes: Shape[] = [];
  for (let i = 0; i < count; i++) {
    const fill = palette[Math.floor(rand() * palette.length)] ?? palette[0] ?? "";
    const kind = Math.floor(rand() * 3);
    const id = `s${i}`;
    if (kind === 0) {
      shapes.push({
        id,
        kind: "circle",
        cx: 15 + rand() * 70,
        cy: 15 + rand() * 70,
        r: 8 + rand() * 20,
        fill,
      });
    } else if (kind === 1) {
      shapes.push({
        id,
        kind: "rect",
        x: 8 + rand() * 50,
        y: 8 + rand() * 50,
        w: 16 + rand() * 30,
        h: 16 + rand() * 30,
        rot: Math.floor(rand() * 90) - 45,
        fill,
      });
    } else {
      const x = 10 + rand() * 50;
      const y = 10 + rand() * 50;
      const s = 20 + rand() * 30;
      shapes.push({
        id,
        kind: "tri",
        points: `${n(x)},${n(y + s)} ${n(x + s / 2)},${n(y)} ${n(x + s)},${n(y + s)}`,
        fill,
      });
    }
  }
  return shapes;
}

/** Generated decorative illustration: a few geometric shapes on a tinted ground. Always square. */
export function ProductArt({ hue, seed, alt, className, ...props }: ProductArtProps) {
  const shapes = buildShapes(hue, seed);
  const a11y = alt ? { role: "img" as const, "aria-label": alt } : { "aria-hidden": true as const };
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: the name comes from aria-label, or the art is aria-hidden when decorative
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      className={cn("block aspect-square w-full overflow-hidden rounded-md", className)}
      {...a11y}
      {...props}
    >
      <rect width="100" height="100" fill={`hsl(${wrapHue(hue)} 45% 80%)`} />
      <circle cx="82" cy="18" r="9" fill={`hsl(${wrapHue(hue + 60)} 85% 72%)`} />
      {shapes.map((shape) => {
        if (shape.kind === "circle") {
          return <circle key={shape.id} cx={n(shape.cx)} cy={n(shape.cy)} r={n(shape.r)} fill={shape.fill} />;
        }
        if (shape.kind === "rect") {
          return (
            <rect
              key={shape.id}
              x={n(shape.x)}
              y={n(shape.y)}
              width={n(shape.w)}
              height={n(shape.h)}
              rx="3"
              fill={shape.fill}
              transform={`rotate(${shape.rot} ${n(shape.x + shape.w / 2)} ${n(shape.y + shape.h / 2)})`}
            />
          );
        }
        return <polygon key={shape.id} points={shape.points} fill={shape.fill} />;
      })}
      <rect y="86" width="100" height="14" fill={`hsl(${wrapHue(hue)} 50% 26%)`} opacity="0.35" />
    </svg>
  );
}
