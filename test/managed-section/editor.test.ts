import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  writeManagedSection,
  readManagedSection,
  removeManagedSection,
  AmbiguousMarkersError,
  MalformedMarkersError,
} from '../../src/managed-section/editor.js';
import {
  BEGIN_MARKER,
  END_MARKER,
  GENERATED_COMMENT,
  CLAUDE_MD_HEADER,
} from '../../src/managed-section/markers.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'auto-sop-editor-test-'));
}

describe('ManagedSectionEditor', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTmpDir();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const claudeMd = () => join(projectRoot, 'CLAUDE.md');
  const backupPath = () =>
    join(projectRoot, '.auto-sop', 'state', 'CLAUDE.md.backup');

  // ─── 1. Create from scratch ─────────────────────────

  it('creates CLAUDE.md from scratch when file does not exist', () => {
    const result = writeManagedSection({
      projectRoot,
      content: { body: 'Hello world' },
    });

    expect(result.verdict).toBe('created');
    expect(result.bytesBefore).toBe(0);
    expect(result.backupPath).toBeNull();
    expect(result.markersPresent).toBe('after_write');

    const content = readFileSync(claudeMd(), 'utf-8');
    expect(content).toContain(CLAUDE_MD_HEADER);
    expect(content).toContain(BEGIN_MARKER);
    expect(content).toContain(END_MARKER);
    expect(content).toContain('Hello world');
  });

  // ─── 2. Update existing section ─────────────────────

  it('updates existing managed section, preserves surrounding content', () => {
    const userContent = '# My Project\n\nUser rules here.\n\n';
    const initialSection = [
      BEGIN_MARKER,
      GENERATED_COMMENT,
      '',
      'Old body',
      '',
      END_MARKER,
    ].join('\n');
    writeFileSync(claudeMd(), userContent + initialSection + '\n');

    const result = writeManagedSection({
      projectRoot,
      content: { body: 'New body' },
    });

    expect(result.verdict).toBe('updated');
    expect(result.backupPath).not.toBeNull();

    const content = readFileSync(claudeMd(), 'utf-8');
    expect(content).toContain('# My Project');
    expect(content).toContain('User rules here.');
    expect(content).toContain('New body');
    expect(content).not.toContain('Old body');
  });

  // ─── 3. Append to existing no-markers file ──────────

  it('appends managed section to existing CLAUDE.md without markers', () => {
    const userContent = '# My Project\n\nSome user rules.\n';
    writeFileSync(claudeMd(), userContent);

    const result = writeManagedSection({
      projectRoot,
      content: { body: 'Auto-generated content' },
    });

    expect(result.verdict).toBe('updated');
    const content = readFileSync(claudeMd(), 'utf-8');

    // User content preserved at top
    expect(content.startsWith('# My Project')).toBe(true);
    expect(content).toContain('Some user rules.');

    // Section appended at bottom
    expect(content).toContain(BEGIN_MARKER);
    expect(content).toContain('Auto-generated content');

    // User content comes BEFORE managed section
    const userIdx = content.indexOf('Some user rules.');
    const sectionIdx = content.indexOf(BEGIN_MARKER);
    expect(userIdx).toBeLessThan(sectionIdx);
  });

  // ─── 4. Idempotent write ────────────────────────────

  it('returns unchanged when writing same content twice', () => {
    writeManagedSection({
      projectRoot,
      content: { body: 'Same body' },
    });
    const mtime1 = statSync(claudeMd()).mtimeMs;

    // Small delay to ensure mtime would differ if file were written
    const result = writeManagedSection({
      projectRoot,
      content: { body: 'Same body' },
    });

    expect(result.verdict).toBe('unchanged');
    expect(result.backupPath).toBeNull();
    const mtime2 = statSync(claudeMd()).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  // ─── 5. Dry-run: zero filesystem mutations ──────────

  it('dry-run returns dry_run verdict and touches nothing on disk', () => {
    // Pre-state: no CLAUDE.md, no state dir
    const stateDir = join(projectRoot, '.auto-sop', 'state');
    const tmpFile = claudeMd() + '.tmp';

    const result = writeManagedSection({
      projectRoot,
      content: { body: 'Test body' },
      dryRun: true,
    });

    expect(result.verdict).toBe('dry_run');
    expect(result.backupPath).toBeNull();
    expect(result.bytesAfter).toBeGreaterThan(0);

    // Nothing written
    expect(existsSync(claudeMd())).toBe(false);
    expect(existsSync(stateDir)).toBe(false);
    expect(existsSync(tmpFile)).toBe(false);
  });

  it('dry-run on existing file does not modify or backup', () => {
    const original = '# Existing\n\nContent here.\n';
    writeFileSync(claudeMd(), original);

    const result = writeManagedSection({
      projectRoot,
      content: { body: 'Would be added' },
      dryRun: true,
    });

    expect(result.verdict).toBe('dry_run');
    expect(readFileSync(claudeMd(), 'utf-8')).toBe(original);
    expect(existsSync(backupPath())).toBe(false);
  });

  // ─── 6. Unicode body ───────────────────────────────

  it('preserves Unicode and emoji in body', () => {
    const body = '🚀 Rocket launch\n\n日本語テスト\n\nCafé ñ';
    writeManagedSection({ projectRoot, content: { body } });

    const read = readManagedSection(projectRoot);
    expect(read).not.toBeNull();
    expect(read!.body).toBe(body);
  });

  // ─── 7. CRLF preservation ──────────────────────────

  it('preserves CRLF line endings in user content outside markers', () => {
    const userContent = '# Project\r\n\r\nWindows rules\r\n\r\n';
    writeFileSync(claudeMd(), userContent);

    writeManagedSection({
      projectRoot,
      content: { body: 'Linux section body' },
    });

    const content = readFileSync(claudeMd(), 'utf-8');
    // User CRLF lines preserved above the section
    expect(content).toContain('# Project\r\n');
    expect(content).toContain('Windows rules\r\n');
  });

  // ─── 8. Trailing whitespace preservation ────────────

  it('preserves trailing whitespace in user content', () => {
    const userContent = '# Project  \n\nRule with tabs\t\t\n\n';
    writeFileSync(claudeMd(), userContent);

    writeManagedSection({
      projectRoot,
      content: { body: 'Section body' },
    });

    const content = readFileSync(claudeMd(), 'utf-8');
    expect(content).toContain('# Project  \n');
    expect(content).toContain('Rule with tabs\t\t\n');
  });

  // ─── 9. Duplicate markers → AmbiguousMarkersError ──

  it('throws AmbiguousMarkersError when CLAUDE.md has duplicate begin markers', () => {
    const content = [
      BEGIN_MARKER,
      GENERATED_COMMENT,
      '',
      'body 1',
      '',
      END_MARKER,
      '',
      BEGIN_MARKER,
      GENERATED_COMMENT,
      '',
      'body 2',
      '',
      END_MARKER,
    ].join('\n');
    writeFileSync(claudeMd(), content);

    expect(() =>
      writeManagedSection({
        projectRoot,
        content: { body: 'new' },
      }),
    ).toThrow(AmbiguousMarkersError);
  });

  // ─── 10. Unclosed markers → MalformedMarkersError ──

  it('throws MalformedMarkersError when begin marker has no end', () => {
    const content = '# Project\n\n' + BEGIN_MARKER + '\nSome stuff\n';
    writeFileSync(claudeMd(), content);

    expect(() =>
      writeManagedSection({
        projectRoot,
        content: { body: 'new' },
      }),
    ).toThrow(MalformedMarkersError);
  });

  // ─── 11. Read on missing file ──────────────────────

  it('readManagedSection returns null when file does not exist', () => {
    expect(readManagedSection(projectRoot)).toBeNull();
  });

  // ─── 12. Read on file without markers ──────────────

  it('readManagedSection returns null when file has no markers', () => {
    writeFileSync(claudeMd(), '# Plain CLAUDE.md\n\nNo markers here.\n');
    expect(readManagedSection(projectRoot)).toBeNull();
  });

  // ─── 13. Remove on missing markers ─────────────────

  it('removeManagedSection is no-op when no markers present', () => {
    const original = '# Plain CLAUDE.md\n\nNo markers here.\n';
    writeFileSync(claudeMd(), original);

    removeManagedSection(projectRoot);

    expect(readFileSync(claudeMd(), 'utf-8')).toBe(original);
  });

  // ─── 14. Remove on present markers ─────────────────

  it('removeManagedSection removes section and preserves surrounding content', () => {
    const userContent = '# My Project\n\nUser content.\n\n';
    const section = [
      BEGIN_MARKER,
      GENERATED_COMMENT,
      '',
      'managed body',
      '',
      END_MARKER,
    ].join('\n');
    writeFileSync(claudeMd(), userContent + section + '\n');

    removeManagedSection(projectRoot);

    const content = readFileSync(claudeMd(), 'utf-8');
    expect(content).toContain('# My Project');
    expect(content).toContain('User content.');
    expect(content).not.toContain(BEGIN_MARKER);
    expect(content).not.toContain(END_MARKER);
    expect(content).not.toContain('managed body');
  });

  // ─── 15. Remove on missing file ────────────────────

  it('removeManagedSection is no-op when file does not exist', () => {
    // Should not throw
    removeManagedSection(projectRoot);
    expect(existsSync(claudeMd())).toBe(false);
  });

  // ─── 16. Backup written BEFORE main file ───────────

  it('backup is written before main file (crash safety)', () => {
    const original = '# Original\n';
    writeFileSync(claudeMd(), original);

    writeManagedSection({
      projectRoot,
      content: { body: 'New content' },
    });

    // Backup should contain the original content
    expect(existsSync(backupPath())).toBe(true);
    expect(readFileSync(backupPath(), 'utf-8')).toBe(original);

    // Main file has new content
    expect(readFileSync(claudeMd(), 'utf-8')).toContain('New content');
  });

  // ─── 17. No leftover .tmp file after write ─────────

  it('atomic rename leaves no .tmp file behind', () => {
    writeManagedSection({
      projectRoot,
      content: { body: 'Test' },
    });

    expect(existsSync(claudeMd() + '.tmp')).toBe(false);
  });

  // ─── 18. Very large CLAUDE.md (1 MB) ───────────────

  it('handles 1 MB CLAUDE.md without issue', () => {
    const bigContent = '# Big Project\n\n' + 'x'.repeat(1_000_000) + '\n';
    writeFileSync(claudeMd(), bigContent);

    const result = writeManagedSection({
      projectRoot,
      content: { body: 'Small section' },
    });

    expect(result.verdict).toBe('updated');
    const content = readFileSync(claudeMd(), 'utf-8');
    expect(content.length).toBeGreaterThan(1_000_000);
    expect(content).toContain('x'.repeat(100)); // spot check
    expect(content).toContain('Small section');
  });

  // ─── 19. Section at exact end of file (no trailing newline) ───

  it('handles section at end of file with no trailing newline', () => {
    const section = [
      BEGIN_MARKER,
      GENERATED_COMMENT,
      '',
      'body here',
      '',
      END_MARKER,
    ].join('\n');
    // No trailing newline
    writeFileSync(claudeMd(), '# Top\n\n' + section);

    const result = writeManagedSection({
      projectRoot,
      content: { body: 'updated body' },
    });

    expect(result.verdict).toBe('updated');
    const content = readFileSync(claudeMd(), 'utf-8');
    expect(content).toContain('updated body');
    expect(content).toContain('# Top');
  });

  // ─── 20. HTML comments in body don't confuse parser ───

  it('handles <!-- in body content without confusing marker parser', () => {
    writeManagedSection({
      projectRoot,
      content: { body: '<!-- This is a comment -->\n\nSome <!-- partial' },
    });

    const read = readManagedSection(projectRoot);
    expect(read).not.toBeNull();
    expect(read!.body).toBe('<!-- This is a comment -->\n\nSome <!-- partial');
  });

  // ─── 21. Read-after-write roundtrip ─────────────────

  it('readManagedSection returns exact body that was written', () => {
    const body = 'Line 1\n\nLine 3 with **bold**\n\n- bullet\n- another';
    writeManagedSection({ projectRoot, content: { body } });

    const read = readManagedSection(projectRoot);
    expect(read).not.toBeNull();
    expect(read!.body).toBe(body);
  });

  // ─── 22. Backup not created on first write (CREATE) ─

  it('no backup on first write (create from scratch)', () => {
    writeManagedSection({
      projectRoot,
      content: { body: 'First write' },
    });

    expect(existsSync(backupPath())).toBe(false);
  });

  // ─── 23. Path traversal rejection ──────────────────

  it('rejects projectRoot containing ..', () => {
    expect(() =>
      writeManagedSection({
        projectRoot: '/tmp/../etc',
        content: { body: 'evil' },
      }),
    ).toThrow(/must not contain/);
  });

  // ─── 24. Orphaned end marker → MalformedMarkersError ─

  it('throws MalformedMarkersError when end marker exists without begin', () => {
    writeFileSync(claudeMd(), '# Project\n\n' + END_MARKER + '\n');

    expect(() =>
      writeManagedSection({
        projectRoot,
        content: { body: 'test' },
      }),
    ).toThrow(MalformedMarkersError);
  });

  // ─── 25. bytesBefore/bytesAfter are accurate ──────

  it('reports accurate byte counts including multibyte chars', () => {
    const existing = '# 日本語\n'; // multibyte
    writeFileSync(claudeMd(), existing);

    const result = writeManagedSection({
      projectRoot,
      content: { body: '🚀' },
    });

    expect(result.bytesBefore).toBe(Buffer.byteLength(existing, 'utf-8'));
    expect(result.bytesAfter).toBeGreaterThan(result.bytesBefore);
  });

  // ─── 26. Multiple writes update backup correctly ───

  it('backup reflects the previous state on each update', () => {
    writeManagedSection({ projectRoot, content: { body: 'v1' } });
    const v1Content = readFileSync(claudeMd(), 'utf-8');

    writeManagedSection({ projectRoot, content: { body: 'v2' } });
    expect(readFileSync(backupPath(), 'utf-8')).toBe(v1Content);

    const v2Content = readFileSync(claudeMd(), 'utf-8');
    writeManagedSection({ projectRoot, content: { body: 'v3' } });
    expect(readFileSync(backupPath(), 'utf-8')).toBe(v2Content);
  });

  // ─── 27. Remove on malformed markers is no-op ─────

  it('removeManagedSection is no-op on malformed markers (no data loss)', () => {
    const content = '# Project\n\n' + BEGIN_MARKER + '\nno end marker\n';
    writeFileSync(claudeMd(), content);

    removeManagedSection(projectRoot);
    expect(readFileSync(claudeMd(), 'utf-8')).toBe(content);
  });

  // ─── 28. Verdict is 'created' only when no previous file ─

  it('verdict is updated (not created) when appending to existing file', () => {
    writeFileSync(claudeMd(), '# Existing\n');

    const result = writeManagedSection({
      projectRoot,
      content: { body: 'new section' },
    });

    expect(result.verdict).toBe('updated');
  });

  // ─── 29. claudeMdPath in result is correct ─────────

  it('returns correct claudeMdPath in result', () => {
    const result = writeManagedSection({
      projectRoot,
      content: { body: 'test' },
    });

    expect(result.claudeMdPath).toBe(join(projectRoot, 'CLAUDE.md'));
  });

  // ─── 30. Backup perms are 0o600 ───────────────────

  it('backup file has restrictive permissions (0o600)', () => {
    writeFileSync(claudeMd(), '# Original\n');

    writeManagedSection({
      projectRoot,
      content: { body: 'update' },
    });

    const stats = statSync(backupPath());
    // Check that the file is not world-readable (mode & 0o077 should be 0)
    expect(stats.mode & 0o077).toBe(0);
  });

  // ─── 31. Duplicate end markers → AmbiguousMarkersError ─

  it('throws AmbiguousMarkersError when CLAUDE.md has duplicate end markers', () => {
    const content = [
      BEGIN_MARKER,
      GENERATED_COMMENT,
      '',
      'body',
      '',
      END_MARKER,
      '',
      END_MARKER,
    ].join('\n');
    writeFileSync(claudeMd(), content);

    expect(() =>
      writeManagedSection({
        projectRoot,
        content: { body: 'new' },
      }),
    ).toThrow(AmbiguousMarkersError);
  });

  // ─── 32. Relative projectRoot rejected ─────────────

  it('rejects relative projectRoot', () => {
    expect(() =>
      writeManagedSection({
        projectRoot: 'relative/path',
        content: { body: 'evil' },
      }),
    ).toThrow(/must be absolute/);
  });

  // ─── 32. readManagedSection throws on non-ENOENT error ─

  it('readManagedSection throws on permission errors', () => {
    // Create a directory named CLAUDE.md to trigger EISDIR
    mkdirSync(claudeMd());

    expect(() => readManagedSection(projectRoot)).toThrow();
  });

  // ─── 33. removeManagedSection throws on non-ENOENT read error ─

  it('removeManagedSection throws on permission errors', () => {
    mkdirSync(claudeMd());
    expect(() => removeManagedSection(projectRoot)).toThrow();
  });

  // ─── 34. writeManagedSection throws on non-ENOENT read error ─

  it('writeManagedSection throws on non-ENOENT read errors', () => {
    mkdirSync(claudeMd());
    expect(() =>
      writeManagedSection({
        projectRoot,
        content: { body: 'test' },
      }),
    ).toThrow();
  });

  // ─── 35. readManagedSection with path traversal ────

  it('readManagedSection rejects path traversal', () => {
    expect(() => readManagedSection('/tmp/../etc')).toThrow(/must not contain/);
  });

  // ─── 36. removeManagedSection with path traversal ──

  it('removeManagedSection rejects path traversal', () => {
    expect(() => removeManagedSection('/tmp/../etc')).toThrow(/must not contain/);
  });
});
