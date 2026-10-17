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

import * as fs from 'fs';
import * as path from 'path';
import type { TaskDefinition } from '@aws-sdk/client-ecs';
import {
  buildServiceTaskDefinitionInput,
  resolveServiceTaskDefinition,
  serviceTaskDefinitionFamily,
  serviceTaskDefinitionHash,
  validateServiceContainers,
  VOLUME_INIT_CONTAINER_NAME,
  type ServiceContainersConfig,
} from '../../../src/handlers/shared/ecs-service-containers';

const CASES = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', '..', 'contracts', 'service-containers', 'cases.json'),
  'utf-8',
)) as { cases: { name: string; config: unknown; valid?: boolean; errors?: string[] }[] };

const BASE_ARN = 'arn:aws:ecs:us-east-1:123456789012:task-definition/stackEcsTaskDef:7';
const LOGS = {
  logDriver: 'awslogs' as const,
  options: { 'awslogs-group': 'agent-logs', 'awslogs-region': 'us-east-1', 'awslogs-stream-prefix': 'agent' },
};
const BASE: TaskDefinition = {
  taskDefinitionArn: BASE_ARN,
  family: 'stackEcsTaskDef',
  revision: 7,
  status: 'ACTIVE',
  taskRoleArn: 'arn:aws:iam::123456789012:role/task',
  executionRoleArn: 'arn:aws:iam::123456789012:role/exec',
  networkMode: 'awsvpc',
  requiresCompatibilities: ['FARGATE'],
  compatibilities: ['EC2', 'FARGATE'],
  cpu: '4096',
  memory: '16384',
  ephemeralStorage: { sizeInGiB: 50 },
  runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
  registeredBy: 'arn:aws:sts::123456789012:assumed-role/cfn',
  containerDefinitions: [{
    name: 'AgentContainer',
    image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/assets:abc',
    essential: true,
    environment: [{ name: 'TASK_TABLE_NAME', value: 'tasks' }],
    mountPoints: [],
    logConfiguration: LOGS,
  }],
};
const CONFIG: ServiceContainersConfig = CASES.cases[0].config as ServiceContainersConfig;

describe('validateServiceContainers (contracts/service-containers/cases.json)', () => {
  test.each(CASES.cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const errors = validateServiceContainers(c.config, 'AgentContainer');
    if (c.valid) {
      expect(errors).toEqual([]);
    } else {
      for (const expected of c.errors ?? []) {
        expect(errors.join('\n')).toContain(expected);
      }
    }
  });
});

describe('serviceTaskDefinitionHash', () => {
  test('ignores key order and changes with the base revision or the config', () => {
    const a = serviceTaskDefinitionHash(BASE_ARN, { containers: [{ name: 'pg', image: 'x', ports: [1] }] });
    const reordered = serviceTaskDefinitionHash(BASE_ARN, { containers: [{ ports: [1], image: 'x', name: 'pg' }] });
    expect(a).toBe(reordered);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(serviceTaskDefinitionHash(BASE_ARN.replace(':7', ':8'), { containers: [{ name: 'pg', image: 'x', ports: [1] }] })).not.toBe(a);
    expect(serviceTaskDefinitionHash(BASE_ARN, { containers: [{ name: 'pg', image: 'y', ports: [1] }] })).not.toBe(a);
  });
});

describe('serviceTaskDefinitionFamily', () => {
  test('is the base family plus a valid, distinct per-repo suffix', () => {
    const f = serviceTaskDefinitionFamily('stackEcsTaskDef', 'Org/my.repo');
    expect(f).toMatch(/^stackEcsTaskDef-org-my-repo-[0-9a-f]{8}$/);
    expect(serviceTaskDefinitionFamily('stackEcsTaskDef', 'Org/my-repo')).not.toBe(f);
    expect(serviceTaskDefinitionFamily('x'.repeat(250), 'o/r').length).toBeLessThanOrEqual(255);
  });
});

