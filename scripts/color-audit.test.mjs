import { describe, expect, it } from 'vitest';
import { auditCss, auditVue } from './color-audit.mjs';

describe('color-audit', () => {
  it('finds hex, rgb and hsl literals in declarations', () => {
    const css = '.a{\n  color: #fff;\n  background: rgba(0, 0, 0, .5);\n  border-color: hsl(10 20% 30%);\n  fill: var(--ok);\n}';
    expect(auditCss(css).map((h) => h.line)).toEqual([2, 3, 4]);
  });

  it('skips selectors, comments and token references', () => {
    const css = '#add {\n  color: var(--paper);\n}\n/* was #ffffff */\n.b{background:color-mix(in srgb, var(--paper) 6%, transparent)}';
    expect(auditCss(css)).toEqual([]);
  });

  it('finds named white and black but not white-space', () => {
    const css = '.a{\n  color: white;\n  background: black;\n  white-space: nowrap;\n}';
    expect(auditCss(css).map((h) => h.line)).toEqual([2, 3]);
  });

  it('does not take identifiers that start like hex for colors', () => {
    expect(auditCss('.x{grid-area:#cafe-zone; content:"a#bed"}')).toEqual([]);
  });

  it('reads only style blocks of a vue file and reports file lines', () => {
    const vue = '<template>\n  <div style="color:#fff"></div>\n</template>\n<style scoped>\n.a{color:#123456}\n</style>';
    expect(auditVue(vue)).toEqual([{ line: 5, text: '.a{color:#123456}' }]);
  });
});
