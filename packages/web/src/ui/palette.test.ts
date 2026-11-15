import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATEGORY_COLORS } from './colors.js';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../style.css'), 'utf8');

const roots = [...css.matchAll(/:root\s*\{([^}]+)\}/g)].map((match) =>
  Object.fromEntries(
    [...(match[1] ?? '').matchAll(/(--[\w-]+):\s*(#[\da-f]+);/gi)].map((token) => [
      token[1],
      token[2],
    ]),
  ),
);
function luminance(hex: string) {
  const expanded = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join('') : hex.slice(1);
  const [red = 0, green = 0, blue = 0] = (expanded.match(/../g) ?? []).map((part) => {
    const value = Number.parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}
function contrast(tokens: Record<string, string>, foreground: string, background: string) {
  const fg = tokens[foreground],
    bg = tokens[background];
  if (!fg || !bg) throw new Error(`Missing contrast token: ${foreground} / ${background}`);
  const a = luminance(fg),
    b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

for (const [index, mode] of ['light', 'dark'].entries()) {
  describe(`${mode} palette accessibility`, () => {
    const tokens = roots[index] ?? {};
    it('keeps reading text and primary/selected labels at AA contrast', () => {
      for (const surface of ['--background', '--card', '--hover', '--selection']) {
        for (const text of ['--foreground', '--secondary-foreground', '--muted-foreground']) {
          expect(contrast(tokens, text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      }
      expect(contrast(tokens, '--primary-foreground', '--primary')).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens, '--selection-foreground', '--selection')).toBeGreaterThanOrEqual(4.5);
    });
    it('keeps category labels readable without relying on hue', () => {
      for (const color of CATEGORY_COLORS) {
        expect(
          contrast(tokens, `--category-${color}-fg`, `--category-${color}-bg`),
          color,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
    it('keeps focus rings and input boundaries distinguishable', () => {
      for (const surface of ['--background', '--card', '--selection']) {
        expect(contrast(tokens, '--ring', surface), `focus on ${surface}`).toBeGreaterThanOrEqual(
          3,
        );
        expect(contrast(tokens, '--input', surface), `input on ${surface}`).toBeGreaterThanOrEqual(
          3,
        );
      }
    });
  });
}
