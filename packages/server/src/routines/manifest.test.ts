import { describe, expect, it } from 'vitest';
import { checkCode, syntaxOnly } from './manifest.js';

const main = 'export async function main() {}\n';
const codes = (code: string) => checkCode(code).map((p) => [p.code, p.at]);

describe('routine code check', () => {
  it('finds imports and require in code, at their line', () => {
    expect(codes(`import x from 'y';\n${main}`)).toEqual([['import_not_allowed', '1:1']]);
    expect(codes(`${main}const m = await import('fs');`)).toEqual([['import_not_allowed', '2:1']]);
    expect(codes(`${main}const fs = require ('fs');`)).toEqual([['import_not_allowed', '2:1']]);
    // A template's `${…}` is code.
    expect(codes(`${main}const t = \`a \${await import('fs')} b\`;`)).toEqual([
      ['import_not_allowed', '2:1'],
    ]);
  });

  it('ignores import and require inside strings, templates and comments', () => {
    const code = `${main}const a = "Never call import(...)";
const b = 'require(x) is not here \\' import(y)';
const c = \`import(z) \${'require(w)'} and \${{ n: 1 }.n} require(v)\`;
// import(u)
/* require(t)
   import(s) */
const d = 1; // require(r)`;
    expect(codes(code)).toEqual([]);
  });

  it('a main only in a comment or a string is missing', () => {
    expect(codes(`// export async function main() {}\nconst x = 1;`)).toEqual([
      ['missing_main', undefined],
    ]);
  });

  it('keeps lines and columns', () => {
    const code = `const a = 'x'; /* y\nz */ const b = \`q\${a}\`;`;
    const syntax = syntaxOnly(code);
    expect(syntax).toHaveLength(code.length);
    expect(syntax.split('\n')).toEqual(["const a = ' ';     ", '     const b = ` ${a}`;']);
  });
});
