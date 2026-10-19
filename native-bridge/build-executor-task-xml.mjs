import { readFileSync } from 'node:fs';
import { buildExecutorTaskXml, validateExecutorTaskXml } from './windows-executor.mjs';

const configPath = process.argv[2];
if (!configPath) throw new Error('USAGE: build-executor-task-xml.mjs <publisher-config.json>');
const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
const descriptor = config?.executor;
if (!descriptor) throw new Error('EXECUTOR_DESCRIPTOR_NOT_CONFIGURED');
const xml = buildExecutorTaskXml(descriptor);
validateExecutorTaskXml(xml, descriptor);
process.stdout.write(xml);
