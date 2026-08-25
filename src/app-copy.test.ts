import { describe, expect, it } from 'vitest';

import { APP_COPY } from './app-copy.js';
import { APP_HTML, APP_JAVASCRIPT } from './app-page.js';

describe('Workbench copy', () => {
  it('keeps English and Simplified Chinese keys and interpolation variables aligned', () => {
    const englishEntries = Object.entries(APP_COPY.en);
    const chineseEntries = Object.entries(APP_COPY['zh-CN']);

    expect(chineseEntries.map(([key]) => key).sort()).toEqual(
      englishEntries.map(([key]) => key).sort(),
    );
    for (const [key, english] of englishEntries) {
      const chinese = APP_COPY['zh-CN'][key as keyof typeof APP_COPY.en];
      expect(english.trim(), `${key} English copy`).not.toBe('');
      expect(chinese.trim(), `${key} Chinese copy`).not.toBe('');
      expect(placeholders(chinese), `${key} interpolation variables`).toEqual(
        placeholders(english),
      );
    }
  });

  it('binds every static translation attribute to registered copy', () => {
    const attributePattern = /data-i18n(?:-placeholder|-aria-label)?="([^"]+)"/g;
    const keys = [...APP_HTML.matchAll(attributePattern)].map((match) => match[1]!);

    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      expect(APP_COPY.en, `English copy for ${key}`).toHaveProperty(key);
      expect(APP_COPY['zh-CN'], `Chinese copy for ${key}`).toHaveProperty(key);
    }
  });

  it('registers every literal copy key used by the browser client', () => {
    const callPattern =
      /\b(?:t|translated|localizedError|setConnection|errorMessage)\(\s*'([^']+)'/g;
    const keys = [...APP_JAVASCRIPT.matchAll(callPattern)].map((match) => match[1]!);

    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) {
      expect(APP_COPY.en, `English copy for ${key}`).toHaveProperty(key);
      expect(APP_COPY['zh-CN'], `Chinese copy for ${key}`).toHaveProperty(key);
    }
  });

  it('ships an accessible, persistent two-language switch and valid client script', () => {
    expect(APP_HTML).toContain('class="language-switch"');
    expect(APP_HTML).toContain('role="group"');
    expect(APP_HTML).toContain('data-locale="en"');
    expect(APP_HTML).toContain('data-locale="zh-CN"');
    expect(APP_JAVASCRIPT).toContain("const LOCALE_STORAGE_KEY = 'missionbraid.locale'");
    expect(APP_JAVASCRIPT).toContain('window.localStorage.getItem(LOCALE_STORAGE_KEY)');
    expect(APP_JAVASCRIPT).toContain('window.localStorage.setItem(LOCALE_STORAGE_KEY, normalized)');
    expect(APP_JAVASCRIPT).toContain('document.documentElement.lang = normalized');
    expect(APP_JAVASCRIPT).toContain("document.title = t('page.title')");
    expect(() => new Function(APP_JAVASCRIPT)).not.toThrow();
  });

  it('exposes the Iteration 2 Claude routes and Runtime intelligence in both languages', () => {
    expect(APP_HTML).toContain('value="claude"');
    expect(APP_HTML).toContain('value="codex-qoder-claude"');
    expect(APP_HTML).toContain('id="claude-model" type="text" value="deepseek-v4-pro"');
    expect(APP_HTML).toContain('<span>bypassPermissions</span>');
    expect(APP_HTML).toContain('<option value="medium" selected>medium</option>');
    expect(APP_JAVASCRIPT).toContain("permissionMode: 'bypassPermissions'");
    expect(APP_JAVASCRIPT).toContain("queued: 'mission.status.queued'");
    expect(APP_JAVASCRIPT).toContain("'runtime.event': 'event.runtime.event'");
    expect(APP_JAVASCRIPT).toContain(
      "'runtime.effective_profile_reported': 'event.runtime.effective_profile_reported'",
    );
    expect(APP_JAVASCRIPT).toContain("titleKey: 'intelligence.rootBranch'");
    expect(APP_JAVASCRIPT).toContain("titleKey: 'intelligence.effectiveProfileReports'");
    expect(APP_JAVASCRIPT).toContain("timelineRecords(timeline, 'mission.created', 'profile')");
    expect(APP_JAVASCRIPT).toContain(
      "timelineRecords(timeline, 'runtime.effective_profile_reported')",
    );
    expect(APP_COPY.en['intelligence.profileSnapshots']).toBe('Profile Snapshots');
    expect(APP_COPY['zh-CN']['intelligence.profileSnapshots']).toBe('Profile Snapshot');
    expect(APP_COPY.en['intelligence.partial']).toContain('Partially observed');
    expect(APP_COPY['zh-CN']['intelligence.partial']).toContain('部分可见');
    expect(APP_JAVASCRIPT).toContain("'intelligence.field.instructions'");
    expect(APP_COPY.en['intelligence.field.modelOverride']).toBe('Model override');
    expect(APP_COPY['zh-CN']['intelligence.field.modelOverride']).toBe('模型是否被改写');
  });

  it('shows explicit adapter capability boundaries in the Runtime Hub', () => {
    for (const capability of [
      'observe',
      'interrupt',
      'steer',
      'pre_tool_gate',
      'resume',
      'native_fork',
      'workspace_restore',
      'external_effect_control',
    ]) {
      expect(APP_JAVASCRIPT).toContain(`['${capability}', 'runtime.capability.`);
    }
    expect(APP_JAVASCRIPT).toContain('renderRuntimeCapabilities(entry)');
    expect(APP_JAVASCRIPT).toContain('RUNTIME_CAPABILITY_STATUS_KEYS[status]');
    expect(APP_JAVASCRIPT).toContain('RUNTIME_CAPABILITY_CONTROL_KEYS[control]');
    expect(APP_COPY.en['runtime.capability.status.unknown']).toBe('Unknown');
    expect(APP_COPY['zh-CN']['runtime.capability.status.unknown']).toBe('未知');
  });

  it('keeps native artifact references visible and loads sanitized evidence on demand', () => {
    expect(APP_JAVASCRIPT).toContain("'/api/v1/artifacts/' + encodeURIComponent(artifactId)");
    expect(APP_JAVASCRIPT).toContain("t('intelligence.field.sourceSequence')");
    expect(APP_JAVASCRIPT).toContain("t('intelligence.field.causalParent')");
    expect(APP_JAVASCRIPT).toContain("t('intelligence.field.nativeArtifact')");
    expect(APP_COPY.en['artifact.view']).toBe('View native evidence');
    expect(APP_COPY['zh-CN']['artifact.view']).toBe('查看原生证据');
  });

  it('shows the honest Checkpoint, Replay, and A/B execution Fork workflow in both languages', () => {
    expect(APP_COPY.en['continuity.heading']).toContain('evidence');
    expect(APP_COPY['zh-CN']['continuity.heading']).toContain('证据');
    expect(APP_COPY.en['continuity.mode.playback']).toBe('Playback');
    expect(APP_COPY['zh-CN']['continuity.mode.playback']).toBe('历史回看');
    expect(APP_COPY.en['continuity.mode.cachedReplay']).toBe('Cached replay');
    expect(APP_COPY.en['continuity.mode.counterfactual']).toBe('Counterfactual resample');
    expect(APP_COPY.en['continuity.mode.executionFork']).toBe('Execution Fork');
    expect(APP_COPY['zh-CN']['continuity.mode.executionFork']).toBe('真实执行分叉');
    expect(APP_COPY.en['continuity.receiptInputOnly']).toContain('has not issued');
    expect(APP_COPY['zh-CN']['continuity.receiptInputOnly']).toContain('尚未签发');
    expect(APP_JAVASCRIPT).toContain('data-continuity-workbench');
    expect(APP_JAVASCRIPT).toContain('dataset.forkMode = mode.id');
    expect(APP_JAVASCRIPT).toContain('isExecutionFork ? executable : ready && canReplay');
    expect(APP_JAVASCRIPT).toContain('dataset.checkpointReplayAction = checkpointId');
    expect(APP_JAVASCRIPT).toContain('dataset.executionForkAction = checkpointId');
    expect(APP_JAVASCRIPT).toContain("'/checkpoints/' +");
    expect(APP_JAVASCRIPT).toContain("'/forks'");
    expect(APP_JAVASCRIPT).toContain("'/replays'");
    expect(APP_JAVASCRIPT).toContain('receiptBranchId(receipt) === lineage.childBranchId');
    expect(APP_JAVASCRIPT).toContain("'planner.field.rankVectors'");
  });

  it('translates stable API error codes before falling back to legacy messages', () => {
    for (const code of [
      'APP_STOPPING',
      'MISSION_ALREADY_RUNNING',
      'RUNTIME_NOT_READY',
      'INVALID_MISSION_DRAFT',
      'ROUTE_NOT_FOUND',
      'INVALID_CONTENT_TYPE',
      'REQUEST_TOO_LARGE',
      'INVALID_JSON',
      'ARTIFACT_NOT_FOUND',
      'COMPOSITE_CHECKPOINT_UNAVAILABLE',
      'EXECUTION_FORK_UNAVAILABLE',
      'INVALID_EXECUTION_FORK',
      'CHECKPOINT_REPLAY_UNAVAILABLE',
      'INVALID_CHECKPOINT_REPLAY',
    ]) {
      expect(APP_JAVASCRIPT).toContain(`code === '${code}'`);
    }
    expect(APP_JAVASCRIPT.indexOf("code === 'APP_STOPPING'")).toBeLessThan(
      APP_JAVASCRIPT.indexOf("message === 'MissionBraid app is stopping.'"),
    );
    expect(APP_JAVASCRIPT).toContain('missionId: params.missionId');
    expect(APP_JAVASCRIPT).toContain('harness: params.runtime');
    expect(APP_JAVASCRIPT).toContain('reason: params.reason');
    expect(APP_JAVASCRIPT).toContain('artifactId: params.artifactId');
    expect(APP_JAVASCRIPT).toContain("if (typeof params.detail === 'string')");
  });
});

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]!).sort();
}
