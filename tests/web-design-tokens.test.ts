import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tokens = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");

// Calculate sRGB contrast from the opaque OKLCH palette, not rendered browser output.
function luminance(name: string): number {
  const match = tokens.match(new RegExp(`--color-${name}: oklch\\(([\\d.]+)% ([\\d.]+) ([\\d.]+)\\)`));
  assert.ok(match, `opaque OKLCH token: ${name}`);
  const lightness = Number(match[1]) / 100;
  const chroma = Number(match[2]);
  const hue = Number(match[3]) * Math.PI / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const [red, green, blue] = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ].map((channel) => Math.max(0, Math.min(1, channel)));
  return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("workbench text palette retains normal-text contrast on its reading surfaces", () => {
  for (const foreground of ["ink", "ink-soft", "muted", "error", "warning", "success"]) {
    for (const background of ["paper", "paper-2", "canvas", "selected"]) {
      assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
    }
  }
});

test("primary action text retains contrast in both resting and hover palettes", () => {
  for (const background of ["accent", "accent-hover"]) {
    assert.ok(contrast("accent-ink", background) >= 4.5, background);
  }
});

test("control and focus palette remains distinct from raised and canvas surfaces", () => {
  for (const foreground of ["control-border", "focus"]) {
    for (const background of ["paper", "canvas"]) {
      assert.ok(contrast(foreground, background) >= 3, `${foreground} on ${background}`);
    }
  }
});
