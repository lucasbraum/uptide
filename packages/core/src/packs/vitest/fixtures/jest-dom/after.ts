import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest'; // @uptide jest-dom-matchers
import "@testing-library/jest-dom"; // @uptide jest-dom-matchers
import * as matchers from '@testing-library/jest-dom/matchers'; // @uptide jest-dom-matchers keep
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

afterEach(cleanup);
expect.extend(matchers);
export type Registered = TestingLibraryMatchers<unknown, void>;
