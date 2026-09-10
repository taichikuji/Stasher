const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const css = readFileSync(join(__dirname, '../src/manager/manager.css'), 'utf8');

function pair(name) {
  const match = css.match(new RegExp(`--${name}: light-dark\\(#([0-9a-f]{6}), #([0-9a-f]{6})\\)`));
  assert.ok(match, `missing ${name} light-dark pair`);
  return match.slice(1).map(hexToRgb);
}

function hexToRgb(hex) {
  return hex.match(/../g).map(value => Number.parseInt(value, 16));
}

function mix(foreground, amount, background) {
  return foreground.map((value, index) => value * amount + background[index] * (1 - amount));
}

function luminance(rgb) {
  const [red, green, blue] = rgb.map(value => {
    value /= 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function expectContrast(label, foreground, background, minimum) {
  const ratio = contrast(foreground, background);
  assert.ok(ratio >= minimum, `${label}: ${ratio.toFixed(2)}:1 is below ${minimum}:1`);
}

test('manager color roles meet WCAG 2.2 contrast targets', () => {
  const base = pair('base');
  const mantle = pair('mantle');
  const surface0 = pair('surface0');
  const surface = [hexToRgb('ffffff'), surface0[1]];
  const text = pair('text');
  const subtext = pair('subtext0');
  const overlay = pair('overlay0');
  const blue = pair('blue');

  for (const mode of [0, 1]) {
    const name = mode === 0 ? 'light' : 'dark';
    expectContrast(`${name} text on surface`, text[mode], surface[mode], 4.5);
    expectContrast(`${name} secondary text on base`, subtext[mode], base[mode], 4.5);
    expectContrast(`${name} input boundary`, overlay[mode], base[mode], 3);
    expectContrast(`${name} focus indicator`, blue[mode], base[mode], 3);
  }

  const fallback = [hexToRgb('1b5cdd'), blue[1]];
  expectContrast('light favicon fallback', fallback[0], mantle[0], 4.5);
  expectContrast('dark favicon fallback', fallback[1], mantle[1], 4.5);

  const tint = [0.149, 0.247];
  const tintBase = [hexToRgb('ffffff'), surface0[1]];
  for (const name of ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']) {
    const rule = css.match(new RegExp(`\\.color-${name}[^}]+--group-color: light-dark\\(#([0-9a-f]{6}), #([0-9a-f]{6})\\); --group-text: light-dark\\(#([0-9a-f]{6}), #([0-9a-f]{6})\\)`));
    assert.ok(rule, `missing ${name} group colors`);
    const colors = rule.slice(1).map(hexToRgb);
    for (const mode of [0, 1]) {
      const background = mix(colors[mode], tint[mode], tintBase[mode]);
      expectContrast(`${mode === 0 ? 'light' : 'dark'} ${name} badge`, colors[mode + 2], background, 4.5);
    }
  }
});
