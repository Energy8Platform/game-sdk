/**
 * Adapter loader.
 *
 * Loads a `BookAdapter` either:
 *  - from a passed-in module / instance (preferred when bundling),
 *  - or by dynamically `import()`-ing a script at a URL (default
 *    convention: `<assetsUrl>/stake-adapter.js`).
 */

import type {
  BookAdapter,
  AdapterModule,
  AdapterFactoryOptions,
} from './types';

/**
 * Resolve any adapter form (raw object, factory, factory promise) into
 * a concrete `BookAdapter` instance.
 */
export async function resolveAdapter(
  candidate: BookAdapter | AdapterModule,
  options: AdapterFactoryOptions,
): Promise<BookAdapter> {
  if (typeof candidate === 'function') {
    const result = (candidate as (
      o?: AdapterFactoryOptions,
    ) => BookAdapter | Promise<BookAdapter>)(options);
    return await Promise.resolve(result);
  }
  return candidate as BookAdapter;
}

/**
 * Default convention for the per-game adapter URL.
 *
 * @example
 *   defaultAdapterUrl('https://cdn/games/sweet-bonanza/bundle/')
 *   // → 'https://cdn/games/sweet-bonanza/bundle/stake-adapter.js'
 */
export function defaultAdapterUrl(assetsUrl: string): string {
  if (!assetsUrl) {
    throw new Error('defaultAdapterUrl: assetsUrl is empty');
  }
  return assetsUrl.endsWith('/')
    ? `${assetsUrl}stake-adapter.js`
    : `${assetsUrl}/stake-adapter.js`;
}

/**
 * Dynamically import a per-game adapter script. The script must be an
 * ES module exposing the adapter as its default export (instance or factory).
 */
export async function loadAdapter(
  url: string,
  options: AdapterFactoryOptions,
): Promise<BookAdapter> {
  // `/* @vite-ignore */` is harmless in non-Vite bundlers and prevents
  // build-time URL rewriting in Vite.
  const mod = (await import(/* @vite-ignore */ url)) as {
    default?: BookAdapter | AdapterModule;
  };

  const candidate = mod.default;
  if (!candidate) {
    throw new Error(
      `Adapter at ${url} has no default export. Expected a BookAdapter or factory.`,
    );
  }

  return resolveAdapter(candidate, options);
}
