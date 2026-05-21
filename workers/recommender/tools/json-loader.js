/**
 * Custom ESM loader hook that automatically adds `type: 'json'` import
 * attributes for `.json` files, working around Node 24's strict requirement.
 *
 * Usage: node --import ./tools/json-loader.js tools/capture-baseline.js
 */

export async function load(url, context, nextLoad) {
  if (url.endsWith('.json')) {
    const result = await nextLoad(url, { ...context, importAttributes: { type: 'json' } });
    return result;
  }
  return nextLoad(url, context);
}
