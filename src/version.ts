/**
 * Package version reported by status and doctor output.
 * Injected at build time by tsdown's `define` from package.json; the string
 * guard keeps an undefined build harmless.
 */
declare const __DSH_QODER_VERSION__: string

export const QODER_CONNECT_VERSION: string =
  typeof __DSH_QODER_VERSION__ === 'string' ? __DSH_QODER_VERSION__ : '0.0.0-dev'
