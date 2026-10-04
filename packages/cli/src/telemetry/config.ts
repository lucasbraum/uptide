declare const __UPTIDE_TELEMETRY_KEY__: string | undefined;
declare const __UPTIDE_TELEMETRY_HOST__: string | undefined;

export const BUILD_KEY =
  typeof __UPTIDE_TELEMETRY_KEY__ === 'string' ? __UPTIDE_TELEMETRY_KEY__ : '';
export const BUILD_HOST =
  typeof __UPTIDE_TELEMETRY_HOST__ === 'string'
    ? __UPTIDE_TELEMETRY_HOST__
    : 'https://eu.i.posthog.com';

/** Origins only: no credentials, query, fragment or arbitrary capture path. */
export function captureUrl(host: string): string | undefined {
  try {
    const url = new URL(host);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      return undefined;
    return new URL('/capture/', url).href;
  } catch {
    return undefined;
  }
}
