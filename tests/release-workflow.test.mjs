/**
 * Tests for .github/workflows/release.yml
 *
 * Covers the changes introduced in the PR:
 *  - workflow_dispatch trigger with tag_name and prerelease inputs
 *  - submodules: recursive in the Checkout step
 *  - Dynamic tag_name, name, and prerelease fields in Create GitHub Release step
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(__dirname, '../.github/workflows/release.yml');
const workflowContent = readFileSync(workflowPath, 'utf8');
const workflow = parse(workflowContent);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find a step in a job by its `name` field.
 * @param {string} jobName
 * @param {string} stepName
 */
function findStep(jobName, stepName) {
  const steps = workflow.jobs[jobName]?.steps ?? [];
  return steps.find((s) => s.name === stepName);
}

// ---------------------------------------------------------------------------
// workflow_dispatch trigger
// ---------------------------------------------------------------------------

describe('workflow_dispatch trigger', () => {
  it('is defined as a trigger', () => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(workflow.on, 'workflow_dispatch'),
      'workflow_dispatch trigger must be present'
    );
  });

  it('has an inputs section', () => {
    assert.ok(
      workflow.on.workflow_dispatch?.inputs,
      'workflow_dispatch must have an inputs section'
    );
  });

  // tag_name input -----------------------------------------------------------

  describe('tag_name input', () => {
    it('exists', () => {
      const input = workflow.on.workflow_dispatch.inputs.tag_name;
      assert.ok(input, 'tag_name input must be defined');
    });

    it('is required', () => {
      const input = workflow.on.workflow_dispatch.inputs.tag_name;
      assert.strictEqual(input.required, true, 'tag_name must be required');
    });

    it('has default value "v1.0.0"', () => {
      const input = workflow.on.workflow_dispatch.inputs.tag_name;
      assert.strictEqual(
        input.default,
        'v1.0.0',
        'tag_name default must be "v1.0.0"'
      );
    });

    it('has a non-empty description mentioning the tag format', () => {
      const input = workflow.on.workflow_dispatch.inputs.tag_name;
      assert.ok(
        typeof input.description === 'string' && input.description.length > 0,
        'tag_name must have a description'
      );
      assert.match(
        input.description,
        /v\d+\.\d+\.\d+/,
        'description should contain a semver example'
      );
    });
  });

  // prerelease input ---------------------------------------------------------

  describe('prerelease input', () => {
    it('exists', () => {
      const input = workflow.on.workflow_dispatch.inputs.prerelease;
      assert.ok(input, 'prerelease input must be defined');
    });

    it('has type boolean', () => {
      const input = workflow.on.workflow_dispatch.inputs.prerelease;
      assert.strictEqual(
        input.type,
        'boolean',
        'prerelease input must have type boolean'
      );
    });

    it('is not required', () => {
      const input = workflow.on.workflow_dispatch.inputs.prerelease;
      assert.notStrictEqual(
        input.required,
        true,
        'prerelease input must not be required'
      );
    });

    it('defaults to false', () => {
      const input = workflow.on.workflow_dispatch.inputs.prerelease;
      assert.strictEqual(
        input.default,
        false,
        'prerelease input default must be false'
      );
    });

    it('has a non-empty description', () => {
      const input = workflow.on.workflow_dispatch.inputs.prerelease;
      assert.ok(
        typeof input.description === 'string' && input.description.length > 0,
        'prerelease input must have a description'
      );
    });
  });
});

// ---------------------------------------------------------------------------
// push trigger still present (regression)
// ---------------------------------------------------------------------------

describe('push trigger (regression)', () => {
  it('retains push trigger on v* tags', () => {
    const pushTrigger = workflow.on.push;
    assert.ok(pushTrigger, 'push trigger must still be defined');
    assert.ok(
      Array.isArray(pushTrigger.tags),
      'push trigger must specify tags'
    );
    assert.ok(
      pushTrigger.tags.some((t) => t === 'v*'),
      'push trigger must include "v*" tag pattern'
    );
  });
});

// ---------------------------------------------------------------------------
// Checkout step – submodules: recursive
// ---------------------------------------------------------------------------

describe('Checkout step in build job', () => {
  it('exists in the build job', () => {
    const step = findStep('build', 'Checkout');
    assert.ok(step, 'Checkout step must be present in the build job');
  });

  it('uses actions/checkout', () => {
    const step = findStep('build', 'Checkout');
    assert.match(
      step.uses,
      /^actions\/checkout@/,
      'Checkout step must use actions/checkout'
    );
  });

  it('sets submodules to recursive', () => {
    const step = findStep('build', 'Checkout');
    assert.strictEqual(
      step.with?.submodules,
      'recursive',
      'Checkout step must set submodules: recursive'
    );
  });

  it('does not set submodules to a non-recursive value', () => {
    const step = findStep('build', 'Checkout');
    assert.notStrictEqual(
      step.with?.submodules,
      false,
      'submodules must not be false'
    );
    assert.notStrictEqual(
      step.with?.submodules,
      'false',
      'submodules must not be the string "false"'
    );
  });
});

