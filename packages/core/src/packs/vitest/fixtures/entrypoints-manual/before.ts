import { test } from 'vitest';
import { VitestTestRunner } from 'vitest/runners'; // @uptide removed-entrypoints-manual at:'vitest/runners'
import { getCurrentTest } from 'vitest/suite'; // @uptide removed-entrypoints-manual at:'vitest/suite'
import { HoistMocker } from 'vitest/mocker'; // @uptide removed-entrypoints-manual at:'vitest/mocker'
import { createRunner } from 'vitest/node'; // @uptide removed-entrypoints-manual keep

test('keeps the specifiers it cannot swap', () => {
  void [VitestTestRunner, getCurrentTest, HoistMocker, createRunner];
});
