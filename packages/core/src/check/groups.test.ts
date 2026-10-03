import { describe, expect, it } from 'vitest';
import { groupName, releaseGroups } from './groups.js';

describe('release groups', () => {
  it('joins same-scope, same-major packages that depend on one another', () => {
    const groups = releaseGroups([
      {
        name: '@aws-sdk/client-s3',
        installed: '3.1076.0',
        dependsOn: ['@aws-sdk/core', '@smithy/types'],
      },
      { name: '@aws-sdk/lib-storage', installed: '3.1076.0', dependsOn: ['@aws-sdk/client-s3'] },
      {
        name: '@aws-sdk/s3-request-presigner',
        installed: '3.1076.0',
        dependsOn: ['@aws-sdk/core'],
      },
      { name: '@aws-sdk/core', installed: '3.1076.0', dependsOn: ['@smithy/core'] },
      { name: '@aws-sdk/cloudfront-signer', installed: '3.1098.0', dependsOn: [] },
      { name: '@smithy/types', installed: '4.0.0', dependsOn: [] },
      { name: 'zod', installed: '3.25.76', dependsOn: [] },
    ]);
    expect(groups).toEqual([
      [
        '@aws-sdk/client-s3',
        '@aws-sdk/core',
        '@aws-sdk/lib-storage',
        '@aws-sdk/s3-request-presigner',
      ],
    ]);
    expect(groupName(groups[0] as string[])).toBe('@aws-sdk/*');
    expect(groupName(['zod'])).toBe('zod');
  });

  it('does not join scoped packages with no edge, nor through an unscoped shared dependency', () => {
    expect(
      releaseGroups([
        { name: '@fastify/cors', installed: '11.2.0', dependsOn: ['fastify'] },
        { name: '@fastify/rate-limit', installed: '10.3.0', dependsOn: ['fastify'] },
        { name: '@scope/a', installed: '1.0.0', dependsOn: [] },
        { name: '@scope/b', installed: '1.0.0', dependsOn: [] },
      ]),
    ).toEqual([]);
  });

  it('joins packages on different majors when one depends on the other explicitly', () => {
    expect(
      releaseGroups([
        { name: '@bull-board/api', installed: '6.14.0', dependsOn: [] },
        { name: '@bull-board/express', installed: '5.23.0', dependsOn: ['@bull-board/api'] },
      ]),
    ).toEqual([['@bull-board/api', '@bull-board/express']]);
  });
});

describe('release groups through shared dependencies', () => {
  it('joins two candidates through a same-scope dependency that is not itself a candidate', () => {
    expect(
      releaseGroups([
        { name: '@aws-sdk/client-s3', installed: '3.1076.0', dependsOn: ['@aws-sdk/core'] },
        {
          name: '@aws-sdk/s3-request-presigner',
          installed: '3.1076.0',
          dependsOn: ['@aws-sdk/core'],
        },
        { name: '@aws-sdk/other', installed: '3.1076.0', dependsOn: ['@smithy/core'] },
      ]),
    ).toEqual([['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner']]);
  });
});
