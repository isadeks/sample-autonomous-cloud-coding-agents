/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

/**
 * ``bgagent repo onboard --service-containers <file>``: containers that run next
 * to the agent in its ECS Fargate task (docs/design/COMPUTE.md, "Service
 * containers"). The orchestrator derives the repo's task definition from them at
 * task start; this module only validates the file so a typo fails at onboarding.
 */

import * as fs from 'fs';
import { CliError } from './errors';

/** A container health check, in ECS's own terms (seconds; ECS defaults when unset). */
export interface ServiceHealthCheck {
  /** ``["CMD", ...]`` or ``["CMD-SHELL", "<shell command>"]``. */
  readonly command: string[];
  readonly interval_s?: number;
  readonly timeout_s?: number;
  readonly retries?: number;
  readonly start_period_s?: number;
}

/** A shared volume mounted into a service container. */
export interface ServiceMount {
  /** Name of a volume declared in {@link ServiceContainersConfig.volumes}. */
  readonly volume: string;
  /** Absolute path inside the service container. */
  readonly path: string;
  readonly read_only?: boolean;
}

/** One service container. Environment values are plain text in the task definition: no secrets. */
export interface ServiceContainerSpec {
  readonly name: string;
  readonly image: string;
  /** When true, the task (and the agent with it) stops if this container exits. Default false. */
  readonly essential?: boolean;
  readonly command?: string[];
  readonly entry_point?: string[];
  readonly environment?: Record<string, string>;
  /** Container ports. Informational: every container in the task shares localhost. */
  readonly ports?: number[];
  /** With a health check the agent waits for HEALTHY, without one for START. */
  readonly health_check?: ServiceHealthCheck;
  readonly mounts?: ServiceMount[];
  readonly user?: string;
  readonly working_directory?: string;
}

/**
 * A task-scoped volume (Fargate ephemeral storage) shared by the agent and the
 * services that mount it, e.g. the workspace, so a service running the app's
 * runtime image can serve the agent's own build.
 */
export interface SharedVolumeSpec {
  readonly name: string;
  /** Absolute mount path in the agent container (owned by the agent user). */
  readonly agent_path: string;
}

/** RepoTable ``service_containers``. */
export interface ServiceContainersConfig {
  readonly containers: ServiceContainerSpec[];
  readonly volumes?: SharedVolumeSpec[];
}

/** The agent's container in the ECS task definition (``EcsAgentCluster``); a service may not reuse it. */
export const AGENT_CONTAINER_NAME = 'AgentContainer';

/** Root container that hands the shared volumes to the agent user before the agent starts. */
export const VOLUME_INIT_CONTAINER_NAME = 'abca-volume-init';

/** Fargate allows 10 containers per task definition: the agent, the volume init, and these. */
export const MAX_SERVICE_CONTAINERS = 8;

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Agent-container paths a shared volume must not cover: the image's own files. */
const PROTECTED_AGENT_PATHS = [
  '/app', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/opt', '/proc',
  '/root', '/run', '/sbin', '/sys', '/usr', '/var',
];

const CONTAINER_KEYS = new Set([
  'name', 'image', 'essential', 'command', 'entry_point', 'environment', 'ports',
  'health_check', 'mounts', 'user', 'working_directory',
]);
const HEALTH_CHECK_KEYS = new Set(['command', 'interval_s', 'timeout_s', 'retries', 'start_period_s']);
const MOUNT_KEYS = new Set(['volume', 'path', 'read_only']);
const VOLUME_KEYS = new Set(['name', 'agent_path']);

