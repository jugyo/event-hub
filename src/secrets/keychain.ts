import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SecretBackendError, type SecretBackend } from "./backend.ts";

interface CommandResult {
  code: number | null;
  stdout: string;
}
type CommandRunner = (path: string, args: string[], input?: string) => Promise<CommandResult>;

export interface KeychainSecretBackendOptions {
  projectRoot: string;
  securityPath?: string;
  clangPath?: string;
  runCommand?: CommandRunner;
}

const WRITE_HELPER_SOURCE = String.raw`
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc != 4) return 1;
  size_t capacity = 1024, length = 0;
  unsigned char *bytes = malloc(capacity);
  if (!bytes) return 1;
  for (;;) {
    if (length == capacity) {
      capacity *= 2;
      unsigned char *larger = realloc(bytes, capacity);
      if (!larger) { free(bytes); return 1; }
      bytes = larger;
    }
    size_t count = fread(bytes + length, 1, capacity - length, stdin);
    length += count;
    if (count == 0) break;
  }

  CFStringRef service = CFStringCreateWithCString(NULL, argv[1], kCFStringEncodingUTF8);
  CFStringRef account = CFStringCreateWithCString(NULL, argv[2], kCFStringEncodingUTF8);
  CFDataRef value = CFDataCreate(NULL, bytes, (CFIndex)length);
  free(bytes);
  if (!service || !account || !value) return 1;

  const void *queryKeys[] = { kSecClass, kSecAttrService, kSecAttrAccount, kSecUseAuthenticationUI };
  const void *queryValues[] = { kSecClassGenericPassword, service, account, kSecUseAuthenticationUIFail };
  CFDictionaryRef query = CFDictionaryCreate(NULL, queryKeys, queryValues, 4,
    &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  OSStatus status;
  if (strcmp(argv[3], "update") == 0) {
    const void *keys[] = { kSecValueData };
    const void *values[] = { value };
    CFDictionaryRef attributes = CFDictionaryCreate(NULL, keys, values, 1,
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    status = SecItemUpdate(query, attributes);
    CFRelease(attributes);
  } else {
    const void *keys[] = { kSecClass, kSecAttrService, kSecAttrAccount, kSecValueData, kSecUseAuthenticationUI };
    const void *values[] = { kSecClassGenericPassword, service, account, value, kSecUseAuthenticationUIFail };
    CFDictionaryRef item = CFDictionaryCreate(NULL, keys, values, 5,
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    status = SecItemAdd(item, NULL);
    CFRelease(item);
  }
  CFRelease(query); CFRelease(value); CFRelease(account); CFRelease(service);
  return status == errSecSuccess ? 0 : 1;
}
`;

function serviceName(projectRoot: string): string {
  const projectId = createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 24);
  return `event-hub:${projectId}`;
}

function runSecurity(path: string, args: string[], input?: string): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(path, args, {
      env: {},
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolveCommand({ code, stdout }));
    child.stdin.end(input);
  });
}

export class KeychainSecretBackend implements SecretBackend {
  readonly #service: string;
  readonly #securityPath: string;
  readonly #clangPath: string;
  readonly #runCommand: CommandRunner;

  constructor(options: KeychainSecretBackendOptions) {
    this.#service = serviceName(options.projectRoot);
    this.#securityPath = options.securityPath ?? "/usr/bin/security";
    this.#clangPath = options.clangPath ?? "/usr/bin/clang";
    this.#runCommand = options.runCommand ?? runSecurity;
  }

  async #read(name: string): Promise<CommandResult> {
    try {
      return await this.#runCommand(this.#securityPath, [
        "find-generic-password",
        "-a",
        name,
        "-s",
        this.#service,
        "-w",
      ]);
    } catch {
      throw new SecretBackendError("UNAVAILABLE");
    }
  }

  async #find(name: string): Promise<CommandResult> {
    try {
      return await this.#runCommand(this.#securityPath, ["find-generic-password", "-a", name, "-s", this.#service]);
    } catch {
      throw new SecretBackendError("UNAVAILABLE");
    }
  }

  async create(name: string, value: string): Promise<void> {
    const current = await this.#find(name);
    if (current.code === 0) throw new SecretBackendError("ALREADY_EXISTS");
    if (current.code !== 44) throw new SecretBackendError("UNAVAILABLE");
    await this.#write(name, value, false);
  }

  async update(name: string, value: string): Promise<void> {
    const current = await this.#find(name);
    if (current.code === 44) throw new SecretBackendError("NOT_FOUND");
    if (current.code !== 0) throw new SecretBackendError("UNAVAILABLE");
    await this.#write(name, value, true);
  }

  async #write(name: string, value: string, update: boolean): Promise<void> {
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "event-hub-keychain-"));
      const helper = join(directory, "write-keychain");
      const compiled = await this.#runCommand(
        this.#clangPath,
        ["-framework", "Security", "-framework", "CoreFoundation", "-x", "c", "-o", helper, "-"],
        WRITE_HELPER_SOURCE,
      );
      if (compiled.code !== 0) throw new Error("helper compile failed");
      const result = await this.#runCommand(helper, [this.#service, name, update ? "update" : "create"], value);
      if (result.code !== 0) throw new Error("helper write failed");
    } catch {
      throw new SecretBackendError("UNAVAILABLE");
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async get(name: string): Promise<string> {
    const result = await this.#read(name);
    if (result.code === 44) throw new SecretBackendError("NOT_FOUND");
    if (result.code !== 0) throw new SecretBackendError("UNAVAILABLE");
    return result.stdout.replace(/\r?\n$/, "");
  }

  async delete(name: string): Promise<void> {
    let result: CommandResult;
    try {
      result = await this.#runCommand(this.#securityPath, ["delete-generic-password", "-a", name, "-s", this.#service]);
    } catch {
      throw new SecretBackendError("UNAVAILABLE");
    }
    if (result.code === 44) throw new SecretBackendError("NOT_FOUND");
    if (result.code !== 0) throw new SecretBackendError("UNAVAILABLE");
  }
}
