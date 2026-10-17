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
 * Per-repo service containers for the ECS substrate.
 *
 * A repo can declare containers (a database, a cache, the app's own runtime
 * image) that run NEXT TO the agent in the same Fargate task, so the agent can
 * start the app and run its UI checks and e2e tests before it pushes. RunTask
 * overrides cannot add containers, so the containers have to be in the task
 * definition: the orchestrator registers one task definition per repo at task
 * start — the stack's build task definition plus the services — and caches it
 * on the RepoTable row, keyed by a hash of the base revision and the config. No
 * CloudFormation resource per repo (the stack is close to the 500-resource
 * limit), and a deploy that rebuilds the agent image re-derives it on the next
 * task. See docs/design/COMPUTE.md ("Service containers").
 */

import { createHash } from 'crypto';
import {
  DeregisterTaskDefinitionCommand,
  DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand,
  type ContainerDefinition,
  type ECSClient,
  type LogConfiguration,
  type RegisterTaskDefinitionCommandInput,
  type Tag,
  type TaskDefinition,
} from '@aws-sdk/client-ecs';
import { type DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';

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

/** Root container that hands the shared volumes to the agent user before the agent starts. */
export const VOLUME_INIT_CONTAINER_NAME = 'abca-volume-init';

/** Fargate allows 10 containers per task definition: the agent, the volume init, and these. */
export const MAX_SERVICE_CONTAINERS = 8;

/** Bump when the derived task definition's shape changes, so cached ones are re-registered. */
const DERIVATION_VERSION = 1;

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
/** Hex characters kept of the config hash and of the repo-name hash in the family. */
const CONFIG_HASH_CHARS = 16;
const REPO_HASH_CHARS = 8;
const REPO_SLUG_MAX_CHARS = 100;
/** ECS limits: task-definition family name, tag value. */
const FAMILY_MAX_CHARS = 255;
const TAG_VALUE_MAX_CHARS = 256;

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
 * Validate a ``service_containers`` value (from the RepoTable, so possibly
 * hand-edited) and return every problem found. The CLI applies the same rules
 * at onboarding (``cli/src/service-containers.ts``); keep the two in step.
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

/** JSON with object keys sorted at every level, so equal configs hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Cache key of a derived task definition: the base revision it was built from
 * plus the service config. A deploy that registers a new base revision, or an
 * edit of the config, changes it.
 */
export function serviceTaskDefinitionHash(baseTaskDefinitionArn: string, config: ServiceContainersConfig): string {
  return createHash('sha256')
    .update(canonicalJson({ v: DERIVATION_VERSION, base: baseTaskDefinitionArn, config }))
    .digest('hex')
    .slice(0, CONFIG_HASH_CHARS);
}

/**
 * Family of a repo's derived task definition: the base family plus a readable
 * repo slug and a short hash of the exact repo name (two repos whose names only
 * differ in characters the slug drops still get different families).
 */
export function serviceTaskDefinitionFamily(baseFamily: string, repo: string): string {
  const slug = repo.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, REPO_SLUG_MAX_CHARS);
  const repoHash = createHash('sha256').update(repo).digest('hex').slice(0, REPO_HASH_CHARS);
  return `${baseFamily}-${slug}-${repoHash}`.slice(0, FAMILY_MAX_CHARS);
}

function logConfigurationFor(base: LogConfiguration | undefined, streamPrefix: string): LogConfiguration | undefined {
  if (!base) return undefined;
  return base.logDriver === 'awslogs'
    ? { ...base, options: { ...base.options, 'awslogs-stream-prefix': streamPrefix } }
    : base;
}

/**
 * The RegisterTaskDefinition input for a repo: the base (build) task
 * definition, unchanged except that
 *
 * - each service is added as a container that logs to the agent's log group
 *   under its own stream prefix;
 * - each shared volume is added as a task volume, mounted into the agent at its
 *   ``agent_path`` and handed to the agent user by a short-lived root container
 *   (a fresh Fargate bind volume is root-owned, and the agent runs as ``agent``);
 * - the agent container waits for every service (HEALTHY when it has a health
 *   check, START otherwise) and for the volume hand-over, and gets
 *   ``ABCA_SERVICE_CONTAINERS`` (comma-separated names).
 *
 * Task size, roles, network mode and platform are the base's: the services
 * share the build task's CPU and memory.
 */
