import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { CONFIG_FILENAME } from "../init.ts";
import { SecretBackendError, type SecretBackend } from "./backend.ts";

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface ProjectConfig {
  secrets?: Record<string, unknown>;
  [key: string]: unknown;
}

export class SecretConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretConfigurationError";
  }
}

async function readConfig(projectRoot: string): Promise<{ path: string; config: ProjectConfig }> {
  const path = resolve(projectRoot, CONFIG_FILENAME);
  let config: unknown;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new SecretConfigurationError(`Could not read ${CONFIG_FILENAME}`);
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new SecretConfigurationError(`${CONFIG_FILENAME} is invalid`);
  }
  const projectConfig = config as ProjectConfig;
  if (
    projectConfig.secrets !== undefined &&
    (typeof projectConfig.secrets !== "object" ||
      projectConfig.secrets === null ||
      Array.isArray(projectConfig.secrets))
  ) {
    throw new SecretConfigurationError("The secrets catalog is invalid");
  }
  return { path, config: projectConfig };
}

async function saveConfig(path: string, config: ProjectConfig): Promise<void> {
  const temporary = resolve(dirname(path), `.${CONFIG_FILENAME}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

type ConfigWriter = (path: string, config: ProjectConfig) => Promise<void>;

function validateName(name: string): void {
  if (!NAME_PATTERN.test(name))
    throw new SecretConfigurationError("Secret reference names must use environment variable syntax");
}

export class SecretService {
  readonly projectRoot: string;
  readonly backend: SecretBackend;
  readonly #writeConfig: ConfigWriter;

  constructor(projectRoot: string, backend: SecretBackend, writeConfig: ConfigWriter = saveConfig) {
    this.projectRoot = projectRoot;
    this.backend = backend;
    this.#writeConfig = writeConfig;
  }

  async list(): Promise<string[]> {
    const { config } = await readConfig(this.projectRoot);
    return Object.keys(config.secrets ?? {}).sort();
  }

  async create(name: string, value: string): Promise<void> {
    validateName(name);
    const { path, config } = await readConfig(this.projectRoot);
    if (Object.hasOwn(config.secrets ?? {}, name))
      throw new SecretConfigurationError("The secret reference is already registered");
    await this.backend.create(name, value);
    config.secrets = { ...config.secrets, [name]: { backend: "keychain" } };
    try {
      await this.#writeConfig(path, config);
    } catch (error) {
      await this.backend.delete(name).catch(() => {});
      throw error;
    }
  }

  async update(name: string, value: string): Promise<void> {
    validateName(name);
    const { config } = await readConfig(this.projectRoot);
    if (!Object.hasOwn(config.secrets ?? {}, name))
      throw new SecretConfigurationError("The secret reference is not registered");
    await this.backend.update(name, value);
  }

  async get(name: string): Promise<string> {
    validateName(name);
    const { config } = await readConfig(this.projectRoot);
    if (!Object.hasOwn(config.secrets ?? {}, name))
      throw new SecretConfigurationError("The secret reference is not registered");
    return this.backend.get(name);
  }

  async delete(name: string): Promise<void> {
    validateName(name);
    const { path, config } = await readConfig(this.projectRoot);
    if (!Object.hasOwn(config.secrets ?? {}, name))
      throw new SecretConfigurationError("The secret reference is not registered");
    try {
      await this.backend.delete(name);
    } catch (error) {
      // If only the previous config save failed after backend deletion, retrying repairs the catalog.
      if (!(error instanceof SecretBackendError) || error.code !== "NOT_FOUND") throw error;
    }
    const remaining = { ...config.secrets };
    delete remaining[name];
    config.secrets = remaining;
    await this.#writeConfig(path, config);
  }
}