describe('buildServiceTaskDefinitionInput', () => {
  const input = buildServiceTaskDefinitionInput(BASE, CONFIG, {
    family: 'stackEcsTaskDef-o-r-12345678',
    agentContainerName: 'AgentContainer',
    tags: [{ key: 'project', value: 'p' }],
  });
  const byName = Object.fromEntries((input.containerDefinitions ?? []).map(c => [c.name, c]));

  test('keeps the base task shape and drops read-only fields', () => {
    expect(input).toMatchObject({
      family: 'stackEcsTaskDef-o-r-12345678',
      taskRoleArn: BASE.taskRoleArn,
      executionRoleArn: BASE.executionRoleArn,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      cpu: '4096',
      memory: '16384',
      ephemeralStorage: { sizeInGiB: 50 },
      runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
      volumes: [{ name: 'workspace' }, { name: 'data' }],
      tags: [{ key: 'project', value: 'p' }],
    });
    for (const readOnly of ['taskDefinitionArn', 'revision', 'status', 'compatibilities', 'registeredBy']) {
      expect(input).not.toHaveProperty(readOnly);
    }
  });

  test('the agent mounts the shared volumes and waits for the services and the volume hand-over', () => {
    const agent = byName.AgentContainer;
    expect(agent.mountPoints).toEqual([
      { sourceVolume: 'workspace', containerPath: '/workspace', readOnly: false },
      { sourceVolume: 'data', containerPath: '/data', readOnly: false },
    ]);
    expect(agent.dependsOn).toEqual([
      { containerName: VOLUME_INIT_CONTAINER_NAME, condition: 'SUCCESS' },
      { containerName: 'postgres', condition: 'HEALTHY' },
      { containerName: 'valkey', condition: 'START' },
      { containerName: 'immich-runtime', condition: 'START' },
    ]);
    expect(agent.environment).toEqual([
      { name: 'TASK_TABLE_NAME', value: 'tasks' },
      { name: 'ABCA_SERVICE_CONTAINERS', value: 'postgres,valkey,immich-runtime' },
    ]);
    expect(agent.image).toBe(BASE.containerDefinitions![0].image);
  });

  test('a root init container from the agent image hands the volumes to the agent user', () => {
    expect(byName[VOLUME_INIT_CONTAINER_NAME]).toMatchObject({
      image: BASE.containerDefinitions![0].image,
      essential: false,
      user: '0',
      entryPoint: ['chown'],
      command: ['agent:agent', '/workspace', '/data'],
    });
  });

  test('services map to ECS container definitions with their own log stream', () => {
    expect(byName.postgres).toEqual({
      name: 'postgres',
      image: CONFIG.containers[0].image,
      essential: true,
      command: ['-c', 'fsync=off', '-c', 'port=5435'],
      environment: [{ name: 'PGPORT', value: '5435' }, { name: 'POSTGRES_PASSWORD', value: 'postgres' }],
      portMappings: [{ containerPort: 5435, protocol: 'tcp' }],
      healthCheck: { command: ['CMD-SHELL', 'pg_isready -p 5435'], interval: 5, timeout: 5, retries: 10, startPeriod: 60 },
      logConfiguration: { ...LOGS, options: { ...LOGS.options, 'awslogs-stream-prefix': 'postgres' } },
    });
    expect(byName.valkey.essential).toBe(false);
    expect(byName['immich-runtime']).toMatchObject({
      user: '0',
      entryPoint: ['bash', '-c'],
      mountPoints: [
        { sourceVolume: 'workspace', containerPath: '/workspace', readOnly: false },
        { sourceVolume: 'data', containerPath: '/data', readOnly: false },
      ],
    });
  });

  test('no volumes: no init container and no extra mounts', () => {
    const plain = buildServiceTaskDefinitionInput(BASE, { containers: [{ name: 'redis', image: 'redis:7' }] }, {
      family: 'f', agentContainerName: 'AgentContainer',
    });
    expect(plain.containerDefinitions!.map(c => c.name)).toEqual(['AgentContainer', 'redis']);
    expect(plain.containerDefinitions![0].dependsOn).toEqual([{ containerName: 'redis', condition: 'START' }]);
    expect(plain.volumes).toEqual([]);
    expect(plain).not.toHaveProperty('tags');
  });

  test('throws when the base has no agent container', () => {
    expect(() => buildServiceTaskDefinitionInput(BASE, CONFIG, { family: 'f', agentContainerName: 'Other' }))
      .toThrow(/no container named Other/);
  });
});