/** ECS's accepted ranges for the health-check fields (seconds, except retries). */
const HEALTH_INTERVAL_MIN_S = 5;
const HEALTH_INTERVAL_MAX_S = 300;
const HEALTH_TIMEOUT_MIN_S = 2;
const HEALTH_TIMEOUT_MAX_S = 120;
const HEALTH_RETRIES_MAX = 10;
const HEALTH_START_PERIOD_MAX_S = 300;
const HEALTH_CHECK_BOUNDS: Record<string, [number, number]> = {
  interval_s: [HEALTH_INTERVAL_MIN_S, HEALTH_INTERVAL_MAX_S],
  timeout_s: [HEALTH_TIMEOUT_MIN_S, HEALTH_TIMEOUT_MAX_S],
  retries: [1, HEALTH_RETRIES_MAX],
  start_period_s: [0, HEALTH_START_PERIOD_MAX_S],
};

const MAX_PORT = 65535;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(s => typeof s === 'string');
}

function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string): string[] {
  return Object.keys(obj).filter(k => !allowed.has(k)).map(k => `${where}: unknown field '${k}'`);
}

function isAbsolutePath(p: unknown): p is string {
  return typeof p === 'string' && p.startsWith('/') && p.length > 1 && !p.split('/').includes('..');
}

/**
 * Validate a ``service_containers`` value and return every problem found. A copy
 * of ``validateServiceContainers`` in ``cdk/src/handlers/shared/ecs-service-containers.ts``,
 * which re-validates at task start; both are tested against
 * ``contracts/service-containers/cases.json``.
 *
 * @param raw - the stored value.
 * @param agentContainerName - the agent container's name, which a service may not reuse.
 * @returns the error messages; empty when the config is valid.
 */
