// Query-string parameters of the public GET routes docs/API.md v2.5 and v2.6). Every value is validated before any database or
// chain read, a parameter sent twice is refused (which one counts is anyone's guess), and an error names the parameter and never echoes
// what was sent.
import { ApiFail } from "./validate";

/** The one value of a query parameter, null when it is absent. A parameter sent twice is `400 bad_request` naming it. */
export function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  if (values.length > 1) throw new ApiFail(400, "bad_request", name);
  return values[0] ?? null;
}

/** One of `allowed`, null when the parameter is absent. */
export function oneOfParam<T extends string>(params: URLSearchParams, name: string, allowed: readonly T[]): T | null {
  const v = single(params, name);
  if (v === null) return null;
  if (!(allowed as readonly string[]).includes(v)) throw new ApiFail(400, "bad_request", name);
  return v as T;
}

/** A plain decimal integer in [min, max]: no sign, no spaces, no exponent, no hex, at most 9 digits. */
export function intParam(params: URLSearchParams, name: string, min: number, max: number, dflt: number): number {
  const v = single(params, name);
  if (v === null) return dflt;
  if (!/^[0-9]{1,9}$/.test(v)) throw new ApiFail(400, "bad_request", name);
  const n = Number(v);
  if (n < min || n > max) throw new ApiFail(400, "bad_request", name);
  return n;
}