export function buildServiceTaskDefinitionInput(
  base: TaskDefinition,
  config: ServiceContainersConfig,
  opts: { readonly family: string; readonly agentContainerName: string; readonly tags?: Tag[] },
): RegisterTaskDefinitionCommandInput {
  const agent = base.containerDefinitions?.find(c => c.name === opts.agentContainerName);
  if (!agent) {
    throw new Error(`Base task definition ${base.taskDefinitionArn ?? ''} has no container named ${opts.agentContainerName}`);
  }
  const volumes = config.volumes ?? [];
  const agentMounts = volumes.map(v => ({ sourceVolume: v.name, containerPath: v.agent_path, readOnly: false }));

  const services: ContainerDefinition[] = config.containers.map(c => ({
    name: c.name,
    image: c.image,
    essential: c.essential ?? false,
    ...(c.command && { command: c.command }),
    ...(c.entry_point && { entryPoint: c.entry_point }),
    ...(c.environment && {
      environment: Object.keys(c.environment).sort().map(name => ({ name, value: c.environment![name] })),
    }),
    ...(c.ports?.length && { portMappings: c.ports.map(containerPort => ({ containerPort, protocol: 'tcp' as const })) }),
    ...(c.health_check && {
      healthCheck: {
        command: c.health_check.command,
        ...(c.health_check.interval_s !== undefined && { interval: c.health_check.interval_s }),
        ...(c.health_check.timeout_s !== undefined && { timeout: c.health_check.timeout_s }),
        ...(c.health_check.retries !== undefined && { retries: c.health_check.retries }),
        ...(c.health_check.start_period_s !== undefined && { startPeriod: c.health_check.start_period_s }),
      },
    }),
    ...(c.mounts?.length && {
      mountPoints: c.mounts.map(m => ({ sourceVolume: m.volume, containerPath: m.path, readOnly: m.read_only ?? false })),
    }),
    ...(c.user && { user: c.user }),
    ...(c.working_directory && { workingDirectory: c.working_directory }),
    ...(logConfigurationFor(agent.logConfiguration, c.name) && {
      logConfiguration: logConfigurationFor(agent.logConfiguration, c.name),
    }),
  }));

  // The agent image's Dockerfile creates the `agent` user the agent runs as;
  // chown by name so this does not hard-code its uid.
  const volumeInit: ContainerDefinition[] = volumes.length ? [{
    name: VOLUME_INIT_CONTAINER_NAME,
    image: agent.image,
    essential: false,
    user: '0',
    entryPoint: ['chown'],
    command: ['agent:agent', ...volumes.map(v => v.agent_path)],
    mountPoints: agentMounts,
    ...(logConfigurationFor(agent.logConfiguration, VOLUME_INIT_CONTAINER_NAME) && {
      logConfiguration: logConfigurationFor(agent.logConfiguration, VOLUME_INIT_CONTAINER_NAME),
    }),
  }] : [];

  const agentContainer: ContainerDefinition = {
    ...agent,
    environment: [
      ...(agent.environment ?? []).filter(e => e.name !== 'ABCA_SERVICE_CONTAINERS'),
      { name: 'ABCA_SERVICE_CONTAINERS', value: config.containers.map(c => c.name).join(',') },
    ],
    mountPoints: [...(agent.mountPoints ?? []), ...agentMounts],
    dependsOn: [
      ...(agent.dependsOn ?? []),
      ...(volumes.length ? [{ containerName: VOLUME_INIT_CONTAINER_NAME, condition: 'SUCCESS' as const }] : []),
      ...config.containers.map(c => ({
        containerName: c.name,
        condition: c.health_check ? 'HEALTHY' as const : 'START' as const,
      })),
    ],
  };

  return {
    family: opts.family,
    taskRoleArn: base.taskRoleArn,
    executionRoleArn: base.executionRoleArn,
    networkMode: base.networkMode,
    requiresCompatibilities: base.requiresCompatibilities,
    cpu: base.cpu,
    memory: base.memory,
    ...(base.ephemeralStorage && { ephemeralStorage: base.ephemeralStorage }),
    ...(base.runtimePlatform && { runtimePlatform: base.runtimePlatform }),
    volumes: [...(base.volumes ?? []), ...volumes.map(v => ({ name: v.name }))],
    containerDefinitions: [
      ...base.containerDefinitions!.map(c => (c.name === opts.agentContainerName ? agentContainer : c)),
      ...volumeInit,
      ...services,
    ],
    ...(opts.tags?.length && { tags: opts.tags }),
  };
}