export function validateServiceContainers(raw: unknown, agentContainerName: string): string[] {
  if (!isRecord(raw)) return ['service_containers must be an object with a "containers" list'];
  const errors = unknownKeys(raw, new Set(['containers', 'volumes']), 'service_containers');
  const containers = raw.containers;
  const volumes = raw.volumes ?? [];
  if (!Array.isArray(containers) || containers.length === 0) {
    errors.push('service_containers.containers must be a non-empty list');
    return errors;
  }
  if (containers.length > MAX_SERVICE_CONTAINERS) {
    errors.push(`service_containers.containers: at most ${MAX_SERVICE_CONTAINERS} containers (Fargate allows 10 per task, including the agent's)`);
  }
  if (!Array.isArray(volumes)) {
    errors.push('service_containers.volumes must be a list');
    return errors;
  }

  const volumeNames = new Set<string>();
  volumes.forEach((v, i) => {
    const where = `service_containers.volumes[${i}]`;
    if (!isRecord(v)) {
      errors.push(`${where} must be an object`);
      return;
    }
    errors.push(...unknownKeys(v, VOLUME_KEYS, where));
    if (typeof v.name !== 'string' || !NAME_PATTERN.test(v.name)) {
      errors.push(`${where}.name must match ${NAME_PATTERN}`);
    } else if (volumeNames.has(v.name)) {
      errors.push(`${where}.name '${v.name}' is declared twice`);
    } else {
      volumeNames.add(v.name);
    }
    if (!isAbsolutePath(v.agent_path)) {
      errors.push(`${where}.agent_path must be an absolute path without '..'`);
    } else if (PROTECTED_AGENT_PATHS.some(p => v.agent_path === p || (v.agent_path as string).startsWith(`${p}/`))) {
      errors.push(`${where}.agent_path '${v.agent_path}' would hide the agent image's files (${PROTECTED_AGENT_PATHS.join(', ')})`);
    }
  });

  const names = new Set<string>();
  containers.forEach((c, i) => {
    const where = `service_containers.containers[${i}]`;
    if (!isRecord(c)) {
      errors.push(`${where} must be an object`);
      return;
    }
    errors.push(...unknownKeys(c, CONTAINER_KEYS, where));
    if (typeof c.name !== 'string' || !NAME_PATTERN.test(c.name)) {
      errors.push(`${where}.name must match ${NAME_PATTERN}`);
    } else if (c.name === agentContainerName || c.name === VOLUME_INIT_CONTAINER_NAME) {
      errors.push(`${where}.name '${c.name}' is reserved`);
    } else if (names.has(c.name)) {
      errors.push(`${where}.name '${c.name}' is used twice`);
    } else {
      names.add(c.name);
    }
    if (typeof c.image !== 'string' || !c.image.trim()) errors.push(`${where}.image must be a non-empty string`);
    if (c.essential !== undefined && typeof c.essential !== 'boolean') errors.push(`${where}.essential must be a boolean`);
    for (const key of ['command', 'entry_point'] as const) {
      if (c[key] !== undefined && !isStringArray(c[key])) errors.push(`${where}.${key} must be a list of strings`);
    }
    for (const key of ['user', 'working_directory'] as const) {
      if (c[key] !== undefined && typeof c[key] !== 'string') errors.push(`${where}.${key} must be a string`);
    }
    if (c.environment !== undefined) {
      if (!isRecord(c.environment)) {
        errors.push(`${where}.environment must be an object of string values`);
      } else {
        for (const [k, v] of Object.entries(c.environment)) {
          if (!ENV_NAME_PATTERN.test(k)) errors.push(`${where}.environment: invalid variable name '${k}'`);
          if (typeof v !== 'string') errors.push(`${where}.environment.${k} must be a string`);
        }
      }
    }
    if (c.ports !== undefined && !(Array.isArray(c.ports)
      && c.ports.every(p => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= MAX_PORT))) {
      errors.push(`${where}.ports must be a list of port numbers`);
    }
    if (c.health_check !== undefined) {
      const hc = c.health_check;
      if (!isRecord(hc)) {
        errors.push(`${where}.health_check must be an object`);
      } else {
        errors.push(...unknownKeys(hc, HEALTH_CHECK_KEYS, `${where}.health_check`));
        if (!isStringArray(hc.command) || hc.command.length < 2 || !['CMD', 'CMD-SHELL'].includes(hc.command[0])) {
          errors.push(`${where}.health_check.command must be ["CMD", ...] or ["CMD-SHELL", "<command>"]`);
        }
        for (const [key, [min, max]] of Object.entries(HEALTH_CHECK_BOUNDS)) {
          const v = hc[key];
          if (v !== undefined && !(Number.isInteger(v) && (v as number) >= min && (v as number) <= max)) {
            errors.push(`${where}.health_check.${key} must be an integer between ${min} and ${max}`);
          }
        }
      }
    }
    if (c.mounts !== undefined) {
      if (!Array.isArray(c.mounts)) {
        errors.push(`${where}.mounts must be a list`);
      } else {
        c.mounts.forEach((m, j) => {
          const mw = `${where}.mounts[${j}]`;
          if (!isRecord(m)) {
            errors.push(`${mw} must be an object`);
            return;
          }
          errors.push(...unknownKeys(m, MOUNT_KEYS, mw));
          if (typeof m.volume !== 'string' || !volumeNames.has(m.volume)) {
            errors.push(`${mw}.volume must name a volume declared in service_containers.volumes`);
          }
          if (!isAbsolutePath(m.path)) errors.push(`${mw}.path must be an absolute path without '..'`);
          if (m.read_only !== undefined && typeof m.read_only !== 'boolean') errors.push(`${mw}.read_only must be a boolean`);
        });
      }
    }
  });
  return errors;
}

/**
 * Read and validate a ``--service-containers`` JSON file.
 * @throws CliError when the file cannot be read, is not JSON, or is invalid.
 */
export function readServiceContainersFile(path: string): ServiceContainersConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new CliError(`--service-containers: cannot read ${path} as JSON: ${(err as Error).message}`);
  }
  const errors = validateServiceContainers(raw, AGENT_CONTAINER_NAME);
  if (errors.length) {
    throw new CliError(`--service-containers: ${path} is invalid:\n  - ${errors.join('\n  - ')}`);
  }
  return raw as ServiceContainersConfig;
}
