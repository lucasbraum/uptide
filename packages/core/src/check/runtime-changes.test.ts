import { describe, expect, it } from 'vitest';
import { runtimeChangeFindings } from './runtime-changes.js';

describe('curated runtime changes', () => {
  const meta = { package: 'express', from: '4.21.2', to: '5.2.1' };
  const text = [
    "app.del('/things/:id', handler);",
    "const id = req.param('id');",
    "res.send(404, 'nope');",
    "app.get('/files/*', serve);",
    "app.get('/users/:id?', show);",
    "app.get('/ok/:id', show);",
    'res.send(body);',
  ].join('\n');
  it('flags express 4 -> 5 behaviour changes as unverified, labeled as runtime changes', () => {
    const out = runtimeChangeFindings(meta, [{ file: 'src/app.js', text }]);
    expect(out.map((f) => `${f.usage.line} ${f.severity}`)).toEqual([
      '1 unverified',
      '2 unverified',
      '3 unverified',
      '4 unverified',
      '5 unverified',
    ]);
    expect(out[0]?.reason).toBe(
      'runtime change, not visible in types: app.del() was removed; use app.delete()',
    );
  });
  it('applies only across the curated major', () => {
    expect(
      runtimeChangeFindings({ package: 'express', from: '5.0.0', to: '5.2.1' }, [
        { file: 'a.js', text },
      ]),
    ).toEqual([]);
    expect(
      runtimeChangeFindings({ package: 'express', from: '4.0.0', to: '4.21.2' }, [
        { file: 'a.js', text },
      ]),
    ).toEqual([]);
    expect(
      runtimeChangeFindings({ package: 'koa', from: '1.0.0', to: '3.0.0' }, [
        { file: 'a.js', text },
      ]),
    ).toEqual([]);
  });
});
