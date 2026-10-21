import { readFileSync } from 'node:fs';
import { buildExecutorTaskXml, validateExecutorRoutingMap, validateExecutorTaskXml } from './windows-executor.mjs';

const configPath = process.argv[2];
const lane = process.argv[3] ?? 'opencode';
if (!configPath) throw new Error('USAGE: build-executor-task-xml.mjs <publisher-config.json> [opencode|antigravity]');
if (!['opencode', 'antigravity'].includes(lane)) throw new Error('EXECUTOR_LANE_INVALID');
const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
if (config?.executors !== undefined && config?.executor !== undefined)
  throw new Error('EXECUTOR_ROUTING_CONFIG_AMBIGUOUS');
if (config?.executors !== undefined && config?.executor_lane !== undefined)
  throw new Error('EXECUTOR_ROUTING_CONFIG_AMBIGUOUS');
if (config?.executor_lane !== undefined &&
    (!['opencode', 'antigravity'].includes(config.executor_lane) || config.executor === undefined))
  throw new Error('EXECUTOR_LANE_CONFIG_INVALID');
if (config?.executors !== undefined) validateExecutorRoutingMap(config.executors);
const descriptor = config?.executors !== undefined ? config.executors[lane]
  : config?.executor_lane !== undefined
    ? config.executor_lane === lane ? config.executor : null
    : lane === 'opencode' ? config?.executor : null;
if (!descriptor) throw new Error(`EXECUTOR_NOT_CONFIGURED_FOR_${lane.toUpperCase()}`);
const xml = buildExecutorTaskXml(descriptor);
validateExecutorTaskXml(xml, descriptor);
process.stdout.write(xml);
