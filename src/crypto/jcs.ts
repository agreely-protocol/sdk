// A strict, NUMBER-FREE JCS (RFC 8785) canonicalizer — a byte-for-byte port of
// the Agreely app's App\Models\Crypto\Canonicalizer (spec rule 17.1). The output
// is the deterministic UTF-8 byte string a verifier re-canonicalizes and hashes,
// so it MUST match the PHP SDK and the server exactly:
//
//   - Accepts ONLY strings, objects, arrays, booleans and null.
//   - THROWS on any number (numbers are the classic cross-language footgun;
//     anything numeric a claim needs travels as a string).
//   - No whitespace in the output. Object keys are ASCII-only, byte-order sorted.
//   - Strings: escape only " and \ and the control range U+0000-U+001F, using the
//     short forms \b \t \n \f \r where they exist, otherwise \u00xx. "/" is NOT
//     escaped. Non-ASCII passes through as raw UTF-8.

/** A value the canonicalizer accepts (no numbers). */
export type JcsValue = string | boolean | null | JcsValue[] | { [key: string]: JcsValue };

/** Canonicalize a value to its JCS UTF-8 string. Throws on numbers / bad keys. */
export function canonicalize(value: unknown): string {
  return encodeValue(value);
}

function encodeValue(value: unknown): string {
  if (typeof value === "string") return encodeString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "bigint") {
    throw new JcsError(
      `Canonicalizer: numbers are forbidden (got ${String(value)}). Numeric values must travel as strings.`,
    );
  }
  if (Array.isArray(value)) {
    return "[" + value.map(encodeValue).join(",") + "]";
  }
  if (typeof value === "object") {
    return encodeObject(value as Record<string, unknown>);
  }
  throw new JcsError(`Canonicalizer: unsupported value of type ${typeof value}.`);
}

function encodeObject(object: Record<string, unknown>): string {
  const keys = Object.keys(object);
  for (const key of keys) {
    if (!isAscii(key)) throw new JcsError("Canonicalizer: object keys must be ASCII-only.");
  }
  // Byte-order sort. For ASCII keys this equals RFC 8785's UTF-16 sort.
  keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(encodeString(key) + ":" + encodeValue(object[key]));
  }
  return "{" + parts.join(",") + "}";
}

function encodeString(input: string): string {
  let out = '"';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    const code = input.charCodeAt(i);
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\r":
        out += "\\r";
        break;
      default:
        if (code < 0x20) {
          out += "\\u" + code.toString(16).padStart(4, "0");
        } else {
          out += ch;
        }
    }
  }
  return out + '"';
}

function isAscii(s: string): boolean {
  return !/[^\x00-\x7F]/.test(s);
}

/** Thrown when a value cannot be canonicalized (a number, a non-ASCII key, …). */
export class JcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JcsError";
  }
}