/** True when ``arn`` is a revision of ``family``. */
function isRevisionOf(arn: string, family: string): boolean {
  const ref = arn.replace(/:\d+$/, '');
  return ref === family || ref.endsWith(`:task-definition/${family}`);
}

export interface ResolveServiceTaskDefinitionInput {
  readonly repo: string;
  readonly config: ServiceContainersConfig;
  /** The stack's build task definition (revision-pinned ARN from the orchestrator env). */
  readonly baseTaskDefinitionArn: string;
  /** Its family, which the derived family is named after. */
  readonly baseFamily: string;
  readonly agentContainerName: string;
  /** What the repo row has cached from an earlier task. */
  readonly cachedArn?: string;
  readonly cachedHash?: string;
}

export interface ResolveServiceTaskDefinitionDeps {
  readonly ecs: Pick<ECSClient, 'send'>;
  readonly ddb: Pick<DynamoDBDocumentClient, 'send'>;
  /** RepoTable, where the derived ARN and its hash are cached (unset = no caching). */
  readonly repoTableName?: string;
}

/**
 * The task definition FAMILY to run a repo's task on: its derived family when
 * the cached one still matches, else a freshly registered revision.
 *
 * On a cache miss this registers the derived task definition, records it on the
 * repo row (best-effort: a failed write only means the next task registers
 * again) and deregisters the revision it replaces when that revision belongs to
 * the same derived family. The caller runs the FAMILY, so a concurrent task that
 * still holds the replaced ARN resolves to the latest ACTIVE revision too.
 *
 * @throws Error when the config is invalid or the registration fails; the task
 *   cannot run without its services.
 */
export async function resolveServiceTaskDefinition(
  input: ResolveServiceTaskDefinitionInput,
  deps: ResolveServiceTaskDefinitionDeps,
): Promise<{ readonly family: string; readonly registered: boolean }> {
  const errors = validateServiceContainers(input.config, input.agentContainerName);
  if (errors.length) {
    throw new Error(`Invalid service_containers for ${input.repo}: ${errors.join('; ')}`);
  }
  const family = serviceTaskDefinitionFamily(input.baseFamily, input.repo);
  const hash = serviceTaskDefinitionHash(input.baseTaskDefinitionArn, input.config);
  if (input.cachedArn && input.cachedHash === hash && isRevisionOf(input.cachedArn, family)) {
    return { family, registered: false };
  }

  const described = await deps.ecs.send(new DescribeTaskDefinitionCommand({
    taskDefinition: input.baseTaskDefinitionArn,
    include: ['TAGS'],
  }));
  if (!described.taskDefinition) {
    throw new Error(`Base task definition ${input.baseTaskDefinitionArn} not found`);
  }
  const tags: Tag[] = [
    ...(described.tags ?? []).filter(t => !t.key?.startsWith('abca:') && !t.key?.startsWith('aws:')),
    { key: 'abca:repo', value: input.repo.slice(0, TAG_VALUE_MAX_CHARS) },
    { key: 'abca:service-config-hash', value: hash },
  ];
  const registered = await deps.ecs.send(new RegisterTaskDefinitionCommand(
    buildServiceTaskDefinitionInput(described.taskDefinition, input.config, {
      family,
      agentContainerName: input.agentContainerName,
      tags,
    }),
  ));
  const arn = registered.taskDefinition?.taskDefinitionArn;
  if (!arn) throw new Error(`RegisterTaskDefinition returned no ARN for ${family}`);
  logger.info('Registered service task definition', { repo: input.repo, task_definition_arn: arn, config_hash: hash });

  if (deps.repoTableName) {
    try {
      await deps.ddb.send(new UpdateCommand({
        TableName: deps.repoTableName,
        Key: { repo: input.repo },
        UpdateExpression: 'SET ecs_task_definition_arn = :arn, ecs_task_definition_hash = :hash',
        ConditionExpression: 'attribute_exists(repo)',
        ExpressionAttributeValues: { ':arn': arn, ':hash': hash },
      }));
    } catch (err) {
      logger.warn('Failed to cache the service task definition on the repo row (non-fatal)', {
        repo: input.repo,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (input.cachedArn && input.cachedArn !== arn && isRevisionOf(input.cachedArn, family)) {
    try {
      await deps.ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: input.cachedArn }));
    } catch (err) {
      logger.warn('Failed to deregister the replaced service task definition (non-fatal)', {
        task_definition_arn: input.cachedArn,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { family, registered: true };
}
