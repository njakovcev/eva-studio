import { describe, expect, it } from 'vitest';
import { createProject, parseProject, safeFileName, serializeProject, uniqueName, FORMAT_VERSION } from '../src/core/project';

describe('project file', () => {
  it('round-trips through save and open', () => {
    const p = createProject({ name: ' Test boat ', client: 'Client', boat: 'Model 30' });
    const back = parseProject(serializeProject(p));
    expect(back.project.name).toBe('Test boat');
    expect(back.settings.defaultEdgeOffset).toBe(15);
    expect(back.settings.defaultCornerRadius).toBe(20);
    expect(back.formatVersion).toBe(FORMAT_VERSION);
  });

  it('fills missing parts with defaults', () => {
    const back = parseProject(JSON.stringify({ app: 'eva-studio', formatVersion: 1, project: { name: 'x' } }));
    expect(back.scans).toEqual([]);
    expect(back.settings.sheet).toEqual({ width: 2400, height: 1200 });
  });

  it('refuses foreign, broken and too-new files', () => {
    expect(() => parseProject('{')).toThrow(/not readable/);
    expect(() => parseProject('{"a":1}')).toThrow(/does not contain/);
    expect(() => parseProject(JSON.stringify({ app: 'eva-studio', formatVersion: 99, project: { name: 'x' } }))).toThrow(/newer version/);
  });

  it('makes safe, unique file names', () => {
    expect(safeFileName('niko: test/scan?.obj')).toBe('niko_ test_scan_.obj');
    expect(safeFileName('  ..  ')).toBe('untitled');
    expect(uniqueName('deck.obj', ['Deck.obj', 'deck (2).obj'])).toBe('deck (3).obj');
  });
});
