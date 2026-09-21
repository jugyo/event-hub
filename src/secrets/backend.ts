export type SecretBackendErrorCode = "ALREADY_EXISTS" | "NOT_FOUND" | "UNAVAILABLE";

const messages: Record<SecretBackendErrorCode, string> = {
  ALREADY_EXISTS: "The secret already exists",
  NOT_FOUND: "The secret was not found",
  UNAVAILABLE: "The secret backend is unavailable",
};

export class SecretBackendError extends Error {
  readonly code: SecretBackendErrorCode;

  constructor(code: SecretBackendErrorCode) {
    super(messages[code]);
    this.name = "SecretBackendError";
    this.code = code;
  }
}

export interface SecretBackend {
  has?(name: string): Promise<boolean>;
  create(name: string, value: string): Promise<void>;
  update(name: string, value: string): Promise<void>;
  get(name: string): Promise<string>;
  delete(name: string): Promise<void>;
}
