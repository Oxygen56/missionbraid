import { resolve } from 'node:path';

export const EFFECT_SCHEMA_VERSION = 1;

export class EffectConflictError extends Error {
  constructor(key) {
    super(`Effect key already has a different payload: ${key}`);
    this.name = 'EffectConflictError';
    this.code = 'EFFECT_PAYLOAD_CONFLICT';
    this.key = key;
  }
}

export class LedgerCorruptionError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'LedgerCorruptionError';
    this.code = 'LEDGER_CORRUPT';
  }
}

function assertRecordInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('record input must be an object');
  }
  if (typeof input.key !== 'string' || input.key.trim().length === 0) {
    throw new TypeError('effect key must be a non-empty string');
  }
  if (input.payload === null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new TypeError('effect payload must be a JSON object');
  }
}

/**
 * A dependency-free, single-writer JSONL ledger.
 *
 * The first runtime creates the stage-owned effect-core module and implements
 * the basic persistence path here. The second runtime must preserve that module
 * while extending this file with conflict and tail-recovery behavior.
 */
export class EffectLedger {
  constructor(filePath) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new TypeError('ledger file path must be a non-empty string');
    }
    this.filePath = resolve(filePath);
  }

  async record(input) {
    assertRecordInput(input);
    throw new Error('TODO: implement durable record and idempotent replay');
  }

  async replay() {
    throw new Error('TODO: implement ledger replay');
  }
}
