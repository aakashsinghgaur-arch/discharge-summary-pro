// Helpers shared by the build and the tests: the print iframe of the original tool runs a small
// inline pagination script, which the Content-Security-Policy allows by its SHA-256 hash.
import { createHash } from 'node:crypto';

export function paginatorScript(engineSource) {
  const start = engineSource.indexOf('js="(function(){');
  const end = engineSource.indexOf("\n return '<!doctype html>", start);
  if (start < 0 || end < 0) throw new Error('print paginator script not found in form-engine.js');
  const expr = engineSource.slice(start + 3, end).trim().replace(/;$/, '');
  return Function(`"use strict";return (${expr});`)();
}
export const sha256 = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
