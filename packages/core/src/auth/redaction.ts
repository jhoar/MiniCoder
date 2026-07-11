export interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const DEFAULT_REPLACEMENT = '[REDACTED]';

const DEFAULT_RULES: RedactionRule[] = [
  {
    pattern:
      /("(?:token|apiKey|api_key|password|secret|credential|privateKey|private_key|accessKey|access_key|accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|webhookSecret|webhook_secret|signingSecret|signing_secret|authorization)":\s*)"[^"]*"/gi,
    replacement: `$1"${DEFAULT_REPLACEMENT}"`,
  },
  { pattern: /\b(gh[ps]_[A-Za-z0-9]{36,})\b/g, replacement: DEFAULT_REPLACEMENT },
  { pattern: /\b(sk-[A-Za-z0-9]{32,})\b/g, replacement: DEFAULT_REPLACEMENT },
  { pattern: /\b(glpat-[A-Za-z0-9\-_]{20,})\b/g, replacement: DEFAULT_REPLACEMENT },
  { pattern: /(Authorization:\s*Bearer\s+)\S+/gi, replacement: `$1${DEFAULT_REPLACEMENT}` },
];

export class SecretRedactor {
  private readonly rules: RedactionRule[];

  constructor(rules: RedactionRule[] = DEFAULT_RULES) {
    this.rules = rules;
  }

  redact(input: string): string {
    let result = input;
    for (const rule of this.rules) {
      const re = new RegExp(
        rule.pattern.source,
        rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g',
      );
      result = result.replace(re, rule.replacement);
    }
    return result;
  }

  /**
   * Phase 16 addition (docs/07 "private chain-of-thought is never stored" verification):
   * a non-mutating check reusing the exact same rule set `redact()` already applies, rather than
   * a second, independently-maintained pattern library. Returns the human-readable replacement
   * text of every rule that matched (deduped), for use by a defense-in-depth audit check (e.g.
   * `state doctor`'s secret-leak scan) over already-persisted rows — it never redacts anything
   * itself; `redact()`/`redactObject()` remain the only write-path redaction mechanism.
   */
  scanForSecrets(input: string): string[] {
    const hits: string[] = [];
    for (const rule of this.rules) {
      const re = new RegExp(
        rule.pattern.source,
        rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g',
      );
      if (re.test(input)) {
        hits.push(rule.pattern.source);
      }
    }
    return hits;
  }

  redactObject<T>(obj: T): T {
    if (typeof obj === 'string') {
      return this.redact(obj) as unknown as T;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactObject(item)) as unknown as T;
    }
    if (obj !== null && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof value === 'string' && SECRET_FIELD_NAMES.has(key.toLowerCase())) {
          result[key] = DEFAULT_REPLACEMENT;
        } else {
          result[key] = this.redactObject(value);
        }
      }
      return result as T;
    }
    return obj;
  }
}

const SECRET_FIELD_NAMES = new Set([
  'token',
  'apikey',
  'api_key',
  'password',
  'secret',
  'credential',
  'privatekey',
  'private_key',
  'accesskey',
  'access_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'clientsecret',
  'client_secret',
  'webhooksecret',
  'webhook_secret',
  'signingsecret',
  'signing_secret',
  'authorization',
]);

export const defaultRedactor = new SecretRedactor();