describe('resolveServiceTaskDefinition', () => {
  const family = serviceTaskDefinitionFamily('stackEcsTaskDef', 'o/r');
  const hash = serviceTaskDefinitionHash(BASE_ARN, CONFIG);
  const input = {
    repo: 'o/r',
    config: CONFIG,
    baseTaskDefinitionArn: BASE_ARN,
    baseFamily: 'stackEcsTaskDef',
    agentContainerName: 'AgentContainer',
  };
  const newArn = `arn:aws:ecs:us-east-1:123456789012:task-definition/${family}:3`;
  let ecsSend: jest.Mock;
  let ddbSend: jest.Mock;

  beforeEach(() => {
    ecsSend = jest.fn(async (cmd: { constructor: { name: string } }) => {
      switch (cmd.constructor.name) {
        case 'DescribeTaskDefinitionCommand':
          return { taskDefinition: BASE, tags: [{ key: 'project', value: 'p' }, { key: 'aws:cloudformation:stack-name', value: 's' }] };
        case 'RegisterTaskDefinitionCommand':
          return { taskDefinition: { taskDefinitionArn: newArn } };
        default:
          return {};
      }
    });
    ddbSend = jest.fn(async () => ({}));
  });
  const deps = () => ({ ecs: { send: ecsSend }, ddb: { send: ddbSend }, repoTableName: 'repos' });
  const sent = (mock: jest.Mock, name: string) =>
    mock.mock.calls.map(([c]) => c).filter((c: { constructor: { name: string } }) => c.constructor.name === name);

  test('cache hit: runs the cached family without any AWS call', async () => {
    const cachedArn = `arn:aws:ecs:us-east-1:123456789012:task-definition/${family}:2`;
    const result = await resolveServiceTaskDefinition({ ...input, cachedArn, cachedHash: hash }, deps() as never);
    expect(result).toEqual({ family, registered: false });
    expect(ecsSend).not.toHaveBeenCalled();
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('cache miss: registers, caches on the repo row, and deregisters the replaced revision', async () => {
    const cachedArn = `arn:aws:ecs:us-east-1:123456789012:task-definition/${family}:2`;
    const result = await resolveServiceTaskDefinition({ ...input, cachedArn, cachedHash: 'stale' }, deps() as never);
    expect(result).toEqual({ family, registered: true });

    const [register] = sent(ecsSend, 'RegisterTaskDefinitionCommand');
    expect(register.input.family).toBe(family);
    expect(register.input.tags).toEqual([
      { key: 'project', value: 'p' },
      { key: 'abca:repo', value: 'o/r' },
      { key: 'abca:service-config-hash', value: hash },
    ]);
    const [update] = sent(ddbSend, 'UpdateCommand');
    expect(update.input).toMatchObject({
      TableName: 'repos',
      Key: { repo: 'o/r' },
      ExpressionAttributeValues: { ':arn': newArn, ':hash': hash },
    });
    const [deregister] = sent(ecsSend, 'DeregisterTaskDefinitionCommand');
    expect(deregister.input).toEqual({ taskDefinition: cachedArn });
  });

  test('never deregisters a cached ARN outside the derived family (e.g. a hand-edited row)', async () => {
    await resolveServiceTaskDefinition({ ...input, cachedArn: BASE_ARN, cachedHash: 'x' }, deps() as never);
    expect(sent(ecsSend, 'DeregisterTaskDefinitionCommand')).toHaveLength(0);
  });

  test('a failed cache write or deregistration does not fail the task', async () => {
    ddbSend.mockRejectedValueOnce(new Error('AccessDenied'));
    const original = ecsSend.getMockImplementation()!;
    ecsSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'DeregisterTaskDefinitionCommand') throw new Error('throttled');
      return original(cmd);
    });
    const cachedArn = `${family}:2`;
    await expect(resolveServiceTaskDefinition({ ...input, cachedArn }, deps() as never))
      .resolves.toEqual({ family, registered: true });
  });

  test('an invalid config fails before any AWS call', async () => {
    await expect(resolveServiceTaskDefinition(
      { ...input, config: { containers: [{ name: 'AgentContainer', image: 'x' }] } },
      deps() as never,
    )).rejects.toThrow(/Invalid service_containers for o\/r: .*is reserved/);
    expect(ecsSend).not.toHaveBeenCalled();
  });

  test('a failed registration fails the session start', async () => {
    ecsSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'RegisterTaskDefinitionCommand') throw new Error('ClientException: bad image');
      return { taskDefinition: BASE };
    });
    await expect(resolveServiceTaskDefinition(input, deps() as never)).rejects.toThrow(/bad image/);
    expect(ddbSend).not.toHaveBeenCalled();
  });
});