// ---------------------------------------------------------------------------
// Create GitHub Release step – dynamic fields
// ---------------------------------------------------------------------------

describe('Create GitHub Release step in release job', () => {
  it('exists', () => {
    const step = findStep('release', 'Create GitHub Release');
    assert.ok(step, 'Create GitHub Release step must be present in release job');
  });

  it('uses softprops/action-gh-release', () => {
    const step = findStep('release', 'Create GitHub Release');
    assert.match(
      step.uses,
      /^softprops\/action-gh-release@/,
      'step must use softprops/action-gh-release'
    );
  });

  // tag_name -----------------------------------------------------------------

  it('sets tag_name using inputs with ref_name fallback', () => {
    const step = findStep('release', 'Create GitHub Release');
    const tagExpr = step.with?.tag_name;
    assert.ok(tagExpr, 'tag_name must be set');
    assert.ok(
      tagExpr.includes('github.event.inputs.tag_name'),
      'tag_name must reference github.event.inputs.tag_name'
    );
    assert.ok(
      tagExpr.includes('github.ref_name'),
      'tag_name must fall back to github.ref_name'
    );
  });

  // name ---------------------------------------------------------------------

  it('sets name using inputs with ref_name fallback', () => {
    const step = findStep('release', 'Create GitHub Release');
    const nameExpr = step.with?.name;
    assert.ok(nameExpr, 'name must be set');
    assert.ok(
      nameExpr.includes('github.event.inputs.tag_name'),
      'name must reference github.event.inputs.tag_name'
    );
    assert.ok(
      nameExpr.includes('github.ref_name'),
      'name must fall back to github.ref_name'
    );
  });

  it('tag_name and name resolve to the same expression', () => {
    const step = findStep('release', 'Create GitHub Release');
    assert.strictEqual(
      step.with?.tag_name,
      step.with?.name,
      'tag_name and name expressions must be identical'
    );
  });

  // prerelease ---------------------------------------------------------------

  it('sets prerelease dynamically (not hardcoded false)', () => {
    const step = findStep('release', 'Create GitHub Release');
    const prereleaseExpr = step.with?.prerelease;
    assert.ok(
      prereleaseExpr !== false && prereleaseExpr !== 'false',
      'prerelease must not be hardcoded to false'
    );
  });

  it('sets prerelease using the inputs.prerelease comparison expression', () => {
    const step = findStep('release', 'Create GitHub Release');
    const prereleaseExpr = String(step.with?.prerelease ?? '');
    assert.ok(
      prereleaseExpr.includes('github.event.inputs.prerelease'),
      'prerelease must reference github.event.inputs.prerelease'
    );
    assert.ok(
      prereleaseExpr.includes("== 'true'") || prereleaseExpr.includes('== true'),
      'prerelease expression must compare the input to true'
    );
  });

  // unchanged fields (regression) -------------------------------------------

  it('keeps draft: false', () => {
    const step = findStep('release', 'Create GitHub Release');
    assert.strictEqual(
      step.with?.draft,
      false,
      'draft must remain false'
    );
  });

  it('keeps generate_release_notes: true', () => {
    const step = findStep('release', 'Create GitHub Release');
    assert.strictEqual(
      step.with?.generate_release_notes,
      true,
      'generate_release_notes must remain true'
    );
  });

  it('keeps artifact file patterns', () => {
    const step = findStep('release', 'Create GitHub Release');
    const files = step.with?.files ?? '';
    assert.ok(files.includes('**/*.exe'), 'must include .exe pattern');
    assert.ok(files.includes('**/*.dmg'), 'must include .dmg pattern');
    assert.ok(files.includes('**/*.AppImage'), 'must include .AppImage pattern');
    assert.ok(files.includes('**/*.deb'), 'must include .deb pattern');
  });
});

// ---------------------------------------------------------------------------
// Permissions (unchanged, regression guard)
// ---------------------------------------------------------------------------

describe('permissions', () => {
  it('grants write permission to contents', () => {
    assert.strictEqual(
      workflow.permissions?.contents,
      'write',
      'contents permission must be write'
    );
  });
});

// ---------------------------------------------------------------------------
// Overall workflow structure (sanity)
// ---------------------------------------------------------------------------

describe('workflow structure', () => {
  it('has a name', () => {
    assert.ok(workflow.name, 'workflow must have a name');
  });

  it('defines build and release jobs', () => {
    assert.ok(workflow.jobs?.build, 'build job must exist');
    assert.ok(workflow.jobs?.release, 'release job must exist');
  });

  it('release job depends on build job', () => {
    const needs = workflow.jobs?.release?.needs;
    const needsArray = Array.isArray(needs) ? needs : [needs];
    assert.ok(
      needsArray.includes('build'),
      'release job must have build in its needs'
    );
  });
});